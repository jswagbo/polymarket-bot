import { ethers } from 'ethers';
import { ClobClient, Side, ApiKeyCreds } from '@polymarket/clob-client';
import { createLogger } from '../utils/logger';

const logger = createLogger('PolymarketClient');

// Polymarket API endpoints
const CLOB_API_URL = 'https://clob.polymarket.com';
const GAMMA_API_URL = 'https://gamma-api.polymarket.com';

// Series IDs for recurring markets
export const SERIES_IDS = {
  BTC_HOURLY: '10114',      // BTC Up or Down Hourly
  XRP_HOURLY: '10123',      // XRP Up or Down Hourly
  TSLA_DAILY: '10375',      // TSLA Daily Up Down
  AMZN_DAILY: '10378',      // AMZN Daily Up Down
  RUSSELL_DAILY: '10388',   // Russell 2000 Daily Up or Down
  EUR_USD_DAILY: '10405',   // EUR/USD Daily Up or Down
  BRENT_DAILY: '10416',     // Brent Crude Oil Daily Up or Down
};

export interface PolymarketClientConfig {
  privateKey: string;
  chainId?: number;
}

export class PolymarketClient {
  private client: ClobClient | null = null;
  private wallet: ethers.Wallet | null = null;
  private apiCreds: ApiKeyCreds | null = null;
  private isInitialized = false;

  constructor(private config: PolymarketClientConfig) {}

  private initError: string | null = null;

  async initialize(): Promise<void> {
    if (this.isInitialized) return;

    try {
      // Check if private key is provided
      const hasKey = this.config.privateKey && 
                     this.config.privateKey.length > 0 && 
                     this.config.privateKey !== 'your_private_key_here';
      
      logger.info(`Private key status: ${hasKey ? 'PROVIDED (' + this.config.privateKey.length + ' chars)' : 'NOT PROVIDED'}`);
      
      if (!hasKey) {
        logger.warn('No private key configured - running in read-only mode');
        this.client = new ClobClient(CLOB_API_URL, 137);
        this.isInitialized = true;
        return;
      }

      // Create wallet from private key
      logger.info('Creating wallet from private key...');
      this.wallet = new ethers.Wallet(this.config.privateKey);
      logger.info(`Wallet address: ${this.wallet.address}`);

      // Initialize CLOB client with wallet for trading
      logger.info('Initializing CLOB client...');
      this.client = new ClobClient(
        CLOB_API_URL,
        137, // Polygon mainnet
        this.wallet
      );

      // Derive API credentials
      logger.info('Deriving API credentials...');
      const rawCreds = await this.client.deriveApiKey();
      this.apiCreds = rawCreds;
      logger.info('API credentials derived successfully');

      // Create new client with credentials
      this.client = new ClobClient(
        CLOB_API_URL,
        137,
        this.wallet,
        this.apiCreds
      );

      // Set up allowances for trading (approve USDC spending)
      logger.info('Setting up token allowances for CLOB trading...');
      try {
        // This updates the balance allowance for the CLOB exchange
        await this.client.updateBalanceAllowance();
        logger.info('Token allowances set successfully');
      } catch (allowanceError: any) {
        logger.warn(`Allowance setup warning: ${allowanceError.message || allowanceError}`);
        // Continue anyway - might already be approved
      }

      this.isInitialized = true;
      this.initError = null;
      logger.info('Polymarket client initialized successfully - TRADING MODE ENABLED');
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      this.initError = errorMsg;
      logger.error('Failed to initialize Polymarket client:', errorMsg);
      
      // Fall back to read-only mode on error
      logger.warn('Falling back to read-only mode due to initialization error');
      this.client = new ClobClient(CLOB_API_URL, 137);
      this.isInitialized = true;
    }
  }

  getInitError(): string | null {
    return this.initError;
  }

  getClient(): ClobClient {
    if (!this.client) {
      throw new Error('Client not initialized. Call initialize() first.');
    }
    return this.client;
  }

  getWalletAddress(): string | null {
    return this.wallet?.address || null;
  }

  isReadOnly(): boolean {
    return this.wallet === null;
  }

  async getMarkets(): Promise<any[]> {
    try {
      // Fetch markets with high limit to find all Bitcoin up/down markets
      const response = await fetch(`${GAMMA_API_URL}/markets?closed=false&limit=1000`);
      if (!response.ok) {
        throw new Error(`Failed to fetch markets: ${response.statusText}`);
      }
      const markets = await response.json() as any[];
      return markets;
    } catch (error) {
      logger.error('Failed to fetch markets', error);
      throw error;
    }
  }

