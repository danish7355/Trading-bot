const fs = require('fs').promises;
const path = require('path');

const DATA_DIR          = path.join(__dirname, '..', 'data');
const SETTINGS_FILE     = path.join(DATA_DIR, 'settings.json');
const TRADES_FILE       = path.join(DATA_DIR, 'trades.json');
const SIGNALS_FILE      = path.join(DATA_DIR, 'signals.json');
const POSITIONS_FILE    = path.join(DATA_DIR, 'positions.json');
const BACKTEST_CACHE_DIR = path.join(DATA_DIR, 'backtest_cache');

const DEFAULT_SETTINGS = {
  exchange: "binance",
  deltaMode: "testnet",
  timeframe: "4h",
  scanCoins: 50,
  scanInterval: 30,
  autoTradeEnabled: true,
  autoTradePaused: false,
  ema: { fast: 9, slow: 55, trend: 200 },
  rsi: { period: 14, min: 30, max: 65 },
  adx: { period: 14, threshold: 20 },
  volume: { period: 20, multiplier: 1.5 },
  macd: { fast: 12, slow: 26, signal: 9 },
  supertrend: { atrPeriod: 10, multiplier: 3.0 },
  fibonacci: { lookback: 100 },
  sr: { lookback: 200 },
  trade: {
    positionSizePct: 5,
    leverage: 10,
    maxConcurrentTrades: 3,
    maxRiskPerTradePct: 2,
    dailyLossLimitPct: 5,
    tp1AtrMultiple: 2.0,
    tp1ClosePct: 40,
    tp2AtrMultiple: 3.5,
    tp2ClosePct: 40,
    tp3ClosePct: 20,
    trailingStopAtr: 1.0,
    trailingActivatesAt: "tp1",
    timeExitCandles: 3,
    timeExitScoreThreshold: 40
  },
  wm: {
    enabled: true,
    lookback: 25,
    v2TolerancePct: 2,
    p2TolerancePct: 2,
    autoExecute: true,
    countdownSeconds: 10,
    soundAlert: true
  },
  demoBalance: 10000,
  telegram: {
    botToken: process.env.TELEGRAM_BOT_TOKEN || "",
    chatId:   process.env.TELEGRAM_CHAT_ID   || "",
    alerts: {
      signalDetected: true,
      wmReady: true,
      wmConfirmed: true,
      tradeOpened: true,
      tp1Hit: true,
      tp2Hit: true,
      tp3Hit: true,
      slHit: true,
      trailingMoved: true,
      trailingHit: true,
      manualClose: true,
      timeExit: true,
      dailyLimit: true,
      ranging: true,
      scoreDegrading: true,
      volatilitySpike: true,
      wmForming: false
    }
  }
};

const DEFAULT_TRADES = {
  open: [], closed: [], demoBalance: 10000,
  realizedPnLToday: 0,
  lastResetDate: new Date().toISOString().split('T')[0]
};
const DEFAULT_SIGNALS  = { signals: [] };
const DEFAULT_POSITIONS = { lastUpdated: Date.now(), coins: [] };

async function ensureDir(dirPath) {
  try { await fs.mkdir(dirPath, { recursive: true }); } catch (e) {}
}

async function ensureFile(filePath, defaultData) {
  try { await fs.access(filePath); }
  catch { await fs.writeFile(filePath, JSON.stringify(defaultData, null, 2), 'utf-8'); }
}

async function initialize() {
  await ensureDir(DATA_DIR);
  await ensureDir(BACKTEST_CACHE_DIR);
  await ensureFile(SETTINGS_FILE, DEFAULT_SETTINGS);
  await ensureFile(TRADES_FILE, DEFAULT_TRADES);
  await ensureFile(SIGNALS_FILE, DEFAULT_SIGNALS);
  await ensureFile(POSITIONS_FILE, DEFAULT_POSITIONS);
}

async function readJSON(filePath, fallback) {
  try {
    const data = await fs.readFile(filePath, 'utf-8');
    return JSON.parse(data);
  } catch (err) {
    console.error(`[STORAGE] Error reading ${filePath}:`, err.message);
    return fallback;
  }
}

async function writeJSON(filePath, data) {
  try {
    await fs.writeFile(filePath, JSON.stringify(data, null, 2), 'utf-8');
    return true;
  } catch (err) {
    console.error(`[STORAGE] Error writing ${filePath}:`, err.message);
    return false;
  }
}

