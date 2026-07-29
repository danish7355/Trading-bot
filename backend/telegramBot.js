const fetch = require('node-fetch');
const storage = require('./storage');
const { formatUTCDateTime } = require('./utils');

const TELEGRAM_API = 'https://api.telegram.org/bot';

async function sendMessage(text, customToken = null, customChatId = null) {
  try {
    const settings = await storage.loadSettings();
    const token  = customToken  || settings.telegram?.botToken || process.env.TELEGRAM_BOT_TOKEN;
    const chatId = customChatId || settings.telegram?.chatId   || process.env.TELEGRAM_CHAT_ID;

    if (!token || !chatId) return { success: false, error: 'Telegram credentials missing' };

    const url = `${TELEGRAM_API}${token}/sendMessage`;
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text, parse_mode: 'HTML' })
    });
    const data = await response.json();
    return data.ok ? { success: true, result: data.result } : { success: false, error: data.description || 'Telegram API error' };
  } catch (err) {
    return { success: false, error: err.message };
  }
}

async function sendSignalAlert(signal) {
  const settings = await storage.loadSettings();
  if (!settings.telegram?.alerts?.signalDetected) return;
  const text = `📡 <b>SIGNAL DETECTED</b>
━━━━━━━━━━━━━━━━━━━━━
Coin: <b>${signal.symbol}</b> | ${signal.direction === 'LONG' ? '▲ LONG' : '▼ SHORT'} | ${signal.timeframe || '4h'}
Signal Time: <b>${signal.signalCandleCloseDateTimeUTC || 'N/A'}</b>
Detected At: ${signal.dateTimeUTC}

Gates: G1✅ G2✅ ${signal.gate2Value || 1.5}× G3✅ ADX:${signal.adxAtSignal?.toFixed(1) || 'N/A'} G4✅ RSI:${signal.rsiAtSignal?.toFixed(1) || 'N/A'}
EMA9: $${signal.ema9?.toFixed(2) || 'N/A'} | EMA55: $${signal.ema55?.toFixed(2) || 'N/A'} | EMA200: $${signal.ema200?.toFixed(2) || 'N/A'}
Price at signal: $${signal.signalCandleClose?.toFixed(2) || 'N/A'}
Score: ${signal.scoreAtSignal}/100${signal.wmPattern ? ' (+' + signal.wmPattern[0] + ')' : ''}
🤖 Auto-trade queued`;
  await sendMessage(text);
}

async function sendWMConfirmedAlert(signal, result) {
  const settings = await storage.loadSettings();
  if (!settings.telegram?.alerts?.wmConfirmed) return;
  const type = result.wmResult?.type || 'W';
  const direction = type === 'W' ? '▲ LONG' : '▼ SHORT';
  const text = `🔔 <b>${type} FORMATION CONFIRMED</b>
━━━━━━━━━━━━━━━━━━━━━
Coin: <b>${signal.symbol}</b> | ${direction} | ${signal.timeframe || '4h'}
Confirmed: <b>${signal.dateTimeUTC}</b>

Pattern:
  ${type === 'W' ? 'V1' : 'P1'}: $${signal.wmV1?.toFixed(2) || 'N/A'}
  Neckline: $${signal.wmNeckline?.toFixed(2) || 'N/A'}
  ${type === 'W' ? 'V2' : 'P2'}: $${signal.wmV2?.toFixed(2) || 'N/A'}
  Break at: $${signal.wmBreakPrice?.toFixed(2) || 'N/A'} ✅

Score: ${signal.scoreAtSignal}/100
⏱ Auto-executes in ${settings.wm?.countdownSeconds || 10}s`;
  await sendMessage(text);
}

async function sendTradeOpenedAlert(trade) {
  const settings = await storage.loadSettings();
  if (!settings.telegram?.alerts?.tradeOpened) return;
  const text = `🤖 <b>TRADE EXECUTED</b>
━━━━━━━━━━━━━━━━━━━━━
Coin: <b>${trade.symbol}</b> | ${trade.direction === 'LONG' ? '▲ LONG' : '▼ SHORT'} | ${trade.timeframe}
Opened: <b>${trade.openedAtUTC}</b>
Exchange: ${(trade.exchange || 'binance').toUpperCase()} | ${trade.isLiveTrade ? '🔴 LIVE' : '📄 PAPER'}

Entry: $${trade.entryPrice.toFixed(2)}
Stop Loss: $${trade.stopLoss.toFixed(2)}
TP1: $${trade.tp1.toFixed(2)} (close 40%)
TP2: $${trade.tp2.toFixed(2)} (close 40%)
TP3: $${trade.tp3.toFixed(2)} (close 20%)
Position: $${trade.positionValue} × ${trade.leverage}× leverage
Trigger: ${trade.trigger}
Score at entry: ${trade.scoreAtEntry}/100`;
  await sendMessage(text);
}

