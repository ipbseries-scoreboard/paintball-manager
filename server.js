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
const { handleRosterApi, getSetupAuthInfo, importAllFromRegistry } = require('./roster-server');

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

// ---------- WEB SERVER (pagine statiche) ----------
const server = http.createServer((req, res) => {
    try {
        const parsedUrl = new URL(req.url || '/', 'http://localhost');
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
            controlToken: null
        };
        rooms.set(name, r);
    }
    return r;
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
        const text = raw.toString();

        // Primo messaggio: presentazione (hello)
        if (!ws._room) {
            clearTimeout(ws._helloTimer);
            ws._helloTimer = null;
            let hello;
            try { hello = JSON.parse(text); } catch (e) { ws.close(1008, 'Hello non valido'); return; }
            if (!hello || hello.type !== 'hello') { ws.close(1008, 'Hello non valido'); return; }

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
                if (rooms.size >= MAX_ROOMS) {
                    ws._authRejected = true;
                    rejectAuth(ws, 'ROOM_LIMIT', 'Numero massimo di Match ID attivi raggiunto.');
                    return;
                }
                room = getRoom(roomName);
            }

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
        // offline. Si eliminano solo attese vuote create da viewer pre-Regia.
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

// Heartbeat applicativo: permette agli schermi di capire di essere vivi
// anche quando la partita è ferma e non arrivano pacchetti di stato.
setInterval(() => {
    const hb = JSON.stringify({ type: '_hb', ts: Date.now() });
    rooms.forEach(room => {
        room.clients.forEach(c => safeSend(c, hb));
        safeSend(room.host, hb);
    });
}, 5000);

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

server.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
        console.error('ERRORE: la porta ' + PORT + ' e\' gia\' occupata.');
        console.error('Chiudi il server avviato in precedenza e riprova.');
    } else {
        console.error('Errore server:', err.message);
    }
    process.exit(1);
});
