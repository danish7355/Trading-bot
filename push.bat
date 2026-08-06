@echo off
title One-Click Git Push - Trading Bot
echo ====================================================
echo                ONE-CLICK GIT PUSH                   
echo ====================================================
echo.

echo [1/3] Staging all changed files...
git add -A

set /p msg="Enter commit message (Press ENTER for default 'update: automated push'): "
if "%msg%"=="" set msg=update: automated push (%date% %time%)

echo.
echo [2/3] Committing changes with message: "%msg%"...
git commit -m "%msg%"

echo.
echo [3/3] Pushing to GitHub (origin main)...
git push origin main

echo.
echo ====================================================
if %ERRORLEVEL% EQU 0 (
    echo SUCCESS: Changes pushed to GitHub successfully!
) else (
    echo ERROR: Git push failed! Please check your network or repository permissions.
)
echo ====================================================
echo.
pause
