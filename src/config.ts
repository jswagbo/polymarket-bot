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
  polygonRpcUrl: string;
}

// Polygon Smart Contract Addresses (from Polymarket docs)
export const POLYGON_CONTRACTS = {
  // Main trading contracts
  CTF_EXCHANGE: '0x4bFb41d5B3570DeFd03C39a9A4D8dE6Bd8B8982E',           // Binary YES/NO markets
  NEGRISK_CTF_EXCHANGE: '0xC5d563A36AE78145C45a50134d48A1215220f80a',    // Multi-outcome markets
  
  // Token contracts
  CTF: '0x4D97DCd97eC945f40cF65F87097ACe5EA0476045',                     // Conditional Tokens Framework
  NEGRISK_ADAPTER: '0xd91E80cF2E7be2e162c6513ceD06f1dD0dA35296',         // Multi-outcome adapter
  USDC: '0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174',                    // USDC.e collateral
  
  // Oracle
  UMA_ORACLE: '0x6A9D222616C90FcA5754cd1333cFD9b7fb6a4F74',              // Market resolution oracle
} as const;

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
    betSize: getEnvNumber('BET_SIZE', 90),
    botEnabled: getEnvBool('BOT_ENABLED', false),
    port: getEnvNumber('PORT', 3000),
    nodeEnv: getEnvVar('NODE_ENV', 'development'),
    dataDir: path.join(process.cwd(), 'data'),
    // Polygon RPC - default to public endpoint (rate limited, add your own for production)
    polygonRpcUrl: getEnvVar('POLYGON_RPC_URL', 'https://polygon-rpc.com'),
  };
}

// Supported crypto types (BTC and ETH only)
export type CryptoType = 'BTC' | 'ETH';
export const ALL_CRYPTOS: CryptoType[] = ['BTC', 'ETH'];

// Per-crypto settings
export interface CryptoSettings {
  enabled: boolean;
  betSize: number;
  minPrice: number;  // Minimum price threshold (e.g., 0.80 = 80¢)
}

// Default settings for each crypto
const DEFAULT_CRYPTO_SETTINGS: CryptoSettings = {
  enabled: true,
  betSize: 90,      // $90 default bet
  minPrice: 0.90,   // 90% threshold
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
    
    // Initialize per-crypto settings with defaults ($90 bet, 90% threshold)
    this.cryptoSettings = new Map();
    ALL_CRYPTOS.forEach(crypto => {
      this.cryptoSettings.set(crypto, {
        enabled: true,
        betSize: config.betSize || 90,
        minPrice: 0.90,
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

