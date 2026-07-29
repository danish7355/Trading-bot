# AlgoBot — Algo Trading Terminal

## Overview
Node.js crypto algo-trading bot with a live browser dashboard. Scans top perpetual futures markets, evaluates 4-gate + W/M pattern signals, opens paper/live trades, and streams real-time price ticks via WebSocket.

## How to Run
```
node server.js
```
The server starts on **port 3000**. The `AlgoBot` workflow is pre-configured in Replit to run this command.

## Architecture
- **`server.js`** — Express HTTP + WebSocket server, all REST routes, startup
- **`backend/scanner.js`** — Crypto futures scanner; 5-min auto-scan heartbeat
- **`backend/multiMarketScanner.js`** — NSE / Commodities / NASDAQ scanners via Yahoo Finance
- **`backend/binanceData.js`** — Bybit V5 primary, Binance Futures fallback, Binance Spot, Coinbase
- **`backend/yahooFinance.js`** — Yahoo Finance v8 chart API adapter for multi-market
- **`backend/storage.js`** — Deep-merge JSON persistence for settings + trades
- **`backend/telegramBot.js`** — Telegram alert functions including trailing/manual close alerts
- **`backend/strategy.js`** — Signal/gate evaluation logic (do not modify)
- **`frontend/index.html`** — Single-page dashboard
- **`frontend/app.js`** — All browser WebSocket + UI logic
- **`frontend/styles.css`** — Dark terminal theme

## Key API Endpoints
| Method | Path | Purpose |
|--------|------|---------|
| GET | `/api/status` | Server + scanner health, heartbeat |
| GET | `/api/scanner/heartbeat` | Scan heartbeat (status, minutesAgo, coinCount) |
| GET | `/api/scanner` | Current coin states |
| POST | `/api/scanner/scan-now` | Force immediate scan |
| GET | `/api/trades/log` | Full trade log (entry/exit/P&L/TF/conditions) |
| GET | `/api/trades/open` | Open positions |
| GET | `/api/trades/closed` | Closed trades with summary |
| POST | `/api/trades/close` | Manually close a trade |
| GET | `/api/markets/status` | NSE/Commodities/NASDAQ scanner statuses |
| GET | `/api/markets/:id` | State for one market |
| POST | `/api/markets/:id/scan-now` | Force scan a market |
| POST | `/api/settings` | Save settings (syncs live engine) |
| GET | `/api/signals` | Signal history with filters |
| GET | `/api/candles` | OHLCV + indicators for chart |

## Data Sources
- **Crypto**: Bybit V5 linear kline (Tier 1) → Binance Futures (Tier 2) → Binance Spot (Tier 3) → Coinbase (Tier 4)
- **NSE / Commodities / NASDAQ**: Yahoo Finance v8 chart API (`.NS` suffix for Indian stocks)

## Bug Fixes Applied (v1.1)
1. **Scan heartbeat** — `lastAutoScanHeartbeat` updated on every run; WS broadcasts `SCAN_HEARTBEAT`; top-bar badge shows ✅/⚠️/⏳ + age
2. **Settings live sync** — `scanner.updateSettings()` called unconditionally on every settings save (not just TF/coin changes)
3. **Trade log** — `/api/trades/log` exposes entry/exit/P&L$/P&L%/timeframeUsed/gate conditions; Trade Log tab in UI
4. **Telegram alerts** — `storage.loadSettings()` deep-merges `telegram.alerts`; trailing/manual close alerts added
5. **Data source** — Bybit V5 is now primary; Binance is fallback; source logged per request

## User Preferences
- No git push until user confirms
- Do not change core strategy/signal logic in `backend/strategy.js`
- Do not restructure existing frontend routes
- Every frontend action must reach the backend engine
