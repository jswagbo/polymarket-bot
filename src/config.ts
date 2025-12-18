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

// Runtime configuration that can be updated
export class RuntimeConfig {
  private static instance: RuntimeConfig;
  
  betSize: number;
  botEnabled: boolean;
  maxCombinedCost: number;
  minPriceForExpensive: number;
  maxPriceForCheap: number;

  private constructor(config: Config) {
    this.betSize = config.betSize;
    this.botEnabled = config.botEnabled;
    this.maxCombinedCost = 1.05; // Max combined cost for straddle ($1.05)
    this.minPriceForExpensive = 0.50; // Price above which leg is "expensive"
    this.maxPriceForCheap = 0.50; // Price below which leg is "cheap"
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

  update(updates: Partial<Pick<RuntimeConfig, 'betSize' | 'botEnabled' | 'maxCombinedCost'>>) {
    if (updates.betSize !== undefined) this.betSize = updates.betSize;
    if (updates.botEnabled !== undefined) this.botEnabled = updates.botEnabled;
    if (updates.maxCombinedCost !== undefined) this.maxCombinedCost = updates.maxCombinedCost;
  }

  toJSON() {
    return {
      betSize: this.betSize,
      botEnabled: this.botEnabled,
      maxCombinedCost: this.maxCombinedCost,
    };
  }
}

