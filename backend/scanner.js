const binanceData = require('./binanceData');
const strategy = require('./strategy');
const tradeManager = require('./tradeManager');
const deltaExchange = require('./deltaExchange');
const telegram = require('./telegramBot');
const storage = require('./storage');
const indicators = require('./indicators');
const websocketManager = require('./websocketManager');
const { sleep, calculateCandlesOpen, formatUTCDateTime, getSessionBadge } = require('./utils');

let coinData = {};
let scannerState = [];
let openTrades = [];
let gateLog = [];
let dailyStats = { pnl: 0, trades: 0, wins: 0, losses: 0 };
let autoTradePaused = false;
let wmSkippedMap = {};

let settingsRef = {};
let broadcastFn = () => {};
let isScannerRunning = false;
let lastScanTimeMs = 0;
let activeCoinList = [];
let fullScanTimer = null;
let isFullScanInProgress = false;

async function loadInitialData(coinList, settings) {
  settingsRef = settings;
  activeCoinList = coinList;
  const batchSize = 5;

  for (let i = 0; i < coinList.length; i += batchSize) {
    const batch = coinList.slice(i, i + batchSize);
    await Promise.all(batch.map(async (symbol) => {
      const candles = await binanceData.getCandles(symbol, settings.timeframe || '4h', 300);
      coinData[symbol] = {
        symbol,
        candles,
        lastScanTime: Date.now()
      };
    }));
    await sleep(100);
  }

  recalculateScannerState();
}

function recalculateScannerState() {
  const coinsArr = [];

  Object.keys(coinData).forEach(symbol => {
    const data = coinData[symbol];
    const candles = data.candles || [];
    if (candles.length < 50) return;

    const closes = candles.map(c => c.close);
    const highs = candles.map(c => c.high);
    const lows = candles.map(c => c.low);
    const volumes = candles.map(c => c.volume);
    const i = closes.length - 1;
    const livePrice = latestPrices[symbol] || websocketManager.getCurrentPrice(symbol) || closes[i];
    const price = livePrice;
    const change24h = websocketManager.getChange24h(symbol) || 0;

    const ema9 = strategy.checkGate1 ? strategy.checkGate1(
      require('./indicators').calculateEMA(closes, 9),
      require('./indicators').calculateEMA(closes, 55),
      closes, candles
    ) : null;

    const ema9Val = require('./indicators').calculateEMA(closes, 9)[i] || price;
    const ema55Val = require('./indicators').calculateEMA(closes, 55)[i] || price;
    const ema200Val = require('./indicators').calculateEMA(closes, 200)[i] || price;
    const rsiVal = require('./indicators').calculateRSI(closes, 14)[i];
    const adxObj = require('./indicators').calculateADX(highs, lows, closes, 14);
    const volSMA = require('./indicators').calculateVolumeSMA(volumes.slice(0, -1), 20);
    const volRatio = volSMA ? Math.round((volumes[i] / volSMA) * 10) / 10 : 1.0;
    const stObj = require('./indicators').calculateSuperTrend(highs, lows, closes, 10, 3.0);
    const stDir = stObj.directions[i] || 'up';

    const g1 = strategy.checkGate1(
      require('./indicators').calculateEMA(closes, 9),
      require('./indicators').calculateEMA(closes, 55),
      closes, candles
    );
    const g2 = strategy.checkGate2(volumes, settingsRef);
    const g3 = strategy.checkGate3(highs, lows, closes, adxObj, settingsRef);
    const g4 = strategy.checkGate4(require('./indicators').calculateRSI(closes, 14), settingsRef);

    const isRanging = !g3.pass;
    const wmStateObj = strategy.getWMState(symbol);

    const statusBadges = [];
    if (wmStateObj.state === 'READY') statusBadges.push('W_READY');
    else if (wmStateObj.state === 'FORMING') statusBadges.push('W_FORMING');
    if (isRanging) statusBadges.push('RANGING');
    if (g1.pass && g2.pass && g3.pass && g4.pass) statusBadges.push('ALL_GATES_PASS');

    const indObj = {
      currentPrice: price,
      ema9: ema9Val,
      ema55: ema55Val,
      ema200: ema200Val,
      rsi: rsiVal,
      adx: adxObj.adx,
      pdi: adxObj.pdi,
      mdi: adxObj.mdi,
      volumeRatio: volRatio,
      supertrendDirection: stDir
    };

    const dir = g1.pass ? g1.direction : (ema9Val > ema55Val ? 'LONG' : 'SHORT');
    const scoreObj = strategy.calculateScore(indObj, dir, wmStateObj.state, settingsRef);

    coinsArr.push({
      symbol,
      price,
      change24h,
      score: scoreObj.total,
      scoreDisplay: scoreObj.scoreDisplay,
      direction: dir,
      status: g1.pass && g2.pass && g3.pass && g4.pass ? 'READY' : 'WATCHING',
      statusBadges,
      ema9: ema9Val,
      ema55: ema55Val,
      ema200: ema200Val,
      emaRelationship: ema9Val > ema55Val ? 'ABOVE' : 'BELOW',
      adx: adxObj.adx,
      pdi: adxObj.pdi,
      mdi: adxObj.mdi,
      rsi: rsiVal,
      volumeRatio: volRatio,
      fundingRate: 0.01,
      supertrendDirection: stDir,
      gate1: g1.pass ? 'PASS' : 'FAIL',
      gate1Direction: g1.direction,
      gate1FailReason: g1.reason,
      gate2: g2.pass ? 'PASS' : 'FAIL',
      gate2Value: g2.ratio,
      gate2FailReason: g2.reason,
      gate3: g3.pass ? 'PASS' : 'FAIL',
      gate3ADX: adxObj.adx,
      gate3FailReason: g3.reason,
      gate4: g4.pass ? 'PASS' : 'FAIL',
      gate4RSI: rsiVal,
      gate4FailReason: g4.reason,
      wmState: wmStateObj.state,
      wmType: wmStateObj.type,
      wmV1: wmStateObj.v1Price,
      wmNeckline: wmStateObj.necklinePrice,
      wmV2: wmStateObj.v2Price,
      isRanging,
      sessionBadge: getSessionBadge()
    });
  });

  scannerState = coinsArr;
  lastScanTimeMs = Date.now();
  storage.saveCoinStates(coinsArr).catch(err => console.error('[STORAGE SAVE ERROR]', err.message));
}

