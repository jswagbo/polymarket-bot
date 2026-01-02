import cron from 'node-cron';
import { PolymarketClient, CryptoType, CRYPTO_DISPLAY_NAMES } from '../polymarket/client';
import { MarketScanner } from '../polymarket/markets';
import { StraddleCalculator } from '../trading/straddle';
import { TradeExecutor } from '../trading/executor';
import { getVolatilityFilter, VolatilityFilter, VolatilityConfig } from '../trading/volatility';
import { Database } from '../db/database';
import { RuntimeConfig, CryptoType as ConfigCryptoType } from '../config';
import { getSettingsManager, BotSettings } from '../settings';
import { createLogger } from '../utils/logger';

const logger = createLogger('Scheduler');

// Supported crypto types for the configurable strategy
export const SUPPORTED_CRYPTOS: CryptoType[] = ['BTC', 'ETH'];

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
  threshold: number;     // Min price threshold (90¢)
  maxThreshold: number;  // Max price threshold (94¢)
}

export class TradingScheduler {
  private cronJob: cron.ScheduledTask | null = null;
  private claimJob: cron.ScheduledTask | null = null;
  private isRunning = false;
  private isClaimRunning = false;
  private lastScanTime: Date | null = null;
  private lastClaimTime: Date | null = null;
  private lastApiCallTime: Date | null = null;
  
  // Minimum time between API calls to avoid rate limiting (5 seconds)
  private minScanIntervalMs = 5000;
  
  // Store market data for each crypto separately
  private marketDataByCrypto: Map<CryptoType, LiveMarketData[]> = new Map();
  
  private scanner: MarketScanner;
  private calculator: StraddleCalculator;
  private executor: TradeExecutor;
  private volatilityFilter: VolatilityFilter;
  private autoClaimEnabled = true;
  private volatilityFilterEnabled = true;
  
  // Stop-loss configuration
  private stopLossEnabled = false;
  private stopLossThreshold = 0.70; // 70 cents default
  private stopLossInterval: NodeJS.Timeout | null = null;
  private stopLossCheckIntervalMs = 1000; // Check every 1 second
  private isStopLossRunning = false;
  
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
    
    // Initialize volatility filter with defaults (will be overridden by settings)
    this.volatilityFilter = getVolatilityFilter({
      skipVolatileHours: false,
      volatileHoursET: [9, 10, 15, 16],
      checkRealTimeVolatility: false,
      maxHourlyVolatilityPercent: 2.0,
      checkSpread: false,
      maxSpreadCents: 5,
      checkVolume: false,
    });
    
    // Apply saved settings on startup
    this.applySettingsFromManager();
    
    // Subscribe to settings changes
    const settingsManager = getSettingsManager();
    settingsManager.onChange((settings) => {
      logger.info('Settings changed, applying updates...');
      this.applySettings(settings);
    });
    
