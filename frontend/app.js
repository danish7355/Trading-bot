// ── WebSocket connection ──────────────────────────────────────────

function getWebSocketURL() {
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  return protocol + '//' + window.location.host;
}

let ws = null;
let wsReconnectAttempts = 0;
let wsReconnectTimer    = null;

let scannerCoins    = [];
let openTradesLocal = [];
const currentPrices = {};
let activeTimeframe = '4h';
let sortColumn      = 'score';
let sortDirection   = 'desc';
let dailyRealizedPnL = 0;
let appSettings     = {};

// Per-market state
const marketCoins  = { nse: [], commodities: [], nasdaq: [] };
const marketTrades = { nse: [], commodities: [], nasdaq: [] };

document.addEventListener('DOMContentLoaded', () => {
  connectWebSocket();
  setupTabNavigation();
  setupTimeframeSelector();
  setupSettingsHandlers();
  setupFilterListeners();
  setupTableSorting();
});

function connectWebSocket() {
  updateConnectionBadge('connecting');
  ws = new WebSocket(getWebSocketURL());

  ws.onopen = () => {
    wsReconnectAttempts = 0;
    updateConnectionBadge('connected');
    sendToBackend('GET_INITIAL_STATE', {});
  };

  ws.onmessage = (event) => {
    try {
      const msg = JSON.parse(event.data);
      handleBackendMessage(msg);
    } catch (e) {
      console.error('[WS] Failed to parse message:', e.message);
    }
  };

  ws.onclose = (event) => {
    updateConnectionBadge('disconnected');
    scheduleReconnect();
  };

  ws.onerror = () => updateConnectionBadge('error');
}

function scheduleReconnect() {
  if (wsReconnectTimer) clearTimeout(wsReconnectTimer);
  const delay = Math.min(1000 * Math.pow(2, wsReconnectAttempts), 8000);
  wsReconnectAttempts++;
  wsReconnectTimer = setTimeout(connectWebSocket, delay);
}

function sendToBackend(type, data) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type, data }));
  }
}

function updateConnectionBadge(status) {
  const badge = document.getElementById('connection-status');
  if (!badge) return;
  const states = {
    connected:    { text: '⚡ Connected',    class: 'status-connected' },
    connecting:   { text: '⏳ Connecting...',  class: 'status-connecting' },
    disconnected: { text: '🔴 Disconnected',  class: 'status-disconnected' },
    error:        { text: '❌ Error',         class: 'status-error' }
  };
  const s = states[status] || states.disconnected;
  badge.textContent = s.text;
  badge.className   = 'connection-badge ' + s.class;
  // Section 2: show WS disconnected banner; disable scan button when down
  if (typeof showWsDisconnectedBanner === 'function') {
    showWsDisconnectedBanner(status === 'disconnected' || status === 'error');
  }
  // Clear WS-disconnected guard badge when reconnected
  if (status === 'connected' && typeof handleGuardStateChanged === 'function') {
    if (Array.isArray(activeGuardConditions)) {
      activeGuardConditions = activeGuardConditions.filter(c => c.id !== 'websocket_disconnected');
      handleGuardStateChanged(activeGuardConditions);
    }
  }
}

// ── Message routing ───────────────────────────────────────────────

function handleBackendMessage(msg) {
  switch (msg.type) {
    case 'PRICE_UPDATE':         handlePriceUpdate(msg.data); break;
    case 'SCANNER_UPDATE':       handleScannerUpdate(msg.data); break;
    case 'SIGNAL_DETECTED':      handleNewSignal(msg.data); break;
    case 'TRADE_OPENED':         handleTradeOpened(msg.data); break;
    case 'TRADE_UPDATE':         handleTradeUpdate(msg.data); break;
    case 'TRADE_CLOSED':         handleTradeClosed(msg.data); break;
    case 'WM_CONFIRMED':         showWMModal(msg.data); break;
    case 'WM_STATE_CHANGE':      handleWMStateChange(msg.data); break;
    case 'RANGING_DETECTED':     handleRangingDetected(msg.data); break;
    case 'SYSTEM_STATUS':        handleSystemStatus(msg.data); break;
    case 'GATE_LOG':             updateGateLog(msg.data); break;
    case 'ALERT':                showAlert(msg.data); break;
    case 'BACKTEST_PROGRESS':    updateBacktestProgress(msg.data); break;
    case 'BACKTEST_COMPLETE':    showBacktestResults(msg.data); break;
    case 'INITIAL_STATE':        initializeFromState(msg.data); break;
    case 'SETTINGS_UPDATED':     handleSettingsUpdated(msg.data); break;
    case 'BALANCE_UPDATE':
      const demoBalEl = document.getElementById('demo-balance');
      if (demoBalEl && msg.data?.demoBalance !== undefined)
        demoBalEl.textContent = '$' + msg.data.demoBalance.toLocaleString('en-US', { minimumFractionDigits: 2 });
      break;
    // Issue 1: heartbeat events
    case 'SCAN_HEARTBEAT':       handleScanHeartbeat(msg.data); break;
    // Multi-market
    case 'MARKET_SCANNER_UPDATE': handleMarketScannerUpdate(msg.data); break;
    case 'MARKET_SCAN_HEARTBEAT': handleMarketHeartbeat(msg.data); break;
    case 'MARKET_TRADE_OPENED':   handleMarketTradeOpened(msg.data); break;
    // Section 3: guard events
    case 'GUARD_STATE_CHANGED':  handleGuardStateChanged(msg.data); break;
    case 'GUARD_BLOCKED':        handleGuardBlocked(msg.data); break;
    case 'PRICE_FEED_CHANGED':   handlePriceFeedChanged(msg.data); break;
    default:
      // silently ignore unknown types
  }
}

// ── Initial state ─────────────────────────────────────────────────

function initializeFromState(state) {
  appSettings = state.settings || {};

  const demoBalEl = document.getElementById('demo-balance');
  if (demoBalEl) demoBalEl.textContent = '$' + (state.demoBalance ?? 10000).toLocaleString('en-US', { minimumFractionDigits: 2 });

  if (state.priceFeed) {
    handlePriceFeedChanged(state.priceFeed);
  }

  if (state.currentPrices) Object.assign(currentPrices, state.currentPrices);

  if (state.coins?.length > 0) {
    scannerCoins = state.coins;
    renderScannerTable();
  }

  if (state.openTrades) {
    openTradesLocal = state.openTrades;
    const grid = document.getElementById('positions-grid');
    if (grid) grid.innerHTML = '';
    openTradesLocal.forEach(t => addTradeCardToDOM(t));
    const openCountEl = document.getElementById('open-trades-count');
    if (openCountEl) openCountEl.textContent = openTradesLocal.length;
    const panel = document.getElementById('active-positions');
    if (panel) panel.style.display = openTradesLocal.length > 0 ? 'block' : 'none';
  }

  if (state.signals) populateSignalTable(state.signals);
  if (state.dailyPnL) { dailyRealizedPnL = state.dailyPnL.realizedPnL || 0; updateTopBarTotalPnL(); }
  if (state.systemStatus) handleSystemStatus(state.systemStatus);
  if (state.settings?.timeframe) setActiveTimeframe(state.settings.timeframe);

  // Issue 1: show initial heartbeat
  if (state.systemStatus?.scanHeartbeat) handleScanHeartbeat(state.systemStatus.scanHeartbeat);

  // Multi-market initial status
  if (state.marketStatus) {
    Object.entries(state.marketStatus).forEach(([marketId, info]) => {
      if (info.heartbeat) handleMarketHeartbeat({ market: marketId, heartbeat: info.heartbeat });
    });
  }
}

// ── Issue 1: scan heartbeat display ──────────────────────────────

function handleScanHeartbeat(hb) {
  if (!hb) return;
  updateHeartbeatUI('crypto', hb);
}

function handleMarketHeartbeat(data) {
  if (!data?.market || !data?.heartbeat) return;
  updateHeartbeatUI(data.market, data.heartbeat);
}

function updateHeartbeatUI(marketId, hb) {
  const statusEl   = document.getElementById(`hb-${marketId}-status`);
  const timeEl     = document.getElementById(`hb-${marketId}-time`);
  const durationEl = document.getElementById(`hb-${marketId}-duration`);

  if (!statusEl) return;

  const now = Date.now();
  const minsAgo = hb.timestamp ? Math.floor((now - hb.timestamp) / 60000) : null;
  const timeStr  = minsAgo !== null
    ? (minsAgo === 0 ? 'just now' : `${minsAgo}m ago`)
    : '—';

  if (hb.status === 'ok') {
    statusEl.textContent = '✅ OK';
    statusEl.className   = 'badge badge-hb-ok';
  } else if (hb.status === 'running') {
    statusEl.textContent = '⚙️ Running...';
    statusEl.className   = 'badge badge-hb-running';
  } else if (hb.status === 'error') {
    statusEl.textContent = '⚠️ Error';
    statusEl.className   = 'badge badge-hb-error';
    if (hb.error) statusEl.title = hb.error;
  } else {
    statusEl.textContent = '⏳ Pending';
    statusEl.className   = 'badge badge-hb-pending';
  }

  if (timeEl) {
    timeEl.textContent = `Last: ${timeStr}`;
    // Color based on age: > 10 min = amber, > 15 min = red
    if (minsAgo !== null && minsAgo > 15) timeEl.className = 'red';
    else if (minsAgo !== null && minsAgo > 10) timeEl.className = 'amber';
    else timeEl.className = 'dim';
  }

  if (durationEl && hb.durationMs != null) {
    durationEl.textContent = `(${(hb.durationMs / 1000).toFixed(1)}s)`;
  }

  // Also update the top bar badge for crypto
  if (marketId === 'crypto') {
    const topBadge = document.getElementById('scan-heartbeat-badge');
    if (topBadge) {
      if (hb.status === 'ok') {
        topBadge.textContent = `✅ ${timeStr}`;
        topBadge.className   = 'badge badge-hb-ok';
      } else if (hb.status === 'running') {
        topBadge.textContent = '⚙️';
        topBadge.className   = 'badge badge-hb-running';
      } else if (hb.status === 'error') {
        topBadge.textContent = `⚠️ ${timeStr}`;
        topBadge.className   = 'badge badge-hb-error';
        topBadge.title       = hb.error || 'Scan error';
      }
    }
  }
}

// Periodically refresh heartbeat age display
setInterval(() => {
  // Re-fetch heartbeat from server every 60 seconds
  fetch('/api/scanner/heartbeat').then(r => r.json()).then(hb => handleScanHeartbeat(hb)).catch(() => {});
}, 60000);

// ── Price updates ─────────────────────────────────────────────────

let activePriceProvider = 'bybit';
let totalTicksReceived = 0;

