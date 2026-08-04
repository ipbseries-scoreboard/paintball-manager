'use strict';

const assert = require('node:assert/strict');
const { once } = require('node:events');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const test = require('node:test');
const WebSocket = require('ws');

const root = path.resolve(__dirname, '..');

function freePort() {
    return new Promise((resolve, reject) => {
        const probe = net.createServer();
        probe.once('error', reject);
        probe.listen(0, '127.0.0.1', () => {
            const port = probe.address().port;
            probe.close(error => error ? reject(error) : resolve(port));
        });
    });
}

async function startRelay(t) {
    const port = await freePort();
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pm-relay-traffic-'));
    const child = spawn(process.execPath, ['server.js', String(port)], {
        cwd: root,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: {
            ...process.env,
            PM_ROSTER_DATA_DIR: dataDir,
            PM_RELAY_HOST_MSG_PER_SEC: '3',
            PM_RELAY_HOST_BYTES_PER_SEC: '256'
        }
    });
    t.after(() => {
        if (child.exitCode === null) child.kill();
        fs.rmSync(dataDir, { recursive: true, force: true });
    });
    await new Promise((resolve, reject) => {
        let output = '';
        let errors = '';
        const timer = setTimeout(() => reject(new Error('Relay non avviato: ' + errors)), 3000);
        child.stderr.on('data', chunk => { errors += chunk.toString(); });
        child.stdout.on('data', chunk => {
            output += chunk.toString();
            if (!output.includes('SERVER PAINTBALL MANAGER ATTIVO')) return;
            clearTimeout(timer);
            resolve();
        });
        child.once('exit', code => {
            clearTimeout(timer);
            reject(new Error('Relay terminato: ' + code + ' ' + errors));
        });
    });
    return 'ws://127.0.0.1:' + port + '/ws';
}

function connectHost(url, room) {
    return new Promise((resolve, reject) => {
        const ws = new WebSocket(url);
        ws.once('error', reject);
        ws.once('open', () => ws.send(JSON.stringify({
            type: 'hello',
            room,
            role: 'host',
            hostToken: 'h'.repeat(64),
            controlToken: '123456'
        })));
        ws.on('message', raw => {
            const packet = JSON.parse(raw.toString());
            if (packet.type === '_welcome') resolve(ws);
        });
    });
}

function closed(ws) {
    return new Promise(resolve => ws.once('close', (code, reason) => {
        resolve({ code, reason: reason.toString() });
    }));
}

test('anche un host di una stanza nuova e limitato per frame e byte', async t => {
    const url = await startRelay(t);

    const messageHost = await connectHost(url, 'HOST-MESSAGE-LIMIT');
    const messageClosed = closed(messageHost);
    for (let index = 0; index < 4; index += 1) {
        messageHost.send(JSON.stringify({ type: 'STATE', index }));
    }
    let result = await messageClosed;
    assert.equal(result.code, 1008);
    assert.match(result.reason, /Traffico eccessivo/);

    const byteHost = await connectHost(url, 'HOST-BYTE-LIMIT');
    const byteClosed = closed(byteHost);
    byteHost.send(JSON.stringify({ type: 'STATE', padding: 'X'.repeat(400) }));
    result = await byteClosed;
    assert.equal(result.code, 1008);
    assert.match(result.reason, /Traffico eccessivo/);
});
