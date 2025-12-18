import { loadConfig, RuntimeConfig } from './config';
import { getPolymarketClient } from './polymarket/client';
import { Database } from './db/database';
import { TradingScheduler } from './scheduler';
import { createServer } from './api/server';
import { createLogger } from './utils/logger';

const logger = createLogger('Main');

async function main() {
  logger.info('Starting Polymarket Straddle Bot...');

  // Load configuration
  const config = loadConfig();
  const runtimeConfig = RuntimeConfig.getInstance(config);

  // Load persisted state
  logger.info('Initializing database...');
  const db = new Database(config.dataDir);

  // Restore persisted config
  const savedBetSize = db.getState('betSize');
  const savedBotEnabled = db.getState('botEnabled');
  const savedMaxCombinedCost = db.getState('maxCombinedCost');

  if (savedBetSize) runtimeConfig.update({ betSize: parseFloat(savedBetSize) });
  if (savedBotEnabled) runtimeConfig.update({ botEnabled: savedBotEnabled === 'true' });
  if (savedMaxCombinedCost) runtimeConfig.update({ maxCombinedCost: parseFloat(savedMaxCombinedCost) });

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

  // Create scheduler
  logger.info('Initializing scheduler...');
  const scheduler = new TradingScheduler(client, db, runtimeConfig);

  // Start scheduler (runs every 5 minutes)
  scheduler.start('*/5 * * * *');

  // Create and start API server
  logger.info('Starting API server...');
  const app = createServer(config, db, scheduler, runtimeConfig);

  const port = config.port;
  app.listen(port, () => {
    logger.info(`
╔══════════════════════════════════════════════════════════════╗
║           POLYMARKET STRADDLE BOT STARTED                     ║
╠══════════════════════════════════════════════════════════════╣
║  Dashboard: http://localhost:${port}                            ║
║  API: http://localhost:${port}/api                              ║
╠══════════════════════════════════════════════════════════════╣
║  Bot Status: ${runtimeConfig.botEnabled ? 'ENABLED ' : 'DISABLED'}                                     ║
║  Bet Size: $${runtimeConfig.betSize}                                             ║
║  Max Combined Cost: $${runtimeConfig.maxCombinedCost.toFixed(2)}                                 ║
╚══════════════════════════════════════════════════════════════╝
    `);
  });

  // Graceful shutdown
  process.on('SIGINT', () => {
    logger.info('Shutting down...');
    scheduler.stop();
    db.close();
    process.exit(0);
  });

  process.on('SIGTERM', () => {
    logger.info('Shutting down...');
    scheduler.stop();
    db.close();
    process.exit(0);
  });
}

main().catch((error) => {
  logger.error('Fatal error', error);
  process.exit(1);
});

