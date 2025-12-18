import { StraddleOpportunity } from '../types';
import { ParsedMarket } from '../polymarket/markets';
import { RuntimeConfig } from '../config';
import { createLogger } from '../utils/logger';

const logger = createLogger('StraddleCalculator');

/**
 * Based on the user's research:
 * - Cheap options (<50¢) hit WAY less than implied
 * - Expensive options (>50¢) hit WAY more than implied
 * 
 * The strategy: Buy balanced straddles where one leg is cheap and one is expensive.
 * The expensive leg overperforms, creating net positive expectation.
 */

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
   */
  private isViableStraddle(upPrice: number, downPrice: number, combinedCost: number): boolean {
    // The strategy works best when:
    // 1. One leg is cheap (<50¢) and one is expensive (>50¢)
    // 2. Combined cost is reasonable (ideally < $1.00, max $1.05)
    
    const hasCheapLeg = upPrice < 0.50 || downPrice < 0.50;
    const hasExpensiveLeg = upPrice >= 0.50 || downPrice >= 0.50;
    const costOk = combinedCost <= this.config.maxCombinedCost;
    
    // Both legs shouldn't be on the same side of 50¢
    const isBalanced = hasCheapLeg && hasExpensiveLeg;
    
    return isBalanced && costOk;
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
}

