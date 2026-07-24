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
        Promise.resolve(Server.handleRosterApi(req, res, url)).catch(error => {
            res.writeHead(500);
            res.end(error.message);
        });
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    t.after(() => new Promise(resolve => server.close(resolve)));
    return 'http://127.0.0.1:' + server.address().port;
}

async function loginCookie(base) {
    const password = Server.getSetupAuthInfo().generatedPassword || process.env.PM_ROSTER_PASSWORD;
    const response = await fetch(base + '/api/rosters/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password })
    });
    assert.equal(response.status, 200);
    return String(response.headers.get('set-cookie') || '').split(';')[0];
}

test('registry: POST valida, estrae gli id IPBA e GET lo restituisce', async t => {
    const base = await startServer(t);
    let response = await fetch(base + '/api/rosters/registry', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
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
    assert.equal(loaded.teams[0].teamId, '77');
    assert.ok(fs.existsSync(path.join(Server.DATA_ROOT, 'registry.json')));

    // Un salvataggio dal pannello senza URL non deve cancellare un URL già noto.
    response = await fetch(base + '/api/rosters/registry', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ teams: [{ name: 'PD SaYnts', rosterUrl: '', logoUrl: '' }] })
    });
    const merged = await response.json();
    assert.equal(merged.teams[0].rosterUrl, 'https://www.ipba.it/video-team-giocatori.aspx?id=77');
    assert.equal(merged.teams[0].teamId, '77');

    // Le squadre note solo al registry (con link valido) sopravvivono a un
    // salvataggio del pannello che non le contiene.
    response = await fetch(base + '/api/rosters/registry', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ teams: [{ name: 'Altra Squadra', rosterUrl: '', logoUrl: '' }] })
    });
    const union = await response.json();
    assert.deepEqual(union.teams.map(team => team.name).sort(), ['Altra Squadra', 'PD SaYnts']);
    assert.equal(union.teams.find(team => team.name === 'PD SaYnts').teamId, '77');
});

function apiPlayer(teamId, pid, name, number) {
    return Core.defaultPlayer(teamId, {
        source: { type: 'IPBA', playerId: String(pid), originalPhotoUrl: 'https://www.ipba.it/public/user_' + pid + '/p.png' },
        originalData: { fullName: name, number: String(number), role: 'MID' }
    }, 0);
}

test('prestito: la configurazione del giocatore segue il playerId nella nuova squadra', async t => {
    const base = await startServer(t);
    const cookie = await loginCookie(base);
    const idX = 'LOANX';
    const idY = 'LOANY';
    const rosterX = Core.defaultTeam(idX);
    rosterX.players = [apiPlayer(idX, 909, 'VERDI PAOLO', 10)];
    rosterX.players[0].customData.displayName = 'IL MURO';
    rosterX.players[0].customData.number = '99';
    rosterX.players[0].image.scale = 1.4;
    let response = await fetch(base + '/api/rosters/' + idX, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Cookie: cookie },
        body: JSON.stringify(rosterX)
    });
    assert.equal(response.status, 200);

    // La rosa Y arriva da un import: salvataggio interno SENZA updateArchive.
    const rosterY = Core.defaultTeam(idY);
    rosterY.players = [apiPlayer(idY, 909, 'VERDI PAOLO', 10)];
    rosterY.players[0].customData.order = 5;
    await Server.saveRoster(rosterY);

    response = await fetch(base + '/api/rosters/' + idY + '?noImport=1');
    const loaded = (await response.json()).roster;
    assert.equal(loaded.players[0].customData.displayName, 'IL MURO');
    assert.equal(loaded.players[0].customData.number, '99');
    assert.equal(loaded.players[0].image.scale, 1.4);
    assert.equal(loaded.players[0].customData.order, 5);
});

test('l\'import interno non azzera l\'archivio con i default', () => {
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
    roster.players = [Core.defaultPlayer(id, {
        source: { type: 'MANUAL' },
        originalData: { fullName: 'MANUALE UNO', number: '1' }
    }, 0)];
    roster.players[0].customData.displayName = 'SOLO QUI';
    const response = await fetch(base + '/api/rosters/' + id, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Cookie: cookie },
        body: JSON.stringify(roster)
    });
    assert.equal(response.status, 200);
    const archive = JSON.parse(fs.readFileSync(path.join(Server.DATA_ROOT, 'players.json'), 'utf8'));
    const values = Object.keys(archive.players).map(key => archive.players[key].customData.displayName);
    assert.equal(values.includes('SOLO QUI'), false);
});

