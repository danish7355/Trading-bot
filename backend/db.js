/**
 * SQLite Database Module — Persistent Trade & Event Storage
 * 
 * Uses better-sqlite3 for synchronous, zero-config local persistence.
 * This runs ALONGSIDE the existing JSON storage — not a replacement.
 * All existing trade logic remains unchanged.
 */

const path = require('path');
const fs = require('fs');

const DB_DIR = path.join(__dirname, '..', 'data');
const DB_PATH = path.join(DB_DIR, 'algobot.db');

let db = null;

function getDb() {
  if (db) return db;
  
  // Ensure data directory exists
  if (!fs.existsSync(DB_DIR)) {
    fs.mkdirSync(DB_DIR, { recursive: true });
  }

  try {
    const Database = require('better-sqlite3');
    db = new Database(DB_PATH, { verbose: null });
    
    // Enable WAL mode for better concurrent read performance
    db.pragma('journal_mode = WAL');
    db.pragma('busy_timeout = 5000');
    
    console.log('[DB] SQLite connected at', DB_PATH);
    return db;
  } catch (err) {
    console.error('[DB] Failed to initialize SQLite:', err.message);
    return null;
  }
}

function initSchema() {
  const database = getDb();
  if (!database) {
    console.error('[DB] Cannot initialize schema — no database connection');
    return false;
  }

  try {
    database.exec(`
      -- Persistent trade storage
      CREATE TABLE IF NOT EXISTS trades (
        id TEXT PRIMARY KEY,
        symbol TEXT NOT NULL,
        side TEXT NOT NULL CHECK(side IN ('LONG', 'SHORT')),
        entry_price REAL NOT NULL,
        exit_price REAL,
        quantity REAL DEFAULT 0,
        position_value REAL DEFAULT 0,
        leverage INTEGER DEFAULT 1,
        pnl REAL DEFAULT 0,
        pnl_percent REAL DEFAULT 0,
        status TEXT NOT NULL DEFAULT 'open' CHECK(status IN ('open', 'closed')),
        opened_at TEXT NOT NULL,
        closed_at TEXT,
        strategy_tag TEXT DEFAULT '4-GATE',
        is_paper INTEGER DEFAULT 1,
        timeframe TEXT DEFAULT '4h',
        exchange TEXT DEFAULT 'binance',
        stop_loss REAL,
        tp1 REAL,
        tp2 REAL,
        tp3 REAL,
        tp1_hit INTEGER DEFAULT 0,
        tp2_hit INTEGER DEFAULT 0,
        tp3_hit INTEGER DEFAULT 0,
        outcome TEXT,
        score_at_entry REAL DEFAULT 0,
        score_at_exit REAL,
        atr_at_entry REAL DEFAULT 0,
        signal_id TEXT,
        metadata_json TEXT,
        created_at TEXT DEFAULT (datetime('now')),
        updated_at TEXT DEFAULT (datetime('now'))
      );

      -- Bot events for heartbeats, errors, and status changes
      CREATE TABLE IF NOT EXISTS bot_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        event_type TEXT NOT NULL,
        message TEXT,
        metadata_json TEXT,
        created_at TEXT DEFAULT (datetime('now'))
      );

      -- Daily balance snapshots for equity curve
      CREATE TABLE IF NOT EXISTS daily_snapshots (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        date TEXT NOT NULL UNIQUE,
        balance REAL NOT NULL,
        open_trades INTEGER DEFAULT 0,
        closed_trades_today INTEGER DEFAULT 0,
        daily_pnl REAL DEFAULT 0,
        win_count INTEGER DEFAULT 0,
        loss_count INTEGER DEFAULT 0,
        created_at TEXT DEFAULT (datetime('now'))
      );

      -- Indexes for fast queries
      CREATE INDEX IF NOT EXISTS idx_trades_status ON trades(status);
      CREATE INDEX IF NOT EXISTS idx_trades_symbol ON trades(symbol);
      CREATE INDEX IF NOT EXISTS idx_trades_strategy ON trades(strategy_tag);
      CREATE INDEX IF NOT EXISTS idx_trades_opened_at ON trades(opened_at);
      CREATE INDEX IF NOT EXISTS idx_trades_closed_at ON trades(closed_at);
      CREATE INDEX IF NOT EXISTS idx_bot_events_type ON bot_events(event_type);
      CREATE INDEX IF NOT EXISTS idx_bot_events_created ON bot_events(created_at);
      CREATE INDEX IF NOT EXISTS idx_daily_snapshots_date ON daily_snapshots(date);
    `);

    console.log('[DB] Schema initialized successfully');
    return true;
  } catch (err) {
    console.error('[DB] Schema initialization failed:', err.message);
    return false;
  }
}

