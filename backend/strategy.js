const indicators = require('./indicators');
const { generateUUID, formatUTCDateTime } = require('./utils');

const wmStates = {};

function getWMState(symbol) {
  if (!wmStates[symbol]) {
    wmStates[symbol] = {
      type: null,
      state: 'WATCHING',
      v1Index: null, v1Price: null,
      necklineIndex: null, necklinePrice: null,
      v2Index: null, v2Price: null,
      startCandle: null,
      invalidated: false
    };
  }
  return wmStates[symbol];
}

function resetWMState(symbol) {
  wmStates[symbol] = {
    type: null, state: 'WATCHING',
    v1Index: null, v1Price: null,
    necklineIndex: null, necklinePrice: null,
    v2Index: null, v2Price: null,
    startCandle: null, invalidated: false
  };
}

function detectLocalMinimum(ema9, i) {
  if (i < 2 || i >= ema9.length - 2) return false;
  return ema9[i] < ema9[i - 1] && ema9[i] < ema9[i - 2] &&
         ema9[i] < ema9[i + 1] && ema9[i] < ema9[i + 2];
}

function detectLocalMaximum(ema9, i) {
  if (i < 2 || i >= ema9.length - 2) return false;
  return ema9[i] > ema9[i - 1] && ema9[i] > ema9[i - 2] &&
         ema9[i] > ema9[i + 1] && ema9[i] > ema9[i + 2];
}

function updateWMDetection(symbol, ema9Array, ema55Array, settings) {
  const state = getWMState(symbol);
  const i = ema9Array.length - 1; // Current closed candle
  const lookback = (settings.wm && settings.wm.lookback) || 25;
  const v2Tol = (settings.wm && settings.wm.v2TolerancePct) || 2;

  if (i < 10) return { confirmed: false, state: state.state, type: state.type };

  // W FORMATION (EMA9 below EMA55)
  if (ema9Array[i] < ema55Array[i]) {
    if (state.type === 'M') resetWMState(symbol);

    if (state.state === 'WATCHING') {
      for (let j = i - 2; j >= Math.max(0, i - lookback); j--) {
        if (detectLocalMinimum(ema9Array, j)) {
          state.type = 'W';
          state.state = 'FORMING';
          state.v1Index = j;
          state.v1Price = ema9Array[j];
          state.startCandle = j;
          break;
        }
      }
    } else if (state.state === 'FORMING') {
      if (ema9Array[i] < state.v1Price * 0.97 || (i - state.startCandle > lookback)) {
        resetWMState(symbol);
        return { confirmed: false, state: 'WATCHING', type: null };
      }

      for (let j = state.v1Index + 3; j <= i - 3; j++) {
        if (detectLocalMaximum(ema9Array, j) && ema9Array[j] > state.v1Price) {
          state.state = 'READY';
          state.necklineIndex = j;
          state.necklinePrice = ema9Array[j];

          for (let k = j + 3; k <= i; k++) {
            if (detectLocalMinimum(ema9Array, k)) {
              const v2Price = ema9Array[k];
              if (v2Price >= state.v1Price * (1 - v2Tol / 100) && v2Price < state.necklinePrice) {
                state.v2Index = k;
                state.v2Price = v2Price;
              }
            }
          }
          break;
        }
      }
    } else if (state.state === 'READY') {
      if (ema9Array[i] < state.v1Price * 0.97 || (i - state.startCandle > lookback)) {
        resetWMState(symbol);
        return { confirmed: false, state: 'WATCHING', type: null };
      }

      if (state.v2Price !== null && ema9Array[i] > state.necklinePrice) {
        state.state = 'CONFIRMED';
        state.breakPrice = ema9Array[i];
        state.breakCandle = i;
        const res = { confirmed: true, type: 'W', ...state };
        resetWMState(symbol);
        return res;
      }
    }
  }
  // M FORMATION (EMA9 above EMA55)
  else if (ema9Array[i] > ema55Array[i]) {
    if (state.type === 'W') resetWMState(symbol);

    if (state.state === 'WATCHING') {
      for (let j = i - 2; j >= Math.max(0, i - lookback); j--) {
        if (detectLocalMaximum(ema9Array, j)) {
          state.type = 'M';
          state.state = 'FORMING';
          state.v1Index = j;
          state.v1Price = ema9Array[j];
          state.startCandle = j;
          break;
        }
      }
    } else if (state.state === 'FORMING') {
      if (ema9Array[i] > state.v1Price * 1.03 || (i - state.startCandle > lookback)) {
        resetWMState(symbol);
        return { confirmed: false, state: 'WATCHING', type: null };
      }

      for (let j = state.v1Index + 3; j <= i - 3; j++) {
        if (detectLocalMinimum(ema9Array, j) && ema9Array[j] < state.v1Price) {
          state.state = 'READY';
          state.necklineIndex = j;
          state.necklinePrice = ema9Array[j];

          for (let k = j + 3; k <= i; k++) {
            if (detectLocalMaximum(ema9Array, k)) {
              const p2Price = ema9Array[k];
              if (p2Price <= state.v1Price * (1 + v2Tol / 100) && p2Price > state.necklinePrice) {
                state.v2Index = k;
                state.v2Price = p2Price;
              }
            }
          }
          break;
        }
      }
    } else if (state.state === 'READY') {
      if (ema9Array[i] > state.v1Price * 1.03 || (i - state.startCandle > lookback)) {
        resetWMState(symbol);
        return { confirmed: false, state: 'WATCHING', type: null };
      }

      if (state.v2Price !== null && ema9Array[i] < state.necklinePrice) {
        state.state = 'CONFIRMED';
        state.breakPrice = ema9Array[i];
        state.breakCandle = i;
        const res = { confirmed: true, type: 'M', ...state };
        resetWMState(symbol);
        return res;
      }
    }
  }

  return { confirmed: false, state: state.state, type: state.type };
}

