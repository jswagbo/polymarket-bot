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
  'function redeemPositions(address collateralToken, bytes32 parentCollectionId, bytes32 conditionId, uint256[] indexSets) external'
];

// NegRisk Adapter for redemption
const NEG_RISK_ADAPTER = '0xd91E80cF2E7be2e162c6513ceD06f1dD0dA35296';
const NEG_RISK_ABI = [
  'function redeemPositions(bytes32 conditionId, uint256[] amounts) external'
];

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
      
      // Get current gas price and add 20% buffer
      const gasPrice = await provider.getGasPrice();
      const boostedGasPrice = gasPrice.mul(120).div(100);
      logger.info(`Gas price: ${ethers.utils.formatUnits(gasPrice, 'gwei')} gwei (using ${ethers.utils.formatUnits(boostedGasPrice, 'gwei')} gwei)`);

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
          gasPrice: boostedGasPrice,
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
          gasPrice: boostedGasPrice,
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
      // Try data-api endpoint (public positions)
      const dataApiUrl = `https://data-api.polymarket.com/positions?user=${address.toLowerCase()}`;
      const response = await fetch(dataApiUrl);
      
      if (response.ok) {
        const positions = await response.json() as any[];
        logger.info(`Found ${positions.length} positions for ${address} from data-api`);
        return positions;
      }
      
      // Fallback to gamma-api
      const gammaResponse = await fetch(`${GAMMA_API_URL}/positions?user=${address.toLowerCase()}`);
      
      if (gammaResponse.ok) {
        const positions = await gammaResponse.json() as any[];
        logger.info(`Found ${positions.length} positions for ${address} from gamma-api`);
        return positions;
      }
      
      logger.warn(`Failed to fetch positions from APIs: data-api=${response.status}, gamma-api=${gammaResponse.status}`);
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
    
    // Filter for claimable positions using correct API fields
    const claimable = positions.filter((p: any) => {
      const hasBalance = parseFloat(p.size || '0') > 0;
      
      // Check if market has ended (endDate in the past)
      const endDate = p.endDate ? new Date(p.endDate) : null;
      const isEnded = endDate ? endDate < new Date() : false;
      
      // Check if winner: curPrice close to 1 means won, 0 means lost
      const curPrice = parseFloat(p.curPrice || '0');
      const isWinner = curPrice >= 0.95;  // Price of 0.95+ means it resolved as winner
      
      // Also check redeemable flag if it exists
      const isRedeemable = p.redeemable === true || p.redeemable === 'true';
      
      logger.info(`  → Position: endDate=${endDate?.toISOString()}, isEnded=${isEnded}, curPrice=${curPrice}, isWinner=${isWinner}, redeemable=${p.redeemable}`);
      
      // Claimable if: has balance AND (market ended with winning price OR explicitly marked redeemable)
      return hasBalance && (isEnded && isWinner) || isRedeemable;
    });

    logger.info(`Found ${claimable.length} claimable positions out of ${positions.length}`);
    return claimable;
  }

  /**
   * Redeem a winning position
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

    try {
      // Get current gas price with minimum floor for Polygon
      const gasPrice = await provider.getGasPrice();
      const minGasPrice = ethers.utils.parseUnits('50', 'gwei'); // Minimum 50 gwei for Polygon
      const boostedGasPrice = gasPrice.gt(minGasPrice) ? gasPrice.mul(150).div(100) : minGasPrice;
      logger.info(`Gas price: ${ethers.utils.formatUnits(gasPrice, 'gwei')} gwei, using ${ethers.utils.formatUnits(boostedGasPrice, 'gwei')} gwei (min 50)`);
      
      let tx;
      
      if (isNegRisk) {
        // Use Neg Risk Adapter for neg risk markets
        const adapter = new ethers.Contract(NEG_RISK_ADAPTER, NEG_RISK_ABI, connectedWallet);
        tx = await adapter.redeemPositions(conditionId, [1, 1], { 
          gasLimit: 300000,
          gasPrice: boostedGasPrice
        });
      } else {
        // Use CTF contract directly
        const ctf = new ethers.Contract(CTF_CONTRACT, CTF_ABI, connectedWallet);
        const parentCollectionId = ethers.constants.HashZero; // Root collection
        
        // IMPORTANT: Polymarket uses USDC.e as collateral, not native USDC
        // Index sets: 1 = outcome 0 (Up/Yes), 2 = outcome 1 (Down/No)
        logger.info(`Redeeming with USDC.e collateral: ${USDC_E_ADDRESS}`);
        
        tx = await ctf.redeemPositions(
          USDC_E_ADDRESS, // USDC.e - Polymarket's collateral token
          parentCollectionId,
          conditionId,
          [1, 2], // Both outcome indices
          { gasLimit: 300000, gasPrice: boostedGasPrice }
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

