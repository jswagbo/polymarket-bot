import { createLogger } from '../utils/logger';
import { PolymarketClient } from '../polymarket/client';
import { NWSClient, CITIES, DailyForecast } from './nws-client';
import { 
  WeatherMarket, 
  WeatherOpportunity, 
  MarketOutcome,
  parseTempBucket,
  detectOpportunities,
  MIN_EDGE_THRESHOLD,
} from './edge-detector';

const logger = createLogger('WeatherScanner');

const GAMMA_API_URL = 'https://gamma-api.polymarket.com';

// Keywords to identify temperature markets
const TEMP_KEYWORDS = [
  'highest temperature',
  'temperature',
  'high temperature',
  'daily high',
  'degrees',
  '°F',
  '°f',
];

// Search queries to find temperature markets
const SEARCH_QUERIES = [
  'highest temperature',
  'temperature NYC',
  'temperature LA',
  'temperature Chicago',
  'temperature Miami',
  'temperature Dallas',
  'temperature Seattle',
];

// City name variations in market titles
const CITY_VARIATIONS: Record<string, string[]> = {
  NYC: ['new york', 'nyc', 'manhattan', 'central park'],
  LA: ['los angeles', 'la', 'lax'],
  Chicago: ['chicago', 'ord'],
  Miami: ['miami', 'mia'],
  Dallas: ['dallas', 'dfw', 'fort worth'],
  Seattle: ['seattle', 'sea'],
};

export interface WeatherScanResult {
  markets: WeatherMarket[];
  forecasts: Map<string, DailyForecast>;
  opportunities: WeatherOpportunity[];
  scannedAt: string;
}

export class WeatherScanner {
  private nwsClient: NWSClient;
  private polyClient: PolymarketClient;

  constructor(polyClient: PolymarketClient) {
    this.nwsClient = new NWSClient();
    this.polyClient = polyClient;
  }

  /**
   * Search for temperature markets on Polymarket
   */
  async findTemperatureMarkets(): Promise<WeatherMarket[]> {
    const markets: WeatherMarket[] = [];

    try {
      // First try searching events
      logger.info('Searching for temperature events...');
      const eventsResponse = await fetch(
        `${GAMMA_API_URL}/events?closed=false&limit=100&_q=${encodeURIComponent('highest temperature')}`,
        { headers: { 'Accept': 'application/json' } }
      );

      if (eventsResponse.ok) {
        const events = await eventsResponse.json() as any[];
        logger.info(`Found ${events.length} events matching "highest temperature"`);
        
        for (const event of events) {
          // Each event may have multiple markets (one per temperature bucket)
          if (event.markets && event.markets.length > 0) {
            const weatherMarket = this.parseEventAsMarket(event);
            if (weatherMarket) {
              markets.push(weatherMarket);
            }
          }
        }
      }

      // Also try market search
      const marketsFound = await this.searchBroadly();
      
      // Merge, avoiding duplicates
      for (const m of marketsFound) {
        if (!markets.find(existing => existing.marketId === m.marketId)) {
          markets.push(m);
        }
      }

      logger.info(`Total temperature markets found: ${markets.length}`);
      return markets;
    } catch (error) {
      logger.error('Failed to fetch temperature markets:', error);
      return await this.searchBroadly();
    }
  }

  /**
   * Parse a Polymarket event (with multiple markets) into our WeatherMarket format
   */
  private parseEventAsMarket(event: any): WeatherMarket | null {
    const title = (event.title || event.question || '').toLowerCase();
    const slug = (event.slug || '').toLowerCase();
    const searchText = `${title} ${slug}`;
    
    // Check if it's a temperature event
    const isTemp = TEMP_KEYWORDS.some(kw => searchText.includes(kw.toLowerCase()));
    if (!isTemp) return null;

    // Identify the city
    let cityCode: string | null = null;
    let cityName: string = '';
    
    for (const [code, variations] of Object.entries(CITY_VARIATIONS)) {
      if (variations.some(v => searchText.includes(v))) {
        cityCode = code;
        cityName = CITIES[code].name;
        break;
      }
    }
    
    if (!cityCode) return null;

    // Parse target date
    const targetDate = this.extractTargetDate(title, event);
    if (!targetDate) return null;

    // Parse outcomes from all markets in the event
    const outcomes: MarketOutcome[] = [];
    
    for (const market of (event.markets || [])) {
      const label = market.groupItemTitle || market.outcome || market.question || '';
      const bucket = parseTempBucket(label);
      
      if (bucket) {
        // Get best price from market
        let price = 0.5;
        if (market.outcomePrices && market.outcomePrices.length > 0) {
          price = parseFloat(market.outcomePrices[0]);
        } else if (market.bestAsk) {
          price = parseFloat(market.bestAsk);
        }
        
        outcomes.push({
          tokenId: market.clobTokenIds?.[0] || market.conditionId || market.id,
          bucket,
          price,
        });
      }
    }

    if (outcomes.length === 0) return null;

    logger.info(`✓ Parsed event: ${cityName} on ${targetDate} with ${outcomes.length} temperature buckets`);

    return {
      marketId: event.id || event.conditionId,
      conditionId: event.conditionId || event.id,
      city: cityName,
      cityCode,
      targetDate,
      outcomes,
      question: event.title || event.question,
    };
  }

