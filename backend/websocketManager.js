const WebSocket = require('ws');
const axios = require('axios');

console.log('[PRICE WS] === MODULE LOADED === File:', __filename);

// In-memory price map — always current
const priceMap = {};
const change24hMap = {};
const lastTickAtMap = {}; // per-symbol freshness tracking
let priceWS = null;
let klineWS = null;
let priceWSConnections = []; // array of WS connections for batched streams
let klineWSConnections = []; // array of WS connections for batched streams
let priceReconnectAttempts = 0;
let klineReconnectAttempts = 0;
let priceReconnectTimeout = null;
let klineReconnectTimeout = null;
let currentSymbols = [];
let currentTimeframe = '4h';
let onCandleCloseCallback = null;
let onPriceTickCallback = null;
let broadcastFn = null;
let lastKlineCheckTime = {};

// One-time REST fallback state (replaces the old 1.5s polling loop)
let hasReceivedPriceUpdate = false;
let priceSeedFallbackTimer = null;

// Multi-exchange feed state
let userSelectedProvider = 'auto'; // 'auto' | 'binance' | 'bybit' | 'coinbase'
let activeProvider = 'bybit';     // resolved active provider
const PROVIDER_ORDER = ['bybit', 'binance', 'coinbase'];

// Section 1: tick watchdog — reconnect if socket is OPEN but silent for >15s
let lastTickReceivedAt = 0;
let tickWatchdogTimer   = null;

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
  console.log('[PRICE WS] *** FUNCTION ENTRY ***');
  console.log(`[PRICE WS] === START PRICE STREAM === symbols: ${symbols?.length || 0}`);
  currentSymbols = symbols;
  if (priceTickCb) onPriceTickCallback = priceTickCb;

  hasReceivedPriceUpdate = false;

  // Terminate all existing price WS connections
  priceWSConnections.forEach(ws => {
    if (ws) { ws.removeAllListeners(); ws.terminate(); }
  });
  priceWSConnections = [];
  priceWS = null;
  if (priceReconnectTimeout) { clearTimeout(priceReconnectTimeout); priceReconnectTimeout = null; }

  connectPriceStreamBatches(symbols);

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

// Split symbols into batches and connect multiple WS connections based on activeProvider
function connectPriceStreamBatches(symbols) {
  if (!symbols || symbols.length === 0) {
    console.log('[PRICE WS] No symbols to connect');
    return;
  }

  // Clean up ALL existing price connections to prevent accumulation
  priceWSConnections.forEach(ws => {
    if (ws) { ws.removeAllListeners(); ws.terminate(); }
  });
  priceWSConnections = [];
  priceWS = null;
  if (priceReconnectTimeout) { clearTimeout(priceReconnectTimeout); priceReconnectTimeout = null; }

  const provider = activeProvider;
  console.log(`[PRICE WS] Connecting public WS stream using provider: [${provider.toUpperCase()}] for ${symbols.length} symbols...`);

  if (provider === 'bybit') {
    connectBybitPublicWS(symbols);
  } else if (provider === 'coinbase') {
    connectCoinbasePublicWS(symbols);
  } else {
    connectBinancePublicWS(symbols);
  }
}

function recordPriceTick(symbol, price, change) {
  if (isNaN(price) || price <= 0) return;
  priceMap[symbol] = price;
  if (!isNaN(change)) change24hMap[symbol] = change;
  lastTickAtMap[symbol] = Date.now();

  hasReceivedPriceUpdate = true;
  lastTickReceivedAt = Date.now();

  if (onPriceTickCallback) {
    onPriceTickCallback(symbol, price);
  }
  schedulePriceBroadcast(symbol, price, change24hMap[symbol] || 0);
}

function connectBybitPublicWS(symbols) {
  try {
    const ws = new WebSocket('wss://stream.bybit.com/v5/public/linear');
    priceWSConnections.push(ws);
    priceWS = ws;

    ws.on('open', () => {
      priceReconnectAttempts = 0;
      console.log(`[PRICE WS] ✅ Bybit Public WS connected for ${symbols.length} symbols`);
      if (broadcastFn) broadcastFn('SYSTEM_STATUS', { binanceConnected: true, provider: 'bybit' });

      // Subscribe in chunks of 20
      const BATCH_SIZE = 20;
      for (let i = 0; i < symbols.length; i += BATCH_SIZE) {
        const chunk = symbols.slice(i, i + BATCH_SIZE);
        const args = chunk.map(s => `tickers.${s.toUpperCase()}`);
        ws.send(JSON.stringify({ op: 'subscribe', args }));
      }
      startTickWatchdog(symbols);
    });

    ws.on('message', (raw) => {
      try {
        const msg = JSON.parse(raw);
        if (msg.topic && msg.topic.startsWith('tickers.') && msg.data) {
          const d = msg.data;
          const symbol = d.symbol;
          const price = parseFloat(d.lastPrice || d.bid1Price || d.ask1Price);
          const change = d.price24hPcnt ? parseFloat(d.price24hPcnt) * 100 : undefined;
          if (symbol && !isNaN(price)) {
            recordPriceTick(symbol, price, change);
          }
        }
      } catch (e) {}
    });

    ws.on('close', (code) => {
      console.log(`[PRICE WS] Bybit WS closed (code: ${code})`);
      if (broadcastFn) broadcastFn('SYSTEM_STATUS', { binanceConnected: false });
      stopTickWatchdog();
      schedulePriceReconnect(symbols);
    });

    ws.on('error', (err) => {
      console.error('[PRICE WS] Bybit WS error:', err.message);
    });
  } catch (err) {
    console.error('[PRICE WS] Bybit connection failed:', err.message);
  }
}

