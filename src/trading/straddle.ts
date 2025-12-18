import { StraddleOpportunity, HourlyMarket, SingleLegOpportunity, Market, Token } from '../types';
import { ParsedMarket } from '../polymarket/markets';
import { createLogger } from '../utils/logger';

const logger = createLogger('StrategyCalculator');

/**
 * UPDATED STRATEGY - Single Leg Expensive Options
 * 
 * Based on research showing expensive options (≥70¢) win ~98% of the time:
 * - Buy whichever side hits 70¢ first
 * - Expected value: 0.98 × $1 - $0.70 = +$0.28 per share (+40% ROI)
 * 
 * This is simpler and more profitable than balanced straddles.
 */

// Strategy threshold - buy when price hits this level
const EXPENSIVE_THRESHOLD = 0.70; // 70¢ = trigger to buy

// Expected win rate for options at different price points
function getExpectedWinRate(price: number): number {
  if (price >= 0.80) return 0.99;      // 80¢+ wins ~99%
  if (price >= 0.70) return 0.98;      // 70-80¢ wins ~98%
  if (price >= 0.60) return 0.93;      // 60-70¢ wins ~93%
  if (price >= 0.50) return 0.80;      // 50-60¢ wins ~80%
  return price;                         // Below 50¢, use implied
}

export interface StraddleConfig {
  betSize: number;           // Amount to bet on the expensive leg
  maxCombinedCost: number;   // Not used in new strategy, kept for compatibility
}

export class StraddleCalculator {
  constructor(private config: StraddleConfig) {}

  /**
   * NEW STRATEGY: Find single-leg opportunities where one side is ≥70¢
   * Buy the expensive side only
   */
  findSingleLegOpportunity(market: HourlyMarket): SingleLegOpportunity | null {
    const upPrice = market.upToken.price;
    const downPrice = market.downToken.price;

    // Validate prices
    if (upPrice <= 0 || downPrice <= 0) {
      return null;
    }

    // Check if UP side is expensive (≥70¢)
    if (upPrice >= EXPENSIVE_THRESHOLD) {
      const size = this.config.betSize / upPrice;
      const expectedWinRate = getExpectedWinRate(upPrice);
      const expectedValue = (expectedWinRate * 1.0) - upPrice; // EV per share

      logger.info(`🎯 Found expensive UP option: ${market.title}`, {
        side: 'UP',
        price: `${(upPrice * 100).toFixed(1)}¢`,
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

    // Check if DOWN side is expensive (≥70¢)
    if (downPrice >= EXPENSIVE_THRESHOLD) {
      const size = this.config.betSize / downPrice;
      const expectedWinRate = getExpectedWinRate(downPrice);
      const expectedValue = (expectedWinRate * 1.0) - downPrice; // EV per share

      logger.info(`🎯 Found expensive DOWN option: ${market.title}`, {
        side: 'DOWN',
        price: `${(downPrice * 100).toFixed(1)}¢`,
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

    // Neither side is expensive enough
    logger.debug(`Market ${market.title}: No side at 70¢+ (Up=${(upPrice*100).toFixed(1)}¢, Down=${(downPrice*100).toFixed(1)}¢)`);
    return null;
  }

  /**
   * Find all single-leg opportunities from hourly markets
   */
  findSingleLegOpportunities(markets: HourlyMarket[]): SingleLegOpportunity[] {
    const opportunities: SingleLegOpportunity[] = [];

    for (const market of markets) {
      const opportunity = this.findSingleLegOpportunity(market);
      if (opportunity) {
        opportunities.push(opportunity);
      }
    }

    // Sort by expected value (highest first)
    opportunities.sort((a, b) => b.expectedValue - a.expectedValue);

    logger.info(`Found ${opportunities.length} single-leg opportunities at ≥70¢`);
    return opportunities;
  }

  /**
   * Analyze hourly market for dashboard display
   * Returns info about both sides for UI
   */
  analyzeHourlyMarket(market: HourlyMarket): {
    upPrice: number;
    downPrice: number;
    combinedCost: number;
    isViable: boolean;
    viableSide: 'up' | 'down' | null;
    expectedValue: number;
  } {
    const upPrice = market.upToken.price;
    const downPrice = market.downToken.price;
    const combinedCost = upPrice + downPrice;

    let isViable = false;
    let viableSide: 'up' | 'down' | null = null;
    let expectedValue = 0;

    if (upPrice >= EXPENSIVE_THRESHOLD) {
      isViable = true;
      viableSide = 'up';
      const winRate = getExpectedWinRate(upPrice);
      expectedValue = (winRate * 1.0 - upPrice) * (this.config.betSize / upPrice);
    } else if (downPrice >= EXPENSIVE_THRESHOLD) {
      isViable = true;
      viableSide = 'down';
      const winRate = getExpectedWinRate(downPrice);
      expectedValue = (winRate * 1.0 - downPrice) * (this.config.betSize / downPrice);
    }

    return {
      upPrice,
      downPrice,
      combinedCost,
      isViable,
      viableSide,
      expectedValue,
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
