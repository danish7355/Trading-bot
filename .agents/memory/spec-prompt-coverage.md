---
name: Uploaded spec prompt coverage
description: Tracks which sections of the uploaded implementation spec have been built vs remaining
---

Spec file: `attached_assets/Pasted--AlgoBot-Single-Session-Implementation-Prompt-...txt`

**Section 1 — WS stale-data watchdog** ✅
- `lastTickReceivedAt` tracked on every WS message tick
- 15-second silence watchdog in `connectPriceStream` → forces reconnect if open but silent
- `getLastTickAge()` exported; `GET /api/ws/status` endpoint added
- Frontend: stale banner shows on disconnect; scan button disabled; STALE badge per-symbol after 30s

**Section 2 — Price animation** ✅ (done in prior session)
- `animatePriceCell()` with ↑↓ arrows, 600ms green/red flash, STALE badge per symbol

**Section 3 — Separate signals by market** ✅
- `market: 'crypto'` field added to every signal in `buildSignalObject`
- Signals tab has market sub-tabs: ₿ Crypto Futures (active), NSE/Forex/US Stocks labeled "coming soon" (disabled, honest UI)
- `loadSignals()` filters by `activeSignalMarket` before populating table

**Section 4 — Strategy presets** ✅
- `backend/strategyPresets.js`: 3 presets (EMA-ADX, Breakout, Trend Continuation) with win-rate/RR disclaimers
- `GET /api/strategy/presets`, `POST /api/strategy/preset/apply`
- Settings tab shows preset cards; applying replaces ALL params; active preset highlighted

**Section 5 — Dashboard tab with real insights** ✅
- Dashboard converted from external link → in-page tab
- `getInsightsFromTrades()` + `getEquityCurveFromTrades()` in analytics.js (JSON fallback, DB-free)
- `GET /api/analytics/insights` returns insights array + summary + equity curve data
- Dashboard shows KPI strip (8 metrics), mini equity curve canvas, auto-insight cards

**Section 6 — Settings as control room** ✅
- `backend/exchangeKeys.js`: server-side key storage in `data/exchange_keys.json`
- Test connection functions for Binance (HMAC-SHA256), Coinbase (Advanced Trade), Delta Exchange
- Settings tab: Binance/Coinbase/Delta API key cards, demo/live toggle per exchange, Test/Save/Clear
- Strategy preset selector, scan interval, TP/SL%, daily/weekly loss caps, cooldown minutes
- `GET /api/exchange/status` (keys redacted), `POST /api/exchange/keys`, `POST /api/exchange/test`, `DELETE /api/exchange/keys/:exchange`

**What still needs user input:**
- Real API keys for Coinbase Advanced Trade and Delta Exchange to test live key validation
- Forex data feed: no live source connected — signals tab correctly labels it "coming soon"
- SQLite DB probe fails (better-sqlite3 binary) — analytics uses JSON fallback (functional)
- Exchange abstraction layer: scanner/executor still hardcoded to Binance internals; full abstraction is a larger refactor
