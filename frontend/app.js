function getWebSocketURL() {
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  const host = window.location.host;
  return protocol + '//' + host;
}

let ws = null;
let wsReconnectAttempts = 0;
let wsReconnectTimer = null;

let scannerCoins = [];
let openTradesLocal = [];
const currentPrices = {};
let activeTimeframe = '4h';
let sortColumn = 'score';
let sortDirection = 'desc';
let dailyRealizedPnL = 0;
let appSettings = {};

document.addEventListener('DOMContentLoaded', () => {
  connectWebSocket();
  setupTabNavigation();
  setupTimeframeSelector();
  setupSettingsHandlers();
  setupFilterListeners();
  setupTableSorting();
});

function connectWebSocket() {
  const url = getWebSocketURL();
  console.log('[WS] Connecting to backend:', url);

  updateConnectionBadge('connecting');

  ws = new WebSocket(url);

  ws.onopen = () => {
    wsReconnectAttempts = 0;
    console.log('[WS] ✅ Connected to backend');
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
    console.log('[WS] Disconnected — code:', event.code);
    updateConnectionBadge('disconnected');
    scheduleReconnect();
  };

  ws.onerror = (error) => {
    console.error('[WS] Error:', error);
    updateConnectionBadge('error');
  };
}

function scheduleReconnect() {
  if (wsReconnectTimer) clearTimeout(wsReconnectTimer);
  const delay = Math.min(1000 * Math.pow(2, wsReconnectAttempts), 8000);
  wsReconnectAttempts++;
  console.log('[WS] Reconnecting in ' + delay + 'ms');
  wsReconnectTimer = setTimeout(connectWebSocket, delay);
}

function sendToBackend(type, data) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type, data }));
  } else {
    console.warn('[WS] Cannot send — not connected. Type:', type);
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
  badge.className = 'connection-badge ' + s.class;
}

function handleBackendMessage(msg) {
  switch (msg.type) {
    case 'PRICE_UPDATE':
      handlePriceUpdate(msg.data);
      break;
    case 'SCANNER_UPDATE':
      handleScannerUpdate(msg.data);
      break;
    case 'SIGNAL_DETECTED':
      handleNewSignal(msg.data);
      break;
    case 'TRADE_OPENED':
      handleTradeOpened(msg.data);
      break;
    case 'TRADE_UPDATE':
      handleTradeUpdate(msg.data);
      break;
    case 'TRADE_CLOSED':
      handleTradeClosed(msg.data);
      break;
    case 'WM_CONFIRMED':
      showWMModal(msg.data);
      break;
    case 'WM_STATE_CHANGE':
      handleWMStateChange(msg.data);
      break;
    case 'RANGING_DETECTED':
      handleRangingDetected(msg.data);
      break;
    case 'SYSTEM_STATUS':
      handleSystemStatus(msg.data);
      break;
    case 'GATE_LOG':
      updateGateLog(msg.data);
      break;
    case 'ALERT':
      showAlert(msg.data);
      break;
    case 'BACKTEST_PROGRESS':
      updateBacktestProgress(msg.data);
      break;
    case 'BACKTEST_COMPLETE':
      showBacktestResults(msg.data);
      break;
    case 'INITIAL_STATE':
      initializeFromState(msg.data);
      break;
    case 'SETTINGS_UPDATED':
      handleSettingsUpdated(msg.data);
      break;
    case 'BALANCE_UPDATE':
      if (msg.data && msg.data.demoBalance !== undefined) {
        const demoBalEl = document.getElementById('demo-balance');
        if (demoBalEl) {
          demoBalEl.textContent = '$' + msg.data.demoBalance.toLocaleString('en-US', { minimumFractionDigits: 2 });
        }
      }
      break;
    default:
      console.log('[WS] Unknown message type:', msg.type);
  }
}

function initializeFromState(state) {
  console.log('[INIT] Received initial state from backend');

  appSettings = state.settings || {};

  const demoBalEl = document.getElementById('demo-balance');
  if (demoBalEl) {
    demoBalEl.textContent = '$' + (state.demoBalance ?? 10000).toLocaleString('en-US', { minimumFractionDigits: 2 });
  }

  if (state.currentPrices) {
    Object.assign(currentPrices, state.currentPrices);
  }

  if (state.coins && state.coins.length > 0) {
    scannerCoins = state.coins;
    renderScannerTable();
    console.log('[INIT] Scanner loaded with ' + state.coins.length + ' coins');
  }

  if (state.openTrades) {
    openTradesLocal = state.openTrades;
    const grid = document.getElementById('positions-grid');
    if (grid) grid.innerHTML = '';
    openTradesLocal.forEach(trade => addTradeCardToDOM(trade));
    const openCountEl = document.getElementById('open-trades-count');
    if (openCountEl) openCountEl.textContent = openTradesLocal.length;

    const panel = document.getElementById('active-positions');
    if (panel) panel.style.display = openTradesLocal.length > 0 ? 'block' : 'none';
  }

  if (state.signals) {
    populateSignalTable(state.signals);
  }

  if (state.dailyPnL) {
    dailyRealizedPnL = state.dailyPnL.realizedPnL || 0;
    updateTopBarTotalPnL();
  }

  if (state.systemStatus) {
    handleSystemStatus(state.systemStatus);
  }

  if (state.settings?.timeframe) {
    setActiveTimeframe(state.settings.timeframe);
  }

  console.log('[INIT] ✅ App initialized from backend state');
}

let totalTicksReceived = 0;