function logGateEvaluation(symbol, result, closeTime) {
  gateLog.push({
    timestamp: Date.now(),
    timeUTC: formatUTCDateTime(closeTime || Date.now()),
    symbol,
    action: result.action,
    reason: result.reason || result.gate1Fail || null,
    score: result.score?.total || null
  });
  if (gateLog.length > 200) gateLog = gateLog.slice(-200);
}

async function onCandleClose(symbol, closeTime) {
  if (!coinData[symbol]) return;

  const newCandles = await binanceData.getCandles(symbol, settingsRef.timeframe || '4h', 300);
  if (newCandles.length > 0) {
    coinData[symbol].candles = newCandles;
  }

  const result = await strategy.evaluateCoin(
    symbol,
    coinData[symbol].candles,
    settingsRef,
    openTrades,
    autoTradePaused
  );

  if (!result) return;

  logGateEvaluation(symbol, result, closeTime);
  recalculateScannerState();

  broadcastFn('SCANNER_UPDATE', { coins: scannerState });
  broadcastFn('GATE_LOG', gateLog.slice(-50));

  if (result.action === 'WM_TRADE') {
    await handleWMTrade(symbol, result);
  } else if (result.action === '4GATE_TRADE') {
    await handle4GateTrade(symbol, result);
  } else if (result.action === 'GATE_FAIL') {
    if (result.signal) await storage.addSignal(result.signal);
    if (result.isRanging) {
      broadcastFn('RANGING_DETECTED', { symbol, reason: result.reason });
      await telegram.sendRangingAlert(symbol, result);
    }
  }
}

async function handle4GateTrade(symbol, result) {
  const signal = result.signal;
  await storage.addSignal(signal);
  broadcastFn('SIGNAL_DETECTED', signal);
  await telegram.sendSignalAlert(signal);

  if (!settingsRef.autoTradeEnabled || autoTradePaused) return;

  const entryPrice = websocketManager.getCurrentPrice(symbol) || signal.signalCandleClose;
  const trade = tradeManager.createTrade(signal, entryPrice, result.atr, result.fib, settingsRef);

  if (settingsRef.exchange === 'delta' && settingsRef.deltaMode === 'live') {
    try {
      const orderRes = await deltaExchange.placeOrder(trade);
      trade.deltaOrderId = orderRes.orderId;
      trade.isLiveTrade = true;
    } catch (e) {
      console.error(`[DELTA LIVE ERROR] ${symbol}:`, e.message);
    }
  }

  await storage.saveTrade(trade);
  openTrades.push(trade);

  signal.tradeFired = true;
  signal.tradeId = trade.id;
  await storage.updateSignal(signal);

  dailyStats.trades++;

  broadcastFn('TRADE_OPENED', trade);
  await telegram.sendTradeOpenedAlert(trade);
  console.log('[TRADE OPENED]', symbol, trade.direction, entryPrice, new Date().toISOString());
}

