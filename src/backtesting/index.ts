/**
 * Historical Backtesting Module
 * 
 * Analyzes past resolved markets to validate and optimize trading strategies.
 * Fetches historical data from Polymarket and simulates trades.
 */

import { createLogger } from '../utils/logger';

const logger = createLogger('Backtester');

const GAMMA_API_URL = 'https://gamma-api.polymarket.com';

// Series IDs for hourly crypto markets
const SERIES_IDS: Record<string, string> = {
  BTC: '10114',
  ETH: '10117',
  SOL: '10122',
};

// Series IDs for 15-minute markets
const SERIES_IDS_15MIN: Record<string, string> = {
  BTC: '10192',
  SOL: '10423',
};

interface ResolvedMarket {
  id: string;
  title: string;
  conditionId: string;
  resolutionDate: string;
  outcome: 'Up' | 'Down' | 'Unknown';
  upPrice: number;      // Price of "Up" before resolution
  downPrice: number;    // Price of "Down" before resolution
  volume: number;
  crypto: string;
}

interface BacktestTrade {
  marketId: string;
  title: string;
  entryPrice: number;
  side: 'Up' | 'Down';
  outcome: 'win' | 'loss';
  pnl: number;          // Per $1 bet: win = (1 - entryPrice), loss = -entryPrice
  date: string;
}

interface BacktestConfig {
  minPrice: number;     // Minimum price threshold (e.g., 0.90)
  maxPrice: number;     // Maximum price threshold (e.g., 0.94)
  betSize: number;      // Simulated bet size in USD
  cryptos: string[];    // Which cryptos to include
  daysBack: number;     // How many days of history to analyze
  marketType: 'hourly' | '15min';
}

interface BacktestResults {
  config: BacktestConfig;
  totalMarkets: number;
  eligibleMarkets: number;
  tradesExecuted: number;
  wins: number;
  losses: number;
  winRate: number;
  totalPnL: number;
  averagePnL: number;
  bestTrade: BacktestTrade | null;
  worstTrade: BacktestTrade | null;
  byDay: Map<string, { trades: number; wins: number; pnl: number }>;
  byCrypto: Map<string, { trades: number; wins: number; pnl: number }>;
  trades: BacktestTrade[];
}

export class Backtester {
  
  /**
   * Fetch price history for a market to get pre-resolution prices
   */
  async fetchPriceHistory(conditionId: string): Promise<{ upPrice: number; downPrice: number } | null> {
    try {
      // Try CLOB API for price history
      const response = await fetch(`https://clob.polymarket.com/prices-history?market=${conditionId}&interval=max&fidelity=60`);
      
      if (!response.ok) return null;
      
      const data = await response.json() as any;
      const history = data.history || [];
      
      if (history.length < 2) return null;
      
      // Get prices from ~30 minutes before end (avoid last-minute spikes)
      // History is sorted oldest to newest, so we want near the end but not the very end
      const targetIndex = Math.max(0, history.length - 30); // 30 minutes before end
      const pricePoint = history[targetIndex];
      
      if (!pricePoint) return null;
      
      const upPrice = parseFloat(pricePoint.p) || 0.5;
      const downPrice = 1 - upPrice;
      
      return { upPrice, downPrice };
    } catch (e) {
      return null;
    }
  }

