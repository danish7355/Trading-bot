require('dotenv').config();

const express   = require('express');
const http      = require('http');
const WebSocket = require('ws');
const path      = require('path');
const cors      = require('cors');

const storage          = require('./backend/storage');
const binanceData      = require('./backend/binanceData');
const websocketManager = require('./backend/websocketManager');
const scanner          = require('./backend/scanner');
const tradeManager     = require('./backend/tradeManager');
const deltaExchange    = require('./backend/deltaExchange');
const telegram         = require('./backend/telegramBot');
const backtest         = require('./backend/backtest');
const indicators       = require('./backend/indicators');
const tradeLogger      = require('./backend/tradeLogger');
const analytics        = require('./backend/analytics');
const db               = require('./backend/db');
const multiMarket      = require('./backend/multiMarketScanner');
const tradingGuard     = require('./backend/tradingGuard');
const exitManager      = require('./backend/exitManager');
const strategyPresets  = require('./backend/strategyPresets');
const exchangeKeys     = require('./backend/exchangeKeys');
const { formatUTCDateTime, formatUptime } = require('./backend/utils');

const app    = express();
const server = http.createServer(app);
const PORT   = process.env.PORT || 3000;

const wss    = new WebSocket.Server({ server });

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'frontend')));

const browserClients = new Set();

function broadcast(type, data) {
  const message = JSON.stringify({ type, data });
  browserClients.forEach(client => {
    if (client.readyState === WebSocket.OPEN) {
      try { client.send(message); }
      catch (e) { console.error('[WS] Send error:', e.message); browserClients.delete(client); }
    }
  });
}
module.exports.broadcast = broadcast;

// Wire multi-market scanner to the same broadcast channel
multiMarket.setBroadcast(broadcast);

async function sendInitialState(ws) {
  try {
    const [settings, trades, signals, scannerData] = await Promise.all([
      storage.loadSettings(),
      storage.loadTrades(),
      storage.getSignals({ limit: 100 }),
      storage.getAllCoinStates()
    ]);

    const currentPrices = websocketManager.getAllPrices();
    const coinsWithLivePrices = (scannerData || []).map(coin => ({
      ...coin, price: currentPrices[coin.symbol] || coin.price
    }));

    const tradesWithPnL = (trades.open || []).map(trade => {
      const currentPrice = currentPrices[trade.symbol] || trade.entryPrice;
      const pnl = tradeManager.calculateLivePnL(trade, currentPrice);
      return { ...trade, currentPrice, unrealizedPnL: pnl.unrealizedPnL, unrealizedPct: pnl.pnlPct };
    });

    const initialState = {
      settings,
      coins: coinsWithLivePrices,
      openTrades: tradesWithPnL,
      closedTrades: (trades.closed || []).slice(-50),
      signals: (signals || []).slice(0, 100),
      currentPrices,
      demoBalance: trades.demoBalance ?? 10000,
      dailyPnL: scanner.getDailyStats(),
      priceFeed: websocketManager.getPriceFeedProvider(),
      systemStatus: {
        uptime: process.uptime(),
        binanceConnected: websocketManager.isConnected(),
        provider: websocketManager.getPriceFeedProvider().active,
        scannerRunning: scanner.isRunning(),
        lastScanTime: scanner.getLastScanTime(),
        scanHeartbeat: scanner.getLastAutoScanHeartbeat(),
        openTradesCount: (trades.open || []).length,
        activeTimeframe: settings.timeframe || '4h'
      },
      marketStatus: multiMarket.getAllMarketsStatus()
    };

    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'INITIAL_STATE', data: initialState }));
    }
  } catch (err) {
    console.error('[WS] Failed to send initial state:', err.message);
  }
}

wss.on('connection', (ws, req) => {
  const ip = req.socket ? req.socket.remoteAddress : 'unknown';
  console.log('[WS] Browser connected — ' + ip);
  browserClients.add(ws);
  sendInitialState(ws);

  ws.on('message', async (raw) => {
    try {
      const msg = JSON.parse(raw);
      if (!msg || !msg.type) return;
      switch (msg.type) {
        case 'GET_INITIAL_STATE':  await sendInitialState(ws); break;
        case 'CLOSE_TRADE':
          if (msg.data?.tradeId) await scanner.manualCloseTrade(msg.data.tradeId);
          break;
        case 'WM_CONFIRM':
          if (msg.data?.signalId) scanner.confirmWMTrade(msg.data.signalId);
          break;
        case 'WM_SKIP':
          if (msg.data?.signalId) scanner.skipWMTrade(msg.data.signalId);
          break;
        case 'UPDATE_SETTINGS':
          if (msg.data) await applySettingsUpdate(msg.data);
          break;
      }
    } catch (e) {
      console.error('[WS] Bad message:', e.message);
    }
  });

  ws.on('close', () => {
    browserClients.delete(ws);
    console.log('[WS] Browser disconnected — ' + browserClients.size + ' remaining');
  });
  ws.on('error', (err) => { console.error('[WS] Client error:', err.message); browserClients.delete(ws); });
});

