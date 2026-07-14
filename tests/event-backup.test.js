'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const EventBackup = require('../event-backup.js');

class MemoryStorage {
    constructor(initial) {
        this.values = new Map(Object.entries(initial || {}).map(([key, value]) => [key, String(value)]));
        this.setCalls = [];
        this.removeCalls = [];
    }

    getItem(key) {
        return this.values.has(key) ? this.values.get(key) : null;
    }

    setItem(key, value) {
        this.setCalls.push(key);
        this.values.set(key, String(value));
    }

    removeItem(key) {
        this.removeCalls.push(key);
        this.values.delete(key);
    }
}

function json(value) {
    return JSON.stringify(value);
}

function validTeam(name) {
    return {
        name: name,
        score: 0,
        timeouts: 1,
        penalties: 0,
        techUsed: false,
        color: '#3b82f6'
    };
}

function validTournamentState() {
    return {
        tournament: {
            active: true,
            name: 'Evento',
            currentIndex: 0,
            matches: [{ time: '09:30', teamA: 'A', teamB: 'B' }]
        },
        teams: {
            A: validTeam('A'),
            B: validTeam('B')
        },
        matchLog: [],
        mode: 'PAUSED',
        timer: 327.5,
        timerMode: 'GAME',
        gameTimeRemaining: 327.5,
        basesSwapped: false,
        currentMatchEvents: [],
        pendingRotationAction: null
    };
}

function validCheckpoint() {
    return {
        savedAt: Date.UTC(2026, 6, 13),
        currentIndex: 0,
        matchKey: '09:30|A|B',
        mode: 'PAUSED',
        prevMode: 'POINT',
        timer: 327.5,
        timerMode: 'GAME',
        gameTimeRemaining: 327.5,
        basesSwapped: false,
        pendingRotationAction: null
    };
}

test('build, parse and restore complete an event backup round-trip', () => {
    const tournamentState = validTournamentState();
    tournamentState.tournament.name = 'Coppa Italia';
    tournamentState.tournament.currentIndex = 1;
    tournamentState.tournament.matches = [
        { time: '09:30', teamA: 'A', teamB: 'B' },
        { time: '09:30', teamA: 'C', teamB: 'D' }
    ];

    const checkpoint = validCheckpoint();
    checkpoint.currentIndex = 1;
    checkpoint.matchKey = '09:30|C|D';

    const sourceValues = {
        pm_tournament_state: json(tournamentState),
        pm_runtime_checkpoint: json(checkpoint),
        pm_settings: json({
            matchId: 'IPBA-1674',
            controlPin: '123456',
            pointIntervalDuration: 30,
            confirmSkipSlot: true,
            buzzerMapping: { GP0_B0: 'POINT_A' }
        }),
        pm_team_style: json({ fontSize: 80, bold: true }),
        pm_stream_clans: json([{ name: 'A', logoUrl: 'logo-a.png' }]),
        pm_host_token: json('must-not-leave-this-storage'),
        pm_leadership_lease: json({ owner: 'old-host' })
    };
    const source = new MemoryStorage(sourceValues);

    const built = EventBackup.build(source);
    assert.equal(built.format, 'IPBA_PAINTBALL_MANAGER_BACKUP');
    assert.equal(built.version, 1);
    assert.equal(built.metadata.itemCount, 5);
    assert.equal(built.metadata.matchCount, 2);
    assert.equal(built.metadata.tournamentName, 'Coppa Italia');
    assert.equal(built.metadata.hasRuntimeCheckpoint, true);
    assert.deepEqual(Object.keys(built.data), EventBackup.STORAGE_KEYS);
    assert.equal(Object.hasOwn(built.data, 'pm_host_token'), false);

    const parsed = EventBackup.parse(JSON.stringify(built));
    const target = new MemoryStorage();
    const result = EventBackup.restore(target, parsed);

    EventBackup.STORAGE_KEYS.forEach((key) => {
        assert.deepEqual(JSON.parse(target.getItem(key)), JSON.parse(sourceValues[key]));
    });
    assert.deepEqual(result.restoredKeys, EventBackup.STORAGE_KEYS);
    assert.deepEqual(result.removedKeys, []);
    assert.equal(result.matchCount, 2);
});

