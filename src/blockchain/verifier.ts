import { ethers } from 'ethers';
import { POLYGON_CONTRACTS } from '../config';
import { createLogger } from '../utils/logger';

const logger = createLogger('BlockchainVerifier');

// CTF Exchange ABI - only the events we need
const CTF_EXCHANGE_ABI = [
  // OrderFilled event - emitted when an order is filled
  'event OrderFilled(bytes32 indexed orderHash, address indexed maker, address indexed taker, uint256 makerAssetId, uint256 takerAssetId, uint256 makerAmountFilled, uint256 takerAmountFilled, uint256 fee)',
  // OrdersMatched event - emitted when two orders are matched
  'event OrdersMatched(bytes32 indexed takerOrderHash, address indexed takerOrderMaker, uint256 makerAssetId, uint256 takerAssetId, uint256 makerAmountFilled, uint256 takerAmountFilled)',
];

// CTF (Conditional Tokens Framework) ABI - for position events
const CTF_ABI = [
  // PositionSplit - when new tokens are minted
  'event PositionSplit(address indexed stakeholder, bytes32 indexed collateralToken, bytes32 indexed parentCollectionId, bytes32 conditionId, uint256[] partition, uint256 amount)',
  // PositionsMerge - when tokens are burned
  'event PositionsMerge(address indexed stakeholder, bytes32 indexed collateralToken, bytes32 indexed parentCollectionId, bytes32 conditionId, uint256[] partition, uint256 amount)',
  // PayoutRedemption - when winnings are claimed after resolution
  'event PayoutRedemption(address indexed redeemer, bytes32 indexed collateralToken, bytes32 indexed parentCollectionId, bytes32 conditionId, uint256[] indexSets, uint256 payout)',
  // ConditionResolution - when a market resolves
  'event ConditionResolution(bytes32 indexed conditionId, address indexed oracle, bytes32 indexed questionId, uint256 outcomeSlotCount, uint256[] payoutNumerators)',
];

export interface OrderFilledEvent {
  orderHash: string;
  maker: string;
  taker: string;
  makerAssetId: string;
  takerAssetId: string;
  makerAmountFilled: ethers.BigNumber;
  takerAmountFilled: ethers.BigNumber;
  fee: ethers.BigNumber;
  blockNumber: number;
  transactionHash: string;
  timestamp?: number;
}

export interface TradeVerification {
  verified: boolean;
  transactionHash: string;
  blockNumber: number;
  timestamp: number;
  fillPrice: number;        // Actual fill price from on-chain
  fillAmount: number;       // Actual amount filled
  fees: number;             // Fees paid
  events: OrderFilledEvent[];
}

export interface MarketResolution {
  conditionId: string;
  resolved: boolean;
  winningOutcome: 'YES' | 'NO' | null;
  payoutNumerators: number[];
  blockNumber: number;
  timestamp: number;
}

export class BlockchainVerifier {
  private provider: ethers.providers.JsonRpcProvider;
  private ctfExchange: ethers.Contract;
  private ctf: ethers.Contract;
  private isConnected: boolean = false;

  constructor(rpcUrl: string) {
    this.provider = new ethers.providers.JsonRpcProvider(rpcUrl);
    
    // Initialize contracts (read-only)
    this.ctfExchange = new ethers.Contract(
      POLYGON_CONTRACTS.CTF_EXCHANGE,
      CTF_EXCHANGE_ABI,
      this.provider
    );
    
    this.ctf = new ethers.Contract(
      POLYGON_CONTRACTS.CTF,
      CTF_ABI,
      this.provider
    );
  }

  async connect(): Promise<boolean> {
    try {
      const network = await this.provider.getNetwork();
      logger.info(`Connected to ${network.name} (chainId: ${network.chainId})`);
      
      if (network.chainId !== 137) {
        logger.warn('Warning: Not connected to Polygon mainnet (chainId 137)');
      }
      
      this.isConnected = true;
      return true;
    } catch (error) {
      logger.error('Failed to connect to Polygon RPC', error);
      this.isConnected = false;
      return false;
    }
  }

