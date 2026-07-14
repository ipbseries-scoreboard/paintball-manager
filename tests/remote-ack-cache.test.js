'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const control = fs.readFileSync(path.resolve(__dirname, '..', 'index.html'), 'utf8');
const sourceStart = control.indexOf("const REMOTE_ACK_STORAGE_KEY = 'pm_remote_ack_cache_v1'");
const loadCall = 'loadRecentRemoteAcksFromStorage();';
const sourceEnd = control.indexOf(loadCall, sourceStart);

assert.ok(sourceStart >= 0 && sourceEnd > sourceStart, 'cache ACK source not found');

const cacheSource = control.slice(sourceStart, sourceEnd + loadCall.length) + `
globalThis.cacheApi = {
    rememberRemoteAck,
    getRecentRemoteAck,
    loadRecentRemoteAcksFromStorage,
    recentRemoteCommandIds
};`;

function createStorage() {
    const values = new Map();
    return {
        getItem(key) { return values.has(key) ? values.get(key) : null; },
        setItem(key, value) { values.set(key, String(value)); },
        removeItem(key) { values.delete(key); }
    };
}

function createCache(storage, room = 'IPBA-TEST') {
    const context = {
        state: { settings: { matchId: room } },
        localStorage: storage,
        console: { warn() { } },
        readJsonStorage(key, fallback) {
            try {
                const raw = storage.getItem(key);
                return raw ? JSON.parse(raw) : fallback;
            } catch (error) {
                return fallback;
            }
        }
    };
    vm.runInNewContext(cacheSource, context);
    return context;
}

test('recent accepted command ACK survives a Regia takeover in the same room', () => {
    const storage = createStorage();
    const first = createCache(storage);
    first.cacheApi.rememberRemoteAck('command-1', {
        type: 'COMMAND_ACK',
        commandId: 'command-1',
        accepted: true,
        message: 'Comando eseguito',
        receivedAt: Date.now(),
        _cacheControlToken: '123456'
    });

    const replacement = createCache(storage);
    const ack = replacement.cacheApi.getRecentRemoteAck({
        commandId: 'command-1',
        controlToken: '123456'
    });

    assert.equal(ack.accepted, true);
    assert.equal(ack.commandId, 'command-1');

    replacement.state.settings.matchId = 'IPBA-OTHER';
    assert.equal(replacement.cacheApi.getRecentRemoteAck({
        commandId: 'command-1',
        controlToken: '123456'
    }), null);
});

test('a cached PIN rejection can be retried with corrected credentials', () => {
    const storage = createStorage();
    const first = createCache(storage);
    first.cacheApi.rememberRemoteAck('command-2', {
        type: 'COMMAND_ACK',
        commandId: 'command-2',
        accepted: false,
        message: 'PIN controllo non valido',
        receivedAt: Date.now(),
        _cacheControlToken: '000000'
    });

    const replacement = createCache(storage);
    assert.equal(replacement.cacheApi.getRecentRemoteAck({
        commandId: 'command-2',
        controlToken: '000000'
    }).accepted, false);
    assert.equal(replacement.cacheApi.getRecentRemoteAck({
        commandId: 'command-2',
        controlToken: '123456'
    }), null);
});