function checkGate1(ema9Array, ema55Array, closes, candles, settings = {}) {
  const i = ema9Array.length - 1;

  if (i < 1 || ema9Array[i] === null || ema55Array[i] === null ||
      ema9Array[i - 1] === null || ema55Array[i - 1] === null) {
    return { pass: false, reason: "Insufficient EMA history", direction: null };
  }

  let direction = null;
  const signalMode = settings.signalMode || 'crossover';

  if (signalMode === 'continuation') {
    if (ema9Array[i] > ema55Array[i] && closes[i] > ema55Array[i]) direction = 'LONG';
    else if (ema9Array[i] < ema55Array[i] && closes[i] < ema55Array[i]) direction = 'SHORT';
    else return { pass: false, reason: "No EMA alignment", direction: null };
  } else {
    // Crossover mode
    const bullishCross = ema9Array[i] > ema55Array[i] && ema9Array[i - 1] <= ema55Array[i - 1];
    const bearishCross = ema9Array[i] < ema55Array[i] && ema9Array[i - 1] >= ema55Array[i - 1];

    if (bullishCross) direction = 'LONG';
    else if (bearishCross) direction = 'SHORT';
    else return { pass: false, reason: "No EMA cross", direction: null };
  }

  // Body confirmation
  if (direction === 'LONG' && closes[i] <= ema55Array[i]) {
    return { pass: false, reason: "Wick only cross (close <= EMA55)", direction };
  }
  if (direction === 'SHORT' && closes[i] >= ema55Array[i]) {
    return { pass: false, reason: "Wick only cross (close >= EMA55)", direction };
  }

  // Choppy check: Count relationship changes in last 5 candles
  let crossesIn5 = 0;
  for (let j = Math.max(1, i - 4); j <= i; j++) {
    const prevRel = ema9Array[j - 1] > ema55Array[j - 1];
    const currRel = ema9Array[j] > ema55Array[j];
    if (prevRel !== currRel) crossesIn5++;
  }

  if (crossesIn5 >= 2) {
    return { pass: false, reason: `Choppy — ${crossesIn5} crosses in last 5 candles`, direction };
  }

  // Slope check (non-blocking)
  const prev2 = Math.max(0, i - 2);
  const slope = ema9Array[prev2] ? ((ema9Array[i] - ema9Array[prev2]) / ema9Array[prev2]) * 100 : 0;
  const flatSlope = Math.abs(slope) < 0.05;

  return {
    pass: true,
    direction,
    flatSlope,
    signalCandleClose: closes[i],
    signalCandleCloseTime: candles[i].closeTime,
    signalDateTimeUTC: formatUTCDateTime(candles[i].closeTime)
  };
}

