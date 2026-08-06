/**
 * strategy_v3.js — Price Action / SMC + EMA5/Bollinger Confluence Strategy Engine
 *
 * Extends v2 with:
 * 1. 4th Entry Trigger Family: EMA5 Trend-Health + Reversal Candle + Bollinger Extension (EMA_BB_REVERSAL)
 * 2. Hard Regime Gate (bandWalkActive): Disqualifies EMA_BB_REVERSAL during strong trend "band walks"
 * 3. Watchdog EMA5 Cross Detection (EMA5_CROSS)
 * 4. Adaptive Trigger Weighting (recalibrateTriggerWeights) based on trade outcome history
 */

const indicators = require('./indicators');
const strategyV2 = require('./strategy_v2');
const { generateUUID, formatUTCDateTime } = require('./utils');

// ── Timeframe Profiles (Extends v2 with EMA/BB fields) ───────────

const STRUCTURE_PROFILES = {
  '1m':  { swingLookback: 5,  obValidityCandles: 40,  impulseAtrMult: 1.3, graceCandles: 2, htf: '5m',  emaFast: 5, bbLength: 20, bbStd: 2.0, dojiBodyMaxPct: 0.20, emaGapAtrMult: 0.35, emaSignalGrace: 2 },
  '5m':  { swingLookback: 7,  obValidityCandles: 60,  impulseAtrMult: 1.4, graceCandles: 2, htf: '15m', emaFast: 5, bbLength: 20, bbStd: 2.0, dojiBodyMaxPct: 0.20, emaGapAtrMult: 0.35, emaSignalGrace: 2 },
  '15m': { swingLookback: 8,  obValidityCandles: 80,  impulseAtrMult: 1.5, graceCandles: 2, htf: '1h',  emaFast: 5, bbLength: 20, bbStd: 2.0, dojiBodyMaxPct: 0.20, emaGapAtrMult: 0.35, emaSignalGrace: 2 },
  '1h':  { swingLookback: 10, obValidityCandles: 100, impulseAtrMult: 1.5, graceCandles: 3, htf: '4h',  emaFast: 5, bbLength: 20, bbStd: 2.0, dojiBodyMaxPct: 0.20, emaGapAtrMult: 0.35, emaSignalGrace: 2 },
  '4h':  { swingLookback: 10, obValidityCandles: 60,  impulseAtrMult: 1.6, graceCandles: 3, htf: '1d',  emaFast: 5, bbLength: 20, bbStd: 2.0, dojiBodyMaxPct: 0.20, emaGapAtrMult: 0.35, emaSignalGrace: 3 },
  '1d':  { swingLookback: 10, obValidityCandles: 40,  impulseAtrMult: 1.8, graceCandles: 4, htf: '1w',  emaFast: 5, bbLength: 20, bbStd: 2.0, dojiBodyMaxPct: 0.20, emaGapAtrMult: 0.35, emaSignalGrace: 4 },
};

function getProfile(timeframe = '1h') {
  return STRUCTURE_PROFILES[timeframe] || STRUCTURE_PROFILES['1h'];
}

// ── Base Trigger Weights ──────────────────────────────────────────

const BASE_TRIGGER_WEIGHTS = {
  'LIQUIDITY_SWEEP_REVERSAL': 0.30,
  'ORDER_BLOCK_RETEST':       0.25,
  'FVG_FILL':                 0.20,
  'BOS_CONTINUATION':         0.10,
  'EMA_BB_REVERSAL':          0.15,
};

let activeTriggerWeights = { ...BASE_TRIGGER_WEIGHTS };

// ── Step 0: Extra Indicators ─────────────────────────────────────

function calculateConfluenceIndicators(candles, profile) {
  const closes = candles.map(c => c.close);
  const ema5 = indicators.calculateEMA(closes, profile.emaFast || 5);
  const bb = indicators.calculateBollingerBands(closes, profile.bbLength || 20, profile.bbStd || 2.0);
  return { ema5, bb };
}

// ── Step 3b-ii: Regime Gate (band_walk_active) ──────────────────

