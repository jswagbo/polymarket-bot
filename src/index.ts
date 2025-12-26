import { loadConfig, RuntimeConfig, ALL_CRYPTOS, CryptoType } from './config';
import { getPolymarketClient } from './polymarket/client';
import { Database } from './db/database';
import { TradingScheduler } from './scheduler';
import { WeatherScheduler } from './weather';
import { createServer } from './api/server';
import { createLogger } from './utils/logger';

const logger = createLogger('Main');

async function main() {
  logger.info('Starting Polymarket Trading Bot...');

  // Load configuration
  const config = loadConfig();
  const runtimeConfig = RuntimeConfig.getInstance(config);

  // Load persisted state
  logger.info('Initializing database...');
  const db = new Database(config.dataDir);

  // Restore persisted global config
  const savedBetSize = db.getState('betSize');
  const savedBotEnabled = db.getState('botEnabled');
  const savedMaxCombinedCost = db.getState('maxCombinedCost');

  if (savedBetSize) runtimeConfig.update({ betSize: parseFloat(savedBetSize) });
  if (savedBotEnabled) runtimeConfig.update({ botEnabled: savedBotEnabled === 'true' });
  if (savedMaxCombinedCost) runtimeConfig.update({ maxCombinedCost: parseFloat(savedMaxCombinedCost) });

  // Restore per-crypto settings
  logger.info('Loading per-crypto settings...');
  for (const crypto of ALL_CRYPTOS) {
    const savedEnabled = db.getState(`crypto_${crypto}_enabled`);
    const savedCryptoBetSize = db.getState(`crypto_${crypto}_betSize`);
    const savedMinPrice = db.getState(`crypto_${crypto}_minPrice`);
    
    if (savedEnabled !== null || savedCryptoBetSize !== null || savedMinPrice !== null) {
      const updates: Partial<{ enabled: boolean; betSize: number; minPrice: number }> = {};
      
      if (savedEnabled !== null) updates.enabled = savedEnabled === 'true';
      if (savedCryptoBetSize !== null) updates.betSize = parseFloat(savedCryptoBetSize);
      if (savedMinPrice !== null) updates.minPrice = parseFloat(savedMinPrice);
      
      runtimeConfig.updateCryptoSettings(crypto, updates);
      logger.info(`Loaded ${crypto} settings: enabled=${updates.enabled}, betSize=${updates.betSize}, minPrice=${updates.minPrice}`);
    }
  }

  // Initialize Polymarket client
  logger.info('Initializing Polymarket client...');
  const client = getPolymarketClient({ privateKey: config.privateKey });
  
  try {
    await client.initialize();
    
    const walletAddress = client.getWalletAddress();
    if (walletAddress) {
      logger.info(`Connected wallet: ${walletAddress}`);
    } else {
      logger.warn('Running in read-only mode - no trading will occur');
    }
  } catch (error) {
    logger.error('Failed to initialize Polymarket client', error);
    logger.warn('Continuing in read-only mode');
  }

  // Create BTC scheduler
  logger.info('Initializing BTC scheduler...');
  const scheduler = new TradingScheduler(client, db, runtimeConfig);

  // Create Weather scheduler
  logger.info('Initializing Weather scheduler...');
  const weatherScheduler = new WeatherScheduler(client, db, runtimeConfig);

  // Start scheduler (runs every 1 second, with 5-second API rate limiting)
  scheduler.start();

  // Create and start API server
  logger.info('Starting API server...');
  const app = createServer(config, db, scheduler, runtimeConfig, weatherScheduler);

  const port = config.port;
  app.listen(port, () => {
    logger.info(`
╔══════════════════════════════════════════════════════════════╗
║           POLYMARKET TRADING BOT STARTED                      ║
╠══════════════════════════════════════════════════════════════╣
║  Dashboard: http://localhost:${port}                            ║
║  API: http://localhost:${port}/api                              ║
╠══════════════════════════════════════════════════════════════╣
║  BTC Bot: ${runtimeConfig.botEnabled ? 'ENABLED ' : 'DISABLED'}                                        ║
║  Weather Bot: READY (manual start)                            ║
║  Bet Size: $${runtimeConfig.betSize}                                             ║
╚══════════════════════════════════════════════════════════════╝
    `);
  });

  // Graceful shutdown
  process.on('SIGINT', () => {
    logger.info('Shutting down...');
    scheduler.stop();
    weatherScheduler.stop();
    db.close();
    process.exit(0);
  });

  process.on('SIGTERM', () => {
    logger.info('Shutting down...');
    scheduler.stop();
    weatherScheduler.stop();
    db.close();
    process.exit(0);
  });
}

main().catch((error) => {
  logger.error('Fatal error', error);
  process.exit(1);
});