async function handleWMTrade(symbol, result) {
  const signal = result.signal;
  await storage.addSignal(signal);

  broadcastFn('WM_CONFIRMED', { signal, wmResult: result.wmResult });
  await telegram.sendWMConfirmedAlert(signal, result);

  if (!settingsRef.autoTradeEnabled || autoTradePaused) return;

  const countdownSec = settingsRef.wm?.countdownSeconds || 10;
  await sleep(countdownSec * 1000);

  if (wmSkippedMap[signal.id]) {
    delete wmSkippedMap[signal.id];
    console.log('[W/M TRADE SKIPPED BY USER]', symbol);
    return;
  }

  const entryPrice = websocketManager.getCurrentPrice(symbol) || signal.signalCandleClose;
  const trade = tradeManager.createTrade(signal, entryPrice, result.atr, result.fib, settingsRef);

  if (settingsRef.exchange === 'delta' && settingsRef.deltaMode === 'live') {
    try {
      const orderRes = await deltaExchange.placeOrder(trade);
      trade.deltaOrderId = orderRes.orderId;
      trade.isLiveTrade = true;
    } catch (e) {
      console.error(`[DELTA LIVE ERROR] ${symbol}:`, e.message);
    }
  }

  await storage.saveTrade(trade);
  openTrades.push(trade);

  signal.tradeFired = true;
  signal.tradeId = trade.id;
  await storage.updateSignal(signal);

  broadcastFn('TRADE_OPENED', trade);
  await telegram.sendTradeOpenedAlert(trade);
}

function skipWMTrade(signalId) {
  wmSkippedMap[signalId] = true;
}

function confirmWMTrade(signalId) {
  delete wmSkippedMap[signalId];
}

const latestPrices = {};

