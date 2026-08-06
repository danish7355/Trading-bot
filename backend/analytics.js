/**
 * Analytics Module — Real-time analytics queries from SQLite
 * 
 * Provides computed analytics endpoints driven by actual trade data,
 * NOT hardcoded placeholder values.
 */

const db = require('./db');

/**
 * Overall performance summary
 */
function getSummary() {
  const database = db.getDb();
  if (!database) return getEmptySummary();

  try {
    const closed = database.prepare("SELECT * FROM trades WHERE status = 'closed'").all();
    
    if (closed.length === 0) return getEmptySummary();

    const wins = closed.filter(t => t.pnl > 0);
    const losses = closed.filter(t => t.pnl <= 0);
    const totalPnL = closed.reduce((sum, t) => sum + (t.pnl || 0), 0);
    const winPnL = wins.reduce((sum, t) => sum + t.pnl, 0);
    const lossPnL = Math.abs(losses.reduce((sum, t) => sum + t.pnl, 0));

    // Profit Factor
    const profitFactor = lossPnL > 0 ? +(winPnL / lossPnL).toFixed(2) : (winPnL > 0 ? 99.99 : 0);

    // Average R:R (avg win / avg loss)
    const avgWin = wins.length > 0 ? winPnL / wins.length : 0;
    const avgLoss = losses.length > 0 ? lossPnL / losses.length : 0;
    const avgRR = avgLoss > 0 ? +(avgWin / avgLoss).toFixed(2) : 0;

    // Max Drawdown
    const maxDrawdown = calculateMaxDrawdown(closed);

    // Sharpe Ratio (simplified: annualized daily returns)
    const sharpe = calculateSharpeRatio(closed);

    // Avg trade duration
    const avgDuration = calculateAvgDuration(closed);

    // Expectancy = (Win% * AvgWin) - (Loss% * AvgLoss)
    const winRate = closed.length > 0 ? wins.length / closed.length : 0;
    const lossRate = 1 - winRate;
    const expectancy = (winRate * avgWin) - (lossRate * avgLoss);

    return {
      totalTrades: closed.length,
      wins: wins.length,
      losses: losses.length,
      winRate: +(winRate * 100).toFixed(1),
      totalPnL: +totalPnL.toFixed(2),
      avgWin: +avgWin.toFixed(2),
      avgLoss: +avgLoss.toFixed(2),
      profitFactor,
      avgRR,
      maxDrawdown: +maxDrawdown.toFixed(2),
      sharpeRatio: +sharpe.toFixed(2),
      avgTradeDuration: avgDuration,
      expectancy: +expectancy.toFixed(2),
      bestTrade: closed.length > 0 ? +Math.max(...closed.map(t => t.pnl)).toFixed(2) : 0,
      worstTrade: closed.length > 0 ? +Math.min(...closed.map(t => t.pnl)).toFixed(2) : 0
    };
  } catch (err) {
    console.error('[ANALYTICS] getSummary error:', err.message);
    return getEmptySummary();
  }
}

function getEmptySummary() {
  return {
    totalTrades: 0, wins: 0, losses: 0, winRate: 0,
    totalPnL: 0, avgWin: 0, avgLoss: 0, profitFactor: 0,
    avgRR: 0, maxDrawdown: 0, sharpeRatio: 0,
    avgTradeDuration: '0h', expectancy: 0,
    bestTrade: 0, worstTrade: 0
  };
}

/**
 * Equity curve from daily snapshots or computed from trades
 */
