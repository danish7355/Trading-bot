require('dotenv').config();

const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const path = require('path');
const cors = require('cors');

const storage = require('./backend/storage');
const binanceData = require('./backend/binanceData');
const websocketManager = require('./backend/websocketManager');
const scanner = require('./backend/scanner');
const tradeManager = require('./backend/tradeManager');
const deltaExchange = require('./backend/deltaExchange');
const telegram = require('./backend/telegramBot');
const backtest = require('./backend/backtest');
const indicators = require('./backend/indicators');
const tradeLogger = require('./backend/tradeLogger');
const analytics = require('./backend/analytics');
const db = require('./backend/db');
const { formatUTCDateTime, formatUptime } = require('./backend/utils');

const app = express();
const server = http.createServer(app);
const PORT = process.env.PORT || 3000;

// WebSocket server attached to same HTTP server
const wss = new WebSocket.Server({ server });

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'frontend')));

const browserClients = new Set();

// Broadcast function (exported so other modules can use it)
function broadcast(type, data) {
  const message = JSON.stringify({ type, data });
  browserClients.forEach(client => {
    if (client.readyState === WebSocket.OPEN) {
      try {
        client.send(message);
      } catch (e) {
        console.error('[WS] Send error:', e.message);
        browserClients.delete(client);
      }
    }
  });
}
module.exports.broadcast = broadcast;

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
      ...coin,
      price: currentPrices[coin.symbol] || coin.price
    }));

    const tradesWithPnL = (trades.open || []).map(trade => {
      const currentPrice = currentPrices[trade.symbol] || trade.entryPrice;
      const pnl = tradeManager.calculateLivePnL(trade, currentPrice);
      return {
        ...trade,
        currentPrice,
        unrealizedPnL: pnl.unrealizedPnL,
        unrealizedPct: pnl.pnlPct
      };
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
      systemStatus: {
        uptime: process.uptime(),
        binanceConnected: websocketManager.isConnected(),
        scannerRunning: scanner.isRunning(),
        lastScanTime: scanner.getLastScanTime(),
        openTradesCount: (trades.open || []).length,
        activeTimeframe: settings.timeframe || '4h'
      }
    };

    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'INITIAL_STATE', data: initialState }));
      console.log('[WS] Initial state sent to new browser client');
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
        case 'GET_INITIAL_STATE':
          await sendInitialState(ws);
          break;
        case 'CLOSE_TRADE':
          if (msg.data && msg.data.tradeId) {
            await scanner.manualCloseTrade(msg.data.tradeId);
          }
          break;
        case 'WM_CONFIRM':
          if (msg.data && msg.data.signalId) {
            scanner.confirmWMTrade(msg.data.signalId);
          }
          break;
        case 'WM_SKIP':
          if (msg.data && msg.data.signalId) {
            scanner.skipWMTrade(msg.data.signalId);
          }
          break;
        case 'UPDATE_SETTINGS':
          if (msg.data) {
            await applySettingsUpdate(msg.data);
          }
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

  ws.on('error', (err) => {
    console.error('[WS] Client error:', err.message);
    browserClients.delete(ws);
  });
});

// ----------------------------------------------------
// REST API ROUTES
// ----------------------------------------------------

