(function (root, factory) {
    const api = factory();
    if (typeof module === 'object' && module.exports) module.exports = api;
    root.IPBARosterCore = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
    'use strict';

    const SCHEMA_VERSION = 1;
    const ROWS = ['AUTO', 'POSTERIORE', 'CENTRALE', 'ANTERIORE'];
    const MAX_PLAYERS_PER_TEAM = 60;

    function cleanText(value, max) {
        return String(value == null ? '' : value)
            .replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ')
            .replace(/\s+/g, ' ').trim().slice(0, max || 160);
    }

    function normalizeToken(value) {
        return cleanText(value, 200).normalize('NFD').replace(/[\u0300-\u036f]/g, '')
            .toUpperCase().replace(/[^A-Z0-9]+/g, '-').replace(/^-+|-+$/g, '');
    }

    function safeTeamId(value) {
        const id = cleanText(value, 40).replace(/[^A-Za-z0-9_-]/g, '');
        return id || '';
    }

    function safePlayerKey(value) {
        return cleanText(value, 150).replace(/[^A-Za-z0-9_-]/g, '').slice(0, 120);
    }

    function safeHttpUrl(value) {
        const text = cleanText(value, 1600);
        if (!text) return '';
        try {
            const url = new URL(text, 'https://www.ipba.it/');
            if (url.protocol !== 'http:' && url.protocol !== 'https:') return '';
            return url.href;
        } catch (error) { return ''; }
    }

    function validColor(value, fallback) {
        const text = cleanText(value, 30);
        return /^#[0-9a-f]{6}$/i.test(text) ? text.toLowerCase() : fallback;
    }

    function makePlayerKey(teamId, source, fullName, number) {
        const team = 'TEAM-' + (normalizeToken(teamId) || 'UNKNOWN');
        const playerId = safeTeamId(source && source.playerId);
        if (playerId) return safePlayerKey(team + '_PLAYER-' + playerId);
        const profile = safeHttpUrl(source && source.profileUrl);
        const profileMatch = profile.match(/[?&]id=([A-Za-z0-9_-]+)/i);
        if (profileMatch) return safePlayerKey(team + '_PLAYER-' + profileMatch[1]);
        return safePlayerKey(team + '_' + (normalizeToken(fullName) || 'PLAYER') + '_' + (normalizeToken(number) || 'NA'));
    }

    function defaultTeam(teamId) {
        const id = safeTeamId(teamId);
        return {
            schemaVersion: SCHEMA_VERSION,
            team: {
                id,
                name: id ? 'TEAM ' + id : 'TEAM',
                companyName: '', companyCode: '',
                originalLogoUrl: '', customLogoUrl: '',
                rosterUrl: id ? 'https://www.ipba.it/video-team-giocatori.aspx?id=' + encodeURIComponent(id) : '',
                title: 'ROSTER', primaryColor: '#22d3ee', secondaryColor: '#fbbf24',
                fontFamily: 'Oswald'
            },
            players: [], updatedAt: 0, sourceUpdatedAt: 0
        };
    }

    function defaultPlayer(teamId, input, index) {
        input = input || {};
        const original = input.originalData || {};
        const source = input.source || {};
        const fullName = cleanText(original.fullName || input.fullName, 100);
        const number = cleanText(original.number || input.number, 12);
        const key = safePlayerKey(input.playerKey) || makePlayerKey(teamId, source, fullName, number);
        const custom = input.customData || {};
        const image = input.image || {};
        const row = ROWS.indexOf(String(custom.row || '').toUpperCase()) >= 0 ? String(custom.row).toUpperCase() : 'AUTO';
        return {
            playerKey: key,
            source: {
                type: source.type === 'MANUAL' ? 'MANUAL' : 'IPBA',
                playerId: safeTeamId(source.playerId),
                profileUrl: safeHttpUrl(source.profileUrl),
                originalPhotoUrl: safeHttpUrl(source.originalPhotoUrl)
            },
            originalData: {
                fullName,
                number,
                role: cleanText(original.role || input.role, 40).toUpperCase(),
                age: cleanText(original.age || input.age, 8)
            },
            customData: {
                firstName: cleanText(custom.firstName, 50),
                lastName: cleanText(custom.lastName, 50),
                displayName: cleanText(custom.displayName, 100),
                number: cleanText(custom.number, 12),
                role: cleanText(custom.role, 40).toUpperCase(),
                nickname: cleanText(custom.nickname, 60),
                visible: custom.visible !== false,
                order: Math.max(1, Math.min(999, parseInt(custom.order, 10) || index + 1)),
                row,
                rowPosition: Math.max(1, Math.min(99, parseInt(custom.rowPosition, 10) || index + 1))
            },
            image: {
                selectedSource: image.selectedSource === 'CUSTOM' ? 'CUSTOM' : 'ORIGINAL',
                customImageUrl: safeHttpUrl(image.customImageUrl) || (/^\/?data\/rosters\//.test(String(image.customImageUrl || '')) ? cleanText(image.customImageUrl, 700) : ''),
                customImageStorageKey: safePlayerKey(image.customImageStorageKey),
                hasTransparency: image.hasTransparency === true,
                width: Math.max(0, parseInt(image.width, 10) || 0),
                height: Math.max(0, parseInt(image.height, 10) || 0),
                scale: Math.max(0.5, Math.min(3, Number(image.scale) || 1)),
                offsetX: Math.max(-100, Math.min(100, Number(image.offsetX) || 0)),
                offsetY: Math.max(-100, Math.min(100, Number(image.offsetY) || 0)),
                bustHeight: Math.max(45, Math.min(100, Number(image.bustHeight) || 72)),
                cropTop: Math.max(0, Math.min(45, Number(image.cropTop) || 0)),
                cropBottom: Math.max(0, Math.min(55, Number(image.cropBottom) || 12)),
                flipX: image.flipX === true,
                shadow: image.shadow !== false,
                glow: image.glow !== false
            }
        };
    }

    function normalizeRoster(input, requestedId) {
        input = input && typeof input === 'object' ? input : {};
        const base = defaultTeam(requestedId || (input.team && input.team.id));
        const teamIn = input.team || {};
        base.team.id = safeTeamId(requestedId || teamIn.id || base.team.id);
        base.team.name = cleanText(teamIn.name, 100) || base.team.name;
        base.team.companyName = cleanText(teamIn.companyName, 180);
        base.team.companyCode = cleanText(teamIn.companyCode, 50);
        base.team.originalLogoUrl = safeHttpUrl(teamIn.originalLogoUrl);
        base.team.customLogoUrl = safeHttpUrl(teamIn.customLogoUrl) || (/^\/?data\/rosters\//.test(String(teamIn.customLogoUrl || '')) ? cleanText(teamIn.customLogoUrl, 700) : '');
        base.team.rosterUrl = safeHttpUrl(teamIn.rosterUrl) || base.team.rosterUrl;
        base.team.title = cleanText(teamIn.title, 50) || 'ROSTER';
        base.team.primaryColor = validColor(teamIn.primaryColor, '#22d3ee');
        base.team.secondaryColor = validColor(teamIn.secondaryColor, '#fbbf24');
        base.team.fontFamily = ['Oswald', 'Roboto', 'Bebas Neue', 'Orbitron'].includes(teamIn.fontFamily) ? teamIn.fontFamily : 'Oswald';
        const list = Array.isArray(input.players) ? input.players.slice(0, MAX_PLAYERS_PER_TEAM) : [];
        const seen = new Set();
        base.players = list.map((player, index) => defaultPlayer(base.team.id, player, index)).filter(player => {
            if (!player.playerKey || seen.has(player.playerKey)) return false;
            seen.add(player.playerKey); return true;
        });
        base.updatedAt = Math.max(0, Number(input.updatedAt) || 0);
        base.sourceUpdatedAt = Math.max(0, Number(input.sourceUpdatedAt) || 0);
        return base;
    }

    function mergeImported(existing, imported) {
        const fresh = normalizeRoster(imported, imported && imported.team && imported.team.id);
        if (!existing) return fresh;
        const old = normalizeRoster(existing, fresh.team.id);
        const oldByKey = new Map(old.players.map(player => [player.playerKey, player]));
        const oldByFallback = new Map(old.players.map(player => [normalizeToken(player.originalData.fullName) + '|' + normalizeToken(player.originalData.number), player]));
        const merged = fresh.players.map((player, index) => {
            const prior = oldByKey.get(player.playerKey) || oldByFallback.get(normalizeToken(player.originalData.fullName) + '|' + normalizeToken(player.originalData.number));
            if (!prior) return player;
            oldByKey.delete(prior.playerKey);
            const out = defaultPlayer(fresh.team.id, player, index);
            out.playerKey = prior.playerKey || out.playerKey;
            out.customData = Object.assign({}, out.customData, prior.customData);
            out.image = Object.assign({}, out.image, prior.image);
            return defaultPlayer(fresh.team.id, out, index);
        });
        old.players.forEach(player => {
            if (player.source.type === 'MANUAL' || oldByKey.has(player.playerKey)) merged.push(player);
        });
        fresh.players = merged;
        fresh.team.customLogoUrl = old.team.customLogoUrl;
        fresh.team.primaryColor = old.team.primaryColor;
        fresh.team.secondaryColor = old.team.secondaryColor;
        fresh.team.title = old.team.title;
        fresh.team.fontFamily = old.team.fontFamily;
        fresh.updatedAt = Date.now();
        return normalizeRoster(fresh, fresh.team.id);
    }

    function displayData(player) {
        const custom = player.customData || {};
        const original = player.originalData || {};
        const customFullName = cleanText([custom.lastName, custom.firstName].filter(Boolean).join(' '), 100);
        return {
            name: cleanText(custom.displayName, 100) || customFullName || cleanText(original.fullName, 100) || 'GIOCATORE',
            number: cleanText(custom.number, 12) || cleanText(original.number, 12),
            role: cleanText(custom.role, 40) || cleanText(original.role, 40),
            nickname: cleanText(custom.nickname, 60)
        };
    }

    function inferredRow(player) {
        const manual = String(player.customData && player.customData.row || 'AUTO').toUpperCase();
        if (manual !== 'AUTO' && ROWS.includes(manual)) return manual;
        const role = displayData(player).role.toUpperCase();
        if (/BACK|POST|DEF/.test(role)) return 'POSTERIORE';
        if (/FRONT|ANT|ATT/.test(role)) return 'ANTERIORE';
        return 'CENTRALE';
    }

    function orderedPlayers(roster) {
        const rowWeight = { POSTERIORE: 0, CENTRALE: 1, ANTERIORE: 2 };
        return normalizeRoster(roster).players.filter(player => player.customData.visible !== false).sort((a, b) => {
            const rowA = inferredRow(a), rowB = inferredRow(b);
            if (rowWeight[rowA] !== rowWeight[rowB]) return rowWeight[rowA] - rowWeight[rowB];
            const pos = (a.customData.rowPosition || 0) - (b.customData.rowPosition || 0);
            return pos || (a.customData.order || 0) - (b.customData.order || 0) || displayData(a).name.localeCompare(displayData(b).name);
        });
    }

    function layoutSpec(count) {
        count = Math.max(0, Math.min(12, parseInt(count, 10) || 0));
        if (count <= 2) return { columns: Math.max(1, count), rows: 1, size: 'hero' };
        if (count <= 4) return { columns: count === 3 ? 3 : 2, rows: count === 3 ? 1 : 2, size: 'large' };
        if (count <= 6) return { columns: 3, rows: 2, size: 'medium' };
        if (count <= 8) return { columns: 4, rows: 2, size: 'compact' };
        return { columns: 4, rows: 3, size: 'dense' };
    }

    function qualityReport(roster) {
        const normalized = normalizeRoster(roster);
        const visible = normalized.players.filter(player => player.customData.visible !== false);
        const numbers = new Map();
        visible.forEach(player => {
            const number = displayData(player).number;
            if (number) numbers.set(number, (numbers.get(number) || 0) + 1);
        });
        const positions = new Map();
        visible.forEach(player => {
            const key = inferredRow(player) + '|' + (player.customData.rowPosition || 0);
            positions.set(key, (positions.get(key) || 0) + 1);
        });
        const transparent = visible.filter(player => player.image.selectedSource === 'CUSTOM' && player.image.hasTransparency).length;
        const original = visible.filter(player => player.image.selectedSource !== 'CUSTOM' && player.source.originalPhotoUrl).length;
        const missing = visible.filter(player => !(player.image.selectedSource === 'CUSTOM' && (player.image.customImageUrl || player.image.customImageStorageKey)) && !player.source.originalPhotoUrl).length;
        const warnings = [];
        if (visible.length > 12) warnings.push('Più di 12 giocatori visibili: verranno create più pagine.');
        if (missing) warnings.push(missing + ' fotografie mancanti.');
        const duplicatedNumbers = [...numbers.entries()].filter(entry => entry[1] > 1).map(entry => entry[0]);
        if (duplicatedNumbers.length) warnings.push('Numeri duplicati: ' + duplicatedNumbers.join(', '));
        const duplicatePositions = [...positions.values()].filter(value => value > 1).length;
        if (duplicatePositions) warnings.push(duplicatePositions + ' posizioni di fila duplicate.');
        const missingNumbers = visible.filter(player => !displayData(player).number).length;
        const missingRoles = visible.filter(player => !displayData(player).role).length;
        const longNames = visible.filter(player => displayData(player).name.length > 24).length;
        if (missingNumbers) warnings.push(missingNumbers + ' numeri mancanti.');
        if (missingRoles) warnings.push(missingRoles + ' ruoli mancanti.');
        if (longNames) warnings.push(longNames + ' nomi lunghi da verificare.');
        return { total: normalized.players.length, visible: visible.length, hidden: normalized.players.length - visible.length, transparent, original, missing, missingNumbers, missingRoles, longNames, duplicatedNumbers, duplicatePositions, warnings };
    }

    function parseIpbaHtml(html, teamId) {
        if (typeof DOMParser === 'undefined') throw new Error('DOMParser non disponibile');
        const id = safeTeamId(teamId);
        const document = new DOMParser().parseFromString(String(html || ''), 'text/html');
        const roster = defaultTeam(id);
        const teamImage = document.querySelector('img[src*="/public/team_' + id + '/"]');
        if (teamImage) {
            roster.team.originalLogoUrl = safeHttpUrl(teamImage.getAttribute('src'));
            const header = teamImage.closest('div') || teamImage.closest('table');
            if (header) {
                const nameNode = header.querySelector('h3 b, h3, b');
                roster.team.name = cleanText(nameNode && nameNode.textContent, 100) || roster.team.name;
                const text = cleanText(header.textContent, 500);
                const code = text.match(/codice\s+(?:fidasc|societ[aà])\s*([A-Za-z0-9/-]+)/i);
                roster.team.companyCode = code ? cleanText(code[1], 50) : '';
                roster.team.companyName = cleanText(text.replace(roster.team.name, '').replace(/codice\s+(?:fidasc|societ[aà]).*$/i, ''), 180);
            }
        }
        const seen = new Set();
        document.querySelectorAll('img[src*="/public/user_"]').forEach((image, index) => {
            let block = image.closest('table');
            while (block && (!block.querySelector('b') || block.querySelectorAll('img[src*="/public/user_"]').length !== 1)) block = block.parentElement && block.parentElement.closest('table');
            if (!block) return;
            const src = safeHttpUrl(image.getAttribute('src'));
            const user = src.match(/\/public\/user_([^/]+)/i);
            const bold = block.querySelector('b');
            const fullName = cleanText(bold && bold.textContent, 100);
            if (!fullName) return;
            let number = '';
            block.querySelectorAll('div').forEach(div => { const value = cleanText(div.textContent, 20); if (!number && /^\d{1,3}$/.test(value)) number = value; });
            const text = cleanText(block.textContent, 400);
            const detail = text.match(/(\d{1,3})\s*anni(?:\s*-\s*([A-Za-zÀ-ÿ0-9 /_-]+))?/i);
            const player = defaultPlayer(id, {
                source: { type: 'IPBA', playerId: user ? user[1] : '', profileUrl: user ? 'https://www.ipba.it/profilo.aspx?id=' + user[1] : '', originalPhotoUrl: src },
                originalData: { fullName, number, role: detail && detail[2] ? cleanText(detail[2], 40) : '', age: detail ? detail[1] : '' }
            }, index);
            if (!seen.has(player.playerKey)) { seen.add(player.playerKey); roster.players.push(player); }
        });
        roster.sourceUpdatedAt = Date.now(); roster.updatedAt = Date.now();
        return normalizeRoster(roster, id);
    }

    return {
        SCHEMA_VERSION, ROWS, cleanText, normalizeToken, safeTeamId, safePlayerKey, safeHttpUrl,
        makePlayerKey, defaultTeam, defaultPlayer, normalizeRoster, mergeImported, displayData,
        inferredRow, orderedPlayers, layoutSpec, qualityReport, parseIpbaHtml
    };
});