    logger.info('Scheduler initialized with saved settings');
  }
  
  /**
   * Apply settings from the settings manager
   */
  private applySettingsFromManager(): void {
    const settingsManager = getSettingsManager();
    const settings = settingsManager.getAll();
    this.applySettings(settings);
  }
  
  /**
   * Apply settings to the scheduler
   */
  applySettings(settings: BotSettings): void {
    // Trading window
    this.tradingWindowStart = settings.tradingWindow.startMinute;
    this.tradingWindowEnd = settings.tradingWindow.endMinute;
    logger.info(`Trading window: ${this.tradingWindowStart}-${this.tradingWindowEnd}`);
    
    // Volatility settings
    this.volatilityFilterEnabled = settings.volatility.enabled;
    this.volatilityFilter.updateConfig({
      skipVolatileHours: settings.volatility.skipVolatileHours,
      volatileHoursET: settings.volatility.volatileHoursET,
      checkRealTimeVolatility: settings.volatility.checkRealTimeVolatility,
      maxHourlyVolatilityPercent: settings.volatility.maxHourlyVolatilityPercent,
      checkSpread: settings.volatility.checkSpread,
      maxSpreadCents: settings.volatility.maxSpreadCents,
    });
    
    // Stop-loss settings
    this.stopLossThreshold = settings.stopLoss.threshold;
    if (settings.stopLoss.enabled !== this.stopLossEnabled) {
      this.setStopLossEnabled(settings.stopLoss.enabled);
    }
    
    // Auto-claim settings
    this.autoClaimEnabled = settings.autoClaim.enabled;
    
    // Update runtime config with crypto settings
    this.runtimeConfig.botEnabled = settings.globalBotEnabled;
    
    // Apply per-crypto settings (BTC and ETH only for now)
    const cryptoMap: Record<string, 'BTC' | 'ETH'> = { btc: 'BTC', eth: 'ETH' };
    for (const [key, crypto] of Object.entries(cryptoMap)) {
      const cryptoSettings = settings[key as keyof Pick<BotSettings, 'btc' | 'eth'>];
      this.runtimeConfig.updateCryptoSettings(crypto, {
        enabled: cryptoSettings.enabled,
        betSize: cryptoSettings.betSize,
        minPrice: cryptoSettings.minPrice,
      });
    }
    
    logger.info('Settings applied successfully');
  }
  
  /**
   * Get all current settings (for API)
   */
  getAllSettings(): BotSettings {
    return getSettingsManager().getAll();
  }
  
  /**
   * Update settings (for API)
   */
  updateSettings(updates: Partial<BotSettings>): BotSettings {
    return getSettingsManager().update(updates);
  }
  
  /**
   * Reset to factory defaults (for API)
   */
  resetToFactory(): BotSettings {
    return getSettingsManager().resetToFactory();
  }
  
  /**
   * Export settings as JSON (for API)
   */
  exportSettings(): string {
    return getSettingsManager().export();
  }
  
  /**
   * Import settings from JSON (for API)
   */
  importSettings(json: string): BotSettings {
    return getSettingsManager().import(json);
  }
  
  /**
   * Enable or disable volatility filtering
   */
  setVolatilityFilterEnabled(enabled: boolean): void {
    this.volatilityFilterEnabled = enabled;
    logger.info(`Volatility filter ${enabled ? 'ENABLED' : 'DISABLED'}`);
  }
  
  /**
   * Update volatility filter configuration
   */
  updateVolatilityConfig(config: Partial<VolatilityConfig>): void {
    this.volatilityFilter.updateConfig(config);
  }
  
  /**
   * Get current volatility filter config
   */
  getVolatilityConfig(): VolatilityConfig {
    return this.volatilityFilter.getConfig();
  }

  // ==========================================
  // STOP-LOSS FUNCTIONS
  // ==========================================

  /**
   * Enable or disable stop-loss monitoring
   */
  setStopLossEnabled(enabled: boolean): void {
    this.stopLossEnabled = enabled;
    logger.info(`🛑 Stop-loss ${enabled ? 'ENABLED' : 'DISABLED'} (threshold: ${(this.stopLossThreshold * 100).toFixed(0)}¢)`);
    
    if (enabled && !this.stopLossInterval) {
      this.startStopLossMonitor();
    } else if (!enabled && this.stopLossInterval) {
      this.stopStopLossMonitor();
    }
  }

  /**
   * Update stop-loss threshold (in decimal, e.g., 0.70 for 70 cents)
   */
  setStopLossThreshold(threshold: number): void {
    this.stopLossThreshold = threshold;
    logger.info(`🛑 Stop-loss threshold set to ${(threshold * 100).toFixed(0)}¢`);
  }

  /**
   * Get current stop-loss config
   */
  getStopLossConfig(): { enabled: boolean; threshold: number } {
    return {
      enabled: this.stopLossEnabled,
      threshold: this.stopLossThreshold,
    };
  }

  /**
   * Start the stop-loss monitoring interval
   */
  private startStopLossMonitor(): void {
    if (this.stopLossInterval) {
      clearInterval(this.stopLossInterval);
    }
    
    logger.info(`🛑 Starting stop-loss monitor (checking every 1 second)`);
    
    // Run immediately once
    this.checkStopLoss();
    
    // Then run on interval
    this.stopLossInterval = setInterval(() => {
      this.checkStopLoss();
    }, this.stopLossCheckIntervalMs);
  }

  /**
   * Stop the stop-loss monitoring interval
   */
  private stopStopLossMonitor(): void {
    if (this.stopLossInterval) {
      clearInterval(this.stopLossInterval);
      this.stopLossInterval = null;
      logger.info('🛑 Stop-loss monitor stopped');
    }
  }

  /**
   * Check all open positions and trigger stop-loss if price drops below threshold
   */
  private async checkStopLoss(): Promise<void> {
    if (!this.stopLossEnabled || this.isStopLossRunning) {
      return;
    }

    this.isStopLossRunning = true;

    try {
      // Get all open positions
      const positions = await this.client.getPositions();
      const openPositions = positions.filter((p: any) => {
        const size = parseFloat(p.size || p.amount || p.shares || '0');
        return size > 0.001 && !p.resolved && !p.closed;
      });

      if (openPositions.length === 0) {
        return;
      }

      logger.debug(`🛑 Checking ${openPositions.length} positions for stop-loss...`);

      for (const position of openPositions) {
        const tokenId = position.asset || position.tokenId;
        const size = parseFloat(position.size || position.amount || position.shares || '0');
        const currentPrice = parseFloat(position.curPrice || position.currentPrice || position.price || '0');
        const title = position.title || position.market?.question || tokenId?.substring(0, 20) || 'Unknown';

        if (!tokenId || size <= 0) {
          continue;
        }

        // Check if current price is below stop-loss threshold
        if (currentPrice > 0 && currentPrice < this.stopLossThreshold) {
          logger.warn(`🛑 STOP-LOSS TRIGGERED for ${title}`);
          logger.warn(`   Current price: ${(currentPrice * 100).toFixed(1)}¢ < Threshold: ${(this.stopLossThreshold * 100).toFixed(0)}¢`);
          logger.warn(`   Selling ${size.toFixed(2)} shares...`);

          try {
            const result = await this.client.placeSellOrder(tokenId, size, true);
            logger.info(`🛑 STOP-LOSS SOLD: ${title}`);
            logger.info(`   Result: ${JSON.stringify(result)}`);
            
            // Record in database
            this.db.recordScan(0, 0, 0); // Just to trigger activity
            
          } catch (sellError: any) {
            logger.error(`🛑 Stop-loss sell FAILED for ${title}: ${sellError.message}`);
          }

          // Small delay between sells
          await new Promise(resolve => setTimeout(resolve, 1000));
        }
      }
    } catch (error: any) {
      logger.error(`🛑 Stop-loss check failed: ${error.message}`);
    } finally {
      this.isStopLossRunning = false;
    }
  }

  /**
   * Manually trigger a stop-loss check
   */
  async triggerStopLossCheck(): Promise<{ checked: number; sold: number }> {
    const positions = await this.client.getPositions();
    const openPositions = positions.filter((p: any) => {
      const size = parseFloat(p.size || p.amount || p.shares || '0');
      return size > 0.001 && !p.resolved && !p.closed;
    });

    let sold = 0;

    for (const position of openPositions) {
      const tokenId = position.asset || position.tokenId;
      const size = parseFloat(position.size || position.amount || position.shares || '0');
      const currentPrice = parseFloat(position.curPrice || position.currentPrice || position.price || '0');

      if (tokenId && size > 0 && currentPrice > 0 && currentPrice < this.stopLossThreshold) {
        try {
          await this.client.placeSellOrder(tokenId, size, true);
          sold++;
        } catch (e) {
          // Continue with other positions
        }
      }
    }

    return { checked: openPositions.length, sold };
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
   * Start the scheduler (runs every 1 second by default for fast opportunity capture)
   * Note: 6-field cron format for seconds: seconds minutes hours day month weekday
   */
  start(cronExpression: string = '*/1 * * * * *'): void {
    if (this.cronJob) {
      logger.warn('Scheduler already running');
      return;
    }

    logger.info(`Starting scheduler with cron: ${cronExpression} (every 1 second)`);
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
   * Uses brute-force approach: scans ALL resolved hourly markets and attempts to redeem each
   * This is the same workflow that works for manual claiming
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
    logger.info('=== STARTING AUTO-CLAIM (BRUTE FORCE APPROACH) ===');

    try {
      // Get enabled cryptos from settings
      const settings = getSettingsManager().getAll();
      const enabledCryptos: string[] = [];
      
      if (settings.btc.autoClaimEnabled) enabledCryptos.push('BTC');
      if (settings.eth.autoClaimEnabled) enabledCryptos.push('ETH');
      if (settings.sol.autoClaimEnabled) enabledCryptos.push('SOL');
      if (settings.xrp.autoClaimEnabled) enabledCryptos.push('XRP');
      
      if (enabledCryptos.length === 0) {
        logger.info('No cryptos enabled for auto-claim, skipping...');
        this.isClaimRunning = false;
        return;
      }
      
      logger.info(`Auto-claiming for: ${enabledCryptos.join(', ')}`);
      
      // Use brute-force approach: scan all resolved hourly markets from last 7 days
      // and attempt to redeem each one. Markets where user has no position will be skipped.
      // This is the EXACT same workflow that works for manual claiming.
      const result = await this.client.claimAllResolvedHourly(settings.autoClaim.daysBack, enabledCryptos);
      
      if (result.success > 0) {
        logger.info(`✅ AUTO-CLAIM COMPLETE: ${result.success} position(s) claimed!`);
      }
      
      if (result.skipped > 0) {
        logger.info(`⏭️ Skipped ${result.skipped} markets (no position or already claimed)`);
      }
      
      if (result.failed > 0) {
        logger.warn(`⚠️ ${result.failed} position(s) failed to claim`);
      }
      
      logger.info(`Auto-claim summary: ${result.attempted} attempted, ${result.success} success, ${result.skipped} skipped, ${result.failed} failed`);

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
   * Check if any crypto is enabled for trading
   */
  private isAnyCryptoEnabled(): boolean {
    for (const crypto of SUPPORTED_CRYPTOS) {
      const settings = this.runtimeConfig.getCryptoSettings(crypto as ConfigCryptoType);
      if (settings.enabled) {
        return true;
      }
    }
    return false;
  }

  /**
   * Run a single market scan and execute trades for ALL crypto types
   * NEW STRATEGY: Buy expensive side (≥ per-crypto threshold) only
   */
  async runScan(): Promise<void> {
    if (this.isRunning) {
      // Skip silently if already running to avoid log spam at 1-second interval
      return;
    }

    // Check if global bot is enabled OR any individual crypto is enabled
    const globalEnabled = this.runtimeConfig.botEnabled;
    const anyCryptoEnabled = this.isAnyCryptoEnabled();
    
    if (!globalEnabled && !anyCryptoEnabled) {
      // Skip silently to avoid log spam
      return;
    }

    // Rate limiting: don't hit API more than once every 5 seconds
    const now = new Date();
    if (this.lastApiCallTime) {
      const timeSinceLastScan = now.getTime() - this.lastApiCallTime.getTime();
      if (timeSinceLastScan < this.minScanIntervalMs) {
        // Skip this scan, too soon
        return;
      }
    }

    this.isRunning = true;
    this.lastScanTime = now;
    this.lastApiCallTime = now;
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
          // ONLY check if this specific crypto toggle is ON (not global)
          const isEnabled = cryptoSettings.enabled;
          const minPrice = cryptoSettings.minPrice;
          const betSize = cryptoSettings.betSize;
          const thresholdPct = (minPrice * 100).toFixed(0);
          
          logger.info(`--- Scanning ${CRYPTO_DISPLAY_NAMES[crypto]} (${crypto}) | Toggle: ${isEnabled ? 'ON' : 'OFF'} | Threshold: ${thresholdPct}% | Bet: $${betSize} ---`);
          
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
              maxThreshold: analysis.maxThreshold,
            };
          });
          this.marketDataByCrypto.set(crypto, marketData);
          totalMarkets += hourlyMarkets.length;

          // Only look for opportunities if this crypto is enabled
          if (!isEnabled) {
            logger.info(`⛔ ${crypto} toggle is OFF, skipping trade execution`);
            continue;
          }

          // Find single-leg opportunities (≥ per-crypto threshold on either side)
          const opportunities = this.calculator.findSingleLegOpportunities(hourlyMarkets, minPrice, betSize);
          totalOpportunities += opportunities.length;

          if (opportunities.length > 0) {
            logger.info(`Found ${opportunities.length} ${crypto} opportunities with expensive side (≥${thresholdPct}¢)`);
            
            if (inTradingWindow) {
              // Run volatility filter before executing trades
              if (this.volatilityFilterEnabled) {
                const quickCheck = this.volatilityFilter.quickCheck();
                if (!quickCheck.canTrade) {
                  logger.warn(`⚠️ Volatility filter BLOCKED ${crypto} trades: ${quickCheck.reason}`);
                  continue;
                }
                
                // Run full volatility check for first opportunity (representative)
                const firstOpp = opportunities[0];
                const tokenId = firstOpp.token?.token_id || '';
                const volumeUsd = 0; // Volume check disabled by default
                
                const fullCheck = await this.volatilityFilter.checkAll(crypto, tokenId, volumeUsd);
                if (!fullCheck.canTrade) {
                  logger.warn(`⚠️ Volatility filter BLOCKED ${crypto} trades: ${fullCheck.reasons.join(', ')}`);
                  continue;
                }
                
                logger.info(`✅ Volatility filter PASSED for ${crypto}`);
              }
              
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
      logger.warn('Force scan requested but a scan is already in progress');
      throw new Error('Scan already in progress. Please wait a moment and try again.');
    }

    this.isRunning = true;
    this.lastScanTime = new Date();
    logger.info(`Force scan starting, isRunning=${this.isRunning}`);
    
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
          // ONLY check if this specific crypto toggle is ON (not global)
          const isEnabled = cryptoSettings.enabled;
          const minPrice = cryptoSettings.minPrice;
          const betSize = cryptoSettings.betSize;
          
          logger.info(`Force scan ${c}: enabled=${isEnabled}, threshold=${(minPrice*100).toFixed(0)}%, bet=$${betSize}`);
          
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
              maxThreshold: analysis.maxThreshold,
            };
          });
          this.marketDataByCrypto.set(c, marketData);
          totalMarkets += hourlyMarkets.length;

          // Find single-leg opportunities (≥ per-crypto threshold)
          const opportunities = this.calculator.findSingleLegOpportunities(hourlyMarkets, minPrice, betSize);
          totalOpportunities += opportunities.length;
          
          // Only execute trades if:
          // 1. This specific crypto toggle is ON
          // 2. Currently in trading window (minutes 45-59)
          const inWindow = this.isInTradingWindow();
          if (opportunities.length > 0 && isEnabled && inWindow) {
            logger.info(`✅ Executing ${c} trades: ${opportunities.length} opportunities, in window, toggle ON`);
            const trades = await this.executor.executeSingleLegTrades(opportunities);
            totalTradesExecuted += trades.length;
          } else if (opportunities.length > 0) {
            // Log why we're not trading
            if (!isEnabled) {
              logger.info(`⛔ ${c} has ${opportunities.length} opportunity(ies) but toggle is OFF`);
            } else if (!inWindow) {
              logger.info(`⏰ ${c} has ${opportunities.length} opportunity(ies) but outside trading window (minute ${new Date().getMinutes()})`);
            }
          }
        } catch (err: any) {
          logger.error(`Force scan failed for ${c}: ${err.message}`);
          logger.error(`Stack: ${err.stack}`);
          // Don't throw - continue with other cryptos
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

