/**
 * Yahoo Finance Data Adapter
 * Provides OHLCV candle data for NSE (Indian stocks), Commodities, and NASDAQ
 * using Yahoo Finance's public (unofficial) chart API — no API key required.
 *
 * Rate limit strategy: ~100 requests/hour. We cache per-symbol for 5 minutes.
 */

const axios = require('axios');
const { sleep } = require('./utils');

// Per-symbol candle cache: { [symbol]: { candles, fetchedAt } }
const candleCache = {};
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

// ── Symbol lists ──────────────────────────────────────────────────

const NSE_SYMBOLS = [
  'RELIANCE.NS','TCS.NS','HDFCBANK.NS','INFY.NS','HINDUNILVR.NS',
  'ICICIBANK.NS','KOTAKBANK.NS','LT.NS','SBIN.NS','BAJFINANCE.NS',
  'BHARTIARTL.NS','ASIANPAINT.NS','AXISBANK.NS','WIPRO.NS','SUNPHARMA.NS',
  'NESTLEIND.NS','TITAN.NS','ULTRACEMCO.NS','POWERGRID.NS','NTPC.NS',
  'MARUTI.NS','TATASTEEL.NS','HCLTECH.NS','TATAMOTORS.NS','INDUSINDBK.NS',
  'ADANIPORTS.NS','BAJAJFINSV.NS','ONGC.NS','CIPLA.NS','DRREDDY.NS'
];

const COMMODITY_SYMBOLS = [
  'GC=F',   // Gold Futures
  'SI=F',   // Silver Futures
  'CL=F',   // Crude Oil WTI Futures
  'NG=F',   // Natural Gas Futures
  'HG=F',   // Copper Futures
  'ZC=F',   // Corn Futures
  'ZW=F'    // Wheat Futures
];

const NASDAQ_SYMBOLS = [
  'AAPL','MSFT','NVDA','AMZN','GOOG','META','TSLA','AVGO','COST','NFLX',
  'AMD','ADBE','INTC','QCOM','PYPL','MRVL','LRCX','KLAC','SNPS','CDNS',
  'ASML','MU','PANW','CRWD','ZS','OKTA','DDOG','SNOW','PLTR','RBLX'
];

// ── Yahoo Finance timeframe mapping ──────────────────────────────

function yahooInterval(timeframe) {
  const map = {
    '1m':'1m', '5m':'5m', '15m':'15m', '30m':'30m',
    '1h':'1h', '2h':'1h', '4h':'1h', '6h':'1h',
    '12h':'1h', '1d':'1d', '1w':'1wk'
  };
  return map[timeframe] || '1d';
}

function yahooRange(timeframe) {
  // How much historical data to request
  const map = {
    '1m':'7d', '5m':'60d', '15m':'60d', '30m':'60d',
    '1h':'730d', '2h':'730d', '4h':'730d', '6h':'730d',
    '12h':'730d', '1d':'2y', '1w':'5y'
  };
  return map[timeframe] || '2y';
}

// ── Core fetch ────────────────────────────────────────────────────

async function fetchCandles(symbol, timeframe = '1d', limit = 300) {
  const cacheKey = `${symbol}|${timeframe}`;
  const cached   = candleCache[cacheKey];
  if (cached && (Date.now() - cached.fetchedAt) < CACHE_TTL_MS) {
    return cached.candles.slice(-limit);
  }

  const interval = yahooInterval(timeframe);
  const range    = yahooRange(timeframe);

  // Yahoo Finance chart API (two mirrors for reliability)
  const urls = [
    `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?interval=${interval}&range=${range}&includePrePost=false`,
    `https://query2.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?interval=${interval}&range=${range}&includePrePost=false`
  ];

  for (const url of urls) {
    try {
      const res = await axios.get(url, {
        timeout: 10000,
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
          'Accept': 'application/json',
          'Accept-Language': 'en-US,en;q=0.9'
        }
      });

      const chart = res.data?.chart?.result?.[0];
      if (!chart) continue;

      const timestamps = chart.timestamp || [];
      const quote      = chart.indicators?.quote?.[0] || {};
      const opens      = quote.open   || [];
      const highs      = quote.high   || [];
      const lows       = quote.low    || [];
      const closes     = quote.close  || [];
      const volumes    = quote.volume || [];

      if (timestamps.length === 0) continue;

      const intervalMs = getIntervalMs(timeframe);
      const candles = [];

      for (let i = 0; i < timestamps.length; i++) {
        const o = opens[i], h = highs[i], l = lows[i], c = closes[i], v = volumes[i];
        // Skip null/NaN candles (market closed, holidays)
        if (o == null || h == null || l == null || c == null ||
            isNaN(o) || isNaN(h) || isNaN(l) || isNaN(c)) continue;

        candles.push({
          openTime:  timestamps[i] * 1000,
          open:      parseFloat(o),
          high:      parseFloat(h),
          low:       parseFloat(l),
          close:     parseFloat(c),
          volume:    parseFloat(v || 0),
          closeTime: timestamps[i] * 1000 + intervalMs - 1
        });
      }

      if (candles.length < 10) continue;

      // Remove last candle (may be incomplete)
      const completeCandles = candles.slice(0, -1);

      candleCache[cacheKey] = { candles: completeCandles, fetchedAt: Date.now() };
      console.log(`[YAHOO] ${symbol}/${timeframe}: fetched ${completeCandles.length} candles`);
      return completeCandles.slice(-limit);
    } catch (err) {
      console.warn(`[YAHOO] ${symbol} fetch error (${url.includes('query1') ? 'mirror1' : 'mirror2'}): ${err.message}`);
      await sleep(500);
    }
  }

  console.error(`[YAHOO] All mirrors failed for ${symbol}/${timeframe}`);
  return candleCache[cacheKey]?.candles.slice(-limit) || [];
}

function getIntervalMs(timeframe) {
  const map = {
    '1m':60000,'5m':300000,'15m':900000,'30m':1800000,
    '1h':3600000,'2h':7200000,'4h':14400000,'6h':21600000,
    '12h':43200000,'1d':86400000,'1w':604800000
  };
  return map[timeframe] || 86400000;
}

// ── Symbol list getters ───────────────────────────────────────────

function getNSESymbols()        { return [...NSE_SYMBOLS]; }
function getCommoditySymbols()  { return [...COMMODITY_SYMBOLS]; }
function getNASDAQSymbols()     { return [...NASDAQ_SYMBOLS]; }

// ── Display name helper ───────────────────────────────────────────

function getDisplayName(symbol) {
  const overrides = {
    'GC=F':'GOLD','SI=F':'SILVER','CL=F':'CRUDE OIL','NG=F':'NAT GAS',
    'HG=F':'COPPER','ZC=F':'CORN','ZW=F':'WHEAT'
  };
  return overrides[symbol] || symbol.replace('.NS','').replace('=F','');
}

module.exports = {
  fetchCandles,
  getNSESymbols,
  getCommoditySymbols,
  getNASDAQSymbols,
  getDisplayName
};
