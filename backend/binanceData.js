const axios = require('axios');
const { sleep } = require('./utils');

const BASE_URL = 'https://fapi.binance.com';

let topCoinsCache = null;
let topCoinsCacheTime = 0;
const CACHE_6_HOURS = 6 * 60 * 60 * 1000;

let requestCount = 0;
let lastResetTime = Date.now();

function checkRateLimit() {
  const now = Date.now();
  if (now - lastResetTime >= 60000) {
    requestCount = 0;
    lastResetTime = now;
  }
  requestCount++;
  if (requestCount > 1000) {
    return true;
  }
  return false;
}

async function fetchWithRateLimit(url, options = {}) {
  if (checkRateLimit()) {
    await sleep(200);
  }
  const response = await axios.get(url, { timeout: 10000, ...options });
  return response.data;
}

// Major crypto perpetuals that guarantee active 24/7 high-frequency price ticks
const MAJOR_CRYPTO_PAIRS = [
  'BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'BNBUSDT', 'XRPUSDT',
  'DOGEUSDT', 'ADAUSDT', 'AVAXUSDT', 'DOTUSDT', 'LINKUSDT',
  'NEARUSDT', 'SUIUSDT', 'UNIUSDT', 'LTCUSDT', 'PEPEUSDT',
  'SHIBUSDT', 'WIFUSDT', 'APTUSDT', 'FILUSDT', 'ARBUSDT',
  'OPUSDT', 'INJUSDT', 'FETUSDT', 'RNDRUSDT', 'TIAUSDT',
  'SEIUSDT', 'BONKUSDT', 'FLOKIUSDT', 'MEMEUSDT', 'ETCUSDT',
  'XLMUSDT', 'ATOMUSDT', 'TRXUSDT', 'BCHUSDT', 'ICPUSDT',
  'STXUSDT', 'AAVEUSDT', 'GRTUSDT', 'GALAUSDT', 'DYDXUSDT',
  'ALGOUSDT', 'FTMUSDT', 'SANDUSDT', 'MANAUSDT', 'AXSUSDT',
  'EOSUSDT', 'THETAUSDT', 'EGLDUSDT', 'NEOUSDT', 'KAVAUSDT'
];

async function getTopCoins(limit = 50) {
  const now = Date.now();
  if (topCoinsCache && (now - topCoinsCacheTime < CACHE_6_HOURS)) {
    return topCoinsCache.slice(0, limit);
  }

  try {
    const exchangeInfo = await fetchWithRateLimit(`${BASE_URL}/fapi/v1/exchangeInfo`);
    const validPerps = new Set(
      (exchangeInfo.symbols || [])
        .filter(s => s.status === 'TRADING' && s.quoteAsset === 'USDT' && s.contractType === 'PERPETUAL')
        .map(s => s.symbol)
    );

    const tickerData = await fetchWithRateLimit(`${BASE_URL}/fapi/v1/ticker/24hr`);
    const sorted = tickerData
      .filter(item => validPerps.has(item.symbol) && !item.symbol.includes('_'))
      .sort((a, b) => parseFloat(b.quoteVolume) - parseFloat(a.quoteVolume))
      .map(item => item.symbol);

    // Ensure top 50 strictly contains active crypto perpetuals
    const filteredCrypto = sorted.filter(sym => !['XAUUSDT', 'XAGUSDT', 'CLUSDT', 'SOXLUSDT', 'SNDKUSDT', 'SKHYNIXUSDT', 'MUUSDT', 'BANKUSDT', 'KORUUSDT', 'SKHYUSDT'].includes(sym));

    topCoinsCache = filteredCrypto.length >= limit ? filteredCrypto : MAJOR_CRYPTO_PAIRS;
    topCoinsCacheTime = now;
    console.log(`[BINANCE] Loaded top ${topCoinsCache.length} active crypto perpetual contracts`);
    return topCoinsCache.slice(0, limit);
  } catch (error) {
    console.error('[BINANCE] Error fetching top coins, using fallback list:', error.message);
    topCoinsCache = MAJOR_CRYPTO_PAIRS;
    topCoinsCacheTime = now;
    return MAJOR_CRYPTO_PAIRS.slice(0, limit);
  }
}

