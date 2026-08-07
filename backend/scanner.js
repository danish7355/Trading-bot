const binanceData    = require('./binanceData');
const strategy       = require('./strategy');
const strategyV2     = require('./strategy_v2');
const strategyV3     = require('./strategy_v3');
const tradeManager   = require('./tradeManager');

function getActiveStrategyEngineName() {
  return settingsRef.strategyEngine || (settingsRef.activePreset === 'smc-confluence' ? 'v3' : settingsRef.activePreset === 'smc-structure' ? 'v2' : 'v1');
}
function getEngineByName(name) {
  if (name === 'v3') return strategyV3;
  if (name === 'v2') return strategyV2;
  return strategy;
}
function getActiveStrategyEngine() { return getEngineByName(getActiveStrategyEngineName()); }
const deltaExchange  = require('./deltaExchange');
const telegram       = require('./telegramBot');
const storage        = require('./storage');
const indicators     = require('./indicators');
const websocketManager = require('./websocketManager');
const { sleep, calculateCandlesOpen, formatUTCDateTime, getSessionBadge } = require('./utils');
const tradeLogger    = require('./tradeLogger');
const tradingGuard   = require('./tradingGuard');
const exitManager    = require('./exitManager');

let coinData        = {};
let scannerState    = [];
let openTrades      = [];
let gateLog         = [];
let dailyStats      = { pnl: 0, trades: 0, wins: 0, losses: 0 };
let autoTradePaused = false;
let wmSkippedMap    = {};

let settingsRef         = {};
let broadcastFn         = () => {};
let isScannerRunning    = false;
let lastScanTimeMs      = 0;
let activeCoinList      = [];
let fullScanTimer       = null;
let isFullScanInProgress = false;

// ── Issue 1: scan heartbeat ───────────────────────────────────────
let lastAutoScanHeartbeat = {
  timestamp: null,
  status: 'pending',   // 'running' | 'ok' | 'error' | 'pending'
  durationMs: null,
  error: null,
  coinCount: 0
};

function getLastAutoScanHeartbeat() { return lastAutoScanHeartbeat; }

// ── Issue 2: live settings update ─────────────────────────────────
function updateSettings(newSettings) {
  const oldTF = settingsRef.timeframe;
  settingsRef = { ...settingsRef, ...newSettings };
  tradingGuard.setSettings(settingsRef);
  exitManager.setSettings(settingsRef);
  if (newSettings.timeframe && newSettings.timeframe !== oldTF && activeCoinList.length) {
    websocketManager.restartKlineStream(activeCoinList, settingsRef.timeframe, onCandleClose);
  }
  console.log(`[SCANNER] Settings updated live — TF: ${settingsRef.timeframe}, AutoTrade: ${settingsRef.autoTradeEnabled}`);
}

async function loadInitialData(coinList, settings) {
  settingsRef    = settings;
  activeCoinList = coinList;
  const batchSize = 5;

  for (let i = 0; i < coinList.length; i += batchSize) {
    const batch = coinList.slice(i, i + batchSize);
    await Promise.all(batch.map(async (symbol) => {
      try {
        const candles = await binanceData.getCandles(symbol, settings.timeframe || '4h', 300);
        coinData[symbol] = { symbol, candles, lastScanTime: Date.now() };
      } catch (err) {
        console.error(`[LOAD] Failed to load ${symbol}:`, err.message);
      }
    }));
    await sleep(100);
  }
  recalculateScannerState();
}