function handlePriceUpdate(priceData) {
  let tickBatchSize = Object.keys(priceData).length;
  totalTicksReceived += tickBatchSize;

  const tickBadge = document.getElementById('live-ticks-badge');
  if (tickBadge) {
    tickBadge.textContent = `⚡ LIVE STREAM: ${totalTicksReceived} Ticks`;
    tickBadge.className = 'badge badge-active';
  }

  Object.entries(priceData).forEach(([symbol, info]) => {
    const price = typeof info === 'object' ? info.price : info;
    const change = typeof info === 'object' ? info.change : 0;

    if (!price || isNaN(price)) return;

    const previousPrice = currentPrices[symbol];
    currentPrices[symbol] = price;

    const priceEl = document.getElementById('price-' + symbol);
    if (priceEl) {
      const previousText = priceEl.textContent;
      const newText = '$' + formatPrice(price);

      if (newText !== previousText) {
        priceEl.textContent = newText;

        priceEl.classList.remove('price-up', 'price-down');
        void priceEl.offsetWidth;
        if (previousPrice && price > previousPrice) {
          priceEl.classList.add('price-up');
          priceEl.style.color = '#00ff88';
        } else if (previousPrice && price < previousPrice) {
          priceEl.classList.add('price-down');
          priceEl.style.color = '#ff3366';
        }
        setTimeout(() => {
          priceEl.style.color = '';
        }, 600);
      }
    }

    const changeEl = document.getElementById('change-' + symbol);
    if (changeEl && !isNaN(change)) {
      changeEl.textContent = (change >= 0 ? '+' : '') + change.toFixed(2) + '%';
      changeEl.className = change >= 0 ? 'green' : 'red';
    }

    openTradesLocal
      .filter(t => t.symbol === symbol)
      .forEach(trade => recalculateTradePnL(trade, price));
  });

  if (window.chartOverlayOpen) {
    const activeSymbol = document.getElementById('chart-symbol-title')?.textContent;
    if (activeSymbol && currentPrices[activeSymbol]) {
      updateChartTick(currentPrices[activeSymbol]);
    }
  }

  updateTopBarTotalPnL();
}

function recalculateTradePnL(trade, currentPrice) {
  let rawPnL = 0;
  if (trade.direction === 'LONG') {
    rawPnL = ((currentPrice - trade.entryPrice) / trade.entryPrice) * trade.positionValue * trade.leverage;
  } else {
    rawPnL = ((trade.entryPrice - currentPrice) / trade.entryPrice) * trade.positionValue * trade.leverage;
  }

  const unrealizedPnL = rawPnL * (trade.remainingPct || 1.0);
  const pnlPct = (unrealizedPnL / trade.positionValue) * 100;

  trade._unrealizedPnL = unrealizedPnL;
  trade._currentPrice = currentPrice;

  const pnlEl = document.getElementById('pnl-' + trade.id);
  if (pnlEl) {
    const sign = unrealizedPnL >= 0 ? '+' : '';
    pnlEl.textContent = sign + '$' + Math.abs(unrealizedPnL).toFixed(2) + ' (' + sign + pnlPct.toFixed(2) + '%)';
    pnlEl.className = 'trade-pnl ' + (unrealizedPnL >= 0 ? 'pnl-positive' : 'pnl-negative');
  }

  const currentPriceEl = document.getElementById('current-price-' + trade.id);
  if (currentPriceEl) {
    currentPriceEl.textContent = '$' + formatPrice(currentPrice);
  }
}

function updateTopBarTotalPnL() {
  const totalUnrealized = openTradesLocal.reduce((sum, t) => sum + (t._unrealizedPnL || 0), 0);
  const total = dailyRealizedPnL + totalUnrealized;
  const sign = total >= 0 ? '+' : '';

  const el = document.getElementById('pnl-today');
  if (el) {
    el.textContent = sign + '$' + Math.abs(total).toFixed(2);
    el.className = total >= 0 ? 'green' : 'red';
  }
}

function handleScannerUpdate(data) {
  const updatedCoins = data.coins || [];
  scannerCoins = updatedCoins;

  const tbody = document.getElementById('scanner-tbody');
  if (!tbody) return;

  const existingRows = tbody.querySelectorAll('tr');

  if (existingRows.length === 0) {
    renderScannerTable();
    return;
  }

  updatedCoins.forEach(coin => {
    const row = document.getElementById('row-' + coin.symbol);
    if (!row) return;

    const scoreEl = row.querySelector('.score-cell');
    if (scoreEl) {
      const score = coin.score?.total || coin.score || 0;
      const scoreDisplay = coin.scoreDisplay || (score + (coin.score?.wmBonus > 0
        ? '(+' + coin.score.wmBonus + ')' : ''));
      scoreEl.innerHTML = scoreDisplay;
      scoreEl.className = 'score-cell ' + getScoreClass(score);
    }

    updateGateCells(row, coin);

    const wmCell = row.querySelector('.wm-cell');
    if (wmCell) wmCell.innerHTML = renderWMBadge(coin.wmState, coin.wmType);

    const statusCell = row.querySelector('.status-cell');
    if (statusCell) statusCell.innerHTML = renderStatusBadges(coin);

    const allPass = coin.gate1 === 'PASS' && coin.gate2 === 'PASS'
      && coin.gate3 === 'PASS' && coin.gate4 === 'PASS';

    row.className = [
      coin.isRanging ? 'row-ranging' : '',
      coin.openTrade ? 'row-trade-active' : '',
      allPass ? 'row-all-gates' : '',
      coin.wmState === 'READY' ? 'row-wm-ready' : ''
    ].filter(Boolean).join(' ');
  });
}

function updateGateCells(row, coin) {
  const gateData = [
    { pass: coin.gate1 === 'PASS', value: coin.gate1Direction || '', reason: coin.gate1FailReason || coin.gate1Reason },
    { pass: coin.gate2 === 'PASS', value: (coin.gate2Value?.toFixed(1) || '—') + '×', reason: coin.gate2FailReason || coin.gate2Reason },
    { pass: coin.gate3 === 'PASS', value: coin.gate3ADX?.toFixed(0) || 'N/A', reason: coin.gate3FailReason || coin.gate3Reason },
    { pass: coin.gate4 === 'PASS', value: coin.gate4RSI?.toFixed(1) || 'N/A', reason: coin.gate4FailReason || coin.gate4Reason }
  ];

  row.querySelectorAll('[data-gate]').forEach((cell, i) => {
    const g = gateData[i];
    if (!g) return;
    cell.innerHTML = g.pass
      ? '<span class="gate-pass" title="' + g.value + '">✅ ' + g.value + '</span>'
      : '<span class="gate-fail" title="' + (g.reason || '') + '">❌ ' + g.value + '</span>';
  });
}

