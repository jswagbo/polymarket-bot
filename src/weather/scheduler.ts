import cron from 'node-cron';
import { createLogger } from '../utils/logger';
import { PolymarketClient } from '../polymarket/client';
import { Database } from '../db/database';
import { RuntimeConfig } from '../config';
import { WeatherScanner, WeatherScanResult } from './scanner';
import { WeatherOpportunity } from './edge-detector';
import { CITIES } from './nws-client';

const logger = createLogger('WeatherScheduler');

export class WeatherScheduler {
  private cronJob: cron.ScheduledTask | null = null;
  private isRunning = false;
  private lastScanTime: Date | null = null;
  private lastScanResult: WeatherScanResult | null = null;
  private scanner: WeatherScanner;
  private opportunities: WeatherOpportunity[] = [];
  private enabled = false;
  private autoTradeEnabled = false;
  private minEdgeForTrade = 0.15;  // 15% minimum edge for auto-trade
  private maxTradeSize = 50;       // Max $50 per trade

  constructor(
    private client: PolymarketClient,
    private db: Database,
    private runtimeConfig: RuntimeConfig
  ) {
    this.scanner = new WeatherScanner(client);
  }

  /**
   * Start the weather scanner (runs every 15 minutes)
   */
  start(cronExpression: string = '*/15 * * * *'): void {
    if (this.cronJob) {
      logger.warn('Weather scheduler already running');
      return;
    }

    logger.info(`Starting weather scheduler with cron: ${cronExpression}`);
    this.enabled = true;

    this.cronJob = cron.schedule(cronExpression, async () => {
      await this.runScan();
    });

    // Run an initial scan
    this.runScan();
  }

  /**
   * Stop the scheduler
   */
  stop(): void {
    if (this.cronJob) {
      this.cronJob.stop();
      this.cronJob = null;
      this.enabled = false;
      logger.info('Weather scheduler stopped');
    }
  }

  /**
   * Run a weather scan
   */
  async runScan(): Promise<WeatherScanResult | null> {
    if (this.isRunning) {
      logger.warn('Weather scan already in progress');
      return this.lastScanResult;
    }

    this.isRunning = true;
    this.lastScanTime = new Date();
    logger.info('=== STARTING WEATHER SCAN ===');

    try {
      // Scan for tomorrow
      const tomorrow = new Date();
      tomorrow.setDate(tomorrow.getDate() + 1);
      
      const result = await this.scanner.scan(tomorrow);
      this.lastScanResult = result;
      this.opportunities = result.opportunities;

      logger.info(`Weather scan complete: ${result.markets.length} markets, ${result.opportunities.length} opportunities`);

      // Auto-trade if enabled
      if (this.autoTradeEnabled && result.opportunities.length > 0) {
        await this.executeAutoTrades(result.opportunities);
      }

      return result;
    } catch (error) {
      logger.error('Weather scan failed:', error);
      return null;
    } finally {
      this.isRunning = false;
    }
  }

  /**
   * Force a manual scan
   */
  async forceScan(): Promise<WeatherScanResult> {
    this.isRunning = false;  // Allow re-scan
    const result = await this.runScan();
    if (!result) {
      throw new Error('Weather scan failed');
    }
    return result;
  }

  /**
   * Execute auto-trades for high-edge opportunities
   */
  private async executeAutoTrades(opportunities: WeatherOpportunity[]): Promise<void> {
    if (this.client.isReadOnly()) {
      logger.info('Read-only mode - skipping auto-trades');
      return;
    }

    const tradeable = opportunities.filter(o => o.edge >= this.minEdgeForTrade);
    if (tradeable.length === 0) {
      logger.info('No opportunities meet minimum edge threshold for auto-trade');
      return;
    }

    logger.info(`${tradeable.length} opportunities meet auto-trade threshold`);

    for (const opp of tradeable) {
      try {
        // Only trade YES for now (simpler)
        if (opp.action !== 'BUY_YES') continue;

        const size = Math.min(this.maxTradeSize / opp.marketPrice, this.maxTradeSize);
        
        logger.info(`Auto-trading: ${opp.city} ${opp.bucket.label} @ ${(opp.marketPrice * 100).toFixed(1)}¢`);
        logger.info(`  Edge: ${(opp.edge * 100).toFixed(1)}% | Size: $${size.toFixed(2)}`);

        await this.client.placeBuyOrder(opp.tokenId, opp.marketPrice, size);
        
        logger.info(`✅ Auto-trade executed for ${opp.city} ${opp.bucket.label}`);
      } catch (error) {
        logger.error(`Failed to execute auto-trade:`, error);
      }

      // Delay between trades
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
  }

  /**
   * Get current status
   */
  getStatus(): {
    enabled: boolean;
    isRunning: boolean;
    lastScanTime: string | null;
    autoTradeEnabled: boolean;
    minEdgeForTrade: number;
    maxTradeSize: number;
    opportunityCount: number;
    cities: typeof CITIES;
  } {
    return {
      enabled: this.enabled,
      isRunning: this.isRunning,
      lastScanTime: this.lastScanTime?.toISOString() || null,
      autoTradeEnabled: this.autoTradeEnabled,
      minEdgeForTrade: this.minEdgeForTrade,
      maxTradeSize: this.maxTradeSize,
      opportunityCount: this.opportunities.length,
      cities: CITIES,
    };
  }

  /**
   * Get last scan result
   */
  getLastScanResult(): WeatherScanResult | null {
    return this.lastScanResult;
  }

  /**
   * Get current opportunities
   */
  getOpportunities(): WeatherOpportunity[] {
    return this.opportunities;
  }

  /**
   * Enable/disable auto-trading
   */
  setAutoTrade(enabled: boolean): void {
    this.autoTradeEnabled = enabled;
    logger.info(`Weather auto-trade ${enabled ? 'enabled' : 'disabled'}`);
  }

  /**
   * Update auto-trade settings
   */
  updateSettings(settings: { minEdgeForTrade?: number; maxTradeSize?: number }): void {
    if (settings.minEdgeForTrade !== undefined) {
      this.minEdgeForTrade = settings.minEdgeForTrade;
    }
    if (settings.maxTradeSize !== undefined) {
      this.maxTradeSize = settings.maxTradeSize;
    }
    logger.info(`Weather settings updated: minEdge=${this.minEdgeForTrade}, maxSize=${this.maxTradeSize}`);
  }

  /**
   * Toggle enabled state
   */
  toggle(): boolean {
    if (this.enabled) {
      this.stop();
    } else {
      this.start();
    }
    return this.enabled;
  }
}


