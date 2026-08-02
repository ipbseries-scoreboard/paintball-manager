/*
 * SERVER LOCALE PAINTBALL MANAGER — web server + relay WebSocket.
 *
 * Sostituisce sia il server PeerJS ("peer") sia http-server:
 *   - Serve le pagine HTML a tutti i dispositivi:  http://IP:9000/referee.html?id=1674
 *   - Relay WebSocket su /ws: la Regia manda lo stato UNA volta, il server
 *     lo inoltra a tutti gli schermi. I comandi degli arbitri tornano alla Regia.
 *
 * Perché è meglio del P2P (PeerJS/WebRTC):
 *   - il Match ID Ã¨ protetto: una seconda Regia puÃ² sostituire la prima solo
 *     presentando lo stesso hostToken;
 *   - niente negoziazione WebRTC (STUN/TURN/ICE) che fallisce su certe reti;
 *   - chi si collega tardi riceve subito l'ultimo stato completo (cache);
 *   - un solo processo, una sola porta.
 *
 * Avvio:  node server.js   (porta di default 9000, oppure: node server.js 9100)
 * Richiede: npm install (dipendenza "ws"), gestito da Avvia_Server_Locale.bat
 *
 * Protocollo (messaggi JSON, i tipi di servizio iniziano con "_"):
 *   client→server (primo msg): {type:'hello', room:'IPBA-1674', role:'host'|'controller'|'viewer'}
 *   La Regia invia hostToken + controlToken; un controller invia token.
 *   Il vecchio ruolo "client" resta accettato come viewer di sola lettura.
 *   server→nuovo arrivato:     {type:'_welcome', role, hostOnline, count}
 *   server→schermi:            {type:'_hostOnline'} / {type:'_hostOffline'} / {type:'_hb'}
 *   server→Regia:              {type:'_roster', count} / {type:'_evicted'} / {type:'_hb'}
 *   Regia→server→schermi:      pacchetti di stato (inoltrati identici)
 *   schermo→server→Regia:      comandi (inoltrati identici)
 */
'use strict';

const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const WebSocket = require('ws');
const { handleRosterApi, getSetupAuthInfo, importAllFromRegistry, isLocalRequest, isSameOriginRequest } = require('./roster-server');

const PORT = parseInt(process.argv[2] || process.env.PORT || '9000', 10);
const ROOT = __dirname;

const MIME = {
    '.html': 'text/html; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.webp': 'image/webp',
    '.gif': 'image/gif',
    '.svg': 'image/svg+xml',
    '.ico': 'image/x-icon',
    '.mp3': 'audio/mpeg',
    '.woff': 'font/woff',
    '.woff2': 'font/woff2',
    '.txt': 'text/plain; charset=utf-8'
};

// ---------- PROXY IPBA ----------
// La pagina evento di ipba.it non manda header CORS, quindi il browser non può
// scaricarla direttamente da index.html. Questo endpoint la scarica lato server:
//   GET /ipba?url=https://www.ipba.it/evento.aspx?id=369
// Ammessi solo URL del dominio ipba.it (niente proxy aperto).
function proxyIpba(req, res) {
    const fail = (msg, code) => {
        if (!res.headersSent) res.writeHead(code || 502, { 'Content-Type': 'text/plain; charset=utf-8', 'Access-Control-Allow-Origin': '*' });
        res.end(msg);
    };
    const isAllowedTarget = (targetUrl) => !!targetUrl &&
        (targetUrl.protocol === 'http:' || targetUrl.protocol === 'https:') &&
        /(^|\.)(ipba\.it|gunzup\.com)$/i.test(targetUrl.hostname);
    let target = null;
    try { target = new URL(new URL(req.url, 'http://localhost').searchParams.get('url') || ''); } catch (e) { }
    if (!isAllowedTarget(target)) { fail('URL non valido: ammessi solo link HTTP/HTTPS di ipba.it o gunzup.com', 400); return; }

    const fetchRemote = (u, depth) => {
        const lib = u.protocol === 'http:' ? http : https;
        const rq = lib.get(u, { headers: { 'User-Agent': 'Mozilla/5.0 (PaintballManager)' } }, (rs) => {
            // Segue eventuali redirect (max 3)
            if (rs.statusCode >= 300 && rs.statusCode < 400 && rs.headers.location && depth < 3) {
                rs.resume();
                try {
                    const redirected = new URL(rs.headers.location, u);
                    if (!isAllowedTarget(redirected)) { fail('Redirect verso un dominio non consentito', 400); return; }
                    fetchRemote(redirected, depth + 1);
                } catch (e) { fail('Redirect non valido'); }
                return;
            }
            res.writeHead(rs.statusCode || 502, {
                'Content-Type': rs.headers['content-type'] || 'text/html; charset=utf-8',
                'Access-Control-Allow-Origin': '*',
                'Cache-Control': 'no-store'
            });
            rs.pipe(res);
        });
        rq.on('error', (e) => fail('Errore proxy: ' + e.message));
        rq.setTimeout(15000, () => rq.destroy(new Error('timeout')));
    };
    fetchRemote(target, 0);
}

