(function (root) {
    'use strict';

    const Core = root.IPBARosterCore;
    if (!Core) throw new Error('roster-core.js deve essere caricato prima di roster-storage.js');

    const CHANNEL_NAME = 'ipba_roster_setup';
    const channel = typeof BroadcastChannel !== 'undefined'
        ? new BroadcastChannel(CHANNEL_NAME)
        : null;

    async function request(url, options) {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 25000);
        try {
            const response = await fetch(url, Object.assign({}, options || {}, {
                credentials: 'same-origin',
                cache: 'no-store',
                signal: controller.signal
            }));
            const text = await response.text();
            let payload = {};
            try {
                payload = text ? JSON.parse(text) : {};
            } catch (error) {
                payload = { error: text || 'Risposta del server non valida' };
            }
            if (!response.ok) {
                const failure = new Error(payload.error || ('Errore HTTP ' + response.status));
                failure.status = response.status;
                failure.payload = payload;
                throw failure;
            }
            return payload;
        } catch (error) {
            if (error && error.name === 'AbortError') throw new Error('Il server locale non risponde.');
            throw error;
        } finally {
            clearTimeout(timeout);
        }
    }

    function teamEndpoint(teamId) {
        const id = Core.safeTeamId(teamId);
        if (!id) throw new Error('ID squadra non valido');
        return '/api/rosters/' + encodeURIComponent(id);
    }

    async function authStatus() {
        return request('/api/rosters/auth/status');
    }

    async function login(password) {
        return request('/api/rosters/auth/login', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ password: String(password || '') })
        });
    }

    async function logout() {
        return request('/api/rosters/auth/logout', { method: 'POST' });
    }

    async function loadTeam(teamId, options) {
        const query = options && options.noImport ? '?noImport=1' : options && options.fresh ? '?fresh=1' : '';
        const payload = await request(teamEndpoint(teamId) + query);
        return {
            roster: Core.normalizeRoster(payload.roster, teamId),
            storage: payload.storage || 'SERVER_LOCALE'
        };
    }

    async function importTeam(teamId) {
        const payload = await request(teamEndpoint(teamId) + '/import', { method: 'POST' });
        const roster = Core.normalizeRoster(payload.roster, teamId);
        notify('ROSTER_CONFIG_UPDATED', roster.team.id, roster.updatedAt);
        return {
            roster,
            storage: payload.storage || 'SERVER_LOCALE'
        };
    }

    async function saveTeam(roster) {
        const clean = Core.normalizeRoster(roster);
        const payload = await request(teamEndpoint(clean.team.id), {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(clean)
        });
        const saved = Core.normalizeRoster(payload.roster, clean.team.id);
        notify('ROSTER_CONFIG_UPDATED', saved.team.id, saved.updatedAt);
        return {
            roster: saved,
            storage: payload.storage || 'SERVER_LOCALE'
        };
    }

    async function uploadPlayerImage(teamId, playerKey, blob, metadata) {
        const id = Core.safeTeamId(teamId);
        const key = Core.safePlayerKey(playerKey);
        if (!id || !key) throw new Error('Squadra o giocatore non valido');
        if (!(blob instanceof Blob)) throw new Error('File immagine non valido');
        const result = await request(
            teamEndpoint(id) + '/players/' + encodeURIComponent(key) + '/photo',
            {
                method: 'POST',
                headers: {
                    'Content-Type': blob.type || 'image/png',
                    'X-Image-Transparency': metadata && metadata.hasTransparency ? '1' : '0'
                },
                body: blob
            }
        );
        notify('PLAYER_IMAGE_UPDATED', id, Date.now());
        return result;
    }

    async function removePlayerImage(teamId, playerKey) {
        const id = Core.safeTeamId(teamId);
        const key = Core.safePlayerKey(playerKey);
        if (!id || !key) throw new Error('Squadra o giocatore non valido');
        await request(teamEndpoint(id) + '/players/' + encodeURIComponent(key) + '/photo', {
            method: 'DELETE'
        });
        notify('PLAYER_IMAGE_UPDATED', id, Date.now());
    }

    function resolvePlayerImage(player) {
        if (!player) return '';
        if (player.image && player.image.selectedSource === 'CUSTOM' && player.image.customImageUrl) {
            return Core.safeAssetUrl(player.image.customImageUrl);
        }
        return Core.safeHttpUrl(player.source && player.source.originalPhotoUrl);
    }

    function notify(type, teamId, updatedAt, extra) {
        const packet = Object.assign({
            type,
            teamId: Core.safeTeamId(teamId),
            updatedAt: Number(updatedAt) || Date.now()
        }, extra || {});
        if (channel) channel.postMessage(packet);
        try {
            root.postMessage(packet, location.origin);
        } catch (error) {
            // BroadcastChannel è il canale primario; postMessage è un supporto locale.
        }
    }

    function subscribe(listener) {
        if (typeof listener !== 'function') return function () {};
        const receive = event => listener(event.data || {});
        if (channel) channel.addEventListener('message', receive);
        return function unsubscribe() {
            if (channel) channel.removeEventListener('message', receive);
        };
    }

    root.IPBARosterStorage = {
        CHANNEL_NAME,
        request,
        authStatus,
        login,
        logout,
        loadTeam,
        importTeam,
        saveTeam,
        uploadPlayerImage,
        removePlayerImage,
        resolvePlayerImage,
        notify,
        subscribe
    };
})(typeof globalThis !== 'undefined' ? globalThis : window);