function recalculateScannerState() {
  const coinsArr  = [];
  const targetList = (activeCoinList && activeCoinList.length > 0) ? activeCoinList : Object.keys(coinData);

  targetList.forEach(symbol => {
    const data = coinData[symbol];
    if (!data) return;
    const candles = data.candles || [];
    if (candles.length < 50) return;

    const closes  = candles.map(c => c.close);
    const highs   = candles.map(c => c.high);
    const lows    = candles.map(c => c.low);
    const volumes = candles.map(c => c.volume);
    const i       = closes.length - 1;
    const livePrice = latestPrices[symbol] || websocketManager.getCurrentPrice(symbol) || closes[i];
    const change24h = websocketManager.getChange24h(symbol) || 0;

    const ema9Val  = indicators.calculateEMA(closes, 9)[i]   || livePrice;
    const ema55Val = indicators.calculateEMA(closes, 55)[i]  || livePrice;
    const ema200Val= indicators.calculateEMA(closes, 200)[i] || livePrice;
    const rsiVal   = indicators.calculateRSI(closes, 14)[i];
    const adxObj   = indicators.calculateADX(highs, lows, closes, 14);
    const volSMA   = indicators.calculateVolumeSMA(volumes.slice(0, -1), 20);
    const volRatio = volSMA ? Math.round((volumes[i] / volSMA) * 10) / 10 : 1.0;
    const stObj    = indicators.calculateSuperTrend(highs, lows, closes, 10, 3.0);
    const stDir    = stObj.directions[i] || 'up';

    const g1 = strategy.checkGate1(
      indicators.calculateEMA(closes, 9),
      indicators.calculateEMA(closes, 55),
      closes, candles
    );
    const g2 = strategy.checkGate2(volumes, settingsRef);
    const g3 = strategy.checkGate3(highs, lows, closes, adxObj, settingsRef);
    const g4 = strategy.checkGate4(indicators.calculateRSI(closes, 14), settingsRef);
    const dir = g1.pass ? g1.direction : (ema9Val > ema55Val ? 'LONG' : 'SHORT');
    const macdRes = indicators.calculateMACD(closes);
    const atrVal = indicators.calculateATR(highs, lows, closes, 14);
    const g5 = strategy.checkGate5_Liquidity(volumes, closes, settingsRef);
    const g6 = strategy.checkGate6_Spread(livePrice, settingsRef);
    const g7 = strategy.checkGate7_Volatility(highs, lows, closes, settingsRef);
    const g8 = strategy.checkGate8_Momentum(macdRes, dir);
    const g9 = strategy.checkGate9_Structure(stDir, dir);
    const g10 = strategy.checkGate10_RiskReward(livePrice, atrVal, dir, settingsRef);
    const gates = { g1, g2, g3, g4, g5, g6, g7, g8, g9, g10 };
    Object.assign(gates, strategy.evaluateGateSystem(gates));

    const isRanging  = !g3.pass;
    const wmStateObj = strategy.getWMState(symbol);
    const statusBadges = [];
    if (wmStateObj.state === 'READY')   statusBadges.push('W_READY');
    else if (wmStateObj.state === 'FORMING') statusBadges.push('W_FORMING');
    if (isRanging) statusBadges.push('RANGING');
    if (gates.mandatoryPassed && gates.confirmationPassed) statusBadges.push('ALL_GATES_PASS');

    const indObj = {
      currentPrice: livePrice, ema9: ema9Val, ema55: ema55Val, ema200: ema200Val,
      rsi: rsiVal, adx: adxObj.adx, pdi: adxObj.pdi, mdi: adxObj.mdi,
      volumeRatio: volRatio, supertrendDirection: stDir
    };
    const scoreObj = strategy.calculateScore(indObj, dir, wmStateObj.state, settingsRef);

    coinsArr.push({
      symbol, price: livePrice, change24h,
      score: scoreObj.total, scoreDisplay: scoreObj.scoreDisplay,
      direction: dir,
      status: gates.mandatoryPassed && gates.confirmationPassed ? 'READY' : 'WATCHING',
      statusBadges,
      ema9: ema9Val, ema55: ema55Val, ema200: ema200Val,
      emaRelationship: ema9Val > ema55Val ? 'ABOVE' : 'BELOW',
      adx: adxObj.adx, pdi: adxObj.pdi, mdi: adxObj.mdi, rsi: rsiVal,
      volumeRatio: volRatio, fundingRate: 0.01, supertrendDirection: stDir,
      gate1: g1.pass ? 'PASS' : 'FAIL', gate1Direction: g1.direction, gate1FailReason: g1.reason,
      gate2: g2.pass ? 'PASS' : 'FAIL', gate2Value: g2.ratio,       gate2FailReason: g2.reason,
      gate3: g3.pass ? 'PASS' : 'FAIL', gate3ADX: adxObj.adx,       gate3FailReason: g3.reason,
      gate4: g4.pass ? 'PASS' : 'FAIL', gate4RSI: rsiVal,           gate4FailReason: g4.reason,
      gate5: g5.pass ? 'PASS' : 'FAIL', gate5FailReason: g5.reason,
      gate6: g6.pass ? 'PASS' : 'FAIL', gate6FailReason: g6.reason,
      gate7: g7.pass ? 'PASS' : 'FAIL', gate7FailReason: g7.reason,
      gate8: g8.pass ? 'PASS' : 'FAIL', gate8FailReason: g8.reason,
      gate9: g9.pass ? 'PASS' : 'FAIL', gate9FailReason: g9.reason,
      gate10: g10.pass ? 'PASS' : 'FAIL', gate10FailReason: g10.reason,
      mandatoryPassed: gates.mandatoryPassed,
      confirmationPassed: gates.confirmationPassed,
      confirmationCount: gates.confirmationCount,
      wmState: wmStateObj.state, wmType: wmStateObj.type,
      wmV1: wmStateObj.v1Price, wmNeckline: wmStateObj.necklinePrice, wmV2: wmStateObj.v2Price,
      isRanging, sessionBadge: getSessionBadge()
    });
  });

  scannerState  = coinsArr;
  lastScanTimeMs = Date.now();
  storage.saveCoinStates(coinsArr).catch(err => console.error('[STORAGE SAVE ERROR]', err.message));
}

