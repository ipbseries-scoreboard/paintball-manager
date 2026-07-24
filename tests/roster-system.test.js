'use strict';

const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');
process.env.PM_ROSTER_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'pm-roster-'));

const test = require('node:test');
const assert = require('node:assert/strict');
const fsp = fs.promises;
const http = require('node:http');
const Core = require('../roster-core');
const Server = require('../roster-server');

function player(teamId, id, name, number, role, overrides) {
    return Core.defaultPlayer(teamId, Object.assign({
        source: { type: 'IPBA', playerId: String(id), originalPhotoUrl: 'https://www.ipba.it/public/user_' + id + '/profilo/thumb/p.png' },
        originalData: { fullName: name, number: String(number), role }
    }, overrides || {}), Number(id) || 0);
}

test('adaptive layouts cover 1, 3, 6, 8 and 12 players without exceeding 4 columns', () => {
    assert.deepEqual(Core.layoutSpec(1), { columns: 1, rows: 1, size: 'hero' });
    assert.equal(Core.layoutSpec(3).columns, 3);
    assert.deepEqual(Core.layoutSpec(6), { columns: 3, rows: 2, size: 'medium' });
    assert.deepEqual(Core.layoutSpec(8), { columns: 4, rows: 2, size: 'compact' });
    assert.deepEqual(Core.layoutSpec(12), { columns: 4, rows: 3, size: 'dense' });
});

test('stable keys prefer IPBA player ids and merge keeps manual customizations and photos', () => {
    const imported = Core.defaultTeam('2');
    imported.players = [player('2', 123, 'ROSSI MARIO', 7, 'MID')];
    const existing = Core.normalizeRoster(imported, '2');
    existing.players[0].customData.displayName = 'M. ROSSI';
    existing.players[0].customData.row = 'ANTERIORE';
    existing.players[0].image.customImageUrl = '/data/rosters/team-2/assets/custom.png';
    existing.players[0].image.selectedSource = 'CUSTOM';
    existing.players.push(player('2', '', 'BIANCHI LUCA', 99, 'BACK', { source: { type: 'MANUAL' } }));
    const refreshed = Core.defaultTeam('2');
    refreshed.players = [player('2', 123, 'ROSSI MARIO', 7, 'FRONT')];
    const merged = Core.mergeImported(existing, refreshed);
    assert.equal(merged.players[0].playerKey, 'TEAM-2_PLAYER-123');
    assert.equal(merged.players[0].customData.displayName, 'M. ROSSI');
    assert.equal(merged.players[0].image.selectedSource, 'CUSTOM');
    assert.equal(merged.players[0].originalData.role, 'FRONT');
    assert.equal(merged.players.filter(item => item.source.type === 'MANUAL').length, 1);
});

test('IPBA parser associates alternating left/right images with the correct player block', () => {
    const html = `<!doctype html><div style="width:550px"><table><tr><td><img src="https://www.ipba.it/public/team_42/profilo/thumb/logo.png"></td><td><h3><b>TEST TEAM</b></h3>TEST COMPANY<br><i>codice fidasc 4242</i></td></tr></table></div>
    <table><tr><td><table><tr><td><img src="https://www.ipba.it/public/user_101/profilo/thumb/a.png"></td><td><table><tr><td><b>ROSSI MARIO</b><div>7</div></td></tr><tr><td>31 anni - FRONT</td></tr></table></td></tr></table></td>
    <td><table><tr><td><table><tr><td><b>BIANCHI LUCA</b><div>88</div></td></tr><tr><td>28 anni - BACK</td></tr></table></td><td><img src="https://www.ipba.it/public/user_202/profilo/thumb/b.webp"></td></tr></table></td></tr></table>`;
    const roster = Server.parseIpbaRoster(html, '42');
    assert.equal(roster.team.name, 'TEST TEAM');
    assert.equal(roster.team.companyCode, '4242');
    assert.equal(roster.players.length, 2);
    const first = roster.players.find(item => item.source.playerId === '101');
    const second = roster.players.find(item => item.source.playerId === '202');
    assert.deepEqual([first.originalData.fullName, first.originalData.number, first.originalData.role], ['ROSSI MARIO', '7', 'FRONT']);
    assert.deepEqual([second.originalData.fullName, second.originalData.number, second.originalData.role], ['BIANCHI LUCA', '88', 'BACK']);
});

test('quality report detects limits, duplicate numbers, missing photos and missing roles', () => {
    const roster = Core.defaultTeam('Q');
    for (let i = 0; i < 13; i++) roster.players.push(player('Q', i + 1, 'GIOCATORE ' + i, i < 2 ? 7 : i, i === 3 ? '' : 'MID', i === 4 ? { source: { type: 'IPBA', playerId: '5', originalPhotoUrl: '' } } : null));
    const report = Core.qualityReport(roster);
    assert.equal(report.visible, 13);
    assert.deepEqual(report.duplicatedNumbers, ['7']);
    assert.equal(report.missing, 1);
    assert.equal(report.missingRoles, 1);
    assert.equal(report.selected, 12);
    assert.equal(report.overflow, 1);
    assert.ok(report.warnings.some(value => value.includes('primi 12')));
});

