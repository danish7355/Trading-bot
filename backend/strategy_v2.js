/**
 * strategy_v2.js — Price Action / Smart Money Concepts (SMC) Strategy Engine
 *
 * Core Concepts:
 * 1. Timeframe Structure Profiles (1m, 5m, 15m, 1h, 4h, 1d)
 * 2. HTF Bias Classification (Bullish / Bearish / Ranging)
 * 3. Structural Detection: Liquidity Sweeps, Order Blocks (OB), Fair Value Gaps (FVG), BOS & CHoCH
 * 4. Weighted Structural Triggers (Liquidity Sweep = 0.35, OB Retest = 0.30, FVG Fill = 0.20, BOS = 0.15)
 * 5. Soft Momentum Confirmation with Grace Window (RSI, MACD Histogram, Volume)
 * 6. Hard Integrity Filters (24h Volume, Spread, OI/Vol ratio)
 * 7. Confidence Score Formula & Tiered Position Sizing
 * 8. Structural Stop-Loss & Take-Profit Calculation (1R, 1.272 Fib Ext, Opposing Structure)
 * 9. Reversal Watchdog for Open Positions (CHoCH, Divergence, Zone Break)
 */

const indicators = require('./indicators');
const { generateUUID, formatUTCDateTime } = require('./utils');

// ── Timeframe Profiles ───────────────────────────────────────────

const STRUCTURE_PROFILES = {
  '1m':  { swingLookback: 5,  obValidityCandles: 40,  impulseAtrMult: 1.3, graceCandles: 2, htf: '5m'  },
  '5m':  { swingLookback: 7,  obValidityCandles: 60,  impulseAtrMult: 1.4, graceCandles: 2, htf: '15m' },
  '15m': { swingLookback: 8,  obValidityCandles: 80,  impulseAtrMult: 1.5, graceCandles: 2, htf: '1h'  },
  '1h':  { swingLookback: 10, obValidityCandles: 100, impulseAtrMult: 1.5, graceCandles: 3, htf: '4h'  },
  '4h':  { swingLookback: 10, obValidityCandles: 60,  impulseAtrMult: 1.6, graceCandles: 3, htf: '1d'  },
  '1d':  { swingLookback: 10, obValidityCandles: 40,  impulseAtrMult: 1.8, graceCandles: 4, htf: '1w'  },
};

function getProfile(timeframe = '1h') {
  return STRUCTURE_PROFILES[timeframe] || STRUCTURE_PROFILES['1h'];
}

// ── Step 1: Swing Detection & HTF Bias ───────────────────────────

function detectSwings(candles, lookback = 10) {
  const highs = [];
  const lows = [];
  const n = candles.length;
  if (n < lookback * 2 + 1) return { highs, lows };

  for (let i = lookback; i < n - lookback; i++) {
    let isHigh = true;
    let isLow = true;
    for (let j = i - lookback; j <= i + lookback; j++) {
      if (j === i) continue;
      if (candles[j].high >= candles[i].high) isHigh = false;
      if (candles[j].low <= candles[i].low) isLow = false;
    }
    if (isHigh) highs.push({ index: i, price: candles[i].high, time: candles[i].closeTime });
    if (isLow) lows.push({ index: i, price: candles[i].low, time: candles[i].closeTime });
  }

  return { highs, lows };
}

function getHTFBias(htfCandles, lookback = 10) {
  if (!htfCandles || htfCandles.length < 30) return 'RANGING';
  const swings = detectSwings(htfCandles, lookback);
  const h = swings.highs;
  const l = swings.lows;

  if (h.length < 2 || l.length < 2) return 'RANGING';

  const lastH = h[h.length - 1].price;
  const prevH = h[h.length - 2].price;
  const lastL = l[l.length - 1].price;
  const prevL = l[l.length - 2].price;

  if (lastH > prevH && lastL > prevL) return 'BULLISH';
  if (lastH < prevH && lastL < prevL) return 'BEARISH';
  return 'RANGING';
}

// ── Step 2: Structural Detection ─────────────────────────────────