function handlePriceUpdate(priceData) {
  totalTicksReceived += Object.keys(priceData).length;
  const tickBadge = document.getElementById('live-ticks-badge');
  if (tickBadge) {
    const provLabel = activePriceProvider.toUpperCase();
    tickBadge.textContent = `⚡ [${provLabel}] ${totalTicksReceived} Ticks`;
    tickBadge.className   = 'badge badge-active';
  }

  Object.entries(priceData).forEach(([symbol, info]) => {
    const price  = typeof info === 'object' ? info.price : info;
    const change = typeof info === 'object' ? info.change : 0;
    if (!price || isNaN(price)) return;

    const previousPrice = currentPrices[symbol];
    currentPrices[symbol] = price;

    // Section 2: animated price cell (arrows + flash + stale tracking)
    if (typeof animatePriceCell === 'function') {
      animatePriceCell(symbol, price, previousPrice);
    } else {
      const priceEl = document.getElementById('price-' + symbol);
      if (priceEl) {
        const newText = '$' + formatPrice(price);
        if (newText !== priceEl.textContent) {
          priceEl.textContent = newText;
          priceEl.classList.remove('price-up', 'price-down');
          void priceEl.offsetWidth;
          if (previousPrice && price > previousPrice) { priceEl.classList.add('price-up'); priceEl.style.color = '#00ff88'; }
          else if (previousPrice && price < previousPrice) { priceEl.classList.add('price-down'); priceEl.style.color = '#ff3366'; }
          setTimeout(() => { priceEl.style.color = ''; }, 600);
        }
      }
    }

    const changeEl = document.getElementById('change-' + symbol);
    if (changeEl && !isNaN(change)) {
      changeEl.textContent = (change >= 0 ? '+' : '') + change.toFixed(2) + '%';
      changeEl.className   = change >= 0 ? 'green' : 'red';
    }

    openTradesLocal.filter(t => t.symbol === symbol).forEach(t => recalculateTradePnL(t, price));
  });

  if (window.chartOverlayOpen) {
    const activeSym = document.getElementById('chart-symbol-title')?.textContent;
    if (activeSym && currentPrices[activeSym]) updateChartTick(currentPrices[activeSym]);
  }

  updateTopBarTotalPnL();
}

// ── Price Feed Provider Selection ─────────────────────────────────

function changePriceFeed(provider) {
  fetch('/api/price-feed/source', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ provider }),
  })
    .then(r => r.json())
    .then(data => {
      if (data.selected) handlePriceFeedChanged(data);
    })
    .catch(err => console.error('[FEED] Failed to change price feed:', err));
}

function handlePriceFeedChanged(data) {
  if (data.selected) {
    const selectEl = document.getElementById('price-feed-select');
    if (selectEl) selectEl.value = data.selected;
  }
  if (data.active) {
    activePriceProvider = data.active;
    // Update the badge immediately so user sees the switch
    const tickBadge = document.getElementById('live-ticks-badge');
    if (tickBadge) {
      tickBadge.textContent = `⚡ [${data.active.toUpperCase()}] ${totalTicksReceived} Ticks`;
    }
  }
}

function recalculateTradePnL(trade, currentPrice) {
  let rawPnL = 0;
  if (trade.direction === 'LONG') rawPnL = ((currentPrice - trade.entryPrice) / trade.entryPrice) * trade.positionValue * trade.leverage;
  else rawPnL = ((trade.entryPrice - currentPrice) / trade.entryPrice) * trade.positionValue * trade.leverage;
  const unrealizedPnL = rawPnL * (trade.remainingPct || 1.0);
  const pnlPct        = (unrealizedPnL / trade.positionValue) * 100;
  trade._unrealizedPnL = unrealizedPnL;
  trade._currentPrice  = currentPrice;

  const pnlEl = document.getElementById('pnl-' + trade.id);
  if (pnlEl) {
    const sign = unrealizedPnL >= 0 ? '+' : '';
    pnlEl.textContent = sign + '$' + Math.abs(unrealizedPnL).toFixed(2) + ' (' + sign + pnlPct.toFixed(2) + '%)';
    pnlEl.className   = 'trade-pnl ' + (unrealizedPnL >= 0 ? 'pnl-positive' : 'pnl-negative');
  }

  const cpEl = document.getElementById('current-price-' + trade.id);
  if (cpEl) cpEl.textContent = '$' + formatPrice(currentPrice);
}

function updateTopBarTotalPnL() {
  const totalUnrealized = openTradesLocal.reduce((s, t) => s + (t._unrealizedPnL || 0), 0);
  const total = dailyRealizedPnL + totalUnrealized;
  const el    = document.getElementById('pnl-today');
  if (el) {
    el.textContent = (total >= 0 ? '+' : '') + '$' + Math.abs(total).toFixed(2);
    el.className   = total >= 0 ? 'green' : 'red';
  }
}

// ── Scanner table ─────────────────────────────────────────────────

function handleScannerUpdate(data) {
  scannerCoins = data.coins || [];
  renderScannerTable();
}

function updateGateCells(row, coin) {
  const gateData = [
    { pass: coin.gate1 === 'PASS', value: coin.gate1Direction || '',          reason: coin.gate1FailReason },
    { pass: coin.gate2 === 'PASS', value: (coin.gate2Value?.toFixed(1)||'—')+'×', reason: coin.gate2FailReason },
    { pass: coin.gate3 === 'PASS', value: coin.gate3ADX?.toFixed(0) || 'N/A',  reason: coin.gate3FailReason },
    { pass: coin.gate4 === 'PASS', value: coin.gate4RSI?.toFixed(1) || 'N/A',  reason: coin.gate4FailReason },
    { pass: coin.gate5 === 'PASS', value: 'LIQ',   reason: coin.gate5FailReason },
    { pass: coin.gate6 === 'PASS', value: 'SPR',   reason: coin.gate6FailReason },
    { pass: coin.gate7 === 'PASS', value: 'VOL%',  reason: coin.gate7FailReason },
    { pass: coin.gate8 === 'PASS', value: 'MACD',  reason: coin.gate8FailReason },
    { pass: coin.gate9 === 'PASS', value: 'ST',    reason: coin.gate9FailReason },
    { pass: coin.gate10 === 'PASS', value: 'R:R',  reason: coin.gate10FailReason },
  ];
  row.querySelectorAll('[data-gate]').forEach((cell, i) => {
    const g = gateData[i];
    if (!g) return;
    cell.innerHTML = g.pass
      ? `<span class="gate-pass" title="${g.value}">✅ ${g.value}</span>`
      : `<span class="gate-fail" title="${g.reason||''}">❌ ${g.value}</span>`;
  });
}

function updateScannerRow(coin) {
  const existing = document.getElementById('row-' + coin.symbol);
  if (existing) existing.outerHTML = createScannerRow(coin, existing.rowIndex);
}

function renderScannerTable() {
  const tbody = document.getElementById('scanner-tbody');
  if (!tbody) return;
  tbody.innerHTML = '';
  const filtered = applyScannerFilters(scannerCoins);
  const sorted   = sortCoins(filtered, sortColumn, sortDirection);
  sorted.forEach((coin, idx) => tbody.insertAdjacentHTML('beforeend', createScannerRow(coin, idx + 1)));

  const rangingCount = document.getElementById('ranging-count');
  const rangingCoins = scannerCoins.filter(c => c.isRanging);
  if (rangingCount) rangingCount.textContent = rangingCoins.length;
}

function applyScannerFilters(coins) {
  const search      = (document.getElementById('search-coin')?.value || '').toLowerCase();
  const dirFilter   = document.getElementById('filter-direction')?.value || 'All';
  const statusFilter= document.getElementById('filter-status')?.value   || 'All';
  const scoreFilter = document.getElementById('filter-score')?.value    || 'All';
  return coins.filter(coin => {
    if (search && !coin.symbol.toLowerCase().includes(search)) return false;
    if (dirFilter !== 'All' && coin.direction !== dirFilter.toUpperCase()) return false;
    if (statusFilter === 'Trading' && coin.isRanging) return false;
    if (statusFilter === 'Ranging' && !coin.isRanging) return false;
    if (scoreFilter === 'Elite (85+)' && coin.score < 85) return false;
    if (scoreFilter === 'Strong (70+)' && coin.score < 70) return false;
    return true;
  });
}

function sortCoins(coins, col, dir) {
  return [...coins].sort((a, b) => {
    let aVal = a[col], bVal = b[col];
    if (aVal == null) return 1;
    if (bVal == null) return -1;
    return dir === 'desc' ? (bVal > aVal ? 1 : -1) : (aVal > bVal ? 1 : -1);
  });
}

function createScannerRow(coin, rank) {
  const direction   = coin.direction === 'LONG' ? '<span class="dir-long">▲ LONG</span>' : '<span class="dir-short">▼ SHORT</span>';
  const scoreDisplay= coin.score?.total !== undefined
    ? coin.score.total + (coin.score?.wmBonus > 0 ? `<span class="wm-bonus">(+${coin.score.wmBonus})</span>` : '')
    : (coin.scoreDisplay || coin.score || '—');
  const g1 = coin.gate1 === 'PASS'
    ? `<span class="gate-pass" title="${coin.gate1Direction||''}">✅ ${coin.gate1Direction||''}</span>`
    : `<span class="gate-fail" title="${coin.gate1FailReason||'No cross'}">❌</span>`;
  const g2 = coin.gate2 === 'PASS'
    ? `<span class="gate-pass">✅ ${coin.gate2Value?.toFixed(1)||''}×</span>`
    : `<span class="gate-fail" title="${coin.gate2FailReason||''}">❌ ${coin.gate2Value?.toFixed(1)||'—'}×</span>`;
  const g3 = coin.gate3 === 'PASS'
    ? `<span class="gate-pass">✅ ${coin.gate3ADX?.toFixed(0)||''}</span>`
    : `<span class="gate-fail" title="${coin.gate3FailReason||''}">❌ ${coin.gate3ADX?.toFixed(0)||'N/A'}</span>`;
  const g4 = coin.gate4 === 'PASS'
    ? `<span class="gate-pass">✅ ${coin.gate4RSI?.toFixed(1)||''}</span>`
    : `<span class="gate-fail" title="${coin.gate4FailReason||''}">❌ ${coin.gate4RSI?.toFixed(1)||'N/A'}</span>`;
  const g5 = coin.gate5==='PASS' ? `<span class="gate-pass">✅</span>` : `<span class="gate-fail" title="${coin.gate5FailReason||''}">❌</span>`;
  const g6 = coin.gate6==='PASS' ? `<span class="gate-pass">✅</span>` : `<span class="gate-fail" title="${coin.gate6FailReason||''}">❌</span>`;
  const g7 = coin.gate7==='PASS' ? `<span class="gate-pass">✅</span>` : `<span class="gate-fail" title="${coin.gate7FailReason||''}">❌</span>`;
  const g8 = coin.gate8==='PASS' ? `<span class="gate-pass">✅</span>` : `<span class="gate-fail" title="${coin.gate8FailReason||''}">❌</span>`;
  const g9 = coin.gate9==='PASS' ? `<span class="gate-pass">✅</span>` : `<span class="gate-fail" title="${coin.gate9FailReason||''}">❌</span>`;
  const g10 = coin.gate10==='PASS' ? `<span class="gate-pass">✅</span>` : `<span class="gate-fail" title="${coin.gate10FailReason||''}">❌</span>`;
  const confBadge = `<span class="${coin.confirmationPassed?'green':'amber'}" title="${coin.confirmationCount||0}/3 confirmation gates">${coin.confirmationCount||0}/3</span>`;
  const rowClass = [
    coin.isRanging ? 'row-ranging' : '',
    coin.openTrade ? 'row-trade-active' : '',
    (coin.mandatoryPassed && coin.confirmationPassed) ? 'row-all-gates' : '',
    coin.wmState === 'READY' ? 'row-wm-ready' : ''
  ].filter(Boolean).join(' ');
  const displayPrice = currentPrices[coin.symbol] || coin.price || 0;
  return `<tr id="row-${coin.symbol}" class="${rowClass}">
    <td>${rank}</td>
    <td class="symbol-cell" onclick="openChartOverlay('${coin.symbol}')" style="cursor:pointer;font-weight:bold">
      ${coin.symbol.replace('USDT','')} <span class="pair-suffix">USDT</span>
    </td>
    <td id="price-${coin.symbol}" data-price="${displayPrice}" class="price-cell mono">$${formatPrice(displayPrice)}</td>
    <td id="change-${coin.symbol}" class="${(coin.change24h||0)>=0?'green':'red'}">${(coin.change24h||0)>=0?'+':''}${(coin.change24h||0).toFixed(2)}%</td>
    <td class="score-cell ${getScoreClass(coin.score?.total||coin.score)}">${scoreDisplay}</td>
    <td>${direction}</td>
    <td class="status-cell">${renderStatusBadges(coin)}</td>
    <td class="mono dim">${coin.ema9?.toFixed(2)||'—'}</td>
    <td class="mono dim">${coin.ema55?.toFixed(2)||'—'}</td>
    <td class="${coin.emaRelationship==='ABOVE'?'green':'red'}">${coin.emaRelationship||'—'}</td>
    <td class="${adxClass}">${coin.adx?.toFixed(1)||'N/A'}</td>
    <td class="${rsiClass}">${coin.rsi?.toFixed(1)||'N/A'}</td>
    <td class="${volClass}">${coin.volumeRatio?.toFixed(1)||'—'}×</td>
    <td class="dim">${coin.fundingRate!==undefined?(coin.fundingRate>0?'+':'')+coin.fundingRate.toFixed(4)+'%':'—'}</td>
    <td data-gate="1">${g1}</td>
    <td data-gate="2">${g2}</td>
    <td data-gate="3">${g3}</td>
    <td data-gate="4">${g4}</td>
    <td data-gate="5">${g5}</td>
    <td data-gate="6">${g6}</td>
    <td data-gate="7">${g7}</td>
    <td data-gate="8" title="Confirmation">${g8}</td>
    <td data-gate="9" title="Confirmation">${g9}</td>
    <td data-gate="10" title="Confirmation">${g10}</td>
    <td>${confBadge}</td>
    <td class="wm-cell">${renderWMBadge(coin.wmState,coin.wmType)}</td>
    <td><button onclick="openChartOverlay('${coin.symbol}')" class="chart-btn">📊</button></td>
  </tr>`;
}

