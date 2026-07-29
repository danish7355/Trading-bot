const axios = require('axios');
const { sleep } = require('./utils');

const BYBIT_BASE  = 'https://api.bybit.com';
const BN_FUTURES  = 'https://fapi.binance.com';
const BN_SPOT     = 'https://api.binance.com';

let topCoinsCache    = null;
let topCoinsCacheTime = 0;
const CACHE_6_HOURS  = 6 * 60 * 60 * 1000;

let requestCount  = 0;
let lastResetTime = Date.now();

function checkRateLimit() {
  const now = Date.now();
  if (now - lastResetTime >= 60000) { requestCount = 0; lastResetTime = now; }
  requestCount++;
  return requestCount > 1000;
}

async function fetchWithRateLimit(url, options = {}) {
  if (checkRateLimit()) await sleep(150);
  const response = await axios.get(url, {
    timeout: 8000,
    headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' },
    ...options
  });
  return response.data;
}

// Bybit interval mapping
const BYBIT_INTERVAL_MAP = {
  '1m':'1','3m':'3','5m':'5','15m':'15','30m':'30',
  '1h':'60','2h':'120','4h':'240','6h':'360','12h':'720','1d':'D','1w':'W'
};

// Binance futures symbol mapper for meme coins
const FUTURES_MEME_MAP = {
  'PEPEUSDT':'1000PEPEUSDT','SHIBUSDT':'1000SHIBUSDT','BONKUSDT':'1000BONKUSDT',
  'FLOKIUSDT':'1000FLOKIUSDT','LUNCUSDT':'1000LUNCUSDT','XECUSDT':'1000XECUSDT',
  'SATSUSDT':'1000SATSUSDT','RATSUSDT':'1000RATSUSDT','CATUSDT':'1000CATUSDT'
};
function getFuturesSymbol(symbol) { return FUTURES_MEME_MAP[symbol] || symbol; }

const MAJOR_CRYPTO_PAIRS = [
  'BTCUSDT','ETHUSDT','SOLUSDT','BNBUSDT','XRPUSDT','DOGEUSDT','ADAUSDT','AVAXUSDT',
  'DOTUSDT','LINKUSDT','NEARUSDT','SUIUSDT','UNIUSDT','LTCUSDT','PEPEUSDT','SHIBUSDT',
  'WIFUSDT','APTUSDT','FILUSDT','ARBUSDT','OPUSDT','INJUSDT','FETUSDT','RNDRUSDT',
  'TIAUSDT','SEIUSDT','BONKUSDT','FLOKIUSDT','MEMEUSDT','ETCUSDT','XLMUSDT','ATOMUSDT',
  'TRXUSDT','BCHUSDT','ICPUSDT','STXUSDT','AAVEUSDT','GRTUSDT','GALAUSDT','DYDXUSDT',
  'ALGOUSDT','FTMUSDT','SANDUSDT','MANAUSDT','AXSUSDT','EOSUSDT','THETAUSDT','EGLDUSDT',
  'NEOUSDT','KAVAUSDT','ROSEUSDT','SNXUSDT','RUNEUSDT','LDOUSDT','CRVUSDT','MKRUSDT',
  'COMPUSDT','1INCHUSDT','FLOWUSDT','CHZUSDT','DASHUSDT','ZECUSDT','YFIUSDT','ANKRUSDT',
  'SKLUSDT','PENDLEUSDT','RENDERUSDT','JUPUSDT','PYTHUSDT','ENAUSDT','ORDIUSDT','TRBUSDT'
];

