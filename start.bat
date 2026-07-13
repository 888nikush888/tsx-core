@echo off
title Telegram TDLib Forwarder
cd /d "%~dp0"

echo ===================================================
echo   Telegram Forwarder - Auto Setup ^& Start
echo ===================================================

:: 1. Check if Node.js is installed
where node >nul 2>nul
if %errorlevel% neq 0 (
    echo [ERROR] Node.js ist nicht installiert!
    echo Bitte lade Node.js von https://nodejs.org/ herunter und installiere es.
    pause
    exit /b 1
)

:: 2. Check if node_modules exists, if not run npm install
if not exist node_modules (
    echo [INFO] node_modules Ordner fehlt. Installiere Abhaengigkeiten...
    call npm install
    if %errorlevel% neq 0 (
        echo [ERROR] Fehler bei der Installation der Abhaengigkeiten!
        pause
        exit /b 1
    )
)

:: 3. Check if config.json exists, if not copy config.json.example
if not exist config.json (
    echo [INFO] config.json fehlt. Erstelle aus Vorlage...
    copy config.json.example config.json >nul
)

:: 4. Start the forwarder
:run_loop
echo [INFO] Starte Telegram Forwarder CLI Dashboard...
node dist/forwarder.js
set EXIT_CODE=%errorlevel%
if %EXIT_CODE% equ 0 (
    echo [INFO] Programm wurde regulaer beendet.
    pause
    exit /b 0
)
echo [WARN] Programm wurde unerwartet beendet (Exit-Code: %EXIT_CODE%).
echo [WARN] Automatischer Neustart in 5 Sekunden...
timeout /t 5 >nul
goto run_loop
