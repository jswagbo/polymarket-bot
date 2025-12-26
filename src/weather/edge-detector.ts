import { createLogger } from '../utils/logger';
import { NWSClient, DailyForecast, CITIES } from './nws-client';

const logger = createLogger('WeatherEdge');

// Configuration
export const MIN_EDGE_THRESHOLD = 0.10;  // 10% minimum edge to flag
export const MAX_EDGE_THRESHOLD = 0.50;  // 50% max (avoid broken data)

export interface TempBucket {
  low: number;
  high: number;
  label: string;
}

export interface MarketOutcome {
  tokenId: string;
  bucket: TempBucket;
  price: number;  // Current YES price (probability)
}

export interface WeatherMarket {
  marketId: string;
  conditionId: string;
  city: string;
  cityCode: string;
  targetDate: string;
  outcomes: MarketOutcome[];
  question: string;
}

export interface WeatherOpportunity {
  id: string;
  city: string;
  cityCode: string;
  targetDate: string;
  bucket: TempBucket;
  tokenId: string;
  nwsForecastHigh: number;
  nwsConfidence: string;
  marketPrice: number;
  impliedProb: number;
  estimatedTrueProb: number;
  edge: number;
  action: 'BUY_YES' | 'BUY_NO';
  expectedValue: number;
  hoursUntil: number;
  detectedAt: string;
}

/**
 * Standard normal distribution CDF approximation
 * Using Abramowitz and Stegun approximation
 */
function normalCDF(x: number): number {
  const a1 = 0.254829592;
  const a2 = -0.284496736;
  const a3 = 1.421413741;
  const a4 = -1.453152027;
  const a5 = 1.061405429;
  const p = 0.3275911;

  const sign = x < 0 ? -1 : 1;
  x = Math.abs(x) / Math.sqrt(2);

  const t = 1.0 / (1.0 + p * x);
  const y = 1.0 - (((((a5 * t + a4) * t) + a3) * t + a2) * t + a1) * t * Math.exp(-x * x);

  return 0.5 * (1.0 + sign * y);
}

/**
 * Calculate probability that actual temperature falls within a bucket
 * Uses normal distribution centered on NWS prediction
 */
export function estimateTrueProbability(
  nwsPredictedHigh: number,
  bucket: TempBucket,
  confidence: 'very_high' | 'high' | 'medium' | 'low'
): number {
  const stdDev = NWSClient.getStdDev(confidence);
  
  // P(bucket.low - 0.5 <= actual <= bucket.high + 0.5)
  // We use ±0.5 to account for rounding
  const zLow = (bucket.low - 0.5 - nwsPredictedHigh) / stdDev;
  const zHigh = (bucket.high + 0.5 - nwsPredictedHigh) / stdDev;
  
  const prob = normalCDF(zHigh) - normalCDF(zLow);
  
  return Math.max(0, Math.min(1, prob));  // Clamp to [0, 1]
}

/**
 * Calculate edge and recommended action
 */
export function calculateEdge(
  trueProb: number,
  marketPrice: number
): { edge: number; action: 'BUY_YES' | 'BUY_NO' } {
  // Edge for buying YES (market is underpricing this outcome)
  const edgeYes = trueProb - marketPrice;
  
  // Edge for buying NO (market is overpricing this outcome)
  const edgeNo = (1 - trueProb) - (1 - marketPrice);
  
  if (edgeYes > edgeNo && edgeYes > 0) {
    return { edge: edgeYes, action: 'BUY_YES' };
  } else if (edgeNo > 0) {
    return { edge: edgeNo, action: 'BUY_NO' };
  } else {
    return { edge: Math.max(edgeYes, edgeNo), action: edgeYes > edgeNo ? 'BUY_YES' : 'BUY_NO' };
  }
}

/**
 * Parse temperature bucket from outcome label
 * Handles formats like "85-86°F", "< 80°F", "> 95°F"
 */
