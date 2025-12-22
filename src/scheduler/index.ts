import cron from 'node-cron';
import { PolymarketClient, CryptoType, CRYPTO_DISPLAY_NAMES } from '../polymarket/client';
import { MarketScanner } from '../polymarket/markets';
import { StraddleCalculator } from '../trading/straddle';
import { TradeExecutor } from '../trading/executor';
import { Database } from '../db/database';
import { RuntimeConfig, CryptoType as ConfigCryptoType } from '../config';
import { createLogger } from '../utils/logger';

const logger = createLogger('Scheduler');

// Supported crypto types for the configurable strategy
export const SUPPORTED_CRYPTOS: CryptoType[] = ['BTC', 'ETH', 'XRP', 'SOL'];

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
  threshold: number;  // The price threshold for this crypto
}

export class TradingScheduler {
  private cronJob: cron.ScheduledTask | null = null;
  private claimJob: cron.ScheduledTask | null = null;
  private isRunning = false;
  private isClaimRunning = false;
  private lastScanTime: Date | null = null;
  private lastClaimTime: Date | null = null;
  
  // Store market data for each crypto separately
  private marketDataByCrypto: Map<CryptoType, LiveMarketData[]> = new Map();
  
  private scanner: MarketScanner;
  private calculator: StraddleCalculator;
  private executor: TradeExecutor;
  private autoClaimEnabled = true;
  
  // Trading window: only trade in last 15 minutes of hour (minutes 45-59)
  private tradingWindowStart = 45;  // Minute 45
  private tradingWindowEnd = 59;    // Minute 59

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
   * Check if current time is within the trading window (last 15 minutes of hour)
   */
  isInTradingWindow(): boolean {
    const now = new Date();
    const minute = now.getMinutes();
    return minute >= this.tradingWindowStart && minute <= this.tradingWindowEnd;
  }

  /**
   * Get minutes until trading window opens
   */
  getMinutesUntilTradingWindow(): number {
    const now = new Date();
    const minute = now.getMinutes();
    if (minute >= this.tradingWindowStart) {
      return 0; // Already in window
    }
    return this.tradingWindowStart - minute;
  }

