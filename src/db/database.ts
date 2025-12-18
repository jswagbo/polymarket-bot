import Database from 'better-sqlite3';
import path from 'path';
import fs from 'fs';
import { Trade, Position, TradeStatus } from '../types';
import { createLogger } from '../utils/logger';

const logger = createLogger('Database');

export class TradeDatabase {
  private db: Database.Database;

  constructor(dataDir: string) {
    // Ensure data directory exists
    if (!fs.existsSync(dataDir)) {
      fs.mkdirSync(dataDir, { recursive: true });
    }

    const dbPath = path.join(dataDir, 'trades.db');
    logger.info(`Opening database at: ${dbPath}`);
    
    this.db = new Database(dbPath);
    this.db.pragma('journal_mode = WAL');
    this.initializeTables();
  }

  private initializeTables() {
    // Trades table
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS trades (
        id TEXT PRIMARY KEY,
        market_id TEXT NOT NULL,
        market_question TEXT NOT NULL,
        up_token_id TEXT NOT NULL,
        down_token_id TEXT NOT NULL,
        up_price REAL NOT NULL,
        down_price REAL NOT NULL,
        up_size REAL NOT NULL,
        down_size REAL NOT NULL,
        combined_cost REAL NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending',
        up_order_id TEXT,
        down_order_id TEXT,
        pnl REAL,
        created_at TEXT NOT NULL,
        resolved_at TEXT
      )
    `);

    // Create indexes for faster queries
    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_trades_market_id ON trades(market_id);
      CREATE INDEX IF NOT EXISTS idx_trades_status ON trades(status);
      CREATE INDEX IF NOT EXISTS idx_trades_created_at ON trades(created_at);
    `);

    // Bot state table (for persisting configuration)
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS bot_state (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )
    `);

    // Scan history table
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS scan_history (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        scan_time TEXT NOT NULL,
        markets_found INTEGER NOT NULL,
        opportunities_found INTEGER NOT NULL,
        trades_executed INTEGER NOT NULL
      )
    `);

    logger.info('Database tables initialized');
  }

  // Trade operations
  saveTrade(trade: Trade): void {
    const stmt = this.db.prepare(`
      INSERT INTO trades (
        id, market_id, market_question, up_token_id, down_token_id,
        up_price, down_price, up_size, down_size, combined_cost,
        status, up_order_id, down_order_id, pnl, created_at, resolved_at
      ) VALUES (
        @id, @market_id, @market_question, @up_token_id, @down_token_id,
        @up_price, @down_price, @up_size, @down_size, @combined_cost,
        @status, @up_order_id, @down_order_id, @pnl, @created_at, @resolved_at
      )
    `);
    stmt.run(trade);
    logger.debug(`Trade saved: ${trade.id}`);
  }

  updateTrade(trade: Trade): void {
    const stmt = this.db.prepare(`
      UPDATE trades SET
        status = @status,
        up_order_id = @up_order_id,
        down_order_id = @down_order_id,
        pnl = @pnl,
        resolved_at = @resolved_at
      WHERE id = @id
    `);
    stmt.run(trade);
    logger.debug(`Trade updated: ${trade.id}`);
  }

  getTrade(id: string): Trade | null {
    const stmt = this.db.prepare('SELECT * FROM trades WHERE id = ?');
    return stmt.get(id) as Trade | null;
  }

  getTradeByMarketId(marketId: string): Trade | null {
    const stmt = this.db.prepare(`
      SELECT * FROM trades 
      WHERE market_id = ? 
      AND status IN ('pending', 'open', 'partial')
      ORDER BY created_at DESC 
      LIMIT 1
    `);
    return stmt.get(marketId) as Trade | null;
  }

  getTradesByStatus(status: TradeStatus): Trade[] {
    const stmt = this.db.prepare('SELECT * FROM trades WHERE status = ? ORDER BY created_at DESC');
    return stmt.all(status) as Trade[];
  }

  getRecentTrades(limit: number = 50): Trade[] {
    const stmt = this.db.prepare('SELECT * FROM trades ORDER BY created_at DESC LIMIT ?');
    return stmt.all(limit) as Trade[];
  }

  getOpenTrades(): Trade[] {
    const stmt = this.db.prepare(`
      SELECT * FROM trades 
      WHERE status IN ('pending', 'open', 'partial')
      ORDER BY created_at DESC
    `);
    return stmt.all() as Trade[];
  }

  // Statistics
  getTotalPnL(): number {
    const stmt = this.db.prepare('SELECT COALESCE(SUM(pnl), 0) as total FROM trades WHERE pnl IS NOT NULL');
    const result = stmt.get() as { total: number };
    return result.total;
  }

  getTotalTrades(): number {
    const stmt = this.db.prepare('SELECT COUNT(*) as count FROM trades');
    const result = stmt.get() as { count: number };
    return result.count;
  }

  getTradeStats(): { total: number; open: number; resolved: number; failed: number; totalPnL: number } {
    const stats = this.db.prepare(`
      SELECT
        COUNT(*) as total,
        SUM(CASE WHEN status IN ('pending', 'open', 'partial') THEN 1 ELSE 0 END) as open,
        SUM(CASE WHEN status = 'resolved' THEN 1 ELSE 0 END) as resolved,
        SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) as failed,
        COALESCE(SUM(pnl), 0) as totalPnL
      FROM trades
    `).get() as any;

    return {
      total: stats.total,
      open: stats.open,
      resolved: stats.resolved,
      failed: stats.failed,
      totalPnL: stats.totalPnL,
    };
  }

  // Bot state operations
  setState(key: string, value: string): void {
    const stmt = this.db.prepare(`
      INSERT INTO bot_state (key, value, updated_at)
      VALUES (?, ?, ?)
      ON CONFLICT(key) DO UPDATE SET value = ?, updated_at = ?
    `);
    const now = new Date().toISOString();
    stmt.run(key, value, now, value, now);
  }

  getState(key: string): string | null {
    const stmt = this.db.prepare('SELECT value FROM bot_state WHERE key = ?');
    const result = stmt.get(key) as { value: string } | undefined;
    return result?.value || null;
  }

  // Scan history
  recordScan(marketsFound: number, opportunitiesFound: number, tradesExecuted: number): void {
    const stmt = this.db.prepare(`
      INSERT INTO scan_history (scan_time, markets_found, opportunities_found, trades_executed)
      VALUES (?, ?, ?, ?)
    `);
    stmt.run(new Date().toISOString(), marketsFound, opportunitiesFound, tradesExecuted);
  }

  getLastScanTime(): string | null {
    const stmt = this.db.prepare('SELECT scan_time FROM scan_history ORDER BY id DESC LIMIT 1');
    const result = stmt.get() as { scan_time: string } | undefined;
    return result?.scan_time || null;
  }

  close(): void {
    this.db.close();
    logger.info('Database closed');
  }
}

// Re-export as Database for simpler imports
export { TradeDatabase as Database };

