const { generateUUID, formatUTCDateTime } = require('./utils');

function createTrade(signal, entryPrice, atr = 100, fib = {}, settings = {}) {
  const direction = signal.direction;
  const demoBalance = settings.demoBalance || 10000;
  const posSizePct = settings.trade?.positionSizePct || 5;
  const leverage = settings.trade?.leverage || 10;
  const maxRiskPct = settings.trade?.maxRiskPerTradePct || 2;
  const tp1Mult = settings.trade?.tp1AtrMultiple || 2.0;
  const tp2Mult = settings.trade?.tp2AtrMultiple || 3.5;

  let positionValue = demoBalance * (posSizePct / 100);

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
    trailingStop: null,
    trailingActive: false,
    positionValue: Math.round(positionValue * 100) / 100,
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
  return { unrealizedPnL, pnlPct };
}

function checkTPSL(trade, currentPrice) {
  if (trade.status !== 'OPEN') return null;

  if (trade.direction === 'LONG') {
    if (!trade.tp1Hit && currentPrice >= trade.tp1) {
      return { action: 'TP1_HIT', closePrice: trade.tp1 };
    }
    if (trade.tp1Hit && !trade.tp2Hit && currentPrice >= trade.tp2) {
      return { action: 'TP2_HIT', closePrice: trade.tp2 };
    }
    if (trade.tp2Hit && !trade.tp3Hit && currentPrice >= trade.tp3) {
      return { action: 'TP3_HIT', closePrice: trade.tp3 };
    }
    if (currentPrice <= trade.stopLoss) {
      return { action: 'SL_HIT', closePrice: trade.stopLoss };
    }
    if (trade.trailingActive && trade.trailingStop && currentPrice <= trade.trailingStop) {
      return { action: 'TRAILING_HIT', closePrice: trade.trailingStop };
    }
  } else {
    if (!trade.tp1Hit && currentPrice <= trade.tp1) {
      return { action: 'TP1_HIT', closePrice: trade.tp1 };
    }
    if (trade.tp1Hit && !trade.tp2Hit && currentPrice <= trade.tp2) {
      return { action: 'TP2_HIT', closePrice: trade.tp2 };
    }
    if (trade.tp2Hit && !trade.tp3Hit && currentPrice <= trade.tp3) {
      return { action: 'TP3_HIT', closePrice: trade.tp3 };
    }
    if (currentPrice >= trade.stopLoss) {
      return { action: 'SL_HIT', closePrice: trade.stopLoss };
    }
    if (trade.trailingActive && trade.trailingStop && currentPrice >= trade.trailingStop) {
      return { action: 'TRAILING_HIT', closePrice: trade.trailingStop };
    }
  }

  return null;
}

function updateTrailingStop(trade, currentPrice, currentATR = 100) {
  if (!trade.trailingActive) return false;

  const trailMult = 1.0;
  if (trade.direction === 'LONG') {
    const newTrailing = currentPrice - (currentATR * trailMult);
    if (trade.trailingStop === null || newTrailing > trade.trailingStop) {
      trade.trailingStop = newTrailing;
      return true;
    }
  } else {
    const newTrailing = currentPrice + (currentATR * trailMult);
    if (trade.trailingStop === null || newTrailing < trade.trailingStop) {
      trade.trailingStop = newTrailing;
      return true;
    }
  }

  return false;
}

module.exports = {
  createTrade,
  calculateLivePnL,
  checkTPSL,
  updateTrailingStop
};
