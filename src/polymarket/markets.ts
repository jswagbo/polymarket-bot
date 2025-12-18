import { Market, Token, BITCOIN_MARKET_FILTER } from '../types';
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
      
      // Check if this is a Bitcoin market
      const isBitcoin = this.isBitcoinMarket(question, description);
      
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
   * Check if a market is related to Bitcoin based on keywords
   */
  private isBitcoinMarket(question: string, description: string): boolean {
    const text = `${question} ${description}`.toLowerCase();
    
    // Check for excluded keywords first
    for (const exclude of BITCOIN_MARKET_FILTER.excludeKeywords) {
      if (text.includes(exclude.toLowerCase())) {
        return false;
      }
    }
    
    // Check for Bitcoin keywords
    for (const keyword of BITCOIN_MARKET_FILTER.keywords) {
      if (text.includes(keyword.toLowerCase())) {
        return true;
      }
    }
    
    return false;
  }

  /**
   * Check if an outcome represents "yes" side (betting it will happen)
   */
  private isUpOutcome(outcome: string): boolean {
    const text = outcome.toLowerCase().trim();
    // Yes is the "up" side - betting the event happens
    return text === 'yes' || text.includes('yes');
  }

  /**
   * Check if an outcome represents "no" side (betting it won't happen)
   */
  private isDownOutcome(outcome: string): boolean {
    const text = outcome.toLowerCase().trim();
    // No is the "down" side - betting the event doesn't happen
    return text === 'no' || text.includes('no');
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