async function getTopCoins(limit = 50) {
  const targetLimit = parseInt(limit) || 50;
  const now = Date.now();
  if (topCoinsCache && topCoinsCache.length >= targetLimit && (now - topCoinsCacheTime < CACHE_6_HOURS)) {
    return topCoinsCache.slice(0, targetLimit);
  }
  try {
    const exchangeInfo = await fetchWithRateLimit(`${BN_FUTURES}/fapi/v1/exchangeInfo`);
    const validPerps = new Set(
      (exchangeInfo.symbols || [])
        .filter(s => s.status === 'TRADING' && s.quoteAsset === 'USDT' && s.contractType === 'PERPETUAL')
        .map(s => s.symbol)
    );
    const tickerData = await fetchWithRateLimit(`${BN_FUTURES}/fapi/v1/ticker/24hr`);
    const sorted = tickerData
      .filter(item => validPerps.has(item.symbol) && !item.symbol.includes('_'))
      .sort((a, b) => parseFloat(b.quoteVolume) - parseFloat(a.quoteVolume))
      .map(item => item.symbol);
    const filteredCrypto = sorted.filter(sym =>
      !['XAUUSDT','XAGUSDT','CLUSDT','SOXLUSDT','BANKUSDT','KORUUSDT'].includes(sym)
    );
    const normalized = filteredCrypto.map(s => s.replace(/^1000/, ''));
    const uniqueCoins = Array.from(new Set(normalized));
    topCoinsCache = uniqueCoins.length >= targetLimit ? uniqueCoins : MAJOR_CRYPTO_PAIRS;
    topCoinsCacheTime = now;
    console.log(`[MARKET_DATA] Loaded top ${targetLimit} active crypto perpetual contracts`);
    return topCoinsCache.slice(0, targetLimit);
  } catch (error) {
    topCoinsCache = MAJOR_CRYPTO_PAIRS;
    topCoinsCacheTime = now;
    return MAJOR_CRYPTO_PAIRS.slice(0, targetLimit);
  }
}

async function getCandles(symbol, interval, limit = 300) {
  const bybitInterval = BYBIT_INTERVAL_MAP[interval] || '240';
  const futuresSymbol = getFuturesSymbol(symbol);

  // ── Tier 1: Bybit Linear Futures (primary) ───────────────────────
  try {
    const url = `${BYBIT_BASE}/v5/market/kline?category=linear&symbol=${symbol}&interval=${bybitInterval}&limit=${limit}`;
    const raw = await fetchWithRateLimit(url);
    if (raw && raw.retCode === 0 && Array.isArray(raw.result?.list) && raw.result.list.length > 0) {
      // Bybit returns newest-first: [startTime, open, high, low, close, volume, turnover]
      const parsed = raw.result.list
        .map(c => ({
          openTime:  parseInt(c[0]),
          open:      parseFloat(c[1]),
          high:      parseFloat(c[2]),
          low:       parseFloat(c[3]),
          close:     parseFloat(c[4]),
          volume:    parseFloat(c[5]),
          closeTime: parseInt(c[0]) + (getIntervalMs(interval)) - 1
        }))
        .reverse(); // convert to ascending order
      const result = parsed.slice(0, -1); // drop last (incomplete) candle
      if (result.length > 10) {
        console.log(`[MARKET_DATA] ${symbol}/${interval}: served by Bybit (${result.length} candles)`);
        return result;
      }
    }
  } catch (err) {
    console.warn(`[MARKET_DATA] Bybit failed for ${symbol}/${interval}: ${err.message} — trying Binance`);
  }

  // ── Tier 2: Binance Futures API ──────────────────────────────────
  try {
    const url = `${BN_FUTURES}/fapi/v1/klines?symbol=${futuresSymbol}&interval=${interval}&limit=${limit}`;
    const raw = await fetchWithRateLimit(url);
    if (Array.isArray(raw) && raw.length > 0) {
      const parsed = raw.map(c => ({
        openTime:  c[0], open: parseFloat(c[1]), high: parseFloat(c[2]),
        low: parseFloat(c[3]), close: parseFloat(c[4]), volume: parseFloat(c[5]), closeTime: c[6]
      }));
      const result = parsed.slice(0, -1);
      console.log(`[MARKET_DATA] ${symbol}/${interval}: served by Binance Futures (fallback, ${result.length} candles)`);
      return result;
    }
  } catch (err) {
    console.warn(`[MARKET_DATA] Binance Futures failed for ${symbol}: ${err.message} — trying Binance Spot`);
  }

  // ── Tier 3: Binance Spot API ─────────────────────────────────────
  try {
    const spotUrl = `${BN_SPOT}/api/v3/klines?symbol=${symbol}&interval=${interval}&limit=${limit}`;
    const raw = await fetchWithRateLimit(spotUrl);
    if (Array.isArray(raw) && raw.length > 0) {
      const parsed = raw.map(c => ({
        openTime:  c[0], open: parseFloat(c[1]), high: parseFloat(c[2]),
        low: parseFloat(c[3]), close: parseFloat(c[4]), volume: parseFloat(c[5]), closeTime: c[6]
      }));
      const result = parsed.slice(0, -1);
      console.log(`[MARKET_DATA] ${symbol}/${interval}: served by Binance Spot (fallback, ${result.length} candles)`);
      return result;
    }
  } catch (err) {
    console.warn(`[MARKET_DATA] Binance Spot failed for ${symbol}: ${err.message} — trying Coinbase`);
  }

  // ── Tier 4: Coinbase ─────────────────────────────────────────────
  try {
    const coin = symbol.replace('USDT', '');
    const cbSymbol = `${coin}-USD`;
    const intervalSecMap = {
      '1m':60,'5m':300,'15m':900,'30m':1800,'1h':3600,'2h':7200,
      '4h':21600,'6h':21600,'12h':43200,'1d':86400
    };
    const granularity = intervalSecMap[interval] || 3600;
    const cbUrl = `https://api.exchange.coinbase.com/products/${cbSymbol}/candles?granularity=${granularity}`;
    const response = await axios.get(cbUrl, { timeout: 8000, headers: { 'User-Agent': 'AlgoBot/1.0' } });
    if (Array.isArray(response.data) && response.data.length > 0) {
      const parsed = response.data.map(c => ({
        openTime:  c[0] * 1000, open: parseFloat(c[3]), high: parseFloat(c[2]),
        low: parseFloat(c[1]), close: parseFloat(c[4]), volume: parseFloat(c[5]),
        closeTime: (c[0] + granularity) * 1000 - 1
      })).sort((a, b) => a.openTime - b.openTime);
      const result = parsed.slice(0, -1);
      console.log(`[MARKET_DATA] ${symbol}/${interval}: served by Coinbase (last fallback, ${result.length} candles)`);
      return result;
    }
  } catch (err) {
    console.error(`[MARKET_DATA] ALL fallbacks failed for ${symbol}/${interval}`);
  }

  return [];
}