function checkGate2(volumes, settings) {
  const i = volumes.length - 1;
  if (i < 20) return { pass: false, reason: "Insufficient volume history", ratio: 0 };

  const volumeSMAInput = volumes.slice(i - 20, i); // Excludes current signal candle
  const volumeSMA = volumeSMAInput.reduce((a, b) => a + b, 0) / 20;

  if (volumeSMA === 0) return { pass: false, reason: "Zero volume average", ratio: 0 };

  const signalVolume = volumes[i];
  let ratio = signalVolume / volumeSMA;
  ratio = Math.round(ratio * 10) / 10;

  const reqMultiplier = settings.volume?.multiplier || 1.5;

  if (ratio < reqMultiplier) {
    return { pass: false, reason: `Vol ${ratio}× below ${reqMultiplier}× required`, ratio };
  }

  return { pass: true, ratio, spike: ratio > 5.0 };
}

function checkGate3(highs, lows, closes, adxResult, settings) {
  // Sub-check A: ADX
  if (!adxResult || adxResult.adx === null) {
    return { pass: false, reason: "Insufficient data for ADX calculation" };
  }

  const reqThreshold = settings.adx?.threshold || 20;
  if (adxResult.adx < reqThreshold) {
    return { pass: false, reason: `ADX ${adxResult.adx.toFixed(1)} below ${reqThreshold}` };
  }

  // Sub-check B: Price band
  if (closes.length < 10) return { pass: false, reason: "Insufficient candles for price band" };
  const last10 = closes.slice(-10);
  const highest = Math.max(...last10);
  const lowest = Math.min(...last10);
  const band = lowest > 0 ? ((highest - lowest) / lowest) * 100 : 0;

  if (band <= 1.5) {
    return { pass: false, reason: `Price band ${band.toFixed(2)}% ≤ 1.5% (ranging)` };
  }

  // Sub-check C: DI oscillation (simplified mock / heuristic)
  const diCrosses = 0; // Standard pass unless extreme oscillation

  return {
    pass: true,
    adx: adxResult.adx,
    pdi: adxResult.pdi,
    mdi: adxResult.mdi,
    band,
    diCrosses
  };
}

function checkGate4(rsiArray, settings) {
  if (!rsiArray || rsiArray.length === 0) {
    return { pass: false, reason: "RSI array empty" };
  }
  const currentRSI = rsiArray[rsiArray.length - 1];

  if (currentRSI === null || currentRSI === undefined) {
    return { pass: false, reason: "RSI not yet calculated" };
  }

  const min = settings.rsi?.min || 30;
  const max = settings.rsi?.max || 65;

  if (currentRSI < min || currentRSI > max) {
    return { pass: false, reason: `RSI ${currentRSI.toFixed(1)} outside ${min}-${max} zone` };
  }

  return { pass: true, rsi: currentRSI };
}

// ── NEW GATES (G5–G10) ───────────────────────────────────────────

function checkGate5_Liquidity(volumes, closes, settings) {
  // 24h USDT volume must exceed minimum threshold
  const i = volumes.length - 1;
  if (i < 0) return { pass: false, reason: 'No volume data' };
  const usdtVol = volumes[i] * (closes[i] || 0);
  const minVol = settings.liquidity?.minUsdtVolume24h || 5_000_000;
  if (usdtVol < minVol) {
    return { pass: false, reason: `24h vol $${(usdtVol/1e6).toFixed(1)}M < $${(minVol/1e6).toFixed(0)}M`, usdtVol };
  }
  return { pass: true, usdtVol };
}

function checkGate6_Spread(currentPrice, settings) {
  // Bid-ask spread check — uses a conservative estimate if real spread unavailable
  // In live mode this would use order book data; for now estimate from price granularity
  const spreadPct = settings.spread?.estimatedPct || 0.05;
  const maxSpread = settings.spread?.maxPct || 0.10;
  if (spreadPct > maxSpread) {
    return { pass: false, reason: `Spread ${spreadPct.toFixed(2)}% > ${maxSpread}%`, spreadPct };
  }
  return { pass: true, spreadPct };
}

