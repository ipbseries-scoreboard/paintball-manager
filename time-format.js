(function (root, factory) {
    const api = factory();
    if (typeof module === 'object' && module.exports) module.exports = api;
    root.PMTimeFormat = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
    'use strict';

    function mmss(value, fallback = '00:00') {
        if (typeof value === 'number' && Number.isFinite(value)) {
            const total = Math.max(0, Math.floor(value));
            const minutes = Math.floor(total / 60);
            const seconds = total % 60;
            return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
        }

        const raw = String(value == null ? '' : value).trim();
        if (!raw) return fallback;

        const clock = raw.match(/^(\d+):(\d{1,2})(?:[.,]\d+)?$/);
        if (clock) {
            return `${String(parseInt(clock[1], 10)).padStart(2, '0')}:${String(parseInt(clock[2], 10)).padStart(2, '0')}`;
        }

        if (/^\d+(?:[.,]\d+)?$/.test(raw)) {
            const numeric = Number(raw.replace(',', '.'));
            if (Number.isFinite(numeric)) return mmss(numeric, fallback);
        }

        return fallback;
    }

    return Object.freeze({ mmss });
});