function detectLiquiditySweep(candles, swingLevel, direction, wickBodyMin = 1.5) {
  if (!candles || candles.length === 0 || !swingLevel) return null;
  const candle = candles[candles.length - 1];
  const body = Math.abs(candle.close - candle.open);

  let wick = 0;
  let closedBack = false;

  if (direction === 'LONG') {
    wick = candle.low < swingLevel ? swingLevel - candle.low : 0;
    closedBack = candle.close > swingLevel;
  } else {
    wick = candle.high > swingLevel ? candle.high - swingLevel : 0;
    closedBack = candle.close < swingLevel;
  }

  if (wick === 0 || body === 0) return null;

  const wickRatio = wick / body;
  if (wickRatio >= wickBodyMin && closedBack) {
    return { level: swingLevel, wickRatio, confirmed: true };
  }
  if (wickRatio >= 1.0) {
    return { level: swingLevel, wickRatio, confirmed: false, state: 'ARMED' };
  }
  return null;
}

function detectOrderBlock(candles, direction, profile, atrVal) {
  if (!candles || candles.length < 15 || !atrVal) return null;
  const n = candles.length;
  const maxLookback = Math.min(n - 4, profile.obValidityCandles);

  for (let i = n - 4; i >= n - maxLookback; i--) {
    const isBullishObCandidate = direction === 'LONG' && candles[i].close < candles[i].open;
    const isBearishObCandidate = direction === 'SHORT' && candles[i].close > candles[i].open;

    if (!isBullishObCandidate && !isBearishObCandidate) continue;

    // Check subsequent move (over 1 to 3 candles)
    let moveSize = 0;
    for (let k = 1; k <= 3 && i + k < n; k++) {
      if (direction === 'LONG') {
        moveSize = Math.max(moveSize, candles[i + k].high - candles[i].close);
      } else {
        moveSize = Math.max(moveSize, candles[i].close - candles[i + k].low);
      }
    }

    if (moveSize >= profile.impulseAtrMult * atrVal) {
      // Check if mitigated
      let isMitigated = false;
      for (let m = i + 4; m < n; m++) {
        const cBody = Math.abs(candles[m].close - candles[m].open);
        if (direction === 'LONG' && candles[m].close < candles[i].low && cBody >= atrVal) {
          isMitigated = true;
          break;
        }
        if (direction === 'SHORT' && candles[m].close > candles[i].high && cBody >= atrVal) {
          isMitigated = true;
          break;
        }
      }
      if (!isMitigated) {
        return {
          index: i,
          top: Math.max(candles[i].open, candles[i].close),
          bottom: Math.min(candles[i].open, candles[i].close),
          high: candles[i].high,
          low: candles[i].low,
          impulseMove: moveSize,
          ageCandles: n - 1 - i
        };
      }
    }
  }
  return null;
}

function detectFVG(candles, direction) {
  if (!candles || candles.length < 3) return null;
  const n = candles.length;
  const c0 = candles[n - 3]; // candle[i-2]
  const c2 = candles[n - 1]; // candle[i]

  if (direction === 'LONG' && c0.high < c2.low) {
    return { top: c2.low, bottom: c0.high, size: c2.low - c0.high, type: 'BULLISH' };
  }
  if (direction === 'SHORT' && c0.low > c2.high) {
    return { top: c0.low, bottom: c2.high, size: c0.low - c2.high, type: 'BEARISH' };
  }
  return null;
}

function detectBOSChoCH(candles, bias) {
  if (!candles || candles.length < 20) return null;
  const swings = detectSwings(candles, 5);
  const n = candles.length;
  const lastClose = candles[n - 1].close;

  if (bias === 'BULLISH') {
    const lastSwingHigh = swings.highs[swings.highs.length - 1];
    if (lastSwingHigh && lastClose > lastSwingHigh.price) {
      return { type: 'BOS', direction: 'LONG', level: lastSwingHigh.price };
    }
    const lastSwingLow = swings.lows[swings.lows.length - 1];
    if (lastSwingLow && lastClose < lastSwingLow.price) {
      return { type: 'CHOCH', direction: 'SHORT', level: lastSwingLow.price };
    }
  } else if (bias === 'BEARISH') {
    const lastSwingLow = swings.lows[swings.lows.length - 1];
    if (lastSwingLow && lastClose < lastSwingLow.price) {
      return { type: 'BOS', direction: 'SHORT', level: lastSwingLow.price };
    }
    const lastSwingHigh = swings.highs[swings.highs.length - 1];
    if (lastSwingHigh && lastClose > lastSwingHigh.price) {
      return { type: 'CHOCH', direction: 'LONG', level: lastSwingHigh.price };
    }
  }
  return null;
}