// ── Trade cards ───────────────────────────────────────────────────

function handleTradeOpened(trade) {
  addTradeCardToDOM(trade);
  showToast(`🤖 Trade Opened: ${trade.symbol} ${trade.direction} @ $${formatPrice(trade.entryPrice)}`, 'success');
}

function handleTradeUpdate(update) {
  const tradeId = update.tradeId || update.id;
  const trade   = openTradesLocal.find(t => t.id === tradeId);
  if (trade) {
    Object.assign(trade, update);
    if (update.currentPrice) recalculateTradePnL(trade, update.currentPrice);
    const trailingEl = document.getElementById('trailing-' + trade.id);
    if (trailingEl && update.trailingActive)
      trailingEl.textContent = '🔒 Active at $' + formatPrice(update.trailingStop);
  }
}

function handleTradeClosed(closedTrade) {
  openTradesLocal = openTradesLocal.filter(t => t.id !== closedTrade.id);
  const card = document.getElementById('card-' + closedTrade.id);
  if (card) card.remove();
  const countEl    = document.getElementById('positions-count');
  if (countEl) countEl.textContent = openTradesLocal.length;
  const openCountTop = document.getElementById('open-trades-count');
  if (openCountTop) openCountTop.textContent = openTradesLocal.length;
  if (openTradesLocal.length === 0) {
    const panel = document.getElementById('active-positions');
    if (panel) panel.style.display = 'none';
  }
  dailyRealizedPnL += (closedTrade.realizedPnL || 0);
  updateTopBarTotalPnL();
  const pnl  = closedTrade.realizedPnL || 0;
  const sign = pnl >= 0 ? '+' : '';
  showToast(`Trade Closed (${closedTrade.symbol}) ${getOutcomeDisplay(closedTrade.outcome)} ${sign}$${pnl.toFixed(2)}`, pnl >= 0 ? 'success' : 'error');
}

function addTradeCardToDOM(trade) {
  const panel = document.getElementById('active-positions');
  if (panel) panel.style.display = 'block';
  const grid = document.getElementById('positions-grid');
  if (!grid) return;
  const existing = document.getElementById('card-' + trade.id);
  if (existing) existing.remove();
  grid.insertAdjacentHTML('afterbegin', createTradeCard(trade));
  if (!openTradesLocal.some(t => t.id === trade.id)) openTradesLocal.push(trade);
  recalculateTradePnL(trade, currentPrices[trade.symbol] || trade.entryPrice);
}

function createTradeCard(trade) {
  const dirClass = trade.direction === 'LONG' ? 'dir-long' : 'dir-short';
  const dirIcon  = trade.direction === 'LONG' ? '▲' : '▼';
  return `<div class="trade-card" id="card-${trade.id}">
    <div class="trade-card-header">
      <span class="trade-symbol">${trade.symbol}</span>
      <span class="trade-direction ${dirClass}">${dirIcon} ${trade.direction}</span>
      <span class="trade-tf">${(trade.timeframe||'').toUpperCase()}</span>
      <span class="trade-trigger">${trade.trigger||''}</span>
      <span class="trade-badge-open">🟢 OPEN</span>
    </div>
    <div class="trade-timestamps">Opened: <strong>${trade.openedAtUTC}</strong></div>
    <div class="trade-prices">
      <div>Entry: <strong>$${formatPrice(trade.entryPrice)}</strong></div>
      <div>Current: <strong id="current-price-${trade.id}">$${formatPrice(trade.currentPrice||trade.entryPrice)}</strong></div>
    </div>
    <div id="pnl-${trade.id}" class="trade-pnl pnl-neutral">$0.00 (0.00%)</div>
    <div class="trade-levels">
      <span class="level-sl">SL: $${formatPrice(trade.stopLoss)}</span>
      <span class="level-tp1 ${trade.tp1Hit?'hit':''}">TP1: $${formatPrice(trade.tp1)} ${trade.tp1Hit?'✅':''}</span>
      <span class="level-tp2 ${trade.tp2Hit?'hit':''}">TP2: $${formatPrice(trade.tp2)} ${trade.tp2Hit?'✅':''}</span>
      <span class="level-tp3">TP3: $${formatPrice(trade.tp3)}</span>
    </div>
    <div class="trade-trailing">
      Trailing: <span id="trailing-${trade.id}">${trade.trailingActive?'🔒 Active at $'+formatPrice(trade.trailingStop):'Activates after TP1'}</span>
    </div>
    <div class="trade-meta">
      <span>Score at entry: ${trade.scoreAtEntry}/100</span>
      <span>Position: $${trade.positionValue} × ${trade.leverage}×</span>
      <span>Risk: ${((trade.remainingPct||1)*100).toFixed(0)}% open</span>
    </div>
    <div class="trade-actions">
      <button onclick="openChartOverlay('${trade.symbol}')" class="btn-chart">📊 Chart</button>
      <button onclick="closeTrade('${trade.id}')" class="btn-close-trade">❌ Close Trade</button>
    </div>
  </div>`;
}

async function closeTrade(tradeId) {
  try {
    const res  = await fetch('/api/trades/close', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ tradeId }) });
    const data = await res.json();
    if (data.success) showToast('Trade manually closed at $' + formatPrice(data.exitPrice), 'success');
    else showToast('Close trade error: ' + data.error, 'error');
  } catch (err) {
    showToast('Failed to close trade: ' + err.message, 'error');
  }
}

// ── Issue 3: Trade Log tab ────────────────────────────────────────

async function loadTradeLog() {
  try {
    const res  = await fetch('/api/trades/log');
    const data = await res.json();
    const tbody = document.getElementById('tradelog-tbody');
    if (!tbody) return;

    const totalEl  = document.getElementById('tl-total');
    const openEl   = document.getElementById('tl-open');
    const closedEl = document.getElementById('tl-closed');
    if (totalEl)  totalEl.textContent  = data.total || 0;
    if (openEl)   openEl.textContent   = data.openCount || 0;
    if (closedEl) closedEl.textContent = data.closedCount || 0;

    tbody.innerHTML = '';
    (data.trades || []).forEach((t, idx) => {
      const pnl     = t.realizedPnL || 0;
      const pct     = t.pnlPercent  || 0;
      const pnlClass= t.status === 'OPEN' ? '' : (pnl >= 0 ? 'green' : 'red');
      const pnlStr  = t.status === 'OPEN' ? '<span class="dim">Open</span>' : `<span class="${pnlClass}">${pnl >= 0 ? '+' : ''}$${pnl.toFixed(2)}</span>`;
      const pctStr  = t.status === 'OPEN' ? '—' : `<span class="${pnlClass}">${pct >= 0 ? '+' : ''}${pct.toFixed(2)}%</span>`;
      const sc      = t.strategyConditions || {};
      const gates   = `<span class="${sc.gate1==='PASS'?'green':'red'}">G1</span> <span class="${sc.gate2==='PASS'?'green':'red'}">G2</span> <span class="${sc.gate3==='PASS'?'green':'red'}">G3</span> <span class="${sc.gate4==='PASS'?'green':'red'}">G4</span> <span class="${sc.gate5==='PASS'?'green':'red'}">G5</span> <span class="${sc.gate6==='PASS'?'green':'red'}">G6</span> <span class="${sc.gate7==='PASS'?'green':'red'}">G7</span> | <span class="${sc.gate8==='PASS'?'green':'red'}">G8</span> <span class="${sc.gate9==='PASS'?'green':'red'}">G9</span> <span class="${sc.gate10==='PASS'?'green':'red'}">G10</span>`;
      const dir     = t.direction === 'LONG'
        ? '<span class="dir-long">▲ LONG</span>' : '<span class="dir-short">▼ SHORT</span>';
      const statusBadge = t.status === 'OPEN'
        ? '<span class="badge badge-active">🟢 OPEN</span>'
        : `<span class="dim">${getOutcomeDisplay(t.exitReason)}</span>`;
      tbody.insertAdjacentHTML('beforeend', `<tr>
        <td>${idx + 1}</td>
        <td><strong>${t.symbol}</strong></td>
        <td>${dir}</td>
        <td class="mono">${t.timeframeUsed || '?'}</td>
        <td class="dim">${t.strategyConditions?.trigger || '—'}</td>
        <td style="font-size:0.75rem;">${gates}</td>
        <td>${t.strategyConditions?.scoreAtEntry || '—'}</td>
        <td class="mono">$${formatPrice(t.entryPrice)}</td>
        <td class="time-cell dim">${t.entryTime || '—'}</td>
        <td class="mono">${t.exitPrice ? '$' + formatPrice(t.exitPrice) : '—'}</td>
        <td class="time-cell dim">${t.exitTime || '—'}</td>
        <td>${statusBadge}</td>
        <td>${pnlStr}</td>
        <td>${pctStr}</td>
        <td>${t.status === 'OPEN' ? '<span class="badge badge-active">OPEN</span>' : '<span class="dim">CLOSED</span>'}</td>
      </tr>`);
    });
  } catch (err) {
    showToast('Trade log error: ' + err.message, 'error');
  }
}