// ---------- API "LOGHI SUL GREEN" ----------
// Config dell'overlay prospettico (streaming.html → sezione 🌿 GREEN).
// streaming.html la pubblica con POST; field-logos-overlay.html — anche dentro
// il Browser Input di vMix, che NON condivide il localStorage di Chrome — la
// legge con GET. Persistita su disco (data/field-logos/) per sopravvivere ai
// riavvii. Endpoint opzionale: su GitHub Pages l'overlay usa l'URL ?cfg=.
const FIELD_LOGOS_DIR = path.join(ROOT, 'data', 'field-logos');
const FIELD_LOGOS_MAX_BYTES = 8 * 1024 * 1024;
// Numero massimo di configurazioni distinte: senza tetto, ogni chiave nuova
// aggiungeva una voce in RAM (fino a 8 MB) e un file su disco, entrambi
// illimitati e scrivibili senza credenziali.
const FIELD_LOGOS_MAX_KEYS = positiveEnvInt('PM_FIELD_LOGOS_MAX_KEYS', 32);
const fieldLogosCache = new Map(); // chiave -> JSON string

// La scrittura dell'overlay in onda e' un'operazione da PC di regia, come il
// setup rose. La lettura invece resta libera: il Browser Input di vMix gira in
// un processo separato che non condivide i cookie di Chrome e deve poter fare
// GET della configurazione senza sessione.
function fieldLogosWriteAllowed(req) {
    // Local-only come il setup rose, piu' il controllo di origine che blocca il
    // CSRF da un sito qualunque aperto sul PC di regia (POST con Content-Type
    // semplice = nessun preflight che ci protegga).
    return isLocalRequest(req) && isSameOriginRequest(req);
}

function handleFieldLogosApi(req, res, parsedUrl) {
    const headers = {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'no-store',
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type',
        'X-Content-Type-Options': 'nosniff'
    };
    if (req.method === 'OPTIONS') { res.writeHead(204, headers); res.end(); return; }
    const m = /^\/api\/field-logos\/([a-z0-9_-]{1,40})$/i.exec(parsedUrl.pathname);
    const key = m ? m[1].toLowerCase() : null;
    if (!key) {
        res.writeHead(404, headers);
        res.end(JSON.stringify({ error: 'Chiave configurazione non valida' }));
        return;
    }
    const filePath = path.join(FIELD_LOGOS_DIR, key + '.json');

    if (req.method === 'GET') {
        const cached = fieldLogosCache.get(key);
        if (cached) { res.writeHead(200, headers); res.end(cached); return; }
        fs.readFile(filePath, 'utf8', (err, txt) => {
            if (err) {
                res.writeHead(404, headers);
                res.end(JSON.stringify({ error: 'Configurazione non trovata' }));
                return;
            }
            if (fieldLogosCache.size < FIELD_LOGOS_MAX_KEYS) fieldLogosCache.set(key, txt);
            res.writeHead(200, headers);
            res.end(txt);
        });
        return;
    }

    if (req.method === 'POST') {
        if (!fieldLogosWriteAllowed(req)) {
            res.writeHead(403, headers);
            res.end(JSON.stringify({ error: 'La configurazione GREEN si pubblica solo dal PC di regia.' }));
            return;
        }
        if (!fieldLogosCache.has(key) && fieldLogosCache.size >= FIELD_LOGOS_MAX_KEYS) {
            res.writeHead(429, headers);
            res.end(JSON.stringify({ error: 'Troppe configurazioni GREEN salvate (max ' + FIELD_LOGOS_MAX_KEYS + ').' }));
            return;
        }
        let size = 0;
        const chunks = [];
        let aborted = false;
        req.on('data', (c) => {
            size += c.length;
            if (size > FIELD_LOGOS_MAX_BYTES) {
                aborted = true;
                res.writeHead(413, headers);
                res.end(JSON.stringify({ error: 'Configurazione troppo grande' }));
                req.destroy();
                return;
            }
            chunks.push(c);
        });
        req.on('end', () => {
            if (aborted) return;
            const body = Buffer.concat(chunks).toString('utf8');
            let parsed = null;
            try { parsed = JSON.parse(body); } catch (e) { }
            if (!parsed || parsed.type !== 'pm-field-logos') {
                res.writeHead(400, headers);
                res.end(JSON.stringify({ error: 'JSON non valido (atteso type=pm-field-logos)' }));
                return;
            }
            fieldLogosCache.set(key, body);
            fs.mkdir(FIELD_LOGOS_DIR, { recursive: true }, (mkErr) => {
                if (mkErr) { console.warn('[FIELD-LOGOS] Cartella non creabile: ' + mkErr.message); return; }
                fs.writeFile(filePath, body, (err) => {
                    if (err) console.warn('[FIELD-LOGOS] Config non salvata su disco: ' + err.message);
                });
            });
            res.writeHead(200, headers);
            res.end(JSON.stringify({ ok: true, updatedAt: parsed.updatedAt || null }));
        });
        req.on('error', () => { });
        return;
    }

    res.writeHead(405, headers);
    res.end(JSON.stringify({ error: 'Metodo non supportato' }));
}