function getEquityCurve(days = 90) {
  const database = db.getDb();
  if (!database) return [];

  try {
    // First try daily snapshots table
    const snapshots = database.prepare(`
      SELECT date, balance, daily_pnl, win_count, loss_count
      FROM daily_snapshots
      ORDER BY date ASC
      LIMIT ?
    `).all(days);

    if (snapshots.length > 0) return snapshots;

    // Fallback: build equity curve from closed trades
    const closed = database.prepare(`
      SELECT pnl, closed_at FROM trades
      WHERE status = 'closed' AND closed_at IS NOT NULL
      ORDER BY closed_at ASC
    `).all();

    if (closed.length === 0) return [];

    let balance = 10000;
    const curve = [];
    const dailyMap = {};

    for (const trade of closed) {
      const date = trade.closed_at.split('T')[0];
      if (!dailyMap[date]) dailyMap[date] = { pnl: 0, wins: 0, losses: 0 };
      dailyMap[date].pnl += trade.pnl || 0;
      if (trade.pnl > 0) dailyMap[date].wins++;
      else dailyMap[date].losses++;
    }

    for (const [date, data] of Object.entries(dailyMap).sort()) {
      balance += data.pnl;
      curve.push({
        date,
        balance: +balance.toFixed(2),
        daily_pnl: +data.pnl.toFixed(2),
        win_count: data.wins,
        loss_count: data.losses
      });
    }

    return curve;
  } catch (err) {
    console.error('[ANALYTICS] getEquityCurve error:', err.message);
    return [];
  }
}

/**
 * Breakdown by strategy tag
 */
function getByStrategy() {
  const database = db.getDb();
  if (!database) return {};

  try {
    const closed = database.prepare("SELECT * FROM trades WHERE status = 'closed'").all();
    const grouped = {};

    for (const trade of closed) {
      const tag = trade.strategy_tag || 'UNKNOWN';
      if (!grouped[tag]) grouped[tag] = { trades: 0, wins: 0, totalPnL: 0, pnls: [] };
      grouped[tag].trades++;
      grouped[tag].totalPnL += trade.pnl || 0;
      grouped[tag].pnls.push(trade.pnl || 0);
      if (trade.pnl > 0) grouped[tag].wins++;
    }

    const result = {};
    for (const [tag, data] of Object.entries(grouped)) {
      result[tag] = {
        trades: data.trades,
        wins: data.wins,
        losses: data.trades - data.wins,
        winRate: data.trades > 0 ? +((data.wins / data.trades) * 100).toFixed(1) : 0,
        totalPnL: +data.totalPnL.toFixed(2),
        avgPnL: data.trades > 0 ? +(data.totalPnL / data.trades).toFixed(2) : 0
      };
    }

    return result;
  } catch (err) {
    console.error('[ANALYTICS] getByStrategy error:', err.message);
    return {};
  }
}

/**
 * Breakdown by symbol — top and bottom performers
 */
function getBySymbol(limit = 20) {
  const database = db.getDb();
  if (!database) return { top: [], bottom: [] };

  try {
    const closed = database.prepare("SELECT * FROM trades WHERE status = 'closed'").all();
    const grouped = {};

    for (const trade of closed) {
      const sym = trade.symbol;
      if (!grouped[sym]) grouped[sym] = { trades: 0, wins: 0, totalPnL: 0 };
      grouped[sym].trades++;
      grouped[sym].totalPnL += trade.pnl || 0;
      if (trade.pnl > 0) grouped[sym].wins++;
    }

    const symbols = Object.entries(grouped).map(([symbol, data]) => ({
      symbol,
      trades: data.trades,
      wins: data.wins,
      winRate: data.trades > 0 ? +((data.wins / data.trades) * 100).toFixed(1) : 0,
      totalPnL: +data.totalPnL.toFixed(2)
    }));

    symbols.sort((a, b) => b.totalPnL - a.totalPnL);

    return {
      top: symbols.slice(0, limit),
      bottom: symbols.slice(-limit).reverse()
    };
  } catch (err) {
    console.error('[ANALYTICS] getBySymbol error:', err.message);
    return { top: [], bottom: [] };
  }
}

/**
 * Breakdown by direction (LONG vs SHORT)
 */
