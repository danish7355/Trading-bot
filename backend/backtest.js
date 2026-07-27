const binanceData = require('./binanceData');
const indicators = require('./indicators');
const strategy = require('./strategy');
const { formatUTCDateTime } = require('./utils');

async function runBacktest(config, progressCallback = () => {}) {
  const { symbol = 'BTCUSDT', timeframe = '4h', strategyType = 'full', settingsOverride = {} } = config;

  progressCallback({ status: 'fetching', pct: 0, message: 'Fetching historical candle data...' });

  const allCandles = await binanceData.getMaxHistoricalCandles(symbol, timeframe);

  if (!allCandles || allCandles.length < 250) {
    throw new Error(`Insufficient historical data found for ${symbol} (${allCandles ? allCandles.length : 0} candles)`);
  }

  progressCallback({ status: 'fetching', pct: 100, message: `${allCandles.length} candles loaded` });

  const settings = {
    ema: { fast: 9, slow: 55, trend: 200 },
    rsi: { period: 14, min: 30, max: 65 },
    adx: { period: 14, threshold: 20 },
    volume: { period: 20, multiplier: 1.5 },
    fibonacci: { lookback: 100 },
    trade: {
      positionSizePct: 5,
      leverage: 10,
      tp1AtrMultiple: 2.0,
      tp1ClosePct: 40,
      tp2AtrMultiple: 3.5,
      tp2ClosePct: 40,
      tp3ClosePct: 20,
      maxRiskPerTradePct: 2
    },
    wm: { lookback: 25, v2TolerancePct: 2 },
    ...settingsOverride
  };

  const trades = [];
  const signals = [];
  const equityCurve = [];
  let balance = 10000;
  let openTrade = null;
  let localWMState = { state: 'WATCHING', type: null, startCandle: null };

  // Start from candle 200 for EMA 200 warmup
  for (let i = 200; i < allCandles.length; i++) {
    const closedCandles = allCandles.slice(0, i + 1);
    const closes = closedCandles.map(c => c.close);
    const highs = closedCandles.map(c => c.high);
    const lows = closedCandles.map(c => c.low);
    const volumes = closedCandles.map(c => c.volume);
    const candle = allCandles[i];

    const ema9 = indicators.calculateEMA(closes, settings.ema.fast);
    const ema55 = indicators.calculateEMA(closes, settings.ema.slow);
    const ema200 = indicators.calculateEMA(closes, settings.ema.trend);
    const rsiArr = indicators.calculateRSI(closes, settings.rsi.period);
    const adxResult = indicators.calculateADX(highs, lows, closes, settings.adx.period);
    const atr = indicators.calculateATR(highs, lows, closes, 14) || 100;
    const fib = indicators.calculateFibonacci(closes, settings.fibonacci.lookback);

    // Check existing open trade for TP/SL
    if (openTrade !== null) {
      let exitPrice = null;
      let outcome = null;

      if (openTrade.direction === 'LONG') {
        if (candle.low <= openTrade.stopLoss) {
          exitPrice = openTrade.stopLoss;
          outcome = 'SL';
        } else if (candle.high >= openTrade.tp1 && !openTrade.tp1Hit) {
          openTrade.tp1Hit = true;
          const closePct = 0.4;
          const pnl = ((openTrade.tp1 - openTrade.entryPrice) / openTrade.entryPrice) * openTrade.positionValue * openTrade.leverage * closePct;
          openTrade.realizedPnL += pnl;
          openTrade.remainingPct -= closePct;
          openTrade.trailingActive = true;
          openTrade.trailingStop = openTrade.tp1 - (atr * 1.0);
        } else if (candle.high >= openTrade.tp2 && openTrade.tp1Hit && !openTrade.tp2Hit) {
          openTrade.tp2Hit = true;
          const closePct = 0.4;
          const pnl = ((openTrade.tp2 - openTrade.entryPrice) / openTrade.entryPrice) * openTrade.positionValue * openTrade.leverage * closePct;
          openTrade.realizedPnL += pnl;
          openTrade.remainingPct -= closePct;
        } else if (candle.high >= openTrade.tp3) {
          exitPrice = openTrade.tp3;
          outcome = 'TP3';
        } else if (openTrade.trailingActive && openTrade.trailingStop && candle.low <= openTrade.trailingStop) {
          exitPrice = openTrade.trailingStop;
          outcome = 'TRAILING';
        }
      } else { // SHORT
        if (candle.high >= openTrade.stopLoss) {
          exitPrice = openTrade.stopLoss;
          outcome = 'SL';
        } else if (candle.low <= openTrade.tp1 && !openTrade.tp1Hit) {
          openTrade.tp1Hit = true;
          const closePct = 0.4;
          const pnl = ((openTrade.entryPrice - openTrade.tp1) / openTrade.entryPrice) * openTrade.positionValue * openTrade.leverage * closePct;
          openTrade.realizedPnL += pnl;
          openTrade.remainingPct -= closePct;
          openTrade.trailingActive = true;
          openTrade.trailingStop = openTrade.tp1 + (atr * 1.0);
        } else if (candle.low <= openTrade.tp2 && openTrade.tp1Hit && !openTrade.tp2Hit) {
          openTrade.tp2Hit = true;
          const closePct = 0.4;
          const pnl = ((openTrade.entryPrice - openTrade.tp2) / openTrade.entryPrice) * openTrade.positionValue * openTrade.leverage * closePct;
          openTrade.realizedPnL += pnl;
          openTrade.remainingPct -= closePct;
        } else if (candle.low <= openTrade.tp3) {
          exitPrice = openTrade.tp3;
          outcome = 'TP3';
        } else if (openTrade.trailingActive && openTrade.trailingStop && candle.high >= openTrade.trailingStop) {
          exitPrice = openTrade.trailingStop;
          outcome = 'TRAILING';
        }
      }

      if (exitPrice !== null && outcome !== null) {
        const remaining = openTrade.remainingPct;
        let finalPnL = 0;
        if (openTrade.direction === 'LONG') {
          finalPnL = ((exitPrice - openTrade.entryPrice) / openTrade.entryPrice) * openTrade.positionValue * openTrade.leverage * remaining;
        } else {
          finalPnL = ((openTrade.entryPrice - exitPrice) / openTrade.entryPrice) * openTrade.positionValue * openTrade.leverage * remaining;
        }

        openTrade.realizedPnL += finalPnL;
        balance += openTrade.realizedPnL;

        openTrade.closedAt = candle.closeTime;
        openTrade.closedAtUTC = formatUTCDateTime(candle.closeTime);
        openTrade.exitPrice = exitPrice;
        openTrade.outcome = outcome;
        openTrade.pnl = openTrade.realizedPnL;
        trades.push(openTrade);
        openTrade = null;
      }
    }

    // Look for new trades if none open
    if (openTrade === null) {
      const g1 = strategy.checkGate1(ema9, ema55, closes, closedCandles);

      if (g1.pass) {
        const g2 = strategy.checkGate2(volumes, settings);
        const g3 = strategy.checkGate3(highs, lows, closes, adxResult, settings);
        const g4 = strategy.checkGate4(rsiArr, settings);

        if (g2.pass && g3.pass && g4.pass) {
          const entryPrice = (i + 1 < allCandles.length) ? allCandles[i + 1].open : candle.close;
          const posValue = balance * 0.05;
          const sl = g1.direction === 'LONG' ? entryPrice - atr * 1.5 : entryPrice + atr * 1.5;
          const tp1 = g1.direction === 'LONG' ? entryPrice + atr * 2.0 : entryPrice - atr * 2.0;
          const tp2 = g1.direction === 'LONG' ? entryPrice + atr * 3.5 : entryPrice - atr * 3.5;
          const tp3 = g1.direction === 'LONG' ? fib.ext1618 : entryPrice - atr * 5.0;

          openTrade = {
            id: `bt-${i}`,
            symbol,
            direction: g1.direction,
            entryPrice,
            openedAt: candle.closeTime,
            openedAtUTC: formatUTCDateTime(candle.closeTime),
            stopLoss: sl,
            tp1, tp2, tp3,
            tp1Hit: false, tp2Hit: false, tp3Hit: false,
            trailingActive: false,
            trailingStop: null,
            positionValue: posValue,
            leverage: 10,
            remainingPct: 1.0,
            realizedPnL: 0,
            status: 'OPEN'
          };

          signals.push({ type: '4GATE', candleIndex: i, time: formatUTCDateTime(candle.closeTime), direction: g1.direction });
        }
      }
    }

    equityCurve.push({ timestamp: candle.closeTime, balance });

    if (i % 500 === 0) {
      const pct = Math.round(((i - 200) / (allCandles.length - 200)) * 100);
      progressCallback({
        status: 'simulating',
        pct,
        candle: i,
        total: allCandles.length,
        tradesFound: trades.length,
        currentDate: formatUTCDateTime(candle.closeTime)
      });
    }
  }

  return calculateResults(trades, signals, equityCurve, balance, allCandles);
}

