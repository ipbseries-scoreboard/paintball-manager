@echo off
setlocal
title IPBA Server Locale (porta 9000)
color 0b

echo ===================================================
echo       SERVER LOCALE - PAINTBALL MANAGER v2
echo   (pagine web + relay dati sulla stessa porta 9000)
echo ===================================================
echo.

:: Controllo 1: Node.js deve essere installato
where node >nul 2>&1
if errorlevel 1 (
    color 0c
    echo ERRORE: Node.js non e' installato o non e' nel PATH.
    echo Scaricalo da https://nodejs.org e installa la versione LTS.
    echo.
    pause
    exit /b 1
)

:: Controllo 2: la porta 9000 non deve essere gia' occupata
netstat -ano | findstr ":9000" | findstr "LISTENING" >nul 2>&1
if not errorlevel 1 (
    color 0e
    echo ATTENZIONE: La porta 9000 e' GIA' in uso.
    echo Il server e' probabilmente gia' avviato in un'altra finestra:
    echo usa quella, oppure chiudila e riavvia questo file.
    echo.
    pause
    exit /b 1
)

pushd "%~dp0"

:: Prima volta: installa la dipendenza "ws" (serve internet solo una volta)
if not exist "node_modules\ws\package.json" (
    echo Prima installazione: scarico la dipendenza "ws"...
    call npm install --ignore-scripts --no-audit --no-fund
    if errorlevel 1 (
        color 0c
        echo ERRORE durante l'installazione. Serve una connessione internet
        echo solo per il primo avvio. Riprova quando sei connesso.
        pause
        exit /b 1
    )
)

echo ATTENZIONE: LASCIATE QUESTA FINESTRA APERTA!
echo Se la chiudi, tutti i tablet e gli schermi si scollegano.
echo.

node server.js

echo.
echo Il server si e' chiuso o c'e' un errore.
pause
