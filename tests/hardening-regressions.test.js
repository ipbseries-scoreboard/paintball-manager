'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

process.env.PM_ROSTER_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'pm-hardening-'));

const fsp = fs.promises;
const Core = require('../roster-core');
const Server = require('../roster-server');

function apiPlayer(teamId, playerId, name) {
    return Core.defaultPlayer(teamId, {
        source: {
            type: 'IPBA',
            playerId: String(playerId),
            profileUrl: 'https://www.ipba.it/profilo.aspx?id=' + playerId,
            originalPhotoUrl: 'https://www.ipba.it/public/user_' + playerId + '/p.png',
            markupId: 'MARK-' + playerId
        },
        originalData: {
            fullName: name,
            number: '7',
            role: 'MID',
            age: '31'
        }
    }, 0);
}

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

test('un roster corrotto viene recuperato dal .bak senza distruggere il backup valido', async () => {
    const id = 'BACKUPT';
    const roster = Core.defaultTeam(id);
    roster.team.name = 'VERSIONE SICURA';
    await Server.saveRoster(roster);

    roster.team.name = 'VERSIONE NUOVA';
    await Server.saveRoster(roster);

    const file = path.join(Server.DATA_ROOT, 'team-' + id, 'roster.json');
    const backup = file + '.bak';
    assert.equal(JSON.parse(await fsp.readFile(backup, 'utf8')).team.name, 'VERSIONE SICURA');
    await fsp.writeFile(file, '{ json corrotto');

    const recovered = await Server.readRoster(id);
    assert.equal(recovered.team.name, 'VERSIONE SICURA');
    recovered.team.name = 'VERSIONE RECUPERATA';
    await Server.saveRoster(recovered);

    assert.equal(JSON.parse(await fsp.readFile(file, 'utf8')).team.name, 'VERSIONE RECUPERATA');
    assert.equal(JSON.parse(await fsp.readFile(backup, 'utf8')).team.name, 'VERSIONE SICURA');
});

test('players.json usa il backup e non azzera le configurazioni globali', async () => {
    const id = 'ARCHBACK';
    const roster = Core.defaultTeam(id);
    roster.players = [apiPlayer(id, 701, 'ROSSI MARIO')];
    roster.players[0].customData.displayName = 'PRIMA VERSIONE';
    await Server.saveRoster(roster, { updateArchive: true });

    roster.players[0].customData.displayName = 'SECONDA VERSIONE';
    await Server.saveRoster(roster, { updateArchive: true });
    const archive = path.join(Server.DATA_ROOT, 'players.json');
    assert.equal(
        JSON.parse(await fsp.readFile(archive + '.bak', 'utf8')).players['701'].customData.displayName,
        'PRIMA VERSIONE'
    );
    await fsp.writeFile(archive, 'non-json');

    const recovered = await Server.readRoster(id);
    assert.equal(recovered.players[0].customData.displayName, 'PRIMA VERSIONE');
    assert.equal(await fsp.readFile(archive, 'utf8'), 'non-json');
    await fsp.copyFile(archive + '.bak', archive);
});

test('il GET pubblico espone solo il modello necessario agli schermi', async t => {
    const base = await startServer(t);
    const id = 'PUBLICT';
    const roster = Core.defaultTeam(id);
    roster.players = [
        apiPlayer(id, 801, 'NOME ANAGRAFICO'),
        apiPlayer(id, 802, 'GIOCATORE NASCOSTO')
    ];
    roster.players[0].customData.displayName = 'NOME DA GARA';
    roster.players[0].customData.nickname = 'SEGRETO';
    roster.players[1].customData.visible = false;
    await Server.saveRoster(roster, { updateArchive: true });

    let response = await fetch(base + '/api/rosters/' + id + '?noImport=1');
    assert.equal(response.status, 200);
    const publicPayload = await response.json();
    assert.equal(publicPayload.visibility, 'PUBLIC');
    assert.equal(publicPayload.roster.players.length, 1);
    const publicPlayer = publicPayload.roster.players[0];
    assert.match(publicPlayer.playerKey, /^PUBLIC-[A-F0-9]{20}$/);
    assert.notEqual(publicPlayer.playerKey, roster.players[0].playerKey);
    assert.equal(publicPlayer.source.playerId, '');
    assert.equal(publicPlayer.source.profileUrl, '');
    assert.equal(publicPlayer.source.markupId, '');
    assert.equal(publicPlayer.originalData.age, '');
    assert.equal(publicPlayer.originalData.fullName, 'NOME DA GARA');
    assert.equal(publicPlayer.customData.nickname, '');

    const cookie = await loginCookie(base);
    response = await fetch(base + '/api/rosters/' + id + '?noImport=1', {
        headers: { Cookie: cookie }
    });
    const fullPayload = await response.json();
    assert.equal(fullPayload.visibility, 'FULL');
    assert.equal(fullPayload.roster.players.length, 2);
    assert.equal(fullPayload.roster.players[0].source.playerId, '801');
    assert.match(fullPayload.roster.players[0].source.profileUrl, /id=801/);
    assert.equal(fullPayload.roster.players[0].originalData.age, '31');
    assert.equal(fullPayload.roster.players[0].customData.nickname, 'SEGRETO');
});

test('upload simultanei lasciano il roster collegato a una foto esistente', async t => {
    const base = await startServer(t);
    const cookie = await loginCookie(base);
    const id = 'PHOTORACE';
    const roster = Core.defaultTeam(id);
    roster.players = [apiPlayer(id, 901, 'FOTO TEST')];
    await Server.saveRoster(roster, { updateArchive: true });
    const key = roster.players[0].playerKey;

    const png = Buffer.from(
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
        'base64'
    );
    png.writeUInt32BE(40, 16);
    png.writeUInt32BE(40, 20);
    const jpeg = Buffer.from([
        0xff, 0xd8, 0xff, 0xc0, 0x00, 0x11, 0x08, 0x00, 0x28, 0x00, 0x28,
        0x03, 0x01, 0x11, 0x00, 0x02, 0x11, 0x00, 0x03, 0x11, 0x00, 0xff, 0xd9
    ]);

    const endpoint = base + '/api/rosters/' + id + '/players/' + key + '/photo';
    const responses = await Promise.all([
        fetch(endpoint, { method: 'POST', headers: { 'Content-Type': 'image/png', Cookie: cookie }, body: png }),
        fetch(endpoint, { method: 'POST', headers: { 'Content-Type': 'image/jpeg', Cookie: cookie }, body: jpeg })
    ]);
    assert.deepEqual(responses.map(response => response.status), [200, 200]);

    const loaded = await Server.readRoster(id);
    const url = loaded.players[0].image.customImageUrl;
    const relative = decodeURIComponent(url).replace(/^data\/rosters\//, '').replace(/\//g, path.sep);
    assert.equal(fs.existsSync(path.join(Server.DATA_ROOT, relative)), true);

    const assets = path.join(Server.DATA_ROOT, 'players', 'assets');
    const active = (await fsp.readdir(assets)).filter(name => /^901\.(png|jpg|webp)$/i.test(name));
    assert.deepEqual(active, [path.basename(relative)]);
});
