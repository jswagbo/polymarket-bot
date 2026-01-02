import { ethers } from 'ethers';
import { ClobClient, Side, ApiKeyCreds, OrderType } from '@polymarket/clob-client';
import { createLogger } from '../utils/logger';

const logger = createLogger('PolymarketClient');

// Polymarket API endpoints
const CLOB_API_URL = 'https://clob.polymarket.com';
const GAMMA_API_URL = 'https://gamma-api.polymarket.com';

// Polygon RPC - try multiple endpoints with fallback
const POLYGON_RPCS = [
  'https://polygon-mainnet.public.blastapi.io',
  'https://polygon-bor-rpc.publicnode.com', 
  'https://1rpc.io/matic',
  'https://polygon.drpc.org',
];
const USDC_E_ADDRESS = '0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174'; // USDC.e (bridged) on Polygon
const USDC_NATIVE_ADDRESS = '0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359'; // Native USDC on Polygon
const CTF_EXCHANGE = '0x4bFb41d5B3570DeFd03C39a9A4D8dE6Bd8B8982E'; // Polymarket CTF Exchange
const NEG_RISK_CTF_EXCHANGE = '0xC5d563A36AE78145C45a50134d48A1215220f80a'; // Neg Risk Exchange

// ERC20 ABI for approve
const ERC20_ABI = [
  'function approve(address spender, uint256 amount) external returns (bool)',
  'function allowance(address owner, address spender) external view returns (uint256)',
  'function balanceOf(address account) external view returns (uint256)'
];

// CTF (Conditional Token Framework) contract for positions
const CTF_CONTRACT = '0x4D97DCd97eC945f40cF65F87097ACe5EA0476045'; // Polymarket CTF
const CTF_ABI = [
  'function balanceOf(address owner, uint256 id) external view returns (uint256)',
  'function balanceOfBatch(address[] owners, uint256[] ids) external view returns (uint256[])',
  'function redeemPositions(address collateralToken, bytes32 parentCollectionId, bytes32 conditionId, uint256[] indexSets) external',
  'function setApprovalForAll(address operator, bool approved) external',
  'function isApprovedForAll(address owner, address operator) external view returns (bool)'
];

// Polygon Gas Station API for optimal gas pricing
const POLYGON_GAS_STATION_URL = 'https://gasstation.polygon.technology/v2';

interface GasStationResponse {
  safeLow: { maxPriorityFee: number; maxFee: number };
  standard: { maxPriorityFee: number; maxFee: number };
  fast: { maxPriorityFee: number; maxFee: number };
  estimatedBaseFee: number;
  blockTime: number;
  blockNumber: number;
}

/**
 * Get optimal gas price from Polygon Gas Station API
 * Falls back to provider gas price if API fails
 */
async function getOptimalGasPrice(
  provider: ethers.providers.JsonRpcProvider,
  speed: 'safeLow' | 'standard' | 'fast' = 'standard'
): Promise<ethers.BigNumber> {
  try {
    const response = await fetch(POLYGON_GAS_STATION_URL);
    if (!response.ok) {
      throw new Error(`Gas Station API returned ${response.status}`);
    }
    
    const gasData = await response.json() as GasStationResponse;
    const gasPriceGwei = gasData[speed].maxFee;
    
    // Polygon Gas Station returns prices in gwei with decimals
    // Round up to ensure we have enough
    const gasPriceWei = ethers.utils.parseUnits(
      Math.ceil(gasPriceGwei).toString(),
      'gwei'
    );
    
    logger.debug(`⛽ Gas Station (${speed}): ${gasPriceGwei.toFixed(2)} gwei (base: ${gasData.estimatedBaseFee.toFixed(2)} gwei)`);
    
    return gasPriceWei;
  } catch (error: any) {
    logger.warn(`⛽ Gas Station API failed (${error.message}), falling back to provider`);
    
    // Fallback to provider gas price with small buffer
    const providerGasPrice = await provider.getGasPrice();
    const bufferedGasPrice = providerGasPrice.mul(110).div(100); // +10% buffer
    
    logger.debug(`⛽ Fallback gas price: ${ethers.utils.formatUnits(bufferedGasPrice, 'gwei')} gwei`);
    
    return bufferedGasPrice;
  }
}

// NegRisk Adapter for redemption
const NEG_RISK_ADAPTER = '0xd91E80cF2E7be2e162c6513ceD06f1dD0dA35296';
const NEG_RISK_ABI = [
  'function redeemPositions(bytes32 conditionId, uint256[] amounts) external'
];

// Series IDs for recurring markets (verified via Gamma API)
export const SERIES_IDS = {
  BTC_HOURLY: '10114',      // BTC Up or Down Hourly
  ETH_HOURLY: '10117',      // ETH Up or Down Hourly (slug: eth-up-or-down-hourly)
  TSLA_DAILY: '10375',      // TSLA Daily Up Down
  AMZN_DAILY: '10378',      // AMZN Daily Up Down
  RUSSELL_DAILY: '10388',   // Russell 2000 Daily Up or Down
  EUR_USD_DAILY: '10405',   // EUR/USD Daily Up or Down
  BRENT_DAILY: '10416',     // Brent Crude Oil Daily Up or Down
};

// Crypto types supported for hourly markets (BTC and ETH only)
export type CryptoType = 'BTC' | 'ETH';

// Map crypto types to series IDs
export const CRYPTO_SERIES_MAP: Record<CryptoType, string> = {
  BTC: SERIES_IDS.BTC_HOURLY,
  ETH: SERIES_IDS.ETH_HOURLY,
};