async function onPriceTick(symbol, price) {
  if (!symbol || !price || isNaN(price)) return;

  latestPrices[symbol] = price;

  const coinState = scannerState.find(c => c.symbol === symbol);
  if (coinState) coinState.price = price;

  const tradesForSymbol = openTrades.filter(t =>
    t.symbol === symbol && t.status === 'OPEN'
  );

  for (const trade of tradesForSymbol) {
    trade.currentPrice = price;

    const candleData = coinData[symbol];
    const currentATR = candleData && candleData.candles && candleData.candles.length > 14
      ? indicators.calculateATR(
          candleData.candles.map(c => c.high),
          candleData.candles.map(c => c.low),
          candleData.candles.map(c => c.close),
          14
        )
      : trade.atrAtEntry;

    const action = tradeManager.checkTPSL(trade, price);
    if (action) {
      await processTPSLAction(trade, action.action, action.closePrice);
    } else if (trade.trailingActive && currentATR) {
      const moved = tradeManager.updateTrailingStop(trade, price, currentATR);
      if (moved) {
        const tradesObj = await storage.loadTrades();
        await storage.saveTrades(tradesObj);
        await telegram.sendTrailingMovedAlert(trade, trade.trailingStop);
      }
    }

    const pnlCalc = tradeManager.calculateLivePnL(trade, price);
    trade.unrealizedPnL = pnlCalc.unrealizedPnL;

    broadcastFn('TRADE_UPDATE', {
      tradeId: trade.id,
      symbol: trade.symbol,
      currentPrice: price,
      unrealizedPnL: pnlCalc.unrealizedPnL,
      pnlPct: pnlCalc.pnlPct,
      trailingStop: trade.trailingStop,
      trailingActive: trade.trailingActive,
      remainingPct: trade.remainingPct,
      tp1Hit: trade.tp1Hit,
      tp2Hit: trade.tp2Hit
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
    trade.trailingStop = trade.direction === 'LONG' ? closePrice - (currentATR * 1.0) : closePrice + (currentATR * 1.0);

    await storage.saveTrade(trade);
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
  trade.closedAt = now;
  trade.closedAtUTC = formatUTCDateTime(now);
  trade.exitPrice = exitPrice;
  trade.status = 'CLOSED';
  trade.outcome = outcome;
  trade.remainingPct = 0;

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

  const signal = await storage.getSignalById(trade.signalId);
  if (signal) {
    signal.tradeOutcome = outcome;
    signal.tradePnL = trade.realizedPnL;
    signal.tradePnLPct = Math.round((trade.realizedPnL / trade.positionValue) * 100 * 100) / 100;
    await storage.updateSignal(signal);
  }

  broadcastFn('TRADE_CLOSED', trade);

  if (outcome === 'SL') {
    await telegram.sendSLAlert(trade, exitPrice, trade.realizedPnL);
  } else if (outcome === 'TP3') {
    await telegram.sendTPAlert(trade, 3, exitPrice, trade.realizedPnL);
  }

  if (trade.isLiveTrade && settingsRef.deltaMode === 'live') {
    try {
      await deltaExchange.closePosition(trade.symbol, trade.direction);
    } catch (e) {
      console.error(`[DELTA CLOSE ERROR] ${trade.symbol}:`, e.message);
    }
  }
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

function restoreOpenTrades(savedOpenTrades = []) {
  openTrades = savedOpenTrades;
}

async function runFullAutoScan() {
  if (isFullScanInProgress) return;
  if (!activeCoinList || activeCoinList.length === 0) return;

  isFullScanInProgress = true;
  const scanStartTime = Date.now();
  console.log(`[AUTO-SCAN] ⚡ Starting 5-minute full market scan for ${activeCoinList.length} coins...`);

  const batchSize = 5;
  for (let i = 0; i < activeCoinList.length; i += batchSize) {
    const batch = activeCoinList.slice(i, i + batchSize);
    await Promise.all(batch.map(async (symbol) => {
      try {
        const freshCandles = await binanceData.getCandles(symbol, settingsRef.timeframe || '4h', 300);
        if (freshCandles && freshCandles.length > 0) {
          if (!coinData[symbol]) {
            coinData[symbol] = { symbol, candles: freshCandles, lastScanTime: Date.now() };
          } else {
            coinData[symbol].candles = freshCandles;
            coinData[symbol].lastScanTime = Date.now();
          }
        }

        if (coinData[symbol] && coinData[symbol].candles && coinData[symbol].candles.length >= 50) {
          const evalResult = await strategy.evaluateCoin(
            symbol,
            coinData[symbol].candles,
            settingsRef,
            openTrades,
            autoTradePaused
          );

          if (evalResult) {
            logGateEvaluation(symbol, evalResult, Date.now());

            if (evalResult.action === 'WM_TRADE') {
              await handleWMTrade(symbol, evalResult);
            } else if (evalResult.action === '4GATE_TRADE') {
              await handle4GateTrade(symbol, evalResult);
            } else if (evalResult.action === 'GATE_FAIL') {
              if (evalResult.signal) await storage.addSignal(evalResult.signal);
              if (evalResult.isRanging) {
                broadcastFn('RANGING_DETECTED', { symbol, reason: evalResult.reason });
                await telegram.sendRangingAlert(symbol, evalResult);
              }
            }
          }
        }
      } catch (err) {
        console.error(`[AUTO-SCAN ERROR] ${symbol}:`, err.message);
      }
    }));
    await sleep(100);
  }

  recalculateScannerState();
  broadcastFn('SCANNER_UPDATE', { coins: scannerState });
  broadcastFn('GATE_LOG', gateLog.slice(-50));

  isFullScanInProgress = false;
  console.log(`[AUTO-SCAN] ✅ Completed full market scan in ${((Date.now() - scanStartTime) / 1000).toFixed(1)}s`);
}

async function forceScan() {
  await runFullAutoScan();
  return scannerState;
}

function getDailyStats() {
  return {
    realizedPnL: dailyStats.pnl,
    trades: dailyStats.trades,
    wins: dailyStats.wins,
    losses: dailyStats.losses
  };
}

function start(coinList, settings, broadcastCallback) {
  settingsRef = settings;
  if (coinList && coinList.length > 0) activeCoinList = coinList;
  if (broadcastCallback) broadcastFn = broadcastCallback;
  isScannerRunning = true;

  // 5-second fast periodic UI refresh for real-time responsiveness
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

  // 5-minute automated FULL market scan & strategy evaluation interval
  const scanIntervalMinutes = settingsRef.scanIntervalMinutes || 5;
  const scanIntervalMs = scanIntervalMinutes * 60 * 1000;
  console.log(`[AUTO-SCAN] Scheduled automated full market scan every ${scanIntervalMinutes} minutes`);

  if (fullScanTimer) clearInterval(fullScanTimer);
  fullScanTimer = setInterval(() => {
    runFullAutoScan().catch(err => console.error('[AUTO-SCAN PERIODIC ERROR]', err.message));
  }, scanIntervalMs);

  // Run initial full scan 3 seconds after start
  setTimeout(() => {
    runFullAutoScan().catch(err => console.error('[AUTO-SCAN INITIAL ERROR]', err.message));
  }, 3000);
}

function isRunning() { return isScannerRunning; }
function getLastScanTime() { return formatUTCDateTime(lastScanTimeMs); }
function getOpenTradeCount() { return openTrades.length; }
function getOpenTrades() { return openTrades; }
function getGateLog() { return gateLog; }

module.exports = {
  loadInitialData,
  start,
  onCandleClose,
  onPriceTick,
  manualCloseTrade,
  skipWMTrade,
  confirmWMTrade,
  restoreOpenTrades,
  isRunning,
  getLastScanTime,
  getOpenTradeCount,
  getOpenTrades,
  getGateLog,
  getScannerState: () => scannerState,
  getDailyStats,
  forceScan,
  runFullAutoScan
};