function logGateEvaluation(symbol, result, closeTime) {
  gateLog.push({
    timestamp: Date.now(),
    timeUTC:   formatUTCDateTime(closeTime || Date.now()),
    symbol,
    action: result.action,
    reason: result.reason || result.gate1Fail || null,
    score:  result.score?.total || null
  });
  if (gateLog.length > 200) gateLog = gateLog.slice(-200);
}

async function onCandleClose(symbol, closeTime) {
  if (!coinData[symbol]) return;
  try {
    // Always use the live settingsRef timeframe — not a cached value
    const tf = settingsRef.timeframe || '4h';
    const newCandles = await binanceData.getCandles(symbol, tf, 300);
    if (newCandles.length > 0) {
      coinData[symbol].candles = newCandles;
    }

    // Section 4: exitManager only manages v1 trades — v2/v3 own their exit via watchdog below
    const hasOpenV1Trades = openTrades.some(t => t.symbol === symbol && t.status === 'OPEN' && (t.strategyEngine || 'v1') === 'v1');
    if (hasOpenV1Trades) {
      const candles = coinData[symbol].candles;
      const highs  = candles.map(c => c.high);
      const lows   = candles.map(c => c.low);
      const closes = candles.map(c => c.close);
      const atr    = indicators.calculateATR(highs, lows, closes, 14);
      const v1Trades = openTrades.filter(t => (t.strategyEngine || 'v1') === 'v1');
      await exitManager.runExitEvaluationsForSymbol(
        v1Trades,
        symbol,
        {
          candles,
          atr,
          fundingRate:    0,
          oiDropPct:      0,
          killSwitchActive: tradingGuard.isKillSwitchActive(),
        },
        finishCloseTrade,
        storage.saveTrade
      );
    }

    // Watchdog check for v2/v3 trades — dispatched by the ENGINE THAT OPENED EACH TRADE,
    // not whichever engine happens to be globally selected right now. A confirmed reversal
    // signal closes the position immediately (this IS v2/v3's exit method).
    const watchdogTrades = openTrades.filter(t => t.symbol === symbol && t.status === 'OPEN' && (t.strategyEngine === 'v2' || t.strategyEngine === 'v3'));
    for (const trade of watchdogTrades) {
      const engine = getEngineByName(trade.strategyEngine);
      const alert = engine.watchdogCheck ? engine.watchdogCheck(trade, coinData[symbol].candles) : null;
      if (alert) {
        console.warn(`[WATCHDOG] ${alert.message}`);
        broadcastFn('WATCHDOG_ALERT', alert);
        const exitPrice = websocketManager.getCurrentPrice(symbol) || trade.currentPrice || trade.entryPrice;
        let pnl = ((exitPrice - trade.entryPrice) / trade.entryPrice) * trade.positionValue * trade.leverage * trade.remainingPct;
        if (trade.direction === 'SHORT') pnl = ((trade.entryPrice - exitPrice) / trade.entryPrice) * trade.positionValue * trade.leverage * trade.remainingPct;
        trade.realizedPnL += pnl;
        await finishCloseTrade(trade, exitPrice, 'WATCHDOG_EXIT');
      }
    }

    const result = await getActiveStrategyEngine().evaluateCoin(
      symbol, coinData[symbol].candles, settingsRef, openTrades, autoTradePaused
    );
    if (!result) return;

    logGateEvaluation(symbol, result, closeTime);
    recalculateScannerState();
    broadcastFn('SCANNER_UPDATE', { coins: scannerState });
    broadcastFn('GATE_LOG', gateLog.slice(-50));

    if (result.action === 'WM_TRADE')   await handleWMTrade(symbol, result);
    else if (result.action === '10GATE_TRADE') await handle10GateTrade(symbol, result);
    else if (result.action === 'GATE_FAIL') {
      if (result.signal) await storage.addSignal(result.signal);
      if (result.isRanging) {
        broadcastFn('RANGING_DETECTED', { symbol, reason: result.reason });
        await telegram.sendRangingAlert(symbol, result);
      }
    }
  } catch (err) {
    console.error(`[ON_CANDLE_CLOSE ERROR] ${symbol}:`, err.message);
  }
}