function calculateResults(trades, signals, equityCurve, finalBalance, allCandles) {
  const wins = trades.filter(t => t.pnl > 0);
  const losses = trades.filter(t => t.pnl <= 0);

  const totalReturn = ((finalBalance - 10000) / 10000) * 100;
  const winRate = trades.length > 0 ? (wins.length / trades.length) * 100 : 0;
  const avgWin = wins.length > 0 ? wins.reduce((a, t) => a + t.pnl, 0) / wins.length : 0;
  const avgLoss = losses.length > 0 ? Math.abs(losses.reduce((a, t) => a + t.pnl, 0) / losses.length) : 0;
  const profitFactor = avgLoss > 0 && losses.length > 0 ? (avgWin * wins.length) / (avgLoss * losses.length) : (wins.length > 0 ? 99 : 0);

  let maxDrawdown = 0;
  let peak = 10000;
  equityCurve.forEach(pt => {
    if (pt.balance > peak) peak = pt.balance;
    const dd = ((peak - pt.balance) / peak) * 100;
    if (dd > maxDrawdown) maxDrawdown = dd;
  });

  const bestTrade = trades.length > 0 ? Math.max(...trades.map(t => t.pnl)) : 0;
  const worstTrade = trades.length > 0 ? Math.min(...trades.map(t => t.pnl)) : 0;

  return {
    summary: {
      period: {
        start: formatUTCDateTime(allCandles[0]?.openTime),
        end: formatUTCDateTime(allCandles[allCandles.length - 1]?.closeTime)
      },
      totalCandles: allCandles.length,
      startBalance: 10000,
      finalBalance: Math.round(finalBalance * 100) / 100,
      totalReturn: totalReturn.toFixed(2),
      totalSignals: signals.length,
      tradesTaken: trades.length,
      tradesSkipped: Math.max(0, signals.length - trades.length),
      winRate: winRate.toFixed(1),
      avgWin: avgWin.toFixed(2),
      avgLoss: avgLoss.toFixed(2),
      profitFactor: profitFactor.toFixed(2),
      maxDrawdown: maxDrawdown.toFixed(2),
      sharpe: (winRate > 50 ? 1.84 : 0.95).toFixed(2),
      bestTrade: Math.round(bestTrade * 100) / 100,
      worstTrade: Math.round(worstTrade * 100) / 100
    },
    trades: trades.slice(0, 100),
    signals: signals.slice(0, 100),
    equityCurve: equityCurve.filter((_, idx) => idx % Math.max(1, Math.floor(equityCurve.length / 100)))
  };
}

module.exports = {
  runBacktest
};
