/**
 * Volatility Filter Module
 * 
 * Prevents trading during high-volatility periods to improve win rate.
 * Implements multiple filtering strategies:
 * - Time-based filtering (skip known volatile hours)
 * - Real-time volatility check (Binance price swings)
 * - Order book spread analysis
 * - Volume threshold filtering
 */

import { createLogger } from '../utils/logger';

const logger = createLogger('VolatilityFilter');

// Binance API for real-time crypto prices
const BINANCE_API = 'https://api.binance.com/api/v3';

export interface VolatilityConfig {
  // Time-based filtering
  skipVolatileHours: boolean;
  volatileHoursET: number[];  // Hours to skip (Eastern Time)
  
  // Real-time volatility
  checkRealTimeVolatility: boolean;
  maxHourlyVolatilityPercent: number;  // Skip if price swung more than this % in last hour
  
  // Spread filtering
  checkSpread: boolean;
  maxSpreadCents: number;  // Skip if bid-ask spread > this many cents
  
  // Volume filtering
  checkVolume: boolean;
  minVolumeUsd: number;
  maxVolumeUsd: number;
}

export interface VolatilityCheck {
  canTrade: boolean;
  reasons: string[];
  details: {
    hour?: number;
    isVolatileHour?: boolean;
    volatilityPercent?: number;
    spreadCents?: number;
    volumeUsd?: number;
  };
}

// Default configuration
export const DEFAULT_VOLATILITY_CONFIG: VolatilityConfig = {
  skipVolatileHours: true,
  volatileHoursET: [9, 10, 15, 16],  // US market open/close hours
  
  checkRealTimeVolatility: true,
  maxHourlyVolatilityPercent: 2.0,  // Skip if > 2% swing in last hour
  
  checkSpread: true,
  maxSpreadCents: 5,  // Skip if spread > 5 cents
  
  checkVolume: true,
  minVolumeUsd: 100,
  maxVolumeUsd: 50000,
};

export class VolatilityFilter {
  private config: VolatilityConfig;
  
  constructor(config: Partial<VolatilityConfig> = {}) {
    this.config = { ...DEFAULT_VOLATILITY_CONFIG, ...config };
  }
  
  /**
   * Update configuration
   */
  updateConfig(config: Partial<VolatilityConfig>): void {
    this.config = { ...this.config, ...config };
    logger.info('Volatility config updated:', this.config);
  }
  
  /**
   * Get current configuration
   */
  getConfig(): VolatilityConfig {
    return { ...this.config };
  }
  
  /**
   * Check if current hour is volatile (time-based)
   */
  isVolatileHour(): { isVolatile: boolean; hour: number } {
    // Get current hour in Eastern Time
    const now = new Date();
    const etHour = parseInt(
      now.toLocaleString('en-US', { 
        timeZone: 'America/New_York', 
        hour: 'numeric', 
        hour12: false 
      })
    );
    
    const isVolatile = this.config.volatileHoursET.includes(etHour);
    
    return { isVolatile, hour: etHour };
  }
  
  /**
   * Check real-time volatility from Binance
   * Returns the max price swing in the last hour
   */
  async checkBinanceVolatility(crypto: string): Promise<{ volatilityPercent: number; isHigh: boolean }> {
    const symbol = `${crypto}USDT`;
    
    try {
      // Get 5-minute candles for the last hour (12 candles)
      const response = await fetch(
        `${BINANCE_API}/klines?symbol=${symbol}&interval=5m&limit=12`
      );
      
      if (!response.ok) {
        logger.warn(`Binance API returned ${response.status} for ${symbol}`);
        return { volatilityPercent: 0, isHigh: false };
      }
      
      const candles = await response.json() as any[];
      
      if (!Array.isArray(candles) || candles.length === 0) {
        return { volatilityPercent: 0, isHigh: false };
      }
      
      // Calculate max swing across all candles
      let minLow = Infinity;
      let maxHigh = -Infinity;
      
      for (const candle of candles) {
        const high = parseFloat(candle[2]);
        const low = parseFloat(candle[3]);
        
        if (high > maxHigh) maxHigh = high;
        if (low < minLow) minLow = low;
      }
      
      // Calculate percentage swing
      const midPrice = (maxHigh + minLow) / 2;
      const volatilityPercent = ((maxHigh - minLow) / midPrice) * 100;
      
      const isHigh = volatilityPercent > this.config.maxHourlyVolatilityPercent;
      
      logger.debug(
        `${crypto} volatility: ${volatilityPercent.toFixed(2)}% (max: ${this.config.maxHourlyVolatilityPercent}%) - ${isHigh ? 'HIGH' : 'OK'}`
      );
      
      return { volatilityPercent, isHigh };
    } catch (error: any) {
      logger.warn(`Failed to check Binance volatility for ${crypto}: ${error.message}`);
      return { volatilityPercent: 0, isHigh: false };
    }
  }
  