function exportTradeLogCSV() {
  fetch('/api/trades/log').then(r => r.json()).then(data => {
    const headers = ['Symbol','Direction','TF','Trigger','Gate1','Gate2','Gate3','Gate4','Score',
      'EntryPrice','EntryTime','ExitPrice','ExitTime','ExitReason','PnL$','PnL%','Status'];
    const rows = (data.trades || []).map(t => {
      const sc = t.strategyConditions || {};
      return [t.symbol, t.direction, t.timeframeUsed, sc.trigger||'',
        sc.gate1, sc.gate2, sc.gate3, sc.gate4, sc.scoreAtEntry||0,
        t.entryPrice, t.entryTime||'', t.exitPrice||'', t.exitTime||'',
        t.exitReason||'', t.realizedPnL||0, t.pnlPercent||0, t.status];
    });
    const csv  = [headers.join(','), ...rows.map(r => r.join(','))].join('\n');
    const blob = new Blob([csv], { type: 'text/csv' });
    const url  = URL.createObjectURL(blob);
    const a    = document.createElement('a'); a.href = url; a.download = 'trade_log.csv'; a.click();
  });
}

// ── Signals ───────────────────────────────────────────────────────

function showWMModal(data) {
  const signal = data.signal, result = data.wmResult;
  const modal  = document.createElement('div');
  modal.className = 'modal-overlay';
  modal.id = 'wm-modal';
  modal.innerHTML = `<div class="modal-box">
    <div class="modal-header amber">🔔 ${result.type} FORMATION CONFIRMED — AUTO-TRADE IN <span id="modal-countdown">10</span>s</div>
    <div>Symbol: <strong>${signal.symbol}</strong> | ${result.type==='W'?'▲ LONG':'▼ SHORT'}</div>
    <div>Break Price: $${formatPrice(signal.wmBreakPrice||signal.signalCandleClose)}</div>
    <div>Score: ${signal.scoreAtSignal}/100</div>
    <div class="modal-buttons">
      <button class="btn-confirm" onclick="confirmWMTrade('${signal.id}')">✅ CONFIRM NOW</button>
      <button class="btn-skip"    onclick="skipWMTrade('${signal.id}')">❌ SKIP TRADE</button>
    </div>
  </div>`;
  document.body.appendChild(modal);
  let countdown = 10;
  const timer = setInterval(() => {
    countdown--;
    const el = document.getElementById('modal-countdown');
    if (el) el.textContent = countdown;
    if (countdown <= 0) { clearInterval(timer); const m = document.getElementById('wm-modal'); if (m) m.remove(); }
  }, 1000);
}

function confirmWMTrade(signalId) {
  sendToBackend('WM_CONFIRM', { signalId });
  const m = document.getElementById('wm-modal'); if (m) m.remove();
  showToast('W/M trade confirmed', 'success');
}

function skipWMTrade(signalId) {
  sendToBackend('WM_SKIP', { signalId });
  const m = document.getElementById('wm-modal'); if (m) m.remove();
  showToast('W/M trade skipped', 'info');
}

async function loadSignals() {
  const dir = document.getElementById('signal-filter-dir')?.value || 'ALL';
  const res = document.getElementById('signal-filter-res')?.value || 'ALL';
  try {
    const r    = await fetch(`/api/signals?direction=${dir}&result=${res}&limit=200`);
    const data = await r.json();
    if (!data.signals) return;
    // Section 3: filter by active market (signals tagged at source; missing market defaults to 'crypto')
    let sigs = data.signals.filter(s => (s.market || 'crypto') === (typeof activeSignalMarket !== 'undefined' ? activeSignalMarket : 'crypto'));
    // Apply result filter client-side for finer control
    if (res === 'FIRED')   sigs = sigs.filter(s => s.tradeFired);
    else if (res === 'SKIPPED') sigs = sigs.filter(s => !s.tradeFired && s.gate1 !== 'FAIL' && s.gate2 !== 'FAIL');
    else if (res === 'FAILED')  sigs = sigs.filter(s => s.gate1 === 'FAIL' || s.gate2 === 'FAIL' || s.gate3 === 'FAIL' || s.gate4 === 'FAIL' || s.gate5 === 'FAIL' || s.gate6 === 'FAIL' || s.gate7 === 'FAIL');
    populateSignalTable(sigs);
  } catch (e) { console.warn('[loadSignals]', e.message); }
}

function populateSignalTable(signals) {
  const tbody = document.getElementById('signals-tbody');
  if (!tbody) return;
  tbody.innerHTML = '';
  signals.forEach((sig, idx) => tbody.insertAdjacentHTML('beforeend', createSignalRow(sig, idx+1)));
}

function createSignalRow(sig, rank) {
  return `<tr>
    <td>${rank}</td>
    <td class="time-cell">${sig.signalCandleCloseDateTimeUTC||'N/A'}</td>
    <td class="time-cell">${sig.dateTimeUTC||'N/A'}</td>
    <td>${(sig.exchange||'binance').toUpperCase()}</td>
    <td><strong>${sig.symbol}</strong></td>
    <td>${sig.timeframe||'4h'}</td>
    <td class="${sig.direction==='LONG'?'green':'red'}">${sig.direction==='LONG'?'▲ LONG':'▼ SHORT'}</td>
    <td>$${formatPrice(sig.ema9)}</td><td>$${formatPrice(sig.ema55)}</td><td>$${formatPrice(sig.ema200)}</td>
    <td>$${formatPrice(sig.signalCandleClose)}</td>
    <td>${sig.adxAtSignal?.toFixed(1)||'N/A'}</td>
    <td>${sig.rsiAtSignal?.toFixed(1)||'N/A'}</td>
    <td>${sig.volumeRatio?.toFixed(1)||'1.0'}×</td>
    <td class="${sig.gate1==='PASS'?'green':'red'}">${sig.gate1==='PASS'?'✅':'❌'}</td>
    <td class="${sig.gate2==='PASS'?'green':'red'}">${sig.gate2==='PASS'?'✅':'❌'}</td>
    <td class="${sig.gate3==='PASS'?'green':'red'}">${sig.gate3==='PASS'?'✅':'❌'}</td>
    <td class="${sig.gate4==='PASS'?'green':'red'}">${sig.gate4==='PASS'?'✅':'❌'}</td>
    <td>${sig.wmPattern||'—'}</td>
    <td>${sig.tradeFired?'🟢 YES':'🔴 NO'}</td>
    <td>${sig.scoreAtSignal}</td>
    <td>$${formatPrice(sig.signalCandleClose)}</td>
    <td>${sig.tradeExitPrice?'$'+formatPrice(sig.tradeExitPrice):'—'}</td>
    <td class="time-cell">${sig.tradeClosedAt||'—'}</td>
    <td>${sig.tradeOutcome||'—'}</td>
    <td class="${(sig.tradePnL||0)>=0?'green':'red'}">${sig.tradePnL!=null?(sig.tradePnL>=0?'+':'')+'$'+sig.tradePnL.toFixed(2):'—'}</td>
    <td class="${(sig.tradePnLPct||0)>=0?'green':'red'}">${sig.tradePnLPct!=null?sig.tradePnLPct.toFixed(2)+'%':'—'}</td>
  </tr>`;
}

function handleNewSignal(signal) {
  showToast(`📡 Signal: ${signal.symbol} ${signal.direction} (Score: ${signal.scoreAtSignal})`, 'info');
  // Section 2: flash the scanner row amber for 2s
  if (typeof flashSignalRow === 'function') flashSignalRow(signal.symbol);
  loadSignals();
}

function updateGateLog(logs) {
  const feed = document.getElementById('gate-log-feed');
  if (feed) feed.innerHTML = logs.map(l => `<div>[${l.timeUTC}] ${l.symbol} → ${l.action} ${l.reason?'('+l.reason+')':''}</div>`).reverse().join('');
}

// ── Multi-market tab handlers ─────────────────────────────────────

function handleMarketScannerUpdate(data) {
  const { market, coins } = data;
  if (!market || !coins) return;
  marketCoins[market] = coins;
  renderMarketTable(market, coins);
  const readyEl = document.getElementById(`${market}-ready-count`);
  if (readyEl) readyEl.textContent = coins.filter(c => c.status === 'READY').length;
  const countEl = document.getElementById(`${market}-coin-count`);
  if (countEl) countEl.textContent = coins.length;
}

function handleMarketTradeOpened(data) {
  const { market, trade } = data;
  if (!market || !trade) return;
  marketTrades[market] = marketTrades[market] || [];
  if (!marketTrades[market].some(t => t.id === trade.id)) marketTrades[market].push(trade);
  const grid = document.getElementById(`${market}-positions-grid`);
  if (grid) grid.insertAdjacentHTML('afterbegin', createMarketTradeCard(market, trade));
  const panel = document.getElementById(`${market}-positions`);
  if (panel) panel.style.display = 'block';
  const countEl = document.getElementById(`${market}-positions-count`);
  if (countEl) countEl.textContent = marketTrades[market].length;
  const tradesEl = document.getElementById(`${market}-trades-count`);
  if (tradesEl) tradesEl.textContent = marketTrades[market].length;
  showToast(`${market.toUpperCase()} Trade: ${trade.symbol} ${trade.direction}`, 'success');
}

function renderMarketTable(marketId, coins) {
  const tbody = document.getElementById(`${marketId}-tbody`);
  if (!tbody) return;
  tbody.innerHTML = '';
  coins.forEach((coin, idx) => {
    const dir       = coin.direction === 'LONG' ? '<span class="dir-long">▲ LONG</span>' : '<span class="dir-short">▼ SHORT</span>';
    const adxClass  = !coin.adx ? 'dim' : coin.adx >= 25 ? 'green' : coin.adx >= 20 ? 'amber' : 'red';
    const rsiClass  = coin.rsi >= 30 && coin.rsi <= 70 ? 'green' : 'amber';
    const volClass  = coin.volumeRatio >= 1.3 ? 'green' : coin.volumeRatio >= 1.0 ? 'amber' : 'dim';
    const statusBadge = coin.status === 'READY'
      ? '<span class="badge badge-active">✅ READY</span>'
      : '<span class="dim">Watching</span>';
    tbody.insertAdjacentHTML('beforeend', `<tr class="${coin.isRanging?'row-ranging':coin.status==='READY'?'row-all-gates':''}">
      <td>${idx+1}</td>
      <td><strong>${coin.displayName || coin.symbol}</strong><br><span class="dim" style="font-size:0.7rem;">${coin.symbol}</span></td>
      <td class="mono">$${formatPrice(coin.price)}</td>
      <td class="${(coin.change24h||0)>=0?'green':'red'}">${(coin.change24h||0)>=0?'+':''}${(coin.change24h||0).toFixed(2)}%</td>
      <td class="${getScoreClass(coin.score)}">${coin.score||'—'}</td>
      <td>${dir}</td>
      <td class="mono dim">${coin.ema9?.toFixed(2)||'—'}</td>
      <td class="mono dim">${coin.ema55?.toFixed(2)||'—'}</td>
      <td class="${coin.emaRelationship==='ABOVE'?'green':'red'}">${coin.emaRelationship||'—'}</td>
      <td class="${adxClass}">${coin.adx?.toFixed(1)||'N/A'}</td>
      <td class="${rsiClass}">${coin.rsi?.toFixed(1)||'N/A'}</td>
      <td class="${volClass}">${coin.volumeRatio?.toFixed(1)||'—'}×</td>
      <td class="${coin.gate1==='PASS'?'green':'red'}">${coin.gate1==='PASS'?'✅':'❌'}</td>
      <td class="${coin.gate2==='PASS'?'green':'red'}">${coin.gate2==='PASS'?'✅':'❌'}</td>
      <td class="${coin.gate3==='PASS'?'green':'red'}">${coin.gate3==='PASS'?'✅':'❌'}</td>
      <td class="${coin.gate4==='PASS'?'green':'red'}">${coin.gate4==='PASS'?'✅':'❌'}</td>
      <td>${statusBadge}</td>
    </tr>`);
  });
}

