# Archivio giocatori centrale — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rose scaricate automaticamente all'avvio dai link fissi del pannello streaming, con configurazione dei giocatori (foto, regolazioni, nome, numero) archiviata una volta per giocatore e riusata in ogni squadra (prestiti inclusi).

**Architecture:** Il server Node (roster-server.js) acquisisce due nuovi store JSON sotto `DATA_ROOT`: `registry.json` (squadre + URL Rosa dal pannello) e `players.json` (archivio per `playerId` IPBA). Le rose per-squadra restano nel formato attuale; il server fa overlay dell'archivio in lettura e write-through in scrittura (solo per i salvataggi espliciti, mai durante gli import). Le pagine client cambiano poco: streaming sincronizza il registry, setup_rose guadagna la modalità "tutte le squadre".

**Tech Stack:** Node http nativo, `node --test`, vanilla JS nelle pagine. Nessuna dipendenza nuova.

## Global Constraints

- Nessuna dipendenza npm aggiuntiva (restano solo `ws` e `cheerio`).
- I file dati si scrivono SOLO con `atomicWrite` (tmp + rename + `.bak`).
- Input sempre sanificati con `Core.cleanText` / `Core.safeTeamId` / `Core.safeHttpUrl`.
- I campi per-squadra `visible/order/row/rowPosition` NON vanno mai nell'archivio.
- Write-through nell'archivio SOLO nei salvataggi espliciti (POST rosa, foto): mai da `importRoster`, altrimenti un import di rosa nuova azzererebbe l'archivio con i default.
- Le stringhe verificate da tests/roster-system.test.js (`SETUP ROSA A`, `MOSTRA ENTRAMBE LE ROSE`, `MEZZO BUSTO`, ecc.) non devono sparire dalle pagine.
- Messaggi utente in italiano, stile esistente.

---

### Task 1: DATA_ROOT configurabile e isolamento dei test su disco

**Files:**
- Modify: `roster-server.js:13` (costante DATA_ROOT)
- Modify: `tests/roster-system.test.js:1-11` (temp dir)

**Interfaces:**
- Produces: `process.env.PM_ROSTER_DATA_DIR` — se impostata PRIMA del require, tutti i percorsi dati del roster server puntano lì. I test file la impostano su una mkdtemp.

- [ ] **Step 1:** In `roster-server.js` sostituire `const DATA_ROOT = path.join(ROOT, 'data', 'rosters');` con:

```js
const DATA_ROOT = process.env.PM_ROSTER_DATA_DIR
    ? path.resolve(process.env.PM_ROSTER_DATA_DIR)
    : path.join(ROOT, 'data', 'rosters');
```

- [ ] **Step 2:** In `tests/roster-system.test.js`, prima dei `require('../roster-server')`, aggiungere:

```js
const os = require('node:os');
process.env.PM_ROSTER_DATA_DIR = require('node:fs').mkdtempSync(require('node:path').join(os.tmpdir(), 'pm-roster-'));
```