  /**
   * Verify a trade by its transaction hash
   * Returns detailed information about the trade from on-chain data
   */
  async verifyTrade(txHash: string): Promise<TradeVerification | null> {
    if (!this.isConnected) {
      await this.connect();
    }

    try {
      logger.info(`Verifying trade: ${txHash}`);
      
      // Get transaction receipt
      const receipt = await this.provider.getTransactionReceipt(txHash);
      if (!receipt) {
        logger.warn(`Transaction not found: ${txHash}`);
        return null;
      }

      // Get block for timestamp
      const block = await this.provider.getBlock(receipt.blockNumber);
      
      // Parse OrderFilled events from the receipt
      const events: OrderFilledEvent[] = [];
      
      for (const log of receipt.logs) {
        // Check if this log is from CTF Exchange
        if (log.address.toLowerCase() === POLYGON_CONTRACTS.CTF_EXCHANGE.toLowerCase()) {
          try {
            const parsed = this.ctfExchange.interface.parseLog(log);
            if (parsed.name === 'OrderFilled') {
              events.push({
                orderHash: parsed.args.orderHash,
                maker: parsed.args.maker,
                taker: parsed.args.taker,
                makerAssetId: parsed.args.makerAssetId.toString(),
                takerAssetId: parsed.args.takerAssetId.toString(),
                makerAmountFilled: parsed.args.makerAmountFilled,
                takerAmountFilled: parsed.args.takerAmountFilled,
                fee: parsed.args.fee,
                blockNumber: receipt.blockNumber,
                transactionHash: txHash,
                timestamp: block.timestamp,
              });
            }
          } catch (e) {
            // Not an OrderFilled event, skip
          }
        }
      }

      if (events.length === 0) {
        logger.warn(`No OrderFilled events found in transaction: ${txHash}`);
        return {
          verified: false,
          transactionHash: txHash,
          blockNumber: receipt.blockNumber,
          timestamp: block.timestamp,
          fillPrice: 0,
          fillAmount: 0,
          fees: 0,
          events: [],
        };
      }

      // Calculate fill price from events
      // For a buy order: fillPrice = takerAmountFilled / makerAmountFilled
      // makerAmountFilled = USDC spent, takerAmountFilled = tokens received
      const totalMakerAmount = events.reduce(
        (sum, e) => sum.add(e.makerAmountFilled),
        ethers.BigNumber.from(0)
      );
      const totalTakerAmount = events.reduce(
        (sum, e) => sum.add(e.takerAmountFilled),
        ethers.BigNumber.from(0)
      );
      const totalFees = events.reduce(
        (sum, e) => sum.add(e.fee),
        ethers.BigNumber.from(0)
      );

      // USDC has 6 decimals, tokens have 6 decimals on Polymarket
      const fillAmount = parseFloat(ethers.utils.formatUnits(totalTakerAmount, 6));
      const usdcSpent = parseFloat(ethers.utils.formatUnits(totalMakerAmount, 6));
      const fees = parseFloat(ethers.utils.formatUnits(totalFees, 6));
      
      // Fill price = USDC spent / tokens received
      const fillPrice = fillAmount > 0 ? usdcSpent / fillAmount : 0;

      logger.info(`Trade verified: ${txHash}`);
      logger.info(`  Fill price: $${fillPrice.toFixed(4)}`);
      logger.info(`  Fill amount: ${fillAmount.toFixed(2)} tokens`);
      logger.info(`  Fees: $${fees.toFixed(4)}`);

      return {
        verified: true,
        transactionHash: txHash,
        blockNumber: receipt.blockNumber,
        timestamp: block.timestamp,
        fillPrice,
        fillAmount,
        fees,
        events,
      };
    } catch (error) {
      logger.error(`Error verifying trade ${txHash}:`, error);
      return null;
    }
  }

  /**
   * Get recent OrderFilled events for a specific token ID
   * Useful for tracking market activity
   */
  async getRecentTrades(
    tokenId: string,
    fromBlock: number = -10000 // Last ~10000 blocks (~5 hours on Polygon)
  ): Promise<OrderFilledEvent[]> {
    if (!this.isConnected) {
      await this.connect();
    }

    try {
      const currentBlock = await this.provider.getBlockNumber();
      const startBlock = fromBlock < 0 ? currentBlock + fromBlock : fromBlock;

      logger.info(`Fetching trades for token ${tokenId} from block ${startBlock}`);

      // Query OrderFilled events
      const filter = this.ctfExchange.filters.OrderFilled();
      const logs = await this.ctfExchange.queryFilter(filter, startBlock, currentBlock);

      // Filter for our token ID
      const events: OrderFilledEvent[] = [];
      for (const log of logs) {
        const args = log.args;
        if (!args) continue;

        if (
          args.makerAssetId.toString() === tokenId ||
          args.takerAssetId.toString() === tokenId
        ) {
          const block = await this.provider.getBlock(log.blockNumber);
          events.push({
            orderHash: args.orderHash,
            maker: args.maker,
            taker: args.taker,
            makerAssetId: args.makerAssetId.toString(),
            takerAssetId: args.takerAssetId.toString(),
            makerAmountFilled: args.makerAmountFilled,
            takerAmountFilled: args.takerAmountFilled,
            fee: args.fee,
            blockNumber: log.blockNumber,
            transactionHash: log.transactionHash,
            timestamp: block.timestamp,
          });
        }
      }

      logger.info(`Found ${events.length} trades for token ${tokenId}`);
      return events;
    } catch (error) {
      logger.error(`Error fetching recent trades:`, error);
      return [];
    }
  }