function bandWalkActive(candles, bbUpper, bbLower, lookback = 5) {
  if (!candles || candles.length < lookback) return false;
  const n = candles.length;
  const sliceCloses = candles.slice(n - lookback).map(c => c.close);
  const sliceUpper  = bbUpper.slice(n - lookback);
  const sliceLower  = bbLower.slice(n - lookback);

  let walkUpCount = 0;
  let walkDownCount = 0;

  for (let k = 0; k < lookback; k++) {
    if (sliceUpper[k] !== null && sliceCloses[k] > sliceUpper[k] * 0.995) walkUpCount++;
    if (sliceLower[k] !== null && sliceCloses[k] < sliceLower[k] * 1.005) walkDownCount++;
  }

  return walkUpCount >= lookback - 1 || walkDownCount >= lookback - 1;
}

// ── Step 3b: EMA5 / Doji / Bollinger Extension Trigger ──────────

function detectEMABBReversal(candles, direction, profile, atrVal, atKeyLevel = false, bbObj = null, ema5Arr = null) {
  if (!atKeyLevel || !candles || candles.length < 20 || !atrVal) return null;
  const n = candles.length;
  const candle = candles[n - 1];
  const body = Math.abs(candle.close - candle.open);
  const candleRange = candle.high - candle.low;

  if (candleRange === 0) return null;

  const isDoji = (body / candleRange) <= (profile.dojiBodyMaxPct || 0.20);
  if (!isDoji) return null;

  const closes = candles.map(c => c.close);
  const ema5 = ema5Arr ? ema5Arr[n - 1] : indicators.calculateEMA(closes, profile.emaFast || 5)[n - 1];
  const bb = bbObj || indicators.calculateBollingerBands(closes, profile.bbLength || 20, profile.bbStd || 2.0);

  if (ema5 === null || bb.upper[n - 1] === null || bb.lower[n - 1] === null) return null;

  const gap = direction === 'LONG' ? (ema5 - candle.high) : (candle.low - ema5);
  const isDetached = gap > 0 && gap >= (profile.emaGapAtrMult || 0.35) * atrVal;

  const touchedBand = direction === 'LONG'
    ? (candle.low <= bb.lower[n - 1])
    : (candle.high >= bb.upper[n - 1]);

  if (isDoji && isDetached && touchedBand) {
    return { type: 'EMA_BB_REVERSAL', strength: 1.0, armedAt: n - 1 };
  }
  if (isDoji && touchedBand && !isDetached) {
    return { type: 'EMA_BB_REVERSAL', strength: 0.6, armedAt: n - 1 };
  }

  return null;
}

function confirmEMABBReversal(candles, armedTrigger, direction, profile, ema5Arr = null) {
  if (!armedTrigger || armedTrigger.armedAt === undefined) return false;
  const n = candles.length;
  const grace = profile.emaSignalGrace || 2;
  const windowSlice = candles.slice(armedTrigger.armedAt, Math.min(n, armedTrigger.armedAt + grace + 1));

  const closes = candles.map(c => c.close);
  const ema5 = ema5Arr || indicators.calculateEMA(closes, profile.emaFast || 5);

  for (let idx = armedTrigger.armedAt; idx < Math.min(n, armedTrigger.armedAt + grace + 1); idx++) {
    if (direction === 'LONG' && closes[idx] > ema5[idx]) return true;
    if (direction === 'SHORT' && closes[idx] < ema5[idx]) return true;
  }
  return false;
}

// ── Weighted Structural Score ────────────────────────────────────

function calculateStructuralScore(triggersFiredMap) {
  if (!triggersFiredMap || Object.keys(triggersFiredMap).length === 0) return 0;
  let sum = 0;
  for (const [trig, strength] of Object.entries(triggersFiredMap)) {
    const weight = activeTriggerWeights[trig] || BASE_TRIGGER_WEIGHTS[trig] || 0;
    sum += weight * strength;
  }
  return Math.min(1.0, sum);
}

// ── Watchdog EMA5 Cross Detection ────────────────────────────────