function getIntervalMs(interval) {
  const map = {
    '1m':60000,'3m':180000,'5m':300000,'15m':900000,'30m':1800000,
    '1h':3600000,'2h':7200000,'4h':14400000,'6h':21600000,'12h':43200000,'1d':86400000
  };
  return map[interval] || 14400000;
}

async function getFundingRates(symbols = []) {
  // Try Bybit first, fallback to Binance
  try {
    const url = `${BYBIT_BASE}/v5/market/tickers?category=linear`;
    const raw = await fetchWithRateLimit(url);
    if (raw && raw.retCode === 0 && Array.isArray(raw.result?.list)) {
      const rateMap = {};
      raw.result.list.forEach(item => {
        const sym = item.symbol;
        if (symbols.length === 0 || symbols.includes(sym)) {
          rateMap[sym] = parseFloat(item.fundingRate) * 100;
        }
      });
      return rateMap;
    }
  } catch {}
  // Binance fallback
  try {
    const data = await fetchWithRateLimit(`${BN_FUTURES}/fapi/v1/premiumIndex`);
    const rateMap = {};
    if (Array.isArray(data)) {
      data.forEach(item => {
        const normSym = item.symbol.replace(/^1000/, '');
        if (symbols.length === 0 || symbols.includes(normSym) || symbols.includes(item.symbol)) {
          rateMap[normSym] = parseFloat(item.lastFundingRate) * 100;
        }
      });
    }
    return rateMap;
  } catch { return {}; }
}

async function getMaxHistoricalCandles(symbol, interval) {
  const futuresSymbol = getFuturesSymbol(symbol);
  const allCandles = [];
  let endTime = Date.now();
  const maxBatches = 5;
  for (let b = 0; b < maxBatches; b++) {
    try {
      const url = `${BN_FUTURES}/fapi/v1/klines?symbol=${futuresSymbol}&interval=${interval}&limit=1000&endTime=${endTime}`;
      const batch = await fetchWithRateLimit(url);
      if (!Array.isArray(batch) || batch.length === 0) break;
      const parsedBatch = batch.map(candle => ({
        openTime: candle[0], open: parseFloat(candle[1]), high: parseFloat(candle[2]),
        low: parseFloat(candle[3]), close: parseFloat(candle[4]),
        volume: parseFloat(candle[5]), closeTime: candle[6]
      }));
      allCandles.unshift(...parsedBatch);
      endTime = parsedBatch[0].openTime - 1;
      await sleep(150);
    } catch (e) { break; }
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

module.exports = { getTopCoins, getCandles, getFundingRates, getMaxHistoricalCandles, getRateLimitStatus };
