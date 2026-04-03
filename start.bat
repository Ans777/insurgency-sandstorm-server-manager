@echo off
title Insurgency Sandstorm - Server Manager
cd /d "%~dp0"

if not exist node_modules (
    echo Installing dependencies...
    npm install
    echo.
)

echo Stopping old instances...
taskkill /IM node.exe /F >nul 2>&1
timeout /t 2 /nobreak >nul

echo Starting Server Manager...
echo.
echo  ^> http://127.0.0.1:3000
echo.
echo Press Ctrl+C to stop.
echo.

powershell -Command "Start-Sleep 3; Start-Process 'http://127.0.0.1:3000'" >nul 2>&1 &
node server.js
pause
