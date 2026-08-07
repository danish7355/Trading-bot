/**
 * ExitManager — evaluates 10 exit triggers on every candle close for all open positions.
 * Translated exactly from the Python spec to Node.js, preserving all decision logic.
 * Logs every decision (even HOLD) to data/exit_log.json.
 */

const fs         = require('fs').promises;
const path       = require('path');
const indicators = require('./indicators');
const telegram   = require('./telegramBot');
const storage    = require('./storage');
const { formatUTCDateTime } = require('./utils');

const EXIT_LOG_FILE = path.join(__dirname, '..', 'data', 'exit_log.json');
const MAX_LOG_ENTRIES = 1000;

// Configurable thresholds (overridden from settings)
const DEFAULTS = {
  fundingExtremeThreshold: 0.005,   // 0.5% absolute funding rate
  maxHoldCandles: {
    '15m': 48, '30m': 32, '1h': 24,
    '2h': 16,  '4h': 12,  '6h': 8,
    '12h': 6,  '1d': 3
  },
  minRegimeScore: 40,
  volDryUpRatio: 0.5,
  oiDropThreshold: 0.10,
  rsiDivergenceLookback: 3,
};

let settingsRef = {};
let broadcastFn = () => {};

function setSettings(s) { settingsRef = s; }
function setBroadcast(fn) { broadcastFn = fn; }

// ── Logging ───────────────────────────────────────────────────────

async function logExitDecision(entry) {
  try {
    let logs = [];
    try {
      const raw = await fs.readFile(EXIT_LOG_FILE, 'utf-8');
      logs = JSON.parse(raw);
    } catch (e) { /* first entry */ }
    if (!Array.isArray(logs)) logs = [];
    logs.unshift(entry);
    if (logs.length > MAX_LOG_ENTRIES) logs = logs.slice(0, MAX_LOG_ENTRIES);
    await fs.writeFile(EXIT_LOG_FILE, JSON.stringify(logs, null, 2), 'utf-8');
  } catch (e) {
    console.error('[EXIT MGR] Log write failed:', e.message);
  }
}

async function loadExitLog(limit = 100) {
  try {
    const raw = await fs.readFile(EXIT_LOG_FILE, 'utf-8');
    const logs = JSON.parse(raw);
    return Array.isArray(logs) ? logs.slice(0, limit) : [];
  } catch (e) {
    return [];
  }
}

// ── Helper: RSI divergence detection ─────────────────────────────
// Price making higher high but RSI making lower high over last N candles

function detectRsiDivergence(position, candles) {
  if (!candles || candles.length < 10) return false;
  const closes = candles.map(c => c.close);
  const highs   = candles.map(c => c.high);
  const lows    = candles.map(c => c.low);
  const rsiArr  = indicators.calculateRSI(closes, 14);
  const n       = candles.length - 1;
  const lookback = DEFAULTS.rsiDivergenceLookback;

  if (position.direction === 'LONG') {
    // Bearish divergence: price higher high, RSI lower high
    let priceHigherHigh = true;
    let rsiLowerHigh    = true;
    for (let i = 1; i <= lookback; i++) {
      if (n - i < 0) return false;
      if (highs[n] <= highs[n - i]) priceHigherHigh = false;
      if (rsiArr[n] !== null && rsiArr[n - i] !== null && rsiArr[n] >= rsiArr[n - i]) rsiLowerHigh = false;
    }
    return priceHigherHigh && rsiLowerHigh;
  } else {
    // Bullish divergence for SHORT: price lower low, RSI higher low
    let priceLowerLow  = true;
    let rsiHigherLow   = true;
    for (let i = 1; i <= lookback; i++) {
      if (n - i < 0) return false;
      if (lows[n] >= lows[n - i]) priceLowerLow  = false;
      if (rsiArr[n] !== null && rsiArr[n - i] !== null && rsiArr[n] <= rsiArr[n - i]) rsiHigherLow = false;
    }
    return priceLowerLow && rsiHigherLow;
  }
}

function isFundingAgainstPosition(direction, fundingRate) {
  // Positive funding rate hurts LONG (they pay), negative hurts SHORT
  if (direction === 'LONG'  && fundingRate > 0) return true;
  if (direction === 'SHORT' && fundingRate < 0) return true;
  return false;
}

// ── Core evaluateExit ─────────────────────────────────────────────
// Translated exactly from Python spec. DO NOT change this decision logic.

/**
 * @param {object} position   - open trade object
 * @param {object} marketState - { price, close, emaM, regime, fundingRate, volRatio3Period, oiDropPct, df (candles) }
 * @returns {{ exit: boolean, reason?: string, pctToExit?: number, action?: string }}
 */
