const { generateUUID, formatUTCDateTime } = require('./utils');

/**
 * v1.1 — Fixes applied against a live paper-trade audit:
 *   FIX 1: createTrade() now actually applies signal.sizeTier to the position
 *          size. Previously it was computed by the strategy engines but never
 *          read here, so every trade opened at full configured size regardless
 *          of how many triggers fired or how strong the setup was.
 *   FIX 2 (new): added checkBreakevenLock() — a shared, engine-agnostic check
 *          that locks the stop to breakeven once a trade has covered a
 *          meaningful fraction of the distance to TP1, BEFORE TP1 itself is
 *          reached. This is what actually closes the "runs 40-50% into profit
 *          then reverses to a loss" gap — previously nothing protected a trade
 *          between entry and a full TP1 hit.
 */

function createTrade(signal, entryPrice, atr = 100, fib = {}, settings = {}, engineName = 'v1') {
  const direction = signal.direction;
  const demoBalance = settings.demoBalance || 10000;
  const posSizePct = settings.trade?.positionSizePct || 5;
  const leverage = settings.trade?.leverage || 10;
  const maxRiskPct = settings.trade?.maxRiskPerTradePct || 2;
  const tp1Mult = settings.trade?.tp1AtrMultiple || 2.0;
  const tp2Mult = settings.trade?.tp2AtrMultiple || 3.5;

  // FIX 1: apply the strategy's tiered position size (0.4 / 0.7 / 1.0) before
  // anything else. Falls back to 1.0 (full size) when a signal doesn't provide
  // one — e.g. v1/WM signals, which don't compute a sizeTier.
  const sizeTier = (signal.sizeTier !== undefined && signal.sizeTier !== null) ? signal.sizeTier : 1.0;
  let positionValue = demoBalance * (posSizePct / 100) * sizeTier;

  let sl = 0;
  let tp1 = 0;
  let tp2 = 0;
  let tp3 = 0;

  if (direction === 'LONG') {
    sl  = signal.sl  || (entryPrice - (atr * 1.5));
    tp1 = signal.tp1 || (entryPrice + (atr * tp1Mult));
    tp2 = signal.tp2 || (entryPrice + (atr * tp2Mult));
    tp3 = signal.tp3 || fib?.ext1618 || (entryPrice + (atr * 5.0));
  } else {
    sl  = signal.sl  || (entryPrice + (atr * 1.5));
    tp1 = signal.tp1 || (entryPrice - (atr * tp1Mult));
    tp2 = signal.tp2 || (entryPrice - (atr * tp2Mult));
    const lowLevel = fib?.level1000 || (entryPrice - (atr * 2.0));
    const swingRange = Math.abs(entryPrice - lowLevel);
    tp3 = signal.tp3 || (swingRange > atr * 0.5 ? entryPrice - swingRange * 1.618 : entryPrice - (atr * 5.0));
  }

  // Risk cap
  const riskPerPrice = Math.abs(entryPrice - sl) / entryPrice;
  const riskAmount = riskPerPrice * positionValue * leverage;
  const maxRiskAmount = demoBalance * (maxRiskPct / 100);

  if (riskAmount > maxRiskAmount && riskAmount > 0) {
    const scaleFactor = maxRiskAmount / riskAmount;
    positionValue = positionValue * scaleFactor;
  }

  const now = Date.now();

  return {
    id: generateUUID(),
    signalId: signal.id,
    openedAt: now,
    openedAtUTC: formatUTCDateTime(now),
    closedAt: null,
    closedAtUTC: null,
    symbol: signal.symbol,
    strategyEngine: engineName,
    timeframe: signal.timeframe || '4h',
    exchange: settings.exchange || 'binance',
    direction,
    entryPrice,
    currentPrice: entryPrice,
    exitPrice: null,
    stopLoss: sl,
    tp1,
    tp2,
    tp3,
    tp1Hit: false,
    tp2Hit: false,
    tp3Hit: false,
    breakevenLocked: false,
    trailingStop: null,
    trailingActive: false,
    positionValue: Math.round(positionValue * 100) / 100,
    sizeTier,
    leverage,
    remainingPct: 1.0,
    realizedPnL: 0,
    unrealizedPnL: 0,
    status: 'OPEN',
    outcome: null,
    trigger: signal.trigger || '4-GATE',
    scoreAtEntry: signal.scoreAtSignal || signal.score || 0,
    scoreAtExit: null,
    atrAtEntry: atr,
    gate1: signal.gate1 || 'PASS',
    gate2: signal.gate2 || 'PASS',
    gate3: signal.gate3 || 'PASS',
    gate4: signal.gate4 || 'PASS',
    wmPattern: signal.wmPattern || null,
    deltaOrderId: null,
    isLiveTrade: false,
    candlesOpen: 0
  };
}

function calculateLivePnL(trade, currentPrice) {
  let pnlPct = 0;
  let rawPnL = 0;

  if (trade.direction === 'LONG') {
    pnlPct = ((currentPrice - trade.entryPrice) / trade.entryPrice) * trade.leverage * 100;
    rawPnL = ((currentPrice - trade.entryPrice) / trade.entryPrice) * trade.positionValue * trade.leverage;
  } else {
    pnlPct = ((trade.entryPrice - currentPrice) / trade.entryPrice) * trade.leverage * 100;
    rawPnL = ((trade.entryPrice - currentPrice) / trade.entryPrice) * trade.positionValue * trade.leverage;
  }

  const unrealizedPnL = rawPnL * trade.remainingPct;
  const totalPnL = (trade.realizedPnL || 0) + unrealizedPnL;
  return { unrealizedPnL, pnlPct, totalPnL };
}

