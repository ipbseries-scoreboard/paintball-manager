@echo off
title Paintball Manager - Cloud Sync Bridge
echo ==========================================
echo    AVVIO CLOUD SYNC BRIDGE (GitHub)
echo ==========================================
echo.
python cloud_sync.py
if %errorlevel% neq 0 (
    echo.
    echo [ERRORE] Impossibile avviare Python. Assicurati che sia installato.
    pause
)
pause
