/*
 * PM-CLIENT v2 — Connettore condiviso del Paintball Manager.
 *
 * Tutte le pagine "client" (referee, pit, ledwall, streaming, board,
 * obs_bar, vmix_bg) usano questo file per collegarsi alla Regia (index.html).
 *
 * Trasporti provati in ordine, con rotazione automatica:
 *   1. RELAY WebSocket (server.js)  — ws://?host=IP[:porta] / host pagina / localhost
 *      Il metodo preferito: niente WebRTC, niente ID occupati, latenza LAN.
 *      Se il relay risponde ma la Regia non c'è ancora, il client RESTA in
 *      attesa sul relay (niente cicli a vuoto) e si aggancia appena arriva.
 *   2. PeerJS locale (porta 9000)   — compatibilità col vecchio server "peer"
 *   3. PeerJS cloud (0.peerjs.com)  — per board.html visto da casa
 *      (disattivabile con ?nocloud=1; il relay si salta con ?norelay=1)
 *
 * Gestisce da solo: retry senza loop sovrapposti, PING/PONG, richiesta dello
 * stato iniziale, pacchetti pre-stringificati, e il badge "DATI NON AGGIORNATI"
 * (opzione staleBadge: true) che avvisa quando non arrivano più dati.
 *
 * Uso:
 *   const conn = PMClient.connect({
 *       id: '1674',                      // con o senza prefisso IPBA-
 *       onData:   (packet) => { ... },   // pacchetti di stato (mai PING/servizio)
 *       onStatus: (msg, isError) => {},  // testo di stato per la UI
 *       onOpen:   () => { ... },         // connessione alla Regia stabilita
 *       onClose:  () => { ... },         // connessione persa (riprova da solo)
 *       staleBadge: true                 // mostra il badge se i dati si fermano
 *   });
 *   conn.send({...});  // true se inviato (referee: comandi)
 *   conn.open;         // boolean
 *   conn.destroy();    // stop definitivo
 */