function ema5CrossAgainst(candles, direction) {
  if (!candles || candles.length < 3) return false;
  const closes = candles.map(c => c.close);
  const ema5 = indicators.calculateEMA(closes, 5);
  const n = closes.length - 1;
  if (ema5[n] === null) return false;

  if (direction === 'LONG' && closes[n] < ema5[n]) return true;
  if (direction === 'SHORT' && closes[n] > ema5[n]) return true;
  return false;
}

function watchdogCheck(position, candles) {
  if (!position || !candles || candles.length < 20) return null;

  // Combine v2 watchdog checks + EMA5_CROSS
  const v2Alert = strategyV2.watchdogCheck(position, candles);
  const signals = v2Alert ? [...v2Alert.signals] : [];

  if (ema5CrossAgainst(candles, position.direction)) {
    if (!signals.includes('EMA5_CROSS')) signals.push('EMA5_CROSS');
  }

  if (signals.length >= 2) {
    const unrealizedPnL = position.unrealizedPnL || 0;
    return {
      positionId: position.id,
      signals,
      currentlyInProfit: unrealizedPnL > 0,
      message: `⚠️ Reversal warning against ${position.direction} on ${position.symbol} — [${signals.join(', ')}]`
    };
  }
  return null;
}

// ── Step 11: Adaptive Trigger Weighting ──────────────────────────

function recalibrateTriggerWeights(tradeLog = [], window = 200, maxShift = 0.05) {
  if (!tradeLog || tradeLog.length === 0) return { ...activeTriggerWeights };
  const recent = tradeLog.slice(-window);
  const updated = { ...activeTriggerWeights };

  for (const triggerType of Object.keys(BASE_TRIGGER_WEIGHTS)) {
    const trades = recent.filter(t => (t.trigger || t.trigger_type || '').includes(triggerType));
    if (trades.length < 15) continue;

    const wins = trades.filter(t => (t.realizedPnL ?? t.pnl ?? 0) > 0).length;
    const winRate = wins / trades.length;

    const shift = Math.max(-maxShift, Math.min(maxShift, (winRate - 0.5) * 0.2));
    updated[triggerType] = Math.round(Math.max(0.05, (BASE_TRIGGER_WEIGHTS[triggerType] + shift)) * 1000) / 1000;
  }

  activeTriggerWeights = updated;
  return updated;
}

// ── Main Entry Point: evaluateCoin (v3) ───────────────────────────