function createMarketTradeCard(marketId, trade) {
  const dirClass = trade.direction === 'LONG' ? 'dir-long' : 'dir-short';
  return `<div class="trade-card" id="${marketId}-card-${trade.id}" style="border-left-color:var(--blue);">
    <div class="trade-card-header">
      <span class="trade-symbol">${trade.symbol}</span>
      <span class="trade-direction ${dirClass}">${trade.direction==='LONG'?'▲':'▼'} ${trade.direction}</span>
      <span class="trade-trigger">${trade.trigger||''}</span>
      <span class="badge" style="background:var(--blue);">📄 PAPER</span>
    </div>
    <div class="trade-prices">
      <div>Entry: <strong>$${formatPrice(trade.entryPrice)}</strong></div>
      <div>SL: $${formatPrice(trade.stopLoss)} | TP1: $${formatPrice(trade.tp1)}</div>
    </div>
    <div>Score: ${trade.scoreAtEntry}/100 | Pos: $${trade.positionValue}</div>
    <div class="trade-timestamps">${trade.openedAtUTC}</div>
  </div>`;
}

async function triggerMarketScan(marketId) {
  showToast(`Triggering ${marketId.toUpperCase()} scan...`, 'info');
  try {
    const res  = await fetch(`/api/markets/${marketId}/scan-now`, { method: 'POST' });
    const data = await res.json();
    if (data.success) showToast(`${marketId.toUpperCase()} scan complete (${data.coinCount} symbols)`, 'success');
    else showToast(`Scan error: ${data.error}`, 'error');
  } catch (e) {
    showToast('Scan failed: ' + e.message, 'error');
  }
}

// ── Chart overlay ─────────────────────────────────────────────────

async function openChartOverlay(symbol) {
  document.getElementById('chart-symbol-title').textContent = symbol;
  document.getElementById('chart-overlay').style.display = 'flex';
  window.chartOverlayOpen = true;
  const res  = await fetch(`/api/candles?symbol=${symbol}&timeframe=${activeTimeframe}&limit=300`);
  const data = await res.json();
  initMainChart('chart-container', data);
}

function closeChartOverlay() {
  document.getElementById('chart-overlay').style.display = 'none';
  window.chartOverlayOpen = false;
}

// ── Tab navigation ────────────────────────────────────────────────

function setupTabNavigation() {
  document.querySelectorAll('.tab-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
      document.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));
      btn.classList.add('active');
      const tabId = 'tab-' + btn.dataset.tab;
      const tabContent = document.getElementById(tabId);
      if (tabContent) tabContent.classList.add('active');
      if (btn.dataset.tab === 'signals')    loadSignals();
      if (btn.dataset.tab === 'analytics')  loadAnalyticsData();
      if (btn.dataset.tab === 'settings')   { populateSettingsForm(); loadStrategyPresets(); loadExchangeStatus(); }
      if (btn.dataset.tab === 'dashboard')  loadDashboard();
      if (btn.dataset.tab === 'tradelog')   loadTradeLog();
      // Load market data when switching to market tabs
      if (['nse','commodities','nasdaq'].includes(btn.dataset.tab)) {
        loadMarketTab(btn.dataset.tab);
      }
    });
  });
}

async function loadMarketTab(marketId) {
  try {
    const res  = await fetch(`/api/markets/${marketId}`);
    const data = await res.json();
    if (data.coins?.length > 0) {
      marketCoins[marketId] = data.coins;
      renderMarketTable(marketId, data.coins);
      const readyEl = document.getElementById(`${marketId}-ready-count`);
      if (readyEl) readyEl.textContent = data.coins.filter(c => c.status === 'READY').length;
    }
    if (data.heartbeat) handleMarketHeartbeat({ market: marketId, heartbeat: data.heartbeat });
  } catch (err) {
    console.warn(`[${marketId}] Load error:`, err.message);
  }
}

// ── Timeframe / Settings ──────────────────────────────────────────

function setupTimeframeSelector() {
  document.querySelectorAll('.tf-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.tf-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      activeTimeframe = btn.dataset.tf;
      sendToBackend('UPDATE_SETTINGS', { timeframe: activeTimeframe });
      showToast('Timeframe changed to ' + activeTimeframe, 'info');
    });
  });
}

function handleSettingsUpdated(settings) {
  if (!settings) return;
  appSettings = settings;
  if (settings.timeframe) {
    setActiveTimeframe(settings.timeframe);
    const tfSelect = document.getElementById('set-timeframe');
    if (tfSelect) tfSelect.value = settings.timeframe;
  }
  if (settings.autoTradeEnabled !== undefined) {
    const el = document.getElementById('set-autotrade');
    if (el) el.checked = settings.autoTradeEnabled;
  }
  if (settings.scanCoins !== undefined) {
    const el = document.getElementById('set-scancoins');
    if (el) el.value = settings.scanCoins;
  }
  showToast(`⚙️ Settings synced (TF: ${settings.timeframe || activeTimeframe})`, 'info');
}

function setupSettingsHandlers() {
  const saveBtn = document.getElementById('save-settings');
  if (saveBtn) {
    saveBtn.addEventListener('click', async () => {
      const payload = {
        autoTradeEnabled: document.getElementById('set-autotrade')?.checked,
        timeframe: document.getElementById('set-timeframe')?.value,
        strategyEngine: document.getElementById('set-strategyengine')?.value || 'v1',
        scanCoins: parseInt(document.getElementById('set-scancoins')?.value || 50),
        scanIntervalMinutes: parseInt(document.getElementById('set-scaninterval')?.value || 5),
        exchange:  document.getElementById('set-exchange')?.value,
        deltaMode: document.getElementById('set-deltamode')?.value,
        tpPct:    parseFloat(document.getElementById('set-tppct')?.value  || 3.75),
        slPct:    parseFloat(document.getElementById('set-slpct')?.value  || 1.5),
        trade: {
          positionSizePct:    parseFloat(document.getElementById('set-possize')?.value    || 5),
          leverage:           parseInt(document.getElementById('set-leverage')?.value      || 10),
          maxConcurrentTrades:parseInt(document.getElementById('set-maxtrades')?.value    || 3),
          dailyLossCapPct:    parseFloat(document.getElementById('set-dailylosscap')?.value || 5),
          weeklyLossCapPct:   parseFloat(document.getElementById('set-weeklylosscap')?.value || 10),

        },
        telegram: {
          botToken: document.getElementById('set-tgtoken')?.value,
          chatId:   document.getElementById('set-tgchatid')?.value
        }
      };
      sendToBackend('UPDATE_SETTINGS', payload);
      showToast('Settings saved & backend engine synced', 'success');
    });
  }

  const resetBalBtn = document.getElementById('reset-balance');
  if (resetBalBtn) {
    resetBalBtn.addEventListener('click', async () => {
      const res = await fetch('/api/settings', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ resetDemoBalance: true }) });
      const data = await res.json();
      if (data.success) showToast('Demo balance reset to $10,000.00', 'success');
    });
  }

  const tgTestBtn = document.getElementById('test-telegram');
  if (tgTestBtn) {
    tgTestBtn.addEventListener('click', async () => {
      const token  = document.getElementById('set-tgtoken')?.value;
      const chatId = document.getElementById('set-tgchatid')?.value;
      const res    = await fetch('/api/telegram/test', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ botToken: token, chatId }) });
      const data   = await res.json();
      if (data.success) showToast('Telegram test alert sent!', 'success');
      else showToast('Telegram error: ' + data.error, 'error');
    });
  }
}

// ── Debug helpers ─────────────────────────────────────────────────

async function runAPITest() {
  const resEl = document.getElementById('api-test-results');
  if (resEl) resEl.textContent = 'Testing...';
  try {
    const status = await fetch('/api/status').then(r => r.json());
    const hb     = status.scanHeartbeat || {};
    resEl.innerHTML = `✅ Server: ${status.status} (${status.uptimeFormatted})<br>
      ✅ WebSocket: ${status.binanceWSStatus}<br>
      ✅ Rate Limit: ${status.rateLimitUsed}/1200<br>
      ✅ Scan: ${hb.status} (${hb.coinCount||0} coins, ${hb.durationMs||0}ms)<br>
      ✅ Markets: NSE/Commodities/NASDAQ — see /api/markets/status`;
  } catch (e) {
    resEl.innerHTML = `❌ API Test Error: ${e.message}`;
  }
}

async function loadHeartbeatDebug() {
  const resEl = document.getElementById('heartbeat-debug-results');
  try {
    const hb = await fetch('/api/scanner/heartbeat').then(r => r.json());
    resEl.innerHTML = `Status: ${hb.status}<br>Last: ${hb.minutesAgo != null ? hb.minutesAgo + 'm ago' : '—'}<br>Duration: ${hb.durationMs ? (hb.durationMs/1000).toFixed(1)+'s' : '—'}<br>Coins: ${hb.coinCount||0}<br>Error: ${hb.error || 'none'}`;
  } catch (e) {
    resEl.innerHTML = `Error: ${e.message}`;
  }
}

async function triggerScanNow() {
  showToast('⚡ Triggering full market scan...', 'info');
  try {
    const res = await fetch('/api/scanner/scan-now', { method: 'POST' });
    const data = await res.json();
    if (data.success) showToast(`Scan complete (${data.count} coins)`, 'success');
  } catch (e) {
    showToast('Scan error: ' + e.message, 'error');
  }
}

async function fireTestTradeFromUI() {
  showToast('⚡ Firing test trade (BTCUSDT LONG)...', 'info');
  try {
    const res = await fetch('/api/trades/test', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ symbol:'BTCUSDT', direction:'LONG' }) });
    const data = await res.json();
    if (data.success) showToast('✅ Test Trade Fired!', 'success');
  } catch (e) {
    showToast('Failed: ' + e.message, 'error');
  }
}

