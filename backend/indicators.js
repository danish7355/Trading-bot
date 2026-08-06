function calculateEMA(closes, period) {
  if (!closes || closes.length < period) {
    return new Array(closes ? closes.length : 0).fill(null);
  }

  const multiplier = 2 / (period + 1);
  const result = new Array(closes.length).fill(null);

  // Seed with SMA
  let sum = 0;
  for (let i = 0; i < period; i++) {
    sum += closes[i];
  }
  result[period - 1] = sum / period;

  // Calculate EMA
  for (let i = period; i < closes.length; i++) {
    result[i] = (closes[i] - result[i - 1]) * multiplier + result[i - 1];
  }

  return result;
}

function calculateRSI(closes, period = 14) {
  if (!closes || closes.length <= period) {
    return new Array(closes ? closes.length : 0).fill(null);
  }

  const result = new Array(closes.length).fill(null);
  let gains = 0;
  let losses = 0;

  for (let i = 1; i <= period; i++) {
    const diff = closes[i] - closes[i - 1];
    if (diff >= 0) gains += diff;
    else losses += Math.abs(diff);
  }

  let avgGain = gains / period;
  let avgLoss = losses / period;

  if (avgLoss === 0) {
    result[period] = avgGain === 0 ? 50 : 100;
  } else {
    const rs = avgGain / avgLoss;
    result[period] = 100 - (100 / (1 + rs));
  }

  for (let i = period + 1; i < closes.length; i++) {
    const diff = closes[i] - closes[i - 1];
    const gain = diff >= 0 ? diff : 0;
    const loss = diff < 0 ? Math.abs(diff) : 0;

    avgGain = ((avgGain * (period - 1)) + gain) / period;
    avgLoss = ((avgLoss * (period - 1)) + loss) / period;

    if (avgLoss === 0) {
      result[i] = avgGain === 0 ? 50 : 100;
    } else {
      const rs = avgGain / avgLoss;
      result[i] = 100 - (100 / (1 + rs));
    }
  }

  return result;
}

function calculateADX(highs, lows, closes, period = 14) {
  const minRequired = period * 2; // Default 28
  if (!closes || closes.length < minRequired) {
    return { adx: null, pdi: null, mdi: null };
  }

  const n = closes.length;
  const tr = new Array(n).fill(0);
  const plusDM = new Array(n).fill(0);
  const minusDM = new Array(n).fill(0);

  for (let i = 1; i < n; i++) {
    const upMove = highs[i] - highs[i - 1];
    const downMove = lows[i - 1] - lows[i];

    if (upMove > downMove && upMove > 0) {
      plusDM[i] = upMove;
    }
    if (downMove > upMove && downMove > 0) {
      minusDM[i] = downMove;
    }

    const tr1 = highs[i] - lows[i];
    const tr2 = Math.abs(highs[i] - closes[i - 1]);
    const tr3 = Math.abs(lows[i] - closes[i - 1]);
    tr[i] = Math.max(tr1, tr2, tr3);
  }

  // Initial smoothed TR, +DM, -DM
  let smoothedTR = 0;
  let smoothedPlusDM = 0;
  let smoothedMinusDM = 0;

  for (let i = 1; i <= period; i++) {
    smoothedTR += tr[i];
    smoothedPlusDM += plusDM[i];
    smoothedMinusDM += minusDM[i];
  }

  const dxList = [];
  let pdiVal = 0;
  let mdiVal = 0;

  for (let i = period + 1; i < n; i++) {
    smoothedTR = smoothedTR - (smoothedTR / period) + tr[i];
    smoothedPlusDM = smoothedPlusDM - (smoothedPlusDM / period) + plusDM[i];
    smoothedMinusDM = smoothedMinusDM - (smoothedMinusDM / period) + minusDM[i];

    pdiVal = smoothedTR === 0 ? 0 : (smoothedPlusDM / smoothedTR) * 100;
    mdiVal = smoothedTR === 0 ? 0 : (smoothedMinusDM / smoothedTR) * 100;

    const diSum = pdiVal + mdiVal;
    const diDiff = Math.abs(pdiVal - mdiVal);
    const dx = diSum === 0 ? 0 : (diDiff / diSum) * 100;
    dxList.push(dx);
  }

  if (dxList.length < period) {
    return { adx: null, pdi: null, mdi: null };
  }

  let adx = dxList.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = period; i < dxList.length; i++) {
    adx = ((adx * (period - 1)) + dxList[i]) / period;
  }

  return {
    adx: Math.round(adx * 10) / 10,
    pdi: Math.round(pdiVal * 10) / 10,
    mdi: Math.round(mdiVal * 10) / 10
  };
}