(function (global) {
    'use strict';

    // ---------- PROTEZIONE LOCALSTORAGE ----------
    // In alcuni contesti (URL "data:", webview con storage disabilitato) leggere
    // window.localStorage lancia un SecurityError e uccide l'intera pagina.
    // In quel caso lo sostituiamo con una copia in memoria: tutto funziona,
    // semplicemente le preferenze non sopravvivono alla chiusura.
    (function () {
        try {
            global.localStorage.getItem('__pm_test__');
        } catch (e) {
            var mem = {};
            var fake = {
                getItem: function (k) { return Object.prototype.hasOwnProperty.call(mem, k) ? mem[k] : null; },
                setItem: function (k, v) { mem[k] = String(v); },
                removeItem: function (k) { delete mem[k]; },
                clear: function () { mem = {}; },
                key: function (i) { return Object.keys(mem)[i] || null; }
            };
            try {
                Object.defineProperty(fake, 'length', { get: function () { return Object.keys(mem).length; } });
                Object.defineProperty(global, 'localStorage', { value: fake, configurable: true });
                console.warn('[PMClient] localStorage non disponibile: uso memoria temporanea (le preferenze non verranno salvate).');
            } catch (e2) { }
        }
    })();

    var ICE_CONFIG = {
        iceServers: [
            { urls: 'stun:stun.l.google.com:19302' },
            { urls: 'stun:stun.relay.metered.ca:80' },
            { urls: 'turn:global.relay.metered.ca:80', username: 'fe841146f64ad98d3f631f65', credential: '1RWiOOZ7GOYCgcBw' },
            { urls: 'turn:global.relay.metered.ca:443', username: 'fe841146f64ad98d3f631f65', credential: '1RWiOOZ7GOYCgcBw' }
        ]
    };

    var WS_WATCHDOG_MS = 5000;     // il relay locale risponde subito o mai
    var PEER_WATCHDOG_MS = 9000;   // PeerJS/cloud hanno bisogno di più tempo
    var END_OF_CYCLE_PAUSE = 6000; // pausa a fine giro per non martellare i server
    var STALE_AFTER_MS = 15000;    // dopo quanto i dati si considerano "vecchi"

    function normalizeId(raw) {
        if (!raw) return null;
        var id = String(raw).trim().toUpperCase();
        if (!id) return null;
        return id.indexOf('IPBA-') === 0 ? id : 'IPBA-' + id;
    }

    function getUrlId() {
        var p = new URLSearchParams(global.location.search);
        return p.get('id') || p.get('matchId');
    }

    function parseHostParam(value) {
        // "192.168.1.50" oppure "192.168.1.50:9100"
        if (!value) return null;
        var parts = value.split(':');
        return { host: parts[0], port: parts[1] ? parseInt(parts[1], 10) : 9000 };
    }

    function buildCandidates() {
        var p = new URLSearchParams(global.location.search);
        var list = [];
        var seen = {};

        var forced = parseHostParam(p.get('host'));
        var pageHost = null;
        var hn = global.location.hostname;
        if (hn && hn !== 'localhost' && hn !== '127.0.0.1' && hn.indexOf('github.io') === -1) {
            pageHost = { host: hn, port: 9000 };
        }
        var localHost = { host: 'localhost', port: 9000 };

        function addWs(target, label) {
            if (!target) return;
            var key = 'ws:' + target.host + ':' + target.port;
            if (seen[key]) return;
            seen[key] = true;
            list.push({
                kind: 'ws',
                label: 'relay ' + label + ' (' + target.host + ':' + target.port + ')',
                url: 'ws://' + target.host + ':' + target.port + '/ws',
                watchdog: WS_WATCHDOG_MS
            });
        }

        function addPeer(target, label) {
            if (!target) return;
            var key = 'peer:' + target.host + ':' + target.port;
            if (seen[key]) return;
            seen[key] = true;
            list.push({
                kind: 'peer',
                label: 'PeerJS ' + label + ' (' + target.host + ':' + target.port + ')',
                options: { secure: false, host: target.host, port: target.port, path: '/', config: ICE_CONFIG, debug: 1 },
                watchdog: PEER_WATCHDOG_MS
            });
        }

        // 1. Relay WebSocket (il metodo preferito)
        if (p.get('norelay') !== '1') {
            addWs(forced, 'indicato');
            addWs(pageHost, 'della pagina');
            addWs(localHost, 'locale');
        }

        // 2. PeerJS locale (compatibilità col vecchio server "peer")
        addPeer(forced, 'indicato');
        addPeer(pageHost, 'della pagina');
        addPeer(localHost, 'locale');

        // 3. Cloud PeerJS (board.html da casa)
        if (p.get('nocloud') !== '1') {
            list.push({
                kind: 'peer',
                label: 'cloud PeerJS',
                options: { secure: true, host: '0.peerjs.com', port: 443, path: '/', config: ICE_CONFIG, debug: 1 },
                watchdog: PEER_WATCHDOG_MS
            });
        }
        return list;
    }

    function connect(cfg) {
        var hostId = normalizeId(cfg.id);
        var candidates = buildCandidates();
        var candIdx = 0;
        var peer = null;      // trasporto PeerJS attivo
        var conn = null;      // DataConnection PeerJS attiva
        var sock = null;      // WebSocket relay attiva
        var connOpen = false; // Regia raggiungibile adesso
        var parked = false;   // agganciati al relay, in attesa della Regia
        var destroyed = false;
        var timer = null;
        var watchdog = null;
        var currentLabel = '';
        var everOpened = false;
        var lastAlive = 0;
        // Ogni tentativo incrementa "gen": gli handler dei tentativi vecchi
        // si auto-disattivano (evita i loop di riconnessione sovrapposti).
        var gen = 0;

        function status(msg, isError) {
            if (cfg.onStatus) { try { cfg.onStatus(msg, !!isError); } catch (e) { } }
            if (isError) { console.warn('[PMClient]', msg); } else { console.log('[PMClient]', msg); }
        }

        function touch() { lastAlive = Date.now(); }

        function fireOpen(label) {
            connOpen = true;
            everOpened = true;
            touch();
            status('Connesso via ' + label);
            if (cfg.onOpen) { try { cfg.onOpen(); } catch (e) { console.error('[PMClient] onOpen:', e); } }
        }

        function fireData(d) {
            touch();
            if (cfg.onData) { try { cfg.onData(d); } catch (e) { console.error('[PMClient] onData:', e); } }
        }

        function fireClose() {
            var was = connOpen;
            connOpen = false;
            if (was && cfg.onClose) { try { cfg.onClose(); } catch (e) { } }
        }

        function cleanup() {
            gen++;
            connOpen = false;
            parked = false;
            if (watchdog) { clearTimeout(watchdog); watchdog = null; }
            if (conn) { try { conn.close(); } catch (e) { } conn = null; }
            if (peer) { try { peer.destroy(); } catch (e) { } peer = null; }
            if (sock) { try { sock.onclose = null; sock.close(); } catch (e) { } sock = null; }
        }

        function scheduleNext(delay) {
            if (destroyed) return;
            if (timer) clearTimeout(timer);
            // A fine giro completo dei candidati, pausa più lunga
            if (candIdx > 0 && candIdx % candidates.length === 0 && delay < END_OF_CYCLE_PAUSE) {
                delay = END_OF_CYCLE_PAUSE;
            }
            timer = setTimeout(tryCandidate, delay);
        }

        // ---------- TRASPORTO 1: RELAY WEBSOCKET ----------
        function tryWs(cand, myGen) {
            var s;
            try {
                s = new WebSocket(cand.url);
            } catch (e) {
                scheduleNext(300);
                return;
            }
            sock = s;

            s.onopen = function () {
                if (destroyed || myGen !== gen) return;
                s.send(JSON.stringify({ type: 'hello', role: 'client', room: hostId }));
            };

            s.onmessage = function (ev) {
                if (destroyed || myGen !== gen) return;
                var d;
                try { d = JSON.parse(ev.data); } catch (e) { return; }
                if (!d) return;
                touch();

                if (d.type && d.type.charAt(0) === '_') {
                    // Messaggi di servizio del relay
                    if (d.type === '_welcome') {
                        if (watchdog) { clearTimeout(watchdog); watchdog = null; }
                        parked = true;
                        if (d.hostOnline) {
                            fireOpen(cand.label);
                            try { s.send(JSON.stringify({ type: 'requestState' })); } catch (e) { }
                        } else {
                            // Relay raggiunto ma Regia non ancora accesa: restiamo qui
                            // in attesa invece di ciclare a vuoto sugli altri server.
                            status('Relay ok. In attesa della Regia...');
                        }
                    } else if (d.type === '_hostOnline') {
                        fireOpen(cand.label);
                        try { s.send(JSON.stringify({ type: 'requestState' })); } catch (e) { }
                    } else if (d.type === '_hostOffline') {
                        status('Regia disconnessa. Resto in attesa che torni...', true);
                        fireClose();
                    }
                    // _hb: solo touch() (già fatto sopra)
                    return;
                }

                if (d.type === 'PING') {
                    try { s.send(JSON.stringify({ type: 'PONG', ts: d.ts })); } catch (e) { }
                    return;
                }
                fireData(d);
            };

            s.onclose = function () {
                if (destroyed || myGen !== gen) return;
                var wasParked = parked;
                parked = false;
                fireClose();
                if (wasParked) {
                    // Il relay funzionava: riprova subito lo stesso candidato
                    status('Connessione al relay persa. Riconnessione...', true);
                    candIdx = Math.max(0, candIdx - 1);
                    scheduleNext(1500);
                } else {
                    scheduleNext(300);
                }
            };

            s.onerror = function () { /* segue sempre onclose */ };
        }

        // ---------- TRASPORTO 2/3: PEERJS (locale o cloud) ----------
        function tryPeer(cand, myGen) {
            var p;
            try {
                p = new Peer(cand.options);
            } catch (e) {
                status('Errore inizializzazione rete: ' + e.message, true);
                scheduleNext(1000);
                return;
            }
            peer = p;

            p.on('open', function () {
                if (destroyed || myGen !== gen) return;
                var c = p.connect(hostId);
                conn = c;

                c.on('open', function () {
                    if (destroyed || myGen !== gen) return;
                    if (watchdog) { clearTimeout(watchdog); watchdog = null; }
                    fireOpen(cand.label);
                    try { c.send({ type: 'requestState' }); } catch (e) { }
                });

                c.on('data', function (raw) {
                    if (destroyed || myGen !== gen) return;
                    var d = raw;
                    if (typeof d === 'string') {
                        try { d = JSON.parse(d); } catch (e) { return; }
                    }
                    if (!d) return;
                    if (d.type === 'PING') {
                        touch();
                        try { c.send({ type: 'PONG', ts: d.ts }); } catch (e) { }
                        return;
                    }
                    fireData(d);
                });

                c.on('close', function () {
                    if (destroyed || myGen !== gen) return;
                    var was = connOpen;
                    fireClose();
                    if (was) {
                        status('Connessione persa. Riconnessione...', true);
                        candIdx = Math.max(0, candIdx - 1);
                        scheduleNext(2000);
                    } else {
                        scheduleNext(1500);
                    }
                });

                c.on('error', function () { /* sfocia in close o nel watchdog */ });
            });

            p.on('disconnected', function () {
                if (destroyed || myGen !== gen) return;
                try { if (peer && !peer.destroyed) peer.reconnect(); } catch (e) { }
            });

            p.on('error', function (err) {
                if (destroyed || myGen !== gen) return;
                if (err.type === 'peer-unavailable') {
                    status('Regia "' + hostId + '" non trovata su ' + cand.label + '.', true);
                    scheduleNext(1500);
                } else if (err.type === 'network' || err.type === 'server-error' ||
                    err.type === 'socket-error' || err.type === 'socket-closed' ||
                    err.type === 'browser-incompatible') {
                    status('Server non raggiungibile: ' + cand.label, true);
                    scheduleNext(500);
                }
                // Altri tipi: lascia decidere al watchdog.
            });
        }

        function tryCandidate() {
            if (destroyed) return;
            cleanup();
            var myGen = gen;
            var cand = candidates[candIdx % candidates.length];
            candIdx++;
            currentLabel = cand.label;
            status('Cerco la Regia su ' + cand.label + '...');

            watchdog = setTimeout(function () {
                if (destroyed || myGen !== gen || connOpen || parked) return;
                status('Nessuna risposta da ' + cand.label + '.', true);
                scheduleNext(300);
            }, cand.watchdog);

            if (cand.kind === 'ws') {
                tryWs(cand, myGen);
            } else {
                tryPeer(cand, myGen);
            }
        }

        // ---------- BADGE "DATI NON AGGIORNATI" ----------
        var badgeEl = null;
        var badgeTimer = null;
        if (cfg.staleBadge) {
            badgeTimer = setInterval(function () {
                if (destroyed) { clearInterval(badgeTimer); return; }
                // Dati "vecchi" se: la Regia non è più raggiungibile (anche se il
                // relay è vivo e manda heartbeat), oppure non arriva più nulla.
                var stale = everOpened && (!connOpen || (Date.now() - lastAlive > STALE_AFTER_MS));
                if (stale && !badgeEl) {
                    badgeEl = document.createElement('div');
                    badgeEl.id = 'pm-stale-badge';
                    badgeEl.textContent = '⚠ DATI NON AGGIORNATI';
                    badgeEl.style.cssText =
                        'position:fixed;top:10px;right:10px;z-index:2147483647;' +
                        'background:#dc2626;color:#fff;font-family:sans-serif;' +
                        'font-size:16px;font-weight:bold;padding:8px 14px;' +
                        'border-radius:8px;box-shadow:0 2px 8px rgba(0,0,0,.5);' +
                        'pointer-events:none;';
                    document.body.appendChild(badgeEl);
                } else if (!stale && badgeEl) {
                    badgeEl.remove();
                    badgeEl = null;
                }
            }, 2000);
        }

        if (!hostId) {
            status('Match ID mancante.', true);
            return {
                send: function () { return false; },
                get open() { return false; },
                get transport() { return ''; },
                destroy: function () { if (badgeTimer) clearInterval(badgeTimer); }
            };
        }

        tryCandidate();

        return {
            send: function (data) {
                if (!connOpen) return false;
                try {
                    if (sock && sock.readyState === 1) { sock.send(JSON.stringify(data)); return true; }
                    if (conn) { conn.send(data); return true; }
                } catch (e) { }
                return false;
            },
            get open() { return connOpen; },
            get transport() { return currentLabel; },
            destroy: function () {
                destroyed = true;
                if (timer) clearTimeout(timer);
                if (badgeTimer) clearInterval(badgeTimer);
                if (badgeEl) { badgeEl.remove(); badgeEl = null; }
                cleanup();
            }
        };
    }

    global.PMClient = {
        connect: connect,
        normalizeId: normalizeId,
        getUrlId: getUrlId
    };
})(window);