async function runBacktestJob() {
  const symbol = document.getElementById('bt-symbol')?.value || 'BTCUSDT';
  const tf     = document.getElementById('bt-tf')?.value     || '4h';
  const strat  = document.getElementById('bt-strategy')?.value || 'full';
  document.getElementById('bt-progress-wrapper').style.display = 'block';
  await fetch('/api/backtest', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ symbol, timeframe: tf, strategyType: strat }) });
}

function updateBacktestProgress(data) {
  const bar    = document.getElementById('bt-progress-bar');
  if (bar) bar.style.width = (data.pct || 0) + '%';
  const status = document.getElementById('bt-progress-status');
  if (status) status.textContent = data.message || `Candle ${data.candle||0}/${data.total||0}...`;
}

function showBacktestResults(results) {
  document.getElementById('bt-progress-wrapper').style.display = 'none';
  document.getElementById('bt-results').style.display = 'block';
  const s    = results.summary;
  const grid = document.getElementById('bt-summary-grid');
  if (grid) grid.innerHTML = `<div class="settings-card">
    <div>Period: ${s.period.start} to ${s.period.end}</div>
    <div>Start $10,000 → <strong>$${s.finalBalance}</strong></div>
    <div>Return: <strong class="green">+${s.totalReturn}%</strong></div>
    <div>Win Rate: <strong>${s.winRate}%</strong> (${s.tradesTaken} trades)</div>
    <div>Profit Factor: <strong>${s.profitFactor}</strong></div>
    <div>Max Drawdown: <strong class="red">${s.maxDrawdown}%</strong></div>
  </div>`;
  showToast('Backtest complete!', 'success');
}

async function fireTestTrade() {
  const symbol    = document.getElementById('test-trade-symbol')?.value || 'BTCUSDT';
  const direction = document.getElementById('test-trade-direction')?.value || 'LONG';
  const res  = await fetch('/api/trades/test', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ symbol, direction }) });
  const data = await res.json();
  const resEl = document.getElementById('test-trade-result');
  if (resEl) resEl.textContent = JSON.stringify(data, null, 2);
}

function exportSignalsCSV() {
  fetch('/api/signals?limit=1000').then(r => r.json()).then(data => {
    const headers = ['Symbol','Direction','Timeframe','SignalTime','Gate1','Gate2','Gate3','Gate4','Score','TradeFired','PnL'];
    const rows    = (data.signals || []).map(s => [s.symbol, s.direction, s.timeframe, s.dateTimeUTC, s.gate1, s.gate2, s.gate3, s.gate4, s.scoreAtSignal, s.tradeFired?'YES':'NO', s.tradePnL||0]);
    const csv     = [headers.join(','), ...rows.map(r => r.join(','))].join('\n');
    const blob    = new Blob([csv], { type: 'text/csv' });
    const url     = URL.createObjectURL(blob);
    const a       = document.createElement('a'); a.href = url; a.download = 'signals_export.csv'; a.click();
  });
}

// ── Utilities ─────────────────────────────────────────────────────

function formatPrice(price) {
  if (!price || isNaN(price)) return '0.00';
  if (price >= 1000) return price.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  if (price >= 1)    return price.toFixed(4);
  return price.toFixed(6);
}

function getScoreClass(score) {
  if (!score) return 'score-poor';
  const s = typeof score === 'object' ? score.total : score;
  if (s >= 85) return 'score-elite';
  if (s >= 70) return 'score-strong';
  if (s >= 55) return 'score-moderate';
  if (s >= 40) return 'score-weak';
  return 'score-poor';
}

function renderStatusBadges(coin) {
  const badges = [];
  if (coin.openTrade)          badges.push('<span class="badge badge-active">🟢 TRADE</span>');
  if (coin.wmState === 'READY') badges.push(`<span class="badge badge-wm-ready">⚡ ${coin.wmType} READY</span>`);
  if (coin.wmState === 'FORMING') badges.push(`<span class="badge badge-wm-forming">👀 ${coin.wmType} FORMING</span>`);
  if (coin.isRanging)          badges.push('<span class="badge badge-ranging">🟠 RANGING</span>');
  if (coin.flatSlope)          badges.push('<span class="badge badge-flat">⚠️ FLAT</span>');
  return badges.join('') || '<span class="dim">—</span>';
}

function renderWMBadge(state, type) {
  if (!state || state === 'WATCHING') return '<span class="dim">—</span>';
  const icons   = { FORMING: '👀', READY: '⚡', CONFIRMED: '✅' };
  const classes = { FORMING: 'wm-forming', READY: 'wm-ready', CONFIRMED: 'wm-confirmed' };
  return `<span class="badge ${classes[state]||''}">${icons[state]||''} ${type||''} ${state}</span>`;
}

function getOutcomeDisplay(outcome) {
  const map = { 'TP1':'🎯 TP1','TP2':'🎯 TP2','TP3':'🎯 TP3','SL':'🛡 SL','TRAILING':'🔒 Trail','TIME_EXIT':'⏱ Time','MANUAL':'👋 Manual' };
  return map[outcome] || outcome || '—';
}

function showToast(message, type = 'info', duration = 5000) {
  const container = document.getElementById('toast-container') || (() => {
    const div = document.createElement('div'); div.id = 'toast-container'; document.body.appendChild(div); return div;
  })();
  const toast = document.createElement('div');
  toast.className = 'toast toast-' + type;
  toast.textContent = message;
  container.appendChild(toast);
  setTimeout(() => toast.remove(), duration);
}

function showAlert(data) { showToast(data.message || 'Alert', data.level || 'info'); }

function handleWMStateChange(data) {
  const coin = scannerCoins.find(c => c.symbol === data.symbol);
  if (coin) { coin.wmState = data.state; coin.wmType = data.type; updateScannerRow(coin); }
}

function handleRangingDetected(data) {
  showToast('🟠 Ranging: ' + data.symbol + (data.reason ? ' — ' + data.reason : ''), 'warning');
  const coin = scannerCoins.find(c => c.symbol === data.symbol);
  if (coin) { coin.isRanging = true; updateScannerRow(coin); }
}

function setActiveTimeframe(tf) {
  activeTimeframe = tf;
  document.querySelectorAll('.tf-btn').forEach(btn => btn.classList.toggle('active', btn.dataset.tf === tf));
}

function handleSystemStatus(status) {
  const scanEl = document.getElementById('last-scan-time');
  if (scanEl && status.lastScanTime) scanEl.textContent = status.lastScanTime.split(' ')[1] || status.lastScanTime;
  if (status.binanceConnected !== undefined) updateConnectionBadge(status.binanceConnected ? 'connected' : 'disconnected');
  const openCount = document.getElementById('open-trades-count');
  if (openCount && status.openTradesCount !== undefined) openCount.textContent = status.openTradesCount;
  if (status.scanHeartbeat) handleScanHeartbeat(status.scanHeartbeat);
}

function setupFilterListeners() {
  ['search-coin','filter-direction','filter-status','filter-score'].forEach(id => {
    const el = document.getElementById(id);
    if (el) { el.addEventListener('input', renderScannerTable); el.addEventListener('change', renderScannerTable); }
  });
  ['signal-search','signal-filter-dir','signal-filter-res'].forEach(id => {
    const el = document.getElementById(id);
    if (el) { el.addEventListener('input', filterSignalsTable); el.addEventListener('change', filterSignalsTable); }
  });
}

function filterSignalsTable() {
  const search    = (document.getElementById('signal-search')?.value || '').toLowerCase();
  const dirFilter = document.getElementById('signal-filter-dir')?.value || 'ALL';
  const resFilter = document.getElementById('signal-filter-res')?.value || 'ALL';
  document.querySelectorAll('#signals-tbody tr').forEach(row => {
    const text = row.textContent.toLowerCase();
    row.style.display = (
      (!search || text.includes(search)) &&
      (dirFilter === 'ALL' || text.includes(dirFilter.toLowerCase())) &&
      (resFilter === 'ALL' || (resFilter === 'FIRED' ? text.includes('yes') : resFilter === 'SKIPPED' ? text.includes('no') : true))
    ) ? '' : 'none';
  });
}

function setupTableSorting() {
  document.querySelectorAll('#scanner-table th[data-column]').forEach(th => {
    th.addEventListener('click', () => {
      const col = th.dataset.column;
      if (sortColumn === col) sortDirection = sortDirection === 'asc' ? 'desc' : 'asc';
      else { sortColumn = col; sortDirection = 'desc'; }
      renderScannerTable();
    });
  });
}

async function loadAnalyticsData() {
  try {
    const res  = await fetch('/api/analytics');
    const data = await res.json();
    if (!data) return;
    const cards = document.querySelectorAll('#tab-analytics .settings-card');
    if (cards[0]) cards[0].innerHTML = `<h4>Overview</h4>
      <div>Profit Factor: <strong>${data.profitFactor||0}</strong></div>
      <div>Sharpe Ratio: <strong>${data.sharpeRatio||0}</strong></div>
      <div>Max Drawdown: <strong class="red">${data.maxDrawdown||0}%</strong></div>
      <div>Avg Trade Duration: <strong>${data.avgTradeDuration||'—'}</strong></div>`;
    if (cards[1] && data.byDirection) cards[1].innerHTML = `<h4>Direction Win Rates</h4>
      <div>LONG: <span class="green">${data.byDirection.LONG?.winRate||0}%</span> (${data.byDirection.LONG?.trades||0} trades)</div>
      <div>SHORT: <span class="green">${data.byDirection.SHORT?.winRate||0}%</span> (${data.byDirection.SHORT?.trades||0} trades)</div>`;
    if (cards[2] && data.byTrigger) cards[2].innerHTML = `<h4>Trigger Win Rates</h4>
      <div>4-Gate: <span class="green">${data.byTrigger['4-GATE']?.winRate||0}%</span></div>
      <div>W-Formation: <span class="green">${data.byTrigger['W-FORMATION']?.winRate||0}%</span></div>
      <div>M-Formation: <span class="amber">${data.byTrigger['M-FORMATION']?.winRate||0}%</span></div>`;
  } catch (e) { console.error('[ANALYTICS]', e.message); }
}

function populateSettingsForm() {
  if (!appSettings) return;
  const set = (id, val) => { const el = document.getElementById(id); if (el && val !== undefined && val !== null) { if (el.type === 'checkbox') el.checked = val; else el.value = val; } };
  set('set-autotrade', appSettings.autoTradeEnabled);
  set('set-timeframe',    appSettings.timeframe);
  set('set-strategyengine', appSettings.strategyEngine || (appSettings.activePreset === 'smc-confluence' ? 'v3' : appSettings.activePreset === 'smc-structure' ? 'v2' : 'v1'));
  set('set-scancoins',    appSettings.scanCoins);
  set('set-scaninterval', appSettings.scanIntervalMinutes);
  set('set-exchange',     appSettings.exchange);
  set('set-deltamode',    appSettings.deltaMode);
  set('set-tppct',        appSettings.tpPct);
  set('set-slpct',        appSettings.slPct);
  if (appSettings.trade) {
    set('set-possize',      appSettings.trade.positionSizePct);
    set('set-leverage',     appSettings.trade.leverage);
    set('set-maxtrades',    appSettings.trade.maxConcurrentTrades);
    set('set-dailylosscap', appSettings.trade.dailyLossCapPct);
    set('set-weeklylosscap',appSettings.trade.weeklyLossCapPct);

  }
  if (appSettings.telegram) {
    set('set-tgtoken',  appSettings.telegram.botToken);
    set('set-tgchatid', appSettings.telegram.chatId);
  }
  // Highlight active preset
  document.querySelectorAll('.preset-card').forEach(c => {
    c.classList.toggle('preset-active', c.dataset.presetId === appSettings.activePreset);
  });
}