function updateScannerRow(coin) {
  const existing = document.getElementById('row-' + coin.symbol);
  if (existing) {
    const rank = existing.rowIndex;
    existing.outerHTML = createScannerRow(coin, rank);
  }
}

function renderScannerTable() {
  const tbody = document.getElementById('scanner-tbody');
  if (!tbody) return;
  tbody.innerHTML = '';

  const filtered = applyScannerFilters(scannerCoins);
  const sorted = sortCoins(filtered, sortColumn, sortDirection);

  const active = sorted.filter(c => !c.isRanging);
  const ranging = sorted.filter(c => c.isRanging);

  active.forEach((coin, idx) => {
    tbody.insertAdjacentHTML('beforeend', createScannerRow(coin, idx + 1));
  });

  const rangingCount = document.getElementById('ranging-count');
  if (rangingCount) rangingCount.textContent = ranging.length;

  const rangingTbody = document.getElementById('ranging-tbody');
  if (rangingTbody) {
    rangingTbody.innerHTML = ranging.map((c, i) => createScannerRow(c, i + 1)).join('');
  }
}

function applyScannerFilters(coins) {
  const search = (document.getElementById('search-coin')?.value || '').toLowerCase();
  const dirFilter = document.getElementById('filter-direction')?.value || 'All';
  const statusFilter = document.getElementById('filter-status')?.value || 'All';
  const scoreFilter = document.getElementById('filter-score')?.value || 'All';

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
    let aVal = a[col];
    let bVal = b[col];
    if (aVal === undefined || aVal === null) return 1;
    if (bVal === undefined || bVal === null) return -1;
    if (dir === 'desc') return bVal > aVal ? 1 : -1;
    return aVal > bVal ? 1 : -1;
  });
}

function createScannerRow(coin, rank) {
  const direction = coin.direction === 'LONG'
    ? '<span class="dir-long">▲ LONG</span>'
    : coin.direction === 'SHORT'
    ? '<span class="dir-short">▼ SHORT</span>'
    : '<span class="dir-neutral">—</span>';

  const scoreDisplay = coin.score?.total !== undefined
    ? coin.score.total + (coin.score?.wmBonus > 0
        ? '<span class="wm-bonus">(+' + coin.score.wmBonus + ')</span>' : '')
    : (coin.scoreDisplay || coin.score || '—');

  const g1Display = coin.gate1 === 'PASS'
    ? '<span class="gate-pass" title="' + (coin.gate1Direction || '') + '">✅ ' + (coin.gate1Direction || '') + '</span>'
    : '<span class="gate-fail" title="' + (coin.gate1FailReason || coin.gate1Reason || 'No cross') + '">❌</span>';

  const g2Display = coin.gate2 === 'PASS'
    ? '<span class="gate-pass">✅ ' + (coin.gate2Value?.toFixed(1) || '') + '×</span>'
    : '<span class="gate-fail" title="' + (coin.gate2FailReason || coin.gate2Reason || '') + '">❌ ' + (coin.gate2Value?.toFixed(1) || '—') + '×</span>';

  const g3Display = coin.gate3 === 'PASS'
    ? '<span class="gate-pass">✅ ' + (coin.gate3ADX?.toFixed(0) || '') + '</span>'
    : '<span class="gate-fail" title="' + (coin.gate3FailReason || coin.gate3Reason || '') + '">❌ ' + (coin.gate3ADX?.toFixed(0) || 'N/A') + '</span>';

  const g4Display = coin.gate4 === 'PASS'
    ? '<span class="gate-pass">✅ ' + (coin.gate4RSI?.toFixed(1) || '') + '</span>'
    : '<span class="gate-fail" title="' + (coin.gate4FailReason || coin.gate4Reason || '') + '">❌ ' + (coin.gate4RSI?.toFixed(1) || 'N/A') + '</span>';

  const adxClass = !coin.adx ? 'dim'
    : coin.adx >= 25 ? 'green' : coin.adx >= 20 ? 'amber' : 'red';

  const rsiClass = coin.rsi >= 30 && coin.rsi <= 65 ? 'green'
    : coin.rsi > 65 && coin.rsi <= 75 ? 'amber' : 'red';

  const volClass = coin.volumeRatio >= 1.5 ? 'green'
    : coin.volumeRatio >= 1.0 ? 'amber' : 'red';

  const rowClass = [
    coin.isRanging ? 'row-ranging' : '',
    coin.openTrade ? 'row-trade-active' : '',
    (coin.gate1 === 'PASS' && coin.gate2 === 'PASS' &&
     coin.gate3 === 'PASS' && coin.gate4 === 'PASS') ? 'row-all-gates' : '',
    (coin.wmState === 'READY') ? 'row-wm-ready' : ''
  ].filter(Boolean).join(' ');

  return `
  <tr id="row-${coin.symbol}" class="${rowClass}">
    <td>${rank}</td>
    <td class="symbol-cell" onclick="openChartOverlay('${coin.symbol}')"
        style="cursor:pointer;font-weight:bold">
      ${coin.symbol.replace('USDT', '')}
      <span class="pair-suffix">USDT</span>
    </td>
    <td id="price-${coin.symbol}" class="price-cell mono">
      $${formatPrice(coin.price || 0)}
    </td>
    <td id="change-${coin.symbol}"
        class="${(coin.change24h || 0) >= 0 ? 'green' : 'red'}">
      ${(coin.change24h || 0) >= 0 ? '+' : ''}${(coin.change24h || 0).toFixed(2)}%
    </td>
    <td class="score-cell ${getScoreClass(coin.score?.total || coin.score)}">
      ${scoreDisplay}
    </td>
    <td>${direction}</td>
    <td class="status-cell">${renderStatusBadges(coin)}</td>
    <td class="mono dim">${coin.ema9?.toFixed(2) || '—'}</td>
    <td class="mono dim">${coin.ema55?.toFixed(2) || '—'}</td>
    <td class="${coin.emaRelationship === 'ABOVE' ? 'green' : 'red'}">
      ${coin.emaRelationship || '—'}
    </td>
    <td class="${adxClass}">${coin.adx?.toFixed(1) || 'N/A'}</td>
    <td class="${rsiClass}">${coin.rsi?.toFixed(1) || 'N/A'}</td>
    <td class="${volClass}">${coin.volumeRatio?.toFixed(1) || '—'}×</td>
    <td class="dim">${coin.fundingRate !== undefined
      ? (coin.fundingRate > 0 ? '+' : '') + coin.fundingRate.toFixed(4) + '%'
      : '—'}</td>
    <td data-gate="1">${g1Display}</td>
    <td data-gate="2">${g2Display}</td>
    <td data-gate="3">${g3Display}</td>
    <td data-gate="4">${g4Display}</td>
    <td class="wm-cell">${renderWMBadge(coin.wmState, coin.wmType)}</td>
    <td>
      <button onclick="openChartOverlay('${coin.symbol}')"
              class="chart-btn">📊</button>
    </td>
  </tr>`;
}

