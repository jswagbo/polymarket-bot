import { StraddleOpportunity, HourlyMarket, SingleLegOpportunity, Market, Token } from '../types';
import { ParsedMarket } from '../polymarket/markets';
import { createLogger } from '../utils/logger';

const logger = createLogger('StrategyCalculator');

/**
 * UPDATED STRATEGY - Single Leg Expensive Options
 * 
 * Buy when price is within the configured range (min threshold to max threshold).
 * This prevents buying options that are too expensive (above 94¢).
 * Sweet spot: 90¢ - 94¢ offers good win rates without overpaying.
 */

// Default thresholds if not specified
const DEFAULT_THRESHOLD = 0.90;     // 90¢ = minimum to buy
const MAX_PRICE_THRESHOLD = 0.94;   // 94¢ = maximum to buy (don't overpay)

// Expected win rate for options at different price points
function getExpectedWinRate(price: number): number {
  if (price >= 0.90) return 0.995;     // 90¢+ wins ~99.5%
  if (price >= 0.80) return 0.99;      // 80¢+ wins ~99%
  if (price >= 0.70) return 0.98;      // 70-80¢ wins ~98%
  if (price >= 0.60) return 0.93;      // 60-70¢ wins ~93%
  if (price >= 0.50) return 0.80;      // 50-60¢ wins ~80%
  return price;                         // Below 50¢, use implied
}

export interface StraddleConfig {
  betSize: number;           // Amount to bet on the expensive leg
  maxCombinedCost: number;   // Not used in new strategy, kept for compatibility
  minPriceThreshold?: number; // Optional: per-crypto price threshold
}

export class StraddleCalculator {
  constructor(private config: StraddleConfig) {}

  // Get the threshold to use (from config or default)
  private getThreshold(): number {
    return this.config.minPriceThreshold ?? DEFAULT_THRESHOLD;
  }

  /**
   * NEW STRATEGY: Find single-leg opportunities where one side is within the buy range
   * Buy the expensive side only if price is between minThreshold and maxThreshold
   * @param market The hourly market to analyze
   * @param customThreshold Optional override minimum threshold (for per-crypto settings)
   * @param customBetSize Optional override bet size (for per-crypto settings)
   */
  findSingleLegOpportunity(
    market: HourlyMarket, 
    customThreshold?: number,
    customBetSize?: number
  ): SingleLegOpportunity | null {
    const upPrice = market.upToken.price;
    const downPrice = market.downToken.price;
    const minThreshold = customThreshold ?? this.getThreshold();
    const maxThreshold = MAX_PRICE_THRESHOLD;
    const betSize = customBetSize ?? this.config.betSize;
    const minPct = (minThreshold * 100).toFixed(0);
    const maxPct = (maxThreshold * 100).toFixed(0);

    // Validate prices
    if (upPrice <= 0 || downPrice <= 0) {
      return null;
    }

    // Check if UP side is in buy range (≥ minThreshold AND ≤ maxThreshold)
    if (upPrice >= minThreshold && upPrice <= maxThreshold) {
      const size = betSize / upPrice;
      const expectedWinRate = getExpectedWinRate(upPrice);
      const expectedValue = (expectedWinRate * 1.0) - upPrice; // EV per share

      logger.info(`🎯 Found UP option in buy range: ${market.title}`, {
        side: 'UP',
        price: `${(upPrice * 100).toFixed(1)}¢`,
        range: `${minPct}¢-${maxPct}¢`,
        expectedWinRate: `${(expectedWinRate * 100).toFixed(0)}%`,
        expectedValue: `+$${(expectedValue * size).toFixed(2)}`,
      });

      return {
        market: this.buildMarketObject(market),
        token: {
          token_id: market.upToken.tokenId,
          outcome: 'Up',
          price: upPrice,
          winner: false,
        },
        side: 'up',
        price: upPrice,
        size,
        expectedValue: expectedValue * size,
        expectedWinRate,
        isViable: true,
      };
    }

    // Check if DOWN side is in buy range (≥ minThreshold AND ≤ maxThreshold)
    if (downPrice >= minThreshold && downPrice <= maxThreshold) {
      const size = betSize / downPrice;
      const expectedWinRate = getExpectedWinRate(downPrice);
      const expectedValue = (expectedWinRate * 1.0) - downPrice; // EV per share

      logger.info(`🎯 Found DOWN option in buy range: ${market.title}`, {
        side: 'DOWN',
        price: `${(downPrice * 100).toFixed(1)}¢`,
        range: `${minPct}¢-${maxPct}¢`,
        expectedWinRate: `${(expectedWinRate * 100).toFixed(0)}%`,
        expectedValue: `+$${(expectedValue * size).toFixed(2)}`,
      });

      return {
        market: this.buildMarketObject(market),
        token: {
          token_id: market.downToken.tokenId,
          outcome: 'Down',
          price: downPrice,
          winner: false,
        },
        side: 'down',
        price: downPrice,
        size,
        expectedValue: expectedValue * size,
        expectedWinRate,
        isViable: true,
      };
    }

    // Log why we're not buying
    if (upPrice > maxThreshold || downPrice > maxThreshold) {
      logger.debug(`Market ${market.title}: Price too high - above ${maxPct}¢ max (Up=${(upPrice*100).toFixed(1)}¢, Down=${(downPrice*100).toFixed(1)}¢)`);
    } else {
      logger.debug(`Market ${market.title}: No side in ${minPct}¢-${maxPct}¢ range (Up=${(upPrice*100).toFixed(1)}¢, Down=${(downPrice*100).toFixed(1)}¢)`);
    }
    return null;
  }

