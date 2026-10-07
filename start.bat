@echo off
setlocal
cd /d "%~dp0"
title TikTok LIVE Gift-Only Chat Reader
echo ==== TikTok LIVE Gift-Only Chat Reader ====
where node >nul 2>&1
if errorlevel 1 (
  echo [ERROR] Node.js is not installed. Install Node.js 18+ from https://nodejs.org and run this again.
  pause
  exit /b 1
)
if not exist "node_modules\socket.io" (
  echo [INFO] Installing dependencies...
  call npm install --no-audit --no-fund
  if errorlevel 1 (
    echo [ERROR] npm install failed.
    pause
    exit /b 1
  )
)
echo [INFO] Server: http://localhost:3000
start "" powershell -NoProfile -WindowStyle Hidden -Command "Start-Sleep 2; Start-Process 'http://localhost:3000'"
set PORT=3000
node server.mjs
echo.
echo Server stopped.
pause
