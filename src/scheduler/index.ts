import cron from 'node-cron';
import { PolymarketClient } from '../polymarket/client';
import { MarketScanner } from '../polymarket/markets';
import { StraddleCalculator } from '../trading/straddle';
import { TradeExecutor } from '../trading/executor';
import { Database } from '../db/database';
import { RuntimeConfig } from '../config';
import { createLogger } from '../utils/logger';

const logger = createLogger('Scheduler');

export interface LiveMarketData {
  eventId: string;
  title: string;
  upPrice: number;
  downPrice: number;
  combinedCost: number;
  hoursLeft: number;
  isViable: boolean;
  viableSide: 'up' | 'down' | null;
  expectedValue: number;
}

export class TradingScheduler {
  private cronJob: cron.ScheduledTask | null = null;
  private claimJob: cron.ScheduledTask | null = null;
  private isRunning = false;
  private isClaimRunning = false;
  private lastScanTime: Date | null = null;
  private lastClaimTime: Date | null = null;
  private lastScannedMarkets: LiveMarketData[] = [];
  private scanner: MarketScanner;
  private calculator: StraddleCalculator;
  private executor: TradeExecutor;
  private autoClaimEnabled = true;

  constructor(
    private client: PolymarketClient,
    private db: Database,
    private runtimeConfig: RuntimeConfig
  ) {
    this.scanner = new MarketScanner(client);
    this.calculator = new StraddleCalculator({
      betSize: runtimeConfig.betSize,
      maxCombinedCost: runtimeConfig.maxCombinedCost,
    });
    this.executor = new TradeExecutor(client, db);
  }

  /**
   * Start the scheduler (runs every 5 minutes by default)
   */
  start(cronExpression: string = '*/5 * * * *'): void {
    if (this.cronJob) {
      logger.warn('Scheduler already running');
      return;
    }

    logger.info(`Starting scheduler with cron: ${cronExpression}`);

    this.cronJob = cron.schedule(cronExpression, async () => {
      await this.runScan();
    });

    // Start auto-claim job (runs every 15 minutes)
    this.claimJob = cron.schedule('*/15 * * * *', async () => {
      await this.runAutoClaim();
    });
    logger.info('Auto-claim scheduler started (every 15 minutes)');

    // Run an initial scan immediately
    this.runScan();
  }

  /**
   * Stop the scheduler
   */
  stop(): void {
    if (this.cronJob) {
      this.cronJob.stop();
      this.cronJob = null;
      logger.info('Trading scheduler stopped');
    }
    if (this.claimJob) {
      this.claimJob.stop();
      this.claimJob = null;
      logger.info('Auto-claim scheduler stopped');
    }
  }

  /**
   * Run auto-claim for resolved winning positions
   */
  async runAutoClaim(): Promise<void> {
    if (this.isClaimRunning) {
      logger.debug('Auto-claim already in progress, skipping...');
      return;
    }

    if (!this.autoClaimEnabled || this.client.isReadOnly()) {
      logger.debug('Auto-claim disabled or in read-only mode, skipping...');
      return;
    }

    this.isClaimRunning = true;
    this.lastClaimTime = new Date();
    logger.info('=== STARTING AUTO-CLAIM CHECK ===');

    try {
      // Get claimable positions
      const claimable = await this.client.getClaimablePositions();
      
      if (claimable.length === 0) {
        logger.info('No claimable positions found');
        return;
      }

      logger.info(`Found ${claimable.length} claimable position(s), attempting to claim...`);
      
      const result = await this.client.claimAllWinnings();
      
      if (result.success > 0) {
        logger.info(`✅ AUTO-CLAIM COMPLETE: ${result.success} position(s) claimed!`);
        result.txHashes.forEach(hash => {
          logger.info(`  Transaction: https://polygonscan.com/tx/${hash}`);
        });
      }
      
      if (result.failed > 0) {
        logger.warn(`⚠️ ${result.failed} position(s) failed to claim`);
      }

    } catch (error) {
      logger.error('Auto-claim failed:', error);
    } finally {
      this.isClaimRunning = false;
    }
  }

  /**
   * Toggle auto-claim feature
   */
  setAutoClaim(enabled: boolean): void {
    this.autoClaimEnabled = enabled;
    logger.info(`Auto-claim ${enabled ? 'enabled' : 'disabled'}`);
  }

  /**
   * Get auto-claim status
   */
  getAutoClaimStatus(): { enabled: boolean; lastClaimTime: string | null } {
    return {
      enabled: this.autoClaimEnabled,
      lastClaimTime: this.lastClaimTime?.toISOString() || null,
    };
  }