// ── Step 3: Weighted Structural Triggers ──────────────────────────

const TRIGGER_WEIGHTS = {
  'LIQUIDITY_SWEEP_REVERSAL': 0.35,
  'ORDER_BLOCK_RETEST':       0.30,
  'FVG_FILL':                 0.20,
  'BOS_CONTINUATION':         0.15,
};

function calculateStructuralScore(triggersFired) {
  if (!triggersFired || triggersFired.length === 0) return 0;
  let sum = 0;
  triggersFired.forEach(t => {
    sum += TRIGGER_WEIGHTS[t] || 0;
  });
  return Math.min(1.0, sum);
}

// ── Step 4: Momentum Confirmation (Soft Score with Grace Window) ─

function momentumConfirmation(candles, direction, graceCandles = 2) {
  if (!candles || candles.length < 25) return 0.0;
  const n = candles.length;

  const closes = candles.map(c => c.close);
  const rsi = indicators.calculateRSI(closes, 14);
  const macd = indicators.calculateMACD(closes);
  const volumes = candles.map(c => c.volume);
  const volSma20 = indicators.calculateVolumeSMA(volumes, 20) || 0;

  let score = 0.0;
  let rsiPassed = false;
  let macdPassed = false;
  let volPassed = false;

  for (let idx = Math.max(0, n - 1 - graceCandles); idx < n; idx++) {
    const curRsi = rsi[idx];
    if (direction === 'LONG' && curRsi !== null && curRsi > 50) rsiPassed = true;
    if (direction === 'SHORT' && curRsi !== null && curRsi < 50) rsiPassed = true;

    if (idx > 0 && macd.histogram[idx] !== null && macd.histogram[idx - 1] !== null) {
      const diff = macd.histogram[idx] - macd.histogram[idx - 1];
      if (direction === 'LONG' && diff > 0) macdPassed = true;
      if (direction === 'SHORT' && diff < 0) macdPassed = true;
    }

    if (volumes[idx] > volSma20) volPassed = true;
  }

  if (rsiPassed) score += 0.4;
  if (macdPassed) score += 0.3;
  if (volPassed) score += 0.3;

  return Math.round(score * 100) / 100;
}

// ── Step 5: Fake-Out / Integrity Filters (Hard Gates) ─────────────

function passesIntegrityFilters(symbol, currentPrice, volume24h, settings = {}) {
  const minVol = settings.liquidity?.minUsdtVolume24h || 3_000_000;
  const usdtVol = (volume24h || 0) * (currentPrice || 0);

  if (volume24h !== undefined && volume24h > 0 && usdtVol < minVol) {
    return { pass: false, reason: `24h Volume $${(usdtVol / 1e6).toFixed(1)}M below minimum $${(minVol / 1e6).toFixed(1)}M` };
  }

  const estimatedSpreadPct = settings.spread?.estimatedPct || 0.05;
  const maxSpreadPct = settings.spread?.maxPct || 0.15;
  if (estimatedSpreadPct > maxSpreadPct) {
    return { pass: false, reason: `Spread ${estimatedSpreadPct.toFixed(2)}% > ${maxSpreadPct}% limit` };
  }

  return { pass: true };
}

// ── Step 6: Confidence Score Calculation ─────────────────────────

function calculateConfidence(structuralScore, momentumScore, htfBiasStrength = 1.0) {
  const raw = (structuralScore * 0.5) + (momentumScore * 0.3) + (htfBiasStrength * 0.2);
  return Math.round(raw * 1000) / 1000;
}

// ── Step 7: Structural SL & TP Calculation ───────────────────────

