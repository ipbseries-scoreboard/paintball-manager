# Sistema rose IPBA — PC di regia

Il nuovo sistema rose funziona sullo stesso PC Windows che esegue `index.html` e `streaming.html`.
Configurazioni e fotografie vengono salvate in `data/rosters/` e non sostituiscono il vecchio sistema
di rose usato sugli altri dispositivi.

## Avvio

Avvia `Avvia_Server_Locale.bat` oppure:

```powershell
node server.js 9000
```

Se non è stata configurata una password fissa, la finestra del server mostra una password temporanea:

```text
PASSWORD SETUP ROSE: **********
```

La password temporanea cambia a ogni riavvio. Per impostarne una fissa:

```powershell
$env:PM_ROSTER_PASSWORD="scegli-una-password-lunga"
node server.js 9000
```

La password non deve essere aggiunta agli URL. Il login crea una sessione protetta e valida soltanto
sul PC di regia. Le pagine delle rose restano leggibili senza password.

## URL

- Rosa singola: `http://localhost:9000/roster-lineup.html?id=2`
- Doppia rosa: `http://localhost:9000/roster-lineup.html?idA=2&idB=5&mode=dual`
- Anteprima: aggiungi `&preview=1&autoplay=1`
- Setup singolo: `http://localhost:9000/setup_rose.html?id=2`
- Setup doppio: `http://localhost:9000/setup_rose.html?idA=2&idB=5`

Usa una sorgente Browser OBS/vMix da `1920×1080`. Senza `preview=1` lo sfondo è trasparente.

## Link fissi e aggiornamento automatico

I link delle rose si inseriscono una volta sola in **streaming.html → GESTIONE ROSE & LOGHI**,
nel campo "URL Rosa" di ogni squadra (es. `https://www.ipba.it/video-team-giocatori.aspx?id=2`).
Premendo **SALVA MODIFICHE** l'elenco viene salvato anche sul server del PC di regia
(`data/rosters/registry.json`).

A ogni avvio del server tutte le rose dell'elenco vengono riscaricate da IPBA in automatico
(righe `[ROSE] …` nella finestra nera). Inoltre, ogni volta che una rosa viene aperta in
diretta (o premi **AGGIORNA ROSE**) il server ricontrolla IPBA se l'ultima lettura ha più di
un minuto: i prestiti del match in corso arrivano senza riavviare nulla. Le personalizzazioni
non si perdono. Se IPBA è irraggiungibile restano i dati dell'ultima volta.

## Archivio giocatori e prestiti

Foto scontornata, regolazioni, nome visualizzato, numero, ruolo e soprannome appartengono al
**giocatore**, non alla squadra: sono salvati in `data/rosters/players.json` con la chiave del
giocatore IPBA e le foto in `data/rosters/players/assets/`. Se un giocatore viene prestato a
un'altra squadra, alla prima importazione della nuova rosa arriva **già configurato**.
Restano per-squadra soltanto: visibile/nascosto, ordine, fila e posizione.

Per preparare tutti i giocatori prima del torneo: **GESTIONE ROSE & LOGHI → SETUP TUTTI I
GIOCATORI** (oppure apri `setup_rose.html` senza parametri). La barra laterale elenca tutte le
squadre del pannello; il pulsante **AGGIORNA TUTTE DA IPBA** riscarica ogni rosa al volo.
Attenzione: modificare la foto o i dati di un giocatore vale per tutte le squadre in cui gioca.

## Importazione da IPBA

Il server legge `https://www.ipba.it/video-team-giocatori.aspx?id=<ID>`, associa ogni fotografia al
blocco del giocatore e salva una copia locale della rosa. Il comando **AGGIORNA DA IPBA** aggiorna
i dati originali senza cancellare:

- nome, numero o ruolo personalizzato;
- visibilità, ordine, fila e posizione;
- fotografia personalizzata;
- scala, offset, crop, ancoraggio, ombra e glow;
- giocatori aggiunti manualmente.

I giocatori non più presenti nell’ultima importazione vengono conservati e nascosti.

## Fotografie

1. Apri il setup e inserisci la password mostrata dal server.
2. Seleziona la squadra e il giocatore.
3. Premi **CARICA FOTO SCONTORNATA**.
4. Usa preferibilmente PNG o WebP con trasparenza.
5. Controlla la foto sul pattern a scacchi.
6. Regola scala, posizione, altezza busto e crop.
7. Premi **SALVA TUTTO**.

Il browser verifica la trasparenza e rimuove i bordi esterni completamente trasparenti. JPG/JPEG è
accettato ma viene segnalato come non trasparente. La foto originale IPBA non viene mai eliminata.

## Limite giocatori

La configurazione conserva tutti i giocatori. In diretta vengono selezionati automaticamente i primi
12 visibili di ogni squadra, secondo ordine automatico o manuale. I comandi pagina permettono di
controllare eventuali giocatori successivi senza comprimere la grafica.

## Streaming

Dentro `streaming.html` apri **TEAMS LIST**. Il pannello offre:

- setup squadra A, squadra B o entrambe;
- rosa A o B a pieno schermo;
- entrambe le rose;
- nascondi, replay e aggiornamento;
- modalità anteprima o trasparente.

Gli ID sono estratti dagli URL rosa configurati per le squadre. Se manca un ID, il vecchio iframe
resta disponibile come fallback.

## Backup e ripristino

**ESPORTA CONFIGURAZIONI** crea un JSON contenente dati e fotografie personalizzate.
**IMPORTA CONFIGURAZIONI** ripristina il pacchetto sul server locale.
Il server mantiene inoltre `roster.json.bak` come copia del salvataggio precedente.