test('la foto di un giocatore IPBA è condivisa tra le squadre e la cancellazione vale ovunque', async t => {
    const base = await startServer(t);
    const cookie = await loginCookie(base);
    const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64');
    png.writeUInt32BE(40, 16);
    png.writeUInt32BE(40, 20);
    const keyX = 'TEAM-LOANX_PLAYER-909';
    let response = await fetch(base + '/api/rosters/LOANX/players/' + keyX + '/photo', {
        method: 'POST',
        headers: { 'Content-Type': 'image/png', 'X-Image-Transparency': '1', Cookie: cookie },
        body: png
    });
    assert.equal(response.status, 200);
    const photo = await response.json();
    assert.match(photo.url, /^data\/rosters\/players\/assets\/909\.png$/);
    assert.ok(fs.existsSync(path.join(Server.DATA_ROOT, 'players', 'assets', '909.png')));
    response = await fetch(base + '/api/rosters/LOANY?noImport=1');
    assert.equal((await response.json()).roster.players[0].image.customImageUrl, photo.url);
    response = await fetch(base + '/api/rosters/LOANY/players/TEAM-LOANY_PLAYER-909/photo', {
        method: 'DELETE',
        headers: { Cookie: cookie }
    });
    assert.equal(response.status, 200);
    assert.equal(fs.existsSync(path.join(Server.DATA_ROOT, 'players', 'assets', '909.png')), false);
    response = await fetch(base + '/api/rosters/LOANX?noImport=1');
    assert.equal((await response.json()).roster.players[0].image.customImageUrl, '');
});

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

test('streaming sincronizza il registry e offre il setup di tutti i giocatori', () => {
    const streaming = fs.readFileSync(path.join(__dirname, '..', 'streaming.html'), 'utf8');
    assert.match(streaming, /api\/rosters\/registry/);
    assert.match(streaming, /SETUP TUTTI I GIOCATORI/);
});

test('streaming usa il registry come fallback quando il pannello non ha URL Rosa', () => {
    const streaming = fs.readFileSync(path.join(__dirname, '..', 'streaming.html'), 'utf8');
    assert.match(streaming, /registryUrlForTeam/);
    assert.match(streaming, /rosterRegistryTeams/);
});

test('fresh=1 riscarica da IPBA una rosa vecchia ma non una appena aggiornata', async t => {
    const base = await startServer(t);
    const id = 'FRESHT';
    const roster = Core.defaultTeam(id);
    roster.players = [apiPlayer(id, 777, 'FRESCHI RINO', 8)];
    roster.sourceUpdatedAt = 0; // mai letta da IPBA: da riscaricare
    await Server.saveRoster(roster);

    const originalImport = Server.importRoster;
    const calls = [];
    Server.importRoster = async teamId => {
        calls.push(teamId);
        const updated = Core.defaultTeam(teamId);
        updated.team.name = 'AGGIORNATA DA IPBA';
        updated.players = [apiPlayer(teamId, 777, 'FRESCHI RINO', 8)];
        updated.sourceUpdatedAt = Date.now();
        return Server.saveRoster(updated);
    };
    t.after(() => { Server.importRoster = originalImport; });

    // Senza fresh: serve la copia locale, nessun contatto con IPBA.
    let response = await fetch(base + '/api/rosters/' + id + '?noImport=1');
    assert.equal((await response.json()).roster.team.name, 'TEAM ' + id);
    assert.equal(calls.length, 0);

    // Con fresh e dati vecchi: re-import.
    response = await fetch(base + '/api/rosters/' + id + '?fresh=1');
    assert.equal((await response.json()).roster.team.name, 'AGGIORNATA DA IPBA');
    assert.deepEqual(calls, [id]);

    // Con fresh ma dati appena letti: nessun nuovo re-import (throttle).
    response = await fetch(base + '/api/rosters/' + id + '?fresh=1');
    assert.equal(response.status, 200);
    assert.equal(calls.length, 1);
});

test('un errore IPBA durante il fresh non interrompe la diretta', async t => {
    const base = await startServer(t);
    const id = 'FRESHE';
    const roster = Core.defaultTeam(id);
    roster.team.name = 'COPIA LOCALE';
    roster.players = [apiPlayer(id, 778, 'LOCALE PINO', 9)];
    roster.sourceUpdatedAt = 0;
    await Server.saveRoster(roster);

    const originalImport = Server.importRoster;
    Server.importRoster = async () => { throw new Error('IPBA HTTP 500'); };
    t.after(() => { Server.importRoster = originalImport; });

    const response = await fetch(base + '/api/rosters/' + id + '?fresh=1');
    assert.equal(response.status, 200);
    assert.equal((await response.json()).roster.team.name, 'COPIA LOCALE');
});

test('la pagina rose chiede dati freschi all\'apertura e su AGGIORNA ROSE', () => {
    const lineup = fs.readFileSync(path.join(__dirname, '..', 'roster-lineup.html'), 'utf8');
    const storage = fs.readFileSync(path.join(__dirname, '..', 'roster-storage.js'), 'utf8');
    assert.match(storage, /fresh=1/);
    assert.match(lineup, /fresh:\s*true/);
});

test('setup rose espone la modalità archivio con tutte le squadre del registry', () => {
    const setup = fs.readFileSync(path.join(__dirname, '..', 'setup_rose.html'), 'utf8');
    assert.match(setup, /api\/rosters\/registry/);
    assert.match(setup, /AGGIORNA TUTTE DA IPBA/);
    assert.match(setup, /registryMode/);
});

test('anche il setup chiede dati freschi quando apre una squadra', () => {
    const setup = fs.readFileSync(path.join(__dirname, '..', 'setup_rose.html'), 'utf8');
    assert.match(setup, /fresh:\s*true/);
});