  /**
   * Fetch resolved markets from a series
   */
  async fetchResolvedMarkets(
    crypto: string, 
    seriesId: string, 
    daysBack: number
  ): Promise<ResolvedMarket[]> {
    const markets: ResolvedMarket[] = [];
    const cutoffDate = new Date();
    cutoffDate.setDate(cutoffDate.getDate() - daysBack);
    const now = new Date();
    
    try {
      logger.info(`Fetching ${crypto} resolved markets (series ${seriesId})...`);
      
      const response = await fetch(`${GAMMA_API_URL}/series/${seriesId}`);
      if (!response.ok) {
        logger.error(`Failed to fetch series ${seriesId}: HTTP ${response.status}`);
        return markets;
      }
      
      const series = await response.json() as any;
      const events = series.events || [];
      
      logger.info(`Found ${events.length} total events in ${crypto} series`);
      
      let processedCount = 0;
      let priceFoundCount = 0;
      
      for (const event of events) {
        try {
          const endDate = new Date(event.endDate);
          
          // Skip if not resolved yet
          if (!event.closed && endDate > now) continue;
          
          // Skip if outside date range
          if (endDate < cutoffDate) continue;
          
          processedCount++;
          
          // Fetch full event details to get market data
          const eventResponse = await fetch(`${GAMMA_API_URL}/events/${event.id}`);
          if (!eventResponse.ok) continue;
          
          const eventDetails = await eventResponse.json() as any;
          const market = eventDetails.markets?.[0];
          
          if (!market) continue;
          
          // Determine outcome from market data
          let outcome: 'Up' | 'Down' | 'Unknown' = 'Unknown';
          
          // Check outcomePrices - winning side should be ~1.0, losing side ~0.0
          if (market.outcomePrices) {
            try {
              const prices = JSON.parse(market.outcomePrices);
              if (Array.isArray(prices) && prices.length >= 2) {
                const upFinal = parseFloat(prices[0]);
                const downFinal = parseFloat(prices[1]);
                
                if (upFinal > 0.9) outcome = 'Up';
                else if (downFinal > 0.9) outcome = 'Down';
              }
            } catch (e) {
              // outcomePrices might not be JSON
            }
          }
          
          // Try to get historical prices (pre-resolution)
          let upPrice = 0.5;
          let downPrice = 0.5;
          
          // Method 1: Try CLOB price history
          if (market.conditionId) {
            const historyPrices = await this.fetchPriceHistory(market.conditionId);
            if (historyPrices) {
              upPrice = historyPrices.upPrice;
              downPrice = historyPrices.downPrice;
              priceFoundCount++;
            }
          }
          
          // Method 2: Use clobTokenIds to fetch from order book if available
          if (upPrice === 0.5 && market.clobTokenIds) {
            try {
              const tokenIds = JSON.parse(market.clobTokenIds);
              if (Array.isArray(tokenIds) && tokenIds.length >= 1) {
                const bookResponse = await fetch(`https://clob.polymarket.com/book?token_id=${tokenIds[0]}`);
                if (bookResponse.ok) {
                  const book = await bookResponse.json() as any;
                  // Get mid price from order book
                  if (book.bids?.length > 0 && book.asks?.length > 0) {
                    const bestBid = parseFloat(book.bids[0].price);
                    const bestAsk = parseFloat(book.asks[0].price);
                    upPrice = (bestBid + bestAsk) / 2;
                    downPrice = 1 - upPrice;
                    priceFoundCount++;
                  }
                }
              }
            } catch (e) {
              // Ignore
            }
          }
          
          // Method 3: Use bestBid/bestAsk from market data
          if (upPrice === 0.5 && market.bestBid && market.bestAsk) {
            upPrice = (parseFloat(market.bestBid) + parseFloat(market.bestAsk)) / 2;
            downPrice = 1 - upPrice;
            if (upPrice !== 0.5) priceFoundCount++;
          }
          
          // Method 4: Use lastTradePrice
          if (upPrice === 0.5 && market.lastTradePrice) {
            upPrice = parseFloat(market.lastTradePrice);
            downPrice = 1 - upPrice;
            if (upPrice !== 0.5) priceFoundCount++;
          }
          
          markets.push({
            id: event.id,
            title: event.title || market.question || 'Unknown',
            conditionId: market.conditionId || '',
            resolutionDate: endDate.toISOString(),
            outcome,
            upPrice,
            downPrice,
            volume: parseFloat(market.volume) || 0,
            crypto,
          });
          
          // Rate limiting - slightly longer to avoid rate limits
          await new Promise(r => setTimeout(r, 100));
          
          // Progress logging every 100 markets
          if (processedCount % 100 === 0) {
            logger.info(`${crypto}: Processed ${processedCount} markets, found ${priceFoundCount} with price data...`);
          }
          
        } catch (e: any) {
          logger.debug(`Failed to process event ${event.id}: ${e.message}`);
        }
      }
      
      logger.info(`${crypto}: Found ${markets.length} resolved markets in range (${priceFoundCount} with price data)`);
      
    } catch (e: any) {
      logger.error(`Error fetching ${crypto} markets: ${e.message}`);
    }
    
    return markets;
  }