function getByDirection() {
  const database = db.getDb();
  if (!database) return {};

  try {
    const closed = database.prepare("SELECT * FROM trades WHERE status = 'closed'").all();
    const result = { LONG: { trades: 0, wins: 0, totalPnL: 0 }, SHORT: { trades: 0, wins: 0, totalPnL: 0 } };

    for (const trade of closed) {
      const dir = trade.side || 'LONG';
      if (!result[dir]) result[dir] = { trades: 0, wins: 0, totalPnL: 0 };
      result[dir].trades++;
      result[dir].totalPnL += trade.pnl || 0;
      if (trade.pnl > 0) result[dir].wins++;
    }

    for (const dir of Object.keys(result)) {
      result[dir].winRate = result[dir].trades > 0 
        ? +((result[dir].wins / result[dir].trades) * 100).toFixed(1) 
        : 0;
      result[dir].avgPnL = result[dir].trades > 0 
        ? +(result[dir].totalPnL / result[dir].trades).toFixed(2) 
        : 0;
      result[dir].totalPnL = +result[dir].totalPnL.toFixed(2);
    }

    return result;
  } catch (err) {
    console.error('[ANALYTICS] getByDirection error:', err.message);
    return {};
  }
}

/**
 * Recent trades with full detail
 */
function getRecentTrades(limit = 20) {
  const database = db.getDb();
  if (!database) return [];

  try {
    return database.prepare(`
      SELECT * FROM trades 
      ORDER BY COALESCE(closed_at, opened_at) DESC 
      LIMIT ?
    `).all(limit);
  } catch (err) {
    console.error('[ANALYTICS] getRecentTrades error:', err.message);
    return [];
  }
}

/**
 * Bot events log
 */
function getBotEvents(type = null, limit = 50) {
  return db.getEvents(type, limit);
}

/**
 * Win streak / loss streak analysis
 */
function getStreakAnalysis() {
  const database = db.getDb();
  if (!database) return { currentStreak: 0, maxWinStreak: 0, maxLossStreak: 0 };

  try {
    const closed = database.prepare(`
      SELECT pnl FROM trades WHERE status = 'closed' ORDER BY closed_at ASC
    `).all();

    let maxWin = 0, maxLoss = 0, current = 0;
    let isWinning = null;

    for (const t of closed) {
      const win = t.pnl > 0;
      if (win === isWinning) {
        current++;
      } else {
        current = 1;
        isWinning = win;
      }
      if (win && current > maxWin) maxWin = current;
      if (!win && current > maxLoss) maxLoss = current;
    }

    return {
      currentStreak: current * (isWinning ? 1 : -1),
      maxWinStreak: maxWin,
      maxLossStreak: maxLoss
    };
  } catch (err) {
    console.error('[ANALYTICS] getStreakAnalysis error:', err.message);
    return { currentStreak: 0, maxWinStreak: 0, maxLossStreak: 0 };
  }
}

// ─── Internal helpers ────────────────────────────────────────────

function calculateMaxDrawdown(closedTrades) {
  if (closedTrades.length === 0) return 0;

  let balance = 10000;
  let peak = balance;
  let maxDD = 0;

  const sorted = [...closedTrades].sort((a, b) => {
    const dateA = a.closed_at || a.opened_at || '';
    const dateB = b.closed_at || b.opened_at || '';
    return dateA.localeCompare(dateB);
  });

  for (const trade of sorted) {
    balance += trade.pnl || 0;
    if (balance > peak) peak = balance;
    const dd = ((peak - balance) / peak) * 100;
    if (dd > maxDD) maxDD = dd;
  }

  return maxDD;
}

function calculateSharpeRatio(closedTrades) {
  if (closedTrades.length < 2) return 0;

  const returns = closedTrades.map(t => (t.pnl || 0) / 10000);
  const avgReturn = returns.reduce((s, r) => s + r, 0) / returns.length;
  
  const variance = returns.reduce((s, r) => s + Math.pow(r - avgReturn, 2), 0) / (returns.length - 1);
  const stdDev = Math.sqrt(variance);

  if (stdDev === 0 || isNaN(stdDev)) return 0;

  // Annualized (assume ~250 trading days equivalent)
  const val = (avgReturn / stdDev) * Math.sqrt(250);
  return isNaN(val) || !isFinite(val) ? 0 : val;
}