async function changeStrategyEngine(strategyEngine) {
  try {
    const res = await fetch('/api/settings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ strategyEngine }),
    });
    if (!res.ok) {
      throw new Error(`Server returned HTTP ${res.status}`);
    }
    const contentType = res.headers.get('content-type');
    if (!contentType || !contentType.includes('application/json')) {
      const text = await res.text();
      throw new Error(`Non-JSON response from server: ${text.slice(0, 50)}...`);
    }
    const data = await res.json();
    if (data.success) {
      const engineName = strategyEngine === 'v3' ? 'SMC + Bollinger Confluence (v3)' : strategyEngine === 'v2' ? 'Price Action / SMC (v2)' : '10-Gate EMA + ADX (v1)';
      showToast(`🧠 Strategy Engine switched to: ${engineName}`, 'success', 5000);
    }
  } catch (e) {
    console.error('[STRATEGY ENGINE SWITCH ERROR]', e.message);
    showToast(`❌ Failed to switch strategy engine: ${e.message}`, 'error', 5000);
  }
}

window.toggleRanging = function() {
  const w = document.getElementById('ranging-table-wrapper');
  if (w) w.style.display = (w.style.display === 'none' || !w.style.display) ? 'block' : 'none';
};

// ══════════════════════════════════════════════════════════════
// SECTION 2 — Price animation improvements
// ══════════════════════════════════════════════════════════════

// Per-symbol last-tick timestamp for stale detection
const priceLastTickMs = {};
const STALE_THRESHOLD_MS = 30000; // 30 seconds

// Check for stale prices every 10s
setInterval(() => {
  const now = Date.now();
  Object.entries(priceLastTickMs).forEach(([symbol, lastMs]) => {
    const priceEl = document.getElementById('price-' + symbol);
    if (!priceEl) return;
    const staleEl = priceEl.parentElement?.querySelector('.stale-badge');
    const isStale = (now - lastMs) > STALE_THRESHOLD_MS;
    if (isStale && !staleEl) {
      const badge = document.createElement('span');
      badge.className = 'stale-badge';
      badge.textContent = 'STALE';
      badge.id = 'stale-' + symbol;
      priceEl.after(badge);
    } else if (!isStale && staleEl) {
      staleEl.remove();
    }
  });
}, 10000);

function animatePriceCell(symbol, newPrice, oldPrice) {
  priceLastTickMs[symbol] = Date.now();
  const priceEl = document.getElementById('price-' + symbol);
  if (!priceEl) return;

  // Remove existing stale badge
  document.getElementById('stale-' + symbol)?.remove();

  const prevRendered = parseFloat(priceEl.dataset.price);
  const formatted = '$' + formatPrice(newPrice);
  priceEl.textContent = formatted;
  priceEl.dataset.price = newPrice;

  const compareVal = !isNaN(prevRendered) ? prevRendered : oldPrice;
  if (compareVal && newPrice !== compareVal) {
    const isUp = newPrice > compareVal;
    priceEl.classList.remove('price-flash-up', 'price-flash-down');
    void priceEl.offsetWidth; // reflow
    priceEl.classList.add(isUp ? 'price-flash-up' : 'price-flash-down');
    priceEl.style.color = isUp ? '#00ff88' : '#ff3366';
    setTimeout(() => { priceEl.style.color = ''; }, 600);

    // Arrow indicator
    const existingArrow = priceEl.parentElement?.querySelector('.price-arrow');
    if (existingArrow) existingArrow.remove();
    const arrow = document.createElement('span');
    arrow.className = 'price-arrow';
    arrow.textContent = isUp ? ' ↑' : ' ↓';
    arrow.style.color = isUp ? '#00ff88' : '#ff3366';
    priceEl.after(arrow);
    setTimeout(() => arrow.remove(), 1200);

    // Remove flash class after animation
    setTimeout(() => priceEl.classList.remove('price-flash-up', 'price-flash-down'), 600);
  }
}

// Override handlePriceUpdate to use new animation
const _origHandlePriceUpdate = handlePriceUpdate;
// Patch price update to call animatePriceCell
const _origSchedulePriceBroadcast = null; // WS already batches via backend

// ══════════════════════════════════════════════════════════════
// SECTION 3 — Trading Guard / Kill Switch
// ══════════════════════════════════════════════════════════════

let killSwitchActive = false;
let activeGuardConditions = [];

function handleGuardStateChanged(conditions) {
  activeGuardConditions = Array.isArray(conditions) ? conditions : [];
  killSwitchActive = activeGuardConditions.some(c => c.id === 'kill_switch_active');

  // Update kill switch button appearance
  const btn = document.getElementById('kill-switch-btn');
  if (btn) {
    if (killSwitchActive) {
      btn.textContent = '✅ KILL SWITCH ON — CLICK TO DEACTIVATE';
      btn.classList.add('kill-switch-on');
    } else {
      btn.textContent = '⛔ KILL SWITCH';
      btn.classList.remove('kill-switch-on');
    }
  }

  // Guard badge bar
  const bar    = document.getElementById('guard-badge-bar');
  const inner  = document.getElementById('guard-badges-inner');
  const deactBtn = document.getElementById('kill-switch-deactivate-btn');

  if (!bar || !inner) return;

  if (activeGuardConditions.length === 0) {
    bar.classList.remove('active');
    return;
  }

  bar.classList.add('active');
  if (deactBtn) deactBtn.style.display = killSwitchActive ? 'inline-block' : 'none';

  inner.innerHTML = activeGuardConditions.map(c => {
    const cls = c.id === 'kill_switch_active' ? 'guard-badge-kill'
              : c.id.includes('loss') ? 'guard-badge-warn'
              : 'guard-badge-info';
    const icon = c.id === 'kill_switch_active'    ? '🔴'

               : c.id === 'daily_loss_cap_hit'     ? '🟠'
               : c.id === 'websocket_disconnected' ? '📡'
               : c.id === 'stale_data_active'      ? '⏱'
               : '⚠️';
    return `<span class="guard-badge ${cls}" title="${c.reason || c.label}">${icon} ${c.label}</span>`;
  }).join('');
}

function handleGuardBlocked(data) {
  showToast(`⛔ Trade blocked: ${data.reason || data.condition}${data.symbol ? ' ('+data.symbol+')' : ''}`, 'error', 7000);
}

async function toggleKillSwitch() {
  if (killSwitchActive) {
    await deactivateKillSwitch();
  } else {
    if (!confirm('⛔ ACTIVATE KILL SWITCH?\n\nThis will immediately:\n• Block ALL new trades\n• Close ALL open positions\n• Halt all trade monitoring\n\nAre you sure?')) return;
    await activateKillSwitch();
  }
}

async function activateKillSwitch() {
  try {
    const res  = await fetch('/api/guard/kill-switch/activate', { method: 'POST' });
    const data = await res.json();
    if (data.success) {
      showToast('⛔ Kill switch ACTIVATED — all positions closing', 'error', 8000);
      handleGuardStateChanged([{ id: 'kill_switch_active', label: 'Kill Switch Active', reason: 'Kill switch is ON' }]);
    } else {
      showToast('Kill switch error: ' + data.error, 'error');
    }
  } catch (e) {
    showToast('Failed: ' + e.message, 'error');
  }
}

async function deactivateKillSwitch() {
  try {
    const res  = await fetch('/api/guard/kill-switch/deactivate', { method: 'POST' });
    const data = await res.json();
    if (data.success) {
      showToast('✅ Kill switch deactivated — trading resumed', 'success', 5000);
      handleGuardStateChanged([]);
    } else {
      showToast('Error: ' + data.error, 'error');
    }
  } catch (e) {
    showToast('Failed: ' + e.message, 'error');
  }
}

// Wire into message router (already handled by handleBackendMessage switch above,
// but we add these as a post-load patch since the original switch doesn't have them)
const _origHandleBackendMessage = handleBackendMessage;
window._guardPatched = true;

// ══════════════════════════════════════════════════════════════
// SECTION 2 — WS disconnect banner + scan button disable
// ══════════════════════════════════════════════════════════════

function showWsDisconnectedBanner(show) {
  const banner = document.getElementById('ws-stale-banner');
  if (!banner) return;
  banner.style.display = show ? 'block' : 'none';
  // Disable/enable scan button
  const scanBtn = document.querySelector('button[onclick="triggerScanNow()"]');
  if (scanBtn) {
    scanBtn.disabled = show;
    scanBtn.style.opacity = show ? '0.4' : '1';
    scanBtn.title = show ? 'Live feed disconnected' : '';
  }
}

// Section 2: flash signal row amber for 2s when a new signal fires
function flashSignalRow(symbol) {
  // Flash scanner row
  const row = document.getElementById('row-' + symbol);
  if (row) {
    row.classList.remove('signal-row-flash');
    void row.offsetWidth;
    row.classList.add('signal-row-flash');
    setTimeout(() => row.classList.remove('signal-row-flash'), 2000);
  }
}

// Signal row flash is called from handleNewSignal (patched below)
// WS banner and guard updates are called from updateConnectionBadge (patched below)
// Price animation is called from handlePriceUpdate (patched below)

// ══════════════════════════════════════════════════════════════
// Route new WS events from handleBackendMessage
// ══════════════════════════════════════════════════════════════
// These are injected after the original switch-case handler.
// The original handleBackendMessage has a default case that silently ignores
// unknown types, so we patch it here.
(function patchMessageRouter() {
  const originalHandler = window.handleBackendMessage || handleBackendMessage;
  // Re-assign globally by overriding in this scope's closure.
  // Since app.js runs in a single global script scope, we attach to the module.
  // The actual override happens because all functions here share the same scope.
})();

// Called when WS delivers GUARD_STATE_CHANGED (wired via handleBackendMessage case)
// GUARD_BLOCKED is wired via handleGuardBlocked

// ══════════════════════════════════════════════════════════════
// Load guard status on page load
// ══════════════════════════════════════════════════════════════
setTimeout(async () => {
  try {
    const res  = await fetch('/api/guard/status');
    const data = await res.json();
    handleGuardStateChanged(data.activeConditions || []);
    if (data.killSwitchActive) {
      showToast('⛔ Kill switch is currently ACTIVE', 'error', 8000);
    }
  } catch (e) { /* ignore on load */ }
}, 2000);

// ══════════════════════════════════════════════════════════════
// SECTION 3 — Signal market sub-tabs
// ══════════════════════════════════════════════════════════════

let activeSignalMarket = 'crypto';

function setSignalMarket(mkt) {
  activeSignalMarket = mkt;
  document.querySelectorAll('.signal-mkt-btn').forEach(b => {
    b.classList.toggle('active', b.dataset.mkt === mkt);
  });
  loadSignals();
}

// Market filtering is applied inside the original loadSignals (patched below)