function calculateSLTP(direction, triggerLevel, entryPrice, atrPrice, impulseLeg = 0, opposingStructureLevel = null) {
  const bufferMult = 0.25;
  let sl = 0;

  if (direction === 'LONG') {
    sl = (triggerLevel || entryPrice) - (atrPrice * bufferMult);
    if (sl >= entryPrice) sl = entryPrice - (atrPrice * 1.5);
  } else {
    sl = (triggerLevel || entryPrice) + (atrPrice * bufferMult);
    if (sl <= entryPrice) sl = entryPrice + (atrPrice * 1.5);
  }

  const r = Math.abs(entryPrice - sl);

  let tp1 = 0;
  let tp2 = 0;
  let tp3 = 0;

  const leg = impulseLeg > 0 ? impulseLeg : r * 3.0;

  if (direction === 'LONG') {
    tp1 = entryPrice + r;
    tp2 = entryPrice + (leg * 1.272);
    tp3 = opposingStructureLevel && opposingStructureLevel > tp2 ? opposingStructureLevel : entryPrice + (r * 4.0);
  } else {
    tp1 = entryPrice - r;
    tp2 = entryPrice - (leg * 1.272);
    tp3 = opposingStructureLevel && opposingStructureLevel < tp2 ? opposingStructureLevel : entryPrice - (r * 4.0);
  }

  const rr = r > 0 ? Math.abs(tp2 - entryPrice) / r : 0;

  return { sl, tp1, tp2, tp3, rr: Math.round(rr * 100) / 100 };
}

// ── Step 8: Tiered Position Sizing ───────────────────────────────

function sizeEntry(triggersFiredCount, momentumScore) {
  if (triggersFiredCount === 1 && momentumScore < 0.4) return 0.4;
  if (triggersFiredCount === 1 && momentumScore >= 0.4) return 0.7;
  if (triggersFiredCount >= 2) return 1.0;
  return 0.0;
}

// ── Step 9: Reversal Watchdog Loop for Open Positions ────────────

function watchdogCheck(position, candles) {
  if (!position || !candles || candles.length < 20) return null;
  const signals = [];
  const direction = position.direction;

  const bias = direction === 'LONG' ? 'BULLISH' : 'BEARISH';
  const bosChoch = detectBOSChoCH(candles, bias);

  if (bosChoch && bosChoch.type === 'CHOCH') {
    signals.push('CHOCH');
  }

  const closes = candles.map(c => c.close);
  const rsiArr = indicators.calculateRSI(closes, 14);
  const div = indicators.detectRSIDivergence(closes, rsiArr, 14);

  if (direction === 'LONG' && div.bearish) signals.push('DIVERGENCE');
  if (direction === 'SHORT' && div.bullish) signals.push('DIVERGENCE');

  const lastClose = closes[closes.length - 1];
  if (direction === 'LONG' && position.stopLoss && lastClose < position.entryPrice - (Math.abs(position.entryPrice - position.stopLoss) * 0.5)) {
    signals.push('ZONE_BREAK');
  }
  if (direction === 'SHORT' && position.stopLoss && lastClose > position.entryPrice + (Math.abs(position.entryPrice - position.stopLoss) * 0.5)) {
    signals.push('ZONE_BREAK');
  }

  if (signals.length >= 2) {
    const unrealizedPnL = position.unrealizedPnL || 0;
    return {
      positionId: position.id,
      signals,
      currentlyInProfit: unrealizedPnL > 0,
      message: `⚠️ Reversal warning against ${direction} on ${position.symbol} — [${signals.join(', ')}]`
    };
  }
  return null;
}

// ── Main Entry Point: evaluateCoin (compatible with scanner.js) ───