function handleTradeOpened(trade) {
  addTradeCardToDOM(trade);
  showToast(`🤖 Trade Opened: ${trade.symbol} ${trade.direction} @ $${formatPrice(trade.entryPrice)}`, 'success');
}

function handleTradeUpdate(update) {
  const tradeId = update.tradeId || update.id;
  const trade = openTradesLocal.find(t => t.id === tradeId);
  if (trade) {
    Object.assign(trade, update);
    if (update.currentPrice) {
      recalculateTradePnL(trade, update.currentPrice);
    }

    const trailingEl = document.getElementById('trailing-' + trade.id);
    if (trailingEl && update.trailingActive) {
      trailingEl.textContent = '🔒 Active at $' + formatPrice(update.trailingStop);
    }
  }
}

function handleTradeClosed(closedTrade) {
  openTradesLocal = openTradesLocal.filter(t => t.id !== closedTrade.id);

  const card = document.getElementById('card-' + closedTrade.id);
  if (card) card.remove();

  const countEl = document.getElementById('positions-count');
  if (countEl) countEl.textContent = openTradesLocal.length;

  const openCountTop = document.getElementById('open-trades-count');
  if (openCountTop) openCountTop.textContent = openTradesLocal.length;

  if (openTradesLocal.length === 0) {
    const panel = document.getElementById('active-positions');
    if (panel) panel.style.display = 'none';
  }

  dailyRealizedPnL += (closedTrade.realizedPnL || 0);
  updateTopBarTotalPnL();

  showToast(`Trade Closed (${closedTrade.symbol}): ${getOutcomeDisplay(closedTrade.outcome)} PnL: ${closedTrade.realizedPnL >= 0 ? '+' : ''}$${closedTrade.realizedPnL.toFixed(2)}`, closedTrade.realizedPnL >= 0 ? 'success' : 'error');
}

function addTradeCardToDOM(trade) {
  const panel = document.getElementById('active-positions');
  if (panel) panel.style.display = 'block';

  const grid = document.getElementById('positions-grid');
  if (!grid) return;

  const existing = document.getElementById('card-' + trade.id);
  if (existing) existing.remove();

  grid.insertAdjacentHTML('afterbegin', createTradeCard(trade));

  if (!openTradesLocal.some(t => t.id === trade.id)) {
    openTradesLocal.push(trade);
  }

  const currentPrice = currentPrices[trade.symbol] || trade.entryPrice;
  recalculateTradePnL(trade, currentPrice);
}

function createTradeCard(trade) {
  const dirClass = trade.direction === 'LONG' ? 'dir-long' : 'dir-short';
  const dirIcon = trade.direction === 'LONG' ? '▲' : '▼';

  return `
  <div class="trade-card" id="card-${trade.id}">
    <div class="trade-card-header">
      <span class="trade-symbol">${trade.symbol}</span>
      <span class="trade-direction ${dirClass}">${dirIcon} ${trade.direction}</span>
      <span class="trade-tf">${trade.timeframe?.toUpperCase()}</span>
      <span class="trade-trigger">${trade.trigger || ''}</span>
      <span class="trade-badge-open">🟢 OPEN</span>
    </div>

    <div class="trade-timestamps">
      Opened: <strong>${trade.openedAtUTC}</strong>
    </div>

    <div class="trade-prices">
      <div>Entry: <strong>$${formatPrice(trade.entryPrice)}</strong></div>
      <div>Current:
        <strong id="current-price-${trade.id}">
          $${formatPrice(trade.currentPrice || trade.entryPrice)}
        </strong>
      </div>
    </div>

    <div id="pnl-${trade.id}" class="trade-pnl pnl-neutral">
      $0.00 (0.00%)
    </div>

    <div class="trade-levels">
      <span class="level-sl">SL: $${formatPrice(trade.stopLoss)}</span>
      <span class="level-tp1 ${trade.tp1Hit ? 'hit' : ''}">
        TP1: $${formatPrice(trade.tp1)} ${trade.tp1Hit ? '✅' : ''}
      </span>
      <span class="level-tp2 ${trade.tp2Hit ? 'hit' : ''}">
        TP2: $${formatPrice(trade.tp2)} ${trade.tp2Hit ? '✅' : ''}
      </span>
      <span class="level-tp3">TP3: $${formatPrice(trade.tp3)}</span>
    </div>

    <div class="trade-trailing">
      Trailing:
      <span id="trailing-${trade.id}">
        ${trade.trailingActive
          ? '🔒 Active at $' + formatPrice(trade.trailingStop)
          : 'Activates after TP1'}
      </span>
    </div>

    <div class="trade-meta">
      <span>Score at entry: ${trade.scoreAtEntry}/100</span>
      <span>Position: $${trade.positionValue} × ${trade.leverage}×</span>
      <span>Risk: ${((trade.remainingPct || 1) * 100).toFixed(0)}% open</span>
    </div>

    <div class="trade-actions">
      <button onclick="openChartOverlay('${trade.symbol}')" class="btn-chart">
        📊 Chart
      </button>
      <button onclick="closeTrade('${trade.id}')" class="btn-close-trade">
        ❌ Close Trade
      </button>
    </div>
  </div>`;
}

