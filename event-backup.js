(function (root, factory) {
    const api = factory();
    if (typeof module === 'object' && module.exports) module.exports = api;
    root.EventBackup = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
    'use strict';

    const FORMAT = 'IPBA_PAINTBALL_MANAGER_BACKUP';
    const VERSION = 1;
    const STORAGE_KEYS = Object.freeze([
        'pm_tournament_state',
        'pm_runtime_checkpoint',
        'pm_settings',
        'pm_team_style',
        'pm_stream_clans'
    ]);
    const ALLOWED_KEYS = new Set(STORAGE_KEYS);
    const DANGEROUS_KEYS = new Set(['__proto__', 'prototype', 'constructor']);

    function fail(message) {
        throw new Error('Backup evento non valido: ' + message);
    }

    function hasOwn(value, key) {
        return Object.prototype.hasOwnProperty.call(value, key);
    }

    function isPlainObject(value) {
        if (!value || Object.prototype.toString.call(value) !== '[object Object]') return false;
        const proto = Object.getPrototypeOf(value);
        return proto === Object.prototype || proto === null;
    }

    function cloneJsonValue(value, path, ancestors) {
        if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
        if (typeof value === 'number') {
            if (!Number.isFinite(value)) fail(path + ' contiene un numero non finito');
            return value;
        }
        if (typeof value !== 'object') fail(path + ' contiene un valore non JSON');
        if (ancestors.has(value)) fail(path + ' contiene un riferimento circolare');

        ancestors.add(value);
        let copy;
        if (Array.isArray(value)) {
            copy = value.map((item, index) => cloneJsonValue(item, path + '[' + index + ']', ancestors));
        } else {
            if (!isPlainObject(value)) fail(path + ' deve essere un oggetto JSON semplice');
            copy = {};
            Object.keys(value).forEach((key) => {
                if (DANGEROUS_KEYS.has(key)) fail(path + ' contiene la chiave non sicura "' + key + '"');
                copy[key] = cloneJsonValue(value[key], path + '.' + key, ancestors);
            });
        }
        ancestors.delete(value);
        return copy;
    }

    function cloneSafe(value, path) {
        return cloneJsonValue(value, path || 'backup', new Set());
    }

    function requireObject(value, path) {
        if (!isPlainObject(value)) fail(path + ' deve essere un oggetto');
    }

    function requireArray(value, path) {
        if (!Array.isArray(value)) fail(path + ' deve essere un array');
    }

    function validateStringField(object, key, path, options) {
        if (!hasOwn(object, key)) return;
        const value = object[key];
        options = options || {};
        if (value === null && options.allowNull) return;
        if (typeof value !== 'string') fail(path + '.' + key + ' deve essere una stringa');
        if (options.pattern && !options.pattern.test(value)) fail(path + '.' + key + ' non valido');
        if (options.maxLength && value.length > options.maxLength) fail(path + '.' + key + ' troppo lungo');
    }

    function validateBooleanField(object, key, path) {
        if (hasOwn(object, key) && typeof object[key] !== 'boolean') {
            fail(path + '.' + key + ' deve essere booleano');
        }
    }

    function validateNumberField(object, key, path, min, max, integer) {
        if (!hasOwn(object, key)) return;
        const value = object[key];
        if (typeof value !== 'number' || !Number.isFinite(value)) {
            fail(path + '.' + key + ' deve essere un numero finito');
        }
        if (integer && !Number.isInteger(value)) fail(path + '.' + key + ' deve essere un intero');
        if (value < min || value > max) fail(path + '.' + key + ' fuori intervallo');
    }

    function requireField(object, key, path) {
        if (!hasOwn(object, key)) fail(path + '.' + key + ' mancante');
    }

    function validateObjectField(object, key, path, allowNull) {
        if (!hasOwn(object, key)) return;
        if (object[key] === null && allowNull) return;
        requireObject(object[key], path + '.' + key);
    }

    function validateArrayField(object, key, path, objectItems) {
        if (!hasOwn(object, key)) return;
        requireArray(object[key], path + '.' + key);
        if (objectItems) {
            object[key].forEach((item, index) => requireObject(item, path + '.' + key + '[' + index + ']'));
        }
    }

    function validatePendingRotation(value, path) {
        if (value === null) return;
        requireObject(value, path);
        validateStringField(value, 'type', path, { maxLength: 64 });
        validateBooleanField(value, 'swapSide', path);
        validateNumberField(value, 'dueAt', path, 0, Number.MAX_SAFE_INTEGER, true);
    }

    function validateTeam(team, path) {
        requireObject(team, path);
        requireField(team, 'name', path);
        validateStringField(team, 'name', path, { maxLength: 500 });
        ['score', 'penalties', 'timeouts'].forEach((key) => {
            validateNumberField(team, key, path, 0, 1000000, false);
        });
        validateBooleanField(team, 'techUsed', path);
        validateStringField(team, 'color', path, { maxLength: 100 });
        if (hasOwn(team, 'lastPenalty') && team.lastPenalty !== null) {
            requireObject(team.lastPenalty, path + '.lastPenalty');
            validateStringField(team.lastPenalty, 'type', path + '.lastPenalty', { maxLength: 100 });
            validateNumberField(team.lastPenalty, 'level', path + '.lastPenalty', 0, 1000000, false);
            validateNumberField(team.lastPenalty, 'timestamp', path + '.lastPenalty', 0, Number.MAX_SAFE_INTEGER, false);
        }
    }

    function validateSavedMatchState(savedState, path) {
        if (savedState === null) return;
        requireObject(savedState, path);
        ['scoreA', 'scoreB', 'penaltiesA', 'penaltiesB'].forEach((key) => {
            validateNumberField(savedState, key, path, 0, 1000000, false);
        });
        ['timer', 'gameTimeRemaining'].forEach((key) => {
            validateNumberField(savedState, key, path, 0, 86400, false);
        });
        ['techUsedA', 'techUsedB', 'basesSwappedNext', 'finished', 'skipped', 'goldenPending'].forEach((key) => {
            validateBooleanField(savedState, key, path);
        });
        ['realStartTime', 'realEndTime'].forEach((key) => {
            validateStringField(savedState, key, path, { allowNull: true, maxLength: 200 });
        });
        validateArrayField(savedState, 'history', path, true);
    }

    function validateMatches(matches, path) {
        requireArray(matches, path);
        matches.forEach((match, index) => {
            const matchPath = path + '[' + index + ']';
            requireObject(match, matchPath);
            ['time', 'teamA', 'teamB', 'phase', 'field', 'pit', 'slotId', 'realStartTime', 'realEndTime'].forEach((key) => {
                validateStringField(match, key, matchPath, { allowNull: true, maxLength: 1000 });
            });
            validateNumberField(match, 'slotOrder', matchPath, 0, 1000000, true);
            validateNumberField(match, 'slotPosition', matchPath, 0, 1000000, true);
            if (hasOwn(match, 'savedState')) validateSavedMatchState(match.savedState, matchPath + '.savedState');
        });
    }

    function validateSettings(settings, path) {
        requireObject(settings, path);
        validateStringField(settings, 'matchId', path, { maxLength: 160 });
        validateStringField(settings, 'controlPin', path, { pattern: /^\d{6}$/ });
        ['lang', 'voiceURI', 'logPassword'].forEach((key) => {
            validateStringField(settings, key, path, { allowNull: key === 'voiceURI', maxLength: 10000 });
        });
        [
            'voice', 'autoStart', 'confirmTowel', 'confirmTech', 'hapticReferee',
            'outdoorMode', 'confirmSkipSlot', 'confirmNoPoint', 'confirmUndo',
            'upgradedToEnglishTTS'
        ].forEach((key) => validateBooleanField(settings, key, path));

        validateNumberField(settings, 'gameDuration', path, 0, 1440, false);
        validateNumberField(settings, 'goldenDuration', path, 0, 1440, false);
        validateNumberField(settings, 'breakDuration', path, 0, 86400, false);
        validateNumberField(settings, 'pointIntervalDuration', path, 0, 86400, false);
        validateNumberField(settings, 'slotIntervalDuration', path, 0, 86400, false);
        validateNumberField(settings, 'singleSlotIntervalDuration', path, 0, 86400, false);
        validateNumberField(settings, 'mercyDiff', path, 1, 1000000, false);

        validateObjectField(settings, 'buzzerMapping', path, false);
        if (hasOwn(settings, 'buzzerMapping')) {
            Object.keys(settings.buzzerMapping).forEach((mappingKey) => {
                if (typeof settings.buzzerMapping[mappingKey] !== 'string') {
                    fail(path + '.buzzerMapping.' + mappingKey + ' deve essere una stringa');
                }
            });
        }
        validateObjectField(settings, 'hotkeys', path, false);
    }

    function validateTournamentState(value, path) {
        requireObject(value, path);
        requireField(value, 'tournament', path);
        requireField(value, 'teams', path);
        requireField(value, 'mode', path);
        requireField(value, 'timer', path);
        requireField(value, 'gameTimeRemaining', path);
        requireField(value, 'basesSwapped', path);

        requireObject(value.tournament, path + '.tournament');
        requireField(value.tournament, 'matches', path + '.tournament');
        requireField(value.tournament, 'active', path + '.tournament');
        requireField(value.tournament, 'currentIndex', path + '.tournament');
        validateMatches(value.tournament.matches, path + '.tournament.matches');
        validateBooleanField(value.tournament, 'active', path + '.tournament');
        validateNumberField(value.tournament, 'currentIndex', path + '.tournament', -1,
            Math.max(-1, value.tournament.matches.length - 1), true);
        ['name', 'date', 'location', 'field', 'layoutUrl', 'eventUrl', 'description'].forEach((key) => {
            validateStringField(value.tournament, key, path + '.tournament', { allowNull: true, maxLength: 10000 });
        });
        validateNumberField(value.tournament, 'delay', path + '.tournament', -1000000, 1000000, false);
        validateObjectField(value.tournament, 'settings', path + '.tournament', false);

        requireObject(value.teams, path + '.teams');
        requireField(value.teams, 'A', path + '.teams');
        requireField(value.teams, 'B', path + '.teams');
        validateTeam(value.teams.A, path + '.teams.A');
        validateTeam(value.teams.B, path + '.teams.B');

        validateStringField(value, 'mode', path, { maxLength: 100 });
        validateStringField(value, 'prevMode', path, { allowNull: true, maxLength: 100 });
        validateStringField(value, 'timerMode', path, { maxLength: 100 });
        validateNumberField(value, 'timer', path, 0, 86400, false);
        validateNumberField(value, 'gameTimeRemaining', path, 0, 86400, false);
        validateBooleanField(value, 'basesSwapped', path);
        validateBooleanField(value, 'outdoorMode', path);
        validateArrayField(value, 'currentMatchEvents', path, true);
        validateArrayField(value, 'matchLog', path, false);
        if (hasOwn(value, 'pendingRotationAction')) {
            validatePendingRotation(value.pendingRotationAction, path + '.pendingRotationAction');
        }
    }

    function validateRuntimeCheckpoint(value, path) {
        requireObject(value, path);
        ['savedAt', 'currentIndex', 'matchKey', 'mode', 'timer', 'gameTimeRemaining', 'basesSwapped']
            .forEach((key) => requireField(value, key, path));
        validateNumberField(value, 'savedAt', path, 0, Number.MAX_SAFE_INTEGER, true);
        validateNumberField(value, 'currentIndex', path, 0, 1000000, true);
        validateStringField(value, 'matchKey', path, { maxLength: 10000 });
        validateStringField(value, 'mode', path, { maxLength: 100 });
        validateStringField(value, 'prevMode', path, { allowNull: true, maxLength: 100 });
        validateStringField(value, 'timerMode', path, { maxLength: 100 });
        validateNumberField(value, 'timer', path, 0, 86400, false);
        validateNumberField(value, 'gameTimeRemaining', path, 0, 86400, false);
        validateBooleanField(value, 'basesSwapped', path);
        if (hasOwn(value, 'pendingRotationAction')) {
            validatePendingRotation(value.pendingRotationAction, path + '.pendingRotationAction');
        }
    }

    function validateTeamStyle(value, path) {
        requireObject(value, path);
        validateNumberField(value, 'fontSize', path, 1, 1000, false);
        validateStringField(value, 'fontFamily', path, { maxLength: 1000 });
        validateBooleanField(value, 'bold', path);
        validateNumberField(value, 'scaleX', path, 0.01, 100, false);
        validateNumberField(value, 'scaleY', path, 0.01, 100, false);
        validateNumberField(value, 'limit', path, 1, 1000, false);
        validateStringField(value, 'dot', path, { maxLength: 100 });
    }

    function validateStreamClans(value, path) {
        requireArray(value, path);
        value.forEach((clan, index) => {
            const clanPath = path + '[' + index + ']';
            requireObject(clan, clanPath);
            ['name', 'logoUrl', 'rosterUrl'].forEach((key) => {
                validateStringField(clan, key, clanPath, { maxLength: key === 'name' ? 1000 : 10000000 });
            });
        });
    }

    function validateEntry(key, value) {
        switch (key) {
            case 'pm_settings':
                validateSettings(value, key);
                break;
            case 'pm_tournament_state':
                validateTournamentState(value, key);
                break;
            case 'pm_runtime_checkpoint':
                validateRuntimeCheckpoint(value, key);
                break;
            case 'pm_team_style':
                validateTeamStyle(value, key);
                break;
            case 'pm_stream_clans':
                validateStreamClans(value, key);
                break;
        }
    }

    function metadataFor(data, ignoredKeys) {
        const tournamentState = data.pm_tournament_state;
        const tournament = tournamentState && isPlainObject(tournamentState.tournament)
            ? tournamentState.tournament
            : tournamentState;
        const matches = tournament && Array.isArray(tournament.matches) ? tournament.matches : [];

        return {
            keys: STORAGE_KEYS.filter((key) => hasOwn(data, key)),
            itemCount: STORAGE_KEYS.filter((key) => hasOwn(data, key)).length,
            matchCount: matches.length,
            tournamentName: tournament && typeof tournament.name === 'string' ? tournament.name : null,
            currentIndex: tournament && Number.isInteger(tournament.currentIndex) ? tournament.currentIndex : null,
            hasRuntimeCheckpoint: hasOwn(data, 'pm_runtime_checkpoint'),
            ignoredKeys: Array.isArray(ignoredKeys) ? ignoredKeys.slice() : []
        };
    }

    function parseInput(textOrObject) {
        if (typeof textOrObject === 'string') {
            if (!textOrObject.trim()) fail('file vuoto');
            try {
                return JSON.parse(textOrObject);
            } catch (error) {
                fail('JSON illeggibile (' + error.message + ')');
            }
        }
        if (!textOrObject || typeof textOrObject !== 'object') fail('Ã¨ richiesto un oggetto o testo JSON');
        return textOrObject;
    }

    function parse(textOrObject) {
        const source = cloneSafe(parseInput(textOrObject), 'backup');
        requireObject(source, 'backup');
        if (source.format !== FORMAT) fail('formato sconosciuto');
        if (source.version !== VERSION) fail('versione non supportata');
        requireObject(source.data, 'backup.data');

        let createdAt = null;
        if (hasOwn(source, 'createdAt') && source.createdAt !== null) {
            if (typeof source.createdAt !== 'string' || !Number.isFinite(Date.parse(source.createdAt))) {
                fail('createdAt non valido');
            }
            createdAt = new Date(source.createdAt).toISOString();
        }

        const data = {};
        const ignoredKeys = [];
        Object.keys(source.data).forEach((key) => {
            if (!ALLOWED_KEYS.has(key)) {
                ignoredKeys.push(key);
                return;
            }
            const value = cloneSafe(source.data[key], 'backup.data.' + key);
            validateEntry(key, value);
            data[key] = value;
        });

        return {
            format: FORMAT,
            version: VERSION,
            createdAt: createdAt,
            data: data,
            metadata: metadataFor(data, ignoredKeys)
        };
    }

    function requireStorage(storage, writable) {
        if (!storage || typeof storage.getItem !== 'function') {
            throw new TypeError('EventBackup richiede uno storage con getItem()');
        }
        if (writable && (typeof storage.setItem !== 'function' || typeof storage.removeItem !== 'function')) {
            throw new TypeError('EventBackup.restore richiede setItem() e removeItem()');
        }
    }

    function build(storage) {
        requireStorage(storage, false);
        const data = {};

        STORAGE_KEYS.forEach((key) => {
            let raw;
            try {
                raw = storage.getItem(key);
            } catch (error) {
                throw new Error('Impossibile leggere ' + key + ': ' + error.message);
            }
            if (raw === null || raw === undefined) return;
            if (typeof raw !== 'string') raw = String(raw);

            let value;
            try {
                value = JSON.parse(raw);
            } catch (error) {
                fail(key + ' contiene JSON illeggibile (' + error.message + ')');
            }
            value = cloneSafe(value, key);
            validateEntry(key, value);
            data[key] = value;
        });

        return parse({
            format: FORMAT,
            version: VERSION,
            createdAt: new Date().toISOString(),
            data: data
        });
    }

    function restore(storage, backup) {
        requireStorage(storage, true);
        const parsed = parse(backup);
        const encoded = {};

        parsed.metadata.keys.forEach((key) => {
            encoded[key] = JSON.stringify(parsed.data[key]);
        });

        const touchedKeys = parsed.metadata.keys.slice();
        if (!hasOwn(parsed.data, 'pm_runtime_checkpoint')) touchedKeys.push('pm_runtime_checkpoint');
        const previous = {};
        touchedKeys.forEach((key) => { previous[key] = storage.getItem(key); });

        try {
            parsed.metadata.keys.forEach((key) => storage.setItem(key, encoded[key]));
            if (!hasOwn(parsed.data, 'pm_runtime_checkpoint')) storage.removeItem('pm_runtime_checkpoint');
        } catch (error) {
            touchedKeys.forEach((key) => {
                try {
                    if (previous[key] === null || previous[key] === undefined) storage.removeItem(key);
                    else storage.setItem(key, previous[key]);
                } catch (rollbackError) { }
            });
            throw new Error('Ripristino backup non riuscito: ' + error.message);
        }

        return {
            format: FORMAT,
            version: VERSION,
            createdAt: parsed.createdAt,
            restoredKeys: parsed.metadata.keys.slice(),
            removedKeys: hasOwn(parsed.data, 'pm_runtime_checkpoint') ? [] : ['pm_runtime_checkpoint'],
            ignoredKeys: parsed.metadata.ignoredKeys.slice(),
            itemCount: parsed.metadata.itemCount,
            matchCount: parsed.metadata.matchCount,
            tournamentName: parsed.metadata.tournamentName,
            currentIndex: parsed.metadata.currentIndex,
            hasRuntimeCheckpoint: parsed.metadata.hasRuntimeCheckpoint
        };
    }

    return Object.freeze({
        FORMAT: FORMAT,
        VERSION: VERSION,
        STORAGE_KEYS: STORAGE_KEYS,
        build: build,
        parse: parse,
        restore: restore
    });
});

