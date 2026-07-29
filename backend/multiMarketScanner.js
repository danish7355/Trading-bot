/**
 * Multi-Market Scanner
 *
 * Runs independent EMA/RSI/ADX strategy scans for NSE, Commodities, and NASDAQ
 * using Yahoo Finance data. Each market has its own auto-scan timer, heartbeat,
 * and paper-trade ledger — completely independent from the crypto scanner.
 *
 * A failure in one market's scan cannot affect the others or the crypto engine.
 */

const yahooFinance  = require('./yahooFinance');
const strategy      = require('./strategy');
const tradeManager  = require('./tradeManager');
const indicators    = require('./indicators');
const { generateUUID, formatUTCDateTime } = require('./utils');

// ── Market definitions ────────────────────────────────────────────

const MARKET_CONFIGS = {
  nse: {
    name: 'NSE India',
    emoji: '🇮🇳',
    symbols: yahooFinance.getNSESymbols(),
    timeframe: '1d',        // Daily charts for Indian stocks
    defaultSettings: buildSettings('1d')
  },
  commodities: {
    name: 'Commodities',
    emoji: '🥇',
    symbols: yahooFinance.getCommoditySymbols(),
    timeframe: '1d',
    defaultSettings: buildSettings('1d')
  },
  nasdaq: {
    name: 'NASDAQ',
    emoji: '📈',
    symbols: yahooFinance.getNASDAQSymbols(),
    timeframe: '1d',        // Daily charts for US stocks
    defaultSettings: buildSettings('1d')
  }
};

function buildSettings(tf) {
  return {
    timeframe: tf,
    autoTradeEnabled: true,
    autoTradePaused: false,
    ema:    { fast: 9, slow: 55, trend: 200 },
    rsi:    { period: 14, min: 30, max: 70 },
    adx:    { period: 14, threshold: 20 },
    volume: { period: 20, multiplier: 1.3 },  // Lower threshold for stock markets
    trade: {
      positionSizePct: 5, leverage: 1,         // No leverage for stocks
      maxConcurrentTrades: 3, maxRiskPerTradePct: 2,
      tp1AtrMultiple: 2.0, tp1ClosePct: 40,
      tp2AtrMultiple: 3.5, tp2ClosePct: 40, tp3ClosePct: 20,
      trailingStopAtr: 1.0
    },
    wm: { enabled: false }                     // W/M pattern off for stocks by default
  };
}

// ── Per-market state ──────────────────────────────────────────────

const marketState = {};

function initMarketState(marketId) {
  marketState[marketId] = {
    coinData:     {},      // symbol → { candles, lastScanTime }
    scannerState: [],      // evaluated coin list
    openTrades:   [],      // paper trades
    closedTrades: [],
    demoBalance:  10000,
    heartbeat: {
      timestamp: null, status: 'pending',
      durationMs: null, error: null, coinCount: 0
    },
    gateLog:    [],
    dailyStats: { pnl: 0, trades: 0, wins: 0, losses: 0 },
    scanTimer:  null,
    isScanning: false,
    initialized: false
  };
}

Object.keys(MARKET_CONFIGS).forEach(initMarketState);

// ── Broadcast (set by server.js) ──────────────────────────────────

let broadcastFn = () => {};
function setBroadcast(fn) { broadcastFn = fn; }

// ── Core scan for one market ──────────────────────────────────────

