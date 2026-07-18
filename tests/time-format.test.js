'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const TimeFormat = require('../time-format.js');

test('visible clocks are always formatted as MM:SS', () => {
    assert.equal(TimeFormat.mmss(300.99), '05:00');
    assert.equal(TimeFormat.mmss(25.19), '00:25');
    assert.equal(TimeFormat.mmss('05:00.99'), '05:00');
    assert.equal(TimeFormat.mmss('0:07,50'), '00:07');
    assert.equal(TimeFormat.mmss(''), '00:00');
});

test('invalid visible clocks use the requested safe fallback', () => {
    assert.equal(TimeFormat.mmss('--:--', '--:--'), '--:--');
    assert.equal(TimeFormat.mmss(null, '--:--'), '--:--');
});