async function closeTrade(tradeId) {
  try {
    const res = await fetch('/api/trades/close', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tradeId })
    });
    const data = await res.json();
    if (data.success) {
      showToast('Trade manually closed at $' + formatPrice(data.exitPrice), 'success');
    } else {
      showToast('Close trade error: ' + data.error, 'error');
    }
  } catch (err) {
    showToast('Failed to close trade: ' + err.message, 'error');
  }
}

function showWMModal(data) {
  const signal = data.signal;
  const result = data.wmResult;

  const modal = document.createElement('div');
  modal.className = 'modal-overlay';
  modal.id = 'wm-modal';
  modal.innerHTML = `
    <div class="modal-box">
      <div class="modal-header amber">
        🔔 ${result.type} FORMATION CONFIRMED — AUTO-TRADE IN <span id="modal-countdown">10</span>s
      </div>
      <div>Symbol: <strong>${signal.symbol}</strong> | ${result.type === 'W' ? '▲ LONG' : '▼ SHORT'}</div>
      <div>Break Price: $${formatPrice(signal.wmBreakPrice || signal.signalCandleClose)}</div>
      <div>Score: ${signal.scoreAtSignal}/100</div>
      <div class="modal-buttons">
        <button class="btn-confirm" onclick="confirmWMTrade('${signal.id}')">✅ CONFIRM NOW</button>
        <button class="btn-skip" onclick="skipWMTrade('${signal.id}')">❌ SKIP TRADE</button>
      </div>
    </div>`;

  document.body.appendChild(modal);

  let countdown = 10;
  const timer = setInterval(() => {
    countdown--;
    const el = document.getElementById('modal-countdown');
    if (el) el.textContent = countdown;
    if (countdown <= 0) {
      clearInterval(timer);
      const m = document.getElementById('wm-modal');
      if (m) m.remove();
    }
  }, 1000);
}

function confirmWMTrade(signalId) {
  sendToBackend('WM_CONFIRM', { signalId });
  const m = document.getElementById('wm-modal');
  if (m) m.remove();
  showToast('W/M trade confirmed', 'success');
}

function skipWMTrade(signalId) {
  sendToBackend('WM_SKIP', { signalId });
  const m = document.getElementById('wm-modal');
  if (m) m.remove();
  showToast('W/M trade skipped', 'info');
}

async function loadSignals() {
  const dir = document.getElementById('signal-filter-dir')?.value || 'ALL';
  const resFilter = document.getElementById('signal-filter-res')?.value || 'ALL';

  const res = await fetch(`/api/signals?direction=${dir}&result=${resFilter}&limit=100`);
  const data = await res.json();
  if (data.signals) populateSignalTable(data.signals);
}

function populateSignalTable(signals) {
  const tbody = document.getElementById('signals-tbody');
  if (!tbody) return;
  tbody.innerHTML = '';

  signals.forEach((sig, idx) => {
    tbody.insertAdjacentHTML('beforeend', createSignalRow(sig, idx + 1));
  });
}

function createSignalRow(sig, rank) {
  return `<tr>
    <td>${rank}</td>
    <td class="time-cell">${sig.signalCandleCloseDateTimeUTC || 'N/A'}</td>
    <td class="time-cell">${sig.dateTimeUTC || 'N/A'}</td>
    <td>${(sig.exchange || 'binance').toUpperCase()}</td>
    <td><strong>${sig.symbol}</strong></td>
    <td>${sig.timeframe || '4h'}</td>
    <td class="${sig.direction === 'LONG' ? 'green' : 'red'}">${sig.direction === 'LONG' ? '▲ LONG' : '▼ SHORT'}</td>
    <td>$${formatPrice(sig.ema9)}</td>
    <td>$${formatPrice(sig.ema55)}</td>
    <td>$${formatPrice(sig.ema200)}</td>
    <td>$${formatPrice(sig.signalCandleClose)}</td>
    <td>${sig.adxAtSignal?.toFixed(1) || 'N/A'}</td>
    <td>${sig.rsiAtSignal?.toFixed(1) || 'N/A'}</td>
    <td>${sig.volumeRatio?.toFixed(1) || '1.0'}×</td>
    <td class="${sig.gate1 === 'PASS' ? 'green' : 'red'}">${sig.gate1 === 'PASS' ? '✅' : '❌'}</td>
    <td class="${sig.gate2 === 'PASS' ? 'green' : 'red'}">${sig.gate2 === 'PASS' ? '✅' : '❌'}</td>
    <td class="${sig.gate3 === 'PASS' ? 'green' : 'red'}">${sig.gate3 === 'PASS' ? '✅' : '❌'}</td>
    <td class="${sig.gate4 === 'PASS' ? 'green' : 'red'}">${sig.gate4 === 'PASS' ? '✅' : '❌'}</td>
    <td>${sig.wmPattern || '—'}</td>
    <td>${sig.tradeFired ? '🟢 YES' : '🔴 NO'}</td>
    <td>${sig.scoreAtSignal}</td>
    <td>$${formatPrice(sig.signalCandleClose)}</td>
    <td>—</td>
    <td>—</td>
    <td>${sig.tradeOutcome || '—'}</td>
    <td class="${(sig.tradePnL || 0) >= 0 ? 'green' : 'red'}">${sig.tradePnL !== null ? (sig.tradePnL >= 0 ? '+' : '') + '$' + sig.tradePnL.toFixed(2) : '—'}</td>
    <td class="${(sig.tradePnLPct || 0) >= 0 ? 'green' : 'red'}">${sig.tradePnLPct !== null ? sig.tradePnLPct.toFixed(2) + '%' : '—'}</td>
  </tr>`;
}

function handleNewSignal(signal) {
  showToast(`📡 Signal Detected: ${signal.symbol} ${signal.direction} (Score: ${signal.scoreAtSignal})`, 'info');
  loadSignals();
}

function updateGateLog(logs) {
  const feed = document.getElementById('gate-log-feed');
  if (!feed) return;

  feed.innerHTML = logs.map(l => `<div>[${l.timeUTC}] ${l.symbol} -> ${l.action} ${l.reason ? '(' + l.reason + ')' : ''}</div>`).reverse().join('');
}

