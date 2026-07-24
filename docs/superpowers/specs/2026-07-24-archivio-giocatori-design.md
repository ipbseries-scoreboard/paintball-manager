# Archivio giocatori centrale e aggiornamento automatico rose — design

Data: 2026-07-24 · Stato: approvato dall'utente (Proposta 1)

## Obiettivo

- I link delle rose sono quelli fissi inseriti nel pannello GESTIONE ROSE & LOGHI di `streaming.html` (campo "URL Rosa").
- A ogni avvio del server tutte le rose vengono riscaricate da IPBA automaticamente.
- Ogni giocatore si configura **una volta sola** (foto scontornata, regolazioni, nome visualizzato, numero, ruolo, soprannome): se viene prestato a un'altra squadra, nella nuova rosa arriva già pronto. Il numero personalizzato segue il giocatore.
- Restano per-squadra: visibile/nascosto, ordine, fila, posizione in fila.

## Architettura dati

### `data/rosters/registry.json`
```json
{ "updatedAt": 0, "teams": [ { "name": "…", "rosterUrl": "https://www.ipba.it/video-team-giocatori.aspx?id=2", "logoUrl": "", "teamId": "2" } ] }
```
- Scritto dal server quando `streaming.html` salva il pannello (`SALVA MODIFICHE`).
- `teamId` estratto lato server dal parametro `id` di `rosterUrl` (solo host ipba.it).
- Massimo 100 squadre; nomi puliti con `cleanText`; URL validati con `safeHttpUrl`.

### `data/rosters/players.json` (archivio giocatori)
```json
{ "updatedAt": 0, "players": { "<playerId>": {
    "customData": { "firstName": "", "lastName": "", "displayName": "", "number": "", "role": "", "nickname": "" },
    "image": { "selectedSource": "ORIGINAL", "customImageUrl": "", "hasTransparency": false, "width": 0, "height": 0,
                "scale": 1, "offsetX": 0, "offsetY": 0, "bustHeight": 78, "cropTop": 0, "cropBottom": 0,
                "anchor": "BOTTOM_CENTER", "flipX": false, "shadow": true, "glow": true }
} } }
```
- Chiave = `source.playerId` IPBA (estratto dall'URL foto `public/user_<id>`). Solo i giocatori con `playerId` usano l'archivio; i giocatori manuali restano interamente nella rosa di squadra come oggi.
- Le foto caricate per giocatori IPBA vanno in `data/rosters/players/assets/<playerId>.<ext>` (condivise tra squadre).

### `data/rosters/team-<id>/roster.json`
- Formato invariato (schema v2, campi inline conservati per compatibilità).
- **Lettura (overlay)**: il server, dopo `readRoster`, sovrascrive per ogni giocatore con `playerId` i 6 campi globali di `customData` e tutto `image` con i valori dell'archivio, se esiste la voce. `visible/order/row/rowPosition` non vengono mai toccati dall'archivio.
- **Scrittura (write-through)**: al salvataggio di una rosa, per ogni giocatore con `playerId` i campi globali vengono scritti anche nell'archivio. L'archivio è la fonte di verità perché la lettura fa sempre overlay.
- **Migrazione implicita**: alla prima lettura, se un giocatore con `playerId` ha configurazioni inline (foto custom o campi globali non vuoti) e l'archivio non ha la voce, la voce viene creata da quei valori (seed). Nessuna migrazione distruttiva.

## API (tutte sotto `/api/rosters/`, stessi header di sicurezza attuali)

| Endpoint | Metodo | Accesso | Funzione |
|---|---|---|---|
| `/registry` | GET | solo PC locale | elenco squadre con teamId estratto |
| `/registry` | POST | solo PC locale | salva il registry (atomicWrite + .bak) |
| `/registry/import-all` | POST | sessione setup | riscarica tutte le rose del registry, ritorna esito per squadra |

Il salvataggio del registry non richiede la password di setup: contiene solo nomi e URL pubblici e arriva dal pannello di regia, che non ha login.

## Aggiornamento automatico all'avvio

- Dopo `server.listen`, in asincrono: lettura registry → per ogni `teamId` in sequenza (pausa ~1,5 s tra una squadra e l'altra per non martellare ipba.it) → `importRoster(teamId)`.
- Esito riga per riga nella finestra del server (`[ROSE] Squadra 2 aggiornata (12 giocatori)` / `[ROSE] Squadra 5: errore …`).
- IPBA irraggiungibile ⇒ restano i dati salvati; l'errore è solo loggato, il server parte comunque.
- La logica è esposta come funzione con dipendenze iniettabili per i test.

## Prestiti — flusso

1. L'utente configura il giocatore (foto, regolazioni, numero…) nel setup di una squadra qualunque → write-through nell'archivio con chiave `playerId`.
2. IPBA aggiorna la rosa della squadra ricevente; all'avvio (o con AGGIORNA TUTTE) il server la importa: il giocatore entra con lo stesso `playerId`.
3. Alla lettura la rosa ricevente riceve l'overlay dell'archivio: foto e configurazione già pronte. Nessuna azione manuale.

## Interfacce

- **streaming.html**: `saveClans()` esegue anche `POST /api/rosters/registry` (try/catch silenzioso: sui dispositivi non-regia il POST fallisce ed è ignorato). Nuovo pulsante «SETUP TUTTI I GIOCATORI» nel pannello che apre `setup_rose.html` senza parametri.
- **setup_rose.html**: senza `id/idA/idB` entra in "modalità archivio": dopo il login carica il registry e mostra nella sidebar tutte le squadre del pannello; cliccandone una la carica nell'editor (riuso dello slot A). Pulsante «AGGIORNA TUTTE DA IPBA» che chiama `/registry/import-all`. Con parametri, comportamento A/B invariato.
- **roster-lineup.html**: invariata (riceve rose già complete).

## Casi limite

- Voce registry senza URL Rosa valido ⇒ ignorata dall'import, non mostrata in modalità archivio.
- Eliminazione foto di un giocatore IPBA ⇒ rimuove foto e voce immagine dall'archivio (vale per tutte le squadre); il testo di conferma lo dice.
- Due giocatori IPBA senza `playerId` (foto senza `user_<id>`) ⇒ nessun archivio, comportamento odierno.
- `import-all` con squadre che falliscono ⇒ le altre proseguono; esito parziale riportato.

## Test

1. Registry: POST valida/salva ed estrae gli id; GET li restituisce; input non validi rifiutati.
2. Prestito: config del giocatore in squadra X → import rosa squadra Y con stesso `playerId` → GET di Y restituisce foto, regolazioni e numero personalizzato.
3. Foto condivisa: upload per giocatore IPBA finisce in `players/assets/` ed è visibile da entrambe le squadre; delete la rimuove ovunque.
4. Seed di migrazione: rosa v2 esistente con config inline → prima lettura crea la voce di archivio.
5. Import-all: con importer finto, rispetta sequenza, prosegue dopo un errore, riporta l'esito.
6. Regressione: i giocatori manuali restano per-squadra; `visible/order/row/rowPosition` non vengono sovrascritti dall'archivio.
