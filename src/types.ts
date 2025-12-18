// Polymarket Market Types
export interface Market {
  id: string;
  condition_id: string;
  question: string;
  description: string;
  market_slug: string;
  end_date_iso: string;
  active: boolean;
  closed: boolean;
  tokens: Token[];
  minimum_order_size: number;
  minimum_tick_size: number;
}

export interface Token {
  token_id: string;
  outcome: string;
  price: number;
  winner: boolean;
}

export interface OrderBook {
  bids: OrderBookLevel[];
  asks: OrderBookLevel[];
  market: string;
  asset_id: string;
  hash: string;
  timestamp: string;
}

export interface OrderBookLevel {
  price: string;
  size: string;
}

// Trading Types
export interface StraddleOpportunity {
  market: Market;
  upToken: Token;
  downToken: Token;
  upPrice: number;
  downPrice: number;
  combinedCost: number;
  upSize: number;
  downSize: number;
  expectedValue: number;
  isViable: boolean;
}

// NEW: Single-leg opportunity (buy expensive side only)
export interface SingleLegOpportunity {
  market: Market;
  token: Token;
  side: 'up' | 'down';
  price: number;
  size: number;
  expectedValue: number;
  expectedWinRate: number;
  isViable: boolean;
}

export interface Trade {
  id: string;
  market_id: string;
  market_question: string;
  // Support both straddle (both tokens) and single-leg (one token) trades
  trade_type: 'straddle' | 'single_leg';
  side?: 'up' | 'down';           // For single-leg trades
  up_token_id: string;
  down_token_id: string;
  up_price: number;
  down_price: number;
  up_size: number;
  down_size: number;
  combined_cost: number;
  status: TradeStatus;
  up_order_id?: string;
  down_order_id?: string;
  pnl?: number;
  created_at: string;
  resolved_at?: string;
}

export type TradeStatus = 
  | 'pending'      // Trade is being placed
  | 'open'         // Both legs filled, waiting for resolution
  | 'partial'      // One leg filled
  | 'resolved'     // Market resolved, PnL calculated
  | 'failed'       // Trade failed
  | 'cancelled';   // Trade cancelled

export interface Position {
  market_id: string;
  market_question: string;
  up_shares: number;
  down_shares: number;
  avg_up_price: number;
  avg_down_price: number;
  total_invested: number;
  current_value: number;
  unrealized_pnl: number;
}

// API Response Types
export interface ApiResponse<T> {
  success: boolean;
  data?: T;
  error?: string;
}

export interface BotStatus {
  enabled: boolean;
  lastScan: string | null;
  activePositions: number;
  totalTrades: number;
  totalPnL: number;
  uptime: number;
}

export interface DashboardStats {
  status: BotStatus;
  config: {
    betSize: number;
    botEnabled: boolean;
    maxCombinedCost: number;
  };
  recentTrades: Trade[];
  activePositions: Position[];
}

// Bitcoin Market Detection
export interface BitcoinMarketFilter {
  keywords: string[];
  excludeKeywords: string[];
}

export const BITCOIN_MARKET_FILTER: BitcoinMarketFilter = {
  keywords: [
    'bitcoin up or down',
    'btc up or down',
    'bitcoin updown',
    'btc-updown',
  ],
  excludeKeywords: [],
};

// Gamma API Types for Hourly Markets
export interface GammaSeries {
  id: string;
  ticker: string;
  slug: string;
  title: string;
  recurrence: 'hourly' | 'daily' | 'weekly' | 'monthly';
  active: boolean;
  closed: boolean;
  events: GammaEvent[];
}

export interface GammaEvent {
  id: string;
  ticker: string;
  slug: string;
  title: string;
  description: string;
  endDate: string;
  active: boolean;
  closed: boolean;
  volume: number;
  markets?: GammaMarket[];
}

export interface GammaMarket {
  id: string;
  question: string;
  conditionId: string;
  slug: string;
  outcomes: string;           // JSON string: '["Up", "Down"]'
  outcomePrices: string;      // JSON string: '["0.5", "0.5"]'
  clobTokenIds: string;       // JSON string: '["token1", "token2"]'
  volume: string;
  active: boolean;
  closed: boolean;
}

export interface HourlyMarket {
  eventId: string;
  title: string;
  slug: string;
  endDate: Date;
  conditionId: string;
  upToken: {
    tokenId: string;
    price: number;
  };
  downToken: {
    tokenId: string;
    price: number;
  };
  hoursUntilClose: number;
}

