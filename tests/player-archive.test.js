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