async function handle10GateTrade(symbol, result) {
  const signal = result.signal;
  await storage.addSignal(signal);
  broadcastFn('SIGNAL_DETECTED', signal);
  await telegram.sendSignalAlert(signal);

  if (!settingsRef.autoTradeEnabled || autoTradePaused) return;

  // Section 3: check all 9 guard conditions before entering
  const demoBalance = await storage.getDemoBalance();
  const guardResult = await tradingGuard.guardTrade(signal, { dailyPnL: dailyStats.pnl, balance: demoBalance });
  if (guardResult.blocked) return;

  // Section 4: per-symbol freshness check - refuse to trade on stale data
  const tickAge = websocketManager.getSymbolTickAge(symbol);
  if (tickAge !== null && tickAge > 15000) {
    console.log(`[TRADE GUARD] Skipped auto-trade on ${symbol} — price data stale (${Math.round(tickAge / 1000)}s old)`);
    return;
  }

  const entryPrice = websocketManager.getCurrentPrice(symbol) || signal.signalCandleClose;
  const trade      = tradeManager.createTrade(signal, entryPrice, result.atr, result.fib, settingsRef, getActiveStrategyEngineName());

  if (settingsRef.exchange === 'delta' && settingsRef.deltaMode === 'live') {
    try {
      const orderRes = await deltaExchange.placeOrder(trade);
      trade.deltaOrderId = orderRes.orderId;
      trade.isLiveTrade  = true;
    } catch (e) {
      console.error(`[DELTA LIVE ERROR] ${symbol}:`, e.message);
    }
  }

  await storage.saveTrade(trade);
  openTrades.push(trade);
  tradeLogger.onTradeOpened(trade);

  signal.tradeFired = true;
  signal.tradeId    = trade.id;
  await storage.updateSignal(signal);
  dailyStats.trades++;

  broadcastFn('TRADE_OPENED', trade);
  await telegram.sendTradeOpenedAlert(trade);
  console.log(`[TRADE OPENED] ${symbol} ${trade.direction} @ ${entryPrice} TF:${trade.timeframe} ${new Date().toISOString()}`);
}

async function handleWMTrade(symbol, result) {
  const signal = result.signal;
  await storage.addSignal(signal);
  broadcastFn('WM_CONFIRMED', { signal, wmResult: result.wmResult });
  await telegram.sendWMConfirmedAlert(signal, result);

  if (!settingsRef.autoTradeEnabled || autoTradePaused) return;

  // Section 3: guard check before WM trade entry
  const demoBalance = await storage.getDemoBalance();
  const guardResult = await tradingGuard.guardTrade(signal, { dailyPnL: dailyStats.pnl, balance: demoBalance });
  if (guardResult.blocked) return;

  // Section 4: per-symbol freshness check - refuse to trade on stale data
  const tickAge = websocketManager.getSymbolTickAge(symbol);
  if (tickAge !== null && tickAge > 15000) {
    console.log(`[TRADE GUARD] Skipped WM auto-trade on ${symbol} — price data stale (${Math.round(tickAge / 1000)}s old)`);
    return;
  }

  const countdownSec = settingsRef.wm?.countdownSeconds || 10;
  await sleep(countdownSec * 1000);

  if (wmSkippedMap[signal.id]) {
    delete wmSkippedMap[signal.id];
    console.log('[W/M TRADE SKIPPED BY USER]', symbol);
    return;
  }

  const entryPrice = websocketManager.getCurrentPrice(symbol) || signal.signalCandleClose;
  const trade      = tradeManager.createTrade(signal, entryPrice, result.atr, result.fib, settingsRef, 'v1');

  if (settingsRef.exchange === 'delta' && settingsRef.deltaMode === 'live') {
    try {
      const orderRes = await deltaExchange.placeOrder(trade);
      trade.deltaOrderId = orderRes.orderId;
      trade.isLiveTrade  = true;
    } catch (e) {
      console.error(`[DELTA LIVE ERROR] ${symbol}:`, e.message);
    }
  }

  await storage.saveTrade(trade);
  openTrades.push(trade);
  tradeLogger.onTradeOpened(trade);

  signal.tradeFired = true;
  signal.tradeId    = trade.id;
  await storage.updateSignal(signal);

  broadcastFn('TRADE_OPENED', trade);
  await telegram.sendTradeOpenedAlert(trade);
}

