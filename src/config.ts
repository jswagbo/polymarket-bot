import dotenv from 'dotenv';
import path from 'path';

// Load environment variables
dotenv.config();

export interface Config {
  privateKey: string;
  dashboardPassword: string;
  betSize: number;
  botEnabled: boolean;
  port: number;
  nodeEnv: string;
  dataDir: string;
}

function getEnvVar(name: string, defaultValue?: string): string {
  const value = process.env[name] || defaultValue;
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

function getEnvNumber(name: string, defaultValue: number): number {
  const value = process.env[name];
  if (!value) return defaultValue;
  const num = parseFloat(value);
  if (isNaN(num)) {
    throw new Error(`Environment variable ${name} must be a number`);
  }
  return num;
}

function getEnvBool(name: string, defaultValue: boolean): boolean {
  const value = process.env[name];
  if (!value) return defaultValue;
  return value.toLowerCase() === 'true' || value === '1';
}

export function loadConfig(): Config {
  return {
    privateKey: getEnvVar('PRIVATE_KEY', ''),
    dashboardPassword: getEnvVar('DASHBOARD_PASSWORD', 'changeme'),
    betSize: getEnvNumber('BET_SIZE', 10),
    botEnabled: getEnvBool('BOT_ENABLED', false),
    port: getEnvNumber('PORT', 3000),
    nodeEnv: getEnvVar('NODE_ENV', 'development'),
    dataDir: path.join(process.cwd(), 'data'),
  };
}

// Supported crypto types
export type CryptoType = 'BTC' | 'ETH' | 'XRP' | 'SOL';
export const ALL_CRYPTOS: CryptoType[] = ['BTC', 'ETH', 'XRP', 'SOL'];

// Per-crypto settings
export interface CryptoSettings {
  enabled: boolean;
  betSize: number;
  minPrice: number;  // Minimum price threshold (e.g., 0.80 = 80¢)
}

// Default settings for each crypto
const DEFAULT_CRYPTO_SETTINGS: CryptoSettings = {
  enabled: true,
  betSize: 10,
  minPrice: 0.80,  // 80¢ threshold
};

// Runtime configuration that can be updated
export class RuntimeConfig {
  private static instance: RuntimeConfig;
  
  // Global settings
  botEnabled: boolean;
  maxCombinedCost: number;
  
  // Per-crypto settings
  private cryptoSettings: Map<CryptoType, CryptoSettings>;

  // Legacy fields for backwards compatibility
  get betSize(): number {
    return this.getCryptoSettings('BTC').betSize;
  }
  set betSize(value: number) {
    // Update all cryptos when setting legacy betSize
    ALL_CRYPTOS.forEach(crypto => {
      const settings = this.cryptoSettings.get(crypto)!;
      settings.betSize = value;
    });
  }

  private constructor(config: Config) {
    this.botEnabled = config.botEnabled;
    this.maxCombinedCost = 1.05;
    
    // Initialize per-crypto settings with defaults
    this.cryptoSettings = new Map();
    ALL_CRYPTOS.forEach(crypto => {
      this.cryptoSettings.set(crypto, {
        enabled: true,
        betSize: config.betSize,
        minPrice: 0.80,
      });
    });
  }

  static getInstance(config?: Config): RuntimeConfig {
    if (!RuntimeConfig.instance) {
      if (!config) {
        config = loadConfig();
      }
      RuntimeConfig.instance = new RuntimeConfig(config);
    }
    return RuntimeConfig.instance;
  }

  // Get settings for a specific crypto
  getCryptoSettings(crypto: CryptoType): CryptoSettings {
    return this.cryptoSettings.get(crypto) || { ...DEFAULT_CRYPTO_SETTINGS };
  }

  // Update settings for a specific crypto
  updateCryptoSettings(crypto: CryptoType, updates: Partial<CryptoSettings>) {
    const current = this.cryptoSettings.get(crypto) || { ...DEFAULT_CRYPTO_SETTINGS };
    if (updates.enabled !== undefined) current.enabled = updates.enabled;
    if (updates.betSize !== undefined) current.betSize = updates.betSize;
    if (updates.minPrice !== undefined) current.minPrice = updates.minPrice;
    this.cryptoSettings.set(crypto, current);
  }

  // Check if a specific crypto is enabled (individual OR global)
  // Global toggle acts as master switch, but individual cryptos can be enabled independently
  isCryptoEnabled(crypto: CryptoType): boolean {
    return this.getCryptoSettings(crypto).enabled || this.botEnabled;
  }

  // Get the minimum price threshold for a crypto
  getCryptoMinPrice(crypto: CryptoType): number {
    return this.getCryptoSettings(crypto).minPrice;
  }

  // Get the bet size for a crypto
  getCryptoBetSize(crypto: CryptoType): number {
    return this.getCryptoSettings(crypto).betSize;
  }

  // Legacy update method for backwards compatibility
  update(updates: Partial<Pick<RuntimeConfig, 'betSize' | 'botEnabled' | 'maxCombinedCost'>>) {
    if (updates.betSize !== undefined) this.betSize = updates.betSize;
    if (updates.botEnabled !== undefined) this.botEnabled = updates.botEnabled;
    if (updates.maxCombinedCost !== undefined) this.maxCombinedCost = updates.maxCombinedCost;
  }

  toJSON() {
    const cryptoConfigs: Record<string, CryptoSettings> = {};
    ALL_CRYPTOS.forEach(crypto => {
      cryptoConfigs[crypto] = this.getCryptoSettings(crypto);
    });
    
    return {
      botEnabled: this.botEnabled,
      maxCombinedCost: this.maxCombinedCost,
      cryptoSettings: cryptoConfigs,
      // Legacy fields
      betSize: this.betSize,
    };
  }
}