test('parse rejects malformed JSON, wrong format/version and invalid tournament schema', () => {
    const invalidState = validTournamentState();
    invalidState.tournament.matches = {};

    assert.throws(() => EventBackup.parse('{not-json'), /JSON illeggibile/);
    assert.throws(() => EventBackup.parse({ format: 'OTHER', version: 1, data: {} }), /formato sconosciuto/);
    assert.throws(() => EventBackup.parse({
        format: EventBackup.FORMAT,
        version: 2,
        data: {}
    }), /versione non supportata/);
    assert.throws(() => EventBackup.parse({
        format: EventBackup.FORMAT,
        version: EventBackup.VERSION,
        data: { pm_tournament_state: invalidState }
    }), /matches deve essere un array/);
    assert.throws(() => EventBackup.build(new MemoryStorage({
        pm_settings: '{broken'
    })), /pm_settings contiene JSON illeggibile/);

    const normalizedWithoutDate = EventBackup.parse({
        format: EventBackup.FORMAT,
        version: EventBackup.VERSION,
        data: {}
    });
    assert.equal(EventBackup.parse(normalizedWithoutDate).createdAt, null);
});

test('parse rejects state values that could break the control page after restore', () => {
    assert.throws(() => EventBackup.parse({
        format: EventBackup.FORMAT,
        version: EventBackup.VERSION,
        data: { pm_settings: { matchId: {} } }
    }), /pm_settings\.matchId deve essere una stringa/);

    const brokenTeamsState = validTournamentState();
    brokenTeamsState.teams = 'broken';
    assert.throws(() => EventBackup.parse({
        format: EventBackup.FORMAT,
        version: EventBackup.VERSION,
        data: { pm_tournament_state: brokenTeamsState }
    }), /pm_tournament_state\.teams deve essere un oggetto/);

    const brokenCheckpoint = validCheckpoint();
    brokenCheckpoint.timer = '327.5';
    assert.throws(() => EventBackup.parse({
        format: EventBackup.FORMAT,
        version: EventBackup.VERSION,
        data: { pm_runtime_checkpoint: brokenCheckpoint }
    }), /pm_runtime_checkpoint\.timer deve essere un numero finito/);
});

test('parse rejects prototype-pollution keys at any depth', () => {
    const malicious = '{"format":"IPBA_PAINTBALL_MANAGER_BACKUP","version":1,"data":{"pm_settings":{"__proto__":{"admin":true}}}}';
    assert.throws(() => EventBackup.parse(malicious), /chiave non sicura "__proto__"/);

    const polluted = Object.create({ inheritedAdmin: true });
    polluted.format = EventBackup.FORMAT;
    polluted.version = EventBackup.VERSION;
    polluted.data = {};
    assert.throws(() => EventBackup.parse(polluted), /oggetto JSON semplice/);
    assert.equal({}.admin, undefined);
});

test('restore writes only the whitelist and removes an absent runtime checkpoint', () => {
    const target = new MemoryStorage({
        pm_runtime_checkpoint: json({ timer: 1 }),
        pm_host_token: 'keep-current-host-token',
        pm_leadership_lease: 'keep-current-leadership'
    });
    const tournamentState = validTournamentState();
    tournamentState.tournament.active = false;
    tournamentState.tournament.currentIndex = -1;
    tournamentState.tournament.matches = [];

    const backup = {
        format: EventBackup.FORMAT,
        version: EventBackup.VERSION,
        createdAt: '2026-07-13T12:00:00.000Z',
        data: {
            pm_tournament_state: tournamentState,
            pm_settings: { mercyDiff: 4 },
            pm_host_token: 'attacker-token',
            pm_leadership_lease: { owner: 'attacker' },
            arbitrary_key: { shouldNotBeWritten: true }
        }
    };

    const result = EventBackup.restore(target, backup);

    assert.deepEqual(target.setCalls, ['pm_tournament_state', 'pm_settings']);
    assert.deepEqual(target.removeCalls, ['pm_runtime_checkpoint']);
    assert.equal(target.getItem('pm_runtime_checkpoint'), null);
    assert.equal(target.getItem('pm_host_token'), 'keep-current-host-token');
    assert.equal(target.getItem('pm_leadership_lease'), 'keep-current-leadership');
    assert.equal(target.getItem('arbitrary_key'), null);
    assert.deepEqual(result.ignoredKeys.sort(), ['arbitrary_key', 'pm_host_token', 'pm_leadership_lease'].sort());
    assert.deepEqual(result.restoredKeys, ['pm_tournament_state', 'pm_settings']);
    assert.deepEqual(result.removedKeys, ['pm_runtime_checkpoint']);
});