function skipWMTrade(signalId)   { wmSkippedMap[signalId] = true; }
function confirmWMTrade(signalId){ delete wmSkippedMap[signalId]; }

const latestPrices = {};

async function onPriceTick(symbol, price) {
  if (!symbol || !price || isNaN(price)) return;

  latestPrices[symbol] = price;
  const coinState = scannerState.find(c => c.symbol === symbol);
  if (coinState) coinState.price = price;

  const tradesForSymbol = openTrades.filter(t => t.symbol === symbol && t.status === 'OPEN');

  for (const trade of tradesForSymbol) {
    trade.currentPrice = price;

    const candleData   = coinData[symbol];
    const currentATR   = candleData && candleData.candles && candleData.candles.length > 14
      ? indicators.calculateATR(
          candleData.candles.map(c => c.high),
          candleData.candles.map(c => c.low),
          candleData.candles.map(c => c.close), 14)
      : trade.atrAtEntry;

    if ((trade.strategyEngine || 'v1') === 'v1') {
      // v1: owns its full fixed TP1/TP2/TP3 ladder + trailing stop
      const action = tradeManager.checkTPSL(trade, price);
      if (action) {
        await processTPSLAction(trade, action.action, action.closePrice);
        continue;
      } else if (trade.trailingActive && currentATR) {
        const moved = tradeManager.updateTrailingStop(trade, price, currentATR);
        if (moved) {
          const tradesObj = await storage.loadTrades();
          await storage.saveTrades(tradesObj);
          await telegram.sendTrailingMovedAlert(trade, trade.trailingStop);
        }
      }
    } else {
      // v2/v3: no fixed TP ladder — their own watchdog signal (checked on candle close)
      // is the real exit. Here we only enforce the strategy's own entry-computed SL
      // as a hard safety floor in case price gaps through it between candle closes.
      const slHit = trade.direction === 'LONG' ? price <= trade.stopLoss : price >= trade.stopLoss;
      if (slHit) {
        let pnl = ((price - trade.entryPrice) / trade.entryPrice) * trade.positionValue * trade.leverage * trade.remainingPct;
        if (trade.direction === 'SHORT') pnl = ((trade.entryPrice - price) / trade.entryPrice) * trade.positionValue * trade.leverage * trade.remainingPct;
        trade.realizedPnL += pnl;
        await finishCloseTrade(trade, trade.stopLoss, 'SL');
        continue;
      }
    }

    const pnlCalc = tradeManager.calculateLivePnL(trade, price);
    trade.unrealizedPnL = pnlCalc.unrealizedPnL;

    broadcastFn('TRADE_UPDATE', {
      tradeId: trade.id, symbol: trade.symbol,
      currentPrice: price,
      unrealizedPnL: pnlCalc.unrealizedPnL, pnlPct: pnlCalc.pnlPct,
      trailingStop: trade.trailingStop, trailingActive: trade.trailingActive,
      remainingPct: trade.remainingPct, tp1Hit: trade.tp1Hit, tp2Hit: trade.tp2Hit
    });
  }
}