/**
 * FIX 2: locks the stop to breakeven (+ a small buffer) once price has moved
 * a configurable fraction of the way from entry to TP1. This runs BEFORE TP1
 * is hit — it's the piece that was completely missing before. Returns true
 * only on the candle/tick where it actually moves the stop, so callers can
 * decide whether to save/broadcast/alert.
 *
 * Never loosens the stop — only ever moves it toward locking in more profit,
 * consistent with how trailing stops already behave in this file.
 */
function checkBreakevenLock(trade, currentPrice, breakevenTriggerPct = 0.5) {
  if (!trade || trade.breakevenLocked || trade.tp1Hit) return false;
  if (!trade.tp1 || !trade.entryPrice) return false;

  const totalDistance = Math.abs(trade.tp1 - trade.entryPrice);
  if (totalDistance === 0) return false;

  const progress = trade.direction === 'LONG'
    ? (currentPrice - trade.entryPrice) / totalDistance
    : (trade.entryPrice - currentPrice) / totalDistance;

  if (progress < breakevenTriggerPct) return false;

  const buffer = Math.abs(trade.entryPrice - trade.stopLoss) * 0.05; // small — covers fees/slippage, not zero

  if (trade.direction === 'LONG') {
    const candidate = trade.entryPrice + buffer;
    if (candidate > trade.stopLoss) {
      trade.stopLoss = candidate;
      trade.breakevenLocked = true;
      return true;
    }
  } else {
    const candidate = trade.entryPrice - buffer;
    if (candidate < trade.stopLoss) {
      trade.stopLoss = candidate;
      trade.breakevenLocked = true;
      return true;
    }
  }
  return false;
}

function checkTPSL(trade, currentPrice) {
  if (trade.status !== 'OPEN') return null;

  if (trade.direction === 'LONG') {
    // 1. Trailing stop check FIRST if active (tighter protection than initial SL)
    if (trade.trailingActive && trade.trailingStop !== null && currentPrice <= trade.trailingStop) {
      return { action: 'TRAILING_HIT', closePrice: trade.trailingStop };
    }
    // 2. Initial Stop Loss check
    if (trade.stopLoss !== null && currentPrice <= trade.stopLoss) {
      return { action: 'SL_HIT', closePrice: trade.stopLoss };
    }
    // 3. Take Profit checks
    if (!trade.tp1Hit && currentPrice >= trade.tp1) {
      return { action: 'TP1_HIT', closePrice: trade.tp1 };
    }
    if (trade.tp1Hit && !trade.tp2Hit && currentPrice >= trade.tp2) {
      return { action: 'TP2_HIT', closePrice: trade.tp2 };
    }
    if (trade.tp2Hit && !trade.tp3Hit && currentPrice >= trade.tp3) {
      return { action: 'TP3_HIT', closePrice: trade.tp3 };
    }
  } else {
    // 1. Trailing stop check FIRST if active for SHORT
    if (trade.trailingActive && trade.trailingStop !== null && currentPrice >= trade.trailingStop) {
      return { action: 'TRAILING_HIT', closePrice: trade.trailingStop };
    }
    // 2. Initial Stop Loss check
    if (trade.stopLoss !== null && currentPrice >= trade.stopLoss) {
      return { action: 'SL_HIT', closePrice: trade.stopLoss };
    }
    // 3. Take Profit checks
    if (!trade.tp1Hit && currentPrice <= trade.tp1) {
      return { action: 'TP1_HIT', closePrice: trade.tp1 };
    }
    if (trade.tp1Hit && !trade.tp2Hit && currentPrice <= trade.tp2) {
      return { action: 'TP2_HIT', closePrice: trade.tp2 };
    }
    if (trade.tp2Hit && !trade.tp3Hit && currentPrice <= trade.tp3) {
      return { action: 'TP3_HIT', closePrice: trade.tp3 };
    }
  }

  return null;
}

function updateTrailingStop(trade, currentPrice, currentATR = 100) {
  if (!trade.trailingActive) return false;

  const trailMult = 1.0;
  if (trade.direction === 'LONG') {
    const calculatedTrailing = currentPrice - (currentATR * trailMult);
    // Trailing stop must never drop below entry price (breakeven) or previous trailing stop / stopLoss
    const minFloor = Math.max(trade.entryPrice, trade.stopLoss || 0);
    const newTrailing = Math.max(calculatedTrailing, minFloor);
    if (trade.trailingStop === null || newTrailing > trade.trailingStop) {
      trade.trailingStop = newTrailing;
      // Ratchet stopLoss up alongside trailingStop
      if (trade.stopLoss === null || newTrailing > trade.stopLoss) {
        trade.stopLoss = newTrailing;
      }
      return true;
    }
  } else {
    const calculatedTrailing = currentPrice + (currentATR * trailMult);
    // Trailing stop for short must never rise above entry price or previous trailing stop / stopLoss
    const maxCeiling = Math.min(trade.entryPrice, trade.stopLoss || Infinity);
    const newTrailing = Math.min(calculatedTrailing, maxCeiling);
    if (trade.trailingStop === null || newTrailing < trade.trailingStop) {
      trade.trailingStop = newTrailing;
      // Ratchet stopLoss down alongside trailingStop
      if (trade.stopLoss === null || newTrailing < trade.stopLoss) {
        trade.stopLoss = newTrailing;
      }
      return true;
    }
  }

  return false;
}

module.exports = {
  createTrade,
  calculateLivePnL,
  checkBreakevenLock,
  checkTPSL,
  updateTrailingStop
};