  /**
   * Run a single market scan and execute trades
   * NEW STRATEGY: Buy expensive side (≥70¢) only
   */
  async runScan(): Promise<void> {
    if (this.isRunning) {
      logger.warn('Scan already in progress, skipping...');
      return;
    }

    if (!this.runtimeConfig.botEnabled) {
      logger.debug('Bot is disabled, skipping scan');
      return;
    }

    this.isRunning = true;
    this.lastScanTime = new Date();
    logger.info('=== STARTING MARKET SCAN (Single-Leg Strategy: Buy ≥70¢) ===');

    try {
      // Update calculator config in case it changed
      this.calculator.updateConfig({
        betSize: this.runtimeConfig.betSize,
        maxCombinedCost: this.runtimeConfig.maxCombinedCost,
      });

      // Scan for hourly BTC Up/Down markets
      logger.info('Fetching hourly BTC markets from Gamma API...');
      const hourlyMarkets = await this.scanner.scanHourlyBTCMarkets();
      logger.info(`Found ${hourlyMarkets.length} hourly BTC markets`);

      // Store live market data for dashboard
      logger.info('Building live market data for dashboard...');
      this.lastScannedMarkets = hourlyMarkets.map(market => {
        const analysis = this.calculator.analyzeHourlyMarket(market);
        return {
          eventId: market.eventId,
          title: market.title,
          upPrice: analysis.upPrice,
          downPrice: analysis.downPrice,
          combinedCost: analysis.combinedCost,
          hoursLeft: market.hoursUntilClose,
          isViable: analysis.isViable,
          viableSide: analysis.viableSide,
          expectedValue: analysis.expectedValue,
        };
      });
      logger.info(`Built ${this.lastScannedMarkets.length} live market entries`);

      // Find single-leg opportunities (≥70¢ on either side)
      logger.info('Finding single-leg opportunities (≥70¢)...');
      const opportunities = this.calculator.findSingleLegOpportunities(hourlyMarkets);
      logger.info(`Found ${opportunities.length} markets with expensive side (≥70¢)`);

      // Execute trades
      let tradesExecuted = 0;
      if (opportunities.length > 0) {
        logger.info(`Attempting to execute ${opportunities.length} single-leg trade(s)...`);
        logger.info(`Client read-only mode: ${this.client.isReadOnly()}`);
        
        try {
          const trades = await this.executor.executeSingleLegTrades(opportunities);
          tradesExecuted = trades.length;
          logger.info(`Successfully executed ${tradesExecuted} trades`);
          
          if (trades.length > 0) {
            trades.forEach(trade => {
              logger.info(`Trade ${trade.id}: ${trade.market_question} (${trade.side?.toUpperCase()}) - Status: ${trade.status}`);
            });
          }
        } catch (execError) {
          logger.error('Trade execution failed:', execError);
        }
      } else {
        logger.info('No markets with ≥70¢ side at this time - waiting for opportunity');
      }

      // Record scan in database
      this.db.recordScan(hourlyMarkets.length, opportunities.length, tradesExecuted);
      logger.info(`=== SCAN COMPLETE: ${hourlyMarkets.length} markets, ${opportunities.length} opportunities, ${tradesExecuted} trades ===`);

    } catch (error) {
      logger.error('Scan failed with error:', error);
      if (error instanceof Error) {
        logger.error(`Error message: ${error.message}`);
        logger.error(`Error stack: ${error.stack}`);
      }
    } finally {
      this.isRunning = false;
    }
  }

  /**
   * Force a manual scan (bypasses disabled check)
   */
  async forceScan(): Promise<{ markets: number; opportunities: number; trades: number }> {
    if (this.isRunning) {
      throw new Error('Scan already in progress');
    }

    this.isRunning = true;
    this.lastScanTime = new Date();
    logger.info('Starting forced hourly BTC market scan (Single-Leg Strategy)...');

    try {
      this.calculator.updateConfig({
        betSize: this.runtimeConfig.betSize,
        maxCombinedCost: this.runtimeConfig.maxCombinedCost,
      });

      // Scan hourly BTC markets
      const hourlyMarkets = await this.scanner.scanHourlyBTCMarkets();
      
      // Store live market data for dashboard
      this.lastScannedMarkets = hourlyMarkets.map(market => {
        const analysis = this.calculator.analyzeHourlyMarket(market);
        return {
          eventId: market.eventId,
          title: market.title,
          upPrice: analysis.upPrice,
          downPrice: analysis.downPrice,
          combinedCost: analysis.combinedCost,
          hoursLeft: market.hoursUntilClose,
          isViable: analysis.isViable,
          viableSide: analysis.viableSide,
          expectedValue: analysis.expectedValue,
        };
      });

      // Find single-leg opportunities (≥70¢)
      const opportunities = this.calculator.findSingleLegOpportunities(hourlyMarkets);
      
      let tradesExecuted = 0;
      if (opportunities.length > 0 && this.runtimeConfig.botEnabled) {
        const trades = await this.executor.executeSingleLegTrades(opportunities);
        tradesExecuted = trades.length;
      }

      this.db.recordScan(hourlyMarkets.length, opportunities.length, tradesExecuted);

      return {
        markets: hourlyMarkets.length,
        opportunities: opportunities.length,
        trades: tradesExecuted,
      };
    } finally {
      this.isRunning = false;
    }
  }

  /**
   * Get current status
   */
  getStatus(): {
    isRunning: boolean;
    lastScanTime: string | null;
    schedulerActive: boolean;
    autoClaimEnabled: boolean;
    lastClaimTime: string | null;
  } {
    return {
      isRunning: this.isRunning,
      lastScanTime: this.lastScanTime?.toISOString() || null,
      schedulerActive: this.cronJob !== null,
      autoClaimEnabled: this.autoClaimEnabled,
      lastClaimTime: this.lastClaimTime?.toISOString() || null,
    };
  }

  /**
   * Get the last scanned live markets
   */
  getLiveMarkets(): LiveMarketData[] {
    return this.lastScannedMarkets;
  }

  /**
   * Expose the calculator's analyzeHourlyMarket for the API
   */
  getCalculator(): StraddleCalculator {
    return this.calculator;
  }
}