  async getMarketByConditionId(conditionId: string): Promise<any> {
    try {
      const response = await fetch(`${GAMMA_API_URL}/markets/${conditionId}`);
      if (!response.ok) {
        throw new Error(`Failed to fetch market: ${response.statusText}`);
      }
      return await response.json();
    } catch (error) {
      logger.error(`Failed to fetch market ${conditionId}`, error);
      throw error;
    }
  }

  /**
   * Get a series by ID with all its events
   */
  async getSeries(seriesId: string): Promise<any> {
    try {
      logger.info(`Fetching series ${seriesId}...`);
      const response = await fetch(`${GAMMA_API_URL}/series/${seriesId}`);
      if (!response.ok) {
        throw new Error(`Failed to fetch series: ${response.statusText}`);
      }
      return await response.json();
    } catch (error) {
      logger.error(`Failed to fetch series ${seriesId}`, error);
      throw error;
    }
  }

  /**
   * Get event details by ID (includes markets with token IDs)
   */
  async getEvent(eventId: string): Promise<any> {
    try {
      const response = await fetch(`${GAMMA_API_URL}/events/${eventId}`);
      if (!response.ok) {
        throw new Error(`Failed to fetch event: ${response.statusText}`);
      }
      return await response.json();
    } catch (error) {
      logger.error(`Failed to fetch event ${eventId}`, error);
      throw error;
    }
  }

  /**
   * Get all active hourly BTC Up/Down events
   */
  async getHourlyBTCEvents(): Promise<any[]> {
    try {
      const series = await this.getSeries(SERIES_IDS.BTC_HOURLY);
      const events = series.events || [];
      
      // Filter for non-closed events that end in the future
      const now = new Date();
      const activeEvents = events.filter((e: any) => {
        if (e.closed) return false;
        const endDate = new Date(e.endDate);
        return endDate > now;
      });

      // Sort by end date (soonest first)
      activeEvents.sort((a: any, b: any) => {
        return new Date(a.endDate).getTime() - new Date(b.endDate).getTime();
      });

      logger.info(`Found ${activeEvents.length} active hourly BTC events`);
      return activeEvents;
    } catch (error) {
      logger.error('Failed to fetch hourly BTC events', error);
      throw error;
    }
  }

  /**
   * Get upcoming hourly events that are good for trading
   * (ending within the next N hours)
   */
  async getUpcomingHourlyEvents(hoursAhead: number = 24): Promise<any[]> {
    try {
      const events = await this.getHourlyBTCEvents();
      const now = new Date();
      const cutoff = new Date(now.getTime() + hoursAhead * 60 * 60 * 1000);

      return events.filter((e: any) => {
        const endDate = new Date(e.endDate);
        return endDate <= cutoff;
      });
    } catch (error) {
      logger.error('Failed to fetch upcoming events', error);
      throw error;
    }
  }

  async getOrderBook(tokenId: string): Promise<any> {
    try {
      if (!this.client) {
        throw new Error('Client not initialized');
      }
      return await this.client.getOrderBook(tokenId);
    } catch (error) {
      logger.error(`Failed to fetch order book for ${tokenId}`, error);
      throw error;
    }
  }

  async getPrice(tokenId: string): Promise<number> {
    try {
      if (!this.client) {
        throw new Error('Client not initialized');
      }
      const orderBook = await this.client.getOrderBook(tokenId);
      
      // Find best bid (highest bid price)
      let bestBid = 0;
      if (orderBook.bids && orderBook.bids.length > 0) {
        const bidPrices = orderBook.bids.map((b: any) => parseFloat(b.price));
        bestBid = Math.max(...bidPrices);
      }
      
      // Find best ask (lowest ask price)
      let bestAsk = 0;
      if (orderBook.asks && orderBook.asks.length > 0) {
        const askPrices = orderBook.asks.map((a: any) => parseFloat(a.price));
        bestAsk = Math.min(...askPrices);
      }
      
      // If we have both bid and ask, use mid price
      if (bestBid > 0 && bestAsk > 0) {
        const midPrice = (bestBid + bestAsk) / 2;
        logger.debug(`Token ${tokenId.slice(0, 10)}... bid=${bestBid} ask=${bestAsk} mid=${midPrice.toFixed(3)}`);
        return midPrice;
      }
      
      // If only ask, use ask (price to buy)
      if (bestAsk > 0) {
        return bestAsk;
      }
      
      // If only bid, use bid
      if (bestBid > 0) {
        return bestBid;
      }
      
      // No liquidity
      return 0;
    } catch (error) {
      logger.debug(`Failed to get price for ${tokenId}: ${error}`);
      return 0;
    }
  }