function calculateAvgDuration(closedTrades) {
  const withDuration = closedTrades.filter(t => t.opened_at && t.closed_at);
  if (withDuration.length === 0) return '0h';

  const totalMs = withDuration.reduce((sum, t) => {
    const open = new Date(t.opened_at).getTime();
    const close = new Date(t.closed_at).getTime();
    return sum + Math.max(0, close - open);
  }, 0);

  const avgMs = totalMs / withDuration.length;
  const hours = Math.floor(avgMs / 3600000);
  const minutes = Math.floor((avgMs % 3600000) / 60000);
  
  if (hours > 24) {
    const days = Math.floor(hours / 24);
    return `${days}d ${hours % 24}h`;
  }
  return `${hours}h ${minutes}m`;
}

/**
 * getInsightsFromTrades — auto-generated insight lines from raw trade array.
 * Accepts the closed-trades array directly so it works with JSON storage
 * when SQLite is unavailable.
 * Returns an array of plain-English insight strings (2–4 items).
 */
function getInsightsFromTrades(closed = []) {
  if (closed.length === 0) {
    return ['No completed trades yet — insights will appear after your first trade closes.'];
  }

  const insights = [];

  // Win rate overall
  const wins   = closed.filter(t => (t.realizedPnL ?? t.pnl ?? 0) > 0);
  const losses = closed.filter(t => (t.realizedPnL ?? t.pnl ?? 0) <= 0);
  const winRate = +(wins.length / closed.length * 100).toFixed(1);
  insights.push(`Overall win rate is ${winRate}% across ${closed.length} closed trade${closed.length !== 1 ? 's' : ''}.`);

  // Best performing direction
  const longTrades  = closed.filter(t => t.direction === 'LONG');
  const shortTrades = closed.filter(t => t.direction === 'SHORT');
  if (longTrades.length > 0 && shortTrades.length > 0) {
    const longWR  = longTrades.filter(t  => (t.realizedPnL ?? t.pnl ?? 0) > 0).length / longTrades.length;
    const shortWR = shortTrades.filter(t => (t.realizedPnL ?? t.pnl ?? 0) > 0).length / shortTrades.length;
    const better  = longWR >= shortWR ? 'LONG' : 'SHORT';
    const betterPct = +(Math.max(longWR, shortWR) * 100).toFixed(1);
    insights.push(`${better} signals are outperforming — ${betterPct}% win rate vs ${+(Math.min(longWR, shortWR) * 100).toFixed(1)}% for ${better === 'LONG' ? 'SHORT' : 'LONG'}.`);
  }

  // Best trigger type
  const byTrigger = {};
  for (const t of closed) {
    const trig = t.trigger || t.entryTrigger || 'UNKNOWN';
    if (!byTrigger[trig]) byTrigger[trig] = { wins: 0, total: 0 };
    byTrigger[trig].total++;
    if ((t.realizedPnL ?? t.pnl ?? 0) > 0) byTrigger[trig].wins++;
  }
  const trigEntries = Object.entries(byTrigger).filter(([, v]) => v.total >= 2);
  if (trigEntries.length > 1) {
    const best = trigEntries.sort((a, b) => (b[1].wins / b[1].total) - (a[1].wins / a[1].total))[0];
    insights.push(`Best trigger type: ${best[0]} with ${+(best[1].wins / best[1].total * 100).toFixed(0)}% win rate (${best[1].total} trades).`);
  }

  // Recent trend (last 5 trades)
  if (closed.length >= 5) {
    const recent5   = closed.slice(-5);
    const recentWins = recent5.filter(t => (t.realizedPnL ?? t.pnl ?? 0) > 0).length;
    const trend = recentWins >= 4 ? '🔥 hot streak' : recentWins <= 1 ? '⚠️ cold streak' : 'neutral';
    if (trend !== 'neutral') {
      insights.push(`Recent form: ${trend} — ${recentWins}/5 of your last trades were profitable.`);
    }
  }

  return insights;
}