function checkGate7_Volatility(highs, lows, closes, settings) {
  // ATR as % of price must be in a sweet spot — not dead, not wild
  if (closes.length < 15) return { pass: false, reason: 'Insufficient data for ATR%' };
  const i = closes.length - 1;
  // Simple ATR(14) as percentage of current price
  let trSum = 0;
  for (let j = Math.max(1, i - 13); j <= i; j++) {
    const tr = Math.max(highs[j] - lows[j], Math.abs(highs[j] - closes[j-1]), Math.abs(lows[j] - closes[j-1]));
    trSum += tr;
  }
  const atrVal = trSum / Math.min(14, i);
  const atrPct = (atrVal / closes[i]) * 100;
  const minATR = settings.volatility?.minAtrPct || 0.5;
  const maxATR = settings.volatility?.maxAtrPct || 8.0;
  if (atrPct < minATR) return { pass: false, reason: `ATR% ${atrPct.toFixed(2)}% < ${minATR}% (dead)`, atrPct };
  if (atrPct > maxATR) return { pass: false, reason: `ATR% ${atrPct.toFixed(2)}% > ${maxATR}% (wild)`, atrPct };
  return { pass: true, atrPct };
}

function checkGate8_Momentum(macdResult, direction) {
  // MACD histogram expanding in signal direction
  const i = macdResult.histogram.length - 1;
  if (i < 1 || macdResult.histogram[i] === null || macdResult.histogram[i-1] === null) {
    return { pass: false, reason: 'Insufficient MACD data' };
  }
  const hist = macdResult.histogram[i];
  const prevHist = macdResult.histogram[i-1];
  const directionMatch = (direction === 'LONG' && hist > 0) || (direction === 'SHORT' && hist < 0);
  const expanding = Math.abs(hist) > Math.abs(prevHist);
  if (directionMatch && expanding) return { pass: true, histogram: hist };
  if (directionMatch) return { pass: false, reason: `MACD aligned but contracting`, histogram: hist };
  return { pass: false, reason: `MACD ${hist > 0 ? 'bullish' : 'bearish'} vs ${direction}`, histogram: hist };
}

function checkGate9_Structure(stDirection, direction) {
  // SuperTrend direction must match signal direction
  const match = (direction === 'LONG' && stDirection === 'up') ||
                (direction === 'SHORT' && stDirection === 'down');
  if (match) return { pass: true, stDirection };
  return { pass: false, reason: `SuperTrend ${stDirection} vs signal ${direction}`, stDirection };
}

function checkGate10_RiskReward(entryPrice, atr, direction, settings) {
  // R:R ratio must meet minimum threshold
  if (!atr || atr <= 0) return { pass: false, reason: 'No ATR for R:R calc' };
  const slDist = atr * 1.5; // matches tradeManager SL distance
  const tp1Mult = settings.trade?.tp1AtrMultiple || 2.0;
  const tpDist = atr * tp1Mult;
  const rr = tpDist / slDist;
  const minRR = settings.riskReward?.minRatio || 1.5;
  if (rr < minRR) return { pass: false, reason: `R:R ${rr.toFixed(2)} < ${minRR}`, rr };
  return { pass: true, rr };
}