async function sendTPAlert(trade, tpNumber, closePrice, pnlAmount) {
  const settings = await storage.loadSettings();
  const alertKey = `tp${tpNumber}Hit`;
  if (!settings.telegram?.alerts?.[alertKey]) return;
  const pnlPct = ((Math.abs(pnlAmount) / trade.positionValue) * 100).toFixed(2);
  const emoji  = tpNumber === 3 ? '🎯' : '✅';
  const sign   = pnlAmount >= 0 ? '+' : '-';
  const text = `${emoji} <b>TP${tpNumber} HIT — ${trade.symbol} ${trade.direction}</b>
━━━━━━━━━━━━━━━━━━━━━
Time: ${formatUTCDateTime(Date.now())}
Timeframe used: ${trade.timeframe}
TP${tpNumber} Price: $${closePrice.toFixed(2)}
Realized (this close): ${sign}$${Math.abs(pnlAmount).toFixed(2)} (${sign}${pnlPct}%)
${tpNumber < 3 ? 'Remaining position: ' + Math.round(trade.remainingPct * 100) + '% open' : 'Position fully closed'}
${tpNumber === 1 ? '🔒 Trailing stop now active' : ''}`;
  await sendMessage(text);
}

async function sendSLAlert(trade, closePrice, lossAmount) {
  const settings = await storage.loadSettings();
  if (!settings.telegram?.alerts?.slHit) return;
  const lossAbs = Math.abs(lossAmount);
  const lossPct = ((lossAbs / trade.positionValue) * 100).toFixed(2);
  const text = `❌ <b>STOP LOSS HIT — ${trade.symbol} ${trade.direction}</b>
━━━━━━━━━━━━━━━━━━━━━
Time: ${formatUTCDateTime(Date.now())}
Timeframe used: ${trade.timeframe}
Entry: $${trade.entryPrice.toFixed(2)} → SL: $${closePrice.toFixed(2)}
Loss: -$${lossAbs.toFixed(2)} (-${lossPct}%)
Score at entry: ${trade.scoreAtEntry}/100`;
  await sendMessage(text);
}

async function sendTrailingHitAlert(trade, closePrice, pnlAmount) {
  const settings = await storage.loadSettings();
  if (!settings.telegram?.alerts?.trailingHit) return;
  const sign   = pnlAmount >= 0 ? '+' : '-';
  const pnlPct = ((Math.abs(pnlAmount) / trade.positionValue) * 100).toFixed(2);
  const text = `🔒 <b>TRAILING STOP HIT — ${trade.symbol} ${trade.direction}</b>
━━━━━━━━━━━━━━━━━━━━━
Time: ${formatUTCDateTime(Date.now())}
Timeframe used: ${trade.timeframe}
Entry: $${trade.entryPrice.toFixed(2)} → Exit: $${closePrice.toFixed(2)}
Realized P&L: ${sign}$${Math.abs(pnlAmount).toFixed(2)} (${sign}${pnlPct}%)
Trailing protected profits ✅`;
  await sendMessage(text);
}

async function sendManualCloseAlert(trade, closePrice, pnlAmount) {
  const settings = await storage.loadSettings();
  if (!settings.telegram?.alerts?.manualClose) return;
  const sign   = pnlAmount >= 0 ? '+' : '-';
  const pnlPct = ((Math.abs(pnlAmount) / trade.positionValue) * 100).toFixed(2);
  const text = `👋 <b>MANUAL CLOSE — ${trade.symbol} ${trade.direction}</b>
━━━━━━━━━━━━━━━━━━━━━
Time: ${formatUTCDateTime(Date.now())}
Timeframe used: ${trade.timeframe}
Entry: $${trade.entryPrice.toFixed(2)} → Exit: $${closePrice.toFixed(2)}
Realized P&L: ${sign}$${Math.abs(pnlAmount).toFixed(2)} (${sign}${pnlPct}%)`;
  await sendMessage(text);
}

async function sendTrailingMovedAlert(trade, newTrailing) {
  const settings = await storage.loadSettings();
  if (!settings.telegram?.alerts?.trailingMoved) return;
  const text = `🔒 <b>TRAILING STOP MOVED — ${trade.symbol}</b>
━━━━━━━━━━━━━━━━━━━━━
New Trailing Level: $${newTrailing.toFixed(2)}
Direction: ${trade.direction}
Locked Profit Level Increased`;
  await sendMessage(text);
}

async function sendDailyLimitAlert(pnl) {
  const text = `⚠️ <b>DAILY LOSS LIMIT REACHED</b>
━━━━━━━━━━━━━━━━━━━━━
Daily PnL: -$${Math.abs(pnl).toFixed(2)}
Auto-trading is now PAUSED for today.
Resets at 00:00 UTC.`;
  await sendMessage(text);
}

async function sendRangingAlert(symbol, result) {
  const settings = await storage.loadSettings();
  if (!settings.telegram?.alerts?.ranging) return;
  const text = `🟠 <b>RANGING MARKET DETECTED — ${symbol}</b>
━━━━━━━━━━━━━━━━━━━━━
Reason: ${result.reason || 'ADX below threshold'}
Trade evaluation skipped for this coin.`;
  await sendMessage(text);
}

async function sendTestAlert(customToken, customChatId) {
  const text = `🧪 <b>ALGOBOT TELEGRAM TEST</b>
━━━━━━━━━━━━━━━━━━━━━
Telegram alerts are successfully connected!
Time: ${formatUTCDateTime(Date.now())}`;
  return await sendMessage(text, customToken, customChatId);
}

module.exports = {
  sendMessage, sendSignalAlert, sendWMConfirmedAlert, sendTradeOpenedAlert,
  sendTPAlert, sendSLAlert, sendTrailingHitAlert, sendManualCloseAlert,
  sendTrailingMovedAlert, sendDailyLimitAlert, sendRangingAlert, sendTestAlert
};