  /**
   * Check if a market condition has been resolved
   */
  async checkMarketResolution(conditionId: string): Promise<MarketResolution | null> {
    if (!this.isConnected) {
      await this.connect();
    }

    try {
      logger.info(`Checking resolution for condition: ${conditionId}`);

      // Query ConditionResolution events
      const filter = this.ctf.filters.ConditionResolution(conditionId);
      const logs = await this.ctf.queryFilter(filter);

      if (logs.length === 0) {
        return {
          conditionId,
          resolved: false,
          winningOutcome: null,
          payoutNumerators: [],
          blockNumber: 0,
          timestamp: 0,
        };
      }

      // Get the most recent resolution event
      const latestLog = logs[logs.length - 1];
      const args = latestLog.args;
      if (!args) return null;

      const block = await this.provider.getBlock(latestLog.blockNumber);
      const payoutNumerators = args.payoutNumerators.map((n: ethers.BigNumber) => n.toNumber());

      // Determine winning outcome
      // For binary markets: [1, 0] means YES won, [0, 1] means NO won
      let winningOutcome: 'YES' | 'NO' | null = null;
      if (payoutNumerators.length === 2) {
        if (payoutNumerators[0] > payoutNumerators[1]) {
          winningOutcome = 'YES';
        } else if (payoutNumerators[1] > payoutNumerators[0]) {
          winningOutcome = 'NO';
        }
      }

      logger.info(`Market resolved: ${winningOutcome || 'Unknown'}`);

      return {
        conditionId,
        resolved: true,
        winningOutcome,
        payoutNumerators,
        blockNumber: latestLog.blockNumber,
        timestamp: block.timestamp,
      };
    } catch (error) {
      logger.error(`Error checking market resolution:`, error);
      return null;
    }
  }

  /**
   * Get current block number and timestamp
   */
  async getBlockInfo(): Promise<{ blockNumber: number; timestamp: number } | null> {
    try {
      const block = await this.provider.getBlock('latest');
      return {
        blockNumber: block.number,
        timestamp: block.timestamp,
      };
    } catch (error) {
      logger.error('Error getting block info:', error);
      return null;
    }
  }

  /**
   * Calculate the actual exit price when selling tokens
   * This looks at the OrderFilled events for sell transactions
   */
  async getExitPrice(txHash: string): Promise<number | null> {
    const verification = await this.verifyTrade(txHash);
    if (!verification || !verification.verified) {
      return null;
    }

    // For sell orders, we're providing tokens and receiving USDC
    // exitPrice = USDC received / tokens sold
    // The fill price calculation in verifyTrade handles this
    return verification.fillPrice;
  }

  /**
   * Get resolved price for a trade based on market outcome
   * Returns 1.00 if the bet won, 0.00 if it lost
   */
  async getResolvedPrice(
    conditionId: string,
    side: 'up' | 'down'
  ): Promise<number | null> {
    const resolution = await this.checkMarketResolution(conditionId);
    if (!resolution || !resolution.resolved) {
      return null;
    }

    // Map 'up'/'down' to 'YES'/'NO'
    const betOutcome = side === 'up' ? 'YES' : 'NO';
    
    if (resolution.winningOutcome === betOutcome) {
      return 1.00; // Won
    } else {
      return 0.00; // Lost
    }
  }

  isReady(): boolean {
    return this.isConnected;
  }
}

// Singleton instance
let verifierInstance: BlockchainVerifier | null = null;

export function getBlockchainVerifier(rpcUrl: string): BlockchainVerifier {
  if (!verifierInstance) {
    verifierInstance = new BlockchainVerifier(rpcUrl);
  }
  return verifierInstance;
}



