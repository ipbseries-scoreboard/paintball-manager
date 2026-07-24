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
