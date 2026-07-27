# AlgoBot Setup Guide

## Step 1 — Replit Setup
1. Create a new Replit project (Node.js template)
2. Copy all files from this project into Replit
3. Replit will auto-detect `package.json` and install dependencies

## Step 2 — Environment Variables (Replit Secrets)
In your Replit project, go to Secrets (lock icon in sidebar)
Add these secrets:

- `TELEGRAM_BOT_TOKEN`: your telegram bot token
  - *How to get*: Message `@BotFather` on Telegram -> Command: `/newbot` -> follow instructions -> copy token
- `TELEGRAM_CHAT_ID`: your telegram chat ID
  - *How to get*: Message `@userinfobot` on Telegram -> copy ID
- `DELTA_API_KEY`: your Delta Exchange API key (optional)
  - *How to get*: Sign up at testnet.delta.exchange -> API Management -> Create Key
- `DELTA_API_SECRET`: your Delta Exchange API secret (optional)
- `DELTA_MODE`: `testnet` (change to `live` only when ready for real trading)
- `PORT`: `3000`

## Step 3 — Start the Bot
Click the **Run** button in Replit.
You should see in the console:
  `[✅] Storage initialized`
  `[✅] Settings loaded`
  `[✅] HTTP server running`
  `[✅] Binance WebSocket connected`
  `[✅] Scanner engine started`
  `AlgoBot fully operational ✅`

## Step 4 — Open the Dashboard
Click the Replit preview URL (top of preview pane) or open `http://localhost:3000`.

## Step 5 — Configure Settings
Go to Settings tab in the app:
- Set your Telegram bot token and chat ID
- Click **Test Telegram** -> verify message arrives
- Configure position size and leverage
- Set exchange (default: Binance paper trading)

## Step 6 — Always-On (Important!)
For the bot to run 24/7 when browser is closed:
- **FREE TIER**: Self-ping every 5 minutes (built-in)
- **HACKER PLAN**: Enable "Always On" toggle in Replit project settings
  -> Go to your Repl -> Three dots menu -> Settings -> Always On

*Always-On is REQUIRED for live trading.*

## Step 7 — Paper Trading Test
The bot starts in paper trading mode automatically (Demo balance: $10,000 USDT).
- Watch the scanner for signals
- When a signal fires, verify Telegram alert arrives
- Use Debug tab -> Force Test Trade to verify execution logic

## Step 8 — Delta Exchange Live Trading (Optional)
Only proceed when you have tested paper trading, configured secrets, and enabled Always-On.
Go to Settings -> Exchange -> Delta Exchange, click **LIVE TRADING**, type `CONFIRM`, and verify the red banner appears at top of page.