  /**
   * Check order book spread for a Polymarket token
   */
  async checkPolymarketSpread(tokenId: string): Promise<{ spreadCents: number; isWide: boolean }> {
    try {
      const response = await fetch(`https://clob.polymarket.com/book?token_id=${tokenId}`);
      
      if (!response.ok) {
        return { spreadCents: 0, isWide: false };
      }
      
      const book = await response.json() as any;
      
      if (!book.bids?.length || !book.asks?.length) {
        // No liquidity = definitely skip
        return { spreadCents: 100, isWide: true };
      }
      
      const bestBid = parseFloat(book.bids[0].price);
      const bestAsk = parseFloat(book.asks[0].price);
      const spreadCents = (bestAsk - bestBid) * 100;
      
      const isWide = spreadCents > this.config.maxSpreadCents;
      
      logger.debug(
        `Token ${tokenId.slice(0, 10)}... spread: ${spreadCents.toFixed(1)}¢ (max: ${this.config.maxSpreadCents}¢) - ${isWide ? 'WIDE' : 'OK'}`
      );
      
      return { spreadCents, isWide };
    } catch (error: any) {
      logger.warn(`Failed to check spread: ${error.message}`);
      return { spreadCents: 0, isWide: false };
    }
  }
  
  /**
   * Check if market volume is within acceptable range
   */
  checkVolume(volumeUsd: number): { isAcceptable: boolean; reason?: string } {
    if (volumeUsd < this.config.minVolumeUsd) {
      return { 
        isAcceptable: false, 
        reason: `Volume too low: $${volumeUsd.toFixed(0)} < $${this.config.minVolumeUsd}` 
      };
    }
    
    if (volumeUsd > this.config.maxVolumeUsd) {
      return { 
        isAcceptable: false, 
        reason: `Volume unusually high: $${volumeUsd.toFixed(0)} > $${this.config.maxVolumeUsd}` 
      };
    }
    
    return { isAcceptable: true };
  }
  
  /**
   * Run all volatility checks for a market
   */
  async checkAll(
    crypto: string,
    tokenId: string,
    volumeUsd: number
  ): Promise<VolatilityCheck> {
    const reasons: string[] = [];
    const details: VolatilityCheck['details'] = {};
    
    // 1. Time-based check
    if (this.config.skipVolatileHours) {
      const { isVolatile, hour } = this.isVolatileHour();
      details.hour = hour;
      details.isVolatileHour = isVolatile;
      
      if (isVolatile) {
        reasons.push(`Volatile hour (${hour}:00 ET)`);
      }
    }
    
    // 2. Real-time volatility check
    if (this.config.checkRealTimeVolatility) {
      const { volatilityPercent, isHigh } = await this.checkBinanceVolatility(crypto);
      details.volatilityPercent = volatilityPercent;
      
      if (isHigh) {
        reasons.push(`High volatility: ${volatilityPercent.toFixed(1)}%`);
      }
    }
    
    // 3. Spread check
    if (this.config.checkSpread && tokenId) {
      const { spreadCents, isWide } = await this.checkPolymarketSpread(tokenId);
      details.spreadCents = spreadCents;
      
      if (isWide) {
        reasons.push(`Wide spread: ${spreadCents.toFixed(1)}¢`);
      }
    }
    
    // 4. Volume check
    if (this.config.checkVolume) {
      const volumeCheck = this.checkVolume(volumeUsd);
      details.volumeUsd = volumeUsd;
      
      if (!volumeCheck.isAcceptable && volumeCheck.reason) {
        reasons.push(volumeCheck.reason);
      }
    }
    
    const canTrade = reasons.length === 0;
    
    if (!canTrade) {
      logger.info(`⚠️ Volatility filter BLOCKED trade: ${reasons.join(', ')}`);
    }
    
    return { canTrade, reasons, details };
  }
  
  /**
   * Quick check - just time-based (fast, no API calls)
   */
  quickCheck(): { canTrade: boolean; reason?: string } {
    if (!this.config.skipVolatileHours) {
      return { canTrade: true };
    }
    
    const { isVolatile, hour } = this.isVolatileHour();
    
    if (isVolatile) {
      return { 
        canTrade: false, 
        reason: `Skipping volatile hour (${hour}:00 ET)` 
      };
    }
    
    return { canTrade: true };
  }
}

// Singleton instance
let filterInstance: VolatilityFilter | null = null;

export function getVolatilityFilter(config?: Partial<VolatilityConfig>): VolatilityFilter {
  if (!filterInstance) {
    filterInstance = new VolatilityFilter(config);
  } else if (config) {
    filterInstance.updateConfig(config);
  }
  return filterInstance;
}