(mantenendo i require esistenti; l'ordine conta: env prima di `require('../roster-server')`).

- [ ] **Step 3:** Run `npm test` → 59 pass (il test API ora scrive nella temp dir).
- [ ] **Step 4:** Commit `refactor: DATA_ROOT configurabile per test isolati`.

---

### Task 2: Registry squadre (file + endpoint GET/POST)

**Files:**
- Modify: `roster-server.js` (nuove funzioni + route in `handleRosterApi` PRIMA della validazione teamId; export)
- Create: `tests/player-archive.test.js`

**Interfaces:**
- Produces: `readRegistry() -> Promise<{updatedAt:number, teams:[{name,rosterUrl,logoUrl,teamId}]}>`; `extractRegistryTeamId(url) -> string`; route `GET|POST /api/rosters/registry` (solo `isLocalRequest`), payload POST `{teams:[{name,rosterUrl,logoUrl}]}` (max 100, nomi vuoti scartati).

- [ ] **Step 1:** Test (nuovo file `tests/player-archive.test.js`, stessa struttura di roster-system: temp DATA_ROOT, server http su porta 0):

```js
'use strict';
const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');
process.env.PM_ROSTER_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'pm-archive-'));
const test = require('node:test');
const assert = require('node:assert/strict');
const fsp = fs.promises;
const http = require('node:http');
const Core = require('../roster-core');
const Server = require('../roster-server');

async function startServer(t) {
    const server = http.createServer((req, res) => {
        const url = new URL(req.url, 'http://127.0.0.1');
        Promise.resolve(Server.handleRosterApi(req, res, url)).catch(error => { res.writeHead(500); res.end(error.message); });
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    t.after(() => new Promise(resolve => server.close(resolve)));
    return 'http://127.0.0.1:' + server.address().port;
}

async function loginCookie(base) {
    const password = Server.getSetupAuthInfo().generatedPassword || process.env.PM_ROSTER_PASSWORD;
    const response = await fetch(base + '/api/rosters/auth/login', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password })
    });
    assert.equal(response.status, 200);
    return String(response.headers.get('set-cookie') || '').split(';')[0];
}

test('registry: POST valida, estrae gli id IPBA e GET lo restituisce', async t => {
    const base = await startServer(t);
    let response = await fetch(base + '/api/rosters/registry', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ teams: [
            { name: 'PD SaYnts', rosterUrl: 'https://www.ipba.it/video-team-giocatori.aspx?id=77', logoUrl: '' },
            { name: 'Senza URL', rosterUrl: 'https://esempio.com/x?id=9', logoUrl: '' },
            { name: '', rosterUrl: 'https://www.ipba.it/video-team-giocatori.aspx?id=5' }
        ] })
    });
    assert.equal(response.status, 200);
    const saved = await response.json();
    assert.equal(saved.teams.length, 2);
    assert.equal(saved.teams[0].teamId, '77');
    assert.equal(saved.teams[1].teamId, '');
    response = await fetch(base + '/api/rosters/registry');
    const loaded = await response.json();
    assert.equal(loaded.teams[0].name, 'PD SaYnts');
    assert.ok(fs.existsSync(path.join(Server.DATA_ROOT, 'registry.json')));
});
```

- [ ] **Step 2:** Run `node --test tests/player-archive.test.js` → FAIL (405/404 sull'endpoint).
- [ ] **Step 3:** Implementazione in roster-server.js:

```js
function registryPath() { return path.join(DATA_ROOT, 'registry.json'); }

function extractRegistryTeamId(value) {
    try {
        const url = new URL(String(value || ''));
        if (!/(^|\.)ipba\.it$/i.test(url.hostname)) return '';
        return Core.safeTeamId(url.searchParams.get('id') || '');
    } catch (error) {
        return '';
    }
}

function normalizeRegistry(input) {
    const teams = Array.isArray(input && input.teams) ? input.teams.slice(0, 100) : [];
    return {
        updatedAt: Math.max(0, Number(input && input.updatedAt) || 0),
        teams: teams.map(team => ({
            name: Core.cleanText(team && team.name, 100),
            rosterUrl: Core.safeHttpUrl(team && team.rosterUrl),
            logoUrl: Core.safeHttpUrl(team && team.logoUrl),
            teamId: extractRegistryTeamId(team && team.rosterUrl)
        })).filter(team => team.name)
    };
}

async function readRegistry() {
    try {
        return normalizeRegistry(JSON.parse(await fsp.readFile(registryPath(), 'utf8')));
    } catch (error) {
        return { updatedAt: 0, teams: [] };
    }
}
```

Route dentro `handleRosterApi`, subito dopo il blocco `auth` e prima della validazione `teamId`:

```js
if (parts[2] === 'registry') {
    if (!isLocalRequest(req)) {
        json(res, 403, { error: 'Il registry rose è disponibile soltanto sul PC di regia.' });
        return true;
    }
    if (parts.length === 3 && req.method === 'GET') {
        json(res, 200, await readRegistry());
        return true;
    }
    if (parts.length === 3 && req.method === 'POST') {
        const registry = normalizeRegistry(await readJson(req, 512 * 1024));
        registry.updatedAt = Date.now();
        await atomicWrite(registryPath(), JSON.stringify(registry, null, 2));
        json(res, 200, registry);
        return true;
    }
    json(res, 405, { error: 'Metodo o endpoint non supportato' });
    return true;
}
```

Export: aggiungere `readRegistry` e `extractRegistryTeamId` a module.exports.

- [ ] **Step 4:** Run test → PASS. `npm test` completo → verde.
- [ ] **Step 5:** Commit `feat: registry squadre sincronizzato dal pannello streaming`.

---

### Task 3: Archivio giocatori (overlay in lettura, write-through nei salvataggi, foto condivise)

**Files:**
- Modify: `roster-server.js` (`readRoster`, `saveRoster`, `savePhoto`, `deletePhoto`, nuove funzioni archivio)
- Modify: `tests/roster-system.test.js:110-116` (percorso foto condivise)
- Test: `tests/player-archive.test.js`

**Interfaces:**
- Consumes: `atomicWrite`, `Core.normalizeRoster`, `Core.defaultPlayer`.
- Produces: `players.json` = `{updatedAt, players: {"<playerId>": {customData:{firstName,lastName,displayName,number,role,nickname}, image:{…tutti i campi image…}}}}`; foto IPBA in `DATA_ROOT/players/assets/<playerId>.<ext>` con URL `data/rosters/players/assets/<file>`; `saveRoster(roster, options)` con `options.updateArchive` boolean (default false).

- [ ] **Step 1: Test prestito + campi per-squadra + seed migrazione** (append a tests/player-archive.test.js):

```js
function apiPlayer(teamId, pid, name, number) {
    return Core.defaultPlayer(teamId, {
        source: { type: 'IPBA', playerId: String(pid), originalPhotoUrl: 'https://www.ipba.it/public/user_' + pid + '/p.png' },
        originalData: { fullName: name, number: String(number), role: 'MID' }
    }, 0);
}

test('prestito: la configurazione del giocatore segue il playerId nella nuova squadra', async t => {
    const base = await startServer(t);
    const cookie = await loginCookie(base);
    const idX = 'LOANX', idY = 'LOANY';
    const rosterX = Core.defaultTeam(idX);
    rosterX.players = [apiPlayer(idX, 909, 'VERDI PAOLO', 10)];
    rosterX.players[0].customData.displayName = 'IL MURO';
    rosterX.players[0].customData.number = '99';
    rosterX.players[0].image.scale = 1.4;
    let response = await fetch(base + '/api/rosters/' + idX, {
        method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookie }, body: JSON.stringify(rosterX)
    });
    assert.equal(response.status, 200);

    // La rosa Y arriva da un import: saveRoster interno SENZA updateArchive
    const rosterY = Core.defaultTeam(idY);
    rosterY.players = [apiPlayer(idY, 909, 'VERDI PAOLO', 10)];
    rosterY.players[0].customData.order = 5;
    await Server.saveRoster(rosterY);

    response = await fetch(base + '/api/rosters/' + idY + '?noImport=1');
    const loaded = (await response.json()).roster;
    assert.equal(loaded.players[0].customData.displayName, 'IL MURO');
    assert.equal(loaded.players[0].customData.number, '99');
    assert.equal(loaded.players[0].image.scale, 1.4);
    assert.equal(loaded.players[0].customData.order, 5); // per-squadra: NON dall'archivio
});

test('l\'import interno non azzera l\'archivio con i default', async () => {
    const archive = JSON.parse(fs.readFileSync(path.join(Server.DATA_ROOT, 'players.json'), 'utf8'));
    assert.equal(archive.players['909'].customData.displayName, 'IL MURO');
});

test('seed: una rosa v2 con configurazioni inline popola l\'archivio alla prima lettura', async () => {
    const id = 'SEEDT';
    const roster = Core.defaultTeam(id);
    roster.players = [apiPlayer(id, 555, 'NERI GIANNI', 4)];
    roster.players[0].customData.nickname = 'JOHNNY';
    const dir = path.join(Server.DATA_ROOT, 'team-' + id);
    await fsp.mkdir(dir, { recursive: true });
    await fsp.writeFile(path.join(dir, 'roster.json'), JSON.stringify(Core.normalizeRoster(roster, id)));
    const read = await Server.readRoster(id);
    assert.equal(read.players[0].customData.nickname, 'JOHNNY');
    const archive = JSON.parse(fs.readFileSync(path.join(Server.DATA_ROOT, 'players.json'), 'utf8'));
    assert.equal(archive.players['555'].customData.nickname, 'JOHNNY');
});

test('giocatori manuali senza playerId restano fuori dall\'archivio', async t => {
    const base = await startServer(t);
    const cookie = await loginCookie(base);
    const id = 'MANUT';
    const roster = Core.defaultTeam(id);
    roster.players = [Core.defaultPlayer(id, { source: { type: 'MANUAL' }, originalData: { fullName: 'MANUALE UNO', number: '1' } }, 0)];
    roster.players[0].customData.displayName = 'SOLO QUI';
    const response = await fetch(base + '/api/rosters/' + id, {
        method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookie }, body: JSON.stringify(roster)
    });
    assert.equal(response.status, 200);
    const archive = JSON.parse(fs.readFileSync(path.join(Server.DATA_ROOT, 'players.json'), 'utf8'));
    assert.equal(Object.keys(archive.players).some(key => archive.players[key].customData.displayName === 'SOLO QUI'), false);
});

test('la foto di un giocatore IPBA è condivisa tra le squadre e la cancellazione vale ovunque', async t => {
    const base = await startServer(t);
    const cookie = await loginCookie(base);
    const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64');
    png.writeUInt32BE(40, 16); png.writeUInt32BE(40, 20);
    const keyX = 'TEAM-LOANX_PLAYER-909';
    let response = await fetch(base + '/api/rosters/LOANX/players/' + keyX + '/photo', {
        method: 'POST', headers: { 'Content-Type': 'image/png', 'X-Image-Transparency': '1', Cookie: cookie }, body: png
    });
    assert.equal(response.status, 200);
    const photo = await response.json();
    assert.match(photo.url, /^data\/rosters\/players\/assets\/909\.png$/);
    assert.ok(fs.existsSync(path.join(Server.DATA_ROOT, 'players', 'assets', '909.png')));
    response = await fetch(base + '/api/rosters/LOANY?noImport=1');
    assert.equal((await response.json()).roster.players[0].image.customImageUrl, photo.url);
    response = await fetch(base + '/api/rosters/LOANY/players/TEAM-LOANY_PLAYER-909/photo', { method: 'DELETE', headers: { Cookie: cookie } });
    assert.equal(response.status, 200);
    assert.equal(fs.existsSync(path.join(Server.DATA_ROOT, 'players', 'assets', '909.png')), false);
    response = await fetch(base + '/api/rosters/LOANX?noImport=1');
    assert.equal((await response.json()).roster.players[0].image.customImageUrl, '');
});
```

- [ ] **Step 2:** Run → FAIL.
- [ ] **Step 3: Implementazione archivio** in roster-server.js:

```js
const ARCHIVE_GLOBAL_FIELDS = ['firstName', 'lastName', 'displayName', 'number', 'role', 'nickname'];

function archivePath() { return path.join(DATA_ROOT, 'players.json'); }

async function readArchive() {
    try {
        const raw = JSON.parse(await fsp.readFile(archivePath(), 'utf8'));
        return {
            updatedAt: Math.max(0, Number(raw && raw.updatedAt) || 0),
            players: raw && raw.players && typeof raw.players === 'object' ? raw.players : {}
        };
    } catch (error) {
        return { updatedAt: 0, players: {} };
    }
}

function archiveEntryFromPlayer(player) {
    const entry = { customData: {}, image: Object.assign({}, player.image) };
    ARCHIVE_GLOBAL_FIELDS.forEach(field => { entry.customData[field] = player.customData[field]; });
    return entry;
}

function overlayArchiveEntry(player, entry) {
    const data = entry && entry.customData && typeof entry.customData === 'object' ? entry.customData : {};
    ARCHIVE_GLOBAL_FIELDS.forEach(field => { player.customData[field] = data[field] == null ? '' : data[field]; });
    player.image = Object.assign({}, player.image, entry && entry.image && typeof entry.image === 'object' ? entry.image : {});
}

function hasArchivableConfig(player) {
    return !!(player.image.customImageUrl ||
        player.image.selectedSource === 'CUSTOM' ||
        ARCHIVE_GLOBAL_FIELDS.some(field => player.customData[field]));
}

// Lettura: overlay dell'archivio; i giocatori configurati inline (dati v2)
// senza voce di archivio la creano (seed di migrazione).
// Scrittura esplicita (updateArchive): write-through dei campi globali.
async function syncRosterWithArchive(roster, updateArchive) {
    const archive = await readArchive();
    let changed = false;
    roster.players.forEach(player => {
        const id = player.source.playerId;
        if (!id) return;
        const entry = archive.players[id];
        if (updateArchive) {
            if (entry || hasArchivableConfig(player)) {
                const next = archiveEntryFromPlayer(player);
                if (JSON.stringify(entry) !== JSON.stringify(next)) {
                    archive.players[id] = next;
                    changed = true;
                }
            }
        } else if (entry) {
            overlayArchiveEntry(player, entry);
        } else if (hasArchivableConfig(player)) {
            archive.players[id] = archiveEntryFromPlayer(player);
            changed = true;
        }
    });
    if (changed) {
        archive.updatedAt = Date.now();
        await atomicWrite(archivePath(), JSON.stringify(archive, null, 2));
    }
    return Core.normalizeRoster(roster, roster.team.id);
}
```

Modifiche ai flussi esistenti:

```js
async function readRoster(teamId) {
    try {
        const raw = JSON.parse(await fsp.readFile(configPath(teamId), 'utf8'));
        return await syncRosterWithArchive(Core.normalizeRoster(raw, teamId), false);
    } catch (error) {
        return null;
    }
}

async function saveRoster(roster, options) {
    const id = roster && roster.team && roster.team.id;
    let clean = Core.normalizeRoster(roster, id);
    if (!clean.team.id) throw Object.assign(new Error('ID squadra non valido'), { status: 400 });
    clean = await syncRosterWithArchive(clean, !!(options && options.updateArchive));
    clean.updatedAt = Date.now();
    await atomicWrite(configPath(clean.team.id), JSON.stringify(clean, null, 2));
    return clean;
}
```

- Nel handler `POST /:id` (salvataggio dal setup): `saveRoster(roster, { updateArchive: true })`.
- In `savePhoto` e `deletePhoto`: `saveRoster(roster, { updateArchive: true })` (il roster letto è già overlaid, quindi il write-through è coerente).
- `importRoster` continua a chiamare `saveRoster(merged)` SENZA updateArchive.
- In `savePhoto`/`deletePhoto`, percorso foto in base a `player.source.playerId`:

```js
const pid = player.source.playerId;
const assets = pid ? path.join(DATA_ROOT, 'players', 'assets') : path.join(teamDir(id), 'assets');
const baseName = pid || key;
// filename = baseName + info.ext; url:
const url = pid
    ? 'data/rosters/players/assets/' + encodeURIComponent(filename)
    : 'data/rosters/team-' + encodeURIComponent(id) + '/assets/' + encodeURIComponent(filename);
```

(la pulizia dei vecchi formati usa `baseName + '.'` nella cartella scelta; identico per la delete).

- [ ] **Step 4:** Aggiornare tests/roster-system.test.js (test foto, righe ~110-116): il giocatore ha playerId '1', quindi il file finisce in `players/assets/1.png`:

```js
assert.equal(fs.existsSync(path.join(Server.DATA_ROOT, 'players', 'assets', '1.png')), true);
// … e dopo la DELETE:
assert.equal(fs.existsSync(path.join(Server.DATA_ROOT, 'players', 'assets', '1.png')), false);
```

- [ ] **Step 5:** Run `npm test` → tutto verde.
- [ ] **Step 6:** Commit `feat: archivio giocatori centrale con overlay e foto condivise`.

---

### Task 4: Import automatico all'avvio + endpoint import-all

**Files:**
- Modify: `roster-server.js` (funzione `importAllFromRegistry`, route import-all, export)
- Modify: `server.js` (chiamata post-listen + log)
- Test: `tests/player-archive.test.js`

**Interfaces:**
- Produces: `importAllFromRegistry({importer?, delayMs?, log?}) -> Promise<[{teamId,name,ok,players?|error?}]>`; route `POST /api/rosters/registry/import-all` (richiede sessione) → `{results}` con `delayMs: 400`.

- [ ] **Step 1: Test** (append):

```js
test('import-all rispetta l\'ordine del registry e prosegue dopo un errore', async () => {
    await fsp.writeFile(path.join(Server.DATA_ROOT, 'registry.json'), JSON.stringify({ teams: [
        { name: 'UNO', rosterUrl: 'https://www.ipba.it/video-team-giocatori.aspx?id=11' },
        { name: 'DUE', rosterUrl: 'https://www.ipba.it/video-team-giocatori.aspx?id=22' },
        { name: 'SENZA ID', rosterUrl: '' }
    ] }));
    const called = [];
    const results = await Server.importAllFromRegistry({
        delayMs: 0,
        importer: async teamId => {
            called.push(teamId);
            if (teamId === '11') throw new Error('IPBA HTTP 500');
            const roster = Core.defaultTeam(teamId);
            roster.team.name = 'DUE OK';
            roster.players = [apiPlayer(teamId, 1, 'X Y', 1)];
            return roster;
        }
    });
    assert.deepEqual(called, ['11', '22']);
    assert.equal(results.length, 2);
    assert.equal(results[0].ok, false);
    assert.match(results[0].error, /IPBA HTTP 500/);
    assert.deepEqual({ ok: results[1].ok, players: results[1].players }, { ok: true, players: 1 });
});
```

- [ ] **Step 2:** Run → FAIL. **Step 3:** Implementazione:

```js
async function importAllFromRegistry(options) {
    options = options || {};
    const importer = options.importer || importRoster;
    const delayMs = options.delayMs == null ? 1500 : options.delayMs;
    const log = options.log || (() => {});
    const registry = await readRegistry();
    const results = [];
    for (const team of registry.teams) {
        if (!team.teamId) continue;
        if (results.length && delayMs) await new Promise(resolve => setTimeout(resolve, delayMs));
        try {
            const roster = await importer(team.teamId);
            results.push({ teamId: team.teamId, name: roster.team.name, ok: true, players: roster.players.length });
            log('[ROSE] ' + roster.team.name + ' (id ' + team.teamId + '): rosa aggiornata, ' + roster.players.length + ' giocatori.');
        } catch (error) {
            results.push({ teamId: team.teamId, name: team.name, ok: false, error: error.message });
            log('[ROSE] ' + (team.name || 'Squadra ' + team.teamId) + ': ERRORE ' + error.message);
        }
    }
    return results;
}
```

Route (dentro il blocco `registry` del Task 2, prima del 405):

```js
if (parts.length === 4 && parts[3] === 'import-all' && req.method === 'POST') {
    if (!authenticatedSession(req)) {
        json(res, 401, { error: 'Sessione setup scaduta. Inserisci nuovamente la password.' });
        return true;
    }
    json(res, 200, { results: await importAllFromRegistry({ delayMs: 400 }) });
    return true;
}
```

In `server.js`, dopo il blocco `server.listen(...)` (dentro la callback, in coda ai log):

```js
setTimeout(() => {
    importAllFromRegistry({ log: console.log }).then(results => {
        if (results.length) console.log('[ROSE] Aggiornamento automatico completato (' + results.filter(r => r.ok).length + '/' + results.length + ' squadre).');
    }).catch(error => console.log('[ROSE] Aggiornamento automatico non riuscito: ' + error.message));
}, 3000);
```

con `importAllFromRegistry` aggiunto al require da `./roster-server`.

- [ ] **Step 4:** `npm test` verde. **Step 5:** Commit `feat: aggiornamento automatico delle rose all'avvio del server`.

---

### Task 5: streaming.html — sync registry e pulsante SETUP TUTTI I GIOCATORI

**Files:**
- Modify: `streaming.html` (funzione `saveClans` ~riga 2979; pannello GESTIONE ROSE & LOGHI ~riga 1640-1660)
- Test: `tests/player-archive.test.js` (regressione sorgente)

- [ ] **Step 1: Test**:

```js
test('streaming sincronizza il registry e offre il setup di tutti i giocatori', () => {
    const streaming = fs.readFileSync(path.join(__dirname, '..', 'streaming.html'), 'utf8');
    assert.match(streaming, /api\/rosters\/registry/);
    assert.match(streaming, /SETUP TUTTI I GIOCATORI/);
});
```

- [ ] **Step 2:** FAIL. **Step 3:** In `saveClans()`, dopo `localStorage.setItem('pm_stream_clans', ...)`:

```js
try {
    fetch('/api/rosters/registry', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ teams: clanConfig.map(clan => ({ name: clan.name || '', rosterUrl: clan.rosterUrl || '', logoUrl: clan.logoUrl || '' })) })
    }).catch(() => { });
} catch (e) { /* pagina aperta fuori dal PC di regia: il registry resta quello del PC locale */ }
```

Nel pannello, sotto il bottone SINCRONIZZA SQUADRE DA TORNEO, aggiungere un bottone con lo stesso stile:

```html
<button onclick="window.open('setup_rose.html', '_blank')" ...stesso stile del bottone sopra...>🧑‍🎨 SETUP TUTTI I GIOCATORI</button>
```

- [ ] **Step 4:** `npm test` verde. **Step 5:** Commit `feat: streaming sincronizza il registry rose sul server`.

---

### Task 6: setup_rose.html — modalità archivio (tutte le squadre) + AGGIORNA TUTTE

**Files:**
- Modify: `setup_rose.html` (init, sidebar, toolbar)
- Test: `tests/player-archive.test.js`

**Interfaces:**
- Consumes: `GET /api/rosters/registry`, `POST /api/rosters/registry/import-all`, `Storage.loadTeam`.

- [ ] **Step 1: Test**:

```js
test('setup rose espone la modalità archivio con tutte le squadre del registry', () => {
    const setup = fs.readFileSync(path.join(__dirname, '..', 'setup_rose.html'), 'utf8');
    assert.match(setup, /api\/rosters\/registry/);
    assert.match(setup, /AGGIORNA TUTTE DA IPBA/);
    assert.match(setup, /registryMode/);
});
```

- [ ] **Step 2:** FAIL. **Step 3:** Modifiche:

1. Stato: `const registryMode = !ids.A && !ids.B;` e `state.registry = [];` e `state.registryDirtyGuard` non serve (si riusa `state.dirty`).
2. `init()`: rimuovere l'uscita anticipata «ID squadra mancante» quando `registryMode` (il login resta identico).
3. `enterApp()`: se `registryMode` → `await loadRegistry()` al posto di `loadTeams()`.

```js
async function loadRegistry() {
    setStatus('CARICAMENTO SQUADRE…');
    const registry = await Storage.request('/api/rosters/registry');
    state.registry = (registry.teams || []).filter(team => team.teamId);
    if (!state.registry.length) {
        setStatus('NESSUNA SQUADRA');
        toast('Nessuna squadra con URL Rosa: compila il pannello GESTIONE ROSE & LOGHI in streaming e premi SALVA MODIFICHE.', true);
        renderRegistrySidebar();
        return;
    }
    renderRegistrySidebar();
    await selectRegistryTeam(state.registry[0].teamId);
}

async function selectRegistryTeam(teamId) {
    if (state.dirty && !confirm('Ci sono modifiche non salvate. Cambiare squadra comunque?')) return;
    setStatus('CARICAMENTO ROSA…');
    try {
        const result = await Storage.loadTeam(teamId);
        state.A = result.roster;
        state.B = null;
        state.storage.A = result.storage;
        state.active = 'A';
        ids.A = teamId;
        state.dirty = false;
        renderAll();
        renderRegistrySidebar();
        setStatus('PRONTO');
    } catch (error) {
        toast('Squadra ' + teamId + ': ' + error.message, true);
        setStatus('ERRORE CARICAMENTO');
    }
}

function renderRegistrySidebar() {
    if (!registryMode) return;
    const sidebar = document.querySelector('.sidebar');
    sidebar.querySelectorAll('.side-tab').forEach(node => { node.hidden = true; });
    let list = document.getElementById('registry-list');
    if (!list) {
        list = document.createElement('div');
        list.id = 'registry-list';
        sidebar.insertBefore(list, sidebar.querySelector('.side-info'));
    }
    list.replaceChildren();
    state.registry.forEach(function (team) {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'side-tab' + (state.A && state.A.team.id === team.teamId ? ' active' : '');
        const letter = document.createElement('span');
        letter.className = 'side-letter';
        letter.textContent = (team.name || '?').slice(0, 1).toUpperCase();
        const label = document.createElement('span');
        const strong = document.createElement('strong');
        strong.textContent = team.name;
        const small = document.createElement('small');
        small.textContent = 'ID ' + team.teamId;
        label.append(strong, small);
        button.append(letter, label);
        button.addEventListener('click', function () { selectRegistryTeam(team.teamId); });
        list.appendChild(button);
    });
}

async function importAllTeams() {
    if (state.dirty && !confirm('Ci sono modifiche non salvate. Aggiornare comunque tutte le squadre da IPBA?')) return;
    setStatus('AGGIORNAMENTO DI TUTTE LE SQUADRE…');
    try {
        const outcome = await Storage.request('/api/rosters/registry/import-all', { method: 'POST' });
        const results = outcome.results || [];
        const failed = results.filter(result => !result.ok);
        toast('Aggiornate ' + (results.length - failed.length) + ' squadre su ' + results.length +
            (failed.length ? ' · Errori: ' + failed.map(result => result.name || result.teamId).join(', ') : '.'), !!failed.length);
        if (state.A) await selectRegistryTeam(state.A.team.id);
        setStatus('AGGIORNAMENTO COMPLETATO');
    } catch (error) {
        toast(error.message, true);
        setStatus('ERRORE AGGIORNAMENTO');
        if (error.status === 401) showLogin('Sessione scaduta.');
    }
}
```

4. Toolbar: nuovo bottone `<button class="btn" data-action="import-all" hidden>AGGIORNA TUTTE DA IPBA</button>`; in `enterApp()` con `registryMode`: mostrarlo e nascondere i bottoni non pertinenti:

```js
if (registryMode) {
    document.querySelector('[data-action="import-all"]').hidden = false;
    ['import-b', 'import-both', 'preview'].forEach(function (name) {
        const node = document.querySelector('.toolbar [data-action="' + name + '"]');
        if (node) node.hidden = true;
    });
    const importA = document.querySelector('[data-action="import-a"]');
    if (importA) importA.textContent = 'AGGIORNA QUESTA SQUADRA DA IPBA';
}
```

5. Dispatcher click: `else if (action === 'import-all') await importAllTeams();`

- [ ] **Step 4:** `npm test` verde + prova manuale `setup_rose.html` senza parametri.
- [ ] **Step 5:** Commit `feat: setup rose in modalità archivio con tutte le squadre`.

---

### Task 7: Documentazione, suite completa e push

**Files:**
- Modify: `ISTRUZIONI_ROSE.md` (sezioni: link fissi dal pannello, aggiornamento all'avvio, archivio giocatori/prestiti, setup tutti i giocatori)

- [ ] **Step 1:** Aggiornare ISTRUZIONI_ROSE.md con il nuovo flusso (pannello → SALVA MODIFICHE → registry; avvio server → rose aggiornate; prestiti automatici; foto per giocatore condivise).
- [ ] **Step 2:** `npm test` completo → tutto verde.
- [ ] **Step 3:** Avvio manuale `node server.js 9077` → verificare log `[ROSE] …` con registry presente.
- [ ] **Step 4:** Commit `docs: istruzioni archivio giocatori` e `git push`.