async function scanMarket(marketId) {
  const cfg   = MARKET_CONFIGS[marketId];
  const state = marketState[marketId];
  if (!cfg || !state) return;
  if (state.isScanning) { console.log(`[${marketId.toUpperCase()}] Scan already in progress — skipping`); return; }

  state.isScanning = true;
  const startMs    = Date.now();
  state.heartbeat  = { timestamp: Date.now(), status: 'running', durationMs: null, error: null, coinCount: cfg.symbols.length };
  broadcastFn(`MARKET_SCAN_HEARTBEAT`, { market: marketId, heartbeat: state.heartbeat });

  console.log(`[${cfg.emoji} ${cfg.name}] Starting scan — ${cfg.symbols.length} symbols @ ${cfg.timeframe}`);
  let errorCount = 0;

  try {
    // Batch fetches: 3 at a time (Yahoo Finance rate limit courtesy)
    const batchSize = 3;
    for (let i = 0; i < cfg.symbols.length; i += batchSize) {
      const batch = cfg.symbols.slice(i, i + batchSize);
      await Promise.all(batch.map(async (symbol) => {
        try {
          const candles = await yahooFinance.fetchCandles(symbol, cfg.timeframe, 300);
          if (!candles || candles.length < 50) return;
          state.coinData[symbol] = { symbol, candles, lastScanTime: Date.now() };

          const evalResult = await strategy.evaluateCoin(
            symbol, candles, cfg.defaultSettings, state.openTrades, state.settings?.autoTradePaused || false
          );
          if (evalResult) {
            if (evalResult.action === '4GATE_TRADE') {
              await handleMarketTrade(marketId, symbol, evalResult, candles);
            }
            // Log gate evaluation
            state.gateLog.unshift({
              timestamp: Date.now(),
              timeUTC:   formatUTCDateTime(Date.now()),
              symbol, action: evalResult.action,
              reason: evalResult.reason || null
            });
            if (state.gateLog.length > 100) state.gateLog = state.gateLog.slice(0, 100);
          }
        } catch (err) {
          errorCount++;
          console.error(`[${marketId.toUpperCase()} SCAN] ${symbol}:`, err.message);
        }
      }));
      // Polite delay between batches to respect Yahoo Finance rate limits
      await new Promise(r => setTimeout(r, 800));
    }

    // Rebuild scanner state
    state.scannerState = buildMarketScannerState(marketId);

    const durationMs   = Date.now() - startMs;
    state.heartbeat    = {
      timestamp: Date.now(),
      status: errorCount === 0 ? 'ok' : 'error',
      durationMs, error: errorCount > 0 ? `${errorCount} symbol(s) failed` : null,
      coinCount: cfg.symbols.length
    };
    broadcastFn(`MARKET_SCANNER_UPDATE`, { market: marketId, coins: state.scannerState });
    broadcastFn(`MARKET_SCAN_HEARTBEAT`, { market: marketId, heartbeat: state.heartbeat });
    console.log(`[${cfg.emoji} ${cfg.name}] Scan done in ${(durationMs / 1000).toFixed(1)}s${errorCount > 0 ? ` (${errorCount} errors)` : ''}`);

  } catch (err) {
    errorCount++;
    const durationMs = Date.now() - startMs;
    state.heartbeat  = { timestamp: Date.now(), status: 'error', durationMs, error: err.message, coinCount: cfg.symbols.length };
    broadcastFn(`MARKET_SCAN_HEARTBEAT`, { market: marketId, heartbeat: state.heartbeat });
    console.error(`[${marketId.toUpperCase()} SCAN FATAL]`, err.message);
  } finally {
    state.isScanning = false;
  }
}

function buildMarketScannerState(marketId) {
  const cfg    = MARKET_CONFIGS[marketId];
  const state  = marketState[marketId];
  const result = [];

  for (const symbol of cfg.symbols) {
    const data = state.coinData[symbol];
    if (!data || !data.candles || data.candles.length < 50) continue;

    const candles = data.candles;
    const closes  = candles.map(c => c.close);
    const highs   = candles.map(c => c.high);
    const lows    = candles.map(c => c.low);
    const volumes = candles.map(c => c.volume);
    const i       = closes.length - 1;
    const price   = closes[i];

    try {
      const ema9Val  = indicators.calculateEMA(closes, 9)[i]   || price;
      const ema55Val = indicators.calculateEMA(closes, 55)[i]  || price;
      const ema200Val= indicators.calculateEMA(closes, 200)[i] || price;
      const rsiVal   = indicators.calculateRSI(closes, 14)[i];
      const adxObj   = indicators.calculateADX(highs, lows, closes, 14);
      const volSMA   = indicators.calculateVolumeSMA(volumes.slice(0, -1), 20);
      const volRatio = volSMA > 0 ? Math.round((volumes[i] / volSMA) * 10) / 10 : 1.0;

      const g1 = strategy.checkGate1(
        indicators.calculateEMA(closes, 9), indicators.calculateEMA(closes, 55),
        closes, candles, cfg.defaultSettings
      );
      const g2 = strategy.checkGate2(volumes, cfg.defaultSettings);
      const g3 = strategy.checkGate3(highs, lows, closes, adxObj, cfg.defaultSettings);
      const g4 = strategy.checkGate4(indicators.calculateRSI(closes, 14), cfg.defaultSettings);

      const dir      = g1.pass ? g1.direction : (ema9Val > ema55Val ? 'LONG' : 'SHORT');
      const scoreObj = strategy.calculateScore(
        { currentPrice: price, ema9: ema9Val, ema55: ema55Val, ema200: ema200Val,
          rsi: rsiVal, adx: adxObj.adx, pdi: adxObj.pdi, mdi: adxObj.mdi, volumeRatio: volRatio,
          supertrendDirection: 'up' },
        dir, 'WATCHING', cfg.defaultSettings
      );

      const prevClose = closes[i - 1] || price;
      const change1d  = prevClose ? Math.round(((price - prevClose) / prevClose) * 100 * 100) / 100 : 0;

      result.push({
        symbol, displayName: yahooFinance.getDisplayName(symbol),
        price, change24h: change1d,
        score: scoreObj.total, scoreDisplay: scoreObj.scoreDisplay,
        direction: dir,
        status: g1.pass && g2.pass && g3.pass && g4.pass ? 'READY' : 'WATCHING',
        ema9: ema9Val, ema55: ema55Val, ema200: ema200Val,
        emaRelationship: ema9Val > ema55Val ? 'ABOVE' : 'BELOW',
        adx: adxObj.adx, rsi: rsiVal, volumeRatio: volRatio,
        gate1: g1.pass ? 'PASS' : 'FAIL', gate1Direction: g1.direction, gate1FailReason: g1.reason,
        gate2: g2.pass ? 'PASS' : 'FAIL', gate2Value: g2.ratio,        gate2FailReason: g2.reason,
        gate3: g3.pass ? 'PASS' : 'FAIL', gate3ADX: adxObj.adx,        gate3FailReason: g3.reason,
        gate4: g4.pass ? 'PASS' : 'FAIL', gate4RSI: rsiVal,            gate4FailReason: g4.reason,
        isRanging: !g3.pass,
        lastScanTime: data.lastScanTime,
        market: marketId
      });
    } catch (err) {
      console.error(`[${marketId}] buildState error for ${symbol}:`, err.message);
    }
  }

  return result.sort((a, b) => (b.score || 0) - (a.score || 0));
}