function evaluateExit(position, marketState) {
  // ── 0. Manual exit flag (checked before everything) ──────────────
  if (position.manualExitRequested) {
    return { exit: true, reason: 'MANUAL_EXIT', pctToExit: 100 };
  }

  // ── 1. Kill-switch synthetic exit ────────────────────────────────
  if (marketState.killSwitchActive) {
    return { exit: true, reason: 'KILL_SWITCH', pctToExit: 100 };
  }

  // ── 2. Hard stop — always checked first, immediate 100% exit ─────
  if (position.direction === 'LONG' && marketState.price <= position.stopLoss) {
    return { exit: true, reason: 'HARD_STOP', pctToExit: 100 };
  }
  if (position.direction === 'SHORT' && marketState.price >= position.stopLoss) {
    return { exit: true, reason: 'HARD_STOP', pctToExit: 100 };
  }

  const triggersFired = [];

  // ── 3. Regime deterioration ───────────────────────────────────────
  const minScore = settingsRef.exitManager?.minRegimeScore || DEFAULTS.minRegimeScore;
  if (marketState.regime && marketState.regime.score < minScore) {
    triggersFired.push('REGIME_DETERIORATION');
  }

  // ── 4. Trend structure break ──────────────────────────────────────
  if (position.direction === 'LONG'  && marketState.close < marketState.emaM) {
    triggersFired.push('TREND_STRUCTURE_BREAK');
  }
  if (position.direction === 'SHORT' && marketState.close > marketState.emaM) {
    triggersFired.push('TREND_STRUCTURE_BREAK');
  }

  // ── 5. RSI divergence (momentum exhaustion) ───────────────────────
  if (marketState.df && detectRsiDivergence(position, marketState.df)) {
    triggersFired.push('MOMENTUM_EXHAUSTION');
  }

  // ── 6. Volume dry-up ──────────────────────────────────────────────
  const volThreshold = settingsRef.exitManager?.volDryUpRatio || DEFAULTS.volDryUpRatio;
  if (marketState.volRatio3Period != null && marketState.volRatio3Period < volThreshold) {
    triggersFired.push('VOLUME_DRY_UP');
  }

  // ── 7. Max hold time ──────────────────────────────────────────────
  if (position.maxHoldUntil && new Date() > new Date(position.maxHoldUntil)) {
    triggersFired.push('MAX_HOLD_TIME');
  }

  // ── 8. Funding rate extreme ───────────────────────────────────────
  const fundingThreshold = settingsRef.exitManager?.fundingExtremeThreshold || DEFAULTS.fundingExtremeThreshold;
  if (marketState.fundingRate != null &&
      Math.abs(marketState.fundingRate) > fundingThreshold &&
      isFundingAgainstPosition(position.direction, marketState.fundingRate)) {
    triggersFired.push('FUNDING_RATE_EXTREME');
  }

  // ── 9. OI dropping while price moves in direction ─────────────────
  const oiThreshold = settingsRef.exitManager?.oiDropThreshold || DEFAULTS.oiDropThreshold;
  if (marketState.oiDropPct != null && marketState.oiDropPct > oiThreshold) {
    triggersFired.push('OI_DROPPING');
  }

  // ── Exit decision matrix ─── DO NOT change this logic ────────────
  if (triggersFired.length >= 3) {
    return { exit: true, reason: triggersFired.join('|'), pctToExit: 100 };
  } else if (triggersFired.length === 2) {
    return { exit: true, reason: triggersFired.join('|'), pctToExit: 50 };
  } else if (triggersFired.length === 1) {
    return { exit: false, action: 'TIGHTEN_STOP', reason: triggersFired[0] };
  } else {
    return { exit: false, action: 'HOLD' };
  }
}

// ── Stop tightening ───────────────────────────────────────────────

function tightenStop(position, currentPrice, currentATR) {
  const atr = currentATR || position.atrAtEntry || 100;
  const tightenFactor = 0.8;
  let newStop;
  if (position.direction === 'LONG') {
    newStop = currentPrice - (tightenFactor * atr);
    // Only tighten if the new stop is above the current stop
    if (position.stopLoss === null || newStop > position.stopLoss) {
      position.stopLoss = newStop;
      return true;
    }
  } else {
    newStop = currentPrice + (tightenFactor * atr);
    // Only tighten if the new stop is below the current stop
    if (position.stopLoss === null || newStop < position.stopLoss) {
      position.stopLoss = newStop;
      return true;
    }
  }
  return false;
}

// ── Partial exit helper ───────────────────────────────────────────

