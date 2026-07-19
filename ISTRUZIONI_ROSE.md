# Sistema rose IPBA

## Avvio consigliato

Avvia `Avvia_Server_Locale.bat` oppure:

```powershell
node server.js 9000
```

Il server importa le pagine IPBA, salva le configurazioni in `data/rosters/` e rende le stesse rose disponibili a tutti i dispositivi collegati allo stesso server.

Per proteggere le modifiche con un token opzionale:

```powershell
$env:PM_ROSTER_TOKEN="scegli-un-token-lungo"
node server.js 9000
```

In questo caso apri il setup aggiungendo `&token=scegli-un-token-lungo` all'URL. Senza token, il server accetta modifiche soltanto dalla propria origine web.

## URL

- Rosa singola: `roster-lineup.html?id=2`
- Doppia rosa: `roster-lineup.html?idA=2&idB=5&mode=dual`
- Anteprima: aggiungi `&preview=1&autoplay=1`
- Setup singolo: `setup_rose.html?id=2`
- Setup doppio: `setup_rose.html?idA=2&idB=5`

La sorgente Browser OBS/vMix consigliata è 1920×1080. Senza `preview=1` lo sfondo è trasparente.

## Fotografie

1. Apri `setup_rose.html`.
2. Seleziona la squadra.
3. Premi **CARICA FOTO SCONTORNATA** sul giocatore.
4. Preferisci PNG o WebP con trasparenza.
5. Controlla la fotografia sul pattern a scacchi.
6. Regola scala, posizione, crop e altezza del mezzo busto.
7. Premi **SALVA TUTTO**.

La foto originale IPBA non viene eliminata. **USA ORIGINALE** la ripristina in qualsiasi momento; **RIMUOVI FOTO** elimina la copia personalizzata.

## Pubblicazione statica

Su un server statico o GitHub Pages non sono disponibili importazione e upload lato server. Pubblica insieme alle pagine anche:

- `roster-core.js`
- `roster-storage.js`
- la cartella `data/rosters/`

I file JSON e le fotografie pubblicati vengono letti da OBS e dagli altri dispositivi in sola lettura. Per modificarli, usa il server locale, esporta le configurazioni e ripubblica i file aggiornati.
