/**
 * TradingGuard — checks all 9 block conditions before any trade entry.
 * If ANY condition is active, returns { blocked: true, reason, condition }.
 * All block events are logged to data/guard_log.json.
 */

const fs      = require('fs').promises;
const path    = require('path');

const GUARD_STATE_FILE = path.join(__dirname, '..', 'data', 'guard_state.json');
const GUARD_LOG_FILE   = path.join(__dirname, '..', 'data', 'guard_log.json');

const MAX_LOG_ENTRIES = 500;

// In-memory state that supplements persisted state
let guardState = {
  killSwitchActive:      false,
  dbWriteFailed:         false,
  wsDisconnected:        false,
  exchangeUnreachable:   false,
  stalePriceSymbols:     {},        // symbol → lastUpdateMs
  lastPriceUpdateMs:     Date.now(),
};

// These come in from scanner/server at runtime
let settingsRef     = {};
let openTradesRef   = [];  // reference — updated externally
let broadcastFn     = () => {};

const CONDITION_LABELS = {
  stale_data_active:       'Stale Data',
  websocket_disconnected:  'WebSocket Disconnected',
  reconciliation_required: 'Reconciliation Required',
  kill_switch_active:      'Kill Switch Active',
  daily_loss_cap_hit:      'Daily Loss Cap Hit',
  weekly_loss_cap_hit:     'Weekly Loss Cap Hit',
  cooldown_active:         'Cooldown Active',
  database_write_failed:   'DB Write Failed',
  exchange_unreachable:    'Exchange Unreachable',
};

// ── Persist / load ────────────────────────────────────────────────

async function loadGuardState() {
  try {
    const raw = await fs.readFile(GUARD_STATE_FILE, 'utf-8');
    const saved = JSON.parse(raw);
    // Merge persisted fields into in-memory state
    guardState.killSwitchActive = saved.killSwitchActive ?? false;
    guardState.lastCooldownTradeMs = saved.lastCooldownTradeMs || null;
    guardState.weeklyPnLStart     = saved.weeklyPnLStart     || null;
    guardState.weeklyPnLBaseline  = saved.weeklyPnLBaseline  || 0;
  } catch (e) {
    // File missing is fine on first run
  }
}

async function saveGuardState() {
  try {
    const toSave = {
      killSwitchActive:     guardState.killSwitchActive,
      lastCooldownTradeMs:  guardState.lastCooldownTradeMs || null,
      weeklyPnLStart:       guardState.weeklyPnLStart     || null,
      weeklyPnLBaseline:    guardState.weeklyPnLBaseline  || 0,
      savedAt:              new Date().toISOString(),
    };
    await fs.writeFile(GUARD_STATE_FILE, JSON.stringify(toSave, null, 2), 'utf-8');
  } catch (e) {
    console.error('[GUARD] Failed to save guard state:', e.message);
  }
}

async function appendGuardLog(entry) {
  try {
    let logs = [];
    try {
      const raw = await fs.readFile(GUARD_LOG_FILE, 'utf-8');
      logs = JSON.parse(raw);
    } catch (e) { /* first entry */ }
    if (!Array.isArray(logs)) logs = [];
    logs.unshift(entry);
    if (logs.length > MAX_LOG_ENTRIES) logs = logs.slice(0, MAX_LOG_ENTRIES);
    await fs.writeFile(GUARD_LOG_FILE, JSON.stringify(logs, null, 2), 'utf-8');
  } catch (e) {
    console.error('[GUARD] Failed to write guard log:', e.message);
  }
}

async function loadGuardLog(limit = 100) {
  try {
    const raw = await fs.readFile(GUARD_LOG_FILE, 'utf-8');
    const logs = JSON.parse(raw);
    return Array.isArray(logs) ? logs.slice(0, limit) : [];
  } catch (e) {
    return [];
  }
}

// ── Setters called by server.js ───────────────────────────────────

function setSettings(settings) { settingsRef = settings; }
function setOpenTrades(trades)  { openTradesRef = trades; }
function setBroadcast(fn)       { broadcastFn = fn; }

function notifyWebSocketStatus(connected) {
  guardState.wsDisconnected = !connected;
}

function notifyDbWriteStatus(failed) {
  guardState.dbWriteFailed = failed;
}

function notifyExchangeStatus(reachable) {
  guardState.exchangeUnreachable = !reachable;
}

function notifyPriceTick(symbol) {
  guardState.stalePriceSymbols[symbol] = Date.now();
  guardState.lastPriceUpdateMs = Date.now();
}

// Called by finishCloseTrade in scanner when a loss trade closes
function recordLossTrade() {
  guardState.lastCooldownTradeMs = Date.now();
  saveGuardState().catch(() => {});
}

