'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const DoublePit = require('../double-pit.js');

function match(time, name, extra = {}) {
    return { time, phase: 'Girone C', teamA: name, teamB: `${name} B`, ...extra };
}

test('pairs matches with equivalent time formats', () => {
    const matches = [match('9.30', 'A'), match('09:30', 'C'), match('10:00', 'E')];
    DoublePit.prepare(matches);

    assert.equal(matches[0].time, '09:30');
    assert.equal(matches[1].time, '09:30');
    assert.equal(matches[0].slotId, matches[1].slotId);
    assert.notEqual(matches[1].slotId, matches[2].slotId);
    assert.equal(DoublePit.getPeerIndex(matches, 0), 1);
    assert.equal(DoublePit.getPeerIndex(matches, 1), 0);
});

test('keeps alternating even when paired rows are not adjacent', () => {
    const matches = [match('09:30', 'A'), match('10:00', 'E'), match('9.30', 'C')];
    DoublePit.prepare(matches);

    assert.equal(DoublePit.getPeerIndex(matches, 0), 2);
    matches[0].savedState = { finished: true };
    assert.equal(DoublePit.getNextPendingIndex(matches, 2), 1);
});

test('does not return a completed peer and advances to the next slot', () => {
    const matches = [
        match('09:30', 'A'),
        match('09:30', 'C', { savedState: { finished: true } }),
        match('10:00', 'E'),
        match('10:00', 'G')
    ];

    assert.equal(DoublePit.getPeerIndex(matches, 0), -1);
    assert.equal(DoublePit.getNextPendingIndex(matches, 0), 2);
});

test('splits more than two same-time matches into separate blocks', () => {
    const matches = [match('09:30', 'A'), match('09:30', 'C'), match('09:30', 'E')];
    DoublePit.prepare(matches);

    assert.equal(DoublePit.isDoubleSlot(matches, 0), true);
    assert.equal(DoublePit.isDoubleSlot(matches, 2), false);
    assert.equal(DoublePit.getPeerIndex(matches, 2), -1);
});
