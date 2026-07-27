@echo off
title Algo Trading Bot Server
color 0A
cd /d "%~dp0"

echo ========================================================
echo       Crypto Algo Trading Bot - Backend Engine
echo ========================================================
echo.
echo [1/2] Opening web dashboard in default browser...
timeout /t 2 /nobreak >nul
start "" "http://localhost:3000"

echo [2/2] Starting Node.js Backend Server on port 3000...
echo.

node server.js

echo.
echo Server stopped. Press any key to close window...
pause >nul