  /**
   * Get prices directly from CLOB API for a list of token IDs
   */
  async getPrices(tokenIds: string[]): Promise<Map<string, number>> {
    const prices = new Map<string, number>();
    
    try {
      // Fetch prices in parallel for speed
      const pricePromises = tokenIds.map(async (tokenId) => {
        const price = await this.getPrice(tokenId);
        return { tokenId, price };
      });
      
      const results = await Promise.all(pricePromises);
      results.forEach(({ tokenId, price }) => {
        prices.set(tokenId, price);
      });
    } catch (error) {
      logger.error('Failed to fetch prices', error);
    }
    
    return prices;
  }

  async placeBuyOrder(tokenId: string, price: number, size: number): Promise<any> {
    if (this.isReadOnly()) {
      throw new Error('Cannot place orders in read-only mode. Configure a valid private key.');
    }

    try {
      if (!this.client) {
        throw new Error('Client not initialized');
      }

      logger.info(`Placing buy order: token=${tokenId}, price=${price}, size=${size}`);

      const order = await this.client.createOrder({
        tokenID: tokenId,
        price: price,
        size: size,
        side: Side.BUY,
      });

      const response = await this.client.postOrder(order);
      
      // Check if response contains an error
      if (response && response.error) {
        const errorMsg = response.error || 'Unknown error';
        logger.error(`Order rejected by Polymarket: ${errorMsg}`, response);
        throw new Error(`Order rejected: ${errorMsg}`);
      }
      
      // Check if we got a valid order ID
      if (!response || (!response.orderID && !response.id)) {
        logger.error('Order response missing order ID', response);
        throw new Error('Order failed: No order ID returned');
      }
      
      logger.info(`Order placed successfully - ID: ${response.orderID || response.id}`);
      return response;
    } catch (error: any) {
      // Parse error message for better logging
      let errorMsg = 'Unknown error';
      if (error instanceof Error) {
        errorMsg = error.message;
      } else if (typeof error === 'string') {
        errorMsg = error;
      } else if (error?.message) {
        errorMsg = error.message;
      }
      
      // Check for common errors
      if (errorMsg.includes('balance') || errorMsg.includes('allowance')) {
        logger.error(`💰 INSUFFICIENT FUNDS: ${errorMsg}`);
        throw new Error('Insufficient USDC balance. Please deposit funds to your Polymarket wallet.');
      }
      
      logger.error(`Failed to place buy order: ${errorMsg}`);
      throw error;
    }
  }

  async cancelOrder(orderId: string): Promise<void> {
    if (this.isReadOnly()) {
      throw new Error('Cannot cancel orders in read-only mode');
    }

    try {
      if (!this.client) {
        throw new Error('Client not initialized');
      }
      await this.client.cancelOrder({ orderID: orderId });
      logger.info(`Order ${orderId} cancelled`);
    } catch (error) {
      logger.error(`Failed to cancel order ${orderId}`, error);
      throw error;
    }
  }

  async getOpenOrders(): Promise<any[]> {
    if (this.isReadOnly()) {
      return [];
    }

    try {
      if (!this.client) {
        throw new Error('Client not initialized');
      }
      const orders = await this.client.getOpenOrders();
      return orders;
    } catch (error) {
      logger.error('Failed to get open orders', error);
      return [];
    }
  }

  async getBalances(): Promise<{ usdc: number; positions: any[] }> {
    if (this.isReadOnly()) {
      return { usdc: 0, positions: [] };
    }

    // Note: Balance fetching requires additional integration with Polygon RPC
    // For now, return placeholder - in production this would query the blockchain
    return { usdc: 0, positions: [] };
  }
}

// Singleton instance
let clientInstance: PolymarketClient | null = null;

export function getPolymarketClient(config?: PolymarketClientConfig): PolymarketClient {
  if (!clientInstance && config) {
    clientInstance = new PolymarketClient(config);
  }
  if (!clientInstance) {
    throw new Error('Polymarket client not initialized. Provide config on first call.');
  }
  return clientInstance;
}

