/**
 * Settings Manager - Handles loading, saving, and resetting settings
 */

import fs from 'fs';
import path from 'path';
import { BotSettings, FACTORY_DEFAULTS, mergeSettings } from './schema';
import { createLogger } from '../utils/logger';

const logger = createLogger('SettingsManager');

const DATA_DIR = path.join(process.cwd(), 'data');
const SETTINGS_FILE = path.join(DATA_DIR, 'settings.json');

export class SettingsManager {
  private settings: BotSettings;
  private listeners: Array<(settings: BotSettings) => void> = [];

  constructor() {
    this.settings = this.load();
  }

  /**
   * Load settings from file, falling back to factory defaults
   */
  private load(): BotSettings {
    try {
      // Ensure data directory exists
      if (!fs.existsSync(DATA_DIR)) {
        fs.mkdirSync(DATA_DIR, { recursive: true });
        logger.info('Created data directory');
      }

      // Try to load existing settings
      if (fs.existsSync(SETTINGS_FILE)) {
        const data = fs.readFileSync(SETTINGS_FILE, 'utf-8');
        const saved = JSON.parse(data) as Partial<BotSettings>;
        
        // Merge with factory defaults to ensure all fields exist
        const merged = mergeSettings(FACTORY_DEFAULTS, saved);
        logger.info('Loaded settings from file');
        return merged;
      }
    } catch (error: any) {
      logger.warn(`Failed to load settings: ${error.message}, using factory defaults`);
    }

    // Return factory defaults if no saved settings
    logger.info('Using factory default settings');
    return JSON.parse(JSON.stringify(FACTORY_DEFAULTS));
  }

  /**
   * Save current settings to file
   */
  save(): void {
    try {
      if (!fs.existsSync(DATA_DIR)) {
        fs.mkdirSync(DATA_DIR, { recursive: true });
      }
      
      fs.writeFileSync(SETTINGS_FILE, JSON.stringify(this.settings, null, 2));
      logger.info('Settings saved to file');
    } catch (error: any) {
      logger.error(`Failed to save settings: ${error.message}`);
      throw error;
    }
  }

  /**
   * Get all settings
   */
  getAll(): BotSettings {
    return JSON.parse(JSON.stringify(this.settings));
  }

  /**
   * Update settings (partial update)
   */
  update(updates: Partial<BotSettings>): BotSettings {
    this.settings = mergeSettings(this.settings, updates);
    this.save();
    this.notifyListeners();
    return this.getAll();
  }

  /**
   * Reset to factory defaults
   */
  resetToFactory(): BotSettings {
    this.settings = JSON.parse(JSON.stringify(FACTORY_DEFAULTS));
    this.save();
    this.notifyListeners();
    logger.info('Settings reset to factory defaults');
    return this.getAll();
  }

  /**
   * Export settings as JSON string
   */
  export(): string {
    return JSON.stringify(this.settings, null, 2);
  }

  /**
   * Import settings from JSON string
   */
  import(jsonString: string): BotSettings {
    try {
      const imported = JSON.parse(jsonString) as Partial<BotSettings>;
      this.settings = mergeSettings(FACTORY_DEFAULTS, imported);
      this.save();
      this.notifyListeners();
      logger.info('Settings imported successfully');
      return this.getAll();
    } catch (error: any) {
      logger.error(`Failed to import settings: ${error.message}`);
      throw new Error('Invalid settings format');
    }
  }

  /**
   * Subscribe to settings changes
   */
  onChange(listener: (settings: BotSettings) => void): () => void {
    this.listeners.push(listener);
    return () => {
      this.listeners = this.listeners.filter(l => l !== listener);
    };
  }

  /**
   * Notify all listeners of settings change
   */
  private notifyListeners(): void {
    const current = this.getAll();
    this.listeners.forEach(listener => {
      try {
        listener(current);
      } catch (error) {
        logger.error('Settings listener error:', error);
      }
    });
  }

  // ==========================================
  // Convenience getters for specific settings
  // ==========================================

  getCryptoSettings(crypto: 'btc' | 'eth' | 'sol') {
    return this.settings[crypto];
  }

  getTradingWindow() {
    return this.settings.tradingWindow;
  }

  getVolatilitySettings() {
    return this.settings.volatility;
  }

  getStopLossSettings() {
    return this.settings.stopLoss;
  }

  getAutoClaimSettings() {
    return this.settings.autoClaim;
  }

  getAdvancedSettings() {
    return this.settings.advanced;
  }

  isGlobalBotEnabled() {
    return this.settings.globalBotEnabled;
  }
}

// Singleton instance
let instance: SettingsManager | null = null;

export function getSettingsManager(): SettingsManager {
  if (!instance) {
    instance = new SettingsManager();
  }
  return instance;
}

