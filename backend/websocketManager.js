const WebSocket = require('ws');
const axios = require('axios');

// In-memory price map — always current
const priceMap = {};
const change24hMap = {};
let priceWS = null;
let klineWS = null;
let priceReconnectAttempts = 0;
let klineReconnectAttempts = 0;
let currentSymbols = [];
let currentTimeframe = '4h';
let onCandleCloseCallback = null;
let onPriceTickCallback = null;
let broadcastFn = null;
let restPollingInterval = null;
let lastKlineCheckTime = {};

function setBroadcast(fn) {
  broadcastFn = fn;
}

// ══════════════════════════════════════════
// PRICE TICKER STREAM + REST FALLBACK POLLING
// ══════════════════════════════════════════

function startPriceStream(symbols, priceTickCb = null) {
  currentSymbols = symbols;
  if (priceTickCb) onPriceTickCallback = priceTickCb;

  // Start fast REST Polling Engine (every 1.5s) to guarantee 100% live updates on all networks
  startRestPricePolling(symbols);

  // Attempt WebSocket stream in parallel
  if (priceWS) {
    priceWS.terminate();
    priceWS = null;
  }
  connectPriceStream(symbols);
}

function startRestPricePolling(symbols) {
  if (restPollingInterval) clearInterval(restPollingInterval);

  console.log('[REST TICKER] Starting ultra-fast 1.5s ticker polling engine for', symbols.length, 'symbols');

  const pollPrices = async () => {
    try {
      let rawData = null;
      try {
        const response = await axios.get('https://fapi.binance.com/fapi/v1/ticker/24hr', { timeout: 5000 });
        if (Array.isArray(response.data)) rawData = response.data;
      } catch (e1) {
        try {
          const response = await axios.get('https://api.binance.com/api/v3/ticker/24hr', { timeout: 5000 });
          if (Array.isArray(response.data)) rawData = response.data;
        } catch (e2) {
          console.error('[REST TICKER ERROR] Failed to fetch REST prices:', e2.message);
        }
      }

      if (!rawData || !Array.isArray(rawData)) return;

      const symbolSet = new Set(symbols);
      const updates = {};

      rawData.forEach(item => {
        if (symbolSet.has(item.symbol)) {
          const price = parseFloat(item.lastPrice);
          const change = parseFloat(item.priceChangePercent);

          if (!isNaN(price) && price > 0) {
            priceMap[item.symbol] = price;
            change24hMap[item.symbol] = change;
            updates[item.symbol] = { price, change };

            if (onPriceTickCallback) {
              onPriceTickCallback(item.symbol, price);
            }
          }
        }
      });

      if (Object.keys(updates).length > 0) {
        if (broadcastFn) {
          broadcastFn('PRICE_UPDATE', updates);
        }
      }
    } catch (e) {
      console.error('[REST TICKER ERROR]', e.message);
    }
  };

  pollPrices(); // Immediate first fetch
  restPollingInterval = setInterval(pollPrices, 1500); // 1.5s loop
}

function connectPriceStream(symbols) {
  if (!symbols || symbols.length === 0) return;

  const streams = symbols.slice(0, 30) // Only subscribe to top 30 on WS stream URL to keep length short
    .map(s => s.toLowerCase() + '@ticker')
    .join('/');

  const url = 'wss://fstream.binance.com/stream?streams=' + streams;

  console.log('[PRICE WS] Connecting to ticker stream...');
  priceWS = new WebSocket(url);

  priceWS.on('open', () => {
    priceReconnectAttempts = 0;
    console.log('[PRICE WS] ✅ Connected');
    if (broadcastFn) broadcastFn('SYSTEM_STATUS', { binanceConnected: true });
  });

  priceWS.on('message', (raw) => {
    try {
      const msg = JSON.parse(raw);
      const data = msg.data || msg;

      if (!data || !data.s) return;

      const symbol = data.s;
      const price = parseFloat(data.c);
      const change = parseFloat(data.P);

      if (isNaN(price) || price <= 0) return;

      priceMap[symbol] = price;
      change24hMap[symbol] = change;

      if (onPriceTickCallback) {
        onPriceTickCallback(symbol, price);
      }

      schedulePriceBroadcast(symbol, price, change);
    } catch (e) {}
  });

  priceWS.on('close', (code) => {
    if (broadcastFn) broadcastFn('SYSTEM_STATUS', { binanceConnected: false });
    schedulePriceReconnect(symbols);
  });

  priceWS.on('error', (err) => {
    console.error('[PRICE WS] Error:', err.message);
  });
}