// ---------- WEB SERVER (pagine statiche) ----------
const server = http.createServer((req, res) => {
    try {
        const parsedUrl = new URL(req.url || '/', 'http://localhost');
        if (parsedUrl.pathname.startsWith('/api/field-logos/') || parsedUrl.pathname === '/api/field-logos') {
            handleFieldLogosApi(req, res, parsedUrl);
            return;
        }
        if (parsedUrl.pathname.startsWith('/api/rosters/')) {
            Promise.resolve(handleRosterApi(req, res, parsedUrl)).catch(error => {
                if (!res.headersSent) res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
                if (!res.writableEnded) res.end(JSON.stringify({ error: error.message || 'Errore API rose' }));
            });
            return;
        }
        let urlPath = decodeURIComponent((req.url || '/').split('?')[0]);
        if (urlPath === '/' || urlPath === '') urlPath = '/index.html';
        if (urlPath === '/ipba') { proxyIpba(req, res); return; }
        const rootPath = path.resolve(ROOT);
        const filePath = path.resolve(rootPath, '.' + urlPath);
        const rootPrefix = rootPath.endsWith(path.sep) ? rootPath : rootPath + path.sep;
        const insideRoot = filePath.toLowerCase().startsWith(rootPrefix.toLowerCase());
        if (!insideRoot) { res.writeHead(403); res.end('Accesso negato'); return; }
        // I file di servizio di atomicWrite (.bak e .tmp-PID-TIMESTAMP) non sono
        // contenuti pubblicabili: erano scaricabili come octet-stream.
        if (/\.bak$|\.tmp-\d+-\d+$/i.test(filePath)) { res.writeHead(403); res.end('Accesso negato'); return; }
        fs.readFile(filePath, (err, buf) => {
            if (err) { res.writeHead(404); res.end('File non trovato: ' + urlPath); return; }
            res.writeHead(200, {
                'Content-Type': MIME[path.extname(filePath).toLowerCase()] || 'application/octet-stream',
                'Cache-Control': 'no-store'
            });
            res.end(buf);
        });
    } catch (e) {
        res.writeHead(500); res.end('Errore server');
    }
});