async function getCandles(symbol, interval, limit = 300) {
  // Tier 1: Binance Futures API
  try {
    const url = `${BASE_URL}/fapi/v1/klines?symbol=${symbol}&interval=${interval}&limit=${limit}`;
    const raw = await fetchWithRateLimit(url);
    if (Array.isArray(raw) && raw.length > 0) {
      const parsed = raw.map(c => ({
        openTime:  c[0],
        open:      parseFloat(c[1]),
        high:      parseFloat(c[2]),
        low:       parseFloat(c[3]),
        close:     parseFloat(c[4]),
        volume:    parseFloat(c[5]),
        closeTime: c[6]
      }));
      return parsed.slice(0, -1);
    }
  } catch (err) {
    console.warn(`[CANDLES] Binance Futures fetch failed for ${symbol}: ${err.message}. Trying Binance Spot API fallback...`);
  }

  // Tier 2: Binance Spot API Fallback
  try {
    const url = `https://api.binance.com/api/v3/klines?symbol=${symbol}&interval=${interval}&limit=${limit}`;
    const raw = await fetchWithRateLimit(url);
    if (Array.isArray(raw) && raw.length > 0) {
      const parsed = raw.map(c => ({
        openTime:  c[0],
        open:      parseFloat(c[1]),
        high:      parseFloat(c[2]),
        low:       parseFloat(c[3]),
        close:     parseFloat(c[4]),
        volume:    parseFloat(c[5]),
        closeTime: c[6]
      }));
      return parsed.slice(0, -1);
    }
  } catch (err) {
    console.warn(`[CANDLES] Binance Spot fetch failed for ${symbol}: ${err.message}. Trying Coinbase Public API fallback...`);
  }

  // Tier 3: Coinbase Exchange Public API Fallback
  try {
    const coin = symbol.replace('USDT', '');
    const cbSymbol = `${coin}-USD`;
    const intervalSecMap = {
      '1m': 60, '5m': 300, '15m': 900, '1h': 3600, '4h': 21600, '6h': 21600, '1d': 86400
    };
    const granularity = intervalSecMap[interval] || 3600;
    const cbUrl = `https://api.exchange.coinbase.com/products/${cbSymbol}/candles?granularity=${granularity}`;
    const response = await axios.get(cbUrl, { timeout: 8000, headers: { 'User-Agent': 'AlgoBot/1.0' } });

    if (Array.isArray(response.data) && response.data.length > 0) {
      // Coinbase format: [time, low, high, open, close, volume]
      const parsed = response.data.map(c => ({
        openTime:  c[0] * 1000,
        open:      parseFloat(c[3]),
        high:      parseFloat(c[2]),
        low:       parseFloat(c[1]),
        close:     parseFloat(c[4]),
        volume:    parseFloat(c[5]),
        closeTime: (c[0] + granularity) * 1000 - 1
      })).sort((a, b) => a.openTime - b.openTime);
      return parsed.slice(0, -1);
    }
  } catch (err) {
    console.error(`[CANDLES] Coinbase fallback failed for ${symbol}: ${err.message}`);
  }

  return [];
}

async function getFundingRates(symbols = []) {
  try {
    const data = await fetchWithRateLimit(`${BASE_URL}/fapi/v1/premiumIndex`);
    const rateMap = {};
    if (Array.isArray(data)) {
      data.forEach(item => {
        if (symbols.length === 0 || symbols.includes(item.symbol)) {
          rateMap[item.symbol] = parseFloat(item.lastFundingRate) * 100;
        }
      });
    }
    return rateMap;
  } catch (error) {
    console.error('[BINANCE] Error fetching funding rates:', error.message);
    return {};
  }
}

async function getMaxHistoricalCandles(symbol, interval) {
  const allCandles = [];
  let endTime = Date.now();
  const maxBatches = 5;

  for (let b = 0; b < maxBatches; b++) {
    try {
      const url = `${BASE_URL}/fapi/v1/klines?symbol=${symbol}&interval=${interval}&limit=1000&endTime=${endTime}`;
      const batch = await fetchWithRateLimit(url);

      if (!Array.isArray(batch) || batch.length === 0) break;

      const parsedBatch = batch.map(candle => ({
        openTime: candle[0],
        open: parseFloat(candle[1]),
        high: parseFloat(candle[2]),
        low: parseFloat(candle[3]),
        close: parseFloat(candle[4]),
        volume: parseFloat(candle[5]),
        closeTime: candle[6]
      }));

      allCandles.unshift(...parsedBatch);
      endTime = parsedBatch[0].openTime - 1;
      await sleep(200);
    } catch (e) {
      console.error(`[BINANCE] Backtest fetch batch failed for ${symbol}:`, e.message);
      break;
    }
  }

  const uniqueMap = new Map();
  allCandles.forEach(c => uniqueMap.set(c.openTime, c));
  return Array.from(uniqueMap.values()).sort((a, b) => a.openTime - b.openTime);
}

function getRateLimitStatus() {
  return {
    count: requestCount,
    max: 1200,
    resetInSeconds: Math.max(0, Math.floor((60000 - (Date.now() - lastResetTime)) / 1000))
  };
}

module.exports = {
  getTopCoins,
  getCandles,
  getFundingRates,
  getMaxHistoricalCandles,
  getRateLimitStatus
};