  /**
   * Simulate a trade and calculate P&L
   */
  simulateTrade(market: ResolvedMarket, side: 'Up' | 'Down', entryPrice: number): BacktestTrade {
    const won = market.outcome === side;
    
    // P&L calculation:
    // - Win: You get $1 per share, paid entryPrice, profit = 1 - entryPrice
    // - Loss: You get $0 per share, paid entryPrice, loss = -entryPrice
    const pnl = won ? (1 - entryPrice) : -entryPrice;
    
    return {
      marketId: market.id,
      title: market.title,
      entryPrice,
      side,
      outcome: won ? 'win' : 'loss',
      pnl,
      date: market.resolutionDate.split('T')[0],
    };
  }

  /**
   * Run backtest with given configuration
   */
  async runBacktest(config: BacktestConfig): Promise<BacktestResults> {
    logger.info('='.repeat(60));
    logger.info('STARTING BACKTEST');
    logger.info('='.repeat(60));
    logger.info(`Strategy: Buy side priced ${config.minPrice * 100}¢ - ${config.maxPrice * 100}¢`);
    logger.info(`Cryptos: ${config.cryptos.join(', ')}`);
    logger.info(`Period: Last ${config.daysBack} days`);
    logger.info(`Market type: ${config.marketType}`);
    logger.info('='.repeat(60));
    
    const seriesMap = config.marketType === '15min' ? SERIES_IDS_15MIN : SERIES_IDS;
    
    // Fetch all resolved markets
    const allMarkets: ResolvedMarket[] = [];
    
    for (const crypto of config.cryptos) {
      const seriesId = seriesMap[crypto];
      if (!seriesId) {
        logger.warn(`No series ID for ${crypto} (${config.marketType})`);
        continue;
      }
      
      const markets = await this.fetchResolvedMarkets(crypto, seriesId, config.daysBack);
      allMarkets.push(...markets);
    }
    
    logger.info(`Total resolved markets fetched: ${allMarkets.length}`);
    
    // Initialize results
    const results: BacktestResults = {
      config,
      totalMarkets: allMarkets.length,
      eligibleMarkets: 0,
      tradesExecuted: 0,
      wins: 0,
      losses: 0,
      winRate: 0,
      totalPnL: 0,
      averagePnL: 0,
      bestTrade: null,
      worstTrade: null,
      byDay: new Map(),
      byCrypto: new Map(),
      trades: [],
    };
    
    // Process each market
    for (const market of allMarkets) {
      // Skip if outcome unknown
      if (market.outcome === 'Unknown') continue;
      
      // Check if either side meets our criteria
      let tradeSignal: { side: 'Up' | 'Down'; price: number } | null = null;
      
      if (market.upPrice >= config.minPrice && market.upPrice <= config.maxPrice) {
        tradeSignal = { side: 'Up', price: market.upPrice };
      } else if (market.downPrice >= config.minPrice && market.downPrice <= config.maxPrice) {
        tradeSignal = { side: 'Down', price: market.downPrice };
      }
      
      if (!tradeSignal) continue;
      
      results.eligibleMarkets++;
      
      // Simulate the trade
      const trade = this.simulateTrade(market, tradeSignal.side, tradeSignal.price);
      results.trades.push(trade);
      results.tradesExecuted++;
      
      if (trade.outcome === 'win') {
        results.wins++;
      } else {
        results.losses++;
      }
      
      results.totalPnL += trade.pnl * config.betSize;
      
      // Track best/worst trades
      if (!results.bestTrade || trade.pnl > results.bestTrade.pnl) {
        results.bestTrade = trade;
      }
      if (!results.worstTrade || trade.pnl < results.worstTrade.pnl) {
        results.worstTrade = trade;
      }
      
      // Track by day
      const dayStats = results.byDay.get(trade.date) || { trades: 0, wins: 0, pnl: 0 };
      dayStats.trades++;
      if (trade.outcome === 'win') dayStats.wins++;
      dayStats.pnl += trade.pnl * config.betSize;
      results.byDay.set(trade.date, dayStats);
      
      // Track by crypto
      const cryptoStats = results.byCrypto.get(market.crypto) || { trades: 0, wins: 0, pnl: 0 };
      cryptoStats.trades++;
      if (trade.outcome === 'win') cryptoStats.wins++;
      cryptoStats.pnl += trade.pnl * config.betSize;
      results.byCrypto.set(market.crypto, cryptoStats);
    }
    
    // Calculate final stats
    results.winRate = results.tradesExecuted > 0 
      ? (results.wins / results.tradesExecuted) * 100 
      : 0;
    results.averagePnL = results.tradesExecuted > 0 
      ? results.totalPnL / results.tradesExecuted 
      : 0;
    
    return results;
  }

