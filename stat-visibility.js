(function (root, factory) {
    var api = factory();
    if (typeof module === 'object' && module.exports) module.exports = api;
    if (root) root.StatVisibility = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
    'use strict';

    var ROUND_ID_RE = /^M\d+-E\d+-(A|B)-T\d+$/;

    function makeRoundId(matchIndex, eventIndex, event) {
        var team = String(event && event.team || '').toUpperCase();
        var time = Number(event && event.time);
        if ((team !== 'A' && team !== 'B') || !Number.isFinite(time)) return '';
        var matchNo = Math.max(0, Math.floor(Number(matchIndex) || 0)) + 1;
        var eventNo = Math.max(0, Math.floor(Number(eventIndex) || 0)) + 1;
        var timeMs = Math.max(0, Math.round(time * 1000));
        return 'M' + matchNo + '-E' + eventNo + '-' + team + '-T' + timeMs;
    }

    function isRoundId(value) {
        return ROUND_ID_RE.test(String(value || ''));
    }

    function normalizeIds(value, maxItems) {
        var limit = Math.max(1, Math.min(2000, Number(maxItems) || 500));
        var seen = Object.create(null);
        var result = [];
        if (!Array.isArray(value)) return result;
        value.forEach(function (item) {
            var id = String(item || '');
            if (!isRoundId(id) || seen[id] || result.length >= limit) return;
            seen[id] = true;
            result.push(id);
        });
        return result;
    }

    return {
        makeRoundId: makeRoundId,
        isRoundId: isRoundId,
        normalizeIds: normalizeIds
    };
});
