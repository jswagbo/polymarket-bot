import { v4 as uuidv4 } from 'uuid';
import { Trade, StraddleOpportunity, TradeStatus } from '../types';
import { PolymarketClient } from '../polymarket/client';
import { Database } from '../db/database';
import { createLogger } from '../utils/logger';

const logger = createLogger('TradeExecutor');

export class TradeExecutor {
  constructor(
    private client: PolymarketClient,
    private db: Database
  ) {}

  /**
   * Execute a straddle trade (buy both up and down)
   */
  async executeStraddle(opportunity: StraddleOpportunity): Promise<Trade | null> {
    const tradeId = uuidv4();
    
    logger.info(`Executing straddle for market: ${opportunity.market.question}`, {
      tradeId,
      upPrice: opportunity.upPrice,
      downPrice: opportunity.downPrice,
      upSize: opportunity.upSize,
      downSize: opportunity.downSize,
    });

    // Create trade record
    const trade: Trade = {
      id: tradeId,
      market_id: opportunity.market.condition_id,
      market_question: opportunity.market.question,
      up_token_id: opportunity.upToken.token_id,
      down_token_id: opportunity.downToken.token_id,
      up_price: opportunity.upPrice,
      down_price: opportunity.downPrice,
      up_size: opportunity.upSize,
      down_size: opportunity.downSize,
      combined_cost: opportunity.combinedCost,
      status: 'pending',
      created_at: new Date().toISOString(),
    };

    // Save trade to database
    this.db.saveTrade(trade);

    if (this.client.isReadOnly()) {
      logger.warn('Client is in read-only mode - simulating trade');
      trade.status = 'open';
      trade.up_order_id = 'simulated-up-' + tradeId;
      trade.down_order_id = 'simulated-down-' + tradeId;
      this.db.updateTrade(trade);
      return trade;
    }

    try {
      // Place UP order
      logger.info(`Placing UP order: ${opportunity.upSize} shares at $${opportunity.upPrice}`);
      const upOrder = await this.client.placeBuyOrder(
        opportunity.upToken.token_id,
        opportunity.upPrice,
        opportunity.upSize
      );
      trade.up_order_id = upOrder.orderID || upOrder.id;
      trade.status = 'partial';
      this.db.updateTrade(trade);

      // Place DOWN order
      logger.info(`Placing DOWN order: ${opportunity.downSize} shares at $${opportunity.downPrice}`);
      const downOrder = await this.client.placeBuyOrder(
        opportunity.downToken.token_id,
        opportunity.downPrice,
        opportunity.downSize
      );
      trade.down_order_id = downOrder.orderID || downOrder.id;
      trade.status = 'open';
      this.db.updateTrade(trade);

      logger.info(`Straddle executed successfully: ${tradeId}`);
      return trade;

    } catch (error) {
      logger.error(`Failed to execute straddle: ${tradeId}`, error);
      trade.status = 'failed';
      this.db.updateTrade(trade);

      // Try to cancel any placed orders
      if (trade.up_order_id) {
        try {
          await this.client.cancelOrder(trade.up_order_id);
        } catch (cancelError) {
          logger.error('Failed to cancel UP order', cancelError);
        }
      }
      if (trade.down_order_id) {
        try {
          await this.client.cancelOrder(trade.down_order_id);
        } catch (cancelError) {
          logger.error('Failed to cancel DOWN order', cancelError);
        }
      }

      return null;
    }
  }

  /**
   * Execute multiple straddles
   */
  async executeStraddles(opportunities: StraddleOpportunity[]): Promise<Trade[]> {
    const trades: Trade[] = [];

    for (const opportunity of opportunities) {
      // Check if we already have an open trade for this market
      const existingTrade = this.db.getTradeByMarketId(opportunity.market.condition_id);
      if (existingTrade && ['pending', 'open', 'partial'].includes(existingTrade.status)) {
        logger.info(`Skipping market ${opportunity.market.condition_id} - already have open trade`);
        continue;
      }

      const trade = await this.executeStraddle(opportunity);
      if (trade) {
        trades.push(trade);
      }

      // Add small delay between orders to avoid rate limiting
      await this.delay(500);
    }

    return trades;
  }

  /**
   * Cancel an open trade
   */
  async cancelTrade(tradeId: string): Promise<boolean> {
    const trade = this.db.getTrade(tradeId);
    if (!trade) {
      logger.error(`Trade not found: ${tradeId}`);
      return false;
    }

    if (trade.status !== 'open' && trade.status !== 'partial') {
      logger.warn(`Cannot cancel trade in status: ${trade.status}`);
      return false;
    }

    try {
      if (trade.up_order_id && !this.client.isReadOnly()) {
        await this.client.cancelOrder(trade.up_order_id);
      }
      if (trade.down_order_id && !this.client.isReadOnly()) {
        await this.client.cancelOrder(trade.down_order_id);
      }

      trade.status = 'cancelled';
      this.db.updateTrade(trade);
      logger.info(`Trade cancelled: ${tradeId}`);
      return true;

    } catch (error) {
      logger.error(`Failed to cancel trade: ${tradeId}`, error);
      return false;
    }
  }

  /**
   * Update trade status based on market resolution
   */
  async checkAndUpdateTradeStatus(trade: Trade): Promise<Trade> {
    // In a full implementation, this would check if the market has resolved
    // and update the trade PnL accordingly
    // For now, return the trade as-is
    return trade;
  }

  private delay(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}