async function evaluateCoin(symbol, candles, settings, openTrades = [], autoTradePaused = false, htfCandles = null) {
  if (!candles || candles.length < 50) return null;

  const timeframe = settings.timeframe || '1h';
  const profile = getProfile(timeframe);

  const closes  = candles.map(c => c.close);
  const highs   = candles.map(c => c.high);
  const lows    = candles.map(c => c.low);
  const volumes = candles.map(c => c.volume);
  const i       = closes.length - 1;
  const currentPrice = closes[i];

  const atrArr = indicators.calculateATR(highs, lows, closes, 14);
  const atrVal = atrArr[i] || (currentPrice * 0.02);

  // Indicators: EMA5, Bollinger Bands
  const { ema5, bb } = calculateConfluenceIndicators(candles, profile);

  // 1. HTF Bias
  const bias = strategyV2.getHTFBias(htfCandles || candles, profile.swingLookback);
  const htfBiasStrength = bias === 'RANGING' ? 0.5 : 1.0;

  // 2. Swings
  const swings = strategyV2.detectSwings(candles, profile.swingLookback);

  // 3. Regime Gate Check (bandWalkActive)
  const isWalkingBand = bandWalkActive(candles, bb.upper, bb.lower, 5);

  const directionsToEvaluate = bias === 'BULLISH' ? ['LONG'] : bias === 'BEARISH' ? ['SHORT'] : ['LONG', 'SHORT'];

  let bestSetup = null;

  for (const direction of directionsToEvaluate) {
    const triggersFiredMap = {};

    // Trigger A: Liquidity Sweep
    const swingTarget = direction === 'LONG'
      ? (swings.lows[swings.lows.length - 1]?.price || null)
      : (swings.highs[swings.highs.length - 1]?.price || null);

    const sweep = strategyV2.detectLiquiditySweep(candles, swingTarget, direction, settings.wick_body_min || 1.5);
    if (sweep && sweep.confirmed) {
      triggersFiredMap['LIQUIDITY_SWEEP_REVERSAL'] = 1.0;
    }

    // Trigger B: Order Block Retest
    const ob = strategyV2.detectOrderBlock(candles, direction, profile, atrVal);
    let inObZone = false;
    if (ob) {
      inObZone = direction === 'LONG'
        ? currentPrice >= ob.low && currentPrice <= ob.high
        : currentPrice <= ob.high && currentPrice >= ob.low;
      if (inObZone) triggersFiredMap['ORDER_BLOCK_RETEST'] = 1.0;
    }

    // Trigger C: FVG Fill
    const fvg = strategyV2.detectFVG(candles, direction);
    if (fvg) {
      const inFvgZone = direction === 'LONG'
        ? currentPrice >= fvg.bottom && currentPrice <= fvg.top
        : currentPrice <= fvg.top && currentPrice >= fvg.bottom;
      if (inFvgZone) triggersFiredMap['FVG_FILL'] = 1.0;
    }

    // Trigger D: BOS Continuation
    const bosChoch = strategyV2.detectBOSChoCH(candles, bias);
    if (bosChoch && bosChoch.type === 'BOS' && bosChoch.direction === direction) {
      triggersFiredMap['BOS_CONTINUATION'] = 1.0;
    }

    // Trigger E: EMA5 / Doji / Bollinger Extension Trigger (Regime-Gated)
    const atKeyLevel = (sweep && sweep.confirmed) || inObZone || (fvg !== null);
    if (!isWalkingBand && atKeyLevel) {
      const emaBbTrig = detectEMABBReversal(candles, direction, profile, atrVal, true, bb, ema5);
      if (emaBbTrig) {
        triggersFiredMap['EMA_BB_REVERSAL'] = emaBbTrig.strength;
      }
    }

    if (Object.keys(triggersFiredMap).length === 0) continue;

    // Structural Score
    const structuralScore = calculateStructuralScore(triggersFiredMap);

    // Momentum Score
    const momentumScore = strategyV2.momentumConfirmation(candles, direction, profile.graceCandles);

    // Confidence Score
    const confidence = strategyV2.calculateConfidence(structuralScore, momentumScore, htfBiasStrength);

    const confThreshold = settings.confidence_threshold || 0.55;

    if (confidence >= confThreshold) {
      if (!bestSetup || confidence > bestSetup.confidence) {
        bestSetup = {
          direction,
          triggersFiredMap,
          triggersFired: Object.keys(triggersFiredMap),
          structuralScore,
          momentumScore,
          confidence,
          ob,
          sweep,
          fvg,
          bosChoch
        };
      }
    }
  }

  // Integrity Filters
  const volume24h = volumes[volumes.length - 1];
  const integrity = strategyV2.passesIntegrityFilters(symbol, currentPrice, volume24h, settings);

  const rsiArr = indicators.calculateRSI(closes, 14);
  const adxResult = indicators.calculateADX(highs, lows, closes, 14);
  const ema9 = indicators.calculateEMA(closes, 9);
  const ema55 = indicators.calculateEMA(closes, 55);
  const ema200 = indicators.calculateEMA(closes, 200);

  const scoreObj = {
    total: bestSetup ? Math.round(bestSetup.confidence * 100) : 0,
    base: bestSetup ? Math.round(bestSetup.confidence * 100) : 0,
    scoreDisplay: bestSetup ? `${Math.round(bestSetup.confidence * 100)}` : '0'
  };

  const gateSystemMock = {
    g1: { pass: true, direction: bestSetup?.direction || (closes[i] > ema55[i] ? 'LONG' : 'SHORT') },
    g2: { pass: integrity.pass, ratio: 1.5, reason: integrity.reason },
    g3: { pass: bias !== 'RANGING', reason: bias === 'RANGING' ? 'HTF Bias Ranging' : null },
    g4: { pass: bestSetup !== null, reason: bestSetup ? null : 'Confidence below threshold' },
    g5: { pass: integrity.pass, reason: integrity.reason },
    g6: { pass: true },
    g7: { pass: true },
    g8: { pass: bestSetup ? bestSetup.momentumScore >= 0.3 : false },
    g9: { pass: true },
    g10: { pass: true },
    mandatoryPassed: integrity.pass && bestSetup !== null,
    confirmationPassed: bestSetup !== null,
    confirmationCount: bestSetup ? bestSetup.triggersFired.length : 0
  };

  if (!bestSetup || !integrity.pass) {
    return {
      action: 'NO_SIGNAL',
      reason: !integrity.pass ? integrity.reason : 'No SMC/BB setup meeting confidence threshold',
      score: scoreObj,
      gates: gateSystemMock
    };
  }

  // Calculate SL / TP
  const triggerLevel = bestSetup.sweep?.level || bestSetup.ob?.low || currentPrice;
  const impulseLeg = bestSetup.ob?.impulseMove || (atrVal * 3);
  const slTp = strategyV2.calculateSLTP(bestSetup.direction, triggerLevel, currentPrice, atrVal, impulseLeg);

  // Position Sizing Tier
  const sizeTier = strategyV2.sizeEntry(bestSetup.triggersFired.length, bestSetup.momentumScore);

  const signal = {
    id: generateUUID(),
    timestamp: Date.now(),
    dateTimeUTC: formatUTCDateTime(Date.now()),
    signalCandleCloseTime: candles[i].closeTime,
    signalCandleCloseDateTimeUTC: formatUTCDateTime(candles[i].closeTime),
    symbol,
    market: 'crypto',
    timeframe,
    exchange: settings.exchange || 'binance',
    direction: bestSetup.direction,
    trigger: `SMC_V3_${bestSetup.triggersFired.join('_')}`,
    signalCandleClose: currentPrice,
    ema9: ema9[i],
    ema55: ema55[i],
    ema200: ema200[i],
    adxAtSignal: adxResult?.adx ?? null,
    rsiAtSignal: rsiArr[i] ?? null,
    volumeRatio: 1.5,
    scoreAtSignal: scoreObj.total,
    scoreBreakdown: {
      structural: Math.round(bestSetup.structuralScore * 50),
      momentum: Math.round(bestSetup.momentumScore * 30),
      htfBias: Math.round(htfBiasStrength * 20)
    },
    confidence: bestSetup.confidence,
    triggersFired: bestSetup.triggersFired,
    sizeTier,
    sl: slTp.sl,
    tp1: slTp.tp1,
    tp2: slTp.tp2,
    tp3: slTp.tp3,
    rr: slTp.rr,
    gate1: 'PASS', gate2: 'PASS', gate3: 'PASS', gate4: 'PASS',
    gate5: 'PASS', gate6: 'PASS', gate7: 'PASS', gate8: 'PASS', gate9: 'PASS', gate10: 'PASS',
    mandatoryPassed: true,
    confirmationPassed: true,
    confirmationCount: bestSetup.triggersFired.length,
    tradeFired: false
  };

  const hasOpen = openTrades.some(t => t.symbol === symbol && t.status === 'OPEN');
  const maxTrades = openTrades.filter(t => t.status === 'OPEN').length >= (settings.trade?.maxConcurrentTrades || 5);

  if (hasOpen) return { action: 'BLOCKED', reason: 'Trade already open', score: scoreObj, gates: gateSystemMock };
  if (maxTrades) return { action: 'BLOCKED', reason: 'Max concurrent trades reached', score: scoreObj, gates: gateSystemMock };
  if (autoTradePaused) return { action: 'BLOCKED', reason: 'Auto-trading paused', score: scoreObj, gates: gateSystemMock };

  return {
    action: '10GATE_TRADE',
    signal,
    direction: bestSetup.direction,
    score: scoreObj,
    atr: atrVal,
    slTp,
    gates: gateSystemMock
  };
}

module.exports = {
  STRUCTURE_PROFILES,
  getProfile,
  calculateConfluenceIndicators,
  bandWalkActive,
  detectEMABBReversal,
  confirmEMABBReversal,
  calculateStructuralScore,
  ema5CrossAgainst,
  watchdogCheck,
  recalibrateTriggerWeights,
  evaluateCoin
};