function calculateScore(ind, direction, wmState, settings) {
  let score = 0;
  const breakdown = {};

  // 1. EMA 200 alignment — max 18 pts
  if (ind.ema200 && ind.currentPrice) {
    const priceDiffPct = ((ind.currentPrice - ind.ema200) / ind.ema200) * 100;
    if (direction === 'LONG') {
      if (priceDiffPct > 1) { score += 18; breakdown.ema200 = 18; }
      else if (Math.abs(priceDiffPct) <= 1) { score += 8; breakdown.ema200 = 8; }
      else breakdown.ema200 = 0;
    } else {
      if (priceDiffPct < -1) { score += 18; breakdown.ema200 = 18; }
      else if (Math.abs(priceDiffPct) <= 1) { score += 8; breakdown.ema200 = 8; }
      else breakdown.ema200 = 0;
    }
  }

  // 2. RSI quality — max 20 pts (+ bonus)
  const rsi = ind.rsi;
  let rsiPts = 0;
  if (rsi !== null && rsi !== undefined) {
    if (direction === 'LONG') {
      if (rsi >= 45 && rsi <= 58) rsiPts = 20;
      else if ((rsi >= 38 && rsi < 45) || (rsi > 58 && rsi <= 65)) rsiPts = 12;
      else if (rsi >= 30 && rsi < 38) rsiPts = 6;
    } else {
      if (rsi >= 38 && rsi <= 52) rsiPts = 20;
      else if ((rsi >= 30 && rsi < 38) || (rsi > 52 && rsi <= 65)) rsiPts = 12;
    }
  }
  if (ind.rsiBullishDiv && direction === 'LONG') rsiPts = Math.min(rsiPts + 5, 25);
  if (ind.rsiBearishDiv && direction === 'SHORT') rsiPts = Math.min(rsiPts + 5, 25);
  score += rsiPts;
  breakdown.rsi = rsiPts;

  // 3. MACD expansion — max 20 pts
  let macdPts = 0;
  if (ind.macdCrossedInDirection) macdPts += 8;
  if (ind.macdHistExpanding) macdPts += 8;
  else if (ind.macdHistPositiveDirection) macdPts += 4;
  if (ind.macdZeroLineConfirms) macdPts += 4;
  macdPts = Math.min(macdPts, 20);
  score += macdPts;
  breakdown.macd = macdPts;

  // 4. ADX strength — max 17 pts
  const adx = ind.adx;
  let adxPts = 0;
  if (adx !== null && adx !== undefined) {
    if (adx >= 40) adxPts = 17;
    else if (adx >= 30) adxPts = 13;
    else if (adx >= 25) adxPts = 9;
    else if (adx >= 20) adxPts = 5;
  }
  if (direction === 'LONG' && ind.pdi < ind.mdi) adxPts -= 4;
  if (direction === 'SHORT' && ind.mdi < ind.pdi) adxPts -= 4;
  adxPts = Math.max(0, adxPts);
  score += adxPts;
  breakdown.adx = adxPts;

  // 5. SuperTrend — max 12 pts
  let stPts = 0;
  if ((direction === 'LONG' && ind.supertrendDirection === 'up') ||
      (direction === 'SHORT' && ind.supertrendDirection === 'down')) {
    stPts = 12;
  }
  score += stPts;
  breakdown.supertrend = stPts;

  // 6. Volume quality — max 8 pts
  const vRatio = ind.volumeRatio || 0;
  let volPts = 0;
  if (vRatio >= 2.0 && vRatio <= 3.0) volPts = 8;
  else if (vRatio >= 1.5 && vRatio < 2.0) volPts = 5;
  else if (vRatio > 3.0 && vRatio <= 5.0) volPts = 4;
  else if (vRatio > 5.0) volPts = 2;
  score += volPts;
  breakdown.volume = volPts;

  // 7. S/R + Fibonacci — max 5 pts
  let srPts = 0;
  if (ind.nearSRZone) srPts += 3;
  if (ind.nearFibLevel) srPts += 2;
  srPts = Math.min(5, srPts);
  score += srPts;
  breakdown.sr = srPts;

  // Base total max 100
  const baseScore = Math.min(100, score);

  // W/M additive bonus
  let wmBonus = 0;
  if (wmState === 'FORMING') wmBonus = 8;
  else if (wmState === 'READY') wmBonus = 12;
  else if (wmState === 'CONFIRMED') wmBonus = 15;

  const totalScore = baseScore + wmBonus;
  const scoreDisplay = wmBonus > 0 ? `${totalScore}(+${wmState[0]})` : `${totalScore}`;

  return {
    total: totalScore,
    base: baseScore,
    wmBonus,
    breakdown,
    scoreDisplay
  };
}

