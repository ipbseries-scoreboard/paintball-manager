/*
 * SERVER LOCALE PAINTBALL MANAGER — web server + relay WebSocket.
 *
 * Sostituisce sia il server PeerJS ("peer") sia http-server:
 *   - Serve le pagine HTML a tutti i dispositivi:  http://IP:9000/referee.html?id=1674
 *   - Relay WebSocket su /ws: la Regia manda lo stato UNA volta, il server
 *     lo inoltra a tutti gli schermi. I comandi degli arbitri tornano alla Regia.
 *
 * Perché è meglio del P2P (PeerJS/WebRTC):
 *   - niente Match ID "occupati": se si apre una seconda Regia, la vecchia
 *     viene scollegata automaticamente (l'ultima vince);
 *   - niente negoziazione WebRTC (STUN/TURN/ICE) che fallisce su certe reti;
 *   - chi si collega tardi riceve subito l'ultimo stato completo (cache);
 *   - un solo processo, una sola porta.
 *
 * Avvio:  node server.js   (porta di default 9000, oppure: node server.js 9100)
 * Richiede: npm install (dipendenza "ws"), gestito da Avvia_Server_Locale.bat
 *
 * Protocollo (messaggi JSON, i tipi di servizio iniziano con "_"):
 *   client→server (primo msg): {type:'hello', room:'IPBA-1674', role:'host'|'client'}
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
const WebSocket = require('ws');

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
    let target = null;
    try { target = new URL(new URL(req.url, 'http://localhost').searchParams.get('url') || ''); } catch (e) { }
    if (!target || !/(^|\.)ipba\.it$/i.test(target.hostname)) { fail('URL non valido: ammessi solo link ipba.it', 400); return; }

    const fetchRemote = (u, depth) => {
        const lib = u.protocol === 'http:' ? http : https;
        const rq = lib.get(u, { headers: { 'User-Agent': 'Mozilla/5.0 (PaintballManager)' } }, (rs) => {
            // Segue eventuali redirect (max 3)
            if (rs.statusCode >= 300 && rs.statusCode < 400 && rs.headers.location && depth < 3) {
                rs.resume();
                try { fetchRemote(new URL(rs.headers.location, u), depth + 1); } catch (e) { fail('Redirect non valido'); }
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
        let urlPath = decodeURIComponent((req.url || '/').split('?')[0]);
        if (urlPath === '/' || urlPath === '') urlPath = '/index.html';
        if (urlPath === '/ipba') { proxyIpba(req, res); return; }
        const filePath = path.join(ROOT, path.normalize(urlPath));
        if (!filePath.startsWith(ROOT)) { res.writeHead(403); res.end('Accesso negato'); return; }
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
const wss = new WebSocket.Server({ server, path: '/ws' });

// room -> { host: ws|null, clients: Set<ws>, lastFullSync: string|null }
const rooms = new Map();

function getRoom(name) {
    let r = rooms.get(name);
    if (!r) { r = { host: null, clients: new Set(), lastFullSync: null }; rooms.set(name, r); }
    return r;
}

function safeSend(ws, data) {
    if (ws && ws.readyState === WebSocket.OPEN) {
        try { ws.send(data); } catch (e) { }
    }
}

function notifyRoster(room) {
    safeSend(room.host, JSON.stringify({ type: '_roster', count: room.clients.size }));
}

wss.on('connection', (ws) => {
    ws._room = null;
    ws._role = null;

    ws.on('message', (raw) => {
        const text = raw.toString();

        // Primo messaggio: presentazione (hello)
        if (!ws._room) {
            let hello;
            try { hello = JSON.parse(text); } catch (e) { ws.close(); return; }
            if (!hello || hello.type !== 'hello' || !hello.room) { ws.close(); return; }

            const roomName = String(hello.room).trim().toUpperCase();
            const room = getRoom(roomName);
            ws._room = roomName;
            ws._role = hello.role === 'host' ? 'host' : 'client';

            if (ws._role === 'host') {
                // L'ultima Regia vince: la precedente viene avvisata e scollegata.
                if (room.host && room.host !== ws) {
                    safeSend(room.host, JSON.stringify({ type: '_evicted' }));
                    try { room.host.close(); } catch (e) { }
                }
                room.host = ws;
                safeSend(ws, JSON.stringify({ type: '_welcome', role: 'host', count: room.clients.size }));
                room.clients.forEach(c => safeSend(c, JSON.stringify({ type: '_hostOnline' })));
                console.log(`[RELAY] Regia collegata alla stanza ${roomName} (${room.clients.size} schermi in attesa)`);
            } else {
                room.clients.add(ws);
                safeSend(ws, JSON.stringify({ type: '_welcome', role: 'client', hostOnline: !!room.host }));
                // Chi arriva tardi riceve subito l'ultimo stato completo conosciuto
                if (room.lastFullSync) safeSend(ws, room.lastFullSync);
                notifyRoster(room);
                console.log(`[RELAY] Schermo collegato alla stanza ${roomName} (totale: ${room.clients.size})`);
            }
            return;
        }

        const room = rooms.get(ws._room);
        if (!room) return;

        if (ws._role === 'host') {
            // Stato dalla Regia: cache del FULL_SYNC + inoltro identico a tutti gli schermi
            try {
                const p = JSON.parse(text);
                if (p && p.type === 'FULL_SYNC') room.lastFullSync = text;
            } catch (e) { }
            room.clients.forEach(c => safeSend(c, text));
        } else {
            // Comandi dagli schermi (referee) verso la Regia
            safeSend(room.host, text);
        }
    });

    ws.on('close', () => {
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
    });

    ws.on('error', () => { });
});

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
    console.log('  LASCIA APERTA QUESTA FINESTRA DURANTE IL TORNEO.');
    console.log('');
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
