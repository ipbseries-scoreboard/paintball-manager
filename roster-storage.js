(function (root) {
    'use strict';
    const Core = root.IPBARosterCore;
    if (!Core) throw new Error('roster-core.js deve essere caricato prima di roster-storage.js');

    const DB_NAME = 'ipba_roster_assets';
    const DB_VERSION = 1;
    const STORE = 'images';
    const objectUrls = new Map();
    const channel = typeof BroadcastChannel !== 'undefined' ? new BroadcastChannel('ipba_roster_setup') : null;

    function token() {
        const query = new URLSearchParams(location.search).get('token');
        if (query) { try { localStorage.setItem('ipba_roster_token', query); } catch (error) { } return query; }
        try { return localStorage.getItem('ipba_roster_token') || ''; } catch (error) { return ''; }
    }

    function headers(extra) {
        const out = Object.assign({}, extra || {});
        if (token()) out['X-Roster-Token'] = token();
        return out;
    }

    async function request(url, options) {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 20000);
        try {
            const response = await fetch(url, Object.assign({}, options || {}, { headers: headers(options && options.headers), signal: controller.signal, cache: 'no-store' }));
            const text = await response.text();
            let body = null;
            try { body = text ? JSON.parse(text) : {}; } catch (error) { body = { error: text || 'Risposta server non valida' }; }
            if (!response.ok) throw new Error(body.error || ('Errore HTTP ' + response.status));
            return body;
        } finally { clearTimeout(timer); }
    }

    function localKey(teamId) { return 'ipba_roster_team::' + Core.safeTeamId(teamId); }

    function saveLocal(roster) {
        const clean = Core.normalizeRoster(roster);
        try { localStorage.setItem(localKey(clean.team.id), JSON.stringify(clean)); } catch (error) { }
        return clean;
    }

    function loadLocal(teamId) {
        try {
            const raw = localStorage.getItem(localKey(teamId));
            return raw ? Core.normalizeRoster(JSON.parse(raw), teamId) : null;
        } catch (error) { return null; }
    }

    async function loadTeam(teamId, options) {
        const id = Core.safeTeamId(teamId);
        if (!id) throw new Error('ID squadra non valido');
        try {
            const payload = await request('/api/rosters/' + encodeURIComponent(id) + ((options && options.noImport) ? '?noImport=1' : ''));
            const roster = saveLocal(payload.roster || payload);
            return { roster, storage: 'SERVER', warning: payload.warning || '' };
        } catch (serverError) {
            try {
                const response = await fetch('data/rosters/team-' + encodeURIComponent(id) + '/roster.json', { cache: 'no-store' });
                if (response.ok) {
                    const roster = saveLocal(Core.normalizeRoster(await response.json(), id));
                    return { roster, storage: 'STATICO', warning: 'Configurazione pubblicata in sola lettura. Per modificarla, usa il server locale e ripubblica i file.' };
                }
            } catch (staticError) { }
            const local = loadLocal(id);
            if (local) return { roster: local, storage: 'LOCALE', warning: 'Server rose non raggiungibile: uso la copia di questo browser.' };
            throw new Error('Rosa non disponibile. Avvia il server locale oppure importala dal setup. Dettaglio: ' + serverError.message);
        }
    }

    async function importTeam(teamId, existing) {
        const id = Core.safeTeamId(teamId);
        if (!id) throw new Error('ID squadra non valido');
        try {
            const payload = await request('/api/rosters/' + encodeURIComponent(id) + '/import', { method: 'POST' });
            return { roster: saveLocal(payload.roster), storage: 'SERVER', warning: payload.warning || '' };
        } catch (serverError) {
            try {
                const sourceUrl = 'https://www.ipba.it/video-team-giocatori.aspx?id=' + encodeURIComponent(id);
                const response = await fetch('/ipba?url=' + encodeURIComponent(sourceUrl), { cache: 'no-store' });
                if (!response.ok) throw new Error('HTTP ' + response.status);
                const imported = Core.parseIpbaHtml(await response.text(), id);
                const merged = Core.mergeImported(existing || loadLocal(id), imported);
                saveLocal(merged);
                return { roster: merged, storage: 'LOCALE', warning: 'Importazione salvata solo in questo browser: API server non disponibile.' };
            } catch (fallbackError) {
                throw new Error('Importazione IPBA non riuscita: ' + fallbackError.message + '. Server: ' + serverError.message);
            }
        }
    }

    async function saveTeam(roster) {
        const clean = Core.normalizeRoster(Object.assign({}, roster, { updatedAt: Date.now() }));
        saveLocal(clean);
        try {
            const payload = await request('/api/rosters/' + encodeURIComponent(clean.team.id), {
                method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(clean)
            });
            const saved = saveLocal(payload.roster || clean);
            notify('ROSTER_CONFIG_UPDATED', saved.team.id, saved.updatedAt);
            return { roster: saved, storage: 'SERVER' };
        } catch (error) {
            notify('ROSTER_CONFIG_UPDATED', clean.team.id, clean.updatedAt);
            return { roster: clean, storage: 'LOCALE', warning: 'Salvato soltanto in questo browser: ' + error.message };
        }
    }

    function openDb() {
        return new Promise((resolve, reject) => {
            if (!indexedDB) { reject(new Error('IndexedDB non disponibile')); return; }
            const request = indexedDB.open(DB_NAME, DB_VERSION);
            request.onupgradeneeded = () => { if (!request.result.objectStoreNames.contains(STORE)) request.result.createObjectStore(STORE); };
            request.onsuccess = () => resolve(request.result);
            request.onerror = () => reject(request.error || new Error('Errore IndexedDB'));
        });
    }

    async function idbPut(key, blob) {
        const db = await openDb();
        await new Promise((resolve, reject) => {
            const tx = db.transaction(STORE, 'readwrite'); tx.objectStore(STORE).put(blob, key);
            tx.oncomplete = resolve; tx.onerror = () => reject(tx.error);
        });
        db.close();
    }

    async function idbGet(key) {
        const db = await openDb();
        const value = await new Promise((resolve, reject) => {
            const tx = db.transaction(STORE, 'readonly'); const req = tx.objectStore(STORE).get(key);
            req.onsuccess = () => resolve(req.result || null); req.onerror = () => reject(req.error);
        });
        db.close(); return value;
    }

    async function idbDelete(key) {
        const db = await openDb();
        await new Promise((resolve, reject) => {
            const tx = db.transaction(STORE, 'readwrite'); tx.objectStore(STORE).delete(key);
            tx.oncomplete = resolve; tx.onerror = () => reject(tx.error);
        });
        db.close();
    }

    async function uploadPlayerImage(teamId, playerKey, blob, metadata) {
        const id = Core.safeTeamId(teamId), key = Core.safePlayerKey(playerKey);
        if (!id || !key || !(blob instanceof Blob)) throw new Error('Foto o identificativi non validi');
        try {
            const url = '/api/rosters/' + encodeURIComponent(id) + '/players/' + encodeURIComponent(key) + '/photo';
            const payload = await request(url, {
                method: 'POST', headers: {
                    'Content-Type': blob.type || 'image/png',
                    'X-Image-Transparency': metadata && metadata.hasTransparency ? '1' : '0',
                    'X-Image-Width': String(metadata && metadata.width || 0),
                    'X-Image-Height': String(metadata && metadata.height || 0)
                }, body: blob
            });
            notify('PLAYER_IMAGE_UPDATED', id, Date.now());
            return { storage: 'SERVER', url: payload.url, storageKey: '', warning: '' };
        } catch (serverError) {
            const storageKey = safeStorageKey(id, key);
            await idbPut(storageKey, blob);
            notify('PLAYER_IMAGE_UPDATED', id, Date.now());
            return { storage: 'LOCALE', url: '', storageKey, warning: 'Foto disponibile solo in questo browser: ' + serverError.message };
        }
    }

    function safeStorageKey(teamId, playerKey) { return 'team-' + Core.safeTeamId(teamId) + '::' + Core.safePlayerKey(playerKey); }

    async function removePlayerImage(teamId, playerKey, storageKey) {
        const id = Core.safeTeamId(teamId), key = Core.safePlayerKey(playerKey);
        if (storageKey) { try { await idbDelete(storageKey); } catch (error) { } }
        try { await request('/api/rosters/' + encodeURIComponent(id) + '/players/' + encodeURIComponent(key) + '/photo', { method: 'DELETE' }); } catch (error) { }
        revokeObjectUrl(storageKey); notify('PLAYER_IMAGE_UPDATED', id, Date.now());
    }

    async function resolvePlayerImage(player) {
        if (!player) return '';
        const image = player.image || {}, source = player.source || {};
        if (image.selectedSource === 'CUSTOM') {
            if (image.customImageUrl) return image.customImageUrl;
            if (image.customImageStorageKey) {
                if (objectUrls.has(image.customImageStorageKey)) return objectUrls.get(image.customImageStorageKey);
                try {
                    const blob = await idbGet(image.customImageStorageKey);
                    if (blob) { const url = URL.createObjectURL(blob); objectUrls.set(image.customImageStorageKey, url); return url; }
                } catch (error) { }
            }
        }
        return source.originalPhotoUrl || '';
    }

    function revokeObjectUrl(key) {
        const url = objectUrls.get(key); if (url) URL.revokeObjectURL(url); objectUrls.delete(key);
    }

    function notify(type, teamId, updatedAt) {
        const packet = { type, teamId: Core.safeTeamId(teamId), updatedAt: Number(updatedAt) || Date.now() };
        if (channel) channel.postMessage(packet);
        try { window.postMessage(packet, location.origin); } catch (error) { }
    }

    addEventListener('beforeunload', () => { objectUrls.forEach(url => URL.revokeObjectURL(url)); objectUrls.clear(); });

    root.IPBARosterStorage = { request, loadTeam, importTeam, saveTeam, loadLocal, saveLocal, uploadPlayerImage, removePlayerImage, resolvePlayerImage, notify, token };
})(typeof globalThis !== 'undefined' ? globalThis : window);