const pendingPriceUpdates = {};
let priceBroadcastTimer = null;

function schedulePriceBroadcast(symbol, price, change) {
  pendingPriceUpdates[symbol] = { price, change };

  if (!priceBroadcastTimer) {
    priceBroadcastTimer = setTimeout(() => {
      if (Object.keys(pendingPriceUpdates).length > 0) {
        if (broadcastFn) broadcastFn('PRICE_UPDATE', { ...pendingPriceUpdates });
        Object.keys(pendingPriceUpdates).forEach(k => {
          delete pendingPriceUpdates[k];
        });
      }
      priceBroadcastTimer = null;
    }, 500);
  }
}

function schedulePriceReconnect(symbols) {
  const delay = Math.min(1000 * Math.pow(2, priceReconnectAttempts), 8000);
  priceReconnectAttempts++;
  setTimeout(() => connectPriceStream(symbols), delay);
}

// ══════════════════════════════════════════
// KLINE (CANDLE) STREAM
// ══════════════════════════════════════════

function startKlineStream(symbols, timeframe, onCandleClose) {
  currentTimeframe = timeframe;
  if (onCandleClose) onCandleCloseCallback = onCandleClose;
  if (klineWS) {
    klineWS.terminate();
    klineWS = null;
  }
  connectKlineStream(symbols, timeframe);
}

function connectKlineStream(symbols, timeframe) {
  if (!symbols || symbols.length === 0) return;

  const streams = symbols.slice(0, 30)
    .map(s => s.toLowerCase() + '@kline_' + timeframe)
    .join('/');

  const url = 'wss://fstream.binance.com/stream?streams=' + streams;

  console.log('[KLINE WS] Connecting for timeframe:', timeframe);
  klineWS = new WebSocket(url);

  klineWS.on('open', () => {
    klineReconnectAttempts = 0;
    console.log('[KLINE WS] ✅ Connected — monitoring candle closes');
  });

  klineWS.on('message', (raw) => {
    try {
      const msg = JSON.parse(raw);
      const eventData = msg.data || msg;
      const kline = eventData.k;
      if (!kline) return;

      const symbol = eventData.s || kline.s;
      const isClosed = kline.x;

      if (isClosed === true) {
        console.log('[KLINE] Candle CLOSED — ' + symbol + ' at ' + new Date(kline.T).toISOString());

        if (onCandleCloseCallback) {
          onCandleCloseCallback(symbol, kline.T, {
            open: parseFloat(kline.o),
            high: parseFloat(kline.h),
            low: parseFloat(kline.l),
            close: parseFloat(kline.c),
            volume: parseFloat(kline.v),
            closeTime: kline.T
          });
        }
      }
    } catch (e) {}
  });

  klineWS.on('close', () => {
    scheduleKlineReconnect(symbols, timeframe);
  });

  klineWS.on('error', (err) => {
    console.error('[KLINE WS] Error:', err.message);
  });
}

function scheduleKlineReconnect(symbols, timeframe) {
  const delay = Math.min(1000 * Math.pow(2, klineReconnectAttempts), 8000);
  klineReconnectAttempts++;
  setTimeout(() => connectKlineStream(symbols, timeframe), delay);
}

function restartKlineStream(symbols, newTimeframe, onCandleClose) {
  console.log('[KLINE WS] Restarting for new timeframe:', newTimeframe);
  currentTimeframe = newTimeframe;
  if (onCandleClose) onCandleCloseCallback = onCandleClose;
  if (klineWS) klineWS.terminate();
  connectKlineStream(symbols, newTimeframe);
}

function getCurrentPrice(symbol) {
  return priceMap[symbol] || null;
}

function getAllPrices() {
  return { ...priceMap };
}

function getChange24h(symbol) {
  return change24hMap[symbol] || 0;
}

function isConnected() {
  return Object.keys(priceMap).length > 0;
}

function stopAllStreams() {
  if (priceWS) priceWS.terminate();
  if (klineWS) klineWS.terminate();
  if (restPollingInterval) clearInterval(restPollingInterval);
  priceWS = null;
  klineWS = null;
}

function setOnPriceTick(cb) {
  onPriceTickCallback = cb;
}

module.exports = {
  setBroadcast,
  startPriceStream,
  startKlineStream,
  restartKlineStream,
  stopAllStreams,
  getCurrentPrice,
  getAllPrices,
  getChange24h,
  isConnected,
  setOnPriceTick
};