  /**
   * Broader search for temperature markets
   */
  private async searchBroadly(): Promise<WeatherMarket[]> {
    const markets: WeatherMarket[] = [];

    try {
      // Search for markets with temperature-related keywords
      for (const keyword of SEARCH_QUERIES) {
        logger.info(`Searching for: "${keyword}"...`);
        const response = await fetch(
          `${GAMMA_API_URL}/markets?closed=false&limit=50&_q=${encodeURIComponent(keyword)}`,
          { headers: { 'Accept': 'application/json' } }
        );

        if (response.ok) {
          const data = await response.json() as any[];
          logger.info(`  Found ${data.length} results for "${keyword}"`);
          
          for (const market of data) {
            const weatherMarket = this.parseWeatherMarket(market);
            if (weatherMarket && !markets.find(m => m.marketId === weatherMarket.marketId)) {
              markets.push(weatherMarket);
              logger.info(`  ✓ Added market: ${weatherMarket.question}`);
            }
          }
        }
        
        await new Promise(resolve => setTimeout(resolve, 300));
      }

      return markets;
    } catch (error) {
      logger.error('Broad search failed:', error);
      return [];
    }
  }

  /**
   * Parse a Polymarket market into our WeatherMarket format
   */
  private parseWeatherMarket(market: any): WeatherMarket | null {
    const question = (market.question || market.title || '').toLowerCase();
    const slug = (market.slug || market.groupItemTitle || '').toLowerCase();
    const searchText = `${question} ${slug}`;
    
    // Check if it's a temperature market
    const isTemp = TEMP_KEYWORDS.some(kw => searchText.includes(kw.toLowerCase()));
    if (!isTemp) {
      return null;
    }

    // Identify the city
    let cityCode: string | null = null;
    let cityName: string = '';
    
    for (const [code, variations] of Object.entries(CITY_VARIATIONS)) {
      if (variations.some(v => searchText.includes(v))) {
        cityCode = code;
        cityName = CITIES[code].name;
        break;
      }
    }
    
    if (!cityCode) {
      logger.debug(`No city match found in: ${question}`);
      return null;
    }

    // Parse target date from market
    const targetDate = this.extractTargetDate(question, market);
    if (!targetDate) {
      logger.debug(`No target date found in: ${question}`);
      return null;
    }

    // Parse outcomes/buckets
    const outcomes = this.parseOutcomes(market);
    if (outcomes.length === 0) {
      logger.debug(`No temperature buckets found in: ${question}`);
      return null;
    }

    logger.info(`✓ Parsed market: ${cityName} on ${targetDate} with ${outcomes.length} buckets`);

    return {
      marketId: market.id || market.conditionId,
      conditionId: market.conditionId,
      city: cityName,
      cityCode,
      targetDate,
      outcomes,
      question: market.question || market.title,
    };
  }

  /**
   * Extract target date from market question/metadata
   */
  private extractTargetDate(question: string, market: any): string | null {
    // Try to get from market metadata
    if (market.endDate) {
      return new Date(market.endDate).toISOString().split('T')[0];
    }

    // Try to parse from question
    // Patterns: "December 25", "Dec 25", "12/25", "2025-12-25"
    const datePatterns = [
      /(\d{4}-\d{2}-\d{2})/,  // ISO format
      /(\d{1,2}\/\d{1,2}\/?\d{0,4})/,  // MM/DD or MM/DD/YY
      /(january|february|march|april|may|june|july|august|september|october|november|december)\s+(\d{1,2})/i,
      /(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)\.?\s+(\d{1,2})/i,
    ];

    for (const pattern of datePatterns) {
      const match = question.match(pattern);
      if (match) {
        try {
          const parsed = new Date(match[0]);
          if (!isNaN(parsed.getTime())) {
            return parsed.toISOString().split('T')[0];
          }
        } catch {}
      }
    }

    // Default to tomorrow if no date found
    const tomorrow = new Date();
    tomorrow.setDate(tomorrow.getDate() + 1);
    return tomorrow.toISOString().split('T')[0];
  }