async function processTPSLAction(trade, action, closePrice) {
  const currentATR = trade.atrAtEntry || 100;

  if (action === 'TP1_HIT') {
    const closePct = (settingsRef.trade?.tp1ClosePct || 40) / 100;
    let pnl = ((closePrice - trade.entryPrice) / trade.entryPrice) * trade.positionValue * trade.leverage * closePct;
    if (trade.direction === 'SHORT') {
      pnl = ((trade.entryPrice - closePrice) / trade.entryPrice) * trade.positionValue * trade.leverage * closePct;
    }
    trade.tp1Hit = true;
    trade.realizedPnL += pnl;
    trade.remainingPct -= closePct;
    trade.trailingActive = true;
    
    // Move stopLoss to breakeven or better on TP1 hit
    if (trade.direction === 'LONG') {
      trade.stopLoss     = Math.max(trade.stopLoss || 0, trade.entryPrice);
      trade.trailingStop = Math.max(closePrice - (currentATR * 1.0), trade.entryPrice);
    } else {
      trade.stopLoss     = Math.min(trade.stopLoss || Infinity, trade.entryPrice);
      trade.trailingStop = Math.min(closePrice + (currentATR * 1.0), trade.entryPrice);
    }

    await storage.saveTrade(trade);
    tradeLogger.onTPHit(trade, 1);
    broadcastFn('TRADE_UPDATE', trade);
    await telegram.sendTPAlert(trade, 1, closePrice, pnl);

  } else if (action === 'TP2_HIT') {
    const closePct = (settingsRef.trade?.tp2ClosePct || 40) / 100;
    let pnl = ((closePrice - trade.entryPrice) / trade.entryPrice) * trade.positionValue * trade.leverage * closePct;
    if (trade.direction === 'SHORT') {
      pnl = ((trade.entryPrice - closePrice) / trade.entryPrice) * trade.positionValue * trade.leverage * closePct;
    }
    trade.tp2Hit = true;
    trade.realizedPnL += pnl;
    trade.remainingPct -= closePct;

    await storage.saveTrade(trade);
    tradeLogger.onTPHit(trade, 2);
    broadcastFn('TRADE_UPDATE', trade);
    await telegram.sendTPAlert(trade, 2, closePrice, pnl);

  } else if (action === 'TP3_HIT') {
    let pnl = ((closePrice - trade.entryPrice) / trade.entryPrice) * trade.positionValue * trade.leverage * trade.remainingPct;
    if (trade.direction === 'SHORT') {
      pnl = ((trade.entryPrice - closePrice) / trade.entryPrice) * trade.positionValue * trade.leverage * trade.remainingPct;
    }
    trade.realizedPnL += pnl;
    await finishCloseTrade(trade, closePrice, 'TP3');

  } else if (action === 'SL_HIT') {
    let pnl = ((closePrice - trade.entryPrice) / trade.entryPrice) * trade.positionValue * trade.leverage * trade.remainingPct;
    if (trade.direction === 'SHORT') {
      pnl = ((trade.entryPrice - closePrice) / trade.entryPrice) * trade.positionValue * trade.leverage * trade.remainingPct;
    }
    trade.realizedPnL += pnl;
    await finishCloseTrade(trade, closePrice, 'SL');

  } else if (action === 'TRAILING_HIT') {
    let pnl = ((closePrice - trade.entryPrice) / trade.entryPrice) * trade.positionValue * trade.leverage * trade.remainingPct;
    if (trade.direction === 'SHORT') {
      pnl = ((trade.entryPrice - closePrice) / trade.entryPrice) * trade.positionValue * trade.leverage * trade.remainingPct;
    }
    trade.realizedPnL += pnl;
    await finishCloseTrade(trade, closePrice, 'TRAILING');
  }
}

async function finishCloseTrade(trade, exitPrice, outcome) {
  const now = Date.now();
  trade.closedAt     = now;
  trade.closedAtUTC  = formatUTCDateTime(now);
  trade.exitPrice    = exitPrice;
  trade.status       = 'CLOSED';
  trade.outcome      = outcome;
  trade.remainingPct = 0;
  // Issue 3: ensure pnlPercent is always set
  trade.pnlPercent   = trade.positionValue > 0
    ? Math.round((trade.realizedPnL / trade.positionValue) * 100 * 100) / 100
    : 0;
  trade.timeframeUsed = trade.timeframe;

  let demoBalance = await storage.getDemoBalance();
  demoBalance += trade.realizedPnL;
  await storage.saveDemoBalance(demoBalance);

  dailyStats.pnl += trade.realizedPnL;
  if (trade.realizedPnL > 0) dailyStats.wins++;
  else dailyStats.losses++;

  // Daily loss limit check (5%)
  if (dailyStats.pnl < 0 && Math.abs(dailyStats.pnl) >= demoBalance * 0.05) {
    autoTradePaused = true;
    await telegram.sendDailyLimitAlert(dailyStats.pnl);
    broadcastFn('ALERT', { level: 'critical', message: 'Daily loss limit reached (5%)' });
  }

  openTrades = openTrades.filter(t => t.id !== trade.id);
  await storage.closeTrade(trade);
  tradeLogger.onTradeClosed(trade);

  const signal = await storage.getSignalById(trade.signalId);
  if (signal) {
    signal.tradeOutcome  = outcome;
    signal.tradePnL      = trade.realizedPnL;
    signal.tradePnLPct   = trade.pnlPercent;
    signal.tradeExitPrice = exitPrice;
    signal.tradeClosedAt = trade.closedAtUTC;
    await storage.updateSignal(signal);
  }

  broadcastFn('TRADE_CLOSED', trade);

  // Issue 4: send Telegram alerts for ALL close outcomes
  if (outcome === 'SL') {
    await telegram.sendSLAlert(trade, exitPrice, trade.realizedPnL);
  } else if (outcome === 'TP3') {
    await telegram.sendTPAlert(trade, 3, exitPrice, trade.realizedPnL);
  } else if (outcome === 'TRAILING') {
    await telegram.sendTrailingHitAlert(trade, exitPrice, trade.realizedPnL);
  } else if (outcome === 'MANUAL') {
    await telegram.sendManualCloseAlert(trade, exitPrice, trade.realizedPnL);
  } else if (outcome === 'WATCHDOG_EXIT') {
    await telegram.sendWatchdogExitAlert(trade, exitPrice, trade.realizedPnL);
  }

  if (trade.isLiveTrade && settingsRef.deltaMode === 'live') {
    try {
      await deltaExchange.closePosition(trade.symbol, trade.direction);
    } catch (e) {
      console.error(`[DELTA CLOSE ERROR] ${trade.symbol}:`, e.message);
    }
  }



  // Update guard's weekly baseline
  const finalBalance = await storage.getDemoBalance();
  tradingGuard.recordWeeklyBaseline(finalBalance);
}