// Display names for each crypto
export const CRYPTO_DISPLAY_NAMES: Record<CryptoType, string> = {
  BTC: 'Bitcoin',
  ETH: 'Ethereum',
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

      // Skip auto-approval on startup - user can trigger manually via dashboard
      // This avoids startup delays and potential crashes
      logger.info('USDC approval can be triggered via dashboard when ready to trade');

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
      const url = `${GAMMA_API_URL}/series/${seriesId}`;
      
      const response = await fetch(url);
      
      if (!response.ok) {
        const errorText = await response.text().catch(() => 'No response body');
        logger.error(`Series ${seriesId} fetch failed: ${response.status} ${response.statusText} - ${errorText}`);
        throw new Error(`Failed to fetch series ${seriesId}: ${response.status} ${response.statusText}`);
      }
      
      const data: any = await response.json();
      logger.info(`Series ${seriesId} fetched successfully, events: ${data?.events?.length || 0}`);
      return data;
    } catch (error: any) {
      const errorMsg = error?.message || error?.toString() || JSON.stringify(error) || 'Unknown error';
      logger.error(`Failed to fetch series ${seriesId}: ${errorMsg}`);
      throw new Error(`Series fetch failed for ${seriesId}: ${errorMsg}`);
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
   * Get all active hourly events for a specific crypto
   */
  async getHourlyCryptoEvents(crypto: CryptoType): Promise<any[]> {
    try {
      const seriesId = CRYPTO_SERIES_MAP[crypto];
      if (!seriesId) {
        throw new Error(`Unknown crypto type: ${crypto}`);
      }
      
      logger.info(`Fetching ${crypto} events from series ${seriesId}...`);
      const series = await this.getSeries(seriesId);
      
      if (!series) {
        logger.warn(`No series data returned for ${crypto} (series ${seriesId})`);
        return [];
      }
      
      const events = series.events || [];
      logger.info(`Series ${seriesId} has ${events.length} total events`);
      
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

      logger.info(`Found ${activeEvents.length} active hourly ${crypto} events`);
      return activeEvents;
    } catch (error: any) {
      const errorMsg = error?.message || error?.toString() || JSON.stringify(error) || 'Unknown error';
      logger.error(`Failed to fetch hourly ${crypto} events: ${errorMsg}`);
      if (error?.stack) {
        logger.error(`Stack: ${error.stack}`);
      }
      throw new Error(`Failed to fetch ${crypto} events: ${errorMsg}`);
    }
  }

  /**
   * Get all active hourly BTC Up/Down events (backwards compatibility)
   */
  async getHourlyBTCEvents(): Promise<any[]> {
    return this.getHourlyCryptoEvents('BTC');
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

      // Get the best ask price from order book for market order
      const orderBook = await this.client.getOrderBook(tokenId);
      let marketPrice = price;
      
      if (orderBook.asks && orderBook.asks.length > 0) {
        // Find the best (lowest) ask price
        const askPrices = orderBook.asks.map((a: any) => parseFloat(a.price));
        const bestAsk = Math.min(...askPrices);
        
        // Use the best ask price + small buffer to ensure fill
        // Round to 2 decimal places (Polymarket tick size)
        marketPrice = Math.min(Math.ceil((bestAsk + 0.01) * 100) / 100, 0.99);
        
        logger.info(`📊 Order book: Best ask=${bestAsk.toFixed(3)}, using market price=${marketPrice.toFixed(3)}`);
      } else {
        logger.warn(`No asks in order book, using original price: ${price}`);
      }

      // Recalculate size based on new market price
      // CRITICAL: Polymarket requires price * size (makerAmount) to have ≤2 decimals!
      // Not just price and size individually, but their PRODUCT
      
      const priceInCents = Math.round(marketPrice * 100);  // Convert to cents (integer)
      const finalPrice = priceInCents / 100;  // Back to dollars (guaranteed 2 decimals)
      
      // Calculate how many WHOLE shares we can buy to ensure price * size has ≤2 decimals
      // By using whole shares, price * wholeShares will have same decimals as price (≤2)
      const targetSpend = price * size;  // How much we want to spend
      const wholeShares = Math.floor(targetSpend / finalPrice);  // Round DOWN to whole shares
      
      // Verify: finalPrice * wholeShares should have ≤2 decimals
      const totalCost = finalPrice * wholeShares;
      const totalCostStr = totalCost.toFixed(2);  // Force 2 decimals
      const verifiedCost = parseFloat(totalCostStr);

      logger.info(`Placing MARKET buy order: token=${tokenId.substring(0, 15)}...`);
      logger.info(`  Price: ${finalPrice}, Size: ${wholeShares} (whole shares)`);
      logger.info(`  Total cost: $${verifiedCost} (price × size = ${finalPrice} × ${wholeShares})`);

      if (wholeShares < 1) {
        throw new Error(`Order too small: would buy ${wholeShares} shares at $${finalPrice}`);
      }

      // Create order with whole share count
      const order = await this.client.createOrder({
        tokenID: tokenId,
        price: finalPrice,
        size: wholeShares,  // WHOLE SHARES ONLY
        side: Side.BUY,
      });

      // Post with FOK (Fill or Kill) order type for immediate execution
      const response = await this.client.postOrder(order, OrderType.FOK);
      
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
      
      logger.info(`✅ MARKET ORDER FILLED - ID: ${response.orderID || response.id}`);
      logger.info(`Order response:`, JSON.stringify(response));
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

  /**
   * Place a market sell order (FOK) to cash out a position
   * Now properly handles fractional shares to avoid leaving dust
   */
  async placeSellOrder(tokenId: string, size: number, sellAll: boolean = true): Promise<any> {
    if (this.isReadOnly()) {
      throw new Error('Cannot place orders in read-only mode. Configure a valid private key.');
    }

    try {
      if (!this.client) {
        throw new Error('Client not initialized');
      }

      // Get the best bid price from order book for market sell
      const orderBook = await this.client.getOrderBook(tokenId);
      let marketPrice = 0.01; // Minimum price if no bids
      
      if (orderBook.bids && orderBook.bids.length > 0) {
        // Find the best (highest) bid price
        const bidPrices = orderBook.bids.map((b: any) => parseFloat(b.price));
        const bestBid = Math.max(...bidPrices);
        
        // Use the best bid price - small buffer to ensure fill
        // Round to 2 decimal places
        marketPrice = Math.max(Math.floor((bestBid - 0.01) * 100) / 100, 0.01);
        
        logger.info(`📊 Order book: Best bid=${bestBid.toFixed(3)}, using sell price=${marketPrice.toFixed(3)}`);
      } else {
        logger.warn(`No bids in order book, using minimum price: ${marketPrice}`);
      }

      const priceInCents = Math.round(marketPrice * 100);
      const finalPrice = priceInCents / 100;
      
      // FIXED: Use exact size with 2 decimal precision to avoid leaving fractional shares
      // Round DOWN slightly to ensure we don't try to sell more than we have
      const exactSize = Math.floor(size * 100) / 100; // 2 decimal places
      
      // Polymarket minimum order is typically 1 share for most operations
      // But for selling existing positions, we should try to sell everything
      const MIN_SELL_SIZE = 0.01; // Minimum that CLOB might accept
      
      if (exactSize < MIN_SELL_SIZE) {
        logger.warn(`Position size ${size} is below minimum ${MIN_SELL_SIZE}, skipping (will be redeemed after market closes)`);
        throw new Error(`Size ${size} below minimum sell threshold - wait for market resolution to redeem`);
      }

      logger.info(`Placing MARKET sell order: token=${tokenId.substring(0, 15)}...`);
      logger.info(`  Price: ${finalPrice}, Size: ${exactSize} shares (original: ${size})`);

      // Create sell order with exact size
      const order = await this.client.createOrder({
        tokenID: tokenId,
        price: finalPrice,
        size: exactSize,
        side: Side.SELL,
      });

      // Post with FOK (Fill or Kill) order type for immediate execution
      const response = await this.client.postOrder(order, OrderType.FOK);
      
      if (response && response.error) {
        const errorMsg = response.error || 'Unknown error';
        logger.error(`Sell order rejected by Polymarket: ${errorMsg}`, response);
        throw new Error(`Sell order rejected: ${errorMsg}`);
      }
      
      if (!response || (!response.orderID && !response.id)) {
        logger.error('Sell order response missing order ID', response);
        throw new Error('Sell order failed: No order ID returned');
      }
      
      logger.info(`✅ MARKET SELL ORDER FILLED - ID: ${response.orderID || response.id}`);
      return response;
    } catch (error: any) {
      let errorMsg = error instanceof Error ? error.message : String(error);
      logger.error(`Failed to place sell order: ${errorMsg}`);
      throw error;
    }
  }

  /**
   * Cash out all open positions by market selling
   */
  async cashOutAllPositions(): Promise<{ success: number; failed: number; results: any[] }> {
    if (this.isReadOnly()) {
      throw new Error('Cannot cash out in read-only mode');
    }

    const results: any[] = [];
    let success = 0;
    let failed = 0;

    try {
      const positions = await this.getPositions();
      const openPositions = positions.filter(p => {
        const size = parseFloat(p.size || '0');
        return size > 0 && !p.resolved;
      });

      logger.info(`Found ${openPositions.length} open positions to cash out`);

      for (const position of openPositions) {
        const tokenId = position.asset || position.tokenId;
        const size = parseFloat(position.size || '0');

        if (!tokenId || size <= 0) {
          logger.warn(`Skipping invalid position:`, position);
          continue;
        }

        try {
          logger.info(`Cashing out position: ${position.title || tokenId.substring(0, 15)}... (${size} shares)`);
          const result = await this.placeSellOrder(tokenId, size);
          results.push({ tokenId, size, result, success: true });
          success++;
        } catch (error: any) {
          logger.error(`Failed to cash out ${tokenId}: ${error.message}`);
          results.push({ tokenId, size, error: error.message, success: false });
          failed++;
        }

        // Small delay between orders
        await new Promise(resolve => setTimeout(resolve, 500));
      }

      logger.info(`Cash out complete: ${success} succeeded, ${failed} failed`);
      return { success, failed, results };
    } catch (error) {
      logger.error('Cash out failed:', error);
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

  /**
   * Approve USDC spending for Polymarket exchanges
   * This is required before placing any orders
   * Checks BOTH USDC.e and native USDC
   */
  async approveUsdcSpending(): Promise<void> {
    if (!this.wallet) {
      throw new Error('No wallet configured');
    }

    logger.info('=== Starting USDC Approval Process ===');
    
    try {
      // Try multiple RPCs until one works
      let provider: ethers.providers.JsonRpcProvider | null = null;
      let workingRpc = '';
      
      for (const rpc of POLYGON_RPCS) {
        try {
          logger.info(`Trying RPC: ${rpc}...`);
          const testProvider = new ethers.providers.JsonRpcProvider(rpc);
          // Test the connection
          const network = await testProvider.getNetwork();
          logger.info(`✅ Connected to ${rpc} (chainId: ${network.chainId})`);
          provider = testProvider;
          workingRpc = rpc;
          break;
        } catch (rpcError: any) {
          logger.warn(`❌ RPC ${rpc} failed: ${rpcError.message}`);
        }
      }
      
      if (!provider) {
        throw new Error('All RPC endpoints failed. Please try again later.');
      }
      const connectedWallet = this.wallet.connect(provider);
      const address = await connectedWallet.getAddress();
      logger.info(`Wallet address: ${address}`);
      
      // Check POL balance for gas
      const polBalance = await provider.getBalance(address);
      logger.info(`POL Balance (for gas): ${ethers.utils.formatEther(polBalance)} POL`);
      
      if (polBalance.lt(ethers.utils.parseEther('0.001'))) {
        throw new Error('Insufficient POL for gas fees. Need at least 0.001 POL.');
      }
      
      // Check both USDC types
      logger.info('Checking USDC balances...');
      const usdcE = new ethers.Contract(USDC_E_ADDRESS, ERC20_ABI, connectedWallet);
      const usdcNative = new ethers.Contract(USDC_NATIVE_ADDRESS, ERC20_ABI, connectedWallet);
      
      const balanceE = await usdcE.balanceOf(address);
      const balanceNative = await usdcNative.balanceOf(address);
      logger.info(`USDC.e Balance: ${ethers.utils.formatUnits(balanceE, 6)} USDC`);
      logger.info(`Native USDC Balance: ${ethers.utils.formatUnits(balanceNative, 6)} USDC`);
      
      // Determine which USDC to use (whichever has balance)
      const useNative = balanceNative.gt(balanceE);
      const usdc = useNative ? usdcNative : usdcE;
      const usdcType = useNative ? 'Native USDC' : 'USDC.e';
      const balance = useNative ? balanceNative : balanceE;
      
      if (balance.isZero()) {
        throw new Error('No USDC balance found. Please deposit USDC first.');
      }
      
      logger.info(`Using ${usdcType} for trading (balance: ${ethers.utils.formatUnits(balance, 6)})`);
      
      // Max approval amount
      const maxApproval = ethers.constants.MaxUint256;
      
      // Check and approve CTF Exchange
      const ctfAllowance = await usdc.allowance(address, CTF_EXCHANGE);
      logger.info(`Current CTF Exchange allowance: ${ethers.utils.formatUnits(ctfAllowance, 6)}`);
      
      // Get optimal gas price from Polygon Gas Station API
      const optimalGasPrice = await getOptimalGasPrice(provider, 'standard');
      logger.info(`⛽ Using gas price: ${ethers.utils.formatUnits(optimalGasPrice, 'gwei')} gwei (via Gas Station API)`);

      const pendingTxs: { name: string; hash: string; promise: Promise<any> }[] = [];
      
      if (ctfAllowance.lt(ethers.utils.parseUnits('1000000', 6))) {
        logger.info(`Approving ${usdcType} for CTF Exchange...`);
        logger.info(`Spender address: ${CTF_EXCHANGE}`);
        logger.info(`USDC contract: ${useNative ? USDC_NATIVE_ADDRESS : USDC_E_ADDRESS}`);
        
        // Get nonce explicitly
        const nonce = await provider.getTransactionCount(address, 'pending');
        logger.info(`Current nonce: ${nonce}`);
        
        const tx1 = await usdc.approve(CTF_EXCHANGE, maxApproval, { 
          gasLimit: 100000,
          gasPrice: optimalGasPrice,
          nonce: nonce
        });
        logger.info(`✅ CTF Approval tx sent!`);
        logger.info(`   Hash: ${tx1.hash}`);
        logger.info(`   View: https://polygonscan.com/tx/${tx1.hash}`);
        pendingTxs.push({ name: 'CTF Exchange', hash: tx1.hash, promise: tx1.wait() });
      } else {
        logger.info('✅ CTF Exchange already approved');
      }

      // Check and approve Neg Risk CTF Exchange
      const negRiskAllowance = await usdc.allowance(address, NEG_RISK_CTF_EXCHANGE);
      logger.info(`Current Neg Risk Exchange allowance: ${ethers.utils.formatUnits(negRiskAllowance, 6)}`);
      
      if (negRiskAllowance.lt(ethers.utils.parseUnits('1000000', 6))) {
        logger.info(`Approving ${usdcType} for Neg Risk CTF Exchange...`);
        logger.info(`Spender address: ${NEG_RISK_CTF_EXCHANGE}`);
        
        // Get fresh nonce (might have incremented from first tx)
        const nonce2 = await provider.getTransactionCount(address, 'pending');
        logger.info(`Current nonce: ${nonce2}`);
        
        const tx2 = await usdc.approve(NEG_RISK_CTF_EXCHANGE, maxApproval, { 
          gasLimit: 100000,
          gasPrice: optimalGasPrice,
          nonce: nonce2
        });
        logger.info(`✅ Neg Risk Approval tx sent!`);
        logger.info(`   Hash: ${tx2.hash}`);
        logger.info(`   View: https://polygonscan.com/tx/${tx2.hash}`);
        pendingTxs.push({ name: 'Neg Risk Exchange', hash: tx2.hash, promise: tx2.wait() });
      } else {
        logger.info('✅ Neg Risk CTF Exchange already approved');
      }

      // If we have pending transactions, wait for them in parallel (but don't block forever)
      if (pendingTxs.length > 0) {
        logger.info(`Waiting for ${pendingTxs.length} approval transaction(s)...`);
        
        // Wait with a timeout of 60 seconds
        const timeout = new Promise((_, reject) => 
          setTimeout(() => reject(new Error('Timeout waiting for confirmations')), 60000)
        );
        
        try {
          const results = await Promise.race([
            Promise.all(pendingTxs.map(tx => tx.promise)),
            timeout
          ]);
          logger.info('All approvals confirmed!');
        } catch (waitError: any) {
          if (waitError.message === 'Timeout waiting for confirmations') {
            logger.warn('Transactions sent but confirmation timed out. Check Polygonscan for status.');
            logger.info('The approvals are likely processing - bot will retry trades shortly.');
          } else {
            throw waitError;
          }
        }
      }
      
      logger.info('=== USDC Approval Complete! Ready to trade. ===');
    } catch (error: any) {
      logger.error('=== USDC Approval Failed ===');
      logger.error(`Error: ${error.message || error}`);
      if (error.code) logger.error(`Error code: ${error.code}`);
      throw error;
    }
  }

  /**
   * Approve CTF (Conditional Tokens) for selling positions
   * This is required to sell/cash out positions
   */
  async approveCTFForSelling(): Promise<void> {
    if (!this.wallet) {
      throw new Error('No wallet configured');
    }

    logger.info('=== Starting CTF Approval for Selling ===');
    
    try {
      // Try multiple RPCs until one works
      let provider: ethers.providers.JsonRpcProvider | null = null;
      
      for (const rpc of POLYGON_RPCS) {
        try {
          logger.info(`Trying RPC: ${rpc}...`);
          const testProvider = new ethers.providers.JsonRpcProvider(rpc);
          await testProvider.getNetwork();
          provider = testProvider;
          break;
        } catch (rpcError: any) {
          logger.warn(`❌ RPC ${rpc} failed: ${rpcError.message}`);
        }
      }
      
      if (!provider) {
        throw new Error('All RPC endpoints failed. Please try again later.');
      }

      const connectedWallet = this.wallet.connect(provider);
      const address = await connectedWallet.getAddress();
      logger.info(`Wallet address: ${address}`);
      
      // Get optimal gas price from Polygon Gas Station API
      const optimalGasPrice = await getOptimalGasPrice(provider, 'standard');
      logger.info(`⛽ Using gas price: ${ethers.utils.formatUnits(optimalGasPrice, 'gwei')} gwei (via Gas Station API)`);
      
      // Create CTF contract instance
      const ctf = new ethers.Contract(CTF_CONTRACT, CTF_ABI, connectedWallet);
      
      // Check if already approved for CTF Exchange
      const isApprovedCTF = await ctf.isApprovedForAll(address, CTF_EXCHANGE);
      logger.info(`CTF Exchange approval status: ${isApprovedCTF}`);
      
      if (!isApprovedCTF) {
        logger.info('Approving CTF for CTF Exchange...');
        const tx1 = await ctf.setApprovalForAll(CTF_EXCHANGE, true, {
          gasLimit: 100000,
          gasPrice: optimalGasPrice
        });
        logger.info(`✅ CTF Exchange approval tx sent: ${tx1.hash}`);
        logger.info(`   View: https://polygonscan.com/tx/${tx1.hash}`);
        await tx1.wait();
        logger.info('✅ CTF Exchange approval confirmed!');
      } else {
        logger.info('✅ CTF Exchange already approved for selling');
      }
      
      // Check if already approved for Neg Risk Exchange
      const isApprovedNegRisk = await ctf.isApprovedForAll(address, NEG_RISK_CTF_EXCHANGE);
      logger.info(`Neg Risk Exchange approval status: ${isApprovedNegRisk}`);
      
      if (!isApprovedNegRisk) {
        logger.info('Approving CTF for Neg Risk Exchange...');
        const tx2 = await ctf.setApprovalForAll(NEG_RISK_CTF_EXCHANGE, true, {
          gasLimit: 100000,
          gasPrice: optimalGasPrice
        });
        logger.info(`✅ Neg Risk approval tx sent: ${tx2.hash}`);
        logger.info(`   View: https://polygonscan.com/tx/${tx2.hash}`);
        await tx2.wait();
        logger.info('✅ Neg Risk Exchange approval confirmed!');
      } else {
        logger.info('✅ Neg Risk Exchange already approved for selling');
      }
      
      logger.info('=== CTF Approval Complete! Ready to sell positions. ===');
    } catch (error: any) {
      logger.error('=== CTF Approval Failed ===');
      logger.error(`Error: ${error.message || error}`);
      throw error;
    }
  }

  /**
   * Check USDC balance and allowances (both USDC.e and native USDC)
   */
  async checkUsdcStatus(): Promise<{ 
    usdcE: { balance: string; ctfAllowance: string; negRiskAllowance: string };
    usdcNative: { balance: string; ctfAllowance: string; negRiskAllowance: string };
    total: string;
  }> {
    if (!this.wallet) {
      throw new Error('No wallet configured');
    }

    // Try RPCs until one works
    let provider: ethers.providers.JsonRpcProvider | null = null;
    for (const rpc of POLYGON_RPCS) {
      try {
        const testProvider = new ethers.providers.JsonRpcProvider(rpc);
        await testProvider.getNetwork();
        provider = testProvider;
        break;
      } catch {
        continue;
      }
    }
    if (!provider) throw new Error('All RPC endpoints failed');
    
    const connectedWallet = this.wallet.connect(provider);
    const address = await connectedWallet.getAddress();
    
    const usdcE = new ethers.Contract(USDC_E_ADDRESS, ERC20_ABI, connectedWallet);
    const usdcNative = new ethers.Contract(USDC_NATIVE_ADDRESS, ERC20_ABI, connectedWallet);

    // Check USDC.e
    const balanceE = await usdcE.balanceOf(address);
    const ctfAllowanceE = await usdcE.allowance(address, CTF_EXCHANGE);
    const negRiskAllowanceE = await usdcE.allowance(address, NEG_RISK_CTF_EXCHANGE);

    // Check native USDC
    const balanceNative = await usdcNative.balanceOf(address);
    const ctfAllowanceNative = await usdcNative.allowance(address, CTF_EXCHANGE);
    const negRiskAllowanceNative = await usdcNative.allowance(address, NEG_RISK_CTF_EXCHANGE);

    const totalBalance = balanceE.add(balanceNative);

    return {
      usdcE: {
        balance: ethers.utils.formatUnits(balanceE, 6),
        ctfAllowance: ethers.utils.formatUnits(ctfAllowanceE, 6),
        negRiskAllowance: ethers.utils.formatUnits(negRiskAllowanceE, 6),
      },
      usdcNative: {
        balance: ethers.utils.formatUnits(balanceNative, 6),
        ctfAllowance: ethers.utils.formatUnits(ctfAllowanceNative, 6),
        negRiskAllowance: ethers.utils.formatUnits(negRiskAllowanceNative, 6),
      },
      total: ethers.utils.formatUnits(totalBalance, 6),
    };
  }

  /**
   * Get user's positions from Polymarket API
   */
  async getPositions(): Promise<any[]> {
    if (!this.wallet) {
      throw new Error('No wallet configured');
    }

    const address = await this.wallet.getAddress();
    
    try {
      // Try the profile-positions endpoint first (most accurate)
      const profileUrl = `https://polymarket.com/api/profile/${address.toLowerCase()}/positions`;
      logger.info(`Fetching positions from profile API: ${profileUrl}`);
      
      try {
        const profileResponse = await fetch(profileUrl, {
          headers: {
            'Accept': 'application/json',
            'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36'
          }
        });
        
        if (profileResponse.ok) {
          const data: any = await profileResponse.json();
          const positions = Array.isArray(data) ? data : (data?.positions || data?.data || []);
          
          // Filter positions with actual balance
          const activePositions = positions.filter((p: any) => {
            const size = parseFloat(p.size || p.amount || p.shares || '0');
            return size > 0.001;
          });
          
          if (activePositions.length > 0) {
            logger.info(`Found ${activePositions.length} active positions from profile API`);
            return activePositions;
          }
        }
      } catch (e: any) {
        logger.debug(`Profile API failed: ${e.message}`);
      }

      // Try CLOB API endpoint for balances
      const clobBalancesUrl = `https://clob.polymarket.com/balances/${address.toLowerCase()}`;
      logger.info(`Fetching balances from CLOB API: ${clobBalancesUrl}`);
      
      try {
        const clobResponse = await fetch(clobBalancesUrl, {
          headers: { 'Accept': 'application/json' }
        });
        
        if (clobResponse.ok) {
          const balances: any = await clobResponse.json();
          logger.info(`CLOB balances response: ${JSON.stringify(balances)}`);
          
          // Convert balances to position format if we get any
          if (balances && typeof balances === 'object') {
            const positions = Object.entries(balances)
              .filter(([_, balance]) => parseFloat(balance as string) > 0.001)
              .map(([tokenId, balance]) => ({
                tokenId,
                size: balance,
                conditionId: tokenId // Will need to look up actual condition
              }));
            
            if (positions.length > 0) {
              logger.info(`Found ${positions.length} positions from CLOB balances`);
              return positions;
            }
          }
        }
      } catch (e: any) {
        logger.debug(`CLOB balances failed: ${e.message}`);
      }

      // Try data-api as last resort
      const dataApiUrl = `https://data-api.polymarket.com/positions?user=${address.toLowerCase()}`;
      logger.info(`Trying data API: ${dataApiUrl}`);
      
      const response = await fetch(dataApiUrl, {
        headers: { 'Accept': 'application/json' }
      });
      
      if (response.ok) {
        const data: any = await response.json();
        const allPositions = Array.isArray(data) ? data : (data?.positions || data?.data || []);
        
        // Filter out positions with 0 balance
        const activePositions = allPositions.filter((p: any) => {
          const size = parseFloat(p.size || p.amount || p.shares || '0');
          return size > 0.001;
        });
        
        logger.info(`Found ${allPositions.length} total, ${activePositions.length} active from data API`);
        return activePositions;
      }
      
      logger.warn(`No positions found from any API for ${address}`);
      return [];
    } catch (error: any) {
      logger.error(`Failed to fetch positions: ${error.message}`);
      return [];
    }
  }

  /**
   * Get resolved markets that have claimable winnings
   */
  async getClaimablePositions(): Promise<any[]> {
    const positions = await this.getPositions();
    
    logger.info(`=== Checking ${positions.length} positions for claimability ===`);
    
    // If no positions from API, try on-chain approach
    if (positions.length === 0) {
      logger.info('No positions from API, checking on-chain...');
      const onChainPositions = await this.getOnChainPositions();
      if (onChainPositions.length > 0) {
        logger.info(`Found ${onChainPositions.length} positions on-chain`);
        return onChainPositions;
      }
    }
    
    // Log FULL position data for first position to understand structure
    if (positions.length > 0) {
      logger.info(`FULL Position data sample: ${JSON.stringify(positions[0], null, 2)}`);
    }
    
    // Log each position for debugging
    positions.forEach((p: any, i: number) => {
      logger.info(`Position ${i + 1}:`);
      logger.info(`  Market: ${p.market?.question || p.title || p.marketTitle || 'Unknown'}`);
      logger.info(`  Size: ${p.size || p.amount || p.shares || p.position || 'N/A'}`);
      logger.info(`  Status fields: status=${p.status}, closed=${p.closed}, settled=${p.settled}, market.closed=${p.market?.closed}`);
      logger.info(`  Winner fields: curPrice=${p.curPrice}, currentPrice=${p.currentPrice}, outcome=${p.outcome}`);
      logger.info(`  All keys: ${Object.keys(p).join(', ')}`);
    });
    
    // Filter for claimable positions using multiple detection methods
    const claimable = positions.filter((p: any) => {
      // Check for balance in various field names
      const size = parseFloat(p.size || p.amount || p.shares || p.position || p.balance || '0');
      const hasBalance = size > 0;
      
      // Check if market has ended
      const endDate = p.endDate ? new Date(p.endDate) : null;
      const isEnded = endDate ? endDate < new Date() : (p.closed === true || p.settled === true);
      
      // Check if winner using multiple indicators
      const curPrice = parseFloat(p.curPrice || p.currentPrice || p.price || '0');
      const isWinner = curPrice >= 0.95 || p.outcome === 'won' || p.won === true;
      
      // Check redeemable flags
      const isRedeemable = p.redeemable === true || p.redeemable === 'true' || 
                           p.canRedeem === true || p.claimable === true;
      
      // Check for resolved status
      const isResolved = p.resolved === true || p.status === 'resolved' || p.status === 'closed';
      
      logger.info(`  → Position: size=${size}, isEnded=${isEnded}, curPrice=${curPrice}, isWinner=${isWinner}, redeemable=${isRedeemable}, resolved=${isResolved}`);
      
      // Claimable if: has balance AND ((market ended with winner) OR explicitly marked redeemable/resolved winner)
      return hasBalance && ((isEnded && isWinner) || isRedeemable || (isResolved && isWinner));
    });

    logger.info(`Found ${claimable.length} claimable positions out of ${positions.length}`);
    return claimable;
  }

  /**
   * Get positions by checking on-chain CTF balances
   */
  async getOnChainPositions(): Promise<any[]> {
    if (!this.wallet) return [];
    
    try {
      const address = await this.wallet.getAddress();
      logger.info(`Checking on-chain positions for ${address}...`);
      
      // Connect to provider
      let provider: ethers.providers.JsonRpcProvider | null = null;
      for (const rpc of POLYGON_RPCS) {
        try {
          const testProvider = new ethers.providers.JsonRpcProvider(rpc);
          await testProvider.getNetwork();
          provider = testProvider;
          break;
        } catch {
          continue;
        }
      }
      
      if (!provider) {
        logger.warn('Could not connect to Polygon for on-chain position check');
        return [];
      }

      // Query the CTF contract for balance
      const ctfAddress = '0x4D97DCd97eC945f40cF65F87097ACe5EA0476045';
      const ctf = new ethers.Contract(ctfAddress, CTF_ABI, provider);
      
      // We'd need to know the token IDs to check balances
      // For now, just log that we tried
      logger.info('On-chain position check requires known token IDs - check your positions on Polymarket website');
      
      return [];
    } catch (error: any) {
      logger.error(`On-chain position check failed: ${error.message}`);
      return [];
    }
  }

  /**
   * Get on-chain balance for a specific position (token ID)
   */
  async getPositionBalance(tokenId: string): Promise<string> {
    if (!this.wallet) return '0';
    
    try {
      let provider: ethers.providers.JsonRpcProvider | null = null;
      for (const rpc of POLYGON_RPCS) {
        try {
          const testProvider = new ethers.providers.JsonRpcProvider(rpc);
          await testProvider.getNetwork();
          provider = testProvider;
          break;
        } catch {
          continue;
        }
      }
      if (!provider) return '0';
      
      const address = await this.wallet.getAddress();
      const ctf = new ethers.Contract(CTF_CONTRACT, [
        'function balanceOf(address account, uint256 id) view returns (uint256)'
      ], provider);
      
      const balance = await ctf.balanceOf(address, tokenId);
      return ethers.utils.formatUnits(balance, 6); // USDC decimals
    } catch (e: any) {
      logger.debug(`Failed to get balance for token ${tokenId}: ${e.message}`);
      return '0';
    }
  }

  /**
   * Calculate token IDs from condition ID
   * Polymarket uses: tokenId = hash(collateral, conditionId, outcomeIndex)
   */
  getTokenIdsForCondition(conditionId: string): { upTokenId: string; downTokenId: string } {
    // For Polymarket, token IDs are derived from the condition
    // The exact calculation depends on the CTF implementation
    // These are typically provided by the API, but we can try to calculate
    const parentCollectionId = ethers.constants.HashZero;
    
    // Token ID for outcome 0 (Up/Yes) = positionId(collateral, parentCollection, conditionId, 1)
    // Token ID for outcome 1 (Down/No) = positionId(collateral, parentCollection, conditionId, 2)
    
    // For now, return placeholder - actual implementation needs market-specific token IDs
    return {
      upTokenId: '0', // Would need actual token IDs from market data
      downTokenId: '0'
    };
  }

  /**
   * Redeem a winning position
   * Uses dynamic gas pricing from Polygon Gas Station API
   */
  async redeemPosition(conditionId: string, isNegRisk: boolean = false): Promise<string> {
    if (!this.wallet) {
      throw new Error('No wallet configured');
    }

    logger.info(`=== Redeeming Position ===`);
    logger.info(`Condition ID: ${conditionId}`);
    logger.info(`Is Neg Risk market: ${isNegRisk}`);

    // Connect to provider
    let provider: ethers.providers.JsonRpcProvider | null = null;
    for (const rpc of POLYGON_RPCS) {
      try {
        const testProvider = new ethers.providers.JsonRpcProvider(rpc);
        await testProvider.getNetwork();
        provider = testProvider;
        break;
      } catch {
        continue;
      }
    }
    if (!provider) throw new Error('All RPC endpoints failed');

    const connectedWallet = this.wallet.connect(provider);
    const address = await this.wallet.getAddress();

    try {
      // Get optimal gas price from Polygon Gas Station API
      const optimalGasPrice = await getOptimalGasPrice(provider, 'standard');
      logger.info(`⛽ Gas price: ${ethers.utils.formatUnits(optimalGasPrice, 'gwei')} gwei (via Gas Station API)`);
      
      let tx;
      
      if (isNegRisk) {
        // Use Neg Risk Adapter for neg risk markets
        const adapter = new ethers.Contract(NEG_RISK_ADAPTER, NEG_RISK_ABI, connectedWallet);
        tx = await adapter.redeemPositions(conditionId, [1, 1], { 
          gasLimit: 300000,
          gasPrice: optimalGasPrice
        });
      } else {
        // Use CTF contract directly
        const ctf = new ethers.Contract(CTF_CONTRACT, CTF_ABI, connectedWallet);
        const parentCollectionId = ethers.constants.HashZero;
        
        logger.info(`Redeeming with USDC.e collateral: ${USDC_E_ADDRESS}`);
        logger.info(`User address: ${address}`);
        
        tx = await ctf.redeemPositions(
          USDC_E_ADDRESS,
          parentCollectionId,
          conditionId,
          [1, 2], // Both outcome indices - will redeem whatever balance exists
          { gasLimit: 400000, gasPrice: optimalGasPrice }
        );
      }

      logger.info(`Redeem tx sent: ${tx.hash}`);
      logger.info(`View: https://polygonscan.com/tx/${tx.hash}`);
      
      const receipt = await tx.wait();
      logger.info(`✅ Redemption confirmed! Block: ${receipt.blockNumber}`);
      
      return tx.hash;
    } catch (error: any) {
      logger.error(`Redemption failed: ${error.message}`);
      throw error;
    }
  }

  /**
   * Claim all available winnings
   */
  async claimAllWinnings(): Promise<{ success: number; failed: number; txHashes: string[] }> {
    const claimable = await this.getClaimablePositions();
    
    if (claimable.length === 0) {
      logger.info('No claimable positions found');
      return { success: 0, failed: 0, txHashes: [] };
    }

    logger.info(`Attempting to claim ${claimable.length} positions...`);
    
    const results = { success: 0, failed: 0, txHashes: [] as string[] };
    
    for (const position of claimable) {
      try {
        const conditionId = position.conditionId;
        const isNegRisk = position.negativeRisk || position.negRisk || false;
        
        logger.info(`Claiming position: conditionId=${conditionId}, negRisk=${isNegRisk}`);
        logger.info(`  Market: ${position.title}, Outcome: ${position.outcome}, Size: ${position.size}`);
        
        const txHash = await this.redeemPosition(conditionId, isNegRisk);
        results.success++;
        results.txHashes.push(txHash);
        
        // Wait a bit between redemptions
        await new Promise(resolve => setTimeout(resolve, 2000));
      } catch (error: any) {
        logger.error(`Failed to claim position: ${error.message}`);
        results.failed++;
      }
    }

    logger.info(`Claim complete: ${results.success} succeeded, ${results.failed} failed`);
    return results;
  }

  /**
   * Get all resolved markets from hourly crypto series
   * Uses the series endpoint approach (same as live market scanning)
   * Includes BTC, ETH, and SOL markets
   */
  async getResolvedHourlyMarkets(daysBack: number = 7): Promise<any[]> {
    // Series IDs for crypto markets (verified working)
    const CLAIM_SERIES_IDS: Record<string, string> = {
      'BTC': '10114',  // BTC Up or Down Hourly
      'ETH': '10117',  // ETH Up or Down Hourly
      'SOL': '10122',  // SOL Up or Down Hourly
      'XRP': '10123',  // XRP Up or Down Hourly
    };
    
    const allMarkets: any[] = [];
    const cutoffDate = new Date();
    cutoffDate.setDate(cutoffDate.getDate() - daysBack);
    const now = new Date();
    
    logger.info(`=== Scanning resolved hourly markets (last ${daysBack} days) ===`);
    logger.info(`Cutoff date: ${cutoffDate.toISOString()}`);
    
    for (const [crypto, seriesId] of Object.entries(CLAIM_SERIES_IDS)) {
      try {
        // Use series endpoint (same approach as live market scanning)
        const url = `${GAMMA_API_URL}/series/${seriesId}`;
        logger.info(`Fetching ${crypto} series from: ${url}`);
        
        const response = await fetch(url);
        if (!response.ok) {
          logger.warn(`Failed to fetch ${crypto} series: HTTP ${response.status}`);
          continue;
        }
        
        const series = await response.json() as any;
        const events = series.events || [];
        logger.info(`${crypto} series has ${events.length} total events`);
        
        let countRecent = 0;
        
        for (const event of events) {
          // Skip events that don't match this crypto
          const title = (event.title || '').toLowerCase();
          const cryptoLower = crypto.toLowerCase();
          const cryptoNameMap: Record<string, string> = {
            'BTC': 'bitcoin',
            'ETH': 'ethereum', 
            'SOL': 'solana',
            'XRP': 'xrp',
          };
          const cryptoName = cryptoNameMap[crypto] || cryptoLower;
          
          if (!title.includes(cryptoLower) && !title.includes(cryptoName)) {
            continue;
          }
          
          // Check if event is closed/resolved
          const endDate = new Date(event.endDate);
          const isClosed = event.closed === true || endDate < now;
          if (!isClosed) continue;
          
          // Check if within date range
          if (endDate < cutoffDate) continue;
          
          // Get market details - events from series endpoint don't have embedded markets
          // Need to fetch individual event details
          try {
            const eventDetails = await this.getEvent(event.id);
            if (!eventDetails || !eventDetails.markets || eventDetails.markets.length === 0) {
              continue;
            }
            
            const market = eventDetails.markets[0];
            if (!market.conditionId) continue;
            
            allMarkets.push({
              title: event.title || market.question,
              conditionId: market.conditionId,
              closedTime: endDate.toISOString(),
              negRisk: market.negRisk || event.enableNegRisk || false,
              crypto,
            });
            countRecent++;
            
            // Small delay to avoid rate limiting
            await new Promise(r => setTimeout(r, 50));
          } catch (fetchErr: any) {
            logger.debug(`Failed to fetch event ${event.id}: ${fetchErr.message}`);
          }
        }
        
        logger.info(`${crypto}: Found ${countRecent} resolved markets within last ${daysBack} days`);
      } catch (e: any) {
        logger.error(`Failed to fetch ${crypto} series: ${e.message}`);
      }
    }
    
    logger.info(`=== Total: ${allMarkets.length} resolved hourly crypto markets ===`);
    return allMarkets;
  }

  /**
   * Attempt to claim all resolved hourly crypto positions (brute force)
   * This tries to redeem every resolved market - if you don't have a position, it will fail gracefully
   * @param daysBack - Number of days to look back for resolved markets
   * @param enabledCryptos - Optional array of cryptos to claim (e.g., ['BTC', 'ETH']). If not provided, claims all.
   */
  async claimAllResolvedHourly(daysBack: number = 7, enabledCryptos?: string[]): Promise<{ attempted: number; success: number; failed: number; skipped: number }> {
    const cryptoFilter = enabledCryptos?.length ? enabledCryptos.join(', ') : 'ALL';
    logger.info(`=== CLAIMING RESOLVED HOURLY MARKETS (last ${daysBack} days, cryptos: ${cryptoFilter}) ===`);
    
    let resolvedMarkets = await this.getResolvedHourlyMarkets(daysBack);
    
    // Filter by enabled cryptos if specified
    if (enabledCryptos && enabledCryptos.length > 0) {
      const enabledSet = new Set(enabledCryptos.map(c => c.toUpperCase()));
      resolvedMarkets = resolvedMarkets.filter(m => enabledSet.has(m.crypto?.toUpperCase()));
      logger.info(`Filtered to ${resolvedMarkets.length} markets for enabled cryptos: ${enabledCryptos.join(', ')}`);
    }
    
    if (resolvedMarkets.length === 0) {
      logger.info('No resolved markets found');
      return { attempted: 0, success: 0, failed: 0, skipped: 0 };
    }

    logger.info(`Found ${resolvedMarkets.length} resolved markets to attempt...`);
    
    const results = { attempted: 0, success: 0, failed: 0, skipped: 0 };
    
    for (const market of resolvedMarkets) {
      results.attempted++;
      
      try {
        logger.info(`[${results.attempted}/${resolvedMarkets.length}] Attempting: ${market.title}`);
        logger.info(`  Condition ID: ${market.conditionId}`);
        
        const txHash = await this.redeemPosition(market.conditionId, market.negRisk);
        results.success++;
        logger.info(`  ✅ SUCCESS! TX: ${txHash}`);
        
        // Wait between successful redemptions
        await new Promise(resolve => setTimeout(resolve, 3000));
      } catch (error: any) {
        const errorMsg = error.message || String(error);
        
        // Check if this is a "no position" error (expected for markets where user didn't trade)
        if (errorMsg.includes('execution reverted') || 
            errorMsg.includes('insufficient') || 
            errorMsg.includes('nothing to redeem') ||
            errorMsg.includes('already redeemed')) {
          results.skipped++;
          logger.info(`  ⏭️ Skipped (no position or already claimed)`);
        } else {
          results.failed++;
          logger.warn(`  ❌ Failed: ${errorMsg}`);
        }
        
        // Small delay even on failures
        await new Promise(resolve => setTimeout(resolve, 500));
      }
    }

    logger.info(`=== CLAIM ALL COMPLETE ===`);
    logger.info(`Attempted: ${results.attempted}`);
    logger.info(`Success: ${results.success}`);
    logger.info(`Skipped (no position): ${results.skipped}`);
    logger.info(`Failed: ${results.failed}`);
    
    return results;
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

