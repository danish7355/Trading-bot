/**
 * Trade Logger — Non-invasive SQLite logging hook
 * 
 * Wraps around existing storage.saveTrade / storage.closeTrade
 * to mirror trade events into SQLite for persistence & analytics.
 * Does NOT replace or modify the JSON storage layer.
 */

const db = require('./db');

let initialized = false;

function init() {
  if (initialized) return;
  
  try {
    const schemaOk = db.initSchema();
    if (schemaOk) {
      db.migrateFromJSON();
      db.logEvent('BOT_START', 'AlgoBot started', {
        timestamp: new Date().toISOString(),
        pid: process.pid
      });
      
      // Start heartbeat — log every 5 minutes
      setInterval(() => {
        db.logEvent('HEARTBEAT', 'Bot alive', {
          timestamp: new Date().toISOString(),
          uptime: process.uptime(),
          memory: process.memoryUsage().rss
        });
      }, 5 * 60 * 1000);

      // Daily snapshot at midnight UTC
      scheduleDailySnapshot();
      
      initialized = true;
      console.log('[TRADE_LOGGER] Initialized — SQLite logging active');
    }
  } catch (err) {
    console.error('[TRADE_LOGGER] Init failed:', err.message);
  }
}

function scheduleDailySnapshot() {
  const now = new Date();
  const nextMidnight = new Date(Date.UTC(
    now.getUTCFullYear(),
    now.getUTCMonth(),
    now.getUTCDate() + 1,
    0, 0, 5 // 5 seconds past midnight
  ));
  const msUntilMidnight = nextMidnight.getTime() - now.getTime();

  setTimeout(() => {
    takeDailySnapshot();
    // Then repeat every 24 hours
    setInterval(takeDailySnapshot, 24 * 60 * 60 * 1000);
  }, msUntilMidnight);

  console.log(`[TRADE_LOGGER] Daily snapshot scheduled in ${Math.round(msUntilMidnight / 60000)} minutes`);
}

async function takeDailySnapshot() {
  try {
    const storage = require('./storage');
    const trades = await storage.loadTrades();
    const today = new Date().toISOString().split('T')[0];
    
    const closedToday = (trades.closed || []).filter(t => {
      const closedDate = t.closedAtUTC || '';
      return closedDate.includes(today);
    });

    db.saveDailySnapshot({
      date: today,
      balance: trades.demoBalance || 10000,
      openTrades: (trades.open || []).length,
      closedTradesToday: closedToday.length,
      dailyPnl: closedToday.reduce((sum, t) => sum + (t.realizedPnL || 0), 0),
      winCount: closedToday.filter(t => (t.realizedPnL || 0) > 0).length,
      lossCount: closedToday.filter(t => (t.realizedPnL || 0) <= 0).length
    });

    db.logEvent('DAILY_SNAPSHOT', `Balance: ${trades.demoBalance}, Trades today: ${closedToday.length}`, {
      date: today,
      balance: trades.demoBalance
    });

    console.log(`[TRADE_LOGGER] Daily snapshot saved for ${today}`);
  } catch (err) {
    console.error('[TRADE_LOGGER] Daily snapshot failed:', err.message);
  }
}

/**
 * Log a new trade being opened.
 * Call this alongside storage.saveTrade()
 */
function onTradeOpened(trade) {
  if (!initialized) return;
  
  try {
    db.insertTrade(trade);
    db.logEvent('TRADE_OPENED', `Opened ${trade.direction} ${trade.symbol} @ ${trade.entryPrice}`, {
      tradeId: trade.id,
      symbol: trade.symbol,
      direction: trade.direction,
      entryPrice: trade.entryPrice,
      leverage: trade.leverage,
      positionValue: trade.positionValue,
      trigger: trade.trigger
    });
    console.log(`[TRADE_LOGGER] Trade opened logged: ${trade.symbol} ${trade.direction}`);
  } catch (err) {
    console.error('[TRADE_LOGGER] onTradeOpened error:', err.message);
  }
}

/**
 * Log a trade being closed (TP hit, SL hit, manual, time exit, etc.)
 * Call this alongside storage.closeTrade()
 */
function onTradeClosed(trade) {
  if (!initialized) return;
  
  try {
    db.closeTrade(trade.id, {
      exitPrice: trade.exitPrice,
      realizedPnL: trade.realizedPnL,
      pnlPercent: trade.pnlPercent || 0,
      closedAtUTC: trade.closedAtUTC || new Date().toISOString(),
      outcome: trade.outcome,
      scoreAtExit: trade.scoreAtExit,
      tp1Hit: trade.tp1Hit,
      tp2Hit: trade.tp2Hit,
      tp3Hit: trade.tp3Hit
    });
    
    const pnlStr = trade.realizedPnL >= 0 
      ? `+$${trade.realizedPnL.toFixed(2)}` 
      : `-$${Math.abs(trade.realizedPnL).toFixed(2)}`;
    
    db.logEvent('TRADE_CLOSED', `Closed ${trade.symbol} ${trade.outcome || 'MANUAL'} — ${pnlStr}`, {
      tradeId: trade.id,
      symbol: trade.symbol,
      direction: trade.direction,
      outcome: trade.outcome,
      realizedPnL: trade.realizedPnL,
      exitPrice: trade.exitPrice
    });
    console.log(`[TRADE_LOGGER] Trade closed logged: ${trade.symbol} → ${pnlStr}`);
  } catch (err) {
    console.error('[TRADE_LOGGER] onTradeClosed error:', err.message);
  }
}

/**
 * Log TP hit (partial close) events
 */
function onTPHit(trade, tpLevel) {
  if (!initialized) return;
  
  try {
    // Update the trade record in SQLite to reflect TP hit
    db.insertTrade(trade);
    db.logEvent('TP_HIT', `${trade.symbol} TP${tpLevel} hit @ ${trade.currentPrice}`, {
      tradeId: trade.id,
      symbol: trade.symbol,
      tpLevel,
      price: trade.currentPrice
    });
  } catch (err) {
    console.error('[TRADE_LOGGER] onTPHit error:', err.message);
  }
}

/**
 * Log a generic bot event
 */
function logBotEvent(eventType, message, metadata = {}) {
  if (!initialized) return;
  
  try {
    db.logEvent(eventType, message, metadata);
  } catch (err) {
    console.error('[TRADE_LOGGER] logBotEvent error:', err.message);
  }
}

/**
 * Force a daily snapshot right now (e.g., on startup)
 */
function forceSnapshot() {
  takeDailySnapshot();
}

module.exports = {
  init,
  onTradeOpened,
  onTradeClosed,
  onTPHit,
  logBotEvent,
  forceSnapshot
};