function applyPartialExit(trade, exitPrice, pctToClose) {
  const fraction = pctToClose / 100;
  const closingPct = Math.min(fraction, trade.remainingPct);

  let pnl;
  if (trade.direction === 'LONG') {
    pnl = ((exitPrice - trade.entryPrice) / trade.entryPrice) * trade.positionValue * trade.leverage * closingPct;
  } else {
    pnl = ((trade.entryPrice - exitPrice) / trade.entryPrice) * trade.positionValue * trade.leverage * closingPct;
  }

  trade.realizedPnL  = (trade.realizedPnL || 0) + pnl;
  trade.remainingPct  = Math.max(0, trade.remainingPct - closingPct);

  // Log partial exit on the trade record itself
  if (!Array.isArray(trade.partialExitLog)) trade.partialExitLog = [];
  trade.partialExitLog.push({
    exitTime:    new Date().toISOString(),
    exitPrice,
    pctClosed:   Math.round(closingPct * 100),
    pnl:         Math.round(pnl * 100) / 100,
    remainingPct: Math.round(trade.remainingPct * 100),
  });

  return pnl;
}

// ── Main loop: run for all open trades on candle close ────────────

/**
 * Called from scanner.onCandleClose for each symbol that has open trades.
 * @param {array}  openTrades  - live openTrades array from scanner
 * @param {string} symbol      - candle that just closed
 * @param {object} candleData  - { candles: [], atr, fundingRate, oiDropPct }
 * @param {function} finishCloseFn  - scanner.finishCloseTrade
 * @param {function} saveTradesFn   - storage.saveTrade
 */
async function runExitEvaluationsForSymbol(openTrades, symbol, candleData, finishCloseFn, saveTradeFn) {
  const trades = openTrades.filter(t => t.symbol === symbol && t.status === 'OPEN');
  if (trades.length === 0) return;

  const candles = candleData.candles || [];
  if (candles.length < 20) return;

  const closes  = candles.map(c => c.close);
  const highs   = candles.map(c => c.high);
  const lows    = candles.map(c => c.low);
  const volumes = candles.map(c => c.volume);
  const i       = closes.length - 1;

  const currentPrice = closes[i];
  const ema55        = indicators.calculateEMA(closes, 55);
  const emaMValue    = ema55[i] || currentPrice;

  // Volume ratio of last 3 candles vs 20-period SMA
  const volSMA       = indicators.calculateVolumeSMA(volumes.slice(0, -3), 20);
  const avg3Vol      = (volumes[i] + (volumes[i-1]||0) + (volumes[i-2]||0)) / 3;
  const volRatio3    = volSMA ? avg3Vol / volSMA : 1.0;

  // Regime score: simple proxy using ADX
  const adxObj = indicators.calculateADX(highs, lows, closes, 14);
  const regimeScore = adxObj.adx != null ? Math.min(100, adxObj.adx * 2.5) : 50;

  const marketState = {
    price:          currentPrice,
    close:          currentPrice,
    emaM:           emaMValue,
    regime:         { score: regimeScore },
    fundingRate:    candleData.fundingRate || 0,
    volRatio3Period: volRatio3,
    oiDropPct:      candleData.oiDropPct || 0,
    df:             candles,
    killSwitchActive: candleData.killSwitchActive || false,
  };

  for (const trade of trades) {
    const decision = evaluateExit(trade, marketState);

    // Log every decision
    const logEntry = {
      positionId:    trade.id,
      symbol:        trade.symbol,
      timestamp:     new Date().toISOString(),
      triggersFired: decision.reason ? decision.reason.split('|') : [],
      decision:      decision.exit ? `EXIT_${decision.pctToExit}PCT` : (decision.action || 'HOLD'),
      action:        decision.action || null,
      currentPrice,
      stopLoss:      trade.stopLoss,
    };
    await logExitDecision(logEntry);

    if (decision.exit) {
      const pct = decision.pctToExit;

      if (pct >= 100) {
        // Full exit
        const outcome = decideOutcomeLabel(decision.reason);
        let pnl;
        if (trade.direction === 'LONG') {
          pnl = ((currentPrice - trade.entryPrice) / trade.entryPrice) * trade.positionValue * trade.leverage * trade.remainingPct;
        } else {
          pnl = ((trade.entryPrice - currentPrice) / trade.entryPrice) * trade.positionValue * trade.leverage * trade.remainingPct;
        }
        trade.realizedPnL = (trade.realizedPnL || 0) + pnl;
        await finishCloseFn(trade, currentPrice, outcome);
        await sendExitTelegram(trade, currentPrice, decision, pnl, false);

      } else if (pct === 50) {
        // Partial exit
        const pnl = applyPartialExit(trade, currentPrice, 50);
        await saveTradeFn(trade);
        broadcastFn('TRADE_UPDATE', { ...trade, partialExit: true, partialPnL: pnl });
        await sendExitTelegram(trade, currentPrice, decision, pnl, true);
        console.log(`[EXIT MGR] 50% partial exit ${symbol} @ ${currentPrice} — triggers: ${decision.reason}`);

        // Recalculate TP on remaining half
        recalculateTPAfterPartial(trade, currentPrice, candleData.atr || trade.atrAtEntry || 100);
        await saveTradeFn(trade);
      }

    } else if (decision.action === 'TIGHTEN_STOP') {
      const atr = candleData.atr || trade.atrAtEntry || 100;
      const moved = tightenStop(trade, currentPrice, atr);
      if (moved) {
        await saveTradeFn(trade);
        broadcastFn('TRADE_UPDATE', { ...trade, stopTightened: true });
        await telegram.sendStopTightenedAlert(trade, trade.stopLoss);
        console.log(`[EXIT MGR] ⚠️ Stop tightened ${symbol} → ${trade.stopLoss.toFixed(4)} (trigger: ${decision.reason})`);
      }
    }
  }
}