// ─── Trade CRUD Operations ───────────────────────────────────────

function insertTrade(trade) {
  const database = getDb();
  if (!database) return null;

  try {
    const stmt = database.prepare(`
      INSERT OR REPLACE INTO trades (
        id, symbol, side, entry_price, exit_price, quantity, position_value,
        leverage, pnl, pnl_percent, status, opened_at, closed_at,
        strategy_tag, is_paper, timeframe, exchange,
        stop_loss, tp1, tp2, tp3, tp1_hit, tp2_hit, tp3_hit,
        outcome, score_at_entry, score_at_exit, atr_at_entry,
        signal_id, metadata_json, updated_at
      ) VALUES (
        @id, @symbol, @side, @entry_price, @exit_price, @quantity, @position_value,
        @leverage, @pnl, @pnl_percent, @status, @opened_at, @closed_at,
        @strategy_tag, @is_paper, @timeframe, @exchange,
        @stop_loss, @tp1, @tp2, @tp3, @tp1_hit, @tp2_hit, @tp3_hit,
        @outcome, @score_at_entry, @score_at_exit, @atr_at_entry,
        @signal_id, @metadata_json, datetime('now')
      )
    `);

    stmt.run({
      id: trade.id,
      symbol: trade.symbol,
      side: trade.direction || trade.side || 'LONG',
      entry_price: trade.entryPrice || trade.entry_price || 0,
      exit_price: trade.exitPrice || trade.exit_price || null,
      quantity: trade.quantity || 0,
      position_value: trade.positionValue || trade.position_value || 0,
      leverage: trade.leverage || 1,
      pnl: trade.realizedPnL || trade.pnl || 0,
      pnl_percent: trade.pnlPercent || trade.pnl_percent || 0,
      status: (trade.status === 'OPEN' || trade.status === 'open') ? 'open' : 'closed',
      opened_at: trade.openedAtUTC || trade.opened_at || new Date(trade.openedAt || Date.now()).toISOString(),
      closed_at: trade.closedAtUTC || trade.closed_at || null,
      strategy_tag: trade.trigger || trade.strategy_tag || '4-GATE',
      is_paper: trade.isLiveTrade ? 0 : 1,
      timeframe: trade.timeframe || '4h',
      exchange: trade.exchange || 'binance',
      stop_loss: trade.stopLoss || trade.stop_loss || null,
      tp1: trade.tp1 || null,
      tp2: trade.tp2 || null,
      tp3: trade.tp3 || null,
      tp1_hit: trade.tp1Hit ? 1 : 0,
      tp2_hit: trade.tp2Hit ? 1 : 0,
      tp3_hit: trade.tp3Hit ? 1 : 0,
      outcome: trade.outcome || null,
      score_at_entry: trade.scoreAtEntry || trade.score_at_entry || 0,
      score_at_exit: trade.scoreAtExit || trade.score_at_exit || null,
      atr_at_entry: trade.atrAtEntry || trade.atr_at_entry || 0,
      signal_id: trade.signalId || trade.signal_id || null,
      metadata_json: JSON.stringify({
        gate1: trade.gate1,
        gate2: trade.gate2,
        gate3: trade.gate3,
        gate4: trade.gate4,
        wmPattern: trade.wmPattern,
        remainingPct: trade.remainingPct,
        trailingStop: trade.trailingStop,
        candlesOpen: trade.candlesOpen
      })
    });

    return trade.id;
  } catch (err) {
    console.error('[DB] insertTrade error:', err.message);
    return null;
  }
}

