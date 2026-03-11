@echo off
title IPBA Local Server (Port 9000)
color 0b

echo ===================================================
echo       SERVER LOCALE - PAINTBALL MANAGER
echo ===================================================
echo.
echo Avvio del server in corso sulla porta 9000...
echo.
echo ATTENZIONE: LASCIATE QUESTA FINESTRA APERTA!
echo Se chiudi questa finestra, tutti i tablet e gli schermi
echo si scollegheranno immediatamente.
echo.
echo ===================================================

:: Usa npx per scaricare/eseguire peer server (il pacchetto si chiama "peer")
call npx peer --port 9000 --key peerjs --path /

echo.
echo Il server si e' chiuso o c'e' un errore.
pause
