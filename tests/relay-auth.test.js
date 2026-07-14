'use strict';

const assert = require('node:assert/strict');
const { once } = require('node:events');
const http = require('node:http');
const net = require('node:net');
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
            probe.close((error) => error ? reject(error) : resolve(port));
        });
    });
}

function waitForPacket(client, predicate, timeoutMs = 2000) {
    const existing = client.packets.find(predicate);
    if (existing) return Promise.resolve(existing);
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
            client.ws.off('message', onMessage);
            reject(new Error('Timeout messaggio relay'));
        }, timeoutMs);
        function onMessage(raw) {
            const packet = JSON.parse(raw.toString());
            if (!predicate(packet)) return;
            clearTimeout(timer);
            client.ws.off('message', onMessage);
            resolve(packet);
        }
        client.ws.on('message', onMessage);
    });
}

function connect(url, hello) {
    return new Promise((resolve, reject) => {
        const ws = new WebSocket(url);
        const client = { ws, packets: [] };
        const timer = setTimeout(() => reject(new Error('Timeout connessione relay')), 2500);
        ws.once('error', reject);
        ws.once('open', () => ws.send(JSON.stringify({ type: 'hello', ...hello })));
        ws.on('message', (raw) => {
            const packet = JSON.parse(raw.toString());
            client.packets.push(packet);
            if (packet.type !== '_welcome' && packet.type !== '_authError') return;
            clearTimeout(timer);
            resolve({ client, packet });
        });
    });
}

function httpStatus(port, requestPath) {
    return new Promise((resolve, reject) => {
        const request = http.request({ host: '127.0.0.1', port, path: requestPath }, (response) => {
            response.resume();
            resolve(response.statusCode);
        });
        request.once('error', reject);
        request.end();
    });
}

async function closeClient(client) {
    if (!client || client.ws.readyState === WebSocket.CLOSED) return;
    const closed = once(client.ws, 'close');
    client.ws.close();
    await closed;
}

function waitForSocketClose(ws, timeoutMs = 2500) {
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
            ws.off('close', onClose);
            reject(new Error('Timeout chiusura WebSocket'));
        }, timeoutMs);
        function onClose(code, reason) {
            clearTimeout(timer);
            resolve({ code, reason: reason.toString() });
        }
        ws.once('close', onClose);
    });
}

function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

async function startRelay(t, environment = {}) {
    const port = await freePort();
    const child = spawn(process.execPath, ['server.js', String(port)], {
        cwd: root,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env, ...environment }
    });
    t.after(() => { if (child.exitCode === null) child.kill(); });

    await new Promise((resolve, reject) => {
        let stdout = '';
        let stderr = '';
        const timer = setTimeout(() => reject(new Error('Server relay non avviato: ' + stderr)), 3000);
        child.once('exit', (code) => {
            clearTimeout(timer);
            reject(new Error('Server relay terminato: ' + code + ' ' + stderr));
        });
        child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
        child.stdout.on('data', (chunk) => {
            stdout += chunk.toString();
            if (!stdout.includes('SERVER PAINTBALL MANAGER ATTIVO')) return;
            clearTimeout(timer);
            resolve();
        });
    });

    return { child, port, url: `ws://127.0.0.1:${port}/ws` };
}

