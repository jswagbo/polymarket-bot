import { StraddleOpportunity, HourlyMarket } from '../types';
import { ParsedMarket } from '../polymarket/markets';
import { RuntimeConfig } from '../config';
import { createLogger } from '../utils/logger';

const logger = createLogger('StraddleCalculator');

/**
 * Based on the user's research:
 * - Cheap options (<40¢) hit WAY less than implied
 * - Expensive options (>60¢) hit WAY more than implied
 * 
 * Strategy thresholds:
 * - CHEAP: < 40¢ (wins way less than implied ~10% vs ~35%)
 * - EXPENSIVE: > 60¢ (wins way more than implied ~93% vs ~65%)
 * 
 * The strategy: Buy balanced straddles where one leg is cheap and one is expensive.
 * The expensive leg overperforms, creating net positive expectation.
 */

// Strategy thresholds
const CHEAP_THRESHOLD = 0.40;     // Below 40¢ = cheap
const EXPENSIVE_THRESHOLD = 0.60; // Above 60¢ = expensive

export interface StraddleConfig {
  betSize: number;           // Total amount to bet (split between up/down)
  maxCombinedCost: number;   // Maximum combined price (e.g., 1.05 = $1.05)
}

export class StraddleCalculator {
  constructor(private config: StraddleConfig) {}

  /**
   * Analyze a market for straddle opportunity
   */
  analyzeMarket(market: ParsedMarket): StraddleOpportunity | null {
    if (!market.upToken || !market.downToken) {
      logger.debug(`Market ${market.id} missing tokens`);
      return null;
    }

    const upPrice = market.upToken.price;
    const downPrice = market.downToken.price;

    // Validate prices
    if (upPrice <= 0 || downPrice <= 0) {
      logger.debug(`Market ${market.id} has invalid prices: up=${upPrice}, down=${downPrice}`);
      return null;
    }

    const combinedCost = upPrice + downPrice;

    // Check if combined cost is within acceptable range
    if (combinedCost > this.config.maxCombinedCost) {
      logger.debug(`Market ${market.id} combined cost too high: ${combinedCost}`);
      return null;
    }

    // Calculate balanced position sizes
    // We want roughly equal dollar exposure on each side
    const halfBet = this.config.betSize / 2;
    const upSize = halfBet / upPrice;
    const downSize = halfBet / downPrice;

    // Calculate expected value based on the miscalibration thesis
    const expectedValue = this.calculateExpectedValue(upPrice, downPrice, upSize, downSize);

    const isViable = this.isViableStraddle(upPrice, downPrice, combinedCost);

    return {
      market: {
        id: market.id,
        condition_id: market.conditionId,
        question: market.question,
        description: '',
        market_slug: market.slug,
        end_date_iso: market.endDate.toISOString(),
        active: market.isActive,
        closed: false,
        tokens: [],
        minimum_order_size: 1,
        minimum_tick_size: 0.01,
      },
      upToken: {
        token_id: market.upToken.tokenId,
        outcome: market.upToken.outcome,
        price: upPrice,
        winner: false,
      },
      downToken: {
        token_id: market.downToken.tokenId,
        outcome: market.downToken.outcome,
        price: downPrice,
        winner: false,
      },
      upPrice,
      downPrice,
      combinedCost,
      upSize,
      downSize,
      expectedValue,
      isViable,
    };
  }

  /**
   * Calculate expected value based on the odds miscalibration thesis
   * 
   * Key insight from user's research:
   * - 20-30¢ options win 3% (implied ~25%) 
   * - 30-40¢ options win 10% (implied ~35%)
   * - 60-70¢ options win 93% (implied ~65%)
   * - 70-80¢ options win 98% (implied ~75%)
   */
  private calculateExpectedValue(
    upPrice: number,
    downPrice: number,
    upSize: number,
    downSize: number
  ): number {
    // Get adjusted win probabilities based on miscalibration
    const upWinProb = this.getAdjustedProbability(upPrice);
    const downWinProb = this.getAdjustedProbability(downPrice);

    // Calculate expected returns
    // If up wins: gain (1 - upPrice) * upSize, lose downPrice * downSize
    // If down wins: lose upPrice * upSize, gain (1 - downPrice) * downSize
    
    const upWinPayout = upSize * 1.0; // Win $1 per share
    const downWinPayout = downSize * 1.0;
    
    const upCost = upPrice * upSize;
    const downCost = downPrice * downSize;
    const totalCost = upCost + downCost;

    // Expected value calculation
    const evUpWins = upWinProb * (upWinPayout - totalCost);
    const evDownWins = downWinProb * (downWinPayout - totalCost);
    
    // Since one must win (binary market), total EV is the weighted sum
    // but we need to handle the case where probabilities don't sum to 1
    const totalProb = upWinProb + downWinProb;
    const normalizedUpProb = upWinProb / totalProb;
    const normalizedDownProb = downWinProb / totalProb;

    const expectedPayout = normalizedUpProb * upWinPayout + normalizedDownProb * downWinPayout;
    const expectedValue = expectedPayout - totalCost;

    return expectedValue;
  }

