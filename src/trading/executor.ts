import { v4 as uuidv4 } from 'uuid';
import { Trade, StraddleOpportunity, SingleLegOpportunity, TradeStatus } from '../types';
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
   * NEW: Execute a single-leg trade (buy expensive side only)
   */
  async executeSingleLeg(opportunity: SingleLegOpportunity): Promise<Trade | null> {
    const tradeId = uuidv4();
    
    logger.info(`=== EXECUTING SINGLE-LEG TRADE ===`);
    logger.info(`Trade ID: ${tradeId}`);
    logger.info(`Market: ${opportunity.market.question}`);
    logger.info(`Side: ${opportunity.side.toUpperCase()}`);
    logger.info(`Token: ${opportunity.token.token_id}`);
    logger.info(`Price: $${opportunity.price.toFixed(3)} (${(opportunity.price * 100).toFixed(1)}¢)`);
    logger.info(`Size: ${opportunity.size.toFixed(2)} shares`);
    logger.info(`Total Cost: $${(opportunity.price * opportunity.size).toFixed(2)}`);
    logger.info(`Expected Win Rate: ${(opportunity.expectedWinRate * 100).toFixed(0)}%`);
    logger.info(`Expected Value: +$${opportunity.expectedValue.toFixed(2)}`);

    // Create trade record
    const trade: Trade = {
      id: tradeId,
      trade_type: 'single_leg',
      side: opportunity.side,
      market_id: opportunity.market.condition_id,
      market_question: opportunity.market.question,
      up_token_id: opportunity.side === 'up' ? opportunity.token.token_id : '',
      down_token_id: opportunity.side === 'down' ? opportunity.token.token_id : '',
      up_price: opportunity.side === 'up' ? opportunity.price : 0,
      down_price: opportunity.side === 'down' ? opportunity.price : 0,
      up_size: opportunity.side === 'up' ? opportunity.size : 0,
      down_size: opportunity.side === 'down' ? opportunity.size : 0,
      combined_cost: opportunity.price * opportunity.size,
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
      logger.error(`Failed to save trade to database: ${errorMessage}`);
      return null;
    }

    // Check if client is in read-only mode
    const isReadOnly = this.client.isReadOnly();
    logger.info(`Client read-only mode: ${isReadOnly}`);

    if (isReadOnly) {
      logger.warn('Client is in read-only mode - simulating trade');
      trade.status = 'open';
      if (opportunity.side === 'up') {
        trade.up_order_id = 'simulated-' + tradeId;
      } else {
        trade.down_order_id = 'simulated-' + tradeId;
      }
      this.db.updateTrade(trade);
      logger.info(`Simulated single-leg trade ${tradeId} created successfully`);
      return trade;
    }

    try {
      // Place order for the expensive side
      logger.info(`Placing ${opportunity.side.toUpperCase()} order: ${opportunity.size.toFixed(2)} shares at $${opportunity.price.toFixed(3)}`);
      
      const order = await this.client.placeBuyOrder(
        opportunity.token.token_id,
        opportunity.price,
        opportunity.size
      );
      
      logger.info(`Order placed successfully:`, order);
      
      if (opportunity.side === 'up') {
        trade.up_order_id = order.orderID || order.id;
      } else {
        trade.down_order_id = order.orderID || order.id;
      }
      trade.status = 'open';
      this.db.updateTrade(trade);

      logger.info(`=== SINGLE-LEG TRADE EXECUTED SUCCESSFULLY ===`);
      logger.info(`Trade ID: ${tradeId}`);
      logger.info(`Order ID: ${order.orderID || order.id}`);
      return trade;

    } catch (error) {
      logger.error(`=== SINGLE-LEG TRADE FAILED ===`);
      logger.error(`Trade ID: ${tradeId}`);
      if (error instanceof Error) {
        logger.error(`Error: ${error.message}`);
        logger.error(`Stack: ${error.stack}`);
      } else {
        logger.error(`Error:`, error);
      }
      
      trade.status = 'failed';
      this.db.updateTrade(trade);
      return null;
    }
  }

  /**
   * Execute multiple single-leg trades
   */
  async executeSingleLegTrades(opportunities: SingleLegOpportunity[]): Promise<Trade[]> {
    const trades: Trade[] = [];
    
    logger.info(`executeSingleLegTrades called with ${opportunities.length} opportunities`);

    for (let i = 0; i < opportunities.length; i++) {
      const opportunity = opportunities[i];
      logger.info(`Processing opportunity ${i + 1}/${opportunities.length}: ${opportunity.market.question} (${opportunity.side.toUpperCase()})`);
      
      // Check if we already have an open trade for this market
      const existingTrade = this.db.getTradeByMarketId(opportunity.market.condition_id);
      if (existingTrade && ['pending', 'open', 'partial'].includes(existingTrade.status)) {
        logger.info(`Skipping market ${opportunity.market.condition_id} - already have open trade (${existingTrade.id})`);
        continue;
      }

      try {
        logger.info(`No existing trade found, executing new single-leg trade...`);
        const trade = await this.executeSingleLeg(opportunity);
        if (trade) {
          trades.push(trade);
          logger.info(`Trade created: ${trade.id} with status ${trade.status}`);
        } else {
          logger.warn(`executeSingleLeg returned null for ${opportunity.market.question}`);
        }
      } catch (error) {
        logger.error(`Error executing single-leg trade for ${opportunity.market.question}:`, error);
      }

      // Add small delay between orders to avoid rate limiting
      await this.delay(500);
    }

    logger.info(`executeSingleLegTrades complete: ${trades.length} trades created`);
    return trades;
  }

  // ============================================
  // LEGACY STRADDLE METHODS (kept for compatibility)
  // ============================================

  async executeStraddle(opportunity: StraddleOpportunity): Promise<Trade | null> {
    logger.warn('executeStraddle called but strategy has been updated to single-leg');
    return null;
  }

  async executeStraddles(opportunities: StraddleOpportunity[]): Promise<Trade[]> {
    logger.warn('executeStraddles called but strategy has been updated to single-leg');
    return [];
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

  private delay(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}