test('relay enforces controller permissions and host ownership', async (t) => {
    const { port, url } = await startRelay(t);
    assert.equal(await httpStatus(port, '/index.html'), 200);
    assert.equal(await httpStatus(port, '/..%5cpackage.json'), 403);
    assert.equal(await httpStatus(port, '/ipba?url=file%3A%2F%2F%2Fetc%2Fpasswd'), 400);

    const invalidControlRoom = await connect(url, { room: 'IPBA-\nBAD', role: 'viewer' });
    assert.equal(invalidControlRoom.packet.type, '_authError');
    assert.equal(invalidControlRoom.packet.code, 'ROOM_INVALID');
    const invalidLongRoom = await connect(url, { room: 'X'.repeat(81), role: 'viewer' });
    assert.equal(invalidLongRoom.packet.type, '_authError');
    assert.equal(invalidLongRoom.packet.code, 'ROOM_INVALID');
    const invalidNonStringRoom = await connect(url, { room: 12345, role: 'viewer' });
    assert.equal(invalidNonStringRoom.packet.type, '_authError');
    assert.equal(invalidNonStringRoom.packet.code, 'ROOM_INVALID');

    const room = 'IPBA-RELAY-TEST';
    const hostToken = 'a'.repeat(64);
    const host = await connect(url, { room, role: 'host', hostToken, controlToken: '654321' });
    assert.equal(host.packet.type, '_welcome');

    const viewer = await connect(url, { room, role: 'viewer' });
    assert.equal(viewer.packet.type, '_welcome');
    const controller = await connect(url, { room, role: 'controller', token: '654321' });
    assert.equal(controller.packet.type, '_welcome');
    const wrongController = await connect(url, { room, role: 'controller', token: '111111' });
    assert.equal(wrongController.packet.type, '_authError');
    assert.equal(wrongController.packet.code, 'CONTROL_TOKEN_INVALID');

    viewer.client.ws.send(JSON.stringify({ type: 'PAUSE' }));
    await new Promise((resolve) => setTimeout(resolve, 80));
    assert.equal(host.client.packets.some((packet) => packet.type === 'PAUSE'), false);

    viewer.client.ws.send(JSON.stringify({ type: 'requestState', marker: 'first' }));
    await waitForPacket(host.client, (packet) => packet.type === 'requestState' && packet.marker === 'first');
    viewer.client.ws.send(JSON.stringify({ type: 'requestState', marker: 'throttled' }));
    await sleep(120);
    assert.equal(host.client.packets.some((packet) => packet.marker === 'throttled'), false);
    await sleep(1450);
    viewer.client.ws.send(JSON.stringify({ type: 'requestState', marker: 'after-throttle' }));
    await waitForPacket(host.client, (packet) => packet.type === 'requestState' && packet.marker === 'after-throttle');

    controller.client.ws.send(JSON.stringify({ type: 'PAUSE', controlToken: '654321' }));
    await waitForPacket(host.client, (packet) => packet.type === 'PAUSE');

    // Anche una stanza inizializzata rimasta completamente vuota conserva la
    // proprietÃ : solo lo stesso hostToken puÃ² riaprire quel Match ID.
    await Promise.all([closeClient(viewer.client), closeClient(controller.client)]);
    await closeClient(host.client);
    const fakeHost = await connect(url, {
        room,
        role: 'host',
        hostToken: 'b'.repeat(64),
        controlToken: '654321'
    });
    assert.equal(fakeHost.packet.type, '_authError');
    assert.equal(fakeHost.packet.code, 'HOST_TOKEN_INVALID');

    const recoveredOriginal = await connect(url, {
        room,
        role: 'host',
        hostToken,
        controlToken: '654321'
    });
    assert.equal(recoveredOriginal.packet.type, '_welcome');

    // Uno schermo puÃ² restare in attesa prima dell'avvio della Regia: la
    // stanza non va ripulita finchÃ© quel viewer Ã¨ ancora collegato.
    const waitingRoom = 'IPBA-WAITING-VIEWER';
    const waitingViewer = await connect(url, { room: waitingRoom, role: 'viewer' });
    assert.equal(waitingViewer.packet.type, '_welcome');
    assert.equal(waitingViewer.packet.hostOnline, false);
    const lateHost = await connect(url, {
        room: waitingRoom,
        role: 'host',
        hostToken: 'e'.repeat(64),
        controlToken: '555555'
    });
    assert.equal(lateHost.packet.type, '_welcome');
    await waitForPacket(waitingViewer.client, (packet) => packet.type === '_hostOnline');
    waitingViewer.client.ws.send(JSON.stringify({ type: 'requestState', marker: 'waiting-viewer' }));
    await waitForPacket(lateHost.client, (packet) => packet.type === 'requestState' && packet.marker === 'waiting-viewer');

    const rateRoom = 'IPBA-RATE-TEST';
    const rateHost = await connect(url, {
        room: rateRoom,
        role: 'host',
        hostToken: 'c'.repeat(64),
        controlToken: '222222'
    });
    assert.equal(rateHost.packet.type, '_welcome');
    for (let attempt = 0; attempt < 8; attempt += 1) {
        const rejected = await connect(url, {
            room: rateRoom,
            role: 'controller',
            token: String(300000 + attempt)
        });
        assert.equal(rejected.packet.type, '_authError');
        assert.equal(rejected.packet.code, 'CONTROL_TOKEN_INVALID');
    }
    const limited = await connect(url, { room: rateRoom, role: 'controller', token: '222222' });
    assert.equal(limited.packet.type, '_authError');
    assert.equal(limited.packet.code, 'AUTH_RATE_LIMIT');

    // Gli errori del controller non devono bloccare la Regia legittima che
    // arriva dallo stesso indirizzo (caso comune quando si prova tutto sul PC
    // Regia), nÃ© un controller autenticato di un'altra stanza.
    const hostAfterControllerFailures = await connect(url, {
        room: rateRoom,
        role: 'host',
        hostToken: 'c'.repeat(64),
        controlToken: '222222'
    });
    assert.equal(hostAfterControllerFailures.packet.type, '_welcome');

    const otherRoom = 'IPBA-RATE-OTHER';
    const otherHost = await connect(url, {
        room: otherRoom,
        role: 'host',
        hostToken: 'd'.repeat(64),
        controlToken: '444444'
    });
    assert.equal(otherHost.packet.type, '_welcome');
    const otherController = await connect(url, {
        room: otherRoom,
        role: 'controller',
        token: '444444'
    });
    assert.equal(otherController.packet.type, '_welcome');

    await Promise.all([
        closeClient(invalidControlRoom.client),
        closeClient(invalidLongRoom.client),
        closeClient(invalidNonStringRoom.client),
        closeClient(viewer.client),
        closeClient(controller.client),
        closeClient(wrongController.client),
        closeClient(fakeHost.client),
        closeClient(recoveredOriginal.client),
        closeClient(waitingViewer.client),
        closeClient(lateHost.client),
        closeClient(rateHost.client),
        closeClient(limited.client),
        closeClient(hostAfterControllerFailures.client),
        closeClient(otherHost.client),
        closeClient(otherController.client)
    ]);
});

