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
let lastKlineCheckTime = {};

// One-time REST fallback state (replaces the old 1.5s polling loop)
let hasReceivedPriceUpdate = false;
let priceSeedFallbackTimer = null;

// REST rate-limit state
let restBlockedUntil = 0; // timestamp (ms) until which ALL REST ticker calls are disabled
const REST_418_COOLDOWN_MS = 5 * 60 * 1000; // minimum 5 minutes after an HTTP 418 ban
const REST_FALLBACK_DELAY_MS = 10000; // how long to wait for WS before seeding via REST

function setBroadcast(fn) {
  broadcastFn = fn;
}

// ══════════════════════════════════════════
// PRICE TICKER STREAM (WebSocket is the sole
// live source; REST is a one-time seed only)
// ══════════════════════════════════════════

function startPriceStream(symbols, priceTickCb = null) {
  currentSymbols = symbols;
  if (priceTickCb) onPriceTickCallback = priceTickCb;

  hasReceivedPriceUpdate = false;

  if (priceWS) {
    priceWS.terminate();
    priceWS = null;
  }
  connectPriceStream(symbols);

  // If the WebSocket hasn't delivered a single price update within
  // REST_FALLBACK_DELAY_MS, do ONE REST fetch to seed initial prices, then stop.
  if (priceSeedFallbackTimer) clearTimeout(priceSeedFallbackTimer);
  priceSeedFallbackTimer = setTimeout(() => {
    priceSeedFallbackTimer = null;
    if (!hasReceivedPriceUpdate) {
      seedInitialPricesOnce(symbols);
    }
  }, REST_FALLBACK_DELAY_MS);
}

// Single REST GET with 429/418 handling. Returns the raw ticker array or null.
async function fetchTickerOnce(url) {
  try {
    const response = await axios.get(url, { timeout: 5000 });
    return Array.isArray(response.data) ? response.data : null;
  } catch (err) {
    const status = err.response ? err.response.status : null;

    if (status === 429) {
      const retryAfterHeader = err.response.headers ? err.response.headers['retry-after'] : null;
      const retryAfterMs = retryAfterHeader ? parseInt(retryAfterHeader, 10) * 1000 : 2000;
      console.warn(`[REST TICKER] 429 rate-limited on ${url}. Waiting ${retryAfterMs}ms (Retry-After) before retrying once.`);
      await new Promise(resolve => setTimeout(resolve, retryAfterMs));

      try {
        const retryResponse = await axios.get(url, { timeout: 5000 });
        return Array.isArray(retryResponse.data) ? retryResponse.data : null;
      } catch (retryErr) {
        console.error(`[REST TICKER] Retry after 429 failed for ${url}:`, retryErr.message);
        return null;
      }
    }

    if (status === 418) {
      restBlockedUntil = Date.now() + REST_418_COOLDOWN_MS;
      console.warn(
        `[REST TICKER] ⚠️ HTTP 418 (IP auto-ban) received from ${url}. ` +
        `Disabling ALL REST ticker calls for at least ${REST_418_COOLDOWN_MS / 60000} minutes.`
      );
      return null;
    }

    console.error(`[REST TICKER] Request failed for ${url}:`, err.message);
    return null;
  }
}

// Tries the futures endpoint, then the spot fallback, respecting any active 418 cooldown.
async function fetchTickerWithFallback() {
  if (Date.now() < restBlockedUntil) {
    const remainingMin = Math.ceil((restBlockedUntil - Date.now()) / 60000);
    console.warn(`[REST TICKER] Skipping REST call — still in 418 cooldown (~${remainingMin} min remaining).`);
    return null;
  }

  let rawData = await fetchTickerOnce('https://fapi.binance.com/fapi/v1/ticker/24hr');

  if (!rawData && Date.now() < restBlockedUntil) {
    // Just got 418'd on the futures endpoint — don't hit the spot endpoint too.
    return null;
  }

  if (!rawData) {
    rawData = await fetchTickerOnce('https://api.binance.com/api/v3/ticker/24hr');
  }

  return rawData;
}

// ONE-TIME REST fallback — only runs if the WebSocket produced nothing within
// REST_FALLBACK_DELAY_MS of connecting. Does not loop or reschedule itself.
async function seedInitialPricesOnce(symbols) {
  console.log('[REST TICKER] No WS price update within 10s — doing a single REST fetch to seed initial prices.');

  const rawData = await fetchTickerWithFallback();
  if (!rawData) {
    console.warn('[REST TICKER] One-time REST seed did not return data.');
    return;
  }

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

  if (Object.keys(updates).length > 0 && broadcastFn) {
    broadcastFn('PRICE_UPDATE', updates);
  }

  console.log(`[REST TICKER] One-time REST seed complete — seeded ${Object.keys(updates).length} symbol(s). REST polling stays off; WS is now the sole price source.`);
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
      hasReceivedPriceUpdate = true;

      if (onPriceTickCallback) {
        onPriceTickCallback(symbol, price);
      }

      schedulePriceBroadcast(symbol, price, change);
    } catch (e) {
      console.error('[PRICE WS] Message parse error:', e.message);
    }
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
    } catch (e) {
      console.error('[KLINE WS] Message parse error:', e.message);
    }
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
  if (priceSeedFallbackTimer) clearTimeout(priceSeedFallbackTimer);
  priceWS = null;
  klineWS = null;
  priceSeedFallbackTimer = null;
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