  /**
   * Parse market outcomes into temperature buckets
   */
  private parseOutcomes(market: any): MarketOutcome[] {
    const outcomes: MarketOutcome[] = [];
    
    // Handle different market structures - Polymarket can have nested outcomes
    let outcomesList = market.outcomes || market.tokens || [];
    
    // If this is an event with multiple markets, try to get outcomes from markets
    if (outcomesList.length === 0 && market.markets) {
      for (const subMarket of market.markets) {
        if (subMarket.outcomes) {
          outcomesList = outcomesList.concat(subMarket.outcomes);
        }
      }
    }
    
    // Also check for groupItemTitle pattern (temperature ranges)
    if (market.groupItemTitle) {
      const bucket = parseTempBucket(market.groupItemTitle);
      if (bucket) {
        outcomes.push({
          tokenId: market.clobTokenIds?.[0] || market.conditionId || market.id,
          bucket,
          price: parseFloat(market.outcomePrices?.[0] || market.bestAsk || '0.5'),
        });
      }
    }
    
    for (const outcome of outcomesList) {
      const label = outcome.outcome || outcome.name || outcome.title || outcome.groupItemTitle || '';
      const bucket = parseTempBucket(label);
      
      if (bucket) {
        const price = parseFloat(
          outcome.price || 
          outcome.lastTradePrice || 
          outcome.outcomePrices?.[0] ||
          outcome.bestAsk ||
          '0.5'
        );
        
        outcomes.push({
          tokenId: outcome.tokenId || outcome.token_id || outcome.clobTokenIds?.[0] || outcome.id,
          bucket,
          price,
        });
      }
    }

    return outcomes;
  }

  /**
   * Fetch current prices for market outcomes
   */
  async updateMarketPrices(market: WeatherMarket): Promise<WeatherMarket> {
    for (const outcome of market.outcomes) {
      try {
        const price = await this.polyClient.getPrice(outcome.tokenId);
        outcome.price = price > 0 ? price : outcome.price;
      } catch (error) {
        logger.debug(`Failed to get price for ${outcome.tokenId}`);
      }
    }
    return market;
  }

  /**
   * Main scan function: find markets, get forecasts, detect opportunities
   */
  async scan(targetDate?: Date): Promise<WeatherScanResult> {
    const scanDate = targetDate || this.getTomorrowDate();
    logger.info(`=== WEATHER SCAN for ${scanDate.toISOString().split('T')[0]} ===`);

    const result: WeatherScanResult = {
      markets: [],
      forecasts: new Map(),
      opportunities: [],
      scannedAt: new Date().toISOString(),
    };

    try {
      // 1. Find temperature markets
      logger.info('Searching for temperature markets...');
      result.markets = await this.findTemperatureMarkets();
      logger.info(`Found ${result.markets.length} temperature markets`);

      if (result.markets.length === 0) {
        logger.warn('No temperature markets found on Polymarket');
        return result;
      }

      // 2. Get NWS forecasts for all cities with markets
      logger.info('Fetching NWS forecasts...');
      const cityCodesWithMarkets = [...new Set(result.markets.map(m => m.cityCode))];
      
      for (const cityCode of cityCodesWithMarkets) {
        try {
          const forecast = await this.nwsClient.getDailyHigh(cityCode, scanDate);
          if (forecast) {
            result.forecasts.set(cityCode, forecast);
            logger.info(`${cityCode}: NWS predicts ${forecast.highTemp}°F (${forecast.confidence})`);
          }
        } catch (error) {
          logger.error(`Failed to get forecast for ${cityCode}:`, error);
        }
        await new Promise(resolve => setTimeout(resolve, 300));
      }

      // 3. Update market prices and detect opportunities
      logger.info('Analyzing markets for opportunities...');
      
      for (const market of result.markets) {
        const forecast = result.forecasts.get(market.cityCode);
        if (!forecast) continue;

        // Update prices
        await this.updateMarketPrices(market);

        // Detect opportunities
        const opps = detectOpportunities(market, forecast);
        result.opportunities.push(...opps);
      }

      logger.info(`=== SCAN COMPLETE: ${result.opportunities.length} opportunities found ===`);
      
      // Sort opportunities by edge (highest first)
      result.opportunities.sort((a, b) => b.edge - a.edge);

      return result;
    } catch (error) {
      logger.error('Weather scan failed:', error);
      throw error;
    }
  }

  /**
   * Get tomorrow's date at midnight local time
   */
  private getTomorrowDate(): Date {
    const tomorrow = new Date();
    tomorrow.setDate(tomorrow.getDate() + 1);
    tomorrow.setHours(0, 0, 0, 0);
    return tomorrow;
  }

  /**
   * Quick scan - just check if any opportunities exist
   */
  async quickScan(): Promise<{ hasOpportunities: boolean; count: number; topOpportunity: WeatherOpportunity | null }> {
    const result = await this.scan();
    return {
      hasOpportunities: result.opportunities.length > 0,
      count: result.opportunities.length,
      topOpportunity: result.opportunities[0] || null,
    };
  }
}