  /**
   * Find all single-leg opportunities from hourly markets
   * @param markets The hourly markets to scan
   * @param customThreshold Optional override minimum threshold (for per-crypto settings)
   * @param customBetSize Optional override bet size (for per-crypto settings)
   */
  findSingleLegOpportunities(
    markets: HourlyMarket[],
    customThreshold?: number,
    customBetSize?: number
  ): SingleLegOpportunity[] {
    const opportunities: SingleLegOpportunity[] = [];
    const minThreshold = customThreshold ?? this.getThreshold();
    const maxThreshold = MAX_PRICE_THRESHOLD;
    const minPct = (minThreshold * 100).toFixed(0);
    const maxPct = (maxThreshold * 100).toFixed(0);

    for (const market of markets) {
      const opportunity = this.findSingleLegOpportunity(market, customThreshold, customBetSize);
      if (opportunity) {
        opportunities.push(opportunity);
      }
    }

    // Sort by expected value (highest first)
    opportunities.sort((a, b) => b.expectedValue - a.expectedValue);

    logger.info(`Found ${opportunities.length} single-leg opportunities in ${minPct}¢-${maxPct}¢ range`);
    return opportunities;
  }

  /**
   * Analyze hourly market for dashboard display
   * Returns info about both sides for UI
   * @param market The hourly market to analyze
   * @param customThreshold Optional override minimum threshold (for per-crypto settings)
   * @param customBetSize Optional override bet size (for per-crypto settings)
   */
  analyzeHourlyMarket(
    market: HourlyMarket,
    customThreshold?: number,
    customBetSize?: number
  ): {
    upPrice: number;
    downPrice: number;
    combinedCost: number;
    isViable: boolean;
    viableSide: 'up' | 'down' | null;
    expectedValue: number;
    threshold: number;
    maxThreshold: number;
  } {
    const upPrice = market.upToken.price;
    const downPrice = market.downToken.price;
    const combinedCost = upPrice + downPrice;
    const minThreshold = customThreshold ?? this.getThreshold();
    const maxThreshold = MAX_PRICE_THRESHOLD;
    const betSize = customBetSize ?? this.config.betSize;

    let isViable = false;
    let viableSide: 'up' | 'down' | null = null;
    let expectedValue = 0;

    // Check if UP is in buy range (≥ min AND ≤ max)
    if (upPrice >= minThreshold && upPrice <= maxThreshold) {
      isViable = true;
      viableSide = 'up';
      const winRate = getExpectedWinRate(upPrice);
      expectedValue = (winRate * 1.0 - upPrice) * (betSize / upPrice);
    } 
    // Check if DOWN is in buy range (≥ min AND ≤ max)
    else if (downPrice >= minThreshold && downPrice <= maxThreshold) {
      isViable = true;
      viableSide = 'down';
      const winRate = getExpectedWinRate(downPrice);
      expectedValue = (winRate * 1.0 - downPrice) * (betSize / downPrice);
    }

    return {
      upPrice,
      downPrice,
      combinedCost,
      isViable,
      viableSide,
      expectedValue,
      threshold: minThreshold,
      maxThreshold,
    };
  }

  private buildMarketObject(market: HourlyMarket): Market {
    return {
      id: market.eventId,
      condition_id: market.conditionId,
      question: market.title,
      description: '',
      market_slug: market.slug,
      end_date_iso: market.endDate.toISOString(),
      active: true,
      closed: false,
      tokens: [],
      minimum_order_size: 5,
      minimum_tick_size: 0.01,
    };
  }

  updateConfig(config: Partial<StraddleConfig>) {
    if (config.betSize !== undefined) this.config.betSize = config.betSize;
    if (config.maxCombinedCost !== undefined) this.config.maxCombinedCost = config.maxCombinedCost;
  }

  // ============================================
  // LEGACY STRADDLE METHODS (kept for compatibility)
  // ============================================

  analyzeMarket(market: ParsedMarket): StraddleOpportunity | null {
    // Legacy method - not used in new strategy
    return null;
  }

  findOpportunities(markets: ParsedMarket[]): StraddleOpportunity[] {
    // Legacy method - not used in new strategy
    return [];
  }

  findHourlyOpportunities(markets: HourlyMarket[]): StraddleOpportunity[] {
    // Legacy method - not used in new strategy
    return [];
  }
}