function connectCoinbasePublicWS(symbols) {
  try {
    const ws = new WebSocket('wss://ws-feed.exchange.coinbase.com');
    priceWSConnections.push(ws);
    priceWS = ws;

    const productIds = symbols.map(s => s.replace(/USDT$/, '-USD'));

    ws.on('open', () => {
      priceReconnectAttempts = 0;
      console.log(`[PRICE WS] ✅ Coinbase Public WS connected for ${symbols.length} symbols`);
      if (broadcastFn) broadcastFn('SYSTEM_STATUS', { binanceConnected: true, provider: 'coinbase' });

      ws.send(JSON.stringify({
        type: 'subscribe',
        product_ids: productIds,
        channels: ['ticker']
      }));
      startTickWatchdog(symbols);
    });

    ws.on('message', (raw) => {
      try {
        const msg = JSON.parse(raw);
        if (msg.type === 'ticker' && msg.product_id && msg.price) {
          const symbol = msg.product_id.replace(/-USD$/, 'USDT');
          const price = parseFloat(msg.price);
          const open24h = parseFloat(msg.open_24h);
          const change = open24h > 0 ? ((price - open24h) / open24h) * 100 : undefined;
          if (symbol && !isNaN(price)) {
            recordPriceTick(symbol, price, change);
          }
        }
      } catch (e) {}
    });

    ws.on('close', (code) => {
      console.log(`[PRICE WS] Coinbase WS closed (code: ${code})`);
      if (broadcastFn) broadcastFn('SYSTEM_STATUS', { binanceConnected: false });
      stopTickWatchdog();
      schedulePriceReconnect(symbols);
    });

    ws.on('error', (err) => {
      console.error('[PRICE WS] Coinbase WS error:', err.message);
    });
  } catch (err) {
    console.error('[PRICE WS] Coinbase connection failed:', err.message);
  }
}

function connectBinancePublicWS(symbols) {
  const BATCH_SIZE = 40;
  const batches = [];
  for (let i = 0; i < symbols.length; i += BATCH_SIZE) {
    batches.push(symbols.slice(i, i + BATCH_SIZE));
  }

  console.log(`[PRICE WS] Connecting ${batches.length} Binance batch(es) for ${symbols.length} symbols...`);

  try {
    batches.forEach((batch, batchIndex) => {
      const streams = batch
        .map(s => s.toLowerCase() + '@bookTicker')
        .join('/');

      const url = 'wss://fstream.binance.com/stream?streams=' + streams;
      const ws = new WebSocket(url);

      priceWSConnections.push(ws);
      if (batchIndex === 0) priceWS = ws;

      ws.on('open', () => {
        priceReconnectAttempts = 0;
        console.log(`[PRICE WS] ✅ Binance Batch ${batchIndex + 1}/${batches.length} connected (${batch.length} symbols)`);
        if (broadcastFn && batchIndex === 0) broadcastFn('SYSTEM_STATUS', { binanceConnected: true, provider: 'binance' });
        if (batchIndex === 0) startTickWatchdog(symbols);
      });

      ws.on('message', (raw) => {
        try {
          const msg = JSON.parse(raw);
          const data = msg.data || msg;
          if (!data || !data.s) return;

          const symbol = data.s;
          const price = parseFloat(data.b || data.c || data.a);
          const change = parseFloat(data.P || 0);

          if (symbol && !isNaN(price)) {
            recordPriceTick(symbol, price, change);
          }
        } catch (e) {}
      });

      ws.on('close', (code) => {
        console.log(`[PRICE WS] Binance Batch ${batchIndex + 1} closed (code: ${code})`);
        if (broadcastFn && batchIndex === 0) broadcastFn('SYSTEM_STATUS', { binanceConnected: false });
        if (batchIndex === 0) stopTickWatchdog();
        schedulePriceReconnect(symbols);
      });

      ws.on('error', (err) => {
        console.error('[PRICE WS] Binance Batch ${batchIndex + 1} ERROR:', err.message);
      });
    });
  } catch (err) {
    console.error('[PRICE WS] Binance batch connection error:', err.message);
  }
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
  if (priceReconnectTimeout) return; // debounce: reconnect already scheduled
  const delay = Math.min(1000 * Math.pow(2, priceReconnectAttempts), 8000);
  priceReconnectAttempts++;
  priceReconnectTimeout = setTimeout(() => {
    priceReconnectTimeout = null;
    connectPriceStreamBatches(symbols);
  }, delay);
}