  /**
   * Get adjusted win probability based on the miscalibration data
   */
  private getAdjustedProbability(price: number): number {
    // Mapping from implied price to actual win rate based on user's research
    if (price < 0.20) {
      return 0.01; // Very cheap, almost never wins
    } else if (price < 0.30) {
      return 0.03; // 20-30¢ wins 3%
    } else if (price < 0.40) {
      return 0.10; // 30-40¢ wins 10%
    } else if (price < 0.50) {
      return 0.20; // 40-50¢ wins ~20% (interpolated)
    } else if (price < 0.60) {
      return 0.80; // 50-60¢ wins ~80% (interpolated)
    } else if (price < 0.70) {
      return 0.93; // 60-70¢ wins 93%
    } else if (price < 0.80) {
      return 0.98; // 70-80¢ wins 98%
    } else {
      return 0.99; // 80¢+ almost always wins
    }
  }

  /**
   * Determine if a straddle is viable based on the strategy
   * 
   * Requirements:
   * - One leg must be CHEAP (< 40¢)
   * - One leg must be EXPENSIVE (> 60¢)
   * - Combined cost must be within max allowed
   */
  private isViableStraddle(upPrice: number, downPrice: number, combinedCost: number): boolean {
    // Check if one leg is cheap (< 40¢)
    const hasCheapLeg = upPrice < CHEAP_THRESHOLD || downPrice < CHEAP_THRESHOLD;
    
    // Check if one leg is expensive (> 60¢)
    const hasExpensiveLeg = upPrice > EXPENSIVE_THRESHOLD || downPrice > EXPENSIVE_THRESHOLD;
    
    // Combined cost must be reasonable
    const costOk = combinedCost <= this.config.maxCombinedCost;
    
    // Need BOTH a cheap leg AND an expensive leg for the strategy to work
    const hasRequiredSkew = hasCheapLeg && hasExpensiveLeg;
    
    if (!hasRequiredSkew && (upPrice > 0 && downPrice > 0)) {
      logger.debug(`Market skipped - no sufficient skew: up=${(upPrice*100).toFixed(1)}¢, down=${(downPrice*100).toFixed(1)}¢ (need <${CHEAP_THRESHOLD*100}¢ AND >${EXPENSIVE_THRESHOLD*100}¢)`);
    }
    
    return hasRequiredSkew && costOk;
  }

  /**
   * Find all viable straddle opportunities from a list of markets
   */
  findOpportunities(markets: ParsedMarket[]): StraddleOpportunity[] {
    const opportunities: StraddleOpportunity[] = [];

    for (const market of markets) {
      const opportunity = this.analyzeMarket(market);
      if (opportunity && opportunity.isViable) {
        opportunities.push(opportunity);
        logger.info(`Found opportunity: ${market.question}`, {
          upPrice: opportunity.upPrice.toFixed(3),
          downPrice: opportunity.downPrice.toFixed(3),
          combinedCost: opportunity.combinedCost.toFixed(3),
          expectedValue: opportunity.expectedValue.toFixed(4),
        });
      }
    }

    // Sort by expected value (highest first)
    opportunities.sort((a, b) => b.expectedValue - a.expectedValue);

    return opportunities;
  }

  updateConfig(config: Partial<StraddleConfig>) {
    if (config.betSize !== undefined) this.config.betSize = config.betSize;
    if (config.maxCombinedCost !== undefined) this.config.maxCombinedCost = config.maxCombinedCost;
  }

  /**
   * Analyze an hourly market (from Gamma API) for straddle opportunity
   */
  analyzeHourlyMarket(market: HourlyMarket): StraddleOpportunity | null {
    const upPrice = market.upToken.price;
    const downPrice = market.downToken.price;

    // Validate prices
    if (upPrice <= 0 || downPrice <= 0) {
      logger.debug(`Market ${market.eventId} has invalid prices: up=${upPrice}, down=${downPrice}`);
      return null;
    }

    const combinedCost = upPrice + downPrice;

    // Check if combined cost is within acceptable range
    if (combinedCost > this.config.maxCombinedCost) {
      logger.debug(`Market ${market.eventId} combined cost too high: ${combinedCost}`);
      return null;
    }

    // Calculate balanced position sizes
    const halfBet = this.config.betSize / 2;
    const upSize = halfBet / upPrice;
    const downSize = halfBet / downPrice;

    // Calculate expected value based on the miscalibration thesis
    const expectedValue = this.calculateExpectedValue(upPrice, downPrice, upSize, downSize);

    const isViable = this.isViableStraddle(upPrice, downPrice, combinedCost);

    return {
      market: {
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
      },
      upToken: {
        token_id: market.upToken.tokenId,
        outcome: 'Up',
        price: upPrice,
        winner: false,
      },
      downToken: {
        token_id: market.downToken.tokenId,
        outcome: 'Down',
        price: downPrice,
        winner: false,
      },
      upPrice,
      downPrice,
      combinedCost,
      upSize,
      downSize,
      expectedValue,
      isViable,
    };
  }

  /**
   * Find opportunities from hourly markets
   */
  findHourlyOpportunities(markets: HourlyMarket[]): StraddleOpportunity[] {
    const opportunities: StraddleOpportunity[] = [];

    for (const market of markets) {
      const opportunity = this.analyzeHourlyMarket(market);
      if (opportunity && opportunity.isViable) {
        opportunities.push(opportunity);
        logger.info(`Found hourly opportunity: ${market.title}`, {
          upPrice: opportunity.upPrice.toFixed(3),
          downPrice: opportunity.downPrice.toFixed(3),
          combinedCost: opportunity.combinedCost.toFixed(3),
          expectedValue: opportunity.expectedValue.toFixed(4),
          hoursLeft: market.hoursUntilClose.toFixed(1),
        });
      }
    }

    // Sort by expected value (highest first)
    opportunities.sort((a, b) => b.expectedValue - a.expectedValue);

    return opportunities;
  }
}