/**
 * Equity curve from JSON trade storage (DB-free fallback).
 */
function getEquityCurveFromTrades(closed = [], startBalance = 10000) {
  if (closed.length === 0) return [];

  const dailyMap = {};
  for (const t of closed) {
    const ts = t.closedAt || t.closed_at;
    if (!ts) continue;
    const date = new Date(ts).toISOString().split('T')[0];
    if (!dailyMap[date]) dailyMap[date] = { pnl: 0, wins: 0, losses: 0 };
    const pnl = t.realizedPnL ?? t.pnl ?? 0;
    dailyMap[date].pnl += pnl;
    if (pnl > 0) dailyMap[date].wins++;
    else dailyMap[date].losses++;
  }

  let balance = startBalance;
  return Object.entries(dailyMap).sort().map(([date, data]) => {
    balance += data.pnl;
    return {
      date,
      balance:    +balance.toFixed(2),
      daily_pnl:  +data.pnl.toFixed(2),
      win_count:  data.wins,
      loss_count: data.losses,
    };
  });
}

function getSummaryFromTrades(closed = [], demoBalance = 10000) {
  if (!closed || closed.length === 0) return getEmptySummary();

  const wins = closed.filter(t => (t.realizedPnL ?? t.pnl ?? 0) > 0);
  const losses = closed.filter(t => (t.realizedPnL ?? t.pnl ?? 0) <= 0);
  const totalPnL = closed.reduce((sum, t) => sum + (t.realizedPnL ?? t.pnl ?? 0), 0);
  const winPnL = wins.reduce((sum, t) => sum + (t.realizedPnL ?? t.pnl ?? 0), 0);
  const lossPnL = Math.abs(losses.reduce((sum, t) => sum + (t.realizedPnL ?? t.pnl ?? 0), 0));

  const profitFactor = lossPnL > 0 ? +(winPnL / lossPnL).toFixed(2) : (winPnL > 0 ? 99.99 : 0);

  const avgWin = wins.length > 0 ? winPnL / wins.length : 0;
  const avgLoss = losses.length > 0 ? lossPnL / losses.length : 0;
  const avgRR = avgLoss > 0 ? +(avgWin / avgLoss).toFixed(2) : 0;

  const maxDrawdown = calculateMaxDrawdown(closed);
  const sharpe = calculateSharpeRatio(closed);
  const avgDuration = calculateAvgDuration(closed);

  const winRate = closed.length > 0 ? wins.length / closed.length : 0;
  const lossRate = 1 - winRate;
  const expectancy = (winRate * avgWin) - (lossRate * avgLoss);

  const pnls = closed.map(t => t.realizedPnL ?? t.pnl ?? 0);

  return {
    totalTrades: closed.length,
    wins: wins.length,
    losses: losses.length,
    winRate: +(winRate * 100).toFixed(1),
    totalPnL: +totalPnL.toFixed(2),
    avgWin: +avgWin.toFixed(2),
    avgLoss: +avgLoss.toFixed(2),
    profitFactor,
    avgRR,
    maxDrawdown: +maxDrawdown.toFixed(2),
    sharpeRatio: +sharpe.toFixed(2),
    avgTradeDuration: avgDuration,
    expectancy: +expectancy.toFixed(2),
    bestTrade: pnls.length > 0 ? +Math.max(...pnls).toFixed(2) : 0,
    worstTrade: pnls.length > 0 ? +Math.min(...pnls).toFixed(2) : 0
  };
}

