@echo off
title Insurgency Sandstorm - Server Manager
cd /d "%~dp0"
echo Stopping old processes...
taskkill /IM node.exe /F >nul 2>&1
timeout /t 2 /nobreak >nul
echo Starting Server Manager...
echo.
start "" http://127.0.0.1:3000
node server.js
pause