async function manualCloseTrade(tradeId) {
  const trade = openTrades.find(t => t.id === tradeId);
  if (!trade) return null;

  const currentPrice = websocketManager.getCurrentPrice(trade.symbol) || trade.currentPrice;
  let pnl = ((currentPrice - trade.entryPrice) / trade.entryPrice) * trade.positionValue * trade.leverage * trade.remainingPct;
  if (trade.direction === 'SHORT') {
    pnl = ((trade.entryPrice - currentPrice) / trade.entryPrice) * trade.positionValue * trade.leverage * trade.remainingPct;
  }
  trade.realizedPnL += pnl;
  await finishCloseTrade(trade, currentPrice, 'MANUAL');
  return trade;
}

function restoreOpenTrades(savedOpenTrades = []) { openTrades = savedOpenTrades; }

async function runFullAutoScan() {
  if (isFullScanInProgress) return;
  if (!activeCoinList || activeCoinList.length === 0) return;

  isFullScanInProgress = true;
  const scanStartTime  = Date.now();
  const tf             = settingsRef.timeframe || '4h';

  // Issue 1: mark scan as running
  lastAutoScanHeartbeat = { timestamp: Date.now(), status: 'running', durationMs: null, error: null, coinCount: 0 };
  broadcastFn('SCAN_HEARTBEAT', lastAutoScanHeartbeat);
  console.log(`[AUTO-SCAN] ⚡ Starting full market scan — ${activeCoinList.length} coins @ TF:${tf}`);

  let errorCount = 0;

  try {
    const batchSize = 5;
    for (let i = 0; i < activeCoinList.length; i += batchSize) {
      const batch = activeCoinList.slice(i, i + batchSize);
      await Promise.all(batch.map(async (symbol) => {
        try {
          const freshCandles = await binanceData.getCandles(symbol, tf, 300);
          if (freshCandles && freshCandles.length > 0) {
            if (!coinData[symbol]) coinData[symbol] = { symbol, candles: freshCandles, lastScanTime: Date.now() };
            else { coinData[symbol].candles = freshCandles; coinData[symbol].lastScanTime = Date.now(); }
          }

          if (coinData[symbol]?.candles?.length >= 50) {
            const evalResult = await getActiveStrategyEngine().evaluateCoin(
              symbol, coinData[symbol].candles, settingsRef, openTrades, autoTradePaused
            );
            if (evalResult) {
              logGateEvaluation(symbol, evalResult, Date.now());
              if (evalResult.action === 'WM_TRADE')        await handleWMTrade(symbol, evalResult);
              else if (evalResult.action === '10GATE_TRADE') await handle10GateTrade(symbol, evalResult);
              else if (evalResult.action === 'GATE_FAIL') {
                if (evalResult.signal) await storage.addSignal(evalResult.signal);
                if (evalResult.isRanging) {
                  broadcastFn('RANGING_DETECTED', { symbol, reason: evalResult.reason });
                  await telegram.sendRangingAlert(symbol, evalResult);
                }
              }
            }
          }
        } catch (err) {
          errorCount++;
          console.error(`[AUTO-SCAN ERROR] ${symbol}:`, err.message);
        }
      }));
      await sleep(100);
    }

    recalculateScannerState();
    broadcastFn('SCANNER_UPDATE', { coins: scannerState });
    broadcastFn('GATE_LOG', gateLog.slice(-50));

    const durationMs = Date.now() - scanStartTime;
    lastAutoScanHeartbeat = {
      timestamp: Date.now(), status: errorCount === 0 ? 'ok' : 'error',
      durationMs, error: errorCount > 0 ? `${errorCount} coin(s) failed` : null,
      coinCount: activeCoinList.length
    };
    broadcastFn('SCAN_HEARTBEAT', lastAutoScanHeartbeat);
    console.log(`[AUTO-SCAN] ✅ Completed — ${activeCoinList.length} coins in ${(durationMs / 1000).toFixed(1)}s @ TF:${tf}${errorCount > 0 ? ` (${errorCount} errors)` : ''}`);

  } catch (err) {
    const durationMs = Date.now() - scanStartTime;
    lastAutoScanHeartbeat = {
      timestamp: Date.now(), status: 'error', durationMs,
      error: err.message, coinCount: activeCoinList.length
    };
    broadcastFn('SCAN_HEARTBEAT', lastAutoScanHeartbeat);
    console.error('[AUTO-SCAN FATAL ERROR]', err.message);
  } finally {
    isFullScanInProgress = false;
  }
}

