'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const StatVisibility = require('../stat-visibility.js');

const source = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
const start = source.indexOf('function calculateTournamentStats()');
const end = source.indexOf('function renderStats()', start);
const factory = new Function('state', 'CONFIG', 'StatVisibility', source.slice(start, end) + '; return calculateTournamentStats;');

function tournamentState(hiddenStatRounds) {
    return {
        tournament: {
            hiddenStatRounds: hiddenStatRounds || [],
            matches: [{
                teamA: 'Squadra A', teamB: 'Squadra B', phase: 'GIRONI',
                savedState: {
                    finished: true, skipped: false, scoreA: 1, scoreB: 1,
                    history: [
                        { type: 'START', time: 600 },
                        { type: 'POINT', team: 'A', time: 599 },
                        { type: 'START', time: 599 },
                        { type: 'POINT', team: 'B', time: 570 }
                    ]
                }
            }]
        }
    };
}

test('excluding an anomalous round recalculates both records and team averages', () => {
    const config = { gameTime: 600, mercyDiff: 4 };
    const normalState = tournamentState([]);
    const normal = factory(normalState, config, StatVisibility)();
    assert.equal(normal.records[0].duration, 1);
    assert.equal(normal.averageTimes.find(row => row.team === 'Squadra A').avg, 1);

    const badRoundId = normal.records[0].id;
    const correctedState = tournamentState([badRoundId]);
    const corrected = factory(correctedState, config, StatVisibility)();
    assert.equal(corrected.records[0].duration, 29);
    assert.equal(corrected.averageTimes.some(row => row.team === 'Squadra A'), false);
    assert.equal(corrected.hiddenRounds[0].id, badRoundId);
});