// ── Settings update (shared by REST + WS) ────────────────────────

async function applySettingsUpdate(newSettings) {
  const currentSettings = await storage.loadSettings();

  if (newSettings.resetDemoBalance) {
    await storage.saveDemoBalance(10000);
    delete newSettings.resetDemoBalance;
  }

  const timeframeChanged = newSettings.timeframe && newSettings.timeframe !== currentSettings.timeframe;
  const newScanCoins     = parseInt(newSettings.scanCoins);
  const currentScanCoins = parseInt(currentSettings.scanCoins || 50);
  const scanCoinsChanged = !isNaN(newScanCoins) && newScanCoins !== currentScanCoins;

  const updated = await storage.saveSettings({
    ...newSettings,
    scanCoins: !isNaN(newScanCoins) ? newScanCoins : currentScanCoins
  });

  // Issue 2: ALWAYS update scanner's live settings reference immediately,
  // for every setting (not just timeframe/scanCoins changes).
  scanner.updateSettings(updated);
  console.log(`[SETTINGS] Live engine updated — TF:${updated.timeframe}, AutoTrade:${updated.autoTradeEnabled}`);

  const numCoins = parseInt(updated.scanCoins) || 50;

  if (timeframeChanged || scanCoinsChanged) {
    console.log(`[SETTINGS] Re-loading data — TF:${updated.timeframe}, Coins:${numCoins}`);
    console.log(`[SETTINGS] Calling startPriceStream from settings handler`);
    const coinList = await binanceData.getTopCoins(numCoins);
    websocketManager.startPriceStream(coinList, (symbol, price) => scanner.onPriceTick(symbol, price));
    console.log(`[SETTINGS] startPriceStream returned from settings handler`);
    websocketManager.restartKlineStream(coinList, updated.timeframe || '4h', (sym, closeTime) => {
      scanner.onCandleClose(sym, closeTime);
    });
    await scanner.loadInitialData(coinList, updated);
    await scanner.runFullAutoScan();
  }

  const demoBalance = await storage.getDemoBalance();
  broadcast('SETTINGS_UPDATED', updated);
  broadcast('BALANCE_UPDATE', { demoBalance });
  broadcast('SCANNER_UPDATE', { coins: scanner.getScannerState() });
  broadcast('SCAN_HEARTBEAT', scanner.getLastAutoScanHeartbeat());

  return updated;
}

// ── REST API ──────────────────────────────────────────────────────

