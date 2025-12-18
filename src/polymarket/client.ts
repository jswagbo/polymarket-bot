import { ethers } from 'ethers';
import { ClobClient, Side, ApiKeyCreds } from '@polymarket/clob-client';
import { createLogger } from '../utils/logger';

const logger = createLogger('PolymarketClient');

// Polymarket CLOB API endpoints
const CLOB_API_URL = 'https://clob.polymarket.com';
const GAMMA_API_URL = 'https://gamma-api.polymarket.com';

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

  async initialize(): Promise<void> {
    if (this.isInitialized) return;

    try {
      // Check if private key is provided
      if (!this.config.privateKey || this.config.privateKey === 'your_private_key_here') {
        logger.warn('No private key configured - running in read-only mode');
        this.client = new ClobClient(CLOB_API_URL, 137);
        this.isInitialized = true;
        return;
      }

      // Create wallet from private key
      this.wallet = new ethers.Wallet(this.config.privateKey);
      logger.info(`Wallet address: ${this.wallet.address}`);

      // Initialize CLOB client with wallet for trading
      this.client = new ClobClient(
        CLOB_API_URL,
        137, // Polygon mainnet
        this.wallet
      );

      // Derive API credentials
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

      this.isInitialized = true;
      logger.info('Polymarket client initialized successfully');
    } catch (error) {
      logger.error('Failed to initialize Polymarket client', error);
      throw error;
    }
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
      const response = await fetch(`${GAMMA_API_URL}/markets?closed=false&limit=500`);
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
      
      // Get best ask price (what you'd pay to buy)
      if (orderBook.asks && orderBook.asks.length > 0) {
        return parseFloat(orderBook.asks[0].price);
      }
      
      // Fallback to mid price if no asks
      if (orderBook.bids && orderBook.bids.length > 0) {
        return parseFloat(orderBook.bids[0].price);
      }
      
      return 0;
    } catch (error) {
      logger.error(`Failed to get price for ${tokenId}`, error);
      return 0;
    }
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
      logger.info('Order placed successfully', response);
      return response;
    } catch (error) {
      logger.error('Failed to place buy order', error);
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