  /**
   * Print backtest results in a readable format
   */
  printResults(results: BacktestResults): void {
    console.log('\n' + '='.repeat(60));
    console.log('📊 BACKTEST RESULTS');
    console.log('='.repeat(60));
    
    console.log('\n📈 STRATEGY CONFIGURATION');
    console.log(`   Price Range: ${results.config.minPrice * 100}¢ - ${results.config.maxPrice * 100}¢`);
    console.log(`   Bet Size: $${results.config.betSize}`);
    console.log(`   Period: ${results.config.daysBack} days`);
    console.log(`   Markets: ${results.config.marketType} (${results.config.cryptos.join(', ')})`);
    
    console.log('\n📊 OVERALL PERFORMANCE');
    console.log(`   Total Markets Scanned: ${results.totalMarkets}`);
    console.log(`   Eligible Markets: ${results.eligibleMarkets}`);
    console.log(`   Trades Executed: ${results.tradesExecuted}`);
    console.log(`   Wins: ${results.wins}`);
    console.log(`   Losses: ${results.losses}`);
    console.log(`   Win Rate: ${results.winRate.toFixed(1)}%`);
    
    console.log('\n💰 P&L SUMMARY');
    console.log(`   Total P&L: $${results.totalPnL.toFixed(2)}`);
    console.log(`   Average P&L per Trade: $${results.averagePnL.toFixed(2)}`);
    
    if (results.bestTrade) {
      console.log(`   Best Trade: +$${(results.bestTrade.pnl * results.config.betSize).toFixed(2)} (${results.bestTrade.side} @ ${(results.bestTrade.entryPrice * 100).toFixed(1)}¢)`);
    }
    if (results.worstTrade) {
      console.log(`   Worst Trade: $${(results.worstTrade.pnl * results.config.betSize).toFixed(2)} (${results.worstTrade.side} @ ${(results.worstTrade.entryPrice * 100).toFixed(1)}¢)`);
    }
    
    console.log('\n📈 BY CRYPTO');
    for (const [crypto, stats] of results.byCrypto) {
      const wr = stats.trades > 0 ? ((stats.wins / stats.trades) * 100).toFixed(1) : '0';
      console.log(`   ${crypto}: ${stats.trades} trades, ${wr}% win rate, $${stats.pnl.toFixed(2)} P&L`);
    }
    
    console.log('\n📅 RECENT DAYS');
    const sortedDays = [...results.byDay.entries()].sort((a, b) => b[0].localeCompare(a[0])).slice(0, 7);
    for (const [day, stats] of sortedDays) {
      const wr = stats.trades > 0 ? ((stats.wins / stats.trades) * 100).toFixed(0) : '0';
      console.log(`   ${day}: ${stats.trades} trades, ${wr}% WR, $${stats.pnl.toFixed(2)}`);
    }
    
    // ROI calculation
    const totalInvested = results.tradesExecuted * results.config.betSize;
    const roi = totalInvested > 0 ? (results.totalPnL / totalInvested) * 100 : 0;
    
    console.log('\n📊 KEY METRICS');
    console.log(`   ROI: ${roi.toFixed(2)}%`);
    console.log(`   Expected Value per $1 bet: $${(results.averagePnL / results.config.betSize).toFixed(4)}`);
    
    console.log('\n' + '='.repeat(60));
  }