// ══════════════════════════════════════════
// KLINE (CANDLE) STREAM
// ══════════════════════════════════════════

function startKlineStream(symbols, timeframe, onCandleClose) {
  currentTimeframe = timeframe;
  if (onCandleClose) onCandleCloseCallback = onCandleClose;

  // Terminate all existing kline WS connections
  klineWSConnections.forEach(ws => {
    if (ws) { ws.removeAllListeners(); ws.terminate(); }
  });
  klineWSConnections = [];
  klineWS = null;
  if (klineReconnectTimeout) { clearTimeout(klineReconnectTimeout); klineReconnectTimeout = null; }

  connectKlineStreamBatches(symbols, timeframe);
}

// Split symbols into batches and connect multiple kline WS connections
function connectKlineStreamBatches(symbols, timeframe) {
  if (!symbols || symbols.length === 0) return;

  // Clean up ALL existing kline connections to prevent accumulation
  klineWSConnections.forEach(ws => {
    if (ws) { ws.removeAllListeners(); ws.terminate(); }
  });
  klineWSConnections = [];
  klineWS = null;
  if (klineReconnectTimeout) { clearTimeout(klineReconnectTimeout); klineReconnectTimeout = null; }

  const BATCH_SIZE = 40;
  const batches = [];
  for (let i = 0; i < symbols.length; i += BATCH_SIZE) {
    batches.push(symbols.slice(i, i + BATCH_SIZE));
  }

  console.log(`[KLINE WS] Connecting ${batches.length} batch(es) for ${symbols.length} symbols @ ${timeframe}...`);

  batches.forEach((batch, batchIndex) => {
    const streams = batch
      .map(s => s.toLowerCase() + '@kline_' + timeframe)
      .join('/');

    const url = 'wss://fstream.binance.com/stream?streams=' + streams;
    const ws = new WebSocket(url);

    klineWSConnections.push(ws);
    if (batchIndex === 0) klineWS = ws; // Keep first connection for backward compatibility

    ws.on('open', () => {
      klineReconnectAttempts = 0;
      console.log(`[KLINE WS] ✅ Batch ${batchIndex + 1}/${batches.length} connected (${batch.length} symbols)`);
    });

    ws.on('message', (raw) => {
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

    ws.on('close', (code) => {
      console.log(`[KLINE WS] Batch ${batchIndex + 1} closed (code: ${code})`);
      scheduleKlineReconnect(symbols, timeframe);
    });

    ws.on('error', (err) => {
      console.error(`[KLINE WS] Batch ${batchIndex + 1} error:`, err.message);
    });
  });
}

function scheduleKlineReconnect(symbols, timeframe) {
  if (klineReconnectTimeout) return; // debounce: reconnect already scheduled
  const delay = Math.min(1000 * Math.pow(2, klineReconnectAttempts), 8000);
  klineReconnectAttempts++;
  klineReconnectTimeout = setTimeout(() => {
    klineReconnectTimeout = null;
    connectKlineStreamBatches(symbols, timeframe);
  }, delay);
}

function restartKlineStream(symbols, newTimeframe, onCandleClose) {
  console.log('[KLINE WS] Restarting for new timeframe:', newTimeframe);
  currentTimeframe = newTimeframe;
  if (onCandleClose) onCandleCloseCallback = onCandleClose;

  // Terminate all existing kline WS connections
  klineWSConnections.forEach(ws => {
    if (ws) { ws.removeAllListeners(); ws.terminate(); }
  });
  klineWSConnections = [];
  klineWS = null;
  if (klineReconnectTimeout) { clearTimeout(klineReconnectTimeout); klineReconnectTimeout = null; }

  connectKlineStreamBatches(symbols, newTimeframe);
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

function setPriceFeedProvider(provider) {
  if (!['auto', 'binance', 'bybit', 'coinbase'].includes(provider)) return;
  userSelectedProvider = provider;
  if (provider === 'auto') {
    activeProvider = 'bybit';
  } else {
    activeProvider = provider;
  }
  console.log(`[PRICE WS] Price feed provider set to: user=${userSelectedProvider}, active=${activeProvider}`);
  if (broadcastFn) {
    broadcastFn('PRICE_FEED_CHANGED', { selected: userSelectedProvider, active: activeProvider });
  }
  if (currentSymbols.length > 0) {
    connectPriceStreamBatches(currentSymbols);
  }
}

function getPriceFeedProvider() {
  return { selected: userSelectedProvider, active: activeProvider };
}

// ── Section 1: Tick silence watchdog ─────────────────────────────
// If active feed is silent for >15s, auto-failover (in 'auto' mode) or force reconnect.
function startTickWatchdog(symbols) {
  stopTickWatchdog();
  tickWatchdogTimer = setInterval(() => {
    const hasOpenConnection = priceWSConnections.some(ws => ws && ws.readyState === WebSocket.OPEN);
    if (!hasOpenConnection) return;

    if (lastTickReceivedAt === 0) return;
    const silenceMs = Date.now() - lastTickReceivedAt;

    if (silenceMs > 15000) {
      if (userSelectedProvider === 'auto') {
        const currentIdx = PROVIDER_ORDER.indexOf(activeProvider);
        const nextIdx = (currentIdx + 1) % PROVIDER_ORDER.length;
        const oldProv = activeProvider;
        activeProvider = PROVIDER_ORDER[nextIdx];
        console.warn(`[PRICE WS] ⚠️ Auto-failover triggered after ${Math.round(silenceMs / 1000)}s silence: switching [${oldProv.toUpperCase()}] -> [${activeProvider.toUpperCase()}]`);
        if (broadcastFn) {
          broadcastFn('PRICE_FEED_CHANGED', { selected: 'auto', active: activeProvider, failover: true });
        }
      } else {
        console.warn(`[PRICE WS] ⚠️ No tick for ${Math.round(silenceMs / 1000)}s on [${activeProvider.toUpperCase()}] — forcing reconnect`);
      }

      if (broadcastFn) broadcastFn('SYSTEM_STATUS', { binanceConnected: false, staleReason: 'silence_watchdog' });
      stopTickWatchdog();

      priceWSConnections.forEach(ws => {
        if (ws) { ws.removeAllListeners(); ws.terminate(); }
      });
      priceWSConnections = [];
      priceWS = null;

      connectPriceStreamBatches(symbols);
    }
  }, 15000);
}

function stopTickWatchdog() {
  if (tickWatchdogTimer) {
    clearInterval(tickWatchdogTimer);
    tickWatchdogTimer = null;
  }
}

function getLastTickAge() {
  if (lastTickReceivedAt === 0) return null; // never received
  return Date.now() - lastTickReceivedAt;
}

// Per-symbol freshness tracking
function getSymbolTickAge(symbol) {
  const lastTick = lastTickAtMap[symbol];
  if (!lastTick) return null; // never received for this symbol
  return Date.now() - lastTick;
}

function isSymbolFresh(symbol, thresholdMs = 15000) {
  const age = getSymbolTickAge(symbol);
  if (age === null) return false; // no data yet
  return age <= thresholdMs;
}

function getFreshnessStatus() {
  const status = {
    global: {
      lastTickAt: lastTickReceivedAt,
      ageMs: getLastTickAge(),
      isFresh: getLastTickAge() !== null && getLastTickAge() <= 15000
    },
    symbols: {}
  };

  // Add per-symbol freshness for currently tracked symbols
  Object.keys(lastTickAtMap).forEach(symbol => {
    const age = getSymbolTickAge(symbol);
    status.symbols[symbol] = {
      lastTickAt: lastTickAtMap[symbol],
      ageMs: age,
      isFresh: age !== null && age <= 15000
    };
  });

  return status;
}

function stopAllStreams() {
  priceWSConnections.forEach(ws => {
    if (ws) { ws.removeAllListeners(); ws.terminate(); }
  });
  klineWSConnections.forEach(ws => {
    if (ws) { ws.removeAllListeners(); ws.terminate(); }
  });
  if (priceSeedFallbackTimer) clearTimeout(priceSeedFallbackTimer);
  if (priceReconnectTimeout) clearTimeout(priceReconnectTimeout);
  if (klineReconnectTimeout) clearTimeout(klineReconnectTimeout);
  stopTickWatchdog();
  priceWSConnections = [];
  klineWSConnections = [];
  priceWS = null;
  klineWS = null;
  priceSeedFallbackTimer = null;
  priceReconnectTimeout = null;
  klineReconnectTimeout = null;
}

function setOnPriceTick(cb) {
  onPriceTickCallback = cb;
}

console.log('[PRICE WS] === EXPORTING MODULE === startPriceStream:', typeof startPriceStream);

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
  setOnPriceTick,
  getLastTickAge,
  getSymbolTickAge,
  isSymbolFresh,
  getFreshnessStatus,
  setPriceFeedProvider,
  getPriceFeedProvider,
};