test('relay bounds payloads, idle sockets, rooms and connections', async (t) => {
    const { url } = await startRelay(t, {
        PM_RELAY_MAX_PAYLOAD: '2048',
        PM_RELAY_MAX_CONNECTIONS: '32',
        PM_RELAY_MAX_CONNECTIONS_PER_IP: '4',
        PM_RELAY_MAX_CLIENTS_PER_ROOM: '2',
        PM_RELAY_MAX_ROOMS: '2',
        PM_RELAY_HELLO_TIMEOUT_MS: '250',
        PM_RELAY_PING_INTERVAL_MS: '100'
    });

    const oversized = new WebSocket(url);
    const oversizedClosed = waitForSocketClose(oversized);
    await once(oversized, 'open');
    oversized.send('X'.repeat(4096));
    assert.equal((await oversizedClosed).code, 1009);

    const idle = new WebSocket(url);
    const idleClosed = waitForSocketClose(idle);
    await once(idle, 'open');
    assert.equal((await idleClosed).code, 1008);

    // Il ping/pong elimina una connessione autenticata che smette di
    // rispondere, liberando anche la sua stanza pre-Regia.
    const staleWs = new WebSocket(url, { autoPong: false });
    const staleClient = { ws: staleWs, packets: [] };
    staleWs.on('message', (raw) => staleClient.packets.push(JSON.parse(raw.toString())));
    const staleClosed = waitForSocketClose(staleWs);
    await once(staleWs, 'open');
    staleWs.send(JSON.stringify({ type: 'hello', room: 'PING-ROOM', role: 'viewer' }));
    await waitForPacket(staleClient, (packet) => packet.type === '_welcome');
    assert.equal((await staleClosed).code, 1006);
    await sleep(40);

    // Una stanza mai inizializzata viene rimossa appena resta vuota: con un
    // massimo di due stanze, tre viewer sequenziali devono entrare tutti.
    for (const room of ['CLEAN-A', 'CLEAN-B', 'CLEAN-C']) {
        const transient = await connect(url, { room, role: 'viewer' });
        assert.equal(transient.packet.type, '_welcome');
        await closeClient(transient.client);
        await sleep(20);
    }

    const roomOneA = await connect(url, { room: 'ROOM-ONE', role: 'viewer' });
    const roomTwoA = await connect(url, { room: 'ROOM-TWO', role: 'viewer' });
    assert.equal(roomOneA.packet.type, '_welcome');
    assert.equal(roomTwoA.packet.type, '_welcome');

    const roomLimit = await connect(url, { room: 'ROOM-THREE', role: 'viewer' });
    assert.equal(roomLimit.packet.type, '_authError');
    assert.equal(roomLimit.packet.code, 'ROOM_LIMIT');
    await closeClient(roomLimit.client);

    const roomOneB = await connect(url, { room: 'ROOM-ONE', role: 'viewer' });
    assert.equal(roomOneB.packet.type, '_welcome');
    const roomFull = await connect(url, { room: 'ROOM-ONE', role: 'viewer' });
    assert.equal(roomFull.packet.type, '_authError');
    assert.equal(roomFull.packet.code, 'ROOM_FULL');
    await closeClient(roomFull.client);

    const roomTwoB = await connect(url, { room: 'ROOM-TWO', role: 'viewer' });
    assert.equal(roomTwoB.packet.type, '_welcome');

    // Quattro connessioni dallo stesso indirizzo sono ammesse; la quinta
    // riceve una chiusura temporanea (1013) prima del protocollo applicativo.
    const overIpLimit = new WebSocket(url);
    const overIpLimitClosed = waitForSocketClose(overIpLimit);
    await once(overIpLimit, 'open');
    assert.equal((await overIpLimitClosed).code, 1013);

    await Promise.all([
        closeClient(roomOneA.client),
        closeClient(roomOneB.client),
        closeClient(roomTwoA.client),
        closeClient(roomTwoB.client)
    ]);
});