async function loadSettings() {
  const saved = await readJSON(SETTINGS_FILE, DEFAULT_SETTINGS);

  // Shallow-merge top-level keys
  const merged = { ...DEFAULT_SETTINGS, ...saved };

  // Deep-merge nested objects so partial saves don't wipe sub-keys
  merged.ema         = { ...DEFAULT_SETTINGS.ema,         ...(saved.ema         || {}) };
  merged.rsi         = { ...DEFAULT_SETTINGS.rsi,         ...(saved.rsi         || {}) };
  merged.adx         = { ...DEFAULT_SETTINGS.adx,         ...(saved.adx         || {}) };
  merged.volume      = { ...DEFAULT_SETTINGS.volume,      ...(saved.volume      || {}) };
  merged.macd        = { ...DEFAULT_SETTINGS.macd,        ...(saved.macd        || {}) };
  merged.supertrend  = { ...DEFAULT_SETTINGS.supertrend,  ...(saved.supertrend  || {}) };
  merged.fibonacci   = { ...DEFAULT_SETTINGS.fibonacci,   ...(saved.fibonacci   || {}) };
  merged.sr          = { ...DEFAULT_SETTINGS.sr,          ...(saved.sr          || {}) };
  merged.trade       = { ...DEFAULT_SETTINGS.trade,       ...(saved.trade       || {}) };
  merged.wm          = { ...DEFAULT_SETTINGS.wm,          ...(saved.wm          || {}) };

  // Critical: deep-merge telegram so alerts sub-object is always fully populated
  const savedTg = saved.telegram || {};
  merged.telegram = {
    ...DEFAULT_SETTINGS.telegram,
    ...savedTg,
    alerts: {
      ...DEFAULT_SETTINGS.telegram.alerts,   // start with all defaults = true
      ...(savedTg.alerts || {})             // apply any explicit user overrides
    }
  };
  // If no token in saved but env has one, use env
  if (!merged.telegram.botToken) merged.telegram.botToken = process.env.TELEGRAM_BOT_TOKEN || '';
  if (!merged.telegram.chatId)   merged.telegram.chatId   = process.env.TELEGRAM_CHAT_ID   || '';

  return merged;
}

async function saveSettings(newSettings) {
  const current = await loadSettings();
  // Deep-merge trade and telegram sub-objects
  const updated = {
    ...current,
    ...newSettings,
    trade: {
      ...current.trade,
      ...(newSettings.trade || {})
    },
    telegram: {
      ...current.telegram,
      ...(newSettings.telegram || {}),
      alerts: {
        ...current.telegram.alerts,
        ...((newSettings.telegram && newSettings.telegram.alerts) || {})
      }
    }
  };
  await writeJSON(SETTINGS_FILE, updated);
  return updated;
}

async function loadTrades()          { return await readJSON(TRADES_FILE, DEFAULT_TRADES); }
async function saveTrades(tradesObj) { return await writeJSON(TRADES_FILE, tradesObj); }

async function saveTrade(trade) {
  const tradesObj = await loadTrades();
  const idx = tradesObj.open.findIndex(t => t.id === trade.id);
  if (idx >= 0) tradesObj.open[idx] = trade;
  else tradesObj.open.push(trade);
  await saveTrades(tradesObj);
}

async function closeTrade(closedTrade) {
  const tradesObj = await loadTrades();
  tradesObj.open   = tradesObj.open.filter(t => t.id !== closedTrade.id);
  tradesObj.closed.unshift(closedTrade);
  await saveTrades(tradesObj);
}

async function loadSignals()          { return await readJSON(SIGNALS_FILE, DEFAULT_SIGNALS); }
async function saveSignals(signalsObj) { return await writeJSON(SIGNALS_FILE, signalsObj); }

async function addSignal(signal) {
  const data = await loadSignals();
  data.signals.unshift(signal);
  if (data.signals.length > 1000) data.signals = data.signals.slice(0, 1000);
  await saveSignals(data);
}

async function updateSignal(signal) {
  const data = await loadSignals();
  const idx  = data.signals.findIndex(s => s.id === signal.id);
  if (idx >= 0) { data.signals[idx] = signal; await saveSignals(data); }
}

async function getSignalById(id) {
  const data = await loadSignals();
  return data.signals.find(s => s.id === id) || null;
}

async function getSignals(filters = {}) {
  const data = await loadSignals();
  let list   = data.signals || [];

  if (filters.exchange  && filters.exchange  !== 'ALL') list = list.filter(s => (s.exchange || 'binance').toLowerCase() === filters.exchange.toLowerCase());
  if (filters.timeframe && filters.timeframe !== 'ALL') list = list.filter(s => s.timeframe === filters.timeframe);
  if (filters.direction && filters.direction !== 'ALL') list = list.filter(s => s.direction === filters.direction.toUpperCase());
  if (filters.result    && filters.result    !== 'ALL') {
    if (filters.result === 'FIRED')   list = list.filter(s => s.tradeFired);
    else if (filters.result === 'SKIPPED') list = list.filter(s => !s.tradeFired);
    else if (filters.result === 'FAILED')  list = list.filter(s => s.gate1 === 'FAIL' || s.gate2 === 'FAIL' || s.gate3 === 'FAIL' || s.gate4 === 'FAIL');
  }
  if (filters.pattern && filters.pattern !== 'ALL') {
    list = list.filter(s => s.wmPattern === filters.pattern || (filters.pattern === 'NONE' && !s.wmPattern));
  }
  if (filters.coin) {
    const coinUpper = filters.coin.toUpperCase();
    list = list.filter(s => s.symbol.includes(coinUpper));
  }
  return list;
}

async function getAllCoinStates() {
  const pos = await readJSON(POSITIONS_FILE, DEFAULT_POSITIONS);
  return pos.coins || [];
}

async function saveCoinStates(coins) {
  await writeJSON(POSITIONS_FILE, { lastUpdated: Date.now(), coins });
}

async function getDemoBalance() {
  const tradesObj = await loadTrades();
  return tradesObj.demoBalance ?? 10000;
}

async function saveDemoBalance(amount) {
  const tradesObj = await loadTrades();
  tradesObj.demoBalance = amount;
  await saveTrades(tradesObj);
}

module.exports = {
  initialize, loadSettings, saveSettings,
  loadTrades, saveTrades, saveTrade, closeTrade,
  addSignal, updateSignal, getSignalById, getSignals,
  getAllCoinStates, saveCoinStates, getDemoBalance, saveDemoBalance
};
