import { Market, Token, BITCOIN_MARKET_FILTER, HourlyMarket } from '../types';
import { PolymarketClient } from './client';
import { createLogger } from '../utils/logger';

const logger = createLogger('MarketScanner');

export interface ParsedMarket {
  id: string;
  conditionId: string;
  question: string;
  slug: string;
  endDate: Date;
  upToken: TokenInfo | null;
  downToken: TokenInfo | null;
  isActive: boolean;
  isBitcoinMarket: boolean;
}

export interface TokenInfo {
  tokenId: string;
  outcome: string;
  price: number;
}

export class MarketScanner {
  constructor(private client: PolymarketClient) {}

  /**
   * Fetch active hourly BTC Up/Down markets from Gamma API
   * This is the main method for finding straddle opportunities
   */
  async scanHourlyBTCMarkets(): Promise<HourlyMarket[]> {
    try {
      logger.info('Scanning for hourly BTC Up/Down markets...');
      
      // Get upcoming events (within next 24 hours)
      const events = await this.client.getUpcomingHourlyEvents(24);
      logger.info(`Found ${events.length} upcoming hourly events`);

      const hourlyMarkets: HourlyMarket[] = [];

      for (const event of events) {
        try {
          // Get full event details with market data
          const eventDetails = await this.client.getEvent(event.id);
          const market = await this.parseHourlyEvent(eventDetails);
          
          if (market) {
            hourlyMarkets.push(market);
          }
        } catch (err) {
          logger.debug(`Failed to parse event ${event.id}: ${err}`);
        }
      }

      logger.info(`Parsed ${hourlyMarkets.length} tradeable hourly markets`);
      return hourlyMarkets;
    } catch (error) {
      logger.error('Failed to scan hourly BTC markets', error);
      throw error;
    }
  }

  /**
   * Parse a Gamma API event into our HourlyMarket format
   */
  private async parseHourlyEvent(event: any): Promise<HourlyMarket | null> {
    try {
      // Get the market from the event (usually just one market per event)
      const markets = event.markets || [];
      if (markets.length === 0) {
        return null;
      }

      const market = markets[0];
      
      // Parse outcomes and token IDs
      const outcomes: string[] = JSON.parse(market.outcomes || '[]');
      const tokenIds: string[] = JSON.parse(market.clobTokenIds || '[]');
      const prices: string[] = JSON.parse(market.outcomePrices || '[]');

      // Find Up and Down tokens
      let upTokenId: string | null = null;
      let downTokenId: string | null = null;
      let upPrice = 0;
      let downPrice = 0;

      for (let i = 0; i < outcomes.length; i++) {
        const outcome = outcomes[i].toLowerCase();
        if (outcome === 'up') {
          upTokenId = tokenIds[i];
          upPrice = parseFloat(prices[i]) || 0;
        } else if (outcome === 'down') {
          downTokenId = tokenIds[i];
          downPrice = parseFloat(prices[i]) || 0;
        }
      }

      if (!upTokenId || !downTokenId) {
        logger.debug(`Event ${event.id} missing up/down tokens`);
        return null;
      }

      // Fetch live prices from order book
      const liveUpPrice = await this.client.getPrice(upTokenId);
      const liveDownPrice = await this.client.getPrice(downTokenId);

      const endDate = new Date(event.endDate);
      const now = new Date();
      const hoursUntilClose = (endDate.getTime() - now.getTime()) / (1000 * 60 * 60);

      return {
        eventId: event.id,
        title: event.title,
        slug: event.slug,
        endDate,
        conditionId: market.conditionId,
        upToken: {
          tokenId: upTokenId,
          price: liveUpPrice || upPrice,
        },
        downToken: {
          tokenId: downTokenId,
          price: liveDownPrice || downPrice,
        },
        hoursUntilClose,
      };
    } catch (error) {
      logger.debug(`Failed to parse hourly event: ${error}`);
      return null;
    }
  }

  /**
   * Get a specific hourly market by event ID
   */
  async getHourlyMarket(eventId: string): Promise<HourlyMarket | null> {
    try {
      const event = await this.client.getEvent(eventId);
      return this.parseHourlyEvent(event);
    } catch (error) {
      logger.error(`Failed to get hourly market ${eventId}`, error);
      return null;
    }
  }