function decideOutcomeLabel(reason) {
  if (!reason) return 'EXIT_MGR';
  if (reason.includes('KILL_SWITCH'))  return 'KILL_SWITCH';
  if (reason.includes('MANUAL_EXIT'))  return 'MANUAL';
  if (reason.includes('HARD_STOP'))    return 'SL';
  return 'EXIT_MGR';
}

function recalculateTPAfterPartial(trade, currentPrice, atr) {
  // After a 50% partial exit, ratchet remaining position's SL to breakeven or better
  if (trade.direction === 'LONG') {
    const minTargetSL = Math.max(trade.entryPrice, currentPrice - atr);
    trade.stopLoss    = Math.max(trade.stopLoss || 0, minTargetSL);
    trade.tp3         = Math.max(trade.tp3 || 0, currentPrice + (atr * 2.5));
  } else {
    const maxTargetSL = Math.min(trade.entryPrice, currentPrice + atr);
    trade.stopLoss    = Math.min(trade.stopLoss || Infinity, maxTargetSL);
    trade.tp3         = Math.min(trade.tp3 || Infinity, currentPrice - (atr * 2.5));
  }
}

// ── Telegram on exit ──────────────────────────────────────────────

async function sendExitTelegram(trade, exitPrice, decision, pnl, isPartial) {
  const holdDuration = formatHoldDuration(trade.openedAt);
  const effectiveValue = trade.positionValue * (trade.remainingPct || 1.0);
  const pnlPct       = effectiveValue > 0 ? ((pnl / effectiveValue) * 100).toFixed(1) : '0.0';
  const pnlStr       = `${pnl >= 0 ? '+' : ''}$${pnl.toFixed(2)} (${pnlPct}%)`;
  const triggers     = decision.reason || 'unknown';

  if (isPartial) {
    await telegram.sendPartialExitAlert(trade, exitPrice, pnl, triggers, holdDuration);
  } else {
    await telegram.sendExitManagerAlert(trade, exitPrice, pnl, pnlStr, triggers, holdDuration, decision.pctToExit === 100);
  }
}

function formatHoldDuration(openedAtMs) {
  const ms = Date.now() - openedAtMs;
  const h  = Math.floor(ms / 3600000);
  const m  = Math.floor((ms % 3600000) / 60000);
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
}

// ── Kill switch: force exit all open positions ────────────────────

async function killSwitchExitAll(openTrades, finishCloseFn) {
  console.log('[EXIT MGR] ⛔ Kill switch triggered — forcing exit on all open positions');
  for (const trade of [...openTrades]) {
    if (trade.status !== 'OPEN') continue;
    const syntheticState = {
      price:          trade.currentPrice || trade.entryPrice,
      close:          trade.currentPrice || trade.entryPrice,
      emaM:           trade.currentPrice || trade.entryPrice,
      regime:         { score: 0 },
      fundingRate:    0,
      volRatio3Period: 1,
      oiDropPct:      0,
      df:             null,
      killSwitchActive: true,
    };
    const decision = evaluateExit(trade, syntheticState);
    if (decision.exit) {
      const ep = trade.currentPrice || trade.entryPrice;
      let pnl;
      if (trade.direction === 'LONG') pnl = ((ep - trade.entryPrice) / trade.entryPrice) * trade.positionValue * trade.leverage * trade.remainingPct;
      else pnl = ((trade.entryPrice - ep) / trade.entryPrice) * trade.positionValue * trade.leverage * trade.remainingPct;
      trade.realizedPnL = (trade.realizedPnL || 0) + pnl;
      await finishCloseFn(trade, ep, 'KILL_SWITCH');
      await telegram.sendExitManagerAlert(trade, ep, pnl,
        `${pnl >= 0 ? '+' : ''}$${pnl.toFixed(2)}`, 'KILL_SWITCH', '0m', true);
    }
  }
}

module.exports = {
  setSettings,
  setBroadcast,
  evaluateExit,
  tightenStop,
  applyPartialExit,
  recalculateTPAfterPartial,
  runExitEvaluationsForSymbol,
  killSwitchExitAll,
  loadExitLog,
};