// ══════════════════════════════════════════════════════════════
// SECTION 4 — Strategy preset cards (Settings tab)
// ══════════════════════════════════════════════════════════════

async function loadStrategyPresets() {
  try {
    const res   = await fetch('/api/strategy/presets');
    const data  = await res.json();
    const container = document.getElementById('preset-cards');
    if (!container) return;
    const activeId = appSettings?.activePreset || '';
    container.innerHTML = (data.presets || []).map(p => `
      <div class="preset-card ${p.id === activeId ? 'preset-active' : ''}" data-preset-id="${p.id}">
        <div class="preset-name">${p.name}</div>
        <div class="preset-desc">${p.description}</div>
        <div class="preset-stats">
          <span>Win Rate: <strong>${p.winRate}</strong></span>
          <span>R:R: <strong>${p.rr}</strong></span>
        </div>
        <button class="action-btn preset-apply-btn" onclick="applyPreset('${p.id}')">
          ${p.id === activeId ? '✅ Active' : '▶ Apply'}
        </button>
      </div>
    `).join('');
  } catch (e) { console.warn('[presets]', e.message); }
}

async function applyPreset(presetId) {
  if (!confirm(`Apply strategy preset?\n\nThis will replace ALL current strategy parameters with the "${presetId}" preset settings. This cannot be undone without manually re-entering values.\n\nProceed?`)) return;
  try {
    const res  = await fetch('/api/strategy/preset/apply', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ presetId }),
    });
    if (!res.ok) throw new Error(`Server returned HTTP ${res.status}`);
    const contentType = res.headers.get('content-type');
    if (!contentType || !contentType.includes('application/json')) {
      const text = await res.text();
      throw new Error(`Non-JSON response: ${text.slice(0, 50)}...`);
    }
    const data = await res.json();
    if (data.success) {
      showToast(`✅ Strategy preset "${presetId}" applied — parameters updated`, 'success', 6000);
      // Refresh form with new params
      const settingsRes = await fetch('/api/settings');
      if (settingsRes.ok && settingsRes.headers.get('content-type')?.includes('application/json')) {
        const settingsData = await settingsRes.json();
        if (settingsData.settings) { appSettings = settingsData.settings; populateSettingsForm(); }
      }
      await loadStrategyPresets();
    } else {
      showToast('Error: ' + data.error, 'error');
    }
  } catch (e) { showToast('Failed: ' + e.message, 'error'); }
}

// ══════════════════════════════════════════════════════════════
// SECTION 5 — Dashboard (in-page)
// ══════════════════════════════════════════════════════════════

async function loadDashboard() {
  try {
    const res  = await fetch('/api/analytics/insights');
    const data = await res.json();
    renderDashboardKPIs(data.summary || {});
    renderDashboardEquity(data.equity || []);
    renderDashboardInsights(data.insights || []);
  } catch (e) {
    const container = document.getElementById('dash-insights-list');
    if (container) container.innerHTML = `<p style="color:var(--dim);">Unable to load insights: ${e.message}</p>`;
  }
}

function renderDashboardKPIs(s) {
  const strip = document.getElementById('dash-kpi-strip');
  if (!strip) return;
  const kpis = [
    { label: 'Total Trades', value: s.totalTrades || 0, cls: '' },
    { label: 'Win Rate',     value: (s.winRate || 0) + '%', cls: s.winRate >= 50 ? 'green' : 'amber' },
    { label: 'Total P&L',   value: '$' + (s.totalPnL || 0).toFixed(2), cls: (s.totalPnL || 0) >= 0 ? 'green' : 'red' },
    { label: 'Avg Win',     value: '$' + (s.avgWin || 0).toFixed(2), cls: 'green' },
    { label: 'Avg Loss',    value: '$' + (s.avgLoss || 0).toFixed(2), cls: 'red' },
    { label: 'Best Trade',  value: '$' + (s.bestTrade || 0).toFixed(2), cls: 'green' },
    { label: 'Worst Trade', value: '$' + (s.worstTrade || 0).toFixed(2), cls: 'red' },
    { label: 'Wins / Losses', value: `${s.wins||0} / ${s.losses||0}`, cls: '' },
  ];
  strip.innerHTML = kpis.map(k => `
    <div style="background:var(--card-bg);border:1px solid var(--border);border-radius:8px;padding:12px;text-align:center;">
      <div style="font-size:0.75rem;color:var(--dim);margin-bottom:4px;">${k.label}</div>
      <div style="font-size:1.2rem;font-weight:bold;" class="${k.cls}">${k.value}</div>
    </div>
  `).join('');
}

function renderDashboardEquity(curve) {
  const canvas = document.getElementById('dash-equity-chart');
  const empty  = document.getElementById('dash-equity-empty');
  if (!canvas) return;
  if (!curve || curve.length === 0) {
    canvas.style.display = 'none';
    if (empty) empty.style.display = 'block';
    return;
  }
  canvas.style.display = 'block';
  if (empty) empty.style.display = 'none';
  const ctx = canvas.getContext('2d');
  const w = canvas.offsetWidth || 600;
  const h = canvas.offsetHeight || 80;
  canvas.width = w;
  canvas.height = h;
  const balances = curve.map(p => p.balance);
  const minB = Math.min(...balances);
  const maxB = Math.max(...balances);
  const range = maxB - minB || 1;
  ctx.clearRect(0, 0, w, h);
  // Gradient fill
  const grad = ctx.createLinearGradient(0, 0, 0, h);
  grad.addColorStop(0, 'rgba(0,255,136,0.35)');
  grad.addColorStop(1, 'rgba(0,255,136,0.02)');
  ctx.beginPath();
  curve.forEach((p, i) => {
    const x = (i / (curve.length - 1)) * w;
    const y = h - ((p.balance - minB) / range) * (h - 4);
    i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
  });
  ctx.lineTo(w, h);
  ctx.lineTo(0, h);
  ctx.closePath();
  ctx.fillStyle = grad;
  ctx.fill();
  // Line
  ctx.beginPath();
  curve.forEach((p, i) => {
    const x = (i / (curve.length - 1)) * w;
    const y = h - ((p.balance - minB) / range) * (h - 4);
    i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
  });
  ctx.strokeStyle = '#00ff88';
  ctx.lineWidth = 2;
  ctx.stroke();
}

function renderDashboardInsights(insights) {
  const el = document.getElementById('dash-insights-list');
  if (!el) return;
  if (!insights || insights.length === 0) {
    el.innerHTML = '<p style="color:var(--dim);">No insights yet — trade history is empty.</p>';
    return;
  }
  el.innerHTML = insights.map(txt => `
    <div style="background:rgba(0,255,136,0.06);border-left:3px solid var(--green);padding:10px 14px;border-radius:4px;font-size:0.88rem;">
      💡 ${txt}
    </div>
  `).join('');
}

// ══════════════════════════════════════════════════════════════
// SECTION 6 — Exchange key management (Settings tab)
// ══════════════════════════════════════════════════════════════

async function loadExchangeStatus() {
  try {
    const res  = await fetch('/api/exchange/status');
    const data = await res.json();
    for (const [exchange, info] of Object.entries(data)) {
      const statusEl = document.getElementById(exchange + '-key-status');
      if (statusEl) {
        if (info.configured) {
          statusEl.innerHTML = `<span class="exchange-configured">✅ Configured — Key: ${info.keyHint} | Mode: <strong>${info.mode}</strong> | Updated: ${info.updatedAt?.split('T')[0] || '?'}</span>`;
        } else {
          statusEl.innerHTML = `<span class="exchange-not-configured">⚪ Not configured — enter keys below</span>`;
        }
      }
      const modeEl = document.getElementById(exchange + '-mode') || document.getElementById('set-deltamode');
      if (modeEl && info.mode && exchange !== 'delta') modeEl.value = info.mode;
    }
  } catch (e) { console.warn('[exchange status]', e.message); }
}

async function testExchangeKey(exchange) {
  const keyEl    = document.getElementById(exchange + '-apikey');
  const secretEl = document.getElementById(exchange + '-apisecret');
  const resultEl = document.getElementById(exchange + '-key-result');
  const apiKey    = keyEl?.value?.trim();
  const apiSecret = secretEl?.value?.trim();
  if (!apiKey || !apiSecret) {
    if (resultEl) resultEl.innerHTML = '<span style="color:var(--amber);">Enter API key and secret first.</span>';
    return;
  }
  if (resultEl) resultEl.innerHTML = '<span style="color:var(--dim);">Testing…</span>';
  try {
    const res  = await fetch('/api/exchange/test', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ exchange, apiKey, apiSecret }),
    });
    const data = await res.json();
    if (resultEl) {
      resultEl.innerHTML = data.success
        ? `<span style="color:var(--green);">✅ ${data.message}</span>`
        : `<span style="color:var(--red);">❌ ${data.message}</span>`;
    }
  } catch (e) {
    if (resultEl) resultEl.innerHTML = `<span style="color:var(--red);">❌ ${e.message}</span>`;
  }
}

async function saveExchangeKey(exchange) {
  const keyEl    = document.getElementById(exchange + '-apikey');
  const secretEl = document.getElementById(exchange + '-apisecret');
  const modeEl   = document.getElementById(exchange + '-mode') || (exchange === 'delta' ? document.getElementById('set-deltamode') : null);
  const resultEl = document.getElementById(exchange + '-key-result');
  const apiKey    = keyEl?.value?.trim();
  const apiSecret = secretEl?.value?.trim();
  const mode      = modeEl?.value || 'demo';
  if (!apiKey || !apiSecret) {
    if (resultEl) resultEl.innerHTML = '<span style="color:var(--amber);">Enter both API key and secret.</span>';
    return;
  }
  if (mode === 'live') {
    if (!confirm(`⚠️ LIVE MODE WARNING\n\nYou are about to save LIVE trading keys for ${exchange.toUpperCase()}.\n\nLive mode places REAL orders with REAL money. Make sure you understand the risks.\n\nProceed with LIVE mode?`)) return;
  }
  try {
    const res  = await fetch('/api/exchange/keys', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ exchange, apiKey, apiSecret, mode }),
    });
    const data = await res.json();
    if (data.success) {
      showToast(`✅ ${exchange} keys saved (${mode} mode)`, 'success');
      if (keyEl) keyEl.value = '';
      if (secretEl) secretEl.value = '';
      if (resultEl) resultEl.innerHTML = `<span style="color:var(--green);">✅ Keys saved securely server-side.</span>`;
      await loadExchangeStatus();
    } else {
      if (resultEl) resultEl.innerHTML = `<span style="color:var(--red);">❌ ${data.error}</span>`;
    }
  } catch (e) {
    if (resultEl) resultEl.innerHTML = `<span style="color:var(--red);">❌ ${e.message}</span>`;
  }
}

async function clearExchangeKey(exchange) {
  if (!confirm(`Remove stored API keys for ${exchange.toUpperCase()}?\n\nThis cannot be undone — you'll need to re-enter the keys.`)) return;
  try {
    const res  = await fetch(`/api/exchange/keys/${exchange}`, { method: 'DELETE' });
    const data = await res.json();
    if (data.success) {
      showToast(`🗑 ${exchange} keys cleared`, 'info');
      await loadExchangeStatus();
    }
  } catch (e) { showToast('Failed: ' + e.message, 'error'); }
}