function recordWeeklyBaseline(balance) {
  const now  = new Date();
  const startOfWeek = new Date(now);
  startOfWeek.setHours(0, 0, 0, 0);
  startOfWeek.setDate(now.getDate() - now.getDay()); // Sunday
  const weekKey = startOfWeek.toISOString().split('T')[0];
  if (guardState.weeklyPnLStart !== weekKey) {
    guardState.weeklyPnLStart    = weekKey;
    guardState.weeklyPnLBaseline = balance;
    saveGuardState().catch(() => {});
  }
}

// ── Kill switch ───────────────────────────────────────────────────

async function activateKillSwitch() {
  guardState.killSwitchActive = true;
  await saveGuardState();
  await logBlockEvent('kill_switch_active', null, { manual: true });
  broadcastFn('GUARD_STATE_CHANGED', getActiveConditions());
  broadcastFn('ALERT', { level: 'critical', message: '🔴 KILL SWITCH ACTIVATED — all trading halted' });
  console.log('[GUARD] ⛔ Kill switch ACTIVATED');
}

async function deactivateKillSwitch() {
  guardState.killSwitchActive = false;
  await saveGuardState();
  broadcastFn('GUARD_STATE_CHANGED', getActiveConditions());
  broadcastFn('ALERT', { level: 'success', message: '✅ Kill switch deactivated — trading resumed' });
  console.log('[GUARD] ✅ Kill switch DEACTIVATED');
}

function isKillSwitchActive() {
  return guardState.killSwitchActive;
}

// ── Condition evaluators ──────────────────────────────────────────

function checkStaleData() {
  const staleThresholdMs = 60 * 1000; // 60 seconds
  const ageMsAgo         = Date.now() - guardState.lastPriceUpdateMs;
  return ageMsAgo > staleThresholdMs;
}

function checkWsDisconnected() {
  return guardState.wsDisconnected === true;
}

function checkKillSwitch() {
  return guardState.killSwitchActive === true;
}

function checkDailyLossCap(currentDailyPnL, balance) {
  const capPct = settingsRef.trade?.dailyLossLimitPct || settingsRef.dailyLossCapPct || 5;
  const cap    = balance * (capPct / 100);
  return currentDailyPnL < 0 && Math.abs(currentDailyPnL) >= cap;
}

function checkWeeklyLossCap(balance) {
  const capPct   = settingsRef.weeklyLossCapPct || 10;
  const baseline = guardState.weeklyPnLBaseline || balance;
  const loss     = balance - baseline;
  const cap      = baseline * (capPct / 100);
  return loss < 0 && Math.abs(loss) >= cap;
}

function checkCooldown() {
  const cooldownMinutes = settingsRef.cooldownMinutes || 30;
  const lastLossMs      = guardState.lastCooldownTradeMs;
  if (!lastLossMs) return false;
  const elapsed = Date.now() - lastLossMs;
  return elapsed < cooldownMinutes * 60 * 1000;
}

function cooldownRemainingMs() {
  const cooldownMs = (settingsRef.cooldownMinutes || 30) * 60 * 1000;
  const lastLossMs = guardState.lastCooldownTradeMs;
  if (!lastLossMs) return 0;
  const remaining = cooldownMs - (Date.now() - lastLossMs);
  return remaining > 0 ? remaining : 0;
}

function checkDbWriteFailed() {
  return guardState.dbWriteFailed === true;
}

function checkExchangeUnreachable() {
  return guardState.exchangeUnreachable === true;
}

// reconciliation_required: open trades in memory vs. known from storage diverged
// For now, flagged externally if deltaExchange positions don't match
let reconciliationRequired = false;
function setReconciliationRequired(val) { reconciliationRequired = val; }
function checkReconciliationRequired()  { return reconciliationRequired; }

// ── Main check ────────────────────────────────────────────────────

/**
 * @param {object} context - { dailyPnL, balance }
 * @returns {{ blocked: boolean, reason?: string, condition?: string, badges: array }}
 */
function checkAllConditions(context = {}) {
  const { dailyPnL = 0, balance = 10000 } = context;

  const checks = [
    { id: 'kill_switch_active',      active: checkKillSwitch() },
    { id: 'websocket_disconnected',  active: checkWsDisconnected() },
    { id: 'stale_data_active',       active: checkStaleData() },
    { id: 'database_write_failed',   active: checkDbWriteFailed() },
    { id: 'exchange_unreachable',    active: checkExchangeUnreachable() },
    { id: 'daily_loss_cap_hit',      active: checkDailyLossCap(dailyPnL, balance) },
    { id: 'weekly_loss_cap_hit',     active: checkWeeklyLossCap(balance) },
    { id: 'cooldown_active',         active: checkCooldown() },
    { id: 'reconciliation_required', active: checkReconciliationRequired() },
  ];

  const activeConditions = checks.filter(c => c.active);

  if (activeConditions.length > 0) {
    const first = activeConditions[0];
    return {
      blocked:    true,
      condition:  first.id,
      reason:     buildReason(first.id),
      allBlocked: activeConditions.map(c => ({ id: c.id, label: CONDITION_LABELS[c.id] || c.id, reason: buildReason(c.id) })),
    };
  }

  return { blocked: false, allBlocked: [] };
}