function getByDirectionFromTrades(closed = []) {
  const result = { LONG: { trades: 0, wins: 0, totalPnL: 0 }, SHORT: { trades: 0, wins: 0, totalPnL: 0 } };
  for (const trade of closed) {
    const dir = trade.direction || trade.side || 'LONG';
    if (!result[dir]) result[dir] = { trades: 0, wins: 0, totalPnL: 0 };
    result[dir].trades++;
    const pnl = trade.realizedPnL ?? trade.pnl ?? 0;
    result[dir].totalPnL += pnl;
    if (pnl > 0) result[dir].wins++;
  }
  for (const dir of Object.keys(result)) {
    result[dir].winRate = result[dir].trades > 0 ? +((result[dir].wins / result[dir].trades) * 100).toFixed(1) : 0;
    result[dir].avgPnL = result[dir].trades > 0 ? +(result[dir].totalPnL / result[dir].trades).toFixed(2) : 0;
    result[dir].totalPnL = +result[dir].totalPnL.toFixed(2);
  }
  return result;
}

function getByStrategyFromTrades(closed = []) {
  const grouped = {};
  for (const trade of closed) {
    const tag = trade.trigger || trade.strategy_tag || '10GATE_TRADE';
    if (!grouped[tag]) grouped[tag] = { trades: 0, wins: 0, totalPnL: 0 };
    grouped[tag].trades++;
    const pnl = trade.realizedPnL ?? trade.pnl ?? 0;
    grouped[tag].totalPnL += pnl;
    if (pnl > 0) grouped[tag].wins++;
  }
  const result = {};
  for (const [tag, data] of Object.entries(grouped)) {
    result[tag] = {
      trades: data.trades,
      wins: data.wins,
      losses: data.trades - data.wins,
      winRate: data.trades > 0 ? +((data.wins / data.trades) * 100).toFixed(1) : 0,
      totalPnL: +data.totalPnL.toFixed(2),
      avgPnL: data.trades > 0 ? +(data.totalPnL / data.trades).toFixed(2) : 0
    };
  }
  return result;
}

function getBySymbolFromTrades(closed = [], limit = 10) {
  const grouped = {};
  for (const trade of closed) {
    const sym = trade.symbol;
    if (!grouped[sym]) grouped[sym] = { trades: 0, wins: 0, totalPnL: 0 };
    grouped[sym].trades++;
    const pnl = trade.realizedPnL ?? trade.pnl ?? 0;
    grouped[sym].totalPnL += pnl;
    if (pnl > 0) grouped[sym].wins++;
  }
  const symbols = Object.entries(grouped).map(([symbol, data]) => ({
    symbol,
    trades: data.trades,
    wins: data.wins,
    winRate: data.trades > 0 ? +((data.wins / data.trades) * 100).toFixed(1) : 0,
    totalPnL: +data.totalPnL.toFixed(2)
  }));
  symbols.sort((a, b) => b.totalPnL - a.totalPnL);
  return {
    top: symbols.slice(0, limit),
    bottom: symbols.slice(-limit).reverse()
  };
}

function getStreakAnalysisFromTrades(closed = []) {
  let maxWin = 0, maxLoss = 0, current = 0;
  let isWinning = null;
  for (const t of closed) {
    const pnl = t.realizedPnL ?? t.pnl ?? 0;
    const win = pnl > 0;
    if (win === isWinning) {
      current++;
    } else {
      current = 1;
      isWinning = win;
    }
    if (win && current > maxWin) maxWin = current;
    if (!win && current > maxLoss) maxLoss = current;
  }
  return {
    currentStreak: current * (isWinning ? 1 : -1),
    maxWinStreak: maxWin,
    maxLossStreak: maxLoss
  };
}

module.exports = {
  getSummary,
  getEquityCurve,
  getByStrategy,
  getBySymbol,
  getByDirection,
  getRecentTrades,
  getBotEvents,
  getStreakAnalysis,
  getInsightsFromTrades,
  getEquityCurveFromTrades,
  getSummaryFromTrades,
  getByDirectionFromTrades,
  getByStrategyFromTrades,
  getBySymbolFromTrades,
  getStreakAnalysisFromTrades
};
