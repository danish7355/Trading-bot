let chartInstance = null;
let mainCandleSeries = null;
let ema9Series = null;
let ema55Series = null;
let ema200Series = null;
let vwapSeries = null;
let currentChartSymbol = null;

function initMainChart(containerId, data) {
  const container = document.getElementById(containerId);
  if (!container) return;

  container.innerHTML = '';

  chartInstance = LightweightCharts.createChart(container, {
    width: container.offsetWidth || 800,
    height: 450,
    layout: {
      background: { color: '#0a0a0f' },
      textColor: '#e0e0e0'
    },
    grid: {
      vertLines: { color: '#1e1e2e' },
      horzLines: { color: '#1e1e2e' }
    },
    crosshair: {
      mode: LightweightCharts.CrosshairMode.Normal
    },
    rightPriceScale: {
      borderColor: '#1e1e2e'
    },
    timeScale: {
      borderColor: '#1e1e2e',
      timeVisible: true,
      secondsVisible: false
    }
  });

  mainCandleSeries = chartInstance.addCandlestickSeries({
    upColor: '#00ff88',
    downColor: '#ff3366',
    borderUpColor: '#00ff88',
    borderDownColor: '#ff3366',
    wickUpColor: '#00ff88',
    wickDownColor: '#ff3366'
  });

  const candleData = (data.candles || []).map(c => ({
    time: c.time,
    open: c.open,
    high: c.high,
    low: c.low,
    close: c.close
  }));
  mainCandleSeries.setData(candleData);

  // EMA 9 (blue)
  if (data.indicators?.ema9) {
    ema9Series = chartInstance.addLineSeries({ color: '#0088ff', lineWidth: 2, title: 'EMA9' });
    const ema9Data = data.indicators.ema9
      .map((v, i) => v !== null ? { time: data.candles[i].time, value: v } : null)
      .filter(Boolean);
    ema9Series.setData(ema9Data);
  }

  // EMA 55 (orange)
  if (data.indicators?.ema55) {
    ema55Series = chartInstance.addLineSeries({ color: '#ff9900', lineWidth: 2, title: 'EMA55' });
    const ema55Data = data.indicators.ema55
      .map((v, i) => v !== null ? { time: data.candles[i].time, value: v } : null)
      .filter(Boolean);
    ema55Series.setData(ema55Data);
  }

  // EMA 200 (purple)
  if (data.indicators?.ema200) {
    ema200Series = chartInstance.addLineSeries({ color: '#aa44ff', lineWidth: 1, title: 'EMA200' });
    const ema200Data = data.indicators.ema200
      .map((v, i) => v !== null ? { time: data.candles[i].time, value: v } : null)
      .filter(Boolean);
    ema200Series.setData(ema200Data);
  }

  // VWAP (white dotted)
  if (data.indicators?.vwap) {
    vwapSeries = chartInstance.addLineSeries({ color: '#ffffff', lineWidth: 1, lineStyle: 2, title: 'VWAP' });
    const vwapData = data.indicators.vwap
      .map((v, i) => v !== null ? { time: data.candles[i].time, value: v } : null)
      .filter(Boolean);
    vwapSeries.setData(vwapData);
  }

  // Fibonacci lines
  if (data.fibonacci) {
    Object.entries(data.fibonacci).forEach(([key, level]) => {
      if ((key.startsWith('level') || key.startsWith('ext')) && typeof level === 'number') {
        mainCandleSeries.createPriceLine({
          price: level,
          color: 'rgba(255,170,0,0.4)',
          lineWidth: 1,
          lineStyle: 2,
          axisLabelVisible: true,
          title: `Fib ${key.replace('level', '').replace('ext', 'Ext ')}`
        });
      }
    });
  }

  // Open trade levels
  if (data.openTrade) {
    const trade = data.openTrade;
    mainCandleSeries.createPriceLine({
      price: trade.entryPrice,
      color: '#0088ff',
      lineWidth: 2,
      axisLabelVisible: true,
      title: `ENTRY (${trade.direction})`
    });
    mainCandleSeries.createPriceLine({
      price: trade.stopLoss,
      color: '#ff3366',
      lineWidth: 2,
      axisLabelVisible: true,
      title: 'SL'
    });
    mainCandleSeries.createPriceLine({
      price: trade.tp1,
      color: '#00ff88',
      lineWidth: 1,
      lineStyle: 2,
      axisLabelVisible: true,
      title: 'TP1 (40%)'
    });
    mainCandleSeries.createPriceLine({
      price: trade.tp2,
      color: '#00ff88',
      lineWidth: 1,
      lineStyle: 2,
      axisLabelVisible: true,
      title: 'TP2 (40%)'
    });
    mainCandleSeries.createPriceLine({
      price: trade.tp3,
      color: '#00ff88',
      lineWidth: 2,
      axisLabelVisible: true,
      title: 'TP3 (20%)'
    });
  }

  window.addEventListener('resize', () => {
    if (chartInstance && container) {
      chartInstance.applyOptions({ width: container.offsetWidth });
    }
  });
}

function updateChartTick(price) {
  if (mainCandleSeries && price) {
    const now = Math.floor(Date.now() / 1000);
    mainCandleSeries.update({ time: now, close: price });
  }
}