  /**
   * Fetch all active Bitcoin up/down markets
   */
  async scanBitcoinMarkets(): Promise<ParsedMarket[]> {
    try {
      logger.info('Scanning for Bitcoin markets...');
      const rawMarkets = await this.client.getMarkets();
      
      const bitcoinMarkets: ParsedMarket[] = [];

      for (const market of rawMarkets) {
        const parsed = await this.parseMarket(market);
        
        if (parsed && parsed.isBitcoinMarket && parsed.isActive) {
          // Fetch current prices for tokens
          if (parsed.upToken) {
            parsed.upToken.price = await this.client.getPrice(parsed.upToken.tokenId);
          }
          if (parsed.downToken) {
            parsed.downToken.price = await this.client.getPrice(parsed.downToken.tokenId);
          }
          
          bitcoinMarkets.push(parsed);
        }
      }

      logger.info(`Found ${bitcoinMarkets.length} active Bitcoin markets`);
      return bitcoinMarkets;
    } catch (error) {
      logger.error('Failed to scan markets', error);
      throw error;
    }
  }

  /**
   * Parse a raw market response into our typed structure
   */
  private async parseMarket(raw: any): Promise<ParsedMarket | null> {
    try {
      const question = raw.question || raw.title || '';
      const description = raw.description || '';
      const slug = raw.market_slug || raw.slug || '';
      
      // Check if this is a Bitcoin Up/Down market
      const isBitcoin = this.isBitcoinMarket(question, description, slug);
      
      // Check if market is active and not closed
      const endDate = new Date(raw.endDateIso || raw.end_date_iso || raw.endDate);
      const isActive = !raw.closed && endDate > new Date();

      // Parse tokens (outcomes)
      const tokens = raw.tokens || raw.outcomes || [];
      let upToken: TokenInfo | null = null;
      let downToken: TokenInfo | null = null;

      for (const token of tokens) {
        const outcome = (token.outcome || token.name || '').toLowerCase();
        const tokenId = token.token_id || token.tokenId || token.id;
        
        if (this.isUpOutcome(outcome)) {
          upToken = {
            tokenId,
            outcome: token.outcome || token.name,
            price: 0,
          };
        } else if (this.isDownOutcome(outcome)) {
          downToken = {
            tokenId,
            outcome: token.outcome || token.name,
            price: 0,
          };
        }
      }

      // Only return markets that have both up and down tokens
      if (!upToken || !downToken) {
        return null;
      }

      return {
        id: raw.id || raw.condition_id,
        conditionId: raw.condition_id || raw.conditionId || raw.id,
        question,
        slug: raw.market_slug || raw.slug || '',
        endDate,
        upToken,
        downToken,
        isActive,
        isBitcoinMarket: isBitcoin,
      };
    } catch (error) {
      logger.debug(`Failed to parse market: ${error}`);
      return null;
    }
  }

  /**
   * Check if a market is a Bitcoin Up/Down market
   */
  private isBitcoinMarket(question: string, description: string, slug?: string): boolean {
    const text = `${question} ${description} ${slug || ''}`.toLowerCase();
    
    // Check for excluded keywords first
    for (const exclude of BITCOIN_MARKET_FILTER.excludeKeywords) {
      if (text.includes(exclude.toLowerCase())) {
        return false;
      }
    }
    
    // Check for Bitcoin Up/Down keywords
    for (const keyword of BITCOIN_MARKET_FILTER.keywords) {
      if (text.includes(keyword.toLowerCase())) {
        return true;
      }
    }
    
    // Also check for the specific slug pattern used by Polymarket
    if (slug && slug.includes('btc-updown')) {
      return true;
    }
    
    return false;
  }

  /**
   * Check if an outcome represents "up" (price going up)
   */
  private isUpOutcome(outcome: string): boolean {
    const text = outcome.toLowerCase().trim();
    return text === 'up';
  }

  /**
   * Check if an outcome represents "down" (price going down)
   */
  private isDownOutcome(outcome: string): boolean {
    const text = outcome.toLowerCase().trim();
    return text === 'down';
  }

  /**
   * Get detailed info for a specific market
   */
  async getMarketDetails(conditionId: string): Promise<ParsedMarket | null> {
    try {
      const raw = await this.client.getMarketByConditionId(conditionId);
      return this.parseMarket(raw);
    } catch (error) {
      logger.error(`Failed to get market details for ${conditionId}`, error);
      return null;
    }
  }
}