async function forceScan() {
  await runFullAutoScan();
  return scannerState;
}

function getDailyStats() {
  return { realizedPnL: dailyStats.pnl, trades: dailyStats.trades, wins: dailyStats.wins, losses: dailyStats.losses };
}

function start(coinList, settings, broadcastCallback) {
  settingsRef    = settings;
  if (coinList && coinList.length > 0) activeCoinList = coinList;
  if (broadcastCallback) broadcastFn = broadcastCallback;
  isScannerRunning = true;

  // Wire guard and exit manager to current settings + broadcast
  tradingGuard.setSettings(settings);
  tradingGuard.setBroadcast(broadcastCallback || broadcastFn);
  exitManager.setSettings(settings);
  exitManager.setBroadcast(broadcastCallback || broadcastFn);

  // 5-second fast periodic UI refresh
  setInterval(async () => {
    try {
      recalculateScannerState();
      broadcastFn('SCANNER_UPDATE', { coins: scannerState });
      for (const trade of openTrades) {
        trade.candlesOpen = calculateCandlesOpen(trade.openedAt, settingsRef.timeframe || '4h');
      }
    } catch (e) {
      console.error('[SCANNER REFRESH ERROR]', e.message);
    }
  }, 5000);

  // 5-minute auto-scan
  const scanIntervalMinutes = settingsRef.scanIntervalMinutes || 5;
  const scanIntervalMs      = scanIntervalMinutes * 60 * 1000;
  console.log(`[AUTO-SCAN] Scheduled every ${scanIntervalMinutes} min`);

  if (fullScanTimer) clearInterval(fullScanTimer);
  fullScanTimer = setInterval(() => {
    runFullAutoScan().catch(err => {
      console.error('[AUTO-SCAN PERIODIC ERROR]', err.message);
      lastAutoScanHeartbeat = { timestamp: Date.now(), status: 'error', durationMs: null, error: err.message, coinCount: activeCoinList.length };
      broadcastFn('SCAN_HEARTBEAT', lastAutoScanHeartbeat);
    });
  }, scanIntervalMs);

  // Initial scan 3s after start
  setTimeout(() => {
    runFullAutoScan().catch(err => console.error('[AUTO-SCAN INITIAL ERROR]', err.message));
  }, 3000);
}

function isRunning()          { return isScannerRunning; }
function getLastScanTime()    { return formatUTCDateTime(lastScanTimeMs); }
function getOpenTradeCount()  { return openTrades.length; }
function getOpenTrades()      { return openTrades; }
function getGateLog()         { return gateLog; }

module.exports = {
  loadInitialData, start, updateSettings,
  onCandleClose, onPriceTick,
  manualCloseTrade, skipWMTrade, confirmWMTrade, restoreOpenTrades,
  isRunning, getLastScanTime, getLastAutoScanHeartbeat,
  getOpenTradeCount, getOpenTrades, getGateLog,
  getScannerState: () => scannerState,
  getDailyStats, forceScan, runFullAutoScan
};