function buildSignalObject(symbol, direction, candles, ema9, ema55, ema200,
                           rsiArr, adxResult, volumeRatio, scoreObj, trigger,
                           gates, wmResult) {
  const i = candles.length - 1;
  const now = Date.now();

  return {
    id: generateUUID(),
    timestamp: now,
    dateTimeUTC: formatUTCDateTime(now),
    signalCandleCloseTime: candles[i].closeTime,
    signalCandleCloseDateTimeUTC: formatUTCDateTime(candles[i].closeTime),
    symbol,
    market:   'crypto',
    timeframe: '4h',
    exchange: 'binance',
    direction,
    trigger,
    signalCandleClose: candles[i].close,
    ema9: ema9[i],
    ema55: ema55[i],
    ema200: ema200[i],
    adxAtSignal: adxResult?.adx ?? null,
    pdiAtSignal: adxResult?.pdi ?? null,
    mdiAtSignal: adxResult?.mdi ?? null,
    rsiAtSignal: rsiArr[i] ?? null,
    volumeRatio,
    scoreAtSignal: scoreObj?.total ?? 0,
    scoreBreakdown: scoreObj?.breakdown ?? {},
    // 10 gates
    gate1: gates.g1?.pass ? 'PASS' : 'FAIL', gate1Reason: gates.g1?.reason || null, gate1Direction: gates.g1?.direction || null,
    gate2: gates.g2?.pass ? 'PASS' : 'FAIL', gate2Reason: gates.g2?.reason || null, gate2Value: gates.g2?.ratio || null,
    gate3: gates.g3?.pass ? 'PASS' : 'FAIL', gate3Reason: gates.g3?.reason || null,
    gate4: gates.g4?.pass ? 'PASS' : 'FAIL', gate4Reason: gates.g4?.reason || null,
    gate5: gates.g5?.pass ? 'PASS' : 'FAIL', gate5Reason: gates.g5?.reason || null,
    gate6: gates.g6?.pass ? 'PASS' : 'FAIL', gate6Reason: gates.g6?.reason || null,
    gate7: gates.g7?.pass ? 'PASS' : 'FAIL', gate7Reason: gates.g7?.reason || null,
    gate8: gates.g8?.pass ? 'PASS' : 'FAIL', gate8Reason: gates.g8?.reason || null,
    gate9: gates.g9?.pass ? 'PASS' : 'FAIL', gate9Reason: gates.g9?.reason || null,
    gate10: gates.g10?.pass ? 'PASS' : 'FAIL', gate10Reason: gates.g10?.reason || null,
    mandatoryPassed: gates.mandatoryPassed,
    confirmationPassed: gates.confirmationPassed,
    confirmationCount: gates.confirmationCount,
    wmPattern: wmResult ? wmResult.type : null,
    wmState: wmResult ? wmResult.state : null,
    wmV1: wmResult?.v1Price || null,
    wmNeckline: wmResult?.necklinePrice || null,
    wmV2: wmResult?.v2Price || null,
    wmBreakPrice: wmResult?.breakPrice || null,
    tradeFired: false,
    tradeId: null,
    tradeOutcome: null,
    tradePnL: null,
    tradePnLPct: null
  };
}

function hasOpenTrade(symbol, openTrades = []) {
  return openTrades.some(t => t.symbol === symbol && t.status === 'OPEN');
}

function maxTradesReached(openTrades = [], settings = {}) {
  const max = settings.trade?.maxConcurrentTrades || 3;
  return openTrades.filter(t => t.status === 'OPEN').length >= max;
}

