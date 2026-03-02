# 📝 Scaletta Avvio Regia - Paintball Manager

Segui questi passaggi in ordine per preparare il sistema prima di un torneo:

### 1. Preparazione Software

- [ ] Assicurati che **Python** sia installato sul PC Regia.
- [ ] Apri una cartella o terminale nel percorso del progetto.

### 2. Avvio Cloud Sync (Opzionale - Per il pubblico)

*Se vuoi che il punteggio sia visibile su GitHub Pages per gli spettatori da casa:*

- [ ] Apri il terminale e digita: `python cloud_sync.py`.
- [ ] Lascia il terminale aperto (minimizzato) per tutta la durata del torneo.

### 3. Avvio della Regia (Manager)

- [ ] Apri il file `index.html` con Chrome o Edge.
- [ ] In alto a sinistra, verifica il **Match ID** (es. `IPBA-1234`).
- [ ] **Importante**: Se hai avviato lo script Python al punto 2, attiva l'interruttore **CLOUD** in alto.

### 4. Connessione Dispositivi Staff (PeerJS)

*Questi dispositivi sono critici e devono essere istantanei:*

- [ ] **Tablet Arbitro**: Apri `referee.html?id=1234` sul tablet. Verifica che appaia "ONLINE".
- [ ] **vMix / Streaming**: Carica i link nelle scene di vMix usando il parametro ID:
  - `streaming.html?id=1234`
  - `board.html?id=1234`
  - *Nota: vMix userà il Sync Locale (0ms) se tutto è sullo stesso PC.*

### 5. Connessione Pubblico (Cloud Mode)

- [ ] Genera il QR Code dalla Regia (tasto 📱 accanto all'ID).
- [ ] Per gli spettatori remoti, assicurati che il link termini con `&cloud=1`.
  - Esempio: `https://tuo-sito.github.io/board.html?id=1234&cloud=1`.

---

### 🚀 Check finale durante il match

- Il numero tra parentesi `( )` in Regia indica quanti dispositivi PeerJS sono collegati (es. Arbitro e vMix).
- Se il numero è `(0)`, l'arbitro non può controllare il tempo! Controlla la sua connessione internet.
