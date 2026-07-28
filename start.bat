@echo off
title Algo Trading Bot Server
color 0A
cd /d "%~dp0"

echo ========================================================
echo       Crypto Algo Trading Bot - Backend Engine
echo ========================================================
echo.

:: Check if node_modules exists
if not exist "node_modules" (
    echo [0/3] Installing dependencies...
    npm install
    echo.
)

echo [1/3] Opening web dashboard in default browser...
timeout /t 2 /nobreak >nul
start "" "http://localhost:3000"

:: Check if PM2 is available for 24/7 operation
where pm2 >nul 2>&1
if %ERRORLEVEL% EQU 0 (
    echo [2/3] PM2 detected — starting in 24/7 mode with auto-restart...
    echo.
    pm2 start ecosystem.config.js
    echo.
    echo [3/3] Bot running via PM2. Useful commands:
    echo   pm2 status         - Check bot status
    echo   pm2 logs algobot   - View live logs
    echo   pm2 restart algobot - Restart the bot
    echo   pm2 stop algobot   - Stop the bot
    echo   pm2 monit          - Real-time monitoring dashboard
    echo.
    echo Press any key to open PM2 monitoring...
    pause >nul
    pm2 monit
) else (
    echo [2/3] Starting Node.js Backend Server on port 3000...
    echo       (Install PM2 globally for 24/7 auto-restart: npm install -g pm2)
    echo.
    node server.js
    echo.
    echo Server stopped. Press any key to close window...
    pause >nul
)