function closeTrade(tradeId, exitData) {
  const database = getDb();
  if (!database) return false;

  try {
    const stmt = database.prepare(`
      UPDATE trades SET
        status = 'closed',
        exit_price = @exit_price,
        pnl = @pnl,
        pnl_percent = @pnl_percent,
        closed_at = @closed_at,
        outcome = @outcome,
        score_at_exit = @score_at_exit,
        tp1_hit = @tp1_hit,
        tp2_hit = @tp2_hit,
        tp3_hit = @tp3_hit,
        updated_at = datetime('now')
      WHERE id = @id
    `);

    stmt.run({
      id: tradeId,
      exit_price: exitData.exitPrice || exitData.exit_price || 0,
      pnl: exitData.realizedPnL || exitData.pnl || 0,
      pnl_percent: exitData.pnlPercent || exitData.pnl_percent || 0,
      closed_at: exitData.closedAtUTC || exitData.closed_at || new Date().toISOString(),
      outcome: exitData.outcome || null,
      score_at_exit: exitData.scoreAtExit || exitData.score_at_exit || null,
      tp1_hit: exitData.tp1Hit ? 1 : 0,
      tp2_hit: exitData.tp2Hit ? 1 : 0,
      tp3_hit: exitData.tp3Hit ? 1 : 0
    });

    return true;
  } catch (err) {
    console.error('[DB] closeTrade error:', err.message);
    return false;
  }
}

function getOpenTrades() {
  const database = getDb();
  if (!database) return [];

  try {
    return database.prepare('SELECT * FROM trades WHERE status = ? ORDER BY opened_at DESC').all('open');
  } catch (err) {
    console.error('[DB] getOpenTrades error:', err.message);
    return [];
  }
}

function getClosedTrades(limit = 100, offset = 0) {
  const database = getDb();
  if (!database) return [];

  try {
    return database.prepare(
      'SELECT * FROM trades WHERE status = ? ORDER BY closed_at DESC LIMIT ? OFFSET ?'
    ).all('closed', limit, offset);
  } catch (err) {
    console.error('[DB] getClosedTrades error:', err.message);
    return [];
  }
}

function getAllTrades() {
  const database = getDb();
  if (!database) return [];

  try {
    return database.prepare('SELECT * FROM trades ORDER BY opened_at DESC').all();
  } catch (err) {
    console.error('[DB] getAllTrades error:', err.message);
    return [];
  }
}

function getTradeById(tradeId) {
  const database = getDb();
  if (!database) return null;

  try {
    return database.prepare('SELECT * FROM trades WHERE id = ?').get(tradeId);
  } catch (err) {
    console.error('[DB] getTradeById error:', err.message);
    return null;
  }
}

function getTradesBySymbol(symbol) {
  const database = getDb();
  if (!database) return [];

  try {
    return database.prepare(
      'SELECT * FROM trades WHERE symbol = ? ORDER BY opened_at DESC'
    ).all(symbol);
  } catch (err) {
    console.error('[DB] getTradesBySymbol error:', err.message);
    return [];
  }
}

function getTradesByStrategy(strategyTag) {
  const database = getDb();
  if (!database) return [];

  try {
    return database.prepare(
      'SELECT * FROM trades WHERE strategy_tag = ? ORDER BY opened_at DESC'
    ).all(strategyTag);
  } catch (err) {
    console.error('[DB] getTradesByStrategy error:', err.message);
    return [];
  }
}

function getTradeCount() {
  const database = getDb();
  if (!database) return { total: 0, open: 0, closed: 0 };

  try {
    const total = database.prepare('SELECT COUNT(*) as cnt FROM trades').get().cnt;
    const open = database.prepare("SELECT COUNT(*) as cnt FROM trades WHERE status = 'open'").get().cnt;
    const closed = database.prepare("SELECT COUNT(*) as cnt FROM trades WHERE status = 'closed'").get().cnt;
    return { total, open, closed };
  } catch (err) {
    console.error('[DB] getTradeCount error:', err.message);
    return { total: 0, open: 0, closed: 0 };
  }
}

// ─── Bot Events ──────────────────────────────────────────────────

