(function (root, factory) {
    const api = factory();
    if (typeof module === 'object' && module.exports) module.exports = api;
    root.DoublePit = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
    'use strict';

    function normalizeTime(value) {
        const raw = String(value || '').trim();
        const match = raw.match(/^(\d{1,2})[.:](\d{2})/);
        if (!match) return raw;
        return `${String(parseInt(match[1], 10)).padStart(2, '0')}:${match[2]}`;
    }

    function normalizePhase(value) {
        const phase = String(value || 'GIRONI').trim().toUpperCase();
        return phase || 'GIRONI';
    }

    function isFinished(match) {
        return !!(match && match.savedState && match.savedState.finished);
    }

    /**
     * Annotates the schedule with stable double-pit slot metadata.
     * Every two matches sharing phase and normalized time form one slot.
     * The function intentionally mutates the match objects so old saved
     * tournaments are migrated as soon as they are loaded.
     */
    function prepare(matches) {
        if (!Array.isArray(matches)) return [];

        const occurrences = Object.create(null);
        const slotOrders = Object.create(null);
        let nextSlotOrder = 0;

        matches.forEach((match) => {
            if (!match) return;

            const normalizedTime = normalizeTime(match.time);
            if (normalizedTime) match.time = normalizedTime;

            const baseKey = `${normalizePhase(match.phase)}|${normalizedTime || 'NO-TIME'}`;
            const occurrence = occurrences[baseKey] || 0;
            occurrences[baseKey] = occurrence + 1;

            // A double-pit block contains at most two matches. If a source
            // contains more than two entries at the same time, start a new block.
            const pairNumber = Math.floor(occurrence / 2);
            const slotId = `${baseKey}|${pairNumber}`;
            if (slotOrders[slotId] === undefined) slotOrders[slotId] = nextSlotOrder++;

            match.slotId = slotId;
            match.slotOrder = slotOrders[slotId];
            match.slotPosition = occurrence % 2;

            const explicitPit = String(match.pit || '').trim().toUpperCase();
            match.pit = explicitPit === 'A' || explicitPit === 'B'
                ? explicitPit
                : (match.slotPosition === 0 ? 'A' : 'B');
        });

        return matches;
    }

    function getSlotIndexes(matches, index) {
        prepare(matches);
        if (!Array.isArray(matches) || !matches[index]) return [];
        const slotId = matches[index].slotId;
        const indexes = [];
        matches.forEach((match, matchIndex) => {
            if (match && match.slotId === slotId) indexes.push(matchIndex);
        });
        return indexes;
    }

    function getPeerIndex(matches, index, unfinishedOnly = true) {
        const current = Array.isArray(matches) ? matches[index] : null;
        if (!current) return -1;

        let candidates = getSlotIndexes(matches, index)
            .filter((candidateIndex) => candidateIndex !== index)
            .filter((candidateIndex) => !unfinishedOnly || !isFinished(matches[candidateIndex]));

        if (candidates.length === 0) return -1;

        // Prefer the opposite labelled pit when imported metadata is present.
        const oppositePit = current.pit === 'A' ? 'B' : (current.pit === 'B' ? 'A' : '');
        const opposite = candidates.find((candidateIndex) => matches[candidateIndex].pit === oppositePit);
        if (opposite !== undefined) return opposite;

        candidates = candidates.sort((a, b) => Math.abs(a - index) - Math.abs(b - index));
        return candidates[0];
    }

    function getNextPendingIndex(matches, index) {
        prepare(matches);
        if (!Array.isArray(matches) || !matches[index]) return -1;

        const currentSlotOrder = matches[index].slotOrder;
        let bestIndex = -1;
        let bestSlotOrder = Number.POSITIVE_INFINITY;

        matches.forEach((match, matchIndex) => {
            if (!match || isFinished(match) || match.slotOrder <= currentSlotOrder) return;
            if (match.slotOrder < bestSlotOrder || (match.slotOrder === bestSlotOrder && (bestIndex === -1 || matchIndex < bestIndex))) {
                bestSlotOrder = match.slotOrder;
                bestIndex = matchIndex;
            }
        });

        if (bestIndex !== -1) return bestIndex;

        // Se dalla pagina Programma si apre manualmente uno slot più avanti,
        // al termine bisogna recuperare il primo blocco ancora incompleto.
        // Senza questo secondo passaggio la regia può dichiarare la fine del
        // torneo e interrompere l'alternanza mentre una doppia pit è pendente.
        matches.forEach((match, matchIndex) => {
            if (!match || matchIndex === index || isFinished(match)) return;
            if (match.slotOrder < bestSlotOrder || (match.slotOrder === bestSlotOrder && (bestIndex === -1 || matchIndex < bestIndex))) {
                bestSlotOrder = match.slotOrder;
                bestIndex = matchIndex;
            }
        });

        return bestIndex;
    }

    function isDoubleSlot(matches, index) {
        return getSlotIndexes(matches, index).length === 2;
    }

    return {
        normalizeTime,
        normalizePhase,
        isFinished,
        prepare,
        getSlotIndexes,
        getPeerIndex,
        getNextPendingIndex,
        isDoubleSlot
    };
});
