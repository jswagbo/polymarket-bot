import express, { Request, Response, NextFunction } from 'express';
import cors from 'cors';
import path from 'path';
import { Database } from '../db/database';
import { RuntimeConfig, Config } from '../config';
import { TradingScheduler } from '../scheduler';
import { createLogger } from '../utils/logger';
import { ApiResponse, DashboardStats, BotStatus } from '../types';

const logger = createLogger('API');

export function createServer(
  config: Config,
  db: Database,
  scheduler: TradingScheduler,
  runtimeConfig: RuntimeConfig
): express.Application {
  const app = express();
  const startTime = Date.now();

  // Middleware
  app.use(cors());
  app.use(express.json());

  // Serve static files (dashboard) - no cache for development
  app.use(express.static(path.join(__dirname, '../../public'), {
    etag: false,
    maxAge: 0,
    setHeaders: (res) => {
      res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
      res.setHeader('Pragma', 'no-cache');
      res.setHeader('Expires', '0');
    }
  }));

  // Simple auth middleware for API routes
  const authMiddleware = (req: Request, res: Response, next: NextFunction): void => {
    const authHeader = req.headers.authorization;
    
    // Allow dashboard access without auth
    if (req.path === '/' || req.path.startsWith('/assets') || req.path.endsWith('.html') || req.path.endsWith('.css') || req.path.endsWith('.js')) {
      return next();
    }

    // Check password for API routes
    if (authHeader) {
      const [type, credentials] = authHeader.split(' ');
      if (type === 'Basic') {
        const decoded = Buffer.from(credentials, 'base64').toString();
        const [, password] = decoded.split(':');
        if (password === config.dashboardPassword) {
          return next();
        }
      } else if (type === 'Bearer' && credentials === config.dashboardPassword) {
        return next();
      }
    }

    // Check query param for simple auth
    if (req.query.password === config.dashboardPassword) {
      return next();
    }

    res.status(401).json({ success: false, error: 'Unauthorized' });
  };

  // Apply auth to API routes
  app.use('/api', authMiddleware);

  // Health check (no auth required)
  app.get('/health', (req: Request, res: Response) => {
    res.json({ status: 'ok', uptime: Date.now() - startTime });
  });

  // Dashboard stats
  app.get('/api/stats', (req: Request, res: Response) => {
    try {
      const tradeStats = db.getTradeStats();
      const schedulerStatus = scheduler.getStatus();
      const recentTrades = db.getRecentTrades(20);
      const openTrades = db.getOpenTrades();

      // Get client info from the scheduler's client
      const client = (scheduler as any).client as import('../polymarket/client').PolymarketClient;
      const isReadOnly = client?.isReadOnly() ?? true;
      const walletAddress = client?.getWalletAddress() ?? null;
      const initError = client?.getInitError() ?? null;

      const stats = {
        status: {
          enabled: runtimeConfig.botEnabled,
          lastScan: schedulerStatus.lastScanTime,
          activePositions: openTrades.length,
          totalTrades: tradeStats.total,
          totalPnL: tradeStats.totalPnL,
          uptime: Date.now() - startTime,
          isReadOnly,
          walletAddress,
          initError,
        },
        config: runtimeConfig.toJSON(),
        recentTrades,
        activePositions: [], // Would need market prices to calculate positions
      };

      res.json({ success: true, data: stats });
    } catch (error) {
      logger.error('Failed to get stats', error);
      res.status(500).json({ success: false, error: 'Internal server error' });
    }
  });

  // Get configuration
  app.get('/api/config', (req: Request, res: Response) => {
    res.json({ success: true, data: runtimeConfig.toJSON() });
  });

  // Update configuration
  app.post('/api/config', (req: Request, res: Response) => {
    try {
      const { betSize, botEnabled, maxCombinedCost } = req.body;

      if (betSize !== undefined) {
        if (typeof betSize !== 'number' || betSize < 1) {
          res.status(400).json({ success: false, error: 'betSize must be a number >= 1' });
          return;
        }
      }

      runtimeConfig.update({ betSize, botEnabled, maxCombinedCost });
      
      // Persist to database
      db.setState('betSize', String(runtimeConfig.betSize));
      db.setState('botEnabled', String(runtimeConfig.botEnabled));
      db.setState('maxCombinedCost', String(runtimeConfig.maxCombinedCost));

      logger.info('Config updated', runtimeConfig.toJSON());
      res.json({ success: true, data: runtimeConfig.toJSON() });
    } catch (error) {
      logger.error('Failed to update config', error);
      res.status(500).json({ success: false, error: 'Internal server error' });
    }
  });

  // Enable/disable bot
  app.post('/api/bot/toggle', (req: Request, res: Response) => {
    runtimeConfig.update({ botEnabled: !runtimeConfig.botEnabled });
    db.setState('botEnabled', String(runtimeConfig.botEnabled));
    
    logger.info(`Bot ${runtimeConfig.botEnabled ? 'enabled' : 'disabled'}`);
    res.json({ success: true, data: { enabled: runtimeConfig.botEnabled } });
  });

  // Force a scan
  app.post('/api/bot/scan', async (req: Request, res: Response) => {
    try {
      const result = await scheduler.forceScan();
      res.json({ success: true, data: result });
    } catch (error) {
      logger.error('Failed to run scan', error);
      res.status(500).json({ success: false, error: String(error) });
    }
  });

  // Emergency stop
  app.post('/api/bot/stop', (req: Request, res: Response) => {
    runtimeConfig.update({ botEnabled: false });
    db.setState('botEnabled', 'false');
    scheduler.stop();
    
    logger.warn('Emergency stop activated');
    res.json({ success: true, message: 'Bot stopped' });
  });

  // Reset bot (clear all trades)
  app.post('/api/bot/reset', (req: Request, res: Response) => {
    try {
      db.clearAllTrades();
      logger.warn('Bot reset - all trades cleared');
      res.json({ success: true, message: 'All trades cleared' });
    } catch (error) {
      logger.error('Failed to reset bot', error);
      res.status(500).json({ success: false, error: 'Failed to reset' });
    }
  });

  // Setup allowances (approve USDC for trading)
  app.post('/api/bot/approve', async (req: Request, res: Response) => {
    try {
      const client = (scheduler as any).client as import('../polymarket/client').PolymarketClient;
      
      if (client.isReadOnly()) {
        res.status(400).json({ success: false, error: 'Cannot approve in read-only mode' });
        return;
      }

      logger.info('Manually triggering allowance setup...');
      const clobClient = client.getClient();
      await clobClient.setAllowances();
      
      logger.info('Allowances approved successfully');
      res.json({ success: true, message: 'USDC spending approved for Polymarket CLOB' });
    } catch (error: any) {
      logger.error('Failed to set allowances', error);
      res.status(500).json({ success: false, error: error.message || 'Failed to approve' });
    }
  });

  // Get trades
  app.get('/api/trades', (req: Request, res: Response) => {
    try {
      const limit = parseInt(req.query.limit as string) || 50;
      const trades = db.getRecentTrades(limit);
      res.json({ success: true, data: trades });
    } catch (error) {
      logger.error('Failed to get trades', error);
      res.status(500).json({ success: false, error: 'Internal server error' });
    }
  });

  // Get open trades
  app.get('/api/trades/open', (req: Request, res: Response) => {
    try {
      const trades = db.getOpenTrades();
      res.json({ success: true, data: trades });
    } catch (error) {
      logger.error('Failed to get open trades', error);
      res.status(500).json({ success: false, error: 'Internal server error' });
    }
  });

  // Get live markets (last scanned)
  app.get('/api/markets/live', (req: Request, res: Response) => {
    try {
      const liveMarkets = scheduler.getLiveMarkets();
      res.json({ success: true, data: liveMarkets });
    } catch (error) {
      logger.error('Failed to get live markets', error);
      res.status(500).json({ success: false, error: 'Internal server error' });
    }
  });

  // Serve dashboard for all other routes
  app.get('*', (req: Request, res: Response) => {
    res.sendFile(path.join(__dirname, '../../public/index.html'));
  });

  return app;
}