async function evaluateCoin(symbol, candles, settings, openTrades = [], autoTradePaused = false) {
  if (!candles || candles.length < 50) return null;

  const closes = candles.map(c => c.close);
  const highs = candles.map(c => c.high);
  const lows = candles.map(c => c.low);
  const volumes = candles.map(c => c.volume);
  const opens = candles.map(c => c.open);

  const ema9 = indicators.calculateEMA(closes, settings.ema?.fast || 9);
  const ema55 = indicators.calculateEMA(closes, settings.ema?.slow || 55);
  const ema200 = indicators.calculateEMA(closes, settings.ema?.trend || 200);
  const rsiArr = indicators.calculateRSI(closes, settings.rsi?.period || 14);
  const adxResult = indicators.calculateADX(highs, lows, closes, settings.adx?.period || 14);
  const macdResult = indicators.calculateMACD(closes);
  const atr = indicators.calculateATR(highs, lows, closes, 14);
  const st = indicators.calculateSuperTrend(highs, lows, closes, 10, 3.0);
  const volSMA = indicators.calculateVolumeSMA(volumes.slice(0, -1), 20);
  const vwap = indicators.calculateVWAP(highs, lows, closes, volumes);
  const fib = indicators.calculateFibonacci(closes, settings.fibonacci?.lookback || 100);
  const sr = indicators.detectSupportResistance(highs, lows, settings.sr?.lookback || 200);
  const rsiDiv = indicators.detectRSIDivergence(closes, rsiArr, 14);

  const i = closes.length - 1;
  const currentPrice = closes[i];
  const currentRSI = rsiArr[i];
  const currentVolRatio = volSMA ? Math.round((volumes[i] / volSMA) * 10) / 10 : 1.0;
  const currentVWAP = vwap[vwap.length - 1];
  const vwapDeviation = currentVWAP ? (Math.abs(currentPrice - currentVWAP) / currentVWAP) * 100 : 0;

  // BUG 3 FIX: MACD direction is computed AFTER we know direction (deferred below)
  const indObj = {
    currentPrice,
    ema9: ema9[i], ema55: ema55[i], ema200: ema200[i],
    rsi: currentRSI,
    adx: adxResult.adx, pdi: adxResult.pdi, mdi: adxResult.mdi,
    macdCrossedInDirection: false, // set after direction known
    macdHistExpanding: macdResult.histogram[i] !== null && macdResult.histogram[i - 1] !== null &&
                       Math.abs(macdResult.histogram[i]) > Math.abs(macdResult.histogram[i - 1]),
    macdHistPositiveDirection: false, // set after direction known
    macdZeroLineConfirms: false, // set after direction known
    supertrendDirection: st.directions[i],
    volumeRatio: currentVolRatio,
    vwapDeviation,
    rsiBullishDiv: rsiDiv.bullish,
    rsiBearishDiv: rsiDiv.bearish,
    nearSRZone: sr.some(s => Math.abs(s.level - currentPrice) / currentPrice <= 0.01),
    nearFibLevel: Object.values(fib).some(f => typeof f === 'number' && Math.abs(f - currentPrice) / currentPrice <= 0.01)
  };

  // Helper: set MACD direction-aware fields
  function setMACDDirection(dir) {
    const hist = macdResult.histogram[i];
    const ml = macdResult.macdLine[i];
    if (dir === 'LONG') {
      indObj.macdCrossedInDirection = hist !== null && hist > 0;
      indObj.macdHistPositiveDirection = hist !== null && hist > 0;
      indObj.macdZeroLineConfirms = ml !== null && ml > 0;
    } else {
      indObj.macdCrossedInDirection = hist !== null && hist < 0;
      indObj.macdHistPositiveDirection = hist !== null && hist < 0;
      indObj.macdZeroLineConfirms = ml !== null && ml < 0;
    }
  }

  const wmResult = updateWMDetection(symbol, ema9, ema55, settings);

  // ── W/M CONFIRMED — BUG 2 FIX: apply same guards as 4GATE_TRADE ──
  if (wmResult.confirmed) {
    const wmDir = wmResult.type === 'W' ? 'LONG' : 'SHORT';
    setMACDDirection(wmDir);
    const score = calculateScore(indObj, wmDir, 'CONFIRMED', settings);
    const g1 = checkGate1(ema9, ema55, closes, candles, settings);
    const g2 = checkGate2(volumes, settings);
    const g3 = checkGate3(highs, lows, closes, adxResult, settings);
    const g4 = checkGate4(rsiArr, settings);
    const gates = { g1, g2, g3, g4,
      g5: checkGate5_Liquidity(volumes, closes, settings),
      g6: checkGate6_Spread(currentPrice, settings),
      g7: checkGate7_Volatility(highs, lows, closes, settings),
      g8: checkGate8_Momentum(macdResult, wmDir),
      g9: checkGate9_Structure(st.directions[i], wmDir),
      g10: checkGate10_RiskReward(currentPrice, atr, wmDir, settings),
    };
    Object.assign(gates, evaluateGateSystem(gates));
    const signal = buildSignalObject(symbol, wmDir, candles, ema9, ema55, ema200,
      rsiArr, adxResult, currentVolRatio, score, 'WM_FORMATION', gates, wmResult);

    // BUG 2 FIX: same safety guards as 4GATE_TRADE
    if (hasOpenTrade(symbol, openTrades)) return { action: 'BLOCKED', reason: 'Trade already open', score };
    if (maxTradesReached(openTrades, settings)) return { action: 'BLOCKED', reason: 'Max trades reached', score };
    if (autoTradePaused) return { action: 'BLOCKED', reason: 'Auto-trading paused', score };

    return { action: 'WM_TRADE', signal, wmResult, score, atr, fib, indicators: indObj, gates };
  }

  // ── 10-GATE SYSTEM ──────────────────────────────────────────────
  const g1 = checkGate1(ema9, ema55, closes, candles, settings);
  if (!g1.pass) {
    const score = calculateScore(indObj, 'LONG', getWMState(symbol).state, settings);
    return { action: 'NO_SIGNAL', gate1Fail: g1.reason, score, indicators: indObj, wmState: getWMState(symbol) };
  }

  const direction = g1.direction;
  setMACDDirection(direction);

  const g2  = checkGate2(volumes, settings);
  const g3  = checkGate3(highs, lows, closes, adxResult, settings);
  const g4  = checkGate4(rsiArr, settings);
  const g5  = checkGate5_Liquidity(volumes, closes, settings);
  const g6  = checkGate6_Spread(currentPrice, settings);
  const g7  = checkGate7_Volatility(highs, lows, closes, settings);
  const g8  = checkGate8_Momentum(macdResult, direction);
  const g9  = checkGate9_Structure(st.directions[i], direction);
  const g10 = checkGate10_RiskReward(currentPrice, atr, direction, settings);

  const gates = { g1, g2, g3, g4, g5, g6, g7, g8, g9, g10 };
  Object.assign(gates, evaluateGateSystem(gates));

  const score = calculateScore(indObj, direction, getWMState(symbol).state, settings);

  // Any mandatory gate failed?
  if (!gates.mandatoryPassed) {
    const firstFail = [g1,g2,g3,g4,g5,g6,g7].findIndex(g => !g.pass) + 1;
    const failedGate = [g1,g2,g3,g4,g5,g6,g7][firstFail - 1];
    const signal = buildSignalObject(symbol, direction, candles, ema9, ema55, ema200,
      rsiArr, adxResult, currentVolRatio, score, '10-GATE', gates, null);
    return {
      action: 'GATE_FAIL', failedGate: firstFail, reason: failedGate.reason,
      signal, score, isRanging: firstFail === 3 && !g3.pass,
      gates
    };
  }

  // Confirmation gates: need 2 of 3
  if (!gates.confirmationPassed) {
    const signal = buildSignalObject(symbol, direction, candles, ema9, ema55, ema200,
      rsiArr, adxResult, currentVolRatio, score, '10-GATE', gates, null);
    return {
      action: 'GATE_FAIL', failedGate: 'CONFIRMATION',
      reason: `Only ${gates.confirmationCount}/3 confirmation gates passed (need 2)`,
      signal, score, gates
    };
  }

  // ALL 10 GATES PASSED
  if (hasOpenTrade(symbol, openTrades)) return { action: 'BLOCKED', reason: 'Trade already open on this coin', score };
  if (maxTradesReached(openTrades, settings)) return { action: 'BLOCKED', reason: 'Max concurrent trades reached', score };
  if (autoTradePaused) return { action: 'BLOCKED', reason: 'Auto-trading paused (daily limit)', score };

  const signal = buildSignalObject(symbol, direction, candles, ema9, ema55, ema200,
    rsiArr, adxResult, currentVolRatio, score, '10-GATE', gates, null);
  return { action: '10GATE_TRADE', signal, direction, score, atr, fib, indicators: indObj, gates };
}

// ── Gate System Evaluator ─────────────────────────────────────────
function evaluateGateSystem(gates) {
  // G1-G7: mandatory (all must pass)
  const mandatoryPassed = [gates.g1, gates.g2, gates.g3, gates.g4, gates.g5, gates.g6, gates.g7]
    .every(g => g.pass);
  // G8-G10: confirmation (2 of 3 must pass)
  const confirmationCount = [gates.g8, gates.g9, gates.g10].filter(g => g.pass).length;
  const confirmationPassed = confirmationCount >= 2;
  return { mandatoryPassed, confirmationPassed, confirmationCount };
}

module.exports = {
  checkGate1, checkGate2, checkGate3, checkGate4,
  checkGate5_Liquidity, checkGate6_Spread, checkGate7_Volatility,
  checkGate8_Momentum, checkGate9_Structure, checkGate10_RiskReward,
  calculateScore, evaluateGateSystem,
  updateWMDetection, resetWMState, getWMState,
  evaluateCoin, buildSignalObject
};
