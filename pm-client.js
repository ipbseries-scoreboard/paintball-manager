/*
 * PM-CLIENT v2.1 — Connettore condiviso del Paintball Manager.
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
 *       role: 'viewer',                  // viewer (default) oppure controller
 *       token: '',                       // PIN richiesto ai controller
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

    // Un'unica configurazione anche per i canali PeerJS secondari (Pubblico e
    // overlay OBS). Senza TURN quei canali funzionano in LAN, ma possono fallire
    // sulle reti mobili con NAT simmetrico anche quando il canale Regia è sano.
    function getCloudPeerOptions() {
        return {
            secure: true,
            host: '0.peerjs.com',
            port: 443,
            path: '/',
            debug: 1,
            config: {
                iceServers: ICE_CONFIG.iceServers.map(function (server) {
                    var copy = { urls: server.urls };
                    if (server.username) copy.username = server.username;
                    if (server.credential) copy.credential = server.credential;
                    return copy;
                })
            }
        };
    }

    var WS_WATCHDOG_MS = 5000;     // il relay locale risponde subito o mai
    var PEER_WATCHDOG_MS = 9000;   // PeerJS/cloud hanno bisogno di più tempo
    var END_OF_CYCLE_PAUSE = 6000; // pausa a fine giro per non martellare i server
    var STALE_AFTER_MS = 15000;    // dopo quanto i dati si considerano "vecchi"

    function normalizeId(raw) {
        if (!raw) return null;
        var id = String(raw).trim().toUpperCase().replace(/[\u0000-\u001f\u007f-\u009f]/g, '');
        if (!id) return null;
        if (id.indexOf('IPBA-') !== 0) id = 'IPBA-' + id;
        return id.slice(0, 80);
    }

    function getUrlId() {
        var p = new URLSearchParams(global.location.search);
        return p.get('id') || p.get('matchId');
    }

    function parseHostParam(value) {
        // "192.168.1.50" oppure "192.168.1.50:9100"
        if (!value) return null;
        value = String(value).trim();
        if (/^wss?:\/\//i.test(value)) {
            try {
                var parsed = new URL(value);
                var secureUrl = parsed.protocol === 'wss:';
                return {
                    host: parsed.hostname,
                    port: parsed.port ? parseInt(parsed.port, 10) : (secureUrl ? 443 : 80),
                    secure: secureUrl
                };
            } catch (e) { return null; }
        }
        var parts = value.split(':');
        var secure = global.location.protocol === 'https:';
        return { host: parts[0], port: parts[1] ? parseInt(parts[1], 10) : (secure ? 443 : 9000), secure: secure };
    }

    function buildCandidates(role, token) {
        var p = new URLSearchParams(global.location.search);
        var list = [];
        var seen = {};

        var forced = parseHostParam(p.get('host'));
        var pageHost = null;
        var hn = global.location.hostname;
        var isGithubPage = /\.github\.io$/i.test(hn || '');
        // I QR della Regia usano local=0 quando il CLOUD è selezionato. In quel
        // caso (e su GitHub Pages senza host esplicito) localhost è il telefono,
        // non la Regia: provarlo prima del cloud aggiunge timeout e falsi errori.
        var localOnly = p.get('local') === '1' || p.get('nocloud') === '1';
        var cloudOnly = !localOnly && (p.get('local') === '0' || (isGithubPage && !forced));
        var cloudController = role === 'controller' && /^\d{6}$/.test(String(token || ''));
        if (hn && !isGithubPage) {
            var pagePort = parseInt(global.location.port, 10);
            if (!pagePort) pagePort = global.location.protocol === 'https:' ? 443 : 80;
            pageHost = { host: hn, port: pagePort, secure: global.location.protocol === 'https:' };
        }
        var localHost = { host: 'localhost', port: 9000, secure: false };

        function addWs(target, label) {
            if (!target) return;
            var scheme = target.secure ? 'wss://' : 'ws://';
            var key = scheme + target.host + ':' + target.port;
            if (seen[key]) return;
            seen[key] = true;
            list.push({
                kind: 'ws',
                label: 'relay ' + label + ' (' + target.host + ':' + target.port + ')',
                url: scheme + target.host + ':' + target.port + '/ws',
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
                options: { secure: !!target.secure, host: target.host, port: target.port, path: '/', config: ICE_CONFIG, debug: 1 },
                watchdog: PEER_WATCHDOG_MS
            });
        }

        // 1. Relay WebSocket (il metodo preferito)
        if (p.get('norelay') !== '1') {
            addWs(forced, 'indicato');
            if (!cloudOnly) {
                addWs(pageHost, 'della pagina');
                addWs(localHost, 'locale');
            }
        }

        // 2. PeerJS locale (compatibilità col vecchio server "peer")
        // PeerJS non verifica i token: resta disponibile solo ai viewer legacy.
        // I controller devono usare il relay WebSocket autenticato.
        if (role === 'viewer') {
            addPeer(forced, 'indicato');
            if (!cloudOnly) {
                addPeer(pageHost, 'della pagina');
                addPeer(localHost, 'locale');
            }
        }

        // 3. Cloud PeerJS: disponibile anche a Streaming/Arbitro da
        // GitHub Pages, ma solo con un PIN controller completo. La Regia
        // verifica comunque il PIN prima di ogni comando mutante.
        if (!localOnly && (role === 'viewer' || cloudController)) {
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
        cfg = cfg || {};
        var hostId = normalizeId(cfg.id);
        var role = cfg.role === 'controller' || cfg.role === 'host' ? cfg.role : 'viewer';
        var token = cfg.token == null ? '' : String(cfg.token);
        var candidates = buildCandidates(role, token);
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
        var lastTransportAlive = 0;
        var lastStateReceived = 0;
        var hostConnectedAt = 0;
        var lastStateRequestAt = 0;
        var resumeTimer = null;
        var resumeVerifyTimer = null;
        var connectStartedAt = Date.now();
        // Ogni tentativo incrementa "gen": gli handler dei tentativi vecchi
        // si auto-disattivano (evita i loop di riconnessione sovrapposti).
        var gen = 0;

        function status(msg, isError) {
            if (cfg.onStatus) { try { cfg.onStatus(msg, !!isError); } catch (e) { } }
            if (isError) { console.warn('[PMClient]', msg); } else { console.log('[PMClient]', msg); }
        }

        function touchTransport() { lastTransportAlive = Date.now(); }

        function fireOpen(label) {
            var firstOpen = !connOpen;
            if (firstOpen) {
                hostConnectedAt = Date.now();
                lastStateReceived = 0;
            }
            connOpen = true;
            everOpened = true;
            touchTransport();
            if (!firstOpen) return;
            status('Connesso via ' + label);
            if (cfg.onOpen) { try { cfg.onOpen(); } catch (e) { console.error('[PMClient] onOpen:', e); } }
        }

        function isRegiaStatePacket(d) {
            if (!d || typeof d !== 'object') return false;
            return d.type === 'FULL_SYNC' || d.type === 'PARTIAL_SYNC' ||
                Number.isFinite(Number(d.stateRevision)) ||
                (Object.prototype.hasOwnProperty.call(d, 'timer') &&
                    (d.teamLeft || d.teamRight || d.mode));
        }

        function fireData(d) {
            touchTransport();
            // ACK e altri messaggi applicativi dimostrano che il collegamento ÃƒÂ¨
            // vivo, ma non che il tabellone abbia ricevuto uno stato aggiornato.
            if (isRegiaStatePacket(d)) lastStateReceived = Date.now();
            if (cfg.onData) { try { cfg.onData(d); } catch (e) { console.error('[PMClient] onData:', e); } }
        }

        function fireClose() {
            var was = connOpen;
            connOpen = false;
            if (was && cfg.onClose) { try { cfg.onClose(); } catch (e) { } }
        }

        function sendData(data) {
            if (!connOpen) return false;
            try {
                var outgoing = data;
                // Ogni comando futuro di un controller porta automaticamente il
                // PIN corrente: la sicurezza non dipende dalla singola pagina UI.
                if (role === 'controller' && data && typeof data === 'object' && !Array.isArray(data)) {
                    outgoing = Object.assign({}, data, { controlToken: token });
                }
                if (sock && sock.readyState === 1) { sock.send(JSON.stringify(outgoing)); return true; }
                if (conn && conn.open) { conn.send(outgoing); return true; }
            } catch (e) { }
            return false;
        }

        function requestFreshState(force) {
            var now = Date.now();
            if (!force && now - lastStateRequestAt < 3000) return false;
            if (!sendData({ type: 'requestState' })) return false;
            lastStateRequestAt = now;
            return true;
        }

        function cleanup() {
            gen++;
            connOpen = false;
            parked = false;
            if (watchdog) { clearTimeout(watchdog); watchdog = null; }
            if (resumeVerifyTimer) { clearTimeout(resumeVerifyTimer); resumeVerifyTimer = null; }
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
            var authRejected = false;
            var authRetryAllowed = false;
            try {
                s = new WebSocket(cand.url);
            } catch (e) {
                scheduleNext(300);
                return;
            }
            sock = s;

            s.onopen = function () {
                if (destroyed || myGen !== gen) return;
                var hello = { type: 'hello', role: role, token: token, room: hostId };
                if (role === 'host') {
                    hello.hostToken = cfg.hostToken == null ? token : String(cfg.hostToken);
                    hello.controlToken = cfg.controlToken == null ? token : String(cfg.controlToken);
                }
                s.send(JSON.stringify(hello));
            };

            s.onmessage = function (ev) {
                if (destroyed || myGen !== gen) return;
                var d;
                try { d = JSON.parse(ev.data); } catch (e) { return; }
                if (!d) return;
                touchTransport();

                if (d.type && d.type.charAt(0) === '_') {
                    // Messaggi di servizio del relay
                    if (d.type === '_authError') {
                        authRejected = true;
                        authRetryAllowed = d.code === 'REGIA_NOT_READY';
                        if (watchdog) { clearTimeout(watchdog); watchdog = null; }
                        status('Accesso negato dal relay: ' + (d.message || 'credenziali non valide.'), true);
                        fireClose();
                        try { s.close(); } catch (e) { }
                    } else if (d.type === '_welcome') {
                        if (watchdog) { clearTimeout(watchdog); watchdog = null; }
                        parked = true;
                        if (role === 'host') {
                            fireOpen(cand.label);
                        } else if (d.hostOnline) {
                            fireOpen(cand.label);
                            requestFreshState(true);
                        } else {
                            // Relay raggiunto ma Regia non ancora accesa: restiamo qui
                            // in attesa invece di ciclare a vuoto sugli altri server.
                            status('Relay ok. In attesa della Regia...');
                        }
                    } else if (d.type === '_hostOnline') {
                        fireOpen(cand.label);
                        requestFreshState(false);
                    } else if (d.type === '_hostOffline') {
                        status('Regia disconnessa. Resto in attesa che torni...', true);
                        fireClose();
                    }
                    // _hb aggiorna solo il trasporto (già fatto sopra), non la
                    // freschezza dei dati prodotti dalla Regia.
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
                if (authRejected) {
                    // Il token puÃ² diventare valido quando parte la Regia o
                    // dopo un cambio PIN: riprova senza martellare il relay.
                    if (authRetryAllowed) scheduleNext(END_OF_CYCLE_PAUSE);
                } else if (wasParked) {
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
            var authCommandId = null;
            var authRejected = false;
            var authTimer = null;
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

                function completePeerOpen() {
                    if (destroyed || myGen !== gen || authRejected) return;
                    if (watchdog) { clearTimeout(watchdog); watchdog = null; }
                    if (authTimer) { clearTimeout(authTimer); authTimer = null; }
                    fireOpen(cand.label);
                    // La Regia risponde con uno snapshot compatto e mirato.
                    requestFreshState(true);
                }

                c.on('open', function () {
                    if (destroyed || myGen !== gen) return;
                    if (role !== 'controller') {
                        completePeerOpen();
                        return;
                    }

                    // PeerJS autentica il canale ma non il ruolo applicativo. Prima
                    // di mostrare Streaming/Arbitro chiediamo quindi alla Regia di
                    // verificare davvero il PIN inserito.
                    authCommandId = 'pm-auth-' + Date.now() + '-' + Math.random().toString(36).slice(2);
                    status('Verifica PIN controller...');
                    try {
                        c.send({
                            type: 'AUTH_CONTROLLER',
                            commandId: authCommandId,
                            controlToken: token
                        });
                    } catch (e) {
                        authRejected = true;
                        if (watchdog) { clearTimeout(watchdog); watchdog = null; }
                        status('Verifica PIN non riuscita.', true);
                        try { c.close(); } catch (closeError) { }
                        return;
                    }
                    authTimer = setTimeout(function () {
                        if (destroyed || myGen !== gen || !authCommandId) return;
                        authRejected = true;
                        if (watchdog) { clearTimeout(watchdog); watchdog = null; }
                        status('Verifica PIN scaduta: controlla il codice e riprova.', true);
                        try { c.close(); } catch (e) { }
                    }, 6000);
                });

                c.on('data', function (raw) {
                    if (destroyed || myGen !== gen) return;
                    var d = raw;
                    if (typeof d === 'string') {
                        try { d = JSON.parse(d); } catch (e) { return; }
                    }
                    if (!d) return;
                    if (d.type === 'PING') {
                        touchTransport();
                        try { c.send({ type: 'PONG', ts: d.ts }); } catch (e) { }
                        return;
                    }
                    if (authCommandId) {
                        if (d.type === 'COMMAND_ACK' && d.commandId === authCommandId) {
                            // Compatibilita con la Regia immediatamente precedente:
                            // il comando sconosciuto arrivava al switch solo DOPO
                            // aver superato la verifica del PIN.
                            var legacyAccepted = /comando sconosciuto/i.test(String(d.message || ''));
                            if (d.accepted === true || legacyAccepted) {
                                authCommandId = null;
                                completePeerOpen();
                            } else {
                                authRejected = true;
                                if (authTimer) { clearTimeout(authTimer); authTimer = null; }
                                if (watchdog) { clearTimeout(watchdog); watchdog = null; }
                                status('Accesso negato: ' + (d.message || 'PIN controllo non valido.'), true);
                                try { c.close(); } catch (e) { }
                            }
                        }
                        return;
                    }
                    fireData(d);
                });

                c.on('close', function () {
                    if (destroyed || myGen !== gen) return;
                    if (authTimer) { clearTimeout(authTimer); authTimer = null; }
                    var was = connOpen;
                    fireClose();
                    if (authRejected) {
                        if (watchdog) { clearTimeout(watchdog); watchdog = null; }
                        return;
                    }
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
                var dataChannelAlive = connOpen && conn && conn.open;
                if (err.type === 'peer-unavailable') {
                    status('Regia "' + hostId + '" non trovata su ' + cand.label + '.', true);
                    scheduleNext(1500);
                } else if (err.type === 'network' || err.type === 'server-error' ||
                    err.type === 'socket-error' || err.type === 'socket-closed' ||
                    err.type === 'browser-incompatible') {
                    // PeerJS può perdere il solo server di signaling mentre il
                    // DataChannel WebRTC continua a funzionare. Distruggerlo qui
                    // provocava il loop di riapertura osservato su Safari/iPhone.
                    if (dataChannelAlive && err.type !== 'browser-incompatible') {
                        status('Segnalazione cloud temporaneamente instabile; canale dati ancora attivo.');
                        try { if (peer && !peer.destroyed && peer.disconnected) peer.reconnect(); } catch (e) { }
                        return;
                    }
                    status('Server non raggiungibile: ' + cand.label, true);
                    scheduleNext(500);
                }
                // Altri tipi: lascia decidere al watchdog.
            });
        }

        function tryCandidate() {
            if (destroyed) return;
            if (!candidates.length) {
                status('Nessun relay sicuro disponibile per il controller.', true);
                return;
            }
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

        // Safari sospende timer e socket quando cambia app o rete. Al ritorno
        // chiediamo uno stato fresco; se non arriva, riavviamo una sola volta il
        // candidato corrente invece di lasciare il tabellone in uno stato zombie.
        function recoverAfterResume() {
            if (destroyed || (global.document && global.document.visibilityState === 'hidden')) return;
            // Ignora il normale pageshow del primo caricamento: tryCandidate è già partito.
            if (!everOpened && Date.now() - connectStartedAt < 3000) return;
            if (resumeTimer) clearTimeout(resumeTimer);
            resumeTimer = setTimeout(function () {
                resumeTimer = null;
                if (destroyed) return;
                if (!connOpen) {
                    scheduleNext(0);
                    return;
                }
                var stateBeforeRequest = lastStateReceived;
                if (!requestFreshState(true)) return;
                if (resumeVerifyTimer) clearTimeout(resumeVerifyTimer);
                resumeVerifyTimer = setTimeout(function () {
                    resumeVerifyTimer = null;
                    if (destroyed || (global.document && global.document.visibilityState === 'hidden')) return;
                    if (!connOpen || !lastStateReceived || lastStateReceived <= stateBeforeRequest) {
                        status('Connessione ripresa senza dati: riconnessione CLOUD...', true);
                        candIdx = Math.max(0, candIdx - 1);
                        fireClose();
                        scheduleNext(0);
                    }
                }, 5000);
            }, 300);
        }

        function onVisibilityResume() {
            if (!global.document || global.document.visibilityState === 'visible') recoverAfterResume();
        }

        // ---------- BADGE "DATI NON AGGIORNATI" ----------
        var badgeEl = null;
        var badgeTimer = null;
        if (cfg.staleBadge) {
            badgeTimer = setInterval(function () {
                if (destroyed) { clearInterval(badgeTimer); return; }
                // Dati "vecchi" se: la Regia non è più raggiungibile (anche se il
                // relay è vivo e manda heartbeat), oppure non arriva più nulla.
                var now = Date.now();
                var transportStale = connOpen && lastTransportAlive &&
                    (now - lastTransportAlive > STALE_AFTER_MS);
                // Se è già arrivato almeno uno stato, i PING sullo stesso canale
                // provano che il flusso dati è ancora vivo anche quando il match è
                // fermo su PRONTO. Prima il solo stato invariato faceva comparire
                // falsamente il badge ogni 15 secondi.
                var initialStateMissing = connOpen && !lastStateReceived && hostConnectedAt &&
                    (now - hostConnectedAt > STALE_AFTER_MS);
                var stale = everOpened && (!connOpen || transportStale || initialStateMissing);
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

        if (global.document) global.document.addEventListener('visibilitychange', onVisibilityResume);
        global.addEventListener('pageshow', recoverAfterResume);
        global.addEventListener('online', recoverAfterResume);

        tryCandidate();

        return {
            send: sendData,
            get open() { return connOpen; },
            get transport() { return currentLabel; },
            destroy: function () {
                destroyed = true;
                if (timer) clearTimeout(timer);
                if (resumeTimer) clearTimeout(resumeTimer);
                if (resumeVerifyTimer) clearTimeout(resumeVerifyTimer);
                if (badgeTimer) clearInterval(badgeTimer);
                if (badgeEl) { badgeEl.remove(); badgeEl = null; }
                if (global.document) global.document.removeEventListener('visibilitychange', onVisibilityResume);
                global.removeEventListener('pageshow', recoverAfterResume);
                global.removeEventListener('online', recoverAfterResume);
                cleanup();
            }
        };
    }

    global.PMClient = {
        connect: connect,
        normalizeId: normalizeId,
        getUrlId: getUrlId,
        getCloudPeerOptions: getCloudPeerOptions
    };
})(window);