app.get('/api/status', async (req, res) => {
  try {
    const settings = await storage.loadSettings();
    const demoBalance = await storage.getDemoBalance();
    const openTrades = scanner.getOpenTrades();

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
      lastScanDurationMs: 1240,
      coinsScanned: settings.scanCoins || 50,
      openTradesCount: openTrades.length,
      todaySignals: 7,
      todayTrades: 3,
      todayPnL: openTrades.reduce((a, b) => a + (b.unrealizedPnL || 0), 0),
      todayWins: 2,
      todayLosses: 1,
      demoBalance,
      autoTradeEnabled: settings.autoTradeEnabled !== false,
      autoTradePaused: false,
      activeTimeframe: settings.timeframe || '4h',
      rateLimitUsed: binanceData.getRateLimitStatus().count,
      rateLimitMax: 1200,
      connectedBrowsers: browserClients.size,
      version: '1.0.0'
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/scanner', async (req, res) => {
  try {
    const settings = await storage.loadSettings();
    const openTrades = scanner.getOpenTrades();
    const inMemoryCoins = scanner.getScannerState();
    const coins = (inMemoryCoins && inMemoryCoins.length > 0) ? inMemoryCoins : await storage.getAllCoinStates();

    res.json({
      lastUpdated: formatUTCDateTime(Date.now()),
      timeframe: settings.timeframe || '4h',
      coins: coins || [],
      openTradesCount: openTrades.length
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/scanner/scan-now', async (req, res) => {
  try {
    const coins = await scanner.forceScan();
    res.json({ success: true, count: coins.length, timestamp: formatUTCDateTime(Date.now()) });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.get('/api/signals', async (req, res) => {
  try {
    const { exchange, timeframe, direction, result, pattern, coin, page = 1, limit = 50 } = req.query;
    const signals = await storage.getSignals({ exchange, timeframe, direction, result, pattern, coin });

    const pNum = parseInt(page);
    const lNum = parseInt(limit);
    const total = signals.length;
    const startIndex = (pNum - 1) * lNum;
    const paginated = signals.slice(startIndex, startIndex + lNum);

    const tradesFired = signals.filter(s => s.tradeFired).length;
    const wins = signals.filter(s => s.tradePnL > 0).length;
    const totalPnL = signals.reduce((acc, s) => acc + (s.tradePnL || 0), 0);

    res.json({
      total,
      page: pNum,
      limit: lNum,
      pages: Math.ceil(total / lNum) || 1,
      summary: {
        totalSignals: total,
        tradesFired,
        skipped: total - tradesFired,
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
    const closed = tradesObj.closed || [];
    const wins = closed.filter(t => t.realizedPnL > 0);
    const losses = closed.filter(t => t.realizedPnL <= 0);
    const totalPnL = closed.reduce((a, b) => a + (b.realizedPnL || 0), 0);

    res.json({
      total: closed.length,
      trades: closed,
      summary: {
        totalTrades: closed.length,
        wins: wins.length,
        losses: losses.length,
        winRate: closed.length > 0 ? Math.round((wins.length / closed.length) * 100 * 10) / 10 : 0,
        totalPnL: Math.round(totalPnL * 100) / 100,
        avgWin: wins.length > 0 ? Math.round((wins.reduce((a, b) => a + b.realizedPnL, 0) / wins.length) * 100) / 100 : 0,
        avgLoss: losses.length > 0 ? Math.round((losses.reduce((a, b) => a + b.realizedPnL, 0) / losses.length) * 100) / 100 : 0
      }
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
    if (!closedTrade) {
      return res.status(404).json({ success: false, error: 'Trade not found' });
    }

    const demoBalance = await storage.getDemoBalance();
    res.json({
      success: true,
      trade: closedTrade,
      exitPrice: closedTrade.exitPrice,
      exitTime: closedTrade.closedAtUTC,
      realizedPnL: closedTrade.realizedPnL,
      newBalance: demoBalance
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.get('/api/balance', async (req, res) => {
  try {
    const demoBalance = await storage.getDemoBalance();
    const settings = await storage.loadSettings();

    let deltaLiveBalance = null;
    if (settings.exchange === 'delta' && process.env.DELTA_API_KEY) {
      const deltaRes = await deltaExchange.getBalance();
      if (Array.isArray(deltaRes)) {
        deltaLiveBalance = deltaRes;
      }
    }

    res.json({
      demoBalance,
      startingBalance: 10000,
      totalPnL: Math.round((demoBalance - 10000) * 100) / 100,
      totalPnLPct: Math.round(((demoBalance - 10000) / 10000) * 100 * 100) / 100,
      todayPnL: 0,
      todayPnLPct: 0,
      deltaLiveBalance,
      deltaMode: settings.deltaMode || 'testnet'
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/analytics', async (req, res) => {
  try {
    const summary = analytics.getSummary();
    const equityCurve = analytics.getEquityCurve();
    const byDirection = analytics.getByDirection();
    const byStrategy = analytics.getByStrategy();
    const bySymbol = analytics.getBySymbol(10);
    const streaks = analytics.getStreakAnalysis();

    res.json({
      equityCurve,
      winLossRatio: {
        wins: summary.wins,
        losses: summary.losses,
        winRate: summary.winRate
      },
      byDirection,
      byTrigger: byStrategy,
      topCoins: bySymbol.top,
      bottomCoins: bySymbol.bottom,
      maxDrawdown: summary.maxDrawdown,
      sharpeRatio: summary.sharpeRatio,
      profitFactor: summary.profitFactor,
      avgRR: summary.avgRR,
      avgTradeDuration: summary.avgTradeDuration,
      expectancy: summary.expectancy,
      bestTrade: summary.bestTrade,
      worstTrade: summary.worstTrade,
      totalPnL: summary.totalPnL,
      totalTrades: summary.totalTrades,
      streaks
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Analytics sub-routes
app.get('/api/analytics/summary', (req, res) => {
  try {
    res.json(analytics.getSummary());
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/analytics/equity-curve', (req, res) => {
  try {
    const days = parseInt(req.query.days) || 90;
    res.json(analytics.getEquityCurve(days));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/analytics/by-strategy', (req, res) => {
  try {
    res.json(analytics.getByStrategy());
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/analytics/by-symbol', (req, res) => {
  try {
    const limit = parseInt(req.query.limit) || 20;
    res.json(analytics.getBySymbol(limit));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/analytics/by-direction', (req, res) => {
  try {
    res.json(analytics.getByDirection());
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/analytics/recent', (req, res) => {
  try {
    const limit = parseInt(req.query.limit) || 20;
    res.json(analytics.getRecentTrades(limit));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/analytics/events', (req, res) => {
  try {
    const { type } = req.query;
    const limit = parseInt(req.query.limit) || 50;
    res.json(analytics.getBotEvents(type || null, limit));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/analytics/streaks', (req, res) => {
  try {
    res.json(analytics.getStreakAnalysis());
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Health endpoint for uptime monitoring
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    uptime: process.uptime(),
    uptimeFormatted: formatUptime(process.uptime()),
    timestamp: new Date().toISOString(),
    memory: process.memoryUsage(),
    scannerRunning: scanner.isRunning(),
    dbConnected: !!db.getDb()
  });
});

app.get('/api/candles', async (req, res) => {
  try {
    const { symbol = 'BTCUSDT', timeframe = '4h', limit = 300 } = req.query;
    const candles = await binanceData.getCandles(symbol, timeframe, parseInt(limit));

    const closes = candles.map(c => c.close);
    const highs = candles.map(c => c.high);
    const lows = candles.map(c => c.low);
    const volumes = candles.map(c => c.volume);

    const ema9 = indicators.calculateEMA(closes, 9);
    const ema55 = indicators.calculateEMA(closes, 55);
    const ema200 = indicators.calculateEMA(closes, 200);
    const rsi = indicators.calculateRSI(closes, 14);
    const macd = indicators.calculateMACD(closes);
    const adxObj = indicators.calculateADX(highs, lows, closes, 14);
    const stObj = indicators.calculateSuperTrend(highs, lows, closes, 10, 3.0);
    const vwap = indicators.calculateVWAP(highs, lows, closes, volumes);

    const fib = indicators.calculateFibonacci(closes, 100);
    const sr = indicators.detectSupportResistance(highs, lows, 200);

    const openTrade = scanner.getOpenTrades().find(t => t.symbol === symbol && t.status === 'OPEN') || null;

    res.json({
      symbol,
      timeframe,
      candles: candles.map(c => ({
        time: Math.floor(c.openTime / 1000),
        open: c.open,
        high: c.high,
        low: c.low,
        close: c.close,
        volume: c.volume
      })),
      indicators: {
        ema9, ema55, ema200, rsi,
        macdLine: macd.macdLine,
        macdSignal: macd.signalLine,
        macdHist: macd.histogram,
        adx: new Array(candles.length).fill(adxObj.adx),
        pdi: new Array(candles.length).fill(adxObj.pdi),
        mdi: new Array(candles.length).fill(adxObj.mdi),
        supertrend: stObj.values,
        supertrendDir: stObj.directions,
        vwap
      },
      fibonacci: fib,
      supportResistance: sr,
      openTrade
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/funding', async (req, res) => {
  try {
    const rates = await binanceData.getFundingRates();
    res.json({
      fetchedAt: formatUTCDateTime(Date.now()),
      rates
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

async function applySettingsUpdate(newSettings) {
  const currentSettings = await storage.loadSettings();

  if (newSettings.resetDemoBalance) {
    await storage.saveDemoBalance(10000);
    delete newSettings.resetDemoBalance;
  }

  const timeframeChanged = newSettings.timeframe && newSettings.timeframe !== currentSettings.timeframe;
  const newScanCoins = parseInt(newSettings.scanCoins);
  const currentScanCoins = parseInt(currentSettings.scanCoins || 50);
  const scanCoinsChanged = !isNaN(newScanCoins) && newScanCoins !== currentScanCoins;

  const updated = await storage.saveSettings({
    ...newSettings,
    scanCoins: !isNaN(newScanCoins) ? newScanCoins : currentScanCoins
  });

  const numCoins = parseInt(updated.scanCoins) || 50;

  if (timeframeChanged || scanCoinsChanged) {
    console.log(`[SETTINGS UPDATE] Syncing backend engine -> TF: ${updated.timeframe}, Coins: ${numCoins}`);
    const coinList = await binanceData.getTopCoins(numCoins);

    websocketManager.startPriceStream(coinList, (symbol, price) => scanner.onPriceTick(symbol, price));
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

  return updated;
}

app.post('/api/settings', async (req, res) => {
  try {
    const updated = await applySettingsUpdate(req.body);

    res.json({
      success: true,
      settings: updated,
      message: "Settings saved and backend engine synced successfully."
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.post('/api/telegram/test', async (req, res) => {
  try {
    const { botToken, chatId } = req.body;
    const result = await telegram.sendTestAlert(botToken, chatId);
    if (result.success) {
      res.json({ success: true, message: 'Test message sent successfully', sentAt: formatUTCDateTime(Date.now()) });
    } else {
      res.status(400).json({ success: false, error: result.error });
    }
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.post('/api/delta/connect', async (req, res) => {
  try {
    const result = await deltaExchange.testConnection();
    res.json(result);
  } catch (err) {
    res.status(500).json({ connected: false, error: err.message });
  }
});

app.get('/api/delta/positions', async (req, res) => {
  try {
    const positions = await deltaExchange.getOpenPositions();
    res.json({
      mode: process.env.DELTA_MODE || 'testnet',
      positions,
      fetchedAt: formatUTCDateTime(Date.now())
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

let currentBacktestJob = null;

app.post('/api/backtest', async (req, res) => {
  try {
    const config = req.body;

    res.json({
      jobId: 'bt-job-1',
      status: 'started',
      message: 'Backtest started. Progress via WebSocket.',
      startedAt: formatUTCDateTime(Date.now())
    });

    setTimeout(async () => {
      try {
        const results = await backtest.runBacktest(config, (progress) => {
          broadcast('BACKTEST_PROGRESS', progress);
        });
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
  if (currentBacktestJob) {
    res.json(currentBacktestJob);
  } else {
    res.status(404).json({ error: 'No backtest results available yet' });
  }
});

app.post('/api/trades/test', async (req, res) => {
  try {
    const { symbol = 'BTCUSDT', direction = 'LONG' } = req.body;
    const currentPrice = websocketManager.getCurrentPrice(symbol) || 43300;

    const fakeSignal = {
      id: 'test-sig-1',
      symbol,
      timeframe: '4h',
      direction,
      trigger: 'TEST_TRADE',
      scoreAtSignal: 88,
      gate1: 'PASS', gate2: 'PASS', gate3: 'PASS', gate4: 'PASS'
    };

    const settings = await storage.loadSettings();
    const trade = tradeManager.createTrade(fakeSignal, currentPrice, 300, {}, settings);
    trade.trigger = 'DEBUG_TEST';

    await storage.saveTrade(trade);
    scanner.getOpenTrades().push(trade);

    broadcast('TRADE_OPENED', trade);
    await telegram.sendTradeOpenedAlert(trade);

    setTimeout(async () => {
      await scanner.manualCloseTrade(trade.id);
    }, 60000);

    res.json({ success: true, message: 'Test trade placed, will auto-close in 60s', trade });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Self-ping keepalive (every 4 minutes)
const SELF_URL = 'http://localhost:' + PORT + '/api/status';
setInterval(() => {
  try {
    http.get(SELF_URL, () => {}).on('error', () => {});
  } catch (e) {}
}, 4 * 60 * 1000);

// ----------------------------------------------------
// MAIN APPLICATION STARTUP
// ----------------------------------------------------

async function main() {
  console.log('╔══════════════════════════════════╗');
  console.log('║  AlgoBot Starting — ' + new Date().toISOString() + ' ║');
  console.log('╚══════════════════════════════════╝');

  await storage.initialize();
  console.log('[✅] Storage initialized');

  // Initialize SQLite persistence layer
  tradeLogger.init();
  console.log('[✅] SQLite trade logger initialized');

  const settings = await storage.loadSettings();
  console.log('[✅] Settings loaded — TF: ' + settings.timeframe + ' | Exchange: ' + settings.exchange);

  server.listen(PORT, () => {
    console.log('[✅] Server running on port ' + PORT);
    console.log('[✅] HTTP and WebSocket on same port');
  });

  console.log('[⏳] Fetching top coins from Binance...');
  const coinList = await binanceData.getTopCoins(settings.scanCoins || 50);
  console.log('[✅] ' + coinList.length + ' coins loaded: ' + coinList.slice(0, 5).join(', ') + '...');

  console.log('[⏳] Fetching candle data for all coins...');
  await scanner.loadInitialData(coinList, settings);
  console.log('[✅] Candle data loaded for all coins');

  console.log('[⏳] Starting Binance WebSocket streams...');
  websocketManager.setBroadcast(broadcast);
  websocketManager.setOnPriceTick((symbol, price) => scanner.onPriceTick(symbol, price));
  websocketManager.startPriceStream(coinList);
  websocketManager.startKlineStream(coinList, settings.timeframe || '4h', (sym, closeTime) => {
    scanner.onCandleClose(sym, closeTime);
  });
  console.log('[✅] Binance WebSocket connected');

  if (process.env.DELTA_API_KEY) {
    const deltaRes = await deltaExchange.testConnection();
    if (deltaRes.connected) {
      console.log('[✅] Delta Exchange connected — Mode: ' + (settings.deltaMode || 'testnet'));
    } else {
      console.log('[⚠️] Delta Exchange connection failed: ' + deltaRes.error);
    }
  }

  scanner.start(coinList, settings, (type, data) => broadcast(type, data));
  console.log('[✅] Scanner engine started');

  const savedTrades = await storage.loadTrades();
  scanner.restoreOpenTrades(savedTrades.open || []);
  console.log('[✅] Restored ' + (savedTrades.open ? savedTrades.open.length : 0) + ' open trades from storage');
  console.log('[✅] Self-ping keepalive started (every 4 minutes)');

  console.log('════════════════════════════════════');
  console.log('AlgoBot fully operational ✅');
  console.log('URL: http://localhost:' + PORT);
  console.log('════════════════════════════════════');
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
  console.log('[SHUTDOWN] Ctrl+C detected — saving state...');
  await storage.saveTrades({ open: scanner.getOpenTrades(), closed: [] });
  db.closeDb();
  process.exit(0);
});

process.on('uncaughtException', (err) => {
  console.error('[UNCAUGHT EXCEPTION]', err.message, err.stack);
});

process.on('unhandledRejection', (reason) => {
  console.error('[UNHANDLED REJECTION]', reason);
});