function calculateMACD(closes, fast = 12, slow = 26, signal = 9) {
  const fastEMA = calculateEMA(closes, fast);
  const slowEMA = calculateEMA(closes, slow);
  const macdLine = new Array(closes.length).fill(null);

  for (let i = 0; i < closes.length; i++) {
    if (fastEMA[i] !== null && slowEMA[i] !== null) {
      macdLine[i] = fastEMA[i] - slowEMA[i];
    }
  }

  const validMacdValues = macdLine.filter(v => v !== null);
  const signalEMA = calculateEMA(validMacdValues, signal);

  const signalLine = new Array(closes.length).fill(null);
  const histogram = new Array(closes.length).fill(null);

  let validIdx = 0;
  for (let i = 0; i < closes.length; i++) {
    if (macdLine[i] !== null) {
      signalLine[i] = signalEMA[validIdx];
      if (signalLine[i] !== null) {
        histogram[i] = macdLine[i] - signalLine[i];
      }
      validIdx++;
    }
  }

  return { macdLine, signalLine, histogram };
}

function calculateATR(highs, lows, closes, period = 14) {
  if (!closes || closes.length < period + 1) return null;

  const tr = [];
  for (let i = 1; i < closes.length; i++) {
    const tr1 = highs[i] - lows[i];
    const tr2 = Math.abs(highs[i] - closes[i - 1]);
    const tr3 = Math.abs(lows[i] - closes[i - 1]);
    tr.push(Math.max(tr1, tr2, tr3));
  }

  let atr = tr.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = period; i < tr.length; i++) {
    atr = ((atr * (period - 1)) + tr[i]) / period;
  }

  return atr;
}

function calculateSuperTrend(highs, lows, closes, atrPeriod = 10, mult = 3.0) {
  const n = closes.length;
  const values = new Array(n).fill(null);
  const directions = new Array(n).fill(null);

  if (n < atrPeriod + 1) return { values, directions };

  // Compute full ATR array once (Wilder's smoothing preserved)
  const trArray = [0];
  for (let i = 1; i < n; i++) {
    const hl = highs[i] - lows[i];
    const hc = Math.abs(highs[i] - closes[i - 1]);
    const lc = Math.abs(lows[i] - closes[i - 1]);
    trArray.push(Math.max(hl, hc, lc));
  }
  const atrArray = new Array(n).fill(null);
  let atrSum = 0;
  for (let i = 1; i <= atrPeriod; i++) atrSum += trArray[i];
  atrArray[atrPeriod] = atrSum / atrPeriod;
  for (let i = atrPeriod + 1; i < n; i++) {
    atrArray[i] = (atrArray[i - 1] * (atrPeriod - 1) + trArray[i]) / atrPeriod;
  }

  const upperBand = new Array(n).fill(0);
  const lowerBand = new Array(n).fill(0);

  for (let i = atrPeriod; i < n; i++) {
    const hl2 = (highs[i] + lows[i]) / 2;
    const atr = atrArray[i] || 0;
    upperBand[i] = hl2 + mult * atr;
    lowerBand[i] = hl2 - mult * atr;
  }

  let isUp = true;

  for (let i = atrPeriod + 1; i < n; i++) {
    if (lowerBand[i] > lowerBand[i - 1] || closes[i - 1] < lowerBand[i - 1]) {
      lowerBand[i] = lowerBand[i];
    } else {
      lowerBand[i] = lowerBand[i - 1];
    }

    if (upperBand[i] < upperBand[i - 1] || closes[i - 1] > upperBand[i - 1]) {
      upperBand[i] = upperBand[i];
    } else {
      upperBand[i] = upperBand[i - 1];
    }

    if (isUp && closes[i] < lowerBand[i]) {
      isUp = false;
    } else if (!isUp && closes[i] > upperBand[i]) {
      isUp = true;
    }

    directions[i] = isUp ? 'up' : 'down';
    values[i] = isUp ? lowerBand[i] : upperBand[i];
  }

  return { values, directions };
}

function calculateVolumeSMA(volumes, period = 20) {
  if (!volumes || volumes.length < period) return null;
  const recent = volumes.slice(-period);
  const sum = recent.reduce((a, b) => a + b, 0);
  return sum / period;
}

function calculateVWAP(highs, lows, closes, volumes) {
  const n = closes.length;
  const vwap = new Array(n).fill(null);
  let cumTPV = 0;
  let cumVol = 0;

  for (let i = 0; i < n; i++) {
    const tp = (highs[i] + lows[i] + closes[i]) / 3;
    const vol = volumes[i] || 1;
    cumTPV += tp * vol;
    cumVol += vol;
    vwap[i] = cumVol > 0 ? cumTPV / cumVol : closes[i];
  }

  return vwap;
}

function calculateFibonacci(closes, lookback = 100) {
  if (!closes || closes.length === 0) {
    return { swingHigh: 0, swingLow: 0, range: 0 };
  }
  const slice = closes.slice(-lookback);
  const swingHigh = Math.max(...slice);
  const swingLow = Math.min(...slice);
  const range = swingHigh - swingLow;

  return {
    swingHigh,
    swingLow,
    range,
    level0: swingHigh,
    level236: swingHigh - range * 0.236,
    level382: swingHigh - range * 0.382,
    level500: swingHigh - range * 0.500,
    level618: swingHigh - range * 0.618,
    level786: swingHigh - range * 0.786,
    level1000: swingLow,
    ext1272: swingHigh + range * 0.272,
    ext1618: swingHigh + range * 0.618
  };
}