async function handleMarketTrade(marketId, symbol, evalResult, candles) {
  const cfg   = MARKET_CONFIGS[marketId];
  const state = marketState[marketId];

  if (!cfg.defaultSettings.autoTradeEnabled || state.settings?.autoTradePaused) return;

  const closes = candles.map(c => c.close);
  const highs  = candles.map(c => c.high);
  const lows   = candles.map(c => c.low);
  const atr    = indicators.calculateATR(highs, lows, closes, 14);

  const signal = evalResult.signal;
  if (!signal) return;

  const entryPrice = closes[closes.length - 1];
  const tradeSettings = {
    ...cfg.defaultSettings,
    demoBalance: state.demoBalance
  };

  const trade = tradeManager.createTrade(signal, entryPrice, atr, {}, tradeSettings);
  trade.market   = marketId;
  trade.exchange = `${marketId}_paper`;

  state.openTrades.push(trade);
  state.dailyStats.trades++;

  broadcastFn('MARKET_TRADE_OPENED', { market: marketId, trade });
  console.log(`[${cfg.emoji} ${cfg.name}] Trade opened: ${symbol} ${trade.direction} @ ${entryPrice}`);
}

// ── Start all market scanners ─────────────────────────────────────

function startAll() {
  Object.keys(MARKET_CONFIGS).forEach(marketId => {
    const cfg   = MARKET_CONFIGS[marketId];
    const state = marketState[marketId];

    console.log(`[MULTI-MARKET] Starting ${cfg.emoji} ${cfg.name} scanner`);

    // Initial scan after staggered delay (avoid Yahoo Finance rate-limiting all at once)
    const staggerMs = Object.keys(MARKET_CONFIGS).indexOf(marketId) * 15000;
    setTimeout(() => {
      scanMarket(marketId).catch(err => console.error(`[${marketId}] Initial scan error:`, err.message));
    }, staggerMs + 5000);

    // Then every 5 minutes
    state.scanTimer = setInterval(() => {
      scanMarket(marketId).catch(err => {
        console.error(`[${marketId}] Periodic scan error:`, err.message);
        state.heartbeat = { timestamp: Date.now(), status: 'error', durationMs: null, error: err.message, coinCount: cfg.symbols.length };
        broadcastFn(`MARKET_SCAN_HEARTBEAT`, { market: marketId, heartbeat: state.heartbeat });
      });
    }, 5 * 60 * 1000);
  });
}

// ── Public getters ────────────────────────────────────────────────

function getMarketState(marketId) {
  const state = marketState[marketId];
  if (!state) return null;
  return {
    coins:       state.scannerState,
    openTrades:  state.openTrades,
    closedTrades: state.closedTrades,
    heartbeat:   state.heartbeat,
    demoBalance: state.demoBalance,
    dailyStats:  state.dailyStats,
    gateLog:     state.gateLog.slice(0, 50)
  };
}

function getAllMarketsStatus() {
  const result = {};
  Object.keys(MARKET_CONFIGS).forEach(marketId => {
    const state = marketState[marketId];
    const cfg   = MARKET_CONFIGS[marketId];
    result[marketId] = {
      name:       cfg.name,
      emoji:      cfg.emoji,
      timeframe:  cfg.timeframe,
      heartbeat:  state.heartbeat,
      coinsCount: state.scannerState.length,
      openTrades: state.openTrades.length,
      readyCoins: state.scannerState.filter(c => c.status === 'READY').length
    };
  });
  return result;
}

function forceScanMarket(marketId) {
  return scanMarket(marketId);
}

module.exports = {
  startAll, setBroadcast,
  getMarketState, getAllMarketsStatus,
  forceScanMarket,
  MARKET_CONFIGS
};
