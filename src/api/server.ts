import express, { Request, Response, NextFunction } from 'express';
import cors from 'cors';
import path from 'path';
import { Database } from '../db/database';
import { RuntimeConfig, Config, CryptoType as ConfigCryptoType, ALL_CRYPTOS } from '../config';
import { TradingScheduler, SUPPORTED_CRYPTOS } from '../scheduler';
import { createLogger } from '../utils/logger';
import { ApiResponse, DashboardStats, BotStatus } from '../types';
import { CryptoType, CRYPTO_DISPLAY_NAMES } from '../polymarket/client';
import { getBlockchainVerifier, BlockchainVerifier } from '../blockchain/verifier';

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

    // Check query param for simple auth (supports both 'password' and 'auth')
    if (req.query.password === config.dashboardPassword || req.query.auth === config.dashboardPassword) {
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

  // Enable/disable bot (global toggle)
  app.post('/api/bot/toggle', (req: Request, res: Response) => {
    runtimeConfig.update({ botEnabled: !runtimeConfig.botEnabled });
    db.setState('botEnabled', String(runtimeConfig.botEnabled));
    
    logger.info(`Bot ${runtimeConfig.botEnabled ? 'enabled' : 'disabled'}`);
    res.json({ success: true, data: { enabled: runtimeConfig.botEnabled } });
  });

  // ============================================
  // PER-CRYPTO SETTINGS ENDPOINTS
  // ============================================

  // Get settings for a specific crypto
  app.get('/api/crypto/:crypto/settings', (req: Request, res: Response) => {
    try {
      const crypto = req.params.crypto.toUpperCase() as ConfigCryptoType;
      
      if (!ALL_CRYPTOS.includes(crypto)) {
        res.status(400).json({ 
          success: false, 
          error: `Invalid crypto: ${crypto}. Supported: ${ALL_CRYPTOS.join(', ')}` 
        });
        return;
      }
      
      const settings = runtimeConfig.getCryptoSettings(crypto);
      res.json({ success: true, data: { crypto, ...settings } });
    } catch (error) {
      logger.error('Failed to get crypto settings', error);
      res.status(500).json({ success: false, error: 'Internal server error' });
    }
  });

  // Update settings for a specific crypto
  app.post('/api/crypto/:crypto/settings', (req: Request, res: Response) => {
    try {
      const crypto = req.params.crypto.toUpperCase() as ConfigCryptoType;
      
      if (!ALL_CRYPTOS.includes(crypto)) {
        res.status(400).json({ 
          success: false, 
          error: `Invalid crypto: ${crypto}. Supported: ${ALL_CRYPTOS.join(', ')}` 
        });
        return;
      }
      
      const { enabled, betSize, minPrice } = req.body;
      
      // Validate inputs
      if (betSize !== undefined && (typeof betSize !== 'number' || betSize < 1)) {
        res.status(400).json({ success: false, error: 'betSize must be a number >= 1' });
        return;
      }
      
      if (minPrice !== undefined && (typeof minPrice !== 'number' || minPrice < 0.5 || minPrice > 0.99)) {
        res.status(400).json({ success: false, error: 'minPrice must be between 0.50 and 0.99' });
        return;
      }
      
      // Update settings
      runtimeConfig.updateCryptoSettings(crypto, { enabled, betSize, minPrice });
      
      // Persist to database
      const newSettings = runtimeConfig.getCryptoSettings(crypto);
      db.setState(`crypto_${crypto}_enabled`, String(newSettings.enabled));
      db.setState(`crypto_${crypto}_betSize`, String(newSettings.betSize));
      db.setState(`crypto_${crypto}_minPrice`, String(newSettings.minPrice));
      
      logger.info(`${crypto} settings updated:`, newSettings);
      res.json({ success: true, data: { crypto, ...newSettings } });
    } catch (error) {
      logger.error('Failed to update crypto settings', error);
      res.status(500).json({ success: false, error: 'Internal server error' });
    }
  });

  // Toggle a specific crypto on/off
  app.post('/api/crypto/:crypto/toggle', (req: Request, res: Response) => {
    try {
      const crypto = req.params.crypto.toUpperCase() as ConfigCryptoType;
      
      if (!ALL_CRYPTOS.includes(crypto)) {
        res.status(400).json({ 
          success: false, 
          error: `Invalid crypto: ${crypto}. Supported: ${ALL_CRYPTOS.join(', ')}` 
        });
        return;
      }
      
      const currentSettings = runtimeConfig.getCryptoSettings(crypto);
      const newEnabled = !currentSettings.enabled;
      
      runtimeConfig.updateCryptoSettings(crypto, { enabled: newEnabled });
      db.setState(`crypto_${crypto}_enabled`, String(newEnabled));
      
      logger.info(`${crypto} ${newEnabled ? 'enabled' : 'disabled'}`);
      res.json({ success: true, data: { crypto, enabled: newEnabled } });
    } catch (error) {
      logger.error('Failed to toggle crypto', error);
      res.status(500).json({ success: false, error: 'Internal server error' });
    }
  });

  // Get all crypto settings at once
  app.get('/api/crypto/all-settings', (req: Request, res: Response) => {
    try {
      const allSettings: Record<string, any> = {};
      
      for (const crypto of ALL_CRYPTOS) {
        const settings = runtimeConfig.getCryptoSettings(crypto);
        allSettings[crypto] = {
          ...settings,
          displayName: CRYPTO_DISPLAY_NAMES[crypto as CryptoType],
        };
      }
      
      res.json({ 
        success: true, 
        data: {
          globalEnabled: runtimeConfig.botEnabled,
          cryptos: allSettings,
        }
      });
    } catch (error) {
      logger.error('Failed to get all crypto settings', error);
      res.status(500).json({ success: false, error: 'Internal server error' });
    }
  });

  // Force a scan (all cryptos)
  app.post('/api/bot/scan', async (req: Request, res: Response) => {
    try {
      const result = await scheduler.forceScan();
      res.json({ success: true, data: result });
    } catch (error) {
      logger.error('Failed to run scan', error);
      res.status(500).json({ success: false, error: String(error) });
    }
  });

  // Force a scan for a specific crypto
  app.post('/api/bot/scan/:crypto', async (req: Request, res: Response) => {
    try {
      const crypto = req.params.crypto.toUpperCase() as CryptoType;
      logger.info(`Force scan requested for: ${crypto}`);
      
      if (!SUPPORTED_CRYPTOS.includes(crypto)) {
        logger.warn(`Invalid crypto requested: ${crypto}`);
        res.status(400).json({ 
          success: false, 
          error: `Invalid crypto: ${crypto}. Supported: ${SUPPORTED_CRYPTOS.join(', ')}` 
        });
        return;
      }
      
      logger.info(`Starting force scan for ${crypto}...`);
      
      const result = await scheduler.forceScan(crypto);
      logger.info(`Force scan complete for ${crypto}: ${JSON.stringify(result)}`);
      res.json({ success: true, data: result, crypto });
    } catch (error: any) {
      // Ensure we always have a useful error message
      const errorMessage = error?.message || error?.toString?.() || JSON.stringify(error) || 'Unknown error occurred';
      const errorStack = error?.stack || 'No stack trace available';
      
      logger.error(`Failed to run scan for ${req.params.crypto}: ${errorMessage}`);
      logger.error(`Error type: ${error?.constructor?.name || typeof error}`);
      logger.error(`Stack: ${errorStack}`);
      
      res.status(500).json({ 
        success: false, 
        error: errorMessage,
        errorType: error?.constructor?.name || typeof error
      });
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
  // Runs in background since blockchain txs take time
  app.post('/api/bot/approve', async (req: Request, res: Response) => {
    try {
      const client = (scheduler as any).client as import('../polymarket/client').PolymarketClient;
      
      if (client.isReadOnly()) {
        res.status(400).json({ success: false, error: 'Cannot approve in read-only mode' });
        return;
      }

      logger.info('Starting USDC approval (runs in background)...');
      
      // Start approval in background - don't await
      client.approveUsdcSpending()
        .then(() => logger.info('✅ USDC approval completed successfully!'))
        .catch((err: any) => logger.error('❌ USDC approval failed:', err.message || err));
      
      // Return immediately
      res.json({ 
        success: true, 
        message: 'USDC approval started! Check Railway logs for progress. This may take 30-60 seconds.' 
      });
    } catch (error: any) {
      logger.error('Failed to start USDC approval', error);
      res.status(500).json({ success: false, error: error.message || 'Failed to start approval' });
    }
  });

  // Approve CTF for selling positions
  app.post('/api/bot/approve-sell', async (req: Request, res: Response) => {
    try {
      const client = (scheduler as any).client as import('../polymarket/client').PolymarketClient;
      
      if (client.isReadOnly()) {
        res.status(400).json({ success: false, error: 'Cannot approve in read-only mode' });
        return;
      }

      logger.info('Starting CTF approval for selling (runs in background)...');
      
      // Start approval in background
      client.approveCTFForSelling()
        .then(() => logger.info('✅ CTF approval completed! You can now sell positions.'))
        .catch((err: any) => logger.error('❌ CTF approval failed:', err.message || err));
      
      res.json({ 
        success: true, 
        message: 'CTF approval started! Check Railway logs for progress. This allows selling positions.' 
      });
    } catch (error: any) {
      logger.error('Failed to start CTF approval', error);
      res.status(500).json({ success: false, error: error.message || 'Failed to start approval' });
    }
  });

  // Check USDC status (balance and allowances for both USDC types)
  app.get('/api/bot/usdc-status', async (req: Request, res: Response) => {
    try {
      const client = (scheduler as any).client as import('../polymarket/client').PolymarketClient;
      
      if (client.isReadOnly()) {
        res.status(400).json({ success: false, error: 'No wallet configured' });
        return;
      }

      const status = await client.checkUsdcStatus();
      
      // Format for easy display
      const formatted = {
        ...status,
        summary: `Total: ${status.total} USDC (USDC.e: ${status.usdcE.balance}, Native: ${status.usdcNative.balance})`
      };
      
      res.json({ success: true, data: formatted });
    } catch (error: any) {
      logger.error('Failed to check USDC status', error);
      res.status(500).json({ success: false, error: error.message || 'Failed to check status' });
    }
  });

  // Get user's positions
  app.get('/api/positions', async (req: Request, res: Response) => {
    try {
      const client = (scheduler as any).client as import('../polymarket/client').PolymarketClient;
      
      if (client.isReadOnly()) {
        res.status(400).json({ success: false, error: 'No wallet configured' });
        return;
      }

      const positions = await client.getPositions();
      res.json({ success: true, data: positions });
    } catch (error: any) {
      logger.error('Failed to get positions', error);
      res.status(500).json({ success: false, error: error.message || 'Failed to get positions' });
    }
  });

  // Get claimable (winning) positions
  app.get('/api/positions/claimable', async (req: Request, res: Response) => {
    try {
      const client = (scheduler as any).client as import('../polymarket/client').PolymarketClient;
      
      if (client.isReadOnly()) {
        res.status(400).json({ success: false, error: 'No wallet configured' });
        return;
      }

      const claimable = await client.getClaimablePositions();
      res.json({ success: true, data: claimable });
    } catch (error: any) {
      logger.error('Failed to get claimable positions', error);
      res.status(500).json({ success: false, error: error.message || 'Failed to get claimable positions' });
    }
  });

  // Claim all winnings
  app.post('/api/positions/claim', async (req: Request, res: Response) => {
    try {
      const client = (scheduler as any).client as import('../polymarket/client').PolymarketClient;
      
      if (client.isReadOnly()) {
        res.status(400).json({ success: false, error: 'No wallet configured' });
        return;
      }

      logger.info('Starting claim all winnings...');
      
      // Run in background
      client.claimAllWinnings()
        .then((result) => logger.info(`✅ Claim complete: ${result.success} succeeded, ${result.failed} failed`))
        .catch((err: any) => logger.error('❌ Claim failed:', err.message || err));
      
      res.json({ 
        success: true, 
        message: 'Claim started! Check Railway logs for progress.' 
      });
    } catch (error: any) {
      logger.error('Failed to start claim', error);
      res.status(500).json({ success: false, error: error.message || 'Failed to start claim' });
    }
  });

  // Manual claim by condition ID
  app.post('/api/positions/claim/:conditionId', async (req: Request, res: Response) => {
    try {
      const client = (scheduler as any).client as import('../polymarket/client').PolymarketClient;
      const { conditionId } = req.params;
      const { negRisk } = req.body;
      
      if (client.isReadOnly()) {
        res.status(400).json({ success: false, error: 'No wallet configured' });
        return;
      }

      if (!conditionId) {
        res.status(400).json({ success: false, error: 'Condition ID required' });
        return;
      }

      logger.info(`Manual claim requested for condition: ${conditionId}`);
      
      // Run claim in background
      client.redeemPosition(conditionId, negRisk === true)
        .then((txHash) => logger.info(`✅ Manual claim successful! TX: ${txHash}`))
        .catch((err: any) => logger.error(`❌ Manual claim failed: ${err.message || err}`));
      
      res.json({ 
        success: true, 
        message: `Claim started for ${conditionId}! Check Railway logs for progress.` 
      });
    } catch (error: any) {
      logger.error('Failed to start manual claim', error);
      res.status(500).json({ success: false, error: error.message || 'Failed to start claim' });
    }
  });

  // Claim all resolved hourly crypto positions (brute force)
  app.post('/api/positions/claim-all-hourly', async (req: Request, res: Response) => {
    try {
      const client = (scheduler as any).client as import('../polymarket/client').PolymarketClient;
      const { daysBack = 7 } = req.body;
      
      if (client.isReadOnly()) {
        res.status(400).json({ success: false, error: 'No wallet configured' });
        return;
      }

      logger.info(`🔄 Starting claim of all resolved hourly markets (last ${daysBack} days)...`);
      
      // Run in background
      client.claimAllResolvedHourly(daysBack)
        .then((result) => {
          logger.info(`🎉 Bulk claim complete!`);
          logger.info(`   Attempted: ${result.attempted}`);
          logger.info(`   Success: ${result.success}`);
          logger.info(`   Skipped: ${result.skipped}`);
          logger.info(`   Failed: ${result.failed}`);
        })
        .catch((err: any) => logger.error('❌ Bulk claim failed:', err.message || err));
      
      res.json({ 
        success: true, 
        message: `Bulk claim started for last ${daysBack} days! This will attempt to claim ALL resolved hourly crypto markets. Check Railway logs for progress.` 
      });
    } catch (error: any) {
      logger.error('Failed to start bulk claim', error);
      res.status(500).json({ success: false, error: error.message || 'Failed to start bulk claim' });
    }
  });

  // Cash out all positions (market sell)
  app.post('/api/positions/cashout', async (req: Request, res: Response) => {
    try {
      const client = (scheduler as any).client as import('../polymarket/client').PolymarketClient;
      
      if (client.isReadOnly()) {
        res.status(400).json({ success: false, error: 'No wallet configured' });
        return;
      }

      logger.info('💸 Starting cash out of all positions...');
      
      // Run in background
      client.cashOutAllPositions()
        .then((result) => {
          logger.info(`💸 Cash out complete: ${result.success} sold, ${result.failed} failed`);
          result.results.forEach((r: any) => {
            if (r.success) {
              logger.info(`  ✅ Sold ${r.size} shares of ${r.tokenId.substring(0, 15)}...`);
            } else {
              logger.warn(`  ❌ Failed to sell ${r.tokenId.substring(0, 15)}...: ${r.error}`);
            }
          });
        })
        .catch((err: any) => logger.error('❌ Cash out failed:', err.message || err));
      
      res.json({ 
        success: true, 
        message: 'Cash out started! Check Railway logs for progress.' 
      });
    } catch (error: any) {
      logger.error('Failed to start cash out', error);
      res.status(500).json({ success: false, error: error.message || 'Failed to start cash out' });
    }
  });

  // Get analytics
  app.get('/api/analytics', (req: Request, res: Response) => {
    try {
      const analytics = db.getAnalytics();
      res.json({ success: true, data: analytics });
    } catch (error) {
      logger.error('Failed to get analytics', error);
      res.status(500).json({ success: false, error: 'Internal server error' });
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

  // Export trades as CSV
  app.get('/api/trades/export', (req: Request, res: Response) => {
    try {
      const trades = db.getAllTrades();
      
      // CSV header
      const headers = [
        'ID',
        'Date',
        'Time (UTC)',
        'Market',
        'Type',
        'Side',
        'Entry Price',
        'Exit Price',
        'Resolved Price',
        'UP Price',
        'DOWN Price',
        'UP Size',
        'DOWN Size',
        'Combined Cost',
        'Status',
        'P&L',
        'Resolved At'
      ];
      
      // Convert trades to CSV rows
      const rows = trades.map(trade => {
        const createdAt = new Date(trade.created_at);
        const resolvedAt = trade.resolved_at ? new Date(trade.resolved_at) : null;
        
        // Entry price is the price we bought at
        const entryPrice = trade.side === 'up' ? trade.up_price : trade.side === 'down' ? trade.down_price : (trade.up_price + trade.down_price) / 2;
        
        // Exit price: price when manually sold/cashed out
        const exitPrice = trade.exit_price;
        
        // Resolved price: 1.00 if won, 0.00 if lost (stored in resolved_price field)
        const resolvedPrice = trade.resolved_price;
        
        return [
          trade.id,
          createdAt.toISOString().split('T')[0],
          createdAt.toISOString().split('T')[1].replace('Z', ''),
          `"${(trade.market_question || trade.market_id).replace(/"/g, '""')}"`,
          trade.trade_type || 'single_leg',
          trade.side?.toUpperCase() || 'N/A',
          entryPrice?.toFixed(4) || '',
          exitPrice !== null && exitPrice !== undefined ? exitPrice.toFixed(4) : '',
          resolvedPrice !== null && resolvedPrice !== undefined ? resolvedPrice.toFixed(2) : '',
          trade.up_price?.toFixed(4) || '',
          trade.down_price?.toFixed(4) || '',
          trade.up_size?.toFixed(2) || '',
          trade.down_size?.toFixed(2) || '',
          trade.combined_cost?.toFixed(2) || '',
          trade.status,
          trade.pnl?.toFixed(2) || '',
          resolvedAt ? resolvedAt.toISOString() : ''
        ].join(',');
      });
      
      const csv = [headers.join(','), ...rows].join('\n');
      
      // Set headers for file download
      const filename = `polymarket-trades-${new Date().toISOString().split('T')[0]}.csv`;
      res.setHeader('Content-Type', 'text/csv');
      res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
      res.send(csv);
      
      logger.info(`Exported ${trades.length} trades to CSV`);
    } catch (error) {
      logger.error('Failed to export trades', error);
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

  // Get live markets (last scanned) - all cryptos
  app.get('/api/markets/live', (req: Request, res: Response) => {
    try {
      const liveMarkets = scheduler.getLiveMarkets();
      res.json({ success: true, data: liveMarkets });
    } catch (error) {
      logger.error('Failed to get live markets', error);
      res.status(500).json({ success: false, error: 'Internal server error' });
    }
  });

  // Get live markets for a specific crypto
  app.get('/api/markets/live/:crypto', (req: Request, res: Response) => {
    try {
      const crypto = req.params.crypto.toUpperCase() as CryptoType;
      
      if (!SUPPORTED_CRYPTOS.includes(crypto)) {
        res.status(400).json({ 
          success: false, 
          error: `Invalid crypto: ${crypto}. Supported: ${SUPPORTED_CRYPTOS.join(', ')}` 
        });
        return;
      }
      
      const liveMarkets = scheduler.getLiveMarkets(crypto);
      res.json({ success: true, data: liveMarkets, crypto });
    } catch (error) {
      logger.error('Failed to get live markets', error);
      res.status(500).json({ success: false, error: 'Internal server error' });
    }
  });

  // Get all live markets organized by crypto
  app.get('/api/markets/live-all', (req: Request, res: Response) => {
    try {
      const allMarkets = scheduler.getAllLiveMarketsByCrypto();
      res.json({ 
        success: true, 
        data: allMarkets,
        supportedCryptos: SUPPORTED_CRYPTOS.map(c => ({
          symbol: c,
          name: CRYPTO_DISPLAY_NAMES[c],
        }))
      });
    } catch (error) {
      logger.error('Failed to get all live markets', error);
      res.status(500).json({ success: false, error: 'Internal server error' });
    }
  });

  // ==========================================
  // BLOCKCHAIN VERIFICATION ENDPOINTS
  // ==========================================

  // Initialize blockchain verifier (lazy)
  let blockchainVerifier: BlockchainVerifier | null = null;
  const getVerifier = () => {
    if (!blockchainVerifier) {
      blockchainVerifier = getBlockchainVerifier(config.polygonRpcUrl);
    }
    return blockchainVerifier;
  };

  // Get blockchain connection status
  app.get('/api/blockchain/status', async (req: Request, res: Response) => {
    try {
      const verifier = getVerifier();
      const connected = await verifier.connect();
      const blockInfo = await verifier.getBlockInfo();
      
      res.json({
        success: true,
        data: {
          connected,
          network: 'Polygon',
          chainId: 137,
          rpcUrl: config.polygonRpcUrl.replace(/\/\/.*@/, '//***@'), // Hide credentials
          currentBlock: blockInfo?.blockNumber || null,
          blockTimestamp: blockInfo?.timestamp || null,
        }
      });
    } catch (error: any) {
      logger.error('Failed to get blockchain status', error);
      res.status(500).json({ success: false, error: error.message || 'Connection failed' });
    }
  });

  // Verify a trade by transaction hash
  app.get('/api/blockchain/verify/:txHash', async (req: Request, res: Response) => {
    try {
      const { txHash } = req.params;
      
      if (!txHash || !txHash.startsWith('0x')) {
        res.status(400).json({ success: false, error: 'Invalid transaction hash' });
        return;
      }
      
      const verifier = getVerifier();
      await verifier.connect();
      
      const verification = await verifier.verifyTrade(txHash);
      
      if (!verification) {
        res.status(404).json({ success: false, error: 'Transaction not found' });
        return;
      }
      
      res.json({ success: true, data: verification });
    } catch (error: any) {
      logger.error('Failed to verify trade', error);
      res.status(500).json({ success: false, error: error.message || 'Verification failed' });
    }
  });

  // Verify and update a trade's on-chain data
  app.post('/api/blockchain/verify-trade/:tradeId', async (req: Request, res: Response) => {
    try {
      const { tradeId } = req.params;
      const { txHash } = req.body;
      
      // Get the trade
      const trade = db.getTrade(tradeId);
      if (!trade) {
        res.status(404).json({ success: false, error: 'Trade not found' });
        return;
      }
      
      if (!txHash || !txHash.startsWith('0x')) {
        res.status(400).json({ success: false, error: 'Invalid transaction hash' });
        return;
      }
      
      const verifier = getVerifier();
      await verifier.connect();
      
      const verification = await verifier.verifyTrade(txHash);
      
      if (!verification || !verification.verified) {
        res.status(404).json({ success: false, error: 'Could not verify transaction' });
        return;
      }
      
      // Update trade with verified data
      db.updateTradeOnChainData(tradeId, {
        exitPrice: verification.fillPrice,
      });
      
      const updatedTrade = db.getTrade(tradeId);
      
      res.json({
        success: true,
        data: {
          trade: updatedTrade,
          verification,
        }
      });
    } catch (error: any) {
      logger.error('Failed to verify and update trade', error);
      res.status(500).json({ success: false, error: error.message || 'Verification failed' });
    }
  });

  // Check market resolution status
  app.get('/api/blockchain/resolution/:conditionId', async (req: Request, res: Response) => {
    try {
      const { conditionId } = req.params;
      
      const verifier = getVerifier();
      await verifier.connect();
      
      const resolution = await verifier.checkMarketResolution(conditionId);
      
      res.json({ success: true, data: resolution });
    } catch (error: any) {
      logger.error('Failed to check market resolution', error);
      res.status(500).json({ success: false, error: error.message || 'Resolution check failed' });
    }
  });

  // Update trade with resolved price (after market settlement)
  app.post('/api/blockchain/resolve-trade/:tradeId', async (req: Request, res: Response) => {
    try {
      const { tradeId } = req.params;
      const { won } = req.body; // Manual override: true if won, false if lost
      
      const trade = db.getTrade(tradeId);
      if (!trade) {
        res.status(404).json({ success: false, error: 'Trade not found' });
        return;
      }
      
      // Resolved price is 1.00 if won, 0.00 if lost
      const resolvedPrice = won ? 1.00 : 0.00;
      
      // Calculate P&L
      const entryPrice = trade.side === 'up' ? trade.up_price : trade.down_price;
      const size = trade.side === 'up' ? trade.up_size : trade.down_size;
      const pnl = won 
        ? (resolvedPrice - entryPrice) * size  // Won: profit is (1 - entry) * shares
        : -entryPrice * size;                   // Lost: loss is entry * shares
      
      db.updateTradeOnChainData(tradeId, {
        resolvedPrice,
        pnl,
        status: 'resolved',
      });
      
      const updatedTrade = db.getTrade(tradeId);
      
      logger.info(`Trade ${tradeId} resolved: ${won ? 'WON' : 'LOST'}, P&L: $${pnl.toFixed(2)}`);
      
      res.json({
        success: true,
        data: {
          trade: updatedTrade,
          resolved: true,
          won,
          pnl,
        }
      });
    } catch (error: any) {
      logger.error('Failed to resolve trade', error);
      res.status(500).json({ success: false, error: error.message || 'Resolution failed' });
    }
  });

  // Get recent on-chain trades for a token
  app.get('/api/blockchain/trades/:tokenId', async (req: Request, res: Response) => {
    try {
      const { tokenId } = req.params;
      const blocks = parseInt(req.query.blocks as string) || 10000;
      
      const verifier = getVerifier();
      await verifier.connect();
      
      const trades = await verifier.getRecentTrades(tokenId, -blocks);
      
      res.json({
        success: true,
        data: {
          tokenId,
          trades,
          count: trades.length,
        }
      });
    } catch (error: any) {
      logger.error('Failed to get recent trades', error);
      res.status(500).json({ success: false, error: error.message || 'Failed to fetch trades' });
    }
  });

  // ==========================================
  // VOLATILITY FILTER ENDPOINTS
  // ==========================================

  // Get volatility filter status and config
  app.get('/api/volatility/config', (req: Request, res: Response) => {
    try {
      const config = scheduler.getVolatilityConfig();
      res.json({ success: true, data: config });
    } catch (error: any) {
      logger.error('Failed to get volatility config', error);
      res.status(500).json({ success: false, error: error.message || 'Failed to get config' });
    }
  });

  // Update volatility filter config
  app.post('/api/volatility/config', (req: Request, res: Response) => {
    try {
      const config = req.body;
      scheduler.updateVolatilityConfig(config);
      res.json({ success: true, data: scheduler.getVolatilityConfig() });
    } catch (error: any) {
      logger.error('Failed to update volatility config', error);
      res.status(500).json({ success: false, error: error.message || 'Failed to update config' });
    }
  });

  // Toggle volatility filter on/off
  app.post('/api/volatility/toggle', (req: Request, res: Response) => {
    try {
      const { enabled } = req.body;
      scheduler.setVolatilityFilterEnabled(enabled !== undefined ? enabled : true);
      res.json({ success: true, data: { enabled } });
    } catch (error: any) {
      logger.error('Failed to toggle volatility filter', error);
      res.status(500).json({ success: false, error: error.message || 'Failed to toggle' });
    }
  });

  // ==========================================
  // STOP-LOSS ENDPOINTS
  // ==========================================

  // Get stop-loss config
  app.get('/api/stoploss/config', (req: Request, res: Response) => {
    try {
      const config = scheduler.getStopLossConfig();
      res.json({ success: true, data: config });
    } catch (error: any) {
      logger.error('Failed to get stop-loss config', error);
      res.status(500).json({ success: false, error: error.message || 'Failed to get config' });
    }
  });

  // Update stop-loss config
  app.post('/api/stoploss/config', (req: Request, res: Response) => {
    try {
      const { enabled, threshold } = req.body;
      
      if (threshold !== undefined) {
        // Convert from cents to decimal if needed (if > 1, assume cents)
        const thresholdDecimal = threshold > 1 ? threshold / 100 : threshold;
        scheduler.setStopLossThreshold(thresholdDecimal);
      }
      
      if (enabled !== undefined) {
        scheduler.setStopLossEnabled(enabled);
      }
      
      res.json({ success: true, data: scheduler.getStopLossConfig() });
    } catch (error: any) {
      logger.error('Failed to update stop-loss config', error);
      res.status(500).json({ success: false, error: error.message || 'Failed to update' });
    }
  });

  // Toggle stop-loss on/off
  app.post('/api/stoploss/toggle', (req: Request, res: Response) => {
    try {
      const { enabled } = req.body;
      scheduler.setStopLossEnabled(enabled !== undefined ? enabled : true);
      res.json({ success: true, data: scheduler.getStopLossConfig() });
    } catch (error: any) {
      logger.error('Failed to toggle stop-loss', error);
      res.status(500).json({ success: false, error: error.message || 'Failed to toggle' });
    }
  });

  // Manually trigger stop-loss check
  app.post('/api/stoploss/check', async (req: Request, res: Response) => {
    try {
      const result = await scheduler.triggerStopLossCheck();
      res.json({ success: true, data: result });
    } catch (error: any) {
      logger.error('Failed to trigger stop-loss check', error);
      res.status(500).json({ success: false, error: error.message || 'Failed to check' });
    }
  });

  // ==========================================
  // UNIFIED SETTINGS ENDPOINTS
  // ==========================================

  // Get all settings
  app.get('/api/settings', (req: Request, res: Response) => {
    try {
      const settings = scheduler.getAllSettings();
      res.json({ success: true, data: settings });
    } catch (error: any) {
      logger.error('Failed to get settings', error);
      res.status(500).json({ success: false, error: error.message || 'Failed to get settings' });
    }
  });

  // Update settings (partial)
  app.post('/api/settings', (req: Request, res: Response) => {
    try {
      const updates = req.body;
      const settings = scheduler.updateSettings(updates);
      res.json({ success: true, data: settings });
    } catch (error: any) {
      logger.error('Failed to update settings', error);
      res.status(500).json({ success: false, error: error.message || 'Failed to update settings' });
    }
  });

  // Reset to factory defaults
  app.post('/api/settings/reset', (req: Request, res: Response) => {
    try {
      const settings = scheduler.resetToFactory();
      res.json({ success: true, data: settings });
    } catch (error: any) {
      logger.error('Failed to reset settings', error);
      res.status(500).json({ success: false, error: error.message || 'Failed to reset' });
    }
  });

  // Export settings as JSON
  app.get('/api/settings/export', (req: Request, res: Response) => {
    try {
      const json = scheduler.exportSettings();
      res.setHeader('Content-Type', 'application/json');
      res.setHeader('Content-Disposition', 'attachment; filename=polymarket-bot-settings.json');
      res.send(json);
    } catch (error: any) {
      logger.error('Failed to export settings', error);
      res.status(500).json({ success: false, error: error.message || 'Failed to export' });
    }
  });

  // Import settings from JSON
  app.post('/api/settings/import', (req: Request, res: Response) => {
    try {
      const json = typeof req.body === 'string' ? req.body : JSON.stringify(req.body);
      const settings = scheduler.importSettings(json);
      res.json({ success: true, data: settings });
    } catch (error: any) {
      logger.error('Failed to import settings', error);
      res.status(500).json({ success: false, error: error.message || 'Invalid settings format' });
    }
  });

  // Serve dashboard for all other routes
  app.get('*', (req: Request, res: Response) => {
    res.sendFile(path.join(__dirname, '../../public/index.html'));
  });

  return app;
}