function detectSupportResistance(highs, lows, lookback = 200) {
  if (!highs || highs.length < 20) return [];
  const startIdx = Math.max(0, highs.length - lookback);
  const pivots = [];

  for (let i = startIdx + 2; i < highs.length - 2; i++) {
    if (highs[i] > highs[i - 1] && highs[i] > highs[i - 2] &&
        highs[i] > highs[i + 1] && highs[i] > highs[i + 2]) {
      pivots.push({ level: highs[i], type: 'resistance' });
    }
    if (lows[i] < lows[i - 1] && lows[i] < lows[i - 2] &&
        lows[i] < lows[i + 1] && lows[i] < lows[i + 2]) {
      pivots.push({ level: lows[i], type: 'support' });
    }
  }

  // Cluster levels within 1%
  const clusters = [];
  pivots.forEach(p => {
    const existing = clusters.find(c => Math.abs(c.level - p.level) / p.level <= 0.01 && c.type === p.type);
    if (existing) {
      existing.strength++;
      existing.level = (existing.level + p.level) / 2;
    } else {
      clusters.push({ level: p.level, type: p.type, strength: 1 });
    }
  });

  return clusters.sort((a, b) => b.strength - a.strength).slice(0, 8);
}

function detectRSIDivergence(closes, rsiValues, lookback = 14) {
  if (!closes || !rsiValues || closes.length < lookback) {
    return { bullish: false, bearish: false };
  }

  const cSlice = closes.slice(-lookback);
  const rSlice = rsiValues.slice(-lookback);

  let bullish = false;
  let bearish = false;

  const minPriceIdx = cSlice.indexOf(Math.min(...cSlice));
  const maxPriceIdx = cSlice.indexOf(Math.max(...cSlice));

  if (minPriceIdx > 0 && minPriceIdx < lookback - 1) {
    if (cSlice[cSlice.length - 1] <= cSlice[minPriceIdx] && rSlice[rSlice.length - 1] > rSlice[minPriceIdx]) {
      bullish = true;
    }
  }

  if (maxPriceIdx > 0 && maxPriceIdx < lookback - 1) {
    if (cSlice[cSlice.length - 1] >= cSlice[maxPriceIdx] && rSlice[rSlice.length - 1] < rSlice[maxPriceIdx]) {
      bearish = true;
    }
  }

  return { bullish, bearish };
}

function detectCandlePattern(opens, highs, lows, closes, direction) {
  if (!closes || closes.length < 3) return { patternFound: false, patternName: null };
  const i = closes.length - 1;

  if (direction === 'LONG') {
    // Bullish Engulfing
    if (closes[i - 1] < opens[i - 1] && closes[i] > opens[i] && closes[i] > opens[i - 1]) {
      return { patternFound: true, patternName: 'Bullish Engulfing' };
    }
    // Hammer / Pin Bar
    const body = Math.abs(closes[i] - opens[i]);
    const lowerWick = Math.min(opens[i], closes[i]) - lows[i];
    if (lowerWick > body * 2) {
      return { patternFound: true, patternName: 'Bullish Hammer/Pin Bar' };
    }
  } else {
    // Bearish Engulfing
    if (closes[i - 1] > opens[i - 1] && closes[i] < opens[i] && closes[i] < opens[i - 1]) {
      return { patternFound: true, patternName: 'Bearish Engulfing' };
    }
    // Shooting Star / Bearish Pin Bar
    const body = Math.abs(closes[i] - opens[i]);
    const upperWick = highs[i] - Math.max(opens[i], closes[i]);
    if (upperWick > body * 2) {
      return { patternFound: true, patternName: 'Shooting Star/Pin Bar' };
    }
  }

  return { patternFound: false, patternName: null };
}

function calculateAllIndicators(candles) {
  if (!candles || candles.length === 0) return {};
  const opens = candles.map(c => c.open);
  const highs = candles.map(c => c.high);
  const lows = candles.map(c => c.low);
  const closes = candles.map(c => c.close);
  const volumes = candles.map(c => c.volume);

  const ema9 = calculateEMA(closes, 9);
  const ema55 = calculateEMA(closes, 55);
  const ema200 = calculateEMA(closes, 200);
  const rsi = calculateRSI(closes, 14);
  const adxObj = calculateADX(highs, lows, closes, 14);
  const macdObj = calculateMACD(closes, 12, 26, 9);
  const atr = calculateATR(highs, lows, closes, 14);
  const stObj = calculateSuperTrend(highs, lows, closes, 10, 3.0);
  const volSMA = calculateVolumeSMA(volumes, 20);
  const vwap = calculateVWAP(highs, lows, closes, volumes);

  return {
    opens, highs, lows, closes, volumes,
    ema9, ema55, ema200,
    rsi, adxObj, macdObj, atr,
    stObj, volSMA, vwap
  };
}

module.exports = {
  calculateEMA,
  calculateRSI,
  calculateADX,
  calculateMACD,
  calculateATR,
  calculateSuperTrend,
  calculateVolumeSMA,
  calculateVWAP,
  calculateFibonacci,
  detectSupportResistance,
  detectRSIDivergence,
  detectCandlePattern,
  calculateAllIndicators
};