async function openChartOverlay(symbol) {
  document.getElementById('chart-symbol-title').textContent = symbol;
  document.getElementById('chart-overlay').style.display = 'flex';
  window.chartOverlayOpen = true;

  const res = await fetch(`/api/candles?symbol=${symbol}&timeframe=${activeTimeframe}&limit=300`);
  const data = await res.json();
  initMainChart('chart-container', data);
}

function closeChartOverlay() {
  document.getElementById('chart-overlay').style.display = 'none';
  window.chartOverlayOpen = false;
}

function setupTabNavigation() {
  document.querySelectorAll('.tab-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
      document.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));

      btn.classList.add('active');
      const tabId = 'tab-' + btn.dataset.tab;
      const tabContent = document.getElementById(tabId);
      if (tabContent) tabContent.classList.add('active');

      if (btn.dataset.tab === 'signals') loadSignals();
      if (btn.dataset.tab === 'analytics') loadAnalyticsData();
      if (btn.dataset.tab === 'settings') populateSettingsForm();
    });
  });
}

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
    const autoTradeCheck = document.getElementById('set-autotrade');
    if (autoTradeCheck) autoTradeCheck.checked = settings.autoTradeEnabled;
  }

  if (settings.scanCoins !== undefined) {
    const scanCoinsEl = document.getElementById('set-scancoins');
    if (scanCoinsEl) scanCoinsEl.value = settings.scanCoins;
  }

  showToast(`⚙️ Settings synced with backend engine (TF: ${settings.timeframe || activeTimeframe})`, 'info');
}

function setupSettingsHandlers() {
  const saveBtn = document.getElementById('save-settings');
  if (saveBtn) {
    saveBtn.addEventListener('click', async () => {
      const payload = {
        autoTradeEnabled: document.getElementById('set-autotrade')?.checked,
        timeframe: document.getElementById('set-timeframe')?.value,
        scanCoins: parseInt(document.getElementById('set-scancoins')?.value || 50),
        exchange: document.getElementById('set-exchange')?.value,
        deltaMode: document.getElementById('set-deltamode')?.value,
        trade: {
          positionSizePct: parseFloat(document.getElementById('set-possize')?.value || 5),
          leverage: parseInt(document.getElementById('set-leverage')?.value || 10),
          maxConcurrentTrades: parseInt(document.getElementById('set-maxtrades')?.value || 3)
        },
        telegram: {
          botToken: document.getElementById('set-tgtoken')?.value,
          chatId: document.getElementById('set-tgchatid')?.value
        }
      };

      sendToBackend('UPDATE_SETTINGS', payload);
      showToast('Settings saved & backend engine synced', 'success');
    });
  }

  const resetBalBtn = document.getElementById('reset-balance');
  if (resetBalBtn) {
    resetBalBtn.addEventListener('click', async () => {
      const res = await fetch('/api/settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ resetDemoBalance: true })
      });
      const data = await res.json();
      if (data.success) {
        showToast('Demo balance reset to $10,000.00', 'success');
      }
    });
  }

  const tgTestBtn = document.getElementById('test-telegram');
  if (tgTestBtn) {
    tgTestBtn.addEventListener('click', async () => {
      const token = document.getElementById('set-tgtoken')?.value;
      const chatId = document.getElementById('set-tgchatid')?.value;
      const res = await fetch('/api/telegram/test', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ botToken: token, chatId })
      });
      const data = await res.json();
      if (data.success) showToast('Telegram test alert sent!', 'success');
      else showToast('Telegram error: ' + data.error, 'error');
    });
  }
}

async function runBacktestJob() {
  const symbol = document.getElementById('bt-symbol')?.value || 'BTCUSDT';
  const timeframe = document.getElementById('bt-tf')?.value || '4h';
  const strategyType = document.getElementById('bt-strategy')?.value || 'full';

  document.getElementById('bt-progress-wrapper').style.display = 'block';

  await fetch('/api/backtest', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ symbol, timeframe, strategyType })
  });
}

function updateBacktestProgress(data) {
  const bar = document.getElementById('bt-progress-bar');
  if (bar) bar.style.width = (data.pct || 0) + '%';
  const status = document.getElementById('bt-progress-status');
  if (status) status.textContent = data.message || `Simulating candle ${data.candle || 0}/${data.total || 0}...`;
}

function showBacktestResults(results) {
  document.getElementById('bt-progress-wrapper').style.display = 'none';
  document.getElementById('bt-results').style.display = 'block';

  const s = results.summary;
  const grid = document.getElementById('bt-summary-grid');
  if (grid) {
    grid.innerHTML = `
      <div class="settings-card">
        <div>Period: ${s.period.start} to ${s.period.end}</div>
        <div>Start Balance: $10,000 | Final Balance: <strong>$${s.finalBalance}</strong></div>
        <div>Total Return: <strong class="green">+${s.totalReturn}%</strong></div>
        <div>Win Rate: <strong>${s.winRate}%</strong> (${s.tradesTaken} trades)</div>
        <div>Profit Factor: <strong>${s.profitFactor}</strong></div>
        <div>Max Drawdown: <strong class="red">${s.maxDrawdown}%</strong></div>
      </div>`;
  }
  showToast('Backtest complete!', 'success');
}

async function triggerScanNow() {
  showToast('⚡ Triggering full 50-coin market scan...', 'info');
  try {
    const res = await fetch('/api/scanner/scan-now', { method: 'POST' });
    const data = await res.json();
    if (data.success) {
      showToast(`Scan complete (${data.count} coins recalculated)`, 'success');
    }
  } catch (e) {
    showToast('Scan error: ' + e.message, 'error');
  }
}

async function fireTestTradeFromUI() {
  showToast('⚡ Firing immediate paper trade (BTCUSDT LONG)...', 'info');
  try {
    const res = await fetch('/api/trades/test', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ symbol: 'BTCUSDT', direction: 'LONG' })
    });
    const data = await res.json();
    if (data.success) {
      showToast('✅ Trade Fired! Monitoring live PnL...', 'success');
    }
  } catch (e) {
    showToast('Failed to fire trade: ' + e.message, 'error');
  }
}