test('image validation accepts PNG headers and rejects mismatched MIME', () => {
    const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64');
    png.writeUInt32BE(40, 16); png.writeUInt32BE(50, 20);
    assert.deepEqual(Server.imageInfo(png, 'image/png'), { ext: '.png', width: 40, height: 50 });
    assert.equal(Server.imageInfo(png, 'image/jpeg'), null);
});

test('roster API saves shared configuration and player photos through safe endpoints', async t => {
    const id = 'TESTAPI' + Date.now().toString(36).toUpperCase();
    const key = 'TEAM-' + id + '_PLAYER-1';
    const roster = Core.defaultTeam(id);
    roster.team.name = 'API TEAM'; roster.players = [player(id, 1, 'API PLAYER', 1, 'MID')];
    const server = http.createServer((req, res) => {
        const url = new URL(req.url, 'http://127.0.0.1');
        Promise.resolve(Server.handleRosterApi(req, res, url)).catch(error => { res.writeHead(500); res.end(error.message); });
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const base = 'http://127.0.0.1:' + server.address().port;
    const dir = path.join(Server.DATA_ROOT, 'team-' + id);
    t.after(async () => { await new Promise(resolve => server.close(resolve)); const resolved = path.resolve(dir); assert.ok(resolved.startsWith(path.resolve(Server.DATA_ROOT) + path.sep)); await fsp.rm(resolved, { recursive: true, force: true }); });
    let response = await fetch(base + '/api/rosters/' + id, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(roster) });
    assert.equal(response.status, 401);
    const authInfo = Server.getSetupAuthInfo();
    const password = authInfo.generatedPassword || process.env.PM_ROSTER_PASSWORD;
    response = await fetch(base + '/api/rosters/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password })
    });
    assert.equal(response.status, 200);
    const cookie = String(response.headers.get('set-cookie') || '').split(';')[0];
    assert.match(cookie, /^pm_roster_session=/);
    response = await fetch(base + '/api/rosters/' + id, { method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookie }, body: JSON.stringify(roster) });
    assert.equal(response.status, 200);
    response = await fetch(base + '/api/rosters/' + id + '?noImport=1');
    const loaded = await response.json();
    assert.equal(loaded.roster.team.name, 'API TEAM');
    const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64');
    png.writeUInt32BE(40, 16); png.writeUInt32BE(40, 20);
    response = await fetch(base + '/api/rosters/' + id + '/players/' + key + '/photo', { method: 'POST', headers: { 'Content-Type': 'image/png', 'X-Image-Transparency': '1', Cookie: cookie }, body: png });
    const photo = await response.json();
    assert.equal(response.status, 200); assert.match(photo.url, /^data\/rosters\//); assert.equal(fs.existsSync(path.join(dir, 'assets', key + '.png')), true);
    response = await fetch(base + '/api/rosters/' + id + '/players/' + key + '/photo', { method: 'DELETE', headers: { Cookie: cookie } });
    assert.equal(response.status, 200); assert.equal(fs.existsSync(path.join(dir, 'assets', key + '.png')), false);
});

test('roster pages and Streaming expose dual controls, half-bust crop and transparent mode', () => {
    const lineup = fs.readFileSync(path.join(__dirname, '..', 'roster-lineup.html'), 'utf8');
    const setup = fs.readFileSync(path.join(__dirname, '..', 'setup_rose.html'), 'utf8');
    const streaming = fs.readFileSync(path.join(__dirname, '..', 'streaming.html'), 'utf8');
    assert.match(lineup, /idA/); assert.match(lineup, /idB/); assert.match(lineup, /SHOW_BOTH_TEAMS/); assert.match(lineup, /background:\s*transparent\s*!important/);
    assert.match(lineup, /single-mode/); assert.match(lineup, /MAX_VISIBLE_PLAYERS|pagePlayers/); assert.match(lineup, /FOTO|portrait/);
    assert.match(setup, /setup-password/); assert.match(setup, /MEZZO BUSTO/); assert.match(setup, /CARICA FOTO SCONTORNATA/); assert.match(setup, /TRASPARENZA RILEVATA: SÌ/);
    assert.match(streaming, /SETUP ROSA A/); assert.match(streaming, /MOSTRA ENTRAMBE LE ROSE/); assert.match(streaming, /setup_rose\.html/); assert.match(streaming, /roster-lineup\.html/);
});
