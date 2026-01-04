/**
 * Settings Schema - All configurable bot settings with defaults
 */

export interface CryptoSettings {
  enabled: boolean;
  betSize: number;
  minPrice: number;  // e.g., 0.90 for 90¢
  maxPrice: number;  // e.g., 0.94 for 94¢
  autoClaimEnabled: boolean;
}

export interface TradingWindowSettings {
  startMinute: number;  // 0-59
  endMinute: number;    // 0-59
}

export interface VolatilitySettings {
  enabled: boolean;
  skipVolatileHours: boolean;
  volatileHoursET: number[];  // e.g., [9, 10, 15, 16]
  checkRealTimeVolatility: boolean;
  maxHourlyVolatilityPercent: number;
  checkSpread: boolean;
  maxSpreadCents: number;
}

export interface StopLossSettings {
  enabled: boolean;
  threshold: number;  // e.g., 0.70 for 70¢
}

export interface AutoClaimSettings {
  enabled: boolean;
  intervalMinutes: number;
  daysBack: number;
}

export interface AutoSellCryptoSettings {
  enabled: boolean;
}

export interface AutoSellSettings {
  enabled: boolean;                    // Master toggle
  runAtMinute: number;                 // Minute of hour to run (default :01)
  sellAllPositions: boolean;           // Sell all regardless of P&L (default true)
  sellInProfitOnly: boolean;           // Only sell positions in profit
  sellInLossOnly: boolean;             // Only sell positions at a loss
  // Per-crypto toggles
  cryptoSettings: {
    BTC: AutoSellCryptoSettings;
    ETH: AutoSellCryptoSettings;
    SOL: AutoSellCryptoSettings;
    XRP: AutoSellCryptoSettings;
  };
}

export interface GasSettings {
  speed: 'safeLow' | 'standard' | 'fast';
}

export interface AdvancedSettings {
  scanIntervalSeconds: number;
  rpcUrl: string;
  gas: GasSettings;
}

export interface BotSettings {
  // Per-crypto settings
  btc: CryptoSettings;
  eth: CryptoSettings;
  sol: CryptoSettings;
  xrp: CryptoSettings;
  
  // Trading window
  tradingWindow: TradingWindowSettings;
  
  // Volatility filter
  volatility: VolatilitySettings;
  
  // Stop-loss
  stopLoss: StopLossSettings;
  
  // Auto-claim
  autoClaim: AutoClaimSettings;
  
  // Auto-sell (runs every hour on the hour)
  autoSell: AutoSellSettings;
  
  // Advanced
  advanced: AdvancedSettings;
  
  // Global
  globalBotEnabled: boolean;
}

/**
 * Factory defaults - these are the "out of box" settings
 */
export const FACTORY_DEFAULTS: BotSettings = {
  // BTC - enabled by default
  btc: {
    enabled: true,
    betSize: 90,
    minPrice: 0.90,
    maxPrice: 0.94,
    autoClaimEnabled: true,
  },
  
  // ETH - disabled by default
  eth: {
    enabled: false,
    betSize: 90,
    minPrice: 0.90,
    maxPrice: 0.94,
    autoClaimEnabled: false,
  },
  
  // SOL - disabled by default
  sol: {
    enabled: false,
    betSize: 90,
    minPrice: 0.90,
    maxPrice: 0.94,
    autoClaimEnabled: false,
  },
  
  // XRP - disabled by default (15-minute markets)
  xrp: {
    enabled: false,
    betSize: 90,
    minPrice: 0.90,
    maxPrice: 0.94,
    autoClaimEnabled: false,
  },
  
  // Trading window: minutes 45-59
  tradingWindow: {
    startMinute: 45,
    endMinute: 59,
  },
  
  // Volatility filter - OFF by default
  volatility: {
    enabled: false,
    skipVolatileHours: false,
    volatileHoursET: [9, 10, 15, 16],
    checkRealTimeVolatility: false,
    maxHourlyVolatilityPercent: 2.0,
    checkSpread: false,
    maxSpreadCents: 5,
  },
  
  // Stop-loss - ON by default at 70¢
  stopLoss: {
    enabled: true,
    threshold: 0.70,
  },
  
  // Auto-claim - ON by default
  autoClaim: {
    enabled: true,
    intervalMinutes: 60,  // Check every hour
    daysBack: 7,
  },
  
  // Auto-sell - OFF by default, runs at :01 of each hour
  autoSell: {
    enabled: false,
    runAtMinute: 1,  // Run at :01 of every hour
    sellAllPositions: true,   // Default ON - sell all regardless of P&L
    sellInProfitOnly: false,  // Default OFF
    sellInLossOnly: false,    // Default OFF
    cryptoSettings: {
      BTC: { enabled: true },
      ETH: { enabled: true },
      SOL: { enabled: true },
      XRP: { enabled: true },
    },
  },
  
  // Advanced settings
  advanced: {
    scanIntervalSeconds: 5,
    rpcUrl: '',  // Empty = use default RPCs
    gas: {
      speed: 'standard',
    },
  },
  
  // Global bot enabled
  globalBotEnabled: false,  // Start disabled for safety
};

/**
 * Deep merge two settings objects
 */
export function mergeSettings(base: BotSettings, overrides: Partial<BotSettings>): BotSettings {
  const result = JSON.parse(JSON.stringify(base)) as BotSettings;
  
  if (overrides.btc) Object.assign(result.btc, overrides.btc);
  if (overrides.eth) Object.assign(result.eth, overrides.eth);
  if (overrides.sol) Object.assign(result.sol, overrides.sol);
  if (overrides.xrp) Object.assign(result.xrp, overrides.xrp);
  if (overrides.tradingWindow) Object.assign(result.tradingWindow, overrides.tradingWindow);
  if (overrides.volatility) Object.assign(result.volatility, overrides.volatility);
  if (overrides.stopLoss) Object.assign(result.stopLoss, overrides.stopLoss);
  if (overrides.autoClaim) Object.assign(result.autoClaim, overrides.autoClaim);
  if (overrides.autoSell) {
    Object.assign(result.autoSell, overrides.autoSell);
    if (overrides.autoSell.cryptoSettings) {
      Object.assign(result.autoSell.cryptoSettings, overrides.autoSell.cryptoSettings);
    }
  }
  if (overrides.advanced) {
    Object.assign(result.advanced, overrides.advanced);
    if (overrides.advanced.gas) Object.assign(result.advanced.gas, overrides.advanced.gas);
  }
  if (overrides.globalBotEnabled !== undefined) result.globalBotEnabled = overrides.globalBotEnabled;
  
  return result;
}

