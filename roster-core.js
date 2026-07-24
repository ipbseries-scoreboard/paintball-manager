(function (root, factory) {
    const api = factory();
    if (typeof module === 'object' && module.exports) module.exports = api;
    root.IPBARosterCore = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
    'use strict';

    const SCHEMA_VERSION = 2;
    const MAX_STORED_PLAYERS = 60;
    const MAX_VISIBLE_PLAYERS = 12;
    const ROWS = ['AUTO', 'POSTERIORE', 'CENTRALE', 'ANTERIORE'];
    const ROW_WEIGHT = { POSTERIORE: 0, CENTRALE: 1, ANTERIORE: 2 };
    const ORDER_MODES = ['AUTO', 'MANUALE'];

    function cleanText(value, maxLength) {
        return String(value == null ? '' : value)
            .replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ')
            .replace(/\s+/g, ' ')
            .trim()
            .slice(0, maxLength || 160);
    }

    function normalizeToken(value) {
        return cleanText(value, 200)
            .normalize('NFD')
            .replace(/[\u0300-\u036f]/g, '')
            .toUpperCase()
            .replace(/[^A-Z0-9]+/g, '-')
            .replace(/^-+|-+$/g, '');
    }

    function safeTeamId(value) {
        return cleanText(value, 40).replace(/[^A-Za-z0-9_-]/g, '');
    }

    function safePlayerKey(value) {
        return cleanText(value, 150).replace(/[^A-Za-z0-9_-]/g, '').slice(0, 120);
    }

    function safeHttpUrl(value) {
        const text = cleanText(value, 1800);
        if (!text) return '';
        try {
            const url = new URL(text, 'https://www.ipba.it/');
            return url.protocol === 'http:' || url.protocol === 'https:' ? url.href : '';
        } catch (error) {
            return '';
        }
    }

    function safeAssetUrl(value) {
        const text = cleanText(value, 1800);
        if (/^\/?data\/rosters\/[A-Za-z0-9_%./-]+$/i.test(text) && !text.includes('..')) return text.replace(/^\/+/, '');
        return safeHttpUrl(text);
    }

    function validColor(value, fallback) {
        const text = cleanText(value, 20);
        return /^#[0-9a-f]{6}$/i.test(text) ? text.toLowerCase() : fallback;
    }

    function boundedNumber(value, fallback, min, max) {
        const number = Number(value);
        return Number.isFinite(number) ? Math.max(min, Math.min(max, number)) : fallback;
    }

    function makePlayerKey(teamId, source, fullName, number) {
        const team = 'TEAM-' + (normalizeToken(teamId) || 'UNKNOWN');
        const playerId = safeTeamId(source && source.playerId);
        if (playerId) return safePlayerKey(team + '_PLAYER-' + playerId);

        const profileUrl = safeHttpUrl(source && source.profileUrl);
        const profileId = profileUrl.match(/[?&](?:id|playerId)=([A-Za-z0-9_-]+)/i);
        if (profileId) return safePlayerKey(team + '_PLAYER-' + profileId[1]);

        const markupId = safePlayerKey(source && source.markupId);
        if (markupId) return safePlayerKey(team + '_MARKUP-' + markupId);

        return safePlayerKey(
            team + '_' + (normalizeToken(fullName) || 'PLAYER') + '_' + (normalizeToken(number) || 'NA')
        );
    }

    function defaultTeam(teamId) {
        const id = safeTeamId(teamId);
        return {
            schemaVersion: SCHEMA_VERSION,
            team: {
                id,
                name: id ? 'TEAM ' + id : 'TEAM',
                companyName: '',
                companyCode: '',
                originalLogoUrl: '',
                customLogoUrl: '',
                rosterUrl: id
                    ? 'https://www.ipba.it/video-team-giocatori.aspx?id=' + encodeURIComponent(id)
                    : '',
                title: 'ROSTER',
                primaryColor: '#00a7c4',
                secondaryColor: '#91c11e',
                fontFamily: 'Source Sans Pro'
            },
            settings: {
                orderMode: 'AUTO',
                maxVisible: MAX_VISIBLE_PLAYERS
            },
            players: [],
            sourceUpdatedAt: 0,
            updatedAt: 0
        };
    }

    function defaultPlayer(teamId, input, index) {
        input = input && typeof input === 'object' ? input : {};
        index = Math.max(0, Number.parseInt(index, 10) || 0);

        const source = input.source && typeof input.source === 'object' ? input.source : {};
        const original = input.originalData && typeof input.originalData === 'object' ? input.originalData : {};
        const custom = input.customData && typeof input.customData === 'object' ? input.customData : {};
        const image = input.image && typeof input.image === 'object' ? input.image : {};
        const fullName = cleanText(original.fullName || input.fullName, 100);
        const originalNumber = cleanText(original.number || input.number, 12);
        const row = ROWS.includes(String(custom.row || '').toUpperCase())
            ? String(custom.row).toUpperCase()
            : 'AUTO';
        const key = safePlayerKey(input.playerKey) || makePlayerKey(teamId, source, fullName, originalNumber);

        return {
            playerKey: key,
            source: {
                type: source.type === 'MANUAL' ? 'MANUAL' : 'IPBA',
                playerId: safeTeamId(source.playerId),
                profileUrl: safeHttpUrl(source.profileUrl),
                originalPhotoUrl: safeHttpUrl(source.originalPhotoUrl),
                markupId: safePlayerKey(source.markupId),
                stale: source.stale === true
            },
            originalData: {
                fullName,
                number: originalNumber,
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
                order: Math.max(1, Math.min(999, Number.parseInt(custom.order, 10) || index + 1)),
                row,
                rowPosition: Math.max(1, Math.min(99, Number.parseInt(custom.rowPosition, 10) || index + 1))
            },
            image: {
                selectedSource: image.selectedSource === 'CUSTOM' ? 'CUSTOM' : 'ORIGINAL',
                customImageUrl: safeAssetUrl(image.customImageUrl),
                hasTransparency: image.hasTransparency === true,
                width: Math.max(0, Number.parseInt(image.width, 10) || 0),
                height: Math.max(0, Number.parseInt(image.height, 10) || 0),
                scale: boundedNumber(image.scale, 1, 0.5, 3),
                offsetX: boundedNumber(image.offsetX, 0, -100, 100),
                offsetY: boundedNumber(image.offsetY, 0, -100, 100),
                bustHeight: boundedNumber(image.bustHeight, 78, 45, 120),
                cropTop: boundedNumber(image.cropTop, 0, 0, 45),
                cropBottom: boundedNumber(image.cropBottom, 0, 0, 55),
                anchor: ['BOTTOM_CENTER', 'CENTER', 'TOP_CENTER'].includes(image.anchor)
                    ? image.anchor
                    : 'BOTTOM_CENTER',
                flipX: image.flipX === true,
                shadow: image.shadow !== false,
                glow: image.glow !== false
            }
        };
    }

    function normalizeRoster(input, requestedId) {
        input = input && typeof input === 'object' ? input : {};
        const requested = requestedId || (input.team && input.team.id);
        const output = defaultTeam(requested);
        const team = input.team && typeof input.team === 'object' ? input.team : {};
        const settings = input.settings && typeof input.settings === 'object' ? input.settings : {};

        output.team.id = safeTeamId(requested || team.id);
        output.team.name = cleanText(team.name, 100) || output.team.name;
        output.team.companyName = cleanText(team.companyName, 180);
        output.team.companyCode = cleanText(team.companyCode, 50);
        output.team.originalLogoUrl = safeHttpUrl(team.originalLogoUrl);
        output.team.customLogoUrl = safeAssetUrl(team.customLogoUrl);
        output.team.rosterUrl = safeHttpUrl(team.rosterUrl) || output.team.rosterUrl;
        output.team.title = cleanText(team.title, 50) || 'ROSTER';
        output.team.primaryColor = validColor(team.primaryColor, '#00a7c4');
        output.team.secondaryColor = validColor(team.secondaryColor, '#91c11e');
        output.team.fontFamily = ['Source Sans Pro', 'Segoe UI', 'Oswald', 'Roboto', 'Arial'].includes(team.fontFamily)
            ? team.fontFamily
            : 'Source Sans Pro';
        output.settings.orderMode = ORDER_MODES.includes(String(settings.orderMode || '').toUpperCase())
            ? String(settings.orderMode).toUpperCase()
            : 'AUTO';
        output.settings.maxVisible = MAX_VISIBLE_PLAYERS;

        const seen = new Set();
        const players = Array.isArray(input.players) ? input.players.slice(0, MAX_STORED_PLAYERS) : [];
        output.players = players.map((player, index) => defaultPlayer(output.team.id, player, index)).filter(player => {
            if (!player.playerKey || seen.has(player.playerKey)) return false;
            seen.add(player.playerKey);
            return true;
        });

        output.sourceUpdatedAt = Math.max(0, Number(input.sourceUpdatedAt) || 0);
        output.updatedAt = Math.max(0, Number(input.updatedAt) || 0);
        return output;
    }

    function fallbackIdentity(player) {
        return normalizeToken(player && player.originalData && player.originalData.fullName) + '|' +
            normalizeToken(player && player.originalData && player.originalData.number);
    }

    function mergeImported(existing, imported) {
        const fresh = normalizeRoster(imported, imported && imported.team && imported.team.id);
        if (!existing) return fresh;

        const previous = normalizeRoster(existing, fresh.team.id);
        const byKey = new Map(previous.players.map(player => [player.playerKey, player]));
        const byFallback = new Map(previous.players.map(player => [fallbackIdentity(player), player]));
        const retained = new Set();

        fresh.players = fresh.players.map((player, index) => {
            const old = byKey.get(player.playerKey) || byFallback.get(fallbackIdentity(player));
            if (!old) return player;
            retained.add(old.playerKey);
            const merged = defaultPlayer(fresh.team.id, player, index);
            merged.playerKey = old.playerKey || merged.playerKey;
            merged.customData = Object.assign({}, merged.customData, old.customData);
            merged.image = Object.assign({}, merged.image, old.image);
            merged.source.stale = false;
            return defaultPlayer(fresh.team.id, merged, index);
        });

        previous.players.forEach(old => {
            if (retained.has(old.playerKey)) return;
            const preserved = defaultPlayer(fresh.team.id, old, fresh.players.length);
            if (preserved.source.type === 'IPBA') {
                preserved.source.stale = true;
                preserved.customData.visible = false;
            }
            fresh.players.push(preserved);
        });

        fresh.team.customLogoUrl = previous.team.customLogoUrl;
        fresh.team.title = previous.team.title;
        fresh.team.primaryColor = previous.team.primaryColor;
        fresh.team.secondaryColor = previous.team.secondaryColor;
        fresh.team.fontFamily = previous.team.fontFamily;
        fresh.settings = Object.assign({}, fresh.settings, previous.settings);
        fresh.updatedAt = Date.now();
        return normalizeRoster(fresh, fresh.team.id);
    }

    function displayData(player) {
        const custom = player && player.customData || {};
        const original = player && player.originalData || {};
        const customName = cleanText([custom.lastName, custom.firstName].filter(Boolean).join(' '), 100);
        return {
            name: cleanText(custom.displayName, 100) || customName || cleanText(original.fullName, 100) || 'GIOCATORE',
            number: cleanText(custom.number, 12) || cleanText(original.number, 12),
            role: cleanText(custom.role, 40) || cleanText(original.role, 40),
            nickname: cleanText(custom.nickname, 60)
        };
    }

    function inferredRow(player) {
        const configured = String(player && player.customData && player.customData.row || 'AUTO').toUpperCase();
        if (configured !== 'AUTO' && ROWS.includes(configured)) return configured;
        const role = displayData(player).role.toUpperCase();
        if (/BACK|POST|DEF/.test(role)) return 'POSTERIORE';
        if (/FRONT|ANT|ATT/.test(role)) return 'ANTERIORE';
        return 'CENTRALE';
    }

    function orderedPlayers(roster, options) {
        const clean = normalizeRoster(roster);
        const orderMode = options && options.forceAuto
            ? 'AUTO'
            : clean.settings.orderMode;
        const visible = clean.players.filter(player => player.customData.visible !== false);
        return visible.sort((left, right) => {
            if (orderMode === 'MANUALE') {
                return (left.customData.order - right.customData.order) ||
                    displayData(left).name.localeCompare(displayData(right).name);
            }
            const rowDifference = ROW_WEIGHT[inferredRow(left)] - ROW_WEIGHT[inferredRow(right)];
            return rowDifference ||
                (left.customData.rowPosition - right.customData.rowPosition) ||
                (left.customData.order - right.customData.order) ||
                displayData(left).name.localeCompare(displayData(right).name);
        });
    }

    function pagePlayers(roster, page, options) {
        const ordered = orderedPlayers(roster, options);
        const pageCount = Math.max(1, Math.ceil(ordered.length / MAX_VISIBLE_PLAYERS));
        const safePage = ((Number.parseInt(page, 10) || 0) % pageCount + pageCount) % pageCount;
        return {
            players: ordered.slice(safePage * MAX_VISIBLE_PLAYERS, (safePage + 1) * MAX_VISIBLE_PLAYERS),
            page: safePage,
            pageCount,
            totalVisible: ordered.length
        };
    }

    function layoutSpec(count, mode) {
        const total = Math.max(0, Math.min(MAX_VISIBLE_PLAYERS, Number.parseInt(count, 10) || 0));
        const single = String(mode || '').toUpperCase() === 'SINGLE';
        if (total <= 2) return { columns: Math.max(1, total), rows: 1, size: 'hero' };
        if (total === 3) return { columns: 3, rows: 1, size: 'hero' };
        if (total === 4) return { columns: single ? 4 : 2, rows: single ? 1 : 2, size: 'large' };
        if (total <= 6) return { columns: 3, rows: 2, size: 'medium' };
        if (total <= 8) return { columns: 4, rows: 2, size: 'compact' };
        return { columns: 4, rows: 3, size: 'dense' };
    }

    function qualityReport(roster) {
        const clean = normalizeRoster(roster);
        const visible = orderedPlayers(clean);
        const selected = visible.slice(0, MAX_VISIBLE_PLAYERS);
        const countByNumber = new Map();
        const countByPosition = new Map();

        visible.forEach(player => {
            const data = displayData(player);
            if (data.number) countByNumber.set(data.number, (countByNumber.get(data.number) || 0) + 1);
            const position = inferredRow(player) + '|' + player.customData.rowPosition;
            countByPosition.set(position, (countByPosition.get(position) || 0) + 1);
        });

        const duplicatedNumbers = [...countByNumber.entries()]
            .filter(entry => entry[1] > 1)
            .map(entry => entry[0]);
        const duplicatedPositions = [...countByPosition.entries()]
            .filter(entry => entry[1] > 1)
            .map(entry => entry[0]);
        const missingPhotos = visible.filter(player => {
            const hasCustom = player.image.selectedSource === 'CUSTOM' && player.image.customImageUrl;
            return !hasCustom && !player.source.originalPhotoUrl;
        }).length;
        const nonTransparent = visible.filter(player =>
            player.image.selectedSource === 'CUSTOM' && !player.image.hasTransparency
        ).length;
        const smallPhotos = visible.filter(player =>
            player.image.width && player.image.height && (player.image.width < 350 || player.image.height < 350)
        ).length;
        const missingNumbers = visible.filter(player => !displayData(player).number).length;
        const missingRoles = visible.filter(player => !displayData(player).role).length;
        const longNames = visible.filter(player => displayData(player).name.length > 26).length;
        const stale = clean.players.filter(player => player.source.stale).length;
        const warnings = [];

        if (visible.length > MAX_VISIBLE_PLAYERS) {
            warnings.push('Sono visibili ' + visible.length + ' giocatori: in diretta vengono selezionati automaticamente i primi 12 giocatori.');
        }
        if (missingPhotos) warnings.push(missingPhotos + ' foto mancanti.');
        if (nonTransparent) warnings.push(nonTransparent + ' foto personalizzate senza trasparenza.');
        if (smallPhotos) warnings.push(smallPhotos + ' foto con risoluzione inferiore a 350×350.');
        if (missingNumbers) warnings.push(missingNumbers + ' numeri mancanti.');
        if (duplicatedNumbers.length) warnings.push('Numeri duplicati: ' + duplicatedNumbers.join(', ') + '.');
        if (missingRoles) warnings.push(missingRoles + ' ruoli mancanti.');
        if (longNames) warnings.push(longNames + ' nomi lunghi da controllare.');
        if (duplicatedPositions.length) warnings.push(duplicatedPositions.length + ' posizioni di fila duplicate.');
        if (stale) warnings.push(stale + ' giocatori non più presenti nell’ultima importazione IPBA e mantenuti nascosti.');

        return {
            total: clean.players.length,
            visible: visible.length,
            selected: selected.length,
            overflow: Math.max(0, visible.length - MAX_VISIBLE_PLAYERS),
            hidden: clean.players.length - visible.length,
            transparent: visible.filter(player => player.image.selectedSource === 'CUSTOM' && player.image.hasTransparency).length,
            original: visible.filter(player => player.image.selectedSource !== 'CUSTOM' && player.source.originalPhotoUrl).length,
            missing: missingPhotos,
            nonTransparent,
            smallPhotos,
            missingNumbers,
            missingRoles,
            longNames,
            stale,
            duplicatedNumbers,
            duplicatedPositions,
            warnings
        };
    }

    function findPlayerBlockFromImage(image) {
        let node = image && image.closest ? image.closest('table') : null;
        while (node) {
            const images = node.querySelectorAll('img[src*="/public/user_"]');
            const name = node.querySelector('b, strong');
            if (images.length === 1 && name) return node;
            const parent = node.parentElement;
            node = parent && parent.closest ? parent.closest('table') : null;
        }
        return null;
    }

    function parseIpbaHtml(html, teamId) {
        if (typeof DOMParser === 'undefined') throw new Error('DOMParser non disponibile');
        const id = safeTeamId(teamId);
        const document = new DOMParser().parseFromString(String(html || ''), 'text/html');
        const roster = defaultTeam(id);

        const logo = document.querySelector('img[src*="/public/team_' + id + '/"]');
        if (logo) {
            roster.team.originalLogoUrl = safeHttpUrl(logo.getAttribute('src'));
            let header = logo.closest('table') || logo.parentElement;
            while (header && !/codice\s+(?:fidasc|societ[aà])/i.test(header.textContent || '') && header.parentElement) {
                header = header.parentElement.closest('table, div') || header.parentElement;
            }
            if (header) {
                const nameNode = header.querySelector('h1, h2, h3, b, strong');
                roster.team.name = cleanText(nameNode && nameNode.textContent, 100) || roster.team.name;
                const raw = cleanText(header.textContent, 600);
                const code = raw.match(/codice\s+(?:fidasc|societ[aà])\s*([A-Za-z0-9/-]+)/i);
                roster.team.companyCode = code ? cleanText(code[1], 50) : '';
                roster.team.companyName = cleanText(
                    raw.replace(roster.team.name, '').replace(/codice\s+(?:fidasc|societ[aà]).*$/i, ''),
                    180
                );
            }
        }

        const seen = new Set();
        document.querySelectorAll('img[src*="/public/user_"]').forEach((image, index) => {
            const block = findPlayerBlockFromImage(image);
            if (!block) return;

            const photoUrl = safeHttpUrl(image.getAttribute('src'));
            const idMatch = photoUrl.match(/\/public\/user_([^/]+)/i);
            const playerId = idMatch ? safeTeamId(idMatch[1]) : '';
            const nameNode = block.querySelector('b, strong');
            const fullName = cleanText(nameNode && nameNode.textContent, 100);
            if (!fullName) return;

            let number = '';
            block.querySelectorAll('div, span, td').forEach(node => {
                if (number) return;
                const value = cleanText(node.textContent, 20);
                if (/^\d{1,3}$/.test(value)) number = value;
            });
            const detail = cleanText(block.textContent, 600)
                .match(/(\d{1,3})\s*anni(?:\s*-\s*([A-Za-zÀ-ÿ0-9 /_-]+))?/i);
            const profileLink = image.closest('a[href]') || block.querySelector('a[href*="id="]');
            const player = defaultPlayer(id, {
                source: {
                    type: 'IPBA',
                    playerId,
                    profileUrl: safeHttpUrl(profileLink && profileLink.getAttribute('href')) ||
                        (playerId ? 'https://www.ipba.it/profilo.aspx?id=' + playerId : ''),
                    originalPhotoUrl: photoUrl,
                    markupId: image.getAttribute('data-player-id') || ''
                },
                originalData: {
                    fullName,
                    number,
                    role: detail && detail[2] ? cleanText(detail[2], 40) : '',
                    age: detail ? detail[1] : ''
                }
            }, index);

            if (!seen.has(player.playerKey)) {
                seen.add(player.playerKey);
                roster.players.push(player);
            }
        });

        roster.sourceUpdatedAt = Date.now();
        roster.updatedAt = Date.now();
        return normalizeRoster(roster, id);
    }

    return {
        SCHEMA_VERSION,
        MAX_STORED_PLAYERS,
        MAX_VISIBLE_PLAYERS,
        ROWS,
        ORDER_MODES,
        cleanText,
        normalizeToken,
        safeTeamId,
        safePlayerKey,
        safeHttpUrl,
        safeAssetUrl,
        validColor,
        makePlayerKey,
        defaultTeam,
        defaultPlayer,
        normalizeRoster,
        mergeImported,
        displayData,
        inferredRow,
        orderedPlayers,
        pagePlayers,
        layoutSpec,
        qualityReport,
        parseIpbaHtml
    };
});