function logEvent(eventType, message, metadata = {}) {
  const database = getDb();
  if (!database) return;

  try {
    database.prepare(`
      INSERT INTO bot_events (event_type, message, metadata_json)
      VALUES (?, ?, ?)
    `).run(eventType, message, JSON.stringify(metadata));
  } catch (err) {
    console.error('[DB] logEvent error:', err.message);
  }
}

function getEvents(eventType = null, limit = 100) {
  const database = getDb();
  if (!database) return [];

  try {
    if (eventType) {
      return database.prepare(
        'SELECT * FROM bot_events WHERE event_type = ? ORDER BY created_at DESC LIMIT ?'
      ).all(eventType, limit);
    }
    return database.prepare(
      'SELECT * FROM bot_events ORDER BY created_at DESC LIMIT ?'
    ).all(limit);
  } catch (err) {
    console.error('[DB] getEvents error:', err.message);
    return [];
  }
}

// ─── Daily Snapshots ─────────────────────────────────────────────

function saveDailySnapshot(snapshotData) {
  const database = getDb();
  if (!database) return false;

  try {
    database.prepare(`
      INSERT OR REPLACE INTO daily_snapshots (
        date, balance, open_trades, closed_trades_today,
        daily_pnl, win_count, loss_count
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      snapshotData.date,
      snapshotData.balance,
      snapshotData.openTrades || 0,
      snapshotData.closedTradesToday || 0,
      snapshotData.dailyPnl || 0,
      snapshotData.winCount || 0,
      snapshotData.lossCount || 0
    );
    return true;
  } catch (err) {
    console.error('[DB] saveDailySnapshot error:', err.message);
    return false;
  }
}

function getDailySnapshots(days = 90) {
  const database = getDb();
  if (!database) return [];

  try {
    return database.prepare(`
      SELECT * FROM daily_snapshots
      ORDER BY date DESC LIMIT ?
    `).all(days);
  } catch (err) {
    console.error('[DB] getDailySnapshots error:', err.message);
    return [];
  }
}

// ─── Cleanup ─────────────────────────────────────────────────────

function closeDb() {
  if (db) {
    try {
      db.close();
      console.log('[DB] SQLite connection closed');
    } catch (err) {
      console.error('[DB] Error closing database:', err.message);
    }
    db = null;
  }
}

// ─── Migration: Import existing JSON trades into SQLite ──────────

function migrateFromJSON() {
  const database = getDb();
  if (!database) return;

  try {
    const tradesFile = path.join(DB_DIR, 'trades.json');
    if (!fs.existsSync(tradesFile)) return;

    const rawData = fs.readFileSync(tradesFile, 'utf-8');
    const tradesObj = JSON.parse(rawData);

    const existingCount = database.prepare('SELECT COUNT(*) as cnt FROM trades').get().cnt;
    if (existingCount > 0) {
      console.log('[DB] SQLite already has trades — skipping JSON migration');
      return;
    }

    let migrated = 0;

    // Migrate open trades
    if (tradesObj.open && Array.isArray(tradesObj.open)) {
      for (const trade of tradesObj.open) {
        insertTrade({ ...trade, status: 'OPEN' });
        migrated++;
      }
    }

    // Migrate closed trades
    if (tradesObj.closed && Array.isArray(tradesObj.closed)) {
      for (const trade of tradesObj.closed) {
        insertTrade({ ...trade, status: 'CLOSED' });
        migrated++;
      }
    }

    if (migrated > 0) {
      console.log(`[DB] Migrated ${migrated} trades from JSON to SQLite`);
      logEvent('MIGRATION', `Migrated ${migrated} trades from trades.json to SQLite`);
    }
  } catch (err) {
    console.error('[DB] Migration error:', err.message);
  }
}

module.exports = {
  getDb,
  initSchema,
  insertTrade,
  closeTrade,
  getOpenTrades,
  getClosedTrades,
  getAllTrades,
  getTradeById,
  getTradesBySymbol,
  getTradesByStrategy,
  getTradeCount,
  logEvent,
  getEvents,
  saveDailySnapshot,
  getDailySnapshots,
  closeDb,
  migrateFromJSON
};
