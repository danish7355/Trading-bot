/**
 * strategyPresets.js — Swappable strategy parameter sets
 *
 * Exactly ONE preset is active at a time. Applying a preset replaces
 * ALL previous strategy parameters — no blending.
 *
 * Stated win-rate and R:R figures are HISTORICAL / BACKTESTED assumptions.
 * They are NOT guarantees of future performance and do NOT constitute
 * financial advice.
 */

const PRESETS = {
  'ema-adx': {
    id:          'ema-adx',
    name:        'EMA Crossover + ADX Filter',
    description: 'Classic EMA9/EMA55 crossover with ADX trend-strength filter. Waits for momentum before entry — best in trending markets.',
    winRate:     '58–62%',
    rr:          '1:2.5',
    disclaimer:  'These figures are backtested estimates. Past performance does not guarantee future results.',
    params: {
      ema9Period:       9,
      ema55Period:      55,
      ema200Period:     200,
      adxThreshold:     25,
      rsiOverbought:    70,
      rsiOversold:      30,
      volumeThreshold:  1.5,
      tpPct:            3.75,
      slPct:            1.5,
      wm: { lookback: 25, v2TolerancePct: 2 },
    },
  },

  'breakout-atr': {
    id:          'breakout-atr',
    name:        'Breakout + High-ADX Momentum',
    description: 'Requires stronger ADX (≥30) to confirm an explosive breakout. Wider RSI bands to catch extreme momentum. Higher R:R but fewer signals.',
    winRate:     '52–56%',
    rr:          '1:3.5',
    disclaimer:  'These figures are backtested estimates. Past performance does not guarantee future results.',
    params: {
      ema9Period:       9,
      ema55Period:      55,
      ema200Period:     200,
      adxThreshold:     30,
      rsiOverbought:    75,
      rsiOversold:      25,
      volumeThreshold:  2.0,
      tpPct:            5.25,
      slPct:            1.5,
      wm: { lookback: 20, v2TolerancePct: 1.5 },
    },
  },

  'trend-continuation': {
    id:          'trend-continuation',
    name:        'Trend Continuation (EMA200 + Volume)',
    description: 'Follows the primary macro trend — only enters in the direction of EMA200. Requires high volume confirmation (2×). Longer holds for larger R:R.',
    winRate:     '55–60%',
    rr:          '1:4.0',
    disclaimer:  'These figures are backtested estimates. Past performance does not guarantee future results.',
    params: {
      ema9Period:       9,
      ema55Period:      55,
      ema200Period:     200,
      adxThreshold:     20,
      rsiOverbought:    65,
      rsiOversold:      35,
      volumeThreshold:  2.0,
      tpPct:            6.0,
      slPct:            1.5,
      wm: { lookback: 30, v2TolerancePct: 2.5 },
    },
  },
  'smc-structure': {
    id:          'smc-structure',
    name:        'Smart Money Concepts (SMC / PA)',
    description: 'Price Action & SMC Engine v2. Uses HTF bias, liquidity sweeps, order block retests, FVG fills, and BOS/CHoCH structural triggers.',
    winRate:     '60–65%',
    rr:          '1:3.0+',
    disclaimer:  'These figures are backtested estimates. Past performance does not guarantee future results.',
    params: {
      strategyEngine:   'v2',
      confidence_threshold: 0.55,
      wick_body_min:    1.5,
      tpPct:            4.5,
      slPct:            1.5,
      wm: { lookback: 25, v2TolerancePct: 2 },
    },
  },
};

function listPresets() {
  return Object.values(PRESETS).map(p => ({
    id:          p.id,
    name:        p.name,
    description: p.description,
    winRate:     p.winRate,
    rr:          p.rr,
    disclaimer:  p.disclaimer,
  }));
}

/**
 * Returns the settings patch to apply when switching to a preset.
 * Throws if the preset ID is unknown.
 */
function getPresetParams(id) {
  const p = PRESETS[id];
  if (!p) throw new Error(`Unknown strategy preset: "${id}"`);
  return { ...p.params, activePreset: id };
}

module.exports = { listPresets, getPresetParams, PRESETS };