  /**
   * Run threshold optimization to find best price range
   */
  async optimizeThresholds(
    cryptos: string[],
    daysBack: number,
    marketType: 'hourly' | '15min' = 'hourly'
  ): Promise<void> {
    console.log('\n' + '='.repeat(60));
    console.log('🔬 THRESHOLD OPTIMIZATION');
    console.log('='.repeat(60));
    console.log('Testing different price thresholds to find optimal range...\n');
    
    const thresholdTests = [
      { min: 0.85, max: 0.90 },
      { min: 0.88, max: 0.92 },
      { min: 0.90, max: 0.94 },
      { min: 0.90, max: 0.95 },
      { min: 0.92, max: 0.96 },
      { min: 0.93, max: 0.97 },
      { min: 0.94, max: 0.98 },
    ];
    
    const optimizationResults: { range: string; winRate: number; trades: number; pnl: number; roi: number }[] = [];
    
    for (const test of thresholdTests) {
      const results = await this.runBacktest({
        minPrice: test.min,
        maxPrice: test.max,
        betSize: 10,
        cryptos,
        daysBack,
        marketType,
      });
      
      const totalInvested = results.tradesExecuted * 10;
      const roi = totalInvested > 0 ? (results.totalPnL / totalInvested) * 100 : 0;
      
      optimizationResults.push({
        range: `${test.min * 100}-${test.max * 100}¢`,
        winRate: results.winRate,
        trades: results.tradesExecuted,
        pnl: results.totalPnL,
        roi,
      });
    }
    
    console.log('\n📊 OPTIMIZATION RESULTS');
    console.log('─'.repeat(60));
    console.log('Range\t\tTrades\tWin Rate\tP&L\t\tROI');
    console.log('─'.repeat(60));
    
    for (const r of optimizationResults) {
      console.log(`${r.range}\t\t${r.trades}\t${r.winRate.toFixed(1)}%\t\t$${r.pnl.toFixed(2)}\t\t${r.roi.toFixed(2)}%`);
    }
    
    // Find best by ROI
    const bestByRoi = optimizationResults.reduce((best, curr) => 
      curr.roi > best.roi ? curr : best
    );
    
    // Find best by win rate (with min trades)
    const withMinTrades = optimizationResults.filter(r => r.trades >= 10);
    const bestByWinRate = withMinTrades.length > 0 
      ? withMinTrades.reduce((best, curr) => curr.winRate > best.winRate ? curr : best)
      : null;
    
    console.log('\n🏆 RECOMMENDATIONS');
    console.log(`   Best ROI: ${bestByRoi.range} (${bestByRoi.roi.toFixed(2)}% ROI, ${bestByRoi.winRate.toFixed(1)}% WR)`);
    if (bestByWinRate) {
      console.log(`   Best Win Rate: ${bestByWinRate.range} (${bestByWinRate.winRate.toFixed(1)}% WR, ${bestByWinRate.trades} trades)`);
    }
    
    console.log('\n' + '='.repeat(60));
  }
}

// CLI interface
async function main() {
  const backtester = new Backtester();
  
  const args = process.argv.slice(2);
  const command = args[0] || 'run';
  
  if (command === 'optimize') {
    // Run threshold optimization
    await backtester.optimizeThresholds(
      ['BTC', 'ETH', 'SOL'],
      30,  // 30 days
      'hourly'
    );
  } else {
    // Run standard backtest
    const results = await backtester.runBacktest({
      minPrice: 0.90,
      maxPrice: 0.94,
      betSize: 10,
      cryptos: ['BTC', 'ETH', 'SOL'],
      daysBack: 30,
      marketType: 'hourly',
    });
    
    backtester.printResults(results);
  }
}

// Export for use as module
export { BacktestConfig, BacktestResults, BacktestTrade };

// Run if executed directly
if (require.main === module) {
  main().catch(console.error);
}

