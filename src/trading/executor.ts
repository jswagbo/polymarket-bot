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
    
    logger.info(`=== EXECUTING STRADDLE ===`);
    logger.info(`Trade ID: ${tradeId}`);
    logger.info(`Market: ${opportunity.market.question}`);
    logger.info(`Up Token: ${opportunity.upToken.token_id}`);
    logger.info(`Down Token: ${opportunity.downToken.token_id}`);
    logger.info(`Up Price: $${opportunity.upPrice.toFixed(3)} | Size: ${opportunity.upSize.toFixed(2)}`);
    logger.info(`Down Price: $${opportunity.downPrice.toFixed(3)} | Size: ${opportunity.downSize.toFixed(2)}`);
    logger.info(`Combined Cost: $${opportunity.combinedCost.toFixed(3)}`);

    // Create trade record with explicit null values for optional fields
    // (SQLite needs explicit null, not undefined)
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
      up_order_id: null as any,
      down_order_id: null as any,
      pnl: null as any,
      created_at: new Date().toISOString(),
      resolved_at: null as any,
    };

    // Save trade to database
    try {
      logger.info(`Saving trade ${tradeId} to database...`);
      this.db.saveTrade(trade);
      logger.info(`Trade ${tradeId} saved to database`);
    } catch (dbError: any) {
      const errorMessage = dbError instanceof Error ? dbError.message : String(dbError);
      const errorStack = dbError instanceof Error ? dbError.stack : 'No stack';
      logger.error(`Failed to save trade to database: ${errorMessage}`);
      logger.error(`Database error stack: ${errorStack}`);
      logger.error(`Trade data that failed:`, JSON.stringify(trade, null, 2));
      return null;
    }

    // Check if client is in read-only mode
    const isReadOnly = this.client.isReadOnly();
    logger.info(`Client read-only mode: ${isReadOnly}`);

    if (isReadOnly) {
      logger.warn('Client is in read-only mode - simulating trade');
      trade.status = 'open';
      trade.up_order_id = 'simulated-up-' + tradeId;
      trade.down_order_id = 'simulated-down-' + tradeId;
      this.db.updateTrade(trade);
      logger.info(`Simulated trade ${tradeId} created successfully`);
      return trade;
    }

    try {
      // Place UP order
      logger.info(`Placing UP order: ${opportunity.upSize.toFixed(2)} shares at $${opportunity.upPrice.toFixed(3)}`);
      const upOrder = await this.client.placeBuyOrder(
        opportunity.upToken.token_id,
        opportunity.upPrice,
        opportunity.upSize
      );
      logger.info(`UP order placed:`, upOrder);
      trade.up_order_id = upOrder.orderID || upOrder.id;
      trade.status = 'partial';
      this.db.updateTrade(trade);

      // Place DOWN order
      logger.info(`Placing DOWN order: ${opportunity.downSize.toFixed(2)} shares at $${opportunity.downPrice.toFixed(3)}`);
      const downOrder = await this.client.placeBuyOrder(
        opportunity.downToken.token_id,
        opportunity.downPrice,
        opportunity.downSize
      );
      logger.info(`DOWN order placed:`, downOrder);
      trade.down_order_id = downOrder.orderID || downOrder.id;
      trade.status = 'open';
      this.db.updateTrade(trade);

      logger.info(`=== STRADDLE EXECUTED SUCCESSFULLY ===`);
      logger.info(`Trade ID: ${tradeId}`);
      logger.info(`UP Order ID: ${trade.up_order_id}`);
      logger.info(`DOWN Order ID: ${trade.down_order_id}`);
      return trade;

    } catch (error) {
      logger.error(`=== STRADDLE EXECUTION FAILED ===`);
      logger.error(`Trade ID: ${tradeId}`);
      if (error instanceof Error) {
        logger.error(`Error: ${error.message}`);
        logger.error(`Stack: ${error.stack}`);
      } else {
        logger.error(`Error:`, error);
      }
      
      trade.status = 'failed';
      this.db.updateTrade(trade);

      // Try to cancel any placed orders
      if (trade.up_order_id) {
        try {
          await this.client.cancelOrder(trade.up_order_id);
          logger.info(`Cancelled UP order: ${trade.up_order_id}`);
        } catch (cancelError) {
          logger.error('Failed to cancel UP order', cancelError);
        }
      }
      if (trade.down_order_id) {
        try {
          await this.client.cancelOrder(trade.down_order_id);
          logger.info(`Cancelled DOWN order: ${trade.down_order_id}`);
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
    
    logger.info(`executeStraddles called with ${opportunities.length} opportunities`);

    for (let i = 0; i < opportunities.length; i++) {
      const opportunity = opportunities[i];
      logger.info(`Processing opportunity ${i + 1}/${opportunities.length}: ${opportunity.market.question}`);
      
      // Check if we already have an open trade for this market
      const existingTrade = this.db.getTradeByMarketId(opportunity.market.condition_id);
      if (existingTrade && ['pending', 'open', 'partial'].includes(existingTrade.status)) {
        logger.info(`Skipping market ${opportunity.market.condition_id} - already have open trade (${existingTrade.id})`);
        continue;
      }

      try {
        logger.info(`No existing trade found, executing new straddle...`);
        const trade = await this.executeStraddle(opportunity);
        if (trade) {
          trades.push(trade);
          logger.info(`Trade created: ${trade.id} with status ${trade.status}`);
        } else {
          logger.warn(`executeStraddle returned null for ${opportunity.market.question}`);
        }
      } catch (error) {
        logger.error(`Error executing straddle for ${opportunity.market.question}:`, error);
      }

      // Add small delay between orders to avoid rate limiting
      await this.delay(500);
    }

    logger.info(`executeStraddles complete: ${trades.length} trades created`);
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

