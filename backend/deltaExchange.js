const crypto = require('crypto');
const fetch = require('node-fetch');

const TESTNET_URL = 'https://testnet-api.delta.exchange';
const LIVE_URL = 'https://api.delta.exchange';

let productMap = {};

function getBaseUrl() {
  const mode = (process.env.DELTA_MODE || 'testnet').toLowerCase();
  return mode === 'live' ? LIVE_URL : TESTNET_URL;
}

function getApiKey() {
  return process.env.DELTA_API_KEY || '';
}

function getApiSecret() {
  return process.env.DELTA_API_SECRET || '';
}

function signRequest(method, path, queryString = '', body = '', timestamp) {
  const message = method + timestamp + path + queryString + body;
  const secret = getApiSecret();
  if (!secret) return '';
  return crypto.createHmac('sha256', secret).update(message).digest('hex');
}

function getHeaders(method, path, queryString = '', body = '') {
  const timestamp = Math.floor(Date.now() / 1000).toString();
  const signature = signRequest(method, path, queryString, body, timestamp);
  return {
    'api-key': getApiKey(),
    'timestamp': timestamp,
    'signature': signature,
    'Content-Type': 'application/json',
    'User-Agent': 'algo-trading-bot/1.0'
  };
}

async function testConnection() {
  const apiKey = getApiKey();
  const apiSecret = getApiSecret();
  if (!apiKey || !apiSecret) {
    return { connected: false, error: 'API Key or Secret missing in environment variables' };
  }

  try {
    const path = '/v2/wallet/balances';
    const headers = getHeaders('GET', path);
    const response = await fetch(getBaseUrl() + path, { headers });
    const data = await response.json();

    if (data.success !== false) {
      return { connected: true, mode: process.env.DELTA_MODE || 'testnet', balance: data.result || [] };
    } else {
      return { connected: false, error: data.error?.message || 'Delta connection failed' };
    }
  } catch (error) {
    return { connected: false, error: error.message };
  }
}

async function getProducts() {
  try {
    const response = await fetch(getBaseUrl() + '/v2/products');
    const data = await response.json();
    if (data.result && Array.isArray(data.result)) {
      data.result.forEach(p => {
        if (p.symbol) productMap[p.symbol] = p.id;
      });
      return data.result;
    }
    return [];
  } catch (err) {
    console.error('[DELTA] Failed to fetch products:', err.message);
    return [];
  }
}

async function placeOrder(trade) {
  if (Object.keys(productMap).length === 0) {
    await getProducts();
  }

  const productId = productMap[trade.symbol];
  if (!productId) throw new Error(`Symbol not found on Delta: ${trade.symbol}`);

  const path = '/v2/orders';
  const size = Math.max(1, Math.floor(trade.positionValue / 10)); // Contracts count
  const bodyObj = {
    product_id: productId,
    side: trade.direction === 'LONG' ? 'buy' : 'sell',
    order_type: 'market_order',
    size: size,
    time_in_force: 'gtc'
  };
  const body = JSON.stringify(bodyObj);

  const headers = getHeaders('POST', path, '', body);
  const response = await fetch(getBaseUrl() + path, {
    method: 'POST',
    headers,
    body
  });

  const data = await response.json();
  if (data.success) {
    return { orderId: data.result.id, status: 'placed' };
  } else {
    throw new Error('Delta order failed: ' + JSON.stringify(data.error));
  }
}

async function getOpenPositions() {
  try {
    const path = '/v2/positions';
    const headers = getHeaders('GET', path);
    const response = await fetch(getBaseUrl() + path, { headers });
    const data = await response.json();
    return data.result || [];
  } catch (err) {
    console.error('[DELTA] Failed to fetch positions:', err.message);
    return [];
  }
}

async function getBalance() {
  try {
    const path = '/v2/wallet/balances';
    const headers = getHeaders('GET', path);
    const response = await fetch(getBaseUrl() + path, { headers });
    const data = await response.json();
    return data.result || [];
  } catch (err) {
    console.error('[DELTA] Failed to fetch balance:', err.message);
    return [];
  }
}

async function closePosition(symbol, direction) {
  if (Object.keys(productMap).length === 0) {
    await getProducts();
  }

  const productId = productMap[symbol];
  if (!productId) return;

  const positions = await getOpenPositions();
  const pos = positions.find(p => p.product_id === productId);
  if (!pos || pos.size === 0) return;

  const path = '/v2/orders';
  const bodyObj = {
    product_id: productId,
    side: direction === 'LONG' ? 'sell' : 'buy',
    order_type: 'market_order',
    size: Math.abs(pos.size),
    reduce_only: true
  };
  const body = JSON.stringify(bodyObj);

  const headers = getHeaders('POST', path, '', body);
  await fetch(getBaseUrl() + path, { method: 'POST', headers, body });
}

async function cancelOrder(orderId) {
  const path = '/v2/orders/' + orderId;
  const headers = getHeaders('DELETE', path);
  const response = await fetch(getBaseUrl() + path, { method: 'DELETE', headers });
  return await response.json();
}

module.exports = {
  testConnection,
  getProducts,
  placeOrder,
  getOpenPositions,
  getBalance,
  closePosition,
  cancelOrder
};