export function parseTempBucket(label: string): TempBucket | null {
  // Handle "< X°F" format
  const lessThanMatch = label.match(/<\s*(\d+)/);
  if (lessThanMatch) {
    return {
      low: -999,
      high: parseInt(lessThanMatch[1]) - 1,
      label,
    };
  }
  
  // Handle "> X°F" format
  const greaterThanMatch = label.match(/>\s*(\d+)/);
  if (greaterThanMatch) {
    return {
      low: parseInt(greaterThanMatch[1]) + 1,
      high: 999,
      label,
    };
  }
  
  // Handle "X-Y°F" or "X to Y" format
  const rangeMatch = label.match(/(\d+)\s*[-–to]+\s*(\d+)/);
  if (rangeMatch) {
    return {
      low: parseInt(rangeMatch[1]),
      high: parseInt(rangeMatch[2]),
      label,
    };
  }
  
  // Handle single number "X°F"
  const singleMatch = label.match(/^(\d+)\s*°?F?$/);
  if (singleMatch) {
    const temp = parseInt(singleMatch[1]);
    return {
      low: temp,
      high: temp,
      label,
    };
  }
  
  return null;
}

/**
 * Main edge detection: compare NWS forecast to market prices
 */
export function detectOpportunities(
  market: WeatherMarket,
  forecast: DailyForecast
): WeatherOpportunity[] {
  const opportunities: WeatherOpportunity[] = [];
  
  logger.info(`Analyzing ${market.city} (${market.targetDate}): NWS predicts ${forecast.highTemp}°F (${forecast.confidence} confidence)`);
  
  for (const outcome of market.outcomes) {
    const bucket = outcome.bucket;
    
    // Skip extreme buckets that are hard to price
    if (bucket.low === -999 || bucket.high === 999) {
      continue;
    }
    
    // Calculate true probability based on NWS forecast
    const trueProb = estimateTrueProbability(
      forecast.highTemp,
      bucket,
      forecast.confidence
    );
    
    // Calculate edge
    const { edge, action } = calculateEdge(trueProb, outcome.price);
    
    // Check if edge is significant
    if (edge >= MIN_EDGE_THRESHOLD && edge <= MAX_EDGE_THRESHOLD) {
      const opportunity: WeatherOpportunity = {
        id: `${market.marketId}-${bucket.label}-${Date.now()}`,
        city: market.city,
        cityCode: market.cityCode,
        targetDate: market.targetDate,
        bucket,
        tokenId: outcome.tokenId,
        nwsForecastHigh: forecast.highTemp,
        nwsConfidence: forecast.confidence,
        marketPrice: outcome.price,
        impliedProb: outcome.price,
        estimatedTrueProb: trueProb,
        edge,
        action,
        expectedValue: edge * 100, // As percentage
        hoursUntil: forecast.hoursUntil,
        detectedAt: new Date().toISOString(),
      };
      
      opportunities.push(opportunity);
      
      logger.info(`🎯 OPPORTUNITY: ${market.city} ${bucket.label}`);
      logger.info(`   NWS: ${forecast.highTemp}°F | Market: ${(outcome.price * 100).toFixed(1)}¢ | True: ${(trueProb * 100).toFixed(1)}%`);
      logger.info(`   Edge: ${(edge * 100).toFixed(1)}% | Action: ${action}`);
    }
  }
  
  return opportunities;
}

/**
 * Calculate expected value for a bet
 */
export function calculateExpectedValue(
  trueProb: number,
  marketPrice: number,
  betSize: number
): number {
  // If buying YES at market price
  // Win: (1 - marketPrice) * betSize with probability trueProb
  // Lose: marketPrice * betSize with probability (1 - trueProb)
  const winAmount = (1 - marketPrice) * betSize;
  const loseAmount = marketPrice * betSize;
  
  const ev = (trueProb * winAmount) - ((1 - trueProb) * loseAmount);
  return ev;
}

/**
 * Validate that probabilities across all buckets sum to ~1
 */
export function validateProbabilities(
  nwsHigh: number,
  buckets: TempBucket[],
  confidence: 'very_high' | 'high' | 'medium' | 'low'
): { isValid: boolean; totalProb: number } {
  let totalProb = 0;
  
  for (const bucket of buckets) {
    totalProb += estimateTrueProbability(nwsHigh, bucket, confidence);
  }
  
  // Should be close to 1 (accounting for extreme buckets we might skip)
  const isValid = totalProb > 0.90 && totalProb < 1.10;
  
  return { isValid, totalProb };
}


