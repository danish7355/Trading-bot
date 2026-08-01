/**
 * exchangeKeys.js — Server-side storage for exchange API credentials.
 *
 * Keys are NEVER sent to the frontend after entry.
 * The frontend only receives a boolean "configured: true/false" per exchange.
 *
 * File: data/exchange_keys.json  (excluded from git via .gitignore)
 */

const fs   = require('fs').promises;
const path = require('path');
const axios = require('axios');

const KEY_FILE = path.join(__dirname, '../data/exchange_keys.json');

const SUPPORTED = ['binance', 'coinbase', 'delta'];

// ── File I/O ─────────────────────────────────────────────────────

async function loadKeys() {
  try {
    const raw = await fs.readFile(KEY_FILE, 'utf8');
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

async function saveKeys(keysObj) {
  await fs.mkdir(path.dirname(KEY_FILE), { recursive: true });
  await fs.writeFile(KEY_FILE, JSON.stringify(keysObj, null, 2), 'utf8');
}

// ── Public API ────────────────────────────────────────────────────

/** Save API key + secret for an exchange. Mode is 'demo' or 'live'. */
async function setExchangeKeys(exchange, apiKey, apiSecret, mode = 'demo') {
  if (!SUPPORTED.includes(exchange)) throw new Error(`Unsupported exchange: ${exchange}`);
  const all = await loadKeys();
  all[exchange] = { apiKey, apiSecret, mode, updatedAt: new Date().toISOString() };
  await saveKeys(all);
}

/** Return a status object safe to send to the frontend (keys redacted). */
async function getExchangeStatus() {
  const all = await loadKeys();
  const result = {};
  for (const ex of SUPPORTED) {
    if (all[ex]?.apiKey) {
      result[ex] = {
        configured: true,
        mode:       all[ex].mode || 'demo',
        keyHint:    all[ex].apiKey.slice(0, 4) + '****',
        updatedAt:  all[ex].updatedAt,
      };
    } else {
      result[ex] = { configured: false, mode: 'demo' };
    }
  }
  return result;
}

/** Retrieve the full key for internal use (never expose over API). */
async function getExchangeKeys(exchange) {
  const all = await loadKeys();
  return all[exchange] || null;
}

/** Remove stored keys for an exchange. */
async function clearExchangeKeys(exchange) {
  const all = await loadKeys();
  delete all[exchange];
  await saveKeys(all);
}

// ── Connection tests ─────────────────────────────────────────────

async function testBinanceConnection(apiKey, apiSecret) {
  try {
    const crypto = require('crypto');
    const ts  = Date.now();
    const qs  = `timestamp=${ts}`;
    const sig = crypto.createHmac('sha256', apiSecret).update(qs).digest('hex');
    const url = `https://api.binance.com/api/v3/account?${qs}&signature=${sig}`;
    const res = await axios.get(url, {
      headers: { 'X-MBX-APIKEY': apiKey },
      timeout: 8000,
    });
    return { success: true, message: `Binance OK — account type: ${res.data.accountType || 'SPOT'}` };
  } catch (err) {
    const status = err.response?.status;
    if (status === 401 || status === 403) return { success: false, message: 'Invalid API key or insufficient permissions' };
    return { success: false, message: err.message };
  }
}

async function testCoinbaseConnection(apiKey, apiSecret) {
  try {
    const crypto = require('crypto');
    const ts      = Math.floor(Date.now() / 1000).toString();
    const method  = 'GET';
    const reqPath = '/api/v3/brokerage/accounts';
    const body    = '';
    const msg     = ts + method + reqPath + body;
    const sig     = crypto.createHmac('sha256', apiSecret).update(msg).digest('hex');
    const res = await axios.get('https://api.coinbase.com' + reqPath, {
      headers: {
        'CB-ACCESS-KEY':       apiKey,
        'CB-ACCESS-SIGN':      sig,
        'CB-ACCESS-TIMESTAMP': ts,
      },
      timeout: 8000,
    });
    return { success: true, message: `Coinbase OK — ${res.data?.accounts?.length ?? 0} account(s) found` };
  } catch (err) {
    const status = err.response?.status;
    if (status === 401 || status === 403) return { success: false, message: 'Invalid Coinbase key or missing permissions' };
    return { success: false, message: err.message };
  }
}

async function testDeltaConnection(apiKey, apiSecret) {
  try {
    // Delta Exchange uses HMAC-SHA256 signed requests
    const crypto    = require('crypto');
    const method    = 'GET';
    const path_str  = '/v2/profile';
    const ts        = Math.floor(Date.now() / 1000).toString();
    const sig_data  = method + ts + path_str;
    const sig       = crypto.createHmac('sha256', apiSecret).update(sig_data).digest('hex');
    const res = await axios.get('https://api.delta.exchange' + path_str, {
      headers: {
        'api-key':       apiKey,
        'signature':     sig,
        'timestamp':     ts,
        'User-Agent':    'AlgoBot/1.0',
        'Content-Type':  'application/json',
      },
      timeout: 8000,
    });
    return { success: true, message: `Delta OK — user: ${res.data?.result?.email || 'authenticated'}` };
  } catch (err) {
    const status = err.response?.status;
    if (status === 401 || status === 403) return { success: false, message: 'Invalid Delta key or insufficient permissions' };
    return { success: false, message: err.message };
  }
}

async function testConnection(exchange, apiKey, apiSecret) {
  switch (exchange) {
    case 'binance':  return testBinanceConnection(apiKey, apiSecret);
    case 'coinbase': return testCoinbaseConnection(apiKey, apiSecret);
    case 'delta':    return testDeltaConnection(apiKey, apiSecret);
    default: return { success: false, message: `Unknown exchange: ${exchange}` };
  }
}

module.exports = {
  setExchangeKeys,
  getExchangeStatus,
  getExchangeKeys,
  clearExchangeKeys,
  testConnection,
  SUPPORTED,
};
