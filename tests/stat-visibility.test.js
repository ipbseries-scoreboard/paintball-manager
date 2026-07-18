'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const StatVisibility = require('../stat-visibility.js');

test('round statistic ids are stable and contain match, event, side and timer', () => {
    assert.equal(
        StatVisibility.makeRoundId(2, 4, { type: 'POINT', team: 'A', time: 598.75 }),
        'M3-E5-A-T598750'
    );
    assert.equal(StatVisibility.makeRoundId(0, 0, { team: 'X', time: 10 }), '');
    assert.equal(StatVisibility.makeRoundId(0, 0, { team: 'B', time: 'bad' }), '');
});

test('hidden statistic ids are validated, deduplicated and bounded', () => {
    const values = ['M1-E1-A-T1000', 'bad', 'M1-E1-A-T1000', 'M2-E3-B-T2500'];
    assert.deepEqual(StatVisibility.normalizeIds(values), ['M1-E1-A-T1000', 'M2-E3-B-T2500']);
    assert.equal(StatVisibility.isRoundId('M12-E8-B-T0'), true);
    assert.equal(StatVisibility.isRoundId('M12-E8-C-T0'), false);
    assert.deepEqual(StatVisibility.normalizeIds(values, 1), ['M1-E1-A-T1000']);
});