app.get('/api/status', async (req, res) => {
  try {
    const settings     = await storage.loadSettings();
    const demoBalance  = await storage.getDemoBalance();
    const openTrades   = scanner.getOpenTrades();
    const heartbeat    = scanner.getLastAutoScanHeartbeat();

    res.json({
      status: 'running',
      uptime: process.uptime(),
      uptimeFormatted: formatUptime(process.uptime()),
      timestamp: formatUTCDateTime(Date.now()),
      binanceConnected: websocketManager.isConnected(),
      binanceWSStatus: websocketManager.isConnected() ? 'connected' : 'reconnecting',
      deltaConnected: settings.exchange === 'delta',
      deltaMode: settings.deltaMode || 'testnet',
      scannerRunning: scanner.isRunning(),
      lastScanTime: scanner.getLastScanTime(),
      scanHeartbeat: heartbeat,
      coinsScanned: settings.scanCoins || 50,
      openTradesCount: openTrades.length,
      demoBalance,
      autoTradeEnabled: settings.autoTradeEnabled !== false,
      activeTimeframe: settings.timeframe || '4h',
      rateLimitUsed: binanceData.getRateLimitStatus().count,
      rateLimitMax: 1200,
      connectedBrowsers: browserClients.size,
      version: '1.0.0',
      marketStatus: multiMarket.getAllMarketsStatus()
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Issue 1: dedicated heartbeat endpoint
app.get('/api/scanner/heartbeat', (req, res) => {
  try {
    const hb = scanner.getLastAutoScanHeartbeat();
    const now = Date.now();
    res.json({
      ...hb,
      minutesAgo: hb.timestamp ? Math.floor((now - hb.timestamp) / 60000) : null,
      secondsAgo: hb.timestamp ? Math.floor((now - hb.timestamp) / 1000)  : null
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/scanner', async (req, res) => {
  try {
    const settings    = await storage.loadSettings();
    const openTrades  = scanner.getOpenTrades();
    const inMemory    = scanner.getScannerState();
    const coins       = (inMemory && inMemory.length > 0) ? inMemory : await storage.getAllCoinStates();
    res.json({
      lastUpdated: formatUTCDateTime(Date.now()),
      timeframe: settings.timeframe || '4h',
      coins: coins || [],
      openTradesCount: openTrades.length,
      heartbeat: scanner.getLastAutoScanHeartbeat()
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/scanner/scan-now', async (req, res) => {
  try {
    const coins = await scanner.forceScan();
    res.json({ success: true, count: coins.length, timestamp: formatUTCDateTime(Date.now()), heartbeat: scanner.getLastAutoScanHeartbeat() });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.get('/api/signals', async (req, res) => {
  try {
    const { exchange, timeframe, direction, result, pattern, coin, page = 1, limit = 50 } = req.query;
    const signals = await storage.getSignals({ exchange, timeframe, direction, result, pattern, coin });

    const pNum = parseInt(page), lNum = parseInt(limit);
    const total = signals.length;
    const paginated = signals.slice((pNum - 1) * lNum, pNum * lNum);

    const tradesFired = signals.filter(s => s.tradeFired).length;
    const wins        = signals.filter(s => s.tradePnL > 0).length;
    const totalPnL    = signals.reduce((acc, s) => acc + (s.tradePnL || 0), 0);

    res.json({
      total, page: pNum, limit: lNum, pages: Math.ceil(total / lNum) || 1,
      summary: {
        totalSignals: total, tradesFired, skipped: total - tradesFired,
        winRate: tradesFired > 0 ? Math.round((wins / tradesFired) * 100 * 10) / 10 : 0,
        avgPnL: tradesFired > 0 ? Math.round((totalPnL / tradesFired) * 100) / 100 : 0
      },
      signals: paginated
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/trades/open', async (req, res) => {
  try {
    const trades = scanner.getOpenTrades();
    const totalUnrealizedPnL = trades.reduce((sum, t) => sum + (t.unrealizedPnL || 0), 0);
    res.json({
      count: trades.length,
      trades: trades.map(t => ({
        ...t,
        durationFormatted: `${Math.floor((Date.now() - t.openedAt) / 3600000)}h ${Math.floor(((Date.now() - t.openedAt) % 3600000) / 60000)}m`
      })),
      totalUnrealizedPnL: Math.round(totalUnrealizedPnL * 100) / 100
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/trades/closed', async (req, res) => {
  try {
    const tradesObj = await storage.loadTrades();
    const closed    = tradesObj.closed || [];
    const wins      = closed.filter(t => t.realizedPnL > 0);
    const losses    = closed.filter(t => t.realizedPnL <= 0);
    const totalPnL  = closed.reduce((a, b) => a + (b.realizedPnL || 0), 0);
    res.json({
      total: closed.length, trades: closed,
      summary: {
        totalTrades: closed.length, wins: wins.length, losses: losses.length,
        winRate: closed.length > 0 ? Math.round((wins.length / closed.length) * 100 * 10) / 10 : 0,
        totalPnL: Math.round(totalPnL * 100) / 100,
        avgWin:  wins.length   > 0 ? Math.round((wins.reduce((a,b)=>a+b.realizedPnL,0)  / wins.length) * 100) / 100 : 0,
        avgLoss: losses.length > 0 ? Math.round((losses.reduce((a,b)=>a+b.realizedPnL,0) / losses.length) * 100) / 100 : 0
      }
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Issue 3: clean trade log with entry/exit/P&L/timeframe/conditions
app.get('/api/trades/log', async (req, res) => {
  try {
    const tradesObj  = await storage.loadTrades();
    const allClosed  = (tradesObj.closed || []).slice(0, 200); // newest first (closeTrade unshifts)
    const allOpen    = scanner.getOpenTrades();

    const formatTrade = (t) => ({
      id:          t.id,
      symbol:      t.symbol,
      direction:   t.direction,
      timeframeUsed: t.timeframeUsed || t.timeframe || '?',
      exchange:    t.exchange || 'binance',
      entryPrice:  t.entryPrice,
      entryTime:   t.openedAtUTC,
      exitPrice:   t.exitPrice || null,
      exitTime:    t.closedAtUTC || null,
      exitReason:  t.outcome || null,
      realizedPnL: t.realizedPnL || 0,
      pnlPercent:  t.pnlPercent || (t.positionValue > 0
        ? Math.round((t.realizedPnL / t.positionValue) * 100 * 100) / 100
        : 0),
      positionValue: t.positionValue,
      leverage:    t.leverage,
      status:      t.status,
      strategyConditions: {
        gate1: t.gate1, gate2: t.gate2, gate3: t.gate3, gate4: t.gate4,
        trigger: t.trigger, wmPattern: t.wmPattern || null,
        scoreAtEntry: t.scoreAtEntry
      }
    });

    const openLog   = allOpen.map(t => ({ ...formatTrade(t), status: 'OPEN' }));
    const closedLog = allClosed.map(formatTrade);

    res.json({
      total: closedLog.length + openLog.length,
      openCount: openLog.length,
      closedCount: closedLog.length,
      trades: [...openLog, ...closedLog]
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/trades/close', async (req, res) => {
  try {
    const { tradeId } = req.body;
    if (!tradeId) return res.status(400).json({ success: false, error: 'tradeId required' });
    const closedTrade = await scanner.manualCloseTrade(tradeId);
    if (!closedTrade) return res.status(404).json({ success: false, error: 'Trade not found' });
    const demoBalance = await storage.getDemoBalance();
    res.json({
      success: true, trade: closedTrade,
      exitPrice: closedTrade.exitPrice, exitTime: closedTrade.closedAtUTC,
      realizedPnL: closedTrade.realizedPnL, pnlPercent: closedTrade.pnlPercent,
      newBalance: demoBalance
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.get('/api/balance', async (req, res) => {
  try {
    const demoBalance = await storage.getDemoBalance();
    const settings    = await storage.loadSettings();
    let deltaLiveBalance = null;
    if (settings.exchange === 'delta' && process.env.DELTA_API_KEY) {
      const deltaRes = await deltaExchange.getBalance();
      if (Array.isArray(deltaRes)) deltaLiveBalance = deltaRes;
    }
    res.json({
      demoBalance, startingBalance: 10000,
      totalPnL:    Math.round((demoBalance - 10000) * 100) / 100,
      totalPnLPct: Math.round(((demoBalance - 10000) / 10000) * 100 * 100) / 100,
      deltaLiveBalance, deltaMode: settings.deltaMode || 'testnet'
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/analytics', async (req, res) => {
  try {
    const summary     = analytics.getSummary();
    const equityCurve = analytics.getEquityCurve();
    const byDirection = analytics.getByDirection();
    const byStrategy  = analytics.getByStrategy();
    const bySymbol    = analytics.getBySymbol(10);
    const streaks     = analytics.getStreakAnalysis();
    res.json({
      equityCurve, winLossRatio: { wins: summary.wins, losses: summary.losses, winRate: summary.winRate },
      byDirection, byTrigger: byStrategy, topCoins: bySymbol.top, bottomCoins: bySymbol.bottom,
      maxDrawdown: summary.maxDrawdown, sharpeRatio: summary.sharpeRatio, profitFactor: summary.profitFactor,
      avgRR: summary.avgRR, avgTradeDuration: summary.avgTradeDuration, expectancy: summary.expectancy,
      bestTrade: summary.bestTrade, worstTrade: summary.worstTrade,
      totalPnL: summary.totalPnL, totalTrades: summary.totalTrades, streaks
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/analytics/summary',      (req, res) => { try { res.json(analytics.getSummary()); } catch (err) { res.status(500).json({ error: err.message }); } });
app.get('/api/analytics/equity-curve', (req, res) => { try { res.json(analytics.getEquityCurve(parseInt(req.query.days)||90)); } catch (err) { res.status(500).json({ error: err.message }); } });
app.get('/api/analytics/by-strategy',  (req, res) => { try { res.json(analytics.getByStrategy()); } catch (err) { res.status(500).json({ error: err.message }); } });
app.get('/api/analytics/by-symbol',    (req, res) => { try { res.json(analytics.getBySymbol(parseInt(req.query.limit)||20)); } catch (err) { res.status(500).json({ error: err.message }); } });
app.get('/api/analytics/by-direction', (req, res) => { try { res.json(analytics.getByDirection()); } catch (err) { res.status(500).json({ error: err.message }); } });
app.get('/api/analytics/recent',       (req, res) => { try { res.json(analytics.getRecentTrades(parseInt(req.query.limit)||20)); } catch (err) { res.status(500).json({ error: err.message }); } });
app.get('/api/analytics/events',       (req, res) => { try { res.json(analytics.getBotEvents(req.query.type||null, parseInt(req.query.limit)||50)); } catch (err) { res.status(500).json({ error: err.message }); } });
app.get('/api/analytics/streaks',      (req, res) => { try { res.json(analytics.getStreakAnalysis()); } catch (err) { res.status(500).json({ error: err.message }); } });

app.get('/health', (req, res) => {
  res.json({
    status: 'ok', uptime: process.uptime(),
    uptimeFormatted: formatUptime(process.uptime()),
    timestamp: new Date().toISOString(),
    memory: process.memoryUsage(),
    scannerRunning: scanner.isRunning(),
    dbConnected: !!db.getDb(),
    scanHeartbeat: scanner.getLastAutoScanHeartbeat()
  });
});

app.get('/api/candles', async (req, res) => {
  try {
    const { symbol = 'BTCUSDT', timeframe = '4h', limit = 300 } = req.query;
    const candles = await binanceData.getCandles(symbol, timeframe, parseInt(limit));
    const closes = candles.map(c => c.close), highs = candles.map(c => c.high),
          lows = candles.map(c => c.low), volumes = candles.map(c => c.volume);
    const ema9   = indicators.calculateEMA(closes, 9);
    const ema55  = indicators.calculateEMA(closes, 55);
    const ema200 = indicators.calculateEMA(closes, 200);
    const rsi    = indicators.calculateRSI(closes, 14);
    const macd   = indicators.calculateMACD(closes);
    const adxObj = indicators.calculateADX(highs, lows, closes, 14);
    const stObj  = indicators.calculateSuperTrend(highs, lows, closes, 10, 3.0);
    const vwap   = indicators.calculateVWAP(highs, lows, closes, volumes);
    const fib    = indicators.calculateFibonacci(closes, 100);
    const sr     = indicators.detectSupportResistance(highs, lows, 200);
    const openTrade = scanner.getOpenTrades().find(t => t.symbol === symbol && t.status === 'OPEN') || null;
    res.json({
      symbol, timeframe,
      candles: candles.map(c => ({ time: Math.floor(c.openTime/1000), open: c.open, high: c.high, low: c.low, close: c.close, volume: c.volume })),
      indicators: { ema9, ema55, ema200, rsi, macdLine: macd.macdLine, macdSignal: macd.signalLine, macdHist: macd.histogram,
        adx: new Array(candles.length).fill(adxObj.adx), pdi: new Array(candles.length).fill(adxObj.pdi),
        mdi: new Array(candles.length).fill(adxObj.mdi), supertrend: stObj.values, supertrendDir: stObj.directions, vwap },
      fibonacci: fib, supportResistance: sr, openTrade
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/funding', async (req, res) => {
  try {
    const rates = await binanceData.getFundingRates();
    res.json({ fetchedAt: formatUTCDateTime(Date.now()), rates });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/settings', async (req, res) => {
  try {
    const settings = await storage.loadSettings();
    res.json({ success: true, settings });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.post('/api/settings', async (req, res) => {
  try {
    const updated = await applySettingsUpdate(req.body);
    res.json({ success: true, settings: updated, message: "Settings saved and backend engine synced." });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.post('/api/telegram/test', async (req, res) => {
  try {
    const { botToken, chatId } = req.body;
    const result = await telegram.sendTestAlert(botToken, chatId);
    if (result.success) res.json({ success: true, message: 'Test message sent', sentAt: formatUTCDateTime(Date.now()) });
    else res.status(400).json({ success: false, error: result.error });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.post('/api/delta/connect', async (req, res) => {
  try { res.json(await deltaExchange.testConnection()); }
  catch (err) { res.status(500).json({ connected: false, error: err.message }); }
});

app.get('/api/delta/positions', async (req, res) => {
  try {
    const positions = await deltaExchange.getOpenPositions();
    res.json({ mode: process.env.DELTA_MODE || 'testnet', positions, fetchedAt: formatUTCDateTime(Date.now()) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Section 1: WS tick-age diagnostic ────────────────────────────
app.get('/api/ws/status', (req, res) => {
  const ageMs = websocketManager.getLastTickAge();
  const freshnessStatus = websocketManager.getFreshnessStatus();
  res.json({
    connected:    websocketManager.isConnected(),
    lastTickAgeMs: ageMs,
    lastTickAgeSec: ageMs !== null ? Math.round(ageMs / 1000) : null,
    freshnessStatus: freshnessStatus,
    stale:        ageMs !== null && ageMs > 15000,
    priceFeed:    websocketManager.getPriceFeedProvider(),
  });
});

app.get('/api/price-feed/source', (req, res) => {
  res.json(websocketManager.getPriceFeedProvider());
});

app.post('/api/price-feed/source', (req, res) => {
  const { provider } = req.body || {};
  if (['auto', 'binance', 'bybit', 'coinbase'].includes(provider)) {
    websocketManager.setPriceFeedProvider(provider);
    res.json({ success: true, ...websocketManager.getPriceFeedProvider() });
  } else {
    res.status(400).json({ error: 'Invalid provider. Must be auto, binance, bybit, or coinbase' });
  }
});

// ── Section 3: Strategy presets ───────────────────────────────────
app.get('/api/strategy/presets', (req, res) => {
  res.json({ presets: strategyPresets.listPresets() });
});

app.post('/api/strategy/preset/apply', async (req, res) => {
  try {
    const { presetId } = req.body;
    if (!presetId) return res.status(400).json({ error: 'presetId required' });
    const patch = strategyPresets.getPresetParams(presetId);
    const current  = await storage.loadSettings();
    const updated  = { ...current, ...patch };
    await storage.saveSettings(updated);
    scanner.updateSettings(updated);
    res.json({ success: true, preset: presetId, params: patch });
  } catch (err) { res.status(400).json({ success: false, error: err.message }); }
});

// ── Section 5: Analytics insights (JSON-storage fallback) ─────────
app.get('/api/analytics/insights', async (req, res) => {
  try {
    const tradesObj = await storage.loadTrades();
    const closed    = tradesObj.closed || [];
    const insights  = analytics.getInsightsFromTrades(closed);
    const equity    = analytics.getEquityCurveFromTrades(closed, tradesObj.demoBalance || 10000);
    const wins  = closed.filter(t => (t.realizedPnL ?? 0) > 0);
    const losses= closed.filter(t => (t.realizedPnL ?? 0) <= 0);
    const totalPnL = closed.reduce((s, t) => s + (t.realizedPnL ?? 0), 0);
    const avgWin  = wins.length  ? wins.reduce( (s, t) => s + (t.realizedPnL ?? 0), 0) / wins.length  : 0;
    const avgLoss = losses.length ? Math.abs(losses.reduce((s, t) => s + (t.realizedPnL ?? 0), 0) / losses.length) : 0;
    const best  = closed.length ? Math.max(...closed.map(t => t.realizedPnL ?? 0)) : 0;
    const worst = closed.length ? Math.min(...closed.map(t => t.realizedPnL ?? 0)) : 0;
    res.json({
      insights,
      equity,
      summary: {
        totalTrades: closed.length,
        wins:    wins.length,
        losses:  losses.length,
        winRate: closed.length ? +(wins.length / closed.length * 100).toFixed(1) : 0,
        totalPnL: +totalPnL.toFixed(2),
        avgWin:   +avgWin.toFixed(2),
        avgLoss:  +avgLoss.toFixed(2),
        bestTrade:  +best.toFixed(2),
        worstTrade: +worst.toFixed(2),
      },
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── Section 6: Exchange key management ───────────────────────────
app.get('/api/exchange/status', async (req, res) => {
  try { res.json(await exchangeKeys.getExchangeStatus()); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/exchange/keys', async (req, res) => {
  try {
    const { exchange, apiKey, apiSecret, mode } = req.body;
    if (!exchange || !apiKey || !apiSecret) return res.status(400).json({ error: 'exchange, apiKey and apiSecret required' });
    await exchangeKeys.setExchangeKeys(exchange, apiKey, apiSecret, mode || 'demo');
    res.json({ success: true, exchange, mode: mode || 'demo' });
  } catch (err) { res.status(400).json({ success: false, error: err.message }); }
});

app.post('/api/exchange/test', async (req, res) => {
  try {
    const { exchange, apiKey, apiSecret, mode = 'demo' } = req.body;
    if (!exchange || !apiKey || !apiSecret) return res.status(400).json({ error: 'exchange, apiKey and apiSecret required' });
    const result = await exchangeKeys.testConnection(exchange, apiKey, apiSecret, mode);
    res.json(result);
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

app.delete('/api/exchange/keys/:exchange', async (req, res) => {
  try {
    await exchangeKeys.clearExchangeKeys(req.params.exchange);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

// ── Guard & Kill Switch API ───────────────────────────────────────

app.get('/api/guard/status', async (req, res) => {
  try {
    const demoBalance  = await storage.getDemoBalance();
    const dailyPnL     = scanner.getDailyStats().realizedPnL || 0;
    const active       = tradingGuard.getActiveConditions({ dailyPnL, balance: demoBalance });
    res.json({
      killSwitchActive: tradingGuard.isKillSwitchActive(),
      activeConditions: active,
      blocked:          active.length > 0,
      cooldownRemainingMs: tradingGuard.cooldownRemainingMs(),
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/guard/kill-switch/activate', async (req, res) => {
  try {
    await tradingGuard.activateKillSwitch();
    await telegram.sendKillSwitchAlert(true);
    // Force-exit all open trades
    await exitManager.killSwitchExitAll(scanner.getOpenTrades(), async (trade, price, outcome) => {
      const tradesObj = await storage.loadTrades();
      trade.exitPrice   = price;
      trade.outcome     = outcome;
      trade.status      = 'CLOSED';
      trade.closedAt    = Date.now();
      trade.closedAtUTC = formatUTCDateTime(Date.now());
      tradesObj.open    = tradesObj.open.filter(t => t.id !== trade.id);
      tradesObj.closed.unshift(trade);
      await storage.saveTrades(tradesObj);
      broadcast('TRADE_CLOSED', trade);
    });
    broadcast('GUARD_STATE_CHANGED', tradingGuard.getActiveConditions());
    res.json({ success: true, killSwitchActive: true });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

app.post('/api/guard/kill-switch/deactivate', async (req, res) => {
  try {
    await tradingGuard.deactivateKillSwitch();
    await telegram.sendKillSwitchAlert(false);
    broadcast('GUARD_STATE_CHANGED', tradingGuard.getActiveConditions());
    res.json({ success: true, killSwitchActive: false });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

app.get('/api/guard/log', async (req, res) => {
  try {
    const limit = parseInt(req.query.limit) || 100;
    const logs  = await tradingGuard.loadGuardLog(limit);
    res.json({ total: logs.length, logs });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/exit/log', async (req, res) => {
  try {
    const limit = parseInt(req.query.limit) || 100;
    const logs  = await exitManager.loadExitLog(limit);
    res.json({ total: logs.length, logs });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── Multi-market API ──────────────────────────────────────────────

app.get('/api/markets/status', (req, res) => {
  try { res.json(multiMarket.getAllMarketsStatus()); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/markets/:marketId', (req, res) => {
  try {
    const data = multiMarket.getMarketState(req.params.marketId);
    if (!data) return res.status(404).json({ error: 'Market not found' });
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/markets/:marketId/scan-now', async (req, res) => {
  try {
    await multiMarket.forceScanMarket(req.params.marketId);
    const data = multiMarket.getMarketState(req.params.marketId);
    res.json({ success: true, market: req.params.marketId, coinCount: data?.coins?.length || 0, heartbeat: data?.heartbeat });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ── Backtest ──────────────────────────────────────────────────────

let currentBacktestJob = null;
app.post('/api/backtest', async (req, res) => {
  try {
    res.json({ jobId: 'bt-job-1', status: 'started', message: 'Backtest started. Progress via WebSocket.', startedAt: formatUTCDateTime(Date.now()) });
    setTimeout(async () => {
      try {
        const results = await backtest.runBacktest(req.body, (progress) => broadcast('BACKTEST_PROGRESS', progress));
        currentBacktestJob = results;
        broadcast('BACKTEST_COMPLETE', results);
      } catch (err) {
        broadcast('ALERT', { level: 'error', message: 'Backtest failed: ' + err.message });
      }
    }, 100);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/backtest/result', (req, res) => {
  if (currentBacktestJob) res.json(currentBacktestJob);
  else res.status(404).json({ error: 'No backtest results yet' });
});

app.post('/api/trades/test', async (req, res) => {
  try {
    const { symbol = 'BTCUSDT', direction = 'LONG' } = req.body;
    const currentPrice = websocketManager.getCurrentPrice(symbol) || 43300;
    const fakeSignal = {
      id: 'test-sig-1', symbol, timeframe: '4h', direction,
      trigger: 'TEST_TRADE', scoreAtSignal: 88,
      gate1: 'PASS', gate2: 'PASS', gate3: 'PASS', gate4: 'PASS'
    };
    const settings = await storage.loadSettings();
    const trade = tradeManager.createTrade(fakeSignal, currentPrice, 300, {}, settings);
    trade.trigger = 'DEBUG_TEST';
    await storage.saveTrade(trade);
    scanner.getOpenTrades().push(trade);
    broadcast('TRADE_OPENED', trade);
    await telegram.sendTradeOpenedAlert(trade);
    setTimeout(async () => { await scanner.manualCloseTrade(trade.id); }, 60000);
    res.json({ success: true, message: 'Test trade placed, auto-closes in 60s', trade });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Self-ping keepalive
const SELF_URL = 'http://localhost:' + PORT + '/api/status';
setInterval(() => {
  try { http.get(SELF_URL, () => {}).on('error', () => {}); } catch (e) {}
}, 4 * 60 * 1000);

// ── Startup ───────────────────────────────────────────────────────

async function main() {
  console.log('╔══════════════════════════════════════╗');
  console.log('║  AlgoBot Starting — ' + new Date().toISOString() + '  ║');
  console.log('╚══════════════════════════════════════╝');

  await storage.initialize();
  console.log('[✅] Storage initialized');

  await tradingGuard.initialize();
  console.log('[✅] Trading guard initialized');

  // Wire WS status changes into the guard
  websocketManager.setBroadcast((type, data) => {
    if (type === 'SYSTEM_STATUS') {
      if (data.binanceConnected !== undefined) {
        tradingGuard.notifyWebSocketStatus(data.binanceConnected);
      }
    }
    broadcast(type, data);
  });

  tradeLogger.init();
  console.log('[✅] SQLite trade logger initialized');

  const settings = await storage.loadSettings();
  console.log(`[✅] Settings loaded — TF:${settings.timeframe} | Exchange:${settings.exchange} | TG alerts: ${Object.keys(settings.telegram?.alerts||{}).filter(k=>settings.telegram.alerts[k]).length} active`);

  server.listen(PORT, () => {
    console.log('[✅] Server running on port ' + PORT);
  });

  console.log('[⏳] Fetching top coins...');
  const coinList = await binanceData.getTopCoins(settings.scanCoins || 50);
  console.log(`[✅] ${coinList.length} coins loaded`);

  console.log('[⏳] Fetching initial candle data...');
  try {
    // Add timeout to prevent hanging
    const loadPromise = scanner.loadInitialData(coinList, settings);
    const timeoutPromise = new Promise((_, reject) => 
      setTimeout(() => reject(new Error('Candle data load timeout after 30s')), 30000)
    );
    await Promise.race([loadPromise, timeoutPromise]);
    console.log('[✅] Candle data loaded');
  } catch (err) {
    console.error('[SERVER] Candle data load ERROR:', err.message, err.stack);
    // Continue anyway - don't block WebSocket init
    console.log('[SERVER] Continuing with WebSocket init despite candle data error');
  }

  console.log('[SERVER] *** AFTER CANDLE LOAD, BEFORE WEBSOCKET ***');
  console.log('[SERVER] *** BEFORE WEBSOCKET INIT ***');
  console.log('[⏳] Starting WebSocket streams...');
  
  try {
    // setBroadcast already wired at startup with guard routing — don't overwrite
    websocketManager.setOnPriceTick((symbol, price) => {
      scanner.onPriceTick(symbol, price);
      tradingGuard.notifyPriceTick(symbol);
    });
    
    console.log(`[SERVER] About to call startPriceStream with ${coinList.length} symbols`);
    console.log(`[SERVER] startPriceStream function type:`, typeof websocketManager.startPriceStream);
    
    websocketManager.startPriceStream(coinList);
    console.log(`[SERVER] startPriceStream returned`);
    
    websocketManager.startKlineStream(coinList, settings.timeframe || '4h', (sym, closeTime) => {
      scanner.onCandleClose(sym, closeTime);
    });
    console.log('[✅] Binance WebSocket connected');
  } catch (err) {
    console.error('[SERVER] WebSocket initialization ERROR:', err.message, err.stack);
    throw err;
  }

  if (process.env.DELTA_API_KEY) {
    const deltaRes = await deltaExchange.testConnection();
    console.log(deltaRes.connected ? `[✅] Delta Exchange connected (${settings.deltaMode||'testnet'})` : `[⚠️] Delta: ${deltaRes.error}`);
  }

  scanner.start(coinList, settings, (type, data) => broadcast(type, data));
  console.log('[✅] Crypto scanner started (auto-scan every 5 min)');

  const savedTrades = await storage.loadTrades();
  scanner.restoreOpenTrades(savedTrades.open || []);
  console.log(`[✅] Restored ${savedTrades.open?.length || 0} open trades`);

  // Start multi-market scanners
  multiMarket.startAll();
  console.log('[✅] Multi-market scanners started (NSE / Commodities / NASDAQ)');

  // Broadcast guard status every 30 seconds
  setInterval(async () => {
    try {
      const demoBalance = await storage.getDemoBalance();
      const dailyPnL    = scanner.getDailyStats().realizedPnL || 0;
      const conditions  = tradingGuard.getActiveConditions({ dailyPnL, balance: demoBalance });
      broadcast('GUARD_STATE_CHANGED', conditions);
    } catch (e) {}
  }, 30000);

  console.log('════════════════════════════════════════');
  console.log('AlgoBot fully operational ✅');
  console.log('URL: http://localhost:' + PORT);
  console.log('════════════════════════════════════════');
}

main().catch(err => {
  console.error('[FATAL STARTUP ERROR]', err);
  process.exit(1);
});

process.on('SIGTERM', async () => {
  console.log('[SHUTDOWN] Saving state...');
  await storage.saveTrades({ open: scanner.getOpenTrades(), closed: [] });
  db.closeDb();
  process.exit(0);
});

process.on('SIGINT', async () => {
  console.log('[SHUTDOWN] Ctrl+C — saving state...');
  await storage.saveTrades({ open: scanner.getOpenTrades(), closed: [] });
  db.closeDb();
  process.exit(0);
});

process.on('uncaughtException', (err) => { console.error('[UNCAUGHT EXCEPTION]', err.message, err.stack); });
process.on('unhandledRejection', (reason) => { console.error('[UNHANDLED REJECTION]', reason); });