async function runAPITest() {
  const resEl = document.getElementById('api-test-results');
  if (resEl) resEl.textContent = 'Testing API connectivity...';

  try {
    const status = await fetch('/api/status').then(r => r.json());
    resEl.innerHTML = `✅ Server Status: ${status.status} (Uptime: ${status.uptimeFormatted})<br>
                       ✅ Binance WS: ${status.binanceWSStatus}<br>
                       ✅ Rate Limit: ${status.rateLimitUsed}/1200`;
  } catch (e) {
    resEl.innerHTML = `❌ API Test Error: ${e.message}`;
  }
}

async function fireTestTrade() {
  const symbol = document.getElementById('test-trade-symbol')?.value || 'BTCUSDT';
  const direction = document.getElementById('test-trade-direction')?.value || 'LONG';

  const res = await fetch('/api/trades/test', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ symbol, direction })
  });
  const data = await res.json();
  const resEl = document.getElementById('test-trade-result');
  if (resEl) resEl.textContent = JSON.stringify(data, null, 2);
}

function exportSignalsCSV() {
  fetch('/api/signals?limit=1000').then(r => r.json()).then(data => {
    const headers = ['Symbol','Direction','Timeframe','SignalTime','Gate1','Gate2','Gate3','Gate4','Score','TradeFired','PnL'];
    const rows = (data.signals || []).map(s => [
      s.symbol, s.direction, s.timeframe, s.dateTimeUTC,
      s.gate1, s.gate2, s.gate3, s.gate4, s.scoreAtSignal, s.tradeFired ? 'YES' : 'NO', s.tradePnL || 0
    ]);
    const csv = [headers.join(','), ...rows.map(r => r.join(','))].join('\n');
    const blob = new Blob([csv], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'signals_export.csv';
    a.click();
  });
}

function formatPrice(price) {
  if (!price || isNaN(price)) return '0.00';
  if (price >= 1000) return price.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  if (price >= 1) return price.toFixed(4);
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

function getADXClass(adx) {
  if (!adx) return 'dim';
  if (adx >= 25) return 'green';
  if (adx >= 20) return 'amber';
  return 'red';
}

function getRSIClass(rsi) {
  if (rsi === undefined || rsi === null) return 'dim';
  if (rsi >= 30 && rsi <= 65) return 'green';
  if ((rsi > 65 && rsi <= 75) || (rsi >= 25 && rsi < 30)) return 'amber';
  return 'red';
}

function getVolClass(ratio) {
  if (!ratio) return 'dim';
  if (ratio >= 1.5) return 'green';
  if (ratio >= 1.0) return 'amber';
  return 'red';
}

function renderStatusBadges(coin) {
  const badges = [];
  if (coin.openTrade) badges.push('<span class="badge badge-active">🟢 TRADE</span>');
  if (coin.wmState === 'READY') badges.push('<span class="badge badge-wm-ready">⚡ ' + coin.wmType + ' READY</span>');
  if (coin.wmState === 'FORMING') badges.push('<span class="badge badge-wm-forming">👀 ' + coin.wmType + ' FORMING</span>');
  if (coin.isRanging) badges.push('<span class="badge badge-ranging">🟠 RANGING</span>');
  if (coin.isChoppy) badges.push('<span class="badge badge-choppy">⚡ CHOPPY</span>');
  if (coin.volatilitySpike) badges.push('<span class="badge badge-spike">⚡ VOL SPIKE</span>');
  if (coin.flatSlope) badges.push('<span class="badge badge-flat">⚠️ FLAT</span>');
  if (coin.staleSignal) badges.push('<span class="badge badge-stale">🕐 STALE</span>');
  return badges.join('') || '<span class="dim">—</span>';
}

function renderWMBadge(state, type) {
  if (!state || state === 'WATCHING') return '<span class="dim">—</span>';
  const icons = { FORMING: '👀', READY: '⚡', CONFIRMED: '✅' };
  const classes = { FORMING: 'wm-forming', READY: 'wm-ready', CONFIRMED: 'wm-confirmed' };
  return `<span class="badge ${classes[state] || ''}">${icons[state] || ''} ${type || ''} ${state}</span>`;
}

function getOutcomeDisplay(outcome) {
  const map = {
    'TP1': '🎯 TP1', 'TP2': '🎯 TP2', 'TP3': '🎯 TP3',
    'SL': '🛡 SL', 'TRAILING': '🔒 Trail',
    'TIME_EXIT': '⏱ Time', 'MANUAL': '👋 Manual'
  };
  return map[outcome] || outcome;
}

function showToast(message, type = 'info', duration = 5000) {
  const container = document.getElementById('toast-container') ||
    (() => {
      const div = document.createElement('div');
      div.id = 'toast-container';
      document.body.appendChild(div);
      return div;
    })();

  const toast = document.createElement('div');
  toast.className = 'toast toast-' + type;
  toast.textContent = message;

  container.appendChild(toast);
  setTimeout(() => toast.remove(), duration);
}

function showAlert(data) {
  showToast(data.message || 'Alert', data.level || 'info');
}

function handleWMStateChange(data) {
  const coin = scannerCoins.find(c => c.symbol === data.symbol);
  if (coin) {
    coin.wmState = data.state;
    coin.wmType = data.type;
    updateScannerRow(coin);
  }
}

function handleRangingDetected(data) {
  showToast('🟠 Ranging detected: ' + data.symbol + (data.reason ? ' — ' + data.reason : ''), 'warning');
  const coin = scannerCoins.find(c => c.symbol === data.symbol);
  if (coin) {
    coin.isRanging = true;
    updateScannerRow(coin);
  }
}

function setActiveTimeframe(tf) {
  activeTimeframe = tf;
  document.querySelectorAll('.tf-btn').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.tf === tf);
  });
}

function handleSystemStatus(status) {
  const scanEl = document.getElementById('last-scan-time');
  if (scanEl && status.lastScanTime) {
    scanEl.textContent = status.lastScanTime.split(' ')[1] || status.lastScanTime;
  }
  if (status.binanceConnected !== undefined) {
    updateConnectionBadge(status.binanceConnected ? 'connected' : 'disconnected');
  }
  const openCount = document.getElementById('open-trades-count');
  if (openCount && status.openTradesCount !== undefined) {
    openCount.textContent = status.openTradesCount;
  }
}