// ---------- RELAY WEBSOCKET ----------
function positiveEnvInt(name, fallback) {
    const parsed = Number.parseInt(process.env[name], 10);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

const WS_MAX_PAYLOAD = positiveEnvInt('PM_RELAY_MAX_PAYLOAD', 16 * 1024 * 1024);
const MAX_BUFFERED_AMOUNT = positiveEnvInt('PM_RELAY_MAX_BUFFERED', 32 * 1024 * 1024);
const MAX_CONNECTIONS = positiveEnvInt('PM_RELAY_MAX_CONNECTIONS', 512);
const MAX_CONNECTIONS_PER_IP = positiveEnvInt('PM_RELAY_MAX_CONNECTIONS_PER_IP', 64);
const MAX_CLIENTS_PER_ROOM = positiveEnvInt('PM_RELAY_MAX_CLIENTS_PER_ROOM', 256);
const MAX_ROOMS = positiveEnvInt('PM_RELAY_MAX_ROOMS', 1024);
const HELLO_TIMEOUT_MS = positiveEnvInt('PM_RELAY_HELLO_TIMEOUT_MS', 5000);
const PING_INTERVAL_MS = positiveEnvInt('PM_RELAY_PING_INTERVAL_MS', 30000);
const REQUEST_STATE_INTERVAL_MS = positiveEnvInt('PM_RELAY_REQUEST_STATE_INTERVAL_MS', 1500);
// Una stanza conserva token e ownership anche mentre la Regia e' offline (serve
// per riprendere il controllo dopo un riavvio del PC di regia), ma non per
// sempre: senza scadenza le stanze si accumulavano fino a MAX_ROOMS e da quel
// momento il relay rifiutava OGNI nuovo Match ID, compreso quello legittimo.
const ROOM_RETENTION_MS = positiveEnvInt('PM_RELAY_ROOM_RETENTION_MS', 12 * 60 * 60 * 1000);
const ROOM_SWEEP_INTERVAL_MS = positiveEnvInt('PM_RELAY_ROOM_SWEEP_MS', 5 * 60 * 1000);
const CLIENT_MAX_MESSAGES_PER_SEC = positiveEnvInt('PM_RELAY_CLIENT_MSG_PER_SEC', 40);

const wss = new WebSocket.Server({
    server,
    path: '/ws',
    maxPayload: WS_MAX_PAYLOAD
});

// room -> { host, clients, lastFullSync, hostToken, controlToken }
const rooms = new Map();
const authFailures = new Map();
const AUTH_WINDOW_MS = 60000;
const AUTH_BLOCK_MS = 30000;
const AUTH_MAX_FAILURES = 8;

function getRoom(name) {
    let r = rooms.get(name);
    if (!r) {
        r = {
            host: null,
            clients: new Set(),
            lastFullSync: null,
            hostToken: null,
            controlToken: null,
            lastActiveAt: Date.now()
        };
        rooms.set(name, r);
    }
    return r;
}

function touchRoom(room) {
    if (room) room.lastActiveAt = Date.now();
}

// Libera le stanze rimaste senza Regia e senza schermi oltre la finestra di
// conservazione. Senza questo, chiunque poteva riservare 1024 Match ID a caso
// (bastano un hostToken qualsiasi e un PIN a 6 cifre) e bloccare il relay in
// modo permanente fino al riavvio del server.
function sweepExpiredRooms() {
    const now = Date.now();
    let removed = 0;
    rooms.forEach((room, name) => {
        if (room.host || room.clients.size) { touchRoom(room); return; }
        if (now - (room.lastActiveAt || 0) <= ROOM_RETENTION_MS) return;
        rooms.delete(name);
        removed += 1;
    });
    if (removed) console.log(`[RELAY] ${removed} stanze inattive liberate (limite ${MAX_ROOMS}).`);
    return removed;
}

// Se il tetto e' comunque stato raggiunto, si recupera lo slot piu' vecchio tra
// le stanze davvero vuote: un evento reale non perde mai la propria stanza,
// perche' finche' Regia o schermi sono collegati la stanza non e' candidabile.
function reclaimOldestIdleRoom() {
    let oldestName = null;
    let oldestAt = Infinity;
    rooms.forEach((room, name) => {
        if (room.host || room.clients.size) return;
        const at = room.lastActiveAt || 0;
        if (at < oldestAt) { oldestAt = at; oldestName = name; }
    });
    if (oldestName === null) return false;
    rooms.delete(oldestName);
    console.log(`[RELAY] Stanza inattiva ${oldestName} liberata per fare posto a un nuovo Match ID.`);
    return true;
}

function safeSend(ws, data) {
    if (ws && ws.readyState === WebSocket.OPEN) {
        const queued = Number(ws.bufferedAmount) || 0;
        const nextSize = typeof data === 'string' ? Buffer.byteLength(data) : (data && data.length) || 0;
        if (queued + nextSize > MAX_BUFFERED_AMOUNT) {
            try { ws.terminate(); } catch (e) { }
            return false;
        }
        try { ws.send(data); return true; } catch (e) { }
    }
    return false;
}

function notifyRoster(room) {
    safeSend(room.host, JSON.stringify({ type: '_roster', count: room.clients.size }));
}

function readToken(value) {
    return typeof value === 'string' ? value : '';
}

function clientAddress(ws) {
    return String(ws && ws._socket && ws._socket.remoteAddress || 'unknown');
}

function normalizeRoomName(value) {
    if (typeof value !== 'string' || /[\u0000-\u001f\u007f-\u009f]/.test(value)) return null;
    const normalized = value.trim().toUpperCase();
    return normalized && normalized.length <= 80 ? normalized : null;
}

function cleanupUnusedRoom(roomName, room) {
    if (!room || room.host || room.clients.size || room.hostToken || room.controlToken) return false;
    if (rooms.get(roomName) !== room) return false;
    rooms.delete(roomName);
    return true;
}

function openConnectionsForAddress(address) {
    let count = 0;
    wss.clients.forEach(client => {
        if (client.readyState !== WebSocket.CLOSED && clientAddress(client) === address) count += 1;
    });
    return count;
}

// La chiave include il Match ID di proposito: il contatore deve valere per la
// stanza bersaglio. Cambiare stanza non regala tentativi, perche' un controller
// su una stanza inesistente riceve REGIA_NOT_READY senza mai arrivare al
// confronto del PIN (e quindi senza consumare ne' azzerare nulla), mentre per
// forzare il PIN di una stanza reale bisogna per forza usarne il nome esatto.
function authFailureKey(ws, role, roomName) {
    return [clientAddress(ws), String(role || ''), String(roomName || '')].join('|');
}

function authIsBlocked(ws, role, roomName) {
    const now = Date.now();
    const key = authFailureKey(ws, role, roomName);
    const entry = authFailures.get(key);
    if (!entry) return false;
    if (entry.blockedUntil > now) return true;
    if (now - entry.windowStartedAt > AUTH_WINDOW_MS) authFailures.delete(key);
    return false;
}

function recordAuthFailure(ws, role, roomName) {
    const now = Date.now();
    const key = authFailureKey(ws, role, roomName);
    let entry = authFailures.get(key);
    if (!entry || now - entry.windowStartedAt > AUTH_WINDOW_MS) {
        entry = { windowStartedAt: now, failures: 0, blockedUntil: 0 };
    }
    entry.failures += 1;
    if (entry.failures >= AUTH_MAX_FAILURES) entry.blockedUntil = now + AUTH_BLOCK_MS;
    authFailures.set(key, entry);

    if (authFailures.size > 512) {
        for (const [savedKey, savedEntry] of authFailures) {
            if (now - savedEntry.windowStartedAt > AUTH_WINDOW_MS && savedEntry.blockedUntil <= now) {
                authFailures.delete(savedKey);
            }
        }
    }
}

function clearAuthFailures(ws, role, roomName) {
    authFailures.delete(authFailureKey(ws, role, roomName));
}

// Confronto a tempo costante: evita di rivelare la parte corretta del token.
// I token vuoti non sono mai credenziali valide.
function sameToken(expected, received) {
    expected = readToken(expected);
    received = readToken(received);
    if (!expected || !received) return false;
    const a = Buffer.from(expected, 'utf8');
    const b = Buffer.from(received, 'utf8');
    return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function rejectAuth(ws, code, message) {
    safeSend(ws, JSON.stringify({ type: '_authError', code, message }));
    // 1008 = violazione delle regole del protocollo. I messaggi giÃ  accodati
    // vengono trasmessi prima della chiusura, inclusa la spiegazione qui sopra.
    try { ws.close(1008, 'Autenticazione non valida'); } catch (e) { }
}

function normalizeRole(role) {
    if (role === 'host' || role === 'controller' || role === 'viewer') return role;
    // CompatibilitÃ  con i vecchi schermi, che usavano il ruolo "client".
    return 'viewer';
}

wss.on('connection', (ws) => {
    // Registra subito i gestori di trasporto: anche un payload rifiutato da
    // `ws` o una connessione oltre i limiti non deve produrre errori non gestiti.
    ws.on('error', () => { });
    ws._isAlive = true;
    ws.on('pong', () => { ws._isAlive = true; });

    const address = clientAddress(ws);
    // La connessione appena arrivata e' gia' dentro wss.clients, quindi il ">"
    // ammette esattamente MAX connessioni e rifiuta la successiva.
    if (wss.clients.size > MAX_CONNECTIONS || openConnectionsForAddress(address) > MAX_CONNECTIONS_PER_IP) {
        try { ws.close(1013, 'Relay occupato'); } catch (e) { }
        return;
    }

    ws._room = null;
    ws._role = null;
    ws._authRejected = false;
    ws._lastRequestStateAt = 0;
    ws._helloTimer = setTimeout(() => {
        if (!ws._room && !ws._authRejected) {
            try { ws.close(1008, 'Hello timeout'); } catch (e) { }
        }
    }, HELLO_TIMEOUT_MS);
    if (typeof ws._helloTimer.unref === 'function') ws._helloTimer.unref();

    ws.on('message', (raw) => {
        if (ws._authRejected) return;

        // Solo la Regia ha motivo di inviare traffico ad alta frequenza (lo
        // stato del match). Schermi e controller sono limitati: senza questo,
        // un client poteva far parsare al server payload da 16 MB in loop.
        if (ws._role && ws._role !== 'host') {
            const now = Date.now();
            if (now - (ws._msgWindowAt || 0) > 1000) { ws._msgWindowAt = now; ws._msgCount = 0; }
            ws._msgCount = (ws._msgCount || 0) + 1;
            if (ws._msgCount > CLIENT_MAX_MESSAGES_PER_SEC) {
                ws._authRejected = true;
                try { ws.close(1008, 'Troppi messaggi'); } catch (e) { }
                return;
            }
        }

        const text = raw.toString();

        // Primo messaggio: presentazione (hello)
        if (!ws._room) {
            clearTimeout(ws._helloTimer);
            ws._helloTimer = null;
            let hello;
            // Il timer di hello e' appena stato azzerato e il rate limiter piu'
            // sopra si applica solo a chi ha gia' un ruolo: senza _authRejected
            // ogni frame successivo rientrava qui e faceva parsare al server un
            // altro payload da WS_MAX_PAYLOAD, in loop, fino alla chiusura.
            const rejectHello = () => {
                ws._authRejected = true;
                try { ws.close(1008, 'Hello non valido'); } catch (e) { }
            };
            try { hello = JSON.parse(text); } catch (e) { rejectHello(); return; }
            if (!hello || hello.type !== 'hello') { rejectHello(); return; }

            const roomName = normalizeRoomName(hello.room);
            const role = normalizeRole(hello.role);
            if (!roomName) {
                ws._authRejected = true;
                rejectAuth(ws, 'ROOM_INVALID', 'Match ID non valido. Usare da 1 a 80 caratteri senza caratteri di controllo.');
                return;
            }

            if ((role === 'host' || role === 'controller') && authIsBlocked(ws, role, roomName)) {
                ws._authRejected = true;
                rejectAuth(ws, 'AUTH_RATE_LIMIT', 'Troppi tentativi non validi. Attendere 30 secondi.');
                return;
            }

            let room = rooms.get(roomName);
            if (!room && role === 'controller') {
                ws._authRejected = true;
                rejectAuth(ws, 'REGIA_NOT_READY', 'Regia non ancora inizializzata.');
                return;
            }

            if (!room) {
                if (rooms.size >= MAX_ROOMS) sweepExpiredRooms();
                if (rooms.size >= MAX_ROOMS) reclaimOldestIdleRoom();
                if (rooms.size >= MAX_ROOMS) {
                    ws._authRejected = true;
                    rejectAuth(ws, 'ROOM_LIMIT', 'Numero massimo di Match ID attivi raggiunto.');
                    return;
                }
                room = getRoom(roomName);
            }
            touchRoom(room);

            if (role === 'host') {
                const hostToken = readToken(hello.hostToken || hello.token);
                const controlToken = readToken(hello.controlToken);
                if (!hostToken || !/^\d{6}$/.test(controlToken)) {
                    ws._authRejected = true;
                    recordAuthFailure(ws, role, roomName);
                    cleanupUnusedRoom(roomName, room);
                    rejectAuth(ws, 'HOST_TOKEN_REQUIRED', 'Credenziali Regia mancanti.');
                    return;
                }
                if (room.hostToken && !sameToken(room.hostToken, hostToken)) {
                    recordAuthFailure(ws, role, roomName);
                    ws._authRejected = true;
                    rejectAuth(ws, 'HOST_TOKEN_INVALID', 'Un\'altra Regia protetta usa gia questo Match ID.');
                    return;
                }

                const controlTokenChanged = !!room.controlToken && !sameToken(room.controlToken, controlToken);
                if (!room.hostToken) room.hostToken = hostToken;
                room.controlToken = controlToken;
                clearAuthFailures(ws, role, roomName);
                ws._room = roomName;
                ws._role = role;

                // Se la Regia cambia PIN, i controller giÃ  autenticati devono
                // riconnettersi. I viewer, essendo di sola lettura, restano online.
                if (controlTokenChanged) {
                    room.clients.forEach(client => {
                        if (client._role === 'controller') {
                            client._authRejected = true;
                            rejectAuth(client, 'CONTROL_TOKEN_CHANGED', 'Il PIN arbitro Ã¨ cambiato: riconnettersi con il nuovo PIN.');
                        }
                    });
                }

                // Solo una Regia con lo stesso hostToken puÃ² sostituire quella attiva.
                if (room.host && room.host !== ws) {
                    safeSend(room.host, JSON.stringify({ type: '_evicted' }));
                    try { room.host.close(); } catch (e) { }
                }
                room.host = ws;
                safeSend(ws, JSON.stringify({ type: '_welcome', role: 'host', count: room.clients.size }));
                room.clients.forEach(c => safeSend(c, JSON.stringify({ type: '_hostOnline' })));
                console.log(`[RELAY] Regia collegata alla stanza ${roomName} (${room.clients.size} schermi in attesa)`);
            } else {
                if (role === 'controller' && !room.controlToken) {
                    ws._authRejected = true;
                    rejectAuth(ws, 'REGIA_NOT_READY', 'Regia non ancora inizializzata.');
                    return;
                }
                if (role === 'controller' && (!/^\d{6}$/.test(readToken(hello.token)) || !sameToken(room.controlToken, hello.token))) {
                    ws._authRejected = true;
                    recordAuthFailure(ws, role, roomName);
                    rejectAuth(ws, 'CONTROL_TOKEN_INVALID', 'PIN arbitro non valido o Regia non ancora inizializzata.');
                    return;
                }
                if (role === 'controller') clearAuthFailures(ws, role, roomName);

                if (room.clients.size >= MAX_CLIENTS_PER_ROOM) {
                    ws._authRejected = true;
                    cleanupUnusedRoom(roomName, room);
                    rejectAuth(ws, 'ROOM_FULL', 'Questa stanza ha raggiunto il numero massimo di schermi e controller.');
                    return;
                }

                ws._room = roomName;
                ws._role = role;
                room.clients.add(ws);
                safeSend(ws, JSON.stringify({ type: '_welcome', role, hostOnline: !!room.host }));
                // Una cache Ã¨ attendibile solo mentre la Regia che l'ha prodotta
                // Ã¨ realmente online; altrimenti si attende un nuovo FULL_SYNC.
                if (room.host && room.lastFullSync) safeSend(ws, room.lastFullSync);
                notifyRoster(room);
                console.log(`[RELAY] ${role === 'controller' ? 'Controller' : 'Schermo'} collegato alla stanza ${roomName} (totale: ${room.clients.size})`);
            }
            return;
        }

        const room = rooms.get(ws._room);
        if (!room) return;
        touchRoom(room);

        if (ws._role === 'host' && room.host === ws) {
            // Stato dalla Regia: cache del FULL_SYNC + inoltro identico a tutti gli schermi
            try {
                const p = JSON.parse(text);
                if (p && p.type === 'FULL_SYNC') room.lastFullSync = text;
            } catch (e) { }
            room.clients.forEach(c => safeSend(c, text));
        } else if (ws._role === 'controller') {
            // Solo un controller autenticato puÃ² inviare comandi alla Regia.
            safeSend(room.host, text);
        } else if (ws._role === 'viewer') {
            // I viewer sono di sola lettura, ma possono chiedere un nuovo stato
            // completo dopo l'ingresso o una riconnessione.
            try {
                const packet = JSON.parse(text);
                if (packet && packet.type === 'requestState' && room.host) {
                    const now = Date.now();
                    if (now - ws._lastRequestStateAt >= REQUEST_STATE_INTERVAL_MS) {
                        ws._lastRequestStateAt = now;
                        safeSend(room.host, text);
                    }
                }
            } catch (e) { }
        }
    });

    ws.on('close', () => {
        clearTimeout(ws._helloTimer);
        const room = ws._room && rooms.get(ws._room);
        if (!room) return;
        if (ws._role === 'host') {
            if (room.host === ws) {
                room.host = null;
                room.clients.forEach(c => safeSend(c, JSON.stringify({ type: '_hostOffline' })));
                console.log(`[RELAY] Regia scollegata dalla stanza ${ws._room}`);
            }
        } else {
            room.clients.delete(ws);
            notifyRoster(room);
        }
        // Le stanze inizializzate conservano token e ownership anche se restano
        // offline. Si eliminano subito le attese vuote create da viewer pre-Regia;
        // le altre restano prenotate per ROOM_RETENTION_MS, poi le libera lo sweep.
        touchRoom(room);
        cleanupUnusedRoom(ws._room, room);
    });
});

// Heartbeat WebSocket: i browser rispondono automaticamente al ping. Una
// connessione che non risponde entro il giro successivo viene liberata, così
// non occupa per sempre i limiti del relay.
const pingInterval = setInterval(() => {
    wss.clients.forEach(ws => {
        if (ws._isAlive === false) {
            try { ws.terminate(); } catch (e) { }
            return;
        }
        ws._isAlive = false;
        try { ws.ping(); } catch (e) { }
    });
}, PING_INTERVAL_MS);
if (typeof pingInterval.unref === 'function') pingInterval.unref();

// Pulizia periodica delle stanze abbandonate (vedi sweepExpiredRooms).
const roomSweepInterval = setInterval(sweepExpiredRooms, ROOM_SWEEP_INTERVAL_MS);
if (typeof roomSweepInterval.unref === 'function') roomSweepInterval.unref();

// Heartbeat applicativo: permette agli schermi di capire di essere vivi
// anche quando la partita è ferma e non arrivano pacchetti di stato.
const heartbeatInterval = setInterval(() => {
    const hb = JSON.stringify({ type: '_hb', ts: Date.now() });
    rooms.forEach(room => {
        room.clients.forEach(c => safeSend(c, hb));
        safeSend(room.host, hb);
    });
}, 5000);
// Come gli altri due timer del relay: non deve tenere vivo il processo da solo.
if (typeof heartbeatInterval.unref === 'function') heartbeatInterval.unref();

// ---------- AVVIO ----------
server.listen(PORT, () => {
    const rosterAuth = getSetupAuthInfo();
    console.log('===================================================');
    console.log('  SERVER PAINTBALL MANAGER ATTIVO (porta ' + PORT + ')');
    console.log('===================================================');
    console.log('');
    console.log('  PC Regia:        http://localhost:' + PORT + '/');
    const ifaces = os.networkInterfaces();
    Object.keys(ifaces).forEach(name => {
        (ifaces[name] || []).forEach(addr => {
            if (addr.family === 'IPv4' && !addr.internal) {
                console.log('  Tablet arbitro:  http://' + addr.address + ':' + PORT + '/referee.html?id=1674');
                console.log('  Altri schermi:   http://' + addr.address + ':' + PORT + '/streaming.html?id=1674');
            }
        });
    });
    console.log('');
    console.log('  (sostituisci 1674 con il tuo Match ID)');
    console.log('');
    if (rosterAuth.configured) {
        console.log('  Setup rose: password personalizzata attiva.');
    } else {
        console.log('  PASSWORD SETUP ROSE: ' + rosterAuth.generatedPassword);
        console.log('  La password cambia al riavvio del server.');
        console.log('  Per renderla fissa imposta PM_ROSTER_PASSWORD.');
    }
    console.log('  LASCIA APERTA QUESTA FINESTRA DURANTE IL TORNEO.');
    console.log('');

    // Aggiornamento automatico delle rose dai link fissi del pannello
    // GESTIONE ROSE & LOGHI (registry). Parte in background: il server
    // è già utilizzabile mentre le rose si aggiornano una alla volta.
    setTimeout(() => {
        importAllFromRegistry({ log: console.log }).then(results => {
            if (results.length) {
                console.log('[ROSE] Aggiornamento automatico completato (' +
                    results.filter(r => r.ok).length + '/' + results.length + ' squadre).');
            }
        }).catch(error => console.log('[ROSE] Aggiornamento automatico non riuscito: ' + error.message));
    }, 3000);
});

// Il WebSocket.Server e' agganciato allo stesso http server e ne RI-EMETTE gli
// errori su di se'. Non avendo un ascoltatore, un errore di listen (tipicamente
// EADDRINUSE) diventava un "Unhandled 'error' event" e usciva con lo stack
// trace di Node: il messaggio in italiano qui sotto non si vedeva mai, proprio
// nel caso per cui era stato scritto. Qui lo assorbiamo e lasciamo rispondere
// il gestore del server, che stampa la spiegazione e chiude.
wss.on('error', () => { });

server.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
        console.error('ERRORE: la porta ' + PORT + ' e\' gia\' occupata.');
        console.error('Chiudi il server avviato in precedenza e riprova.');
    } else {
        console.error('Errore server:', err.message);
    }
    process.exit(1);
});