  /**
   * Start the scheduler (runs every 30 seconds by default)
   * Note: 6-field cron format for seconds: seconds minutes hours day month weekday
   */
  start(cronExpression: string = '*/30 * * * * *'): void {
    if (this.cronJob) {
      logger.warn('Scheduler already running');
      return;
    }

    logger.info(`Starting scheduler with cron: ${cronExpression} (every 30 seconds)`);
    logger.info(`Trading window: minutes ${this.tradingWindowStart}-${this.tradingWindowEnd} of each hour`);

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
   * Run a single market scan and execute trades for ALL crypto types
   * NEW STRATEGY: Buy expensive side (≥ per-crypto threshold) only
   */
  async runScan(): Promise<void> {
    if (this.isRunning) {
      logger.warn('Scan already in progress, skipping...');
      return;
    }

    // Check if global bot is enabled
    if (!this.runtimeConfig.botEnabled) {
      logger.debug('Bot is disabled, skipping scan');
      return;
    }

    this.isRunning = true;
    this.lastScanTime = new Date();
    logger.info('=== STARTING MULTI-CRYPTO MARKET SCAN (Per-Crypto Configurable Strategy) ===');

    try {
      let totalMarkets = 0;
      let totalOpportunities = 0;
      let totalTradesExecuted = 0;
      const inTradingWindow = this.isInTradingWindow();
      const currentMinute = new Date().getMinutes();

      // Scan each crypto type
      for (const crypto of SUPPORTED_CRYPTOS) {
        try {
          // Get per-crypto settings
          const cryptoSettings = this.runtimeConfig.getCryptoSettings(crypto as ConfigCryptoType);
          const isEnabled = this.runtimeConfig.isCryptoEnabled(crypto as ConfigCryptoType);
          const minPrice = cryptoSettings.minPrice;
          const betSize = cryptoSettings.betSize;
          const thresholdPct = (minPrice * 100).toFixed(0);
          
          logger.info(`--- Scanning ${CRYPTO_DISPLAY_NAMES[crypto]} (${crypto}) | Enabled: ${isEnabled} | Threshold: ${thresholdPct}¢ | Bet: $${betSize} ---`);
          
          // Fetch markets for this crypto (always fetch for dashboard display)
          const hourlyMarkets = await this.scanner.scanHourlyCryptoMarkets(crypto);
          logger.info(`Found ${hourlyMarkets.length} hourly ${crypto} markets`);

          // Store live market data for this crypto (use per-crypto threshold)
          const marketData: LiveMarketData[] = hourlyMarkets.map(market => {
            const analysis = this.calculator.analyzeHourlyMarket(market, minPrice, betSize);
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
              threshold: minPrice,
            };
          });
          this.marketDataByCrypto.set(crypto, marketData);
          totalMarkets += hourlyMarkets.length;

          // Only look for opportunities if this crypto is enabled
          if (!isEnabled) {
            logger.info(`${crypto} is disabled, skipping trade execution`);
            continue;
          }

          // Find single-leg opportunities (≥ per-crypto threshold on either side)
          const opportunities = this.calculator.findSingleLegOpportunities(hourlyMarkets, minPrice, betSize);
          totalOpportunities += opportunities.length;

          if (opportunities.length > 0) {
            logger.info(`Found ${opportunities.length} ${crypto} opportunities with expensive side (≥${thresholdPct}¢)`);
            
            if (inTradingWindow) {
              logger.info(`✅ IN TRADING WINDOW - Executing ${crypto} trades...`);
              
              try {
                const trades = await this.executor.executeSingleLegTrades(opportunities);
                totalTradesExecuted += trades.length;
                
                if (trades.length > 0) {
                  trades.forEach(trade => {
                    logger.info(`Trade ${trade.id}: ${trade.market_question} (${trade.side?.toUpperCase()}) - Status: ${trade.status}`);
                  });
                }
              } catch (execError) {
                logger.error(`${crypto} trade execution failed:`, execError);
              }
            }
          }
        } catch (cryptoError) {
          logger.error(`Failed to scan ${crypto} markets:`, cryptoError);
          // Continue with other cryptos even if one fails
        }
      }

      // Log trading window status summary
      if (totalOpportunities > 0 && !inTradingWindow) {
        const minutesUntil = this.getMinutesUntilTradingWindow();
        logger.info(`⏰ ${totalOpportunities} total opportunity(ies) found, but outside trading window (minute ${currentMinute})`);
        logger.info(`   Trading window: minutes ${this.tradingWindowStart}-${this.tradingWindowEnd}. Opens in ${minutesUntil} minutes.`);
      }

      // Record scan in database
      this.db.recordScan(totalMarkets, totalOpportunities, totalTradesExecuted);
      logger.info(`=== MULTI-CRYPTO SCAN COMPLETE: ${totalMarkets} markets, ${totalOpportunities} opportunities, ${totalTradesExecuted} trades ===`);

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
   * Force a manual scan for a specific crypto or all cryptos (bypasses disabled check)
   */
  async forceScan(crypto?: CryptoType): Promise<{ markets: number; opportunities: number; trades: number }> {
    if (this.isRunning) {
      throw new Error('Scan already in progress');
    }

    this.isRunning = true;
    this.lastScanTime = new Date();
    
    const cryptosToScan = crypto ? [crypto] : SUPPORTED_CRYPTOS;
    logger.info(`Starting forced scan for: ${cryptosToScan.join(', ')}...`);

    try {
      let totalMarkets = 0;
      let totalOpportunities = 0;
      let totalTradesExecuted = 0;

      for (const c of cryptosToScan) {
        try {
          // Get per-crypto settings
          const cryptoSettings = this.runtimeConfig.getCryptoSettings(c as ConfigCryptoType);
          const isEnabled = this.runtimeConfig.isCryptoEnabled(c as ConfigCryptoType);
          const minPrice = cryptoSettings.minPrice;
          const betSize = cryptoSettings.betSize;
          
          // Scan hourly markets for this crypto
          const hourlyMarkets = await this.scanner.scanHourlyCryptoMarkets(c);
          
          // Store live market data for dashboard (use per-crypto threshold)
          const marketData: LiveMarketData[] = hourlyMarkets.map(market => {
            const analysis = this.calculator.analyzeHourlyMarket(market, minPrice, betSize);
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
              threshold: minPrice,
            };
          });
          this.marketDataByCrypto.set(c, marketData);
          totalMarkets += hourlyMarkets.length;

          // Find single-leg opportunities (≥ per-crypto threshold)
          const opportunities = this.calculator.findSingleLegOpportunities(hourlyMarkets, minPrice, betSize);
          totalOpportunities += opportunities.length;
          
          // Only execute trades if this specific crypto is enabled
          if (opportunities.length > 0 && isEnabled) {
            const trades = await this.executor.executeSingleLegTrades(opportunities);
            totalTradesExecuted += trades.length;
          }
        } catch (err) {
          logger.error(`Force scan failed for ${c}:`, err);
        }
      }

      this.db.recordScan(totalMarkets, totalOpportunities, totalTradesExecuted);

      return {
        markets: totalMarkets,
        opportunities: totalOpportunities,
        trades: totalTradesExecuted,
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
    inTradingWindow: boolean;
    tradingWindowStart: number;
    tradingWindowEnd: number;
    currentMinute: number;
    minutesUntilWindow: number;
  } {
    return {
      isRunning: this.isRunning,
      lastScanTime: this.lastScanTime?.toISOString() || null,
      schedulerActive: this.cronJob !== null,
      autoClaimEnabled: this.autoClaimEnabled,
      lastClaimTime: this.lastClaimTime?.toISOString() || null,
      inTradingWindow: this.isInTradingWindow(),
      tradingWindowStart: this.tradingWindowStart,
      tradingWindowEnd: this.tradingWindowEnd,
      currentMinute: new Date().getMinutes(),
      minutesUntilWindow: this.getMinutesUntilTradingWindow(),
    };
  }

  /**
   * Get the last scanned live markets for a specific crypto
   */
  getLiveMarkets(crypto?: CryptoType): LiveMarketData[] {
    if (crypto) {
      return this.marketDataByCrypto.get(crypto) || [];
    }
    // Return all markets if no crypto specified (backwards compatibility)
    const allMarkets: LiveMarketData[] = [];
    for (const markets of this.marketDataByCrypto.values()) {
      allMarkets.push(...markets);
    }
    return allMarkets;
  }

  /**
   * Get all live market data organized by crypto type
   */
  getAllLiveMarketsByCrypto(): Record<CryptoType, LiveMarketData[]> {
    const result: Record<string, LiveMarketData[]> = {};
    for (const crypto of SUPPORTED_CRYPTOS) {
      result[crypto] = this.marketDataByCrypto.get(crypto) || [];
    }
    return result as Record<CryptoType, LiveMarketData[]>;
  }

  /**
   * Expose the calculator's analyzeHourlyMarket for the API
   */
  getCalculator(): StraddleCalculator {
    return this.calculator;
  }
}