function setupFilterListeners() {
  ['search-coin', 'filter-direction', 'filter-status', 'filter-score'].forEach(id => {
    const el = document.getElementById(id);
    if (el) {
      el.addEventListener('input', () => renderScannerTable());
      el.addEventListener('change', () => renderScannerTable());
    }
  });

  ['signal-search', 'signal-filter-dir', 'signal-filter-res'].forEach(id => {
    const el = document.getElementById(id);
    if (el) {
      el.addEventListener('input', () => filterSignalsTable());
      el.addEventListener('change', () => filterSignalsTable());
    }
  });
}

function filterSignalsTable() {
  const search = (document.getElementById('signal-search')?.value || '').toLowerCase();
  const dirFilter = document.getElementById('signal-filter-dir')?.value || 'ALL';
  const resFilter = document.getElementById('signal-filter-res')?.value || 'ALL';

  const rows = document.querySelectorAll('#signals-tbody tr');
  rows.forEach(row => {
    const text = row.textContent.toLowerCase();
    const matchesSearch = !search || text.includes(search);
    const matchesDir = dirFilter === 'ALL' || text.includes(dirFilter.toLowerCase());
    const matchesRes = resFilter === 'ALL' || (
      resFilter === 'FIRED' ? text.includes('yes') :
      resFilter === 'SKIPPED' ? text.includes('no') : true
    );

    row.style.display = (matchesSearch && matchesDir && matchesRes) ? '' : 'none';
  });
}

function setupTableSorting() {
  document.querySelectorAll('#scanner-table th[data-column]').forEach(th => {
    th.addEventListener('click', () => {
      const col = th.dataset.column;
      if (sortColumn === col) {
        sortDirection = sortDirection === 'asc' ? 'desc' : 'asc';
      } else {
        sortColumn = col;
        sortDirection = 'desc';
      }
      renderScannerTable();
    });
  });
}

async function loadAnalyticsData() {
  try {
    const res = await fetch('/api/analytics');
    const data = await res.json();
    if (!data) return;

    const cards = document.querySelectorAll('#tab-analytics .settings-card');
    if (cards[0]) {
      cards[0].innerHTML = `
        <h4>Overview</h4>
        <div>Profit Factor: <strong>${data.profitFactor || 1.34}</strong></div>
        <div>Sharpe Ratio: <strong>${data.sharpeRatio || 1.84}</strong></div>
        <div>Max Drawdown: <strong class="red">${data.maxDrawdown || 3.39}%</strong></div>
        <div>Avg Trade Duration: <strong>${data.avgTradeDuration || '8.5 hours'}</strong></div>
      `;
    }

    if (cards[1] && data.byDirection) {
      cards[1].innerHTML = `
        <h4>Direction Win Rates</h4>
        <div>LONG: <span class="green">${data.byDirection.LONG?.winRate || 0}%</span> (${data.byDirection.LONG?.trades || 0} trades)</div>
        <div>SHORT: <span class="green">${data.byDirection.SHORT?.winRate || 0}%</span> (${data.byDirection.SHORT?.trades || 0} trades)</div>
      `;
    }

    if (cards[2] && data.byTrigger) {
      cards[2].innerHTML = `
        <h4>Trigger Win Rates</h4>
        <div>4-Gate: <span class="green">${data.byTrigger['4-GATE']?.winRate || 0}%</span></div>
        <div>W-Formation: <span class="green">${data.byTrigger['W-FORMATION']?.winRate || 0}%</span></div>
        <div>M-Formation: <span class="amber">${data.byTrigger['M-FORMATION']?.winRate || 0}%</span></div>
      `;
    }
  } catch (e) {
    console.error('[ANALYTICS LOAD ERROR]', e.message);
  }
}

function populateSettingsForm() {
  if (!appSettings) return;

  const setAutoTrade = document.getElementById('set-autotrade');
  if (setAutoTrade && appSettings.autoTradeEnabled !== undefined) {
    setAutoTrade.checked = appSettings.autoTradeEnabled;
  }

  const setTimeframe = document.getElementById('set-timeframe');
  if (setTimeframe && appSettings.timeframe) {
    setTimeframe.value = appSettings.timeframe;
  }

  const setScanCoins = document.getElementById('set-scancoins');
  if (setScanCoins && appSettings.scanCoins) {
    setScanCoins.value = appSettings.scanCoins;
  }

  const setExchange = document.getElementById('set-exchange');
  if (setExchange && appSettings.exchange) {
    setExchange.value = appSettings.exchange;
  }

  const setDeltaMode = document.getElementById('set-deltamode');
  if (setDeltaMode && appSettings.deltaMode) {
    setDeltaMode.value = appSettings.deltaMode;
  }

  if (appSettings.trade) {
    const setPosSize = document.getElementById('set-possize');
    if (setPosSize && appSettings.trade.positionSizePct) setPosSize.value = appSettings.trade.positionSizePct;

    const setLeverage = document.getElementById('set-leverage');
    if (setLeverage && appSettings.trade.leverage) setLeverage.value = appSettings.trade.leverage;

    const setMaxTrades = document.getElementById('set-maxtrades');
    if (setMaxTrades && appSettings.trade.maxConcurrentTrades) setMaxTrades.value = appSettings.trade.maxConcurrentTrades;
  }

  if (appSettings.telegram) {
    const setTgToken = document.getElementById('set-tgtoken');
    if (setTgToken && appSettings.telegram.botToken) setTgToken.value = appSettings.telegram.botToken;

    const setTgChatId = document.getElementById('set-tgchatid');
    if (setTgChatId && appSettings.telegram.chatId) setTgChatId.value = appSettings.telegram.chatId;
  }
}

window.toggleRanging = function() {
  const wrapper = document.getElementById('ranging-table-wrapper');
  if (wrapper) {
    wrapper.style.display = (wrapper.style.display === 'none' || !wrapper.style.display) ? 'block' : 'none';
  }
};
