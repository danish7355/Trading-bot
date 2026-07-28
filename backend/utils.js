function generateUUID() {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
    const r = Math.random() * 16 | 0;
    const v = c === 'x' ? r : (r & 0x3 | 0x8);
    return v.toString(16);
  });
}

function formatUTCDateTime(timestamp) {
  if (!timestamp) return 'N/A';
  const d = new Date(timestamp);
  if (isNaN(d.getTime())) return 'N/A';
  // Convert to Indian Standard Time (IST: UTC + 5:30)
  const istOffsetMs = (5 * 60 + 30) * 60 * 1000;
  const istDate = new Date(d.getTime() + istOffsetMs);
  const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  const day = String(istDate.getUTCDate()).padStart(2, '0');
  const month = months[istDate.getUTCMonth()];
  const year = istDate.getUTCFullYear();
  const hours = String(istDate.getUTCHours()).padStart(2, '0');
  const minutes = String(istDate.getUTCMinutes()).padStart(2, '0');
  const seconds = String(istDate.getUTCSeconds()).padStart(2, '0');
  return `${day}-${month}-${year} ${hours}:${minutes}:${seconds} IST`;
}

function formatUptime(seconds) {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  return `${h}h ${m}m ${s}s`;
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function formatPrice(price) {
  if (price === null || price === undefined || isNaN(price)) return 'N/A';
  if (price >= 1000) return price.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  if (price >= 1) return price.toFixed(4);
  return price.toFixed(6);
}

function getSessionBadge() {
  const hour = new Date().getUTCHours();
  if (hour >= 13 && hour < 17) return 'LONDON_NY_OVERLAP';
  if (hour >= 17 && hour < 21) return 'NY_SESSION';
  if (hour >= 8 && hour < 13) return 'LONDON_SESSION';
  return 'ASIAN_SESSION';
}

function isHighlyCorrelated(symbol1, symbol2) {
  if (symbol1 === symbol2) return true;
  const correlatedGroups = [
    ['ETHUSDT', 'SOLUSDT', 'AVAXUSDT', 'MATICUSDT', 'ARBUSDT', 'OPUSDT'],
    ['BTCUSDT', 'WBTCUSDT'],
    ['BNBUSDT', 'CAKEUSDT'],
    ['DOGEUSDT', 'SHIBUSDT', 'PEPEUSDT', 'FLOKIUSDT']
  ];
  return correlatedGroups.some(group => group.includes(symbol1) && group.includes(symbol2));
}

function getTimeframeMs(timeframe) {
  const map = {
    '1m': 60000,
    '5m': 300000,
    '15m': 900000,
    '30m': 1800000,
    '1h': 3600000,
    '2h': 7200000,
    '4h': 14400000,
    '6h': 21600000,
    '12h': 43200000,
    '1d': 86400000
  };
  return map[timeframe] || 14400000;
}

function calculateCandlesOpen(openedAt, timeframe) {
  if (!openedAt) return 0;
  const tfMs = getTimeframeMs(timeframe);
  const elapsed = Date.now() - openedAt;
  return Math.max(0, Math.floor(elapsed / tfMs));
}

module.exports = {
  generateUUID,
  formatUTCDateTime,
  formatUptime,
  sleep,
  formatPrice,
  getSessionBadge,
  isHighlyCorrelated,
  getTimeframeMs,
  calculateCandlesOpen
};