function buildReason(conditionId) {
  switch (conditionId) {
    case 'kill_switch_active':     return 'Kill switch is ON — all trading halted';
    case 'websocket_disconnected': return 'WebSocket is disconnected — price feed unreliable';
    case 'stale_data_active':      return `Last price update was ${Math.round((Date.now() - guardState.lastPriceUpdateMs)/1000)}s ago (>60s threshold)`;
    case 'database_write_failed':  return 'Last DB write failed — refusing to trade on bad state';
    case 'exchange_unreachable':   return 'Exchange API health check failed';
    case 'daily_loss_cap_hit':     return `Daily loss cap hit (${settingsRef.trade?.dailyLossLimitPct || 5}%)`;
    case 'weekly_loss_cap_hit':    return `Weekly loss cap hit (${settingsRef.weeklyLossCapPct || 10}%)`;
    case 'cooldown_active': {
      const rem = Math.ceil(cooldownRemainingMs() / 60000);
      return `Cooldown active — ${rem}m remaining after last loss trade`;
    }
    case 'reconciliation_required': return 'Position reconciliation required — manual review needed';
    default:                        return conditionId;
  }
}

async function logBlockEvent(conditionId, attemptedTrade, extra = {}) {
  const entry = {
    timestamp:     new Date().toISOString(),
    condition:     conditionId,
    reason:        buildReason(conditionId),
    attemptedSymbol: attemptedTrade?.symbol || null,
    attemptedDir:    attemptedTrade?.direction || null,
    ...extra,
  };
  console.log(`[GUARD] 🚫 BLOCKED — ${entry.condition}: ${entry.reason}${attemptedTrade ? ` (tried ${attemptedTrade.symbol})` : ''}`);
  await appendGuardLog(entry);
}

/**
 * Full check + logging for a potential trade.
 * Call this before opening any position.
 */
async function guardTrade(signal, context = {}) {
  const result = checkAllConditions(context);
  if (result.blocked) {
    await logBlockEvent(result.condition, signal, { score: signal?.scoreAtSignal });
    broadcastFn('GUARD_BLOCKED', {
      condition: result.condition,
      reason:    result.reason,
      symbol:    signal?.symbol,
      allBlocked: result.allBlocked,
    });
  }
  return result;
}

// ── Active condition badges for UI ────────────────────────────────

function getActiveConditions(context = {}) {
  const { dailyPnL = 0, balance = 10000 } = context;
  const checks = [
    { id: 'kill_switch_active',      active: checkKillSwitch() },
    { id: 'websocket_disconnected',  active: checkWsDisconnected() },
    { id: 'stale_data_active',       active: checkStaleData() },
    { id: 'database_write_failed',   active: checkDbWriteFailed() },
    { id: 'exchange_unreachable',    active: checkExchangeUnreachable() },
    { id: 'daily_loss_cap_hit',      active: checkDailyLossCap(dailyPnL, balance) },
    { id: 'weekly_loss_cap_hit',     active: checkWeeklyLossCap(balance) },
    { id: 'cooldown_active',         active: checkCooldown() },
    { id: 'reconciliation_required', active: checkReconciliationRequired() },
  ];
  return checks
    .filter(c => c.active)
    .map(c => ({
      id:    c.id,
      label: CONDITION_LABELS[c.id] || c.id,
      reason: buildReason(c.id),
      cooldownRemaining: c.id === 'cooldown_active' ? Math.ceil(cooldownRemainingMs() / 60000) : null,
    }));
}

async function initialize() {
  try {
    await fs.mkdir(path.dirname(GUARD_STATE_FILE), { recursive: true });
  } catch (e) {}
  await loadGuardState();
  console.log(`[GUARD] Initialized — kill switch: ${guardState.killSwitchActive ? '🔴 ON' : '🟢 OFF'}`);
}

module.exports = {
  initialize,
  setSettings,
  setOpenTrades,
  setBroadcast,
  notifyWebSocketStatus,
  notifyDbWriteStatus,
  notifyExchangeStatus,
  notifyPriceTick,
  recordLossTrade,
  recordWeeklyBaseline,
  activateKillSwitch,
  deactivateKillSwitch,
  isKillSwitchActive,
  guardTrade,
  checkAllConditions,
  getActiveConditions,
  setReconciliationRequired,
  loadGuardLog,
  cooldownRemainingMs,
};