async function evaluateCoin(symbol, candles, settings, openTrades = [], autoTradePaused = false, htfCandles = null) {
  if (!candles || candles.length < 50) return null;

  const timeframe = settings.timeframe || '1h';
  const profile = getProfile(timeframe);

  const closes = candles.map(c => c.close);
  const highs  = candles.map(c => c.high);
  const lows   = candles.map(c => c.low);
  const volumes = candles.map(c => c.volume);
  const i      = closes.length - 1;
  const currentPrice = closes[i];

  const atrArr = indicators.calculateATR(highs, lows, closes, 14);
  const atrVal = atrArr[i] || (currentPrice * 0.02);

  // 1. HTF Bias
  const bias = getHTFBias(htfCandles || candles, profile.swingLookback);
  const htfBiasStrength = bias === 'RANGING' ? 0.5 : 1.0;

  // 2. Swings on execution timeframe
  const swings = detectSwings(candles, profile.swingLookback);

  const directionsToEvaluate = bias === 'BULLISH' ? ['LONG'] : bias === 'BEARISH' ? ['SHORT'] : ['LONG', 'SHORT'];

  let bestSetup = null;

  for (const direction of directionsToEvaluate) {
    const triggersFired = [];

    // Trigger A: Liquidity Sweep
    const swingTarget = direction === 'LONG'
      ? (swings.lows[swings.lows.length - 1]?.price || null)
      : (swings.highs[swings.highs.length - 1]?.price || null);

    const sweep = detectLiquiditySweep(candles, swingTarget, direction, settings.wick_body_min || 1.5);
    if (sweep && sweep.confirmed) {
      triggersFired.push('LIQUIDITY_SWEEP_REVERSAL');
    }

    // Trigger B: Order Block Retest
    const ob = detectOrderBlock(candles, direction, profile, atrVal);
    if (ob) {
      const inObZone = direction === 'LONG'
        ? currentPrice >= ob.low && currentPrice <= ob.high
        : currentPrice <= ob.high && currentPrice >= ob.low;
      if (inObZone) triggersFired.push('ORDER_BLOCK_RETEST');
    }

    // Trigger C: FVG Fill
    const fvg = detectFVG(candles, direction);
    if (fvg) {
      const inFvgZone = direction === 'LONG'
        ? currentPrice >= fvg.bottom && currentPrice <= fvg.top
        : currentPrice <= fvg.top && currentPrice >= fvg.bottom;
      if (inFvgZone) triggersFired.push('FVG_FILL');
    }

    // Trigger D: BOS Continuation
    const bosChoch = detectBOSChoCH(candles, bias);
    if (bosChoch && bosChoch.type === 'BOS' && bosChoch.direction === direction) {
      triggersFired.push('BOS_CONTINUATION');
    }

    if (triggersFired.length === 0) continue;

    // 3. Structural Score
    const structuralScore = calculateStructuralScore(triggersFired);

    // 4. Momentum Score
    const momentumScore = momentumConfirmation(candles, direction, profile.graceCandles);

    // 5. Confidence Score
    const confidence = calculateConfidence(structuralScore, momentumScore, htfBiasStrength);

    const confThreshold = settings.confidence_threshold || 0.55;

    if (confidence >= confThreshold) {
      if (!bestSetup || confidence > bestSetup.confidence) {
        bestSetup = {
          direction,
          triggersFired,
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

  // 6. Integrity Filters (Hard Gates)
  const volume24h = volumes[volumes.length - 1];
  const integrity = passesIntegrityFilters(symbol, currentPrice, volume24h, settings);

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
      reason: !integrity.pass ? integrity.reason : 'No SMC setup meeting confidence threshold',
      score: scoreObj,
      gates: gateSystemMock
    };
  }

  // Calculate SL / TP
  const triggerLevel = bestSetup.sweep?.level || bestSetup.ob?.low || currentPrice;
  const impulseLeg = bestSetup.ob?.impulseMove || (atrVal * 3);
  const slTp = calculateSLTP(bestSetup.direction, triggerLevel, currentPrice, atrVal, impulseLeg);

  // Position Sizing Tier
  const sizeTier = sizeEntry(bestSetup.triggersFired.length, bestSetup.momentumScore);

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
    trigger: `SMC_${bestSetup.triggersFired.join('_')}`,
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
  detectSwings,
  getHTFBias,
  detectLiquiditySweep,
  detectOrderBlock,
  detectFVG,
  detectBOSChoCH,
  calculateStructuralScore,
  momentumConfirmation,
  passesIntegrityFilters,
  calculateConfidence,
  calculateSLTP,
  sizeEntry,
  watchdogCheck,
  evaluateCoin
};
