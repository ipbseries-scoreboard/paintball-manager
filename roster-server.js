'use strict';

const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const http = require('http');
const https = require('https');
const crypto = require('crypto');
const cheerio = require('cheerio');
const Core = require('./roster-core');

const ROOT = __dirname;
const DATA_ROOT = process.env.PM_ROSTER_DATA_DIR
    ? path.resolve(process.env.PM_ROSTER_DATA_DIR)
    : path.join(ROOT, 'data', 'rosters');
const MAX_JSON = 2 * 1024 * 1024;
const MAX_PHOTO = 10 * 1024 * 1024;
const MAX_DIMENSION = 6000;
const MAX_PIXELS = 25 * 1000 * 1000;
const SESSION_MAX_AGE_MS = 8 * 60 * 60 * 1000;
const AUTH_WINDOW_MS = 60 * 1000;
const AUTH_BLOCK_MS = 60 * 1000;
const AUTH_MAX_FAILURES = 6;
const configuredPassword = String(process.env.PM_ROSTER_PASSWORD || '').trim();
const generatedPassword = configuredPassword ? '' : crypto.randomBytes(7).toString('base64url');
const setupPassword = configuredPassword || generatedPassword;
const sessions = new Map();
const loginFailures = new Map();

function json(res, status, value, extraHeaders) {
    const body = status === 204 ? Buffer.alloc(0) : Buffer.from(JSON.stringify(value));
    res.writeHead(status, Object.assign({
        'Content-Type': 'application/json; charset=utf-8',
        'Content-Length': body.length,
        'Cache-Control': 'no-store',
        'Pragma': 'no-cache',
        'X-Content-Type-Options': 'nosniff',
        'Referrer-Policy': 'same-origin'
    }, extraHeaders || {}));
    res.end(body);
}

function getSetupAuthInfo() {
    return {
        configured: !!configuredPassword,
        generatedPassword
    };
}

function hashText(value) {
    return crypto.createHash('sha256').update(String(value || ''), 'utf8').digest();
}

function safeEqual(left, right) {
    return crypto.timingSafeEqual(hashText(left), hashText(right));
}

function clientAddress(req) {
    return String(req && req.socket && req.socket.remoteAddress || '');
}

function isLocalRequest(req) {
    const address = clientAddress(req).toLowerCase();
    return address === '127.0.0.1' ||
        address === '::1' ||
        address === 'localhost' ||
        address === '::ffff:127.0.0.1';
}

// Difesa CSRF per gli endpoint di scrittura che non possono richiedere la
// sessione di setup. Un browser invia sempre Origin sulle richieste POST
// cross-site, quindi un'origine diversa dalla nostra e' un tentativo esterno.
// Un Origin assente indica un client non-browser (curl, script), che non e'
// il vettore CSRF.
function isSameOriginRequest(req) {
    const origin = req && req.headers && req.headers.origin;
    if (!origin) return true;
    try {
        const host = new URL(origin).host.toLowerCase();
        const expected = String(req.headers.host || '').toLowerCase();
        return !!expected && host === expected;
    } catch (error) {
        return false;
    }
}

function readCookies(req) {
    const output = {};
    String(req.headers.cookie || '').split(';').forEach(part => {
        const separator = part.indexOf('=');
        if (separator < 1) return;
        const key = part.slice(0, separator).trim();
        const value = part.slice(separator + 1).trim();
        if (key) output[key] = value;
    });
    return output;
}

function cleanupSessions() {
    const now = Date.now();
    sessions.forEach((session, token) => {
        if (!session || session.expiresAt <= now) sessions.delete(token);
    });
}

function authenticatedSession(req) {
    if (!isLocalRequest(req)) return null;
    cleanupSessions();
    const token = readCookies(req).pm_roster_session;
    const session = token && sessions.get(token);
    if (!session || session.address !== clientAddress(req)) return null;
    session.expiresAt = Date.now() + SESSION_MAX_AGE_MS;
    return session;
}

function cookieHeader(token, maxAgeSeconds) {
    return 'pm_roster_session=' + token +
        '; Path=/; HttpOnly; SameSite=Strict; Max-Age=' + maxAgeSeconds;
}

function authFailureEntry(address) {
    const now = Date.now();
    // Pulizia opportunistica: la mappa e' indicizzata per indirizzo e senza
    // questo passaggio cresceva senza limite.
    if (loginFailures.size > 256) {
        loginFailures.forEach((saved, key) => {
            if (now - saved.windowStartedAt > AUTH_WINDOW_MS && saved.blockedUntil <= now) loginFailures.delete(key);
        });
    }
    let entry = loginFailures.get(address);
    // Un blocco ancora attivo non va azzerato dalla scadenza della finestra:
    // altrimenti il blocco da 60 s ne durava in pratica una cinquantina.
    if (!entry || (now - entry.windowStartedAt > AUTH_WINDOW_MS && entry.blockedUntil <= now)) {
        entry = { windowStartedAt: now, failures: 0, blockedUntil: 0 };
        loginFailures.set(address, entry);
    }
    return entry;
}

function registerLoginFailure(address) {
    const entry = authFailureEntry(address);
    entry.failures += 1;
    if (entry.failures >= AUTH_MAX_FAILURES) entry.blockedUntil = Date.now() + AUTH_BLOCK_MS;
}

function canAttemptLogin(address) {
    return authFailureEntry(address).blockedUntil <= Date.now();
}

function teamDir(teamId) {
    return path.join(DATA_ROOT, 'team-' + Core.safeTeamId(teamId));
}

function registryPath() {
    return path.join(DATA_ROOT, 'registry.json');
}

function extractRegistryTeamId(value) {
    try {
        const url = new URL(String(value || ''));
        if (!/(^|\.)ipba\.it$/i.test(url.hostname)) return '';
        return Core.safeTeamId(url.searchParams.get('id') || '');
    } catch (error) {
        return '';
    }
}

function normalizeRegistry(input) {
    const teams = Array.isArray(input && input.teams) ? input.teams.slice(0, 100) : [];
    return {
        updatedAt: Math.max(0, Number(input && input.updatedAt) || 0),
        teams: teams.map(team => ({
            name: Core.cleanText(team && team.name, 100),
            rosterUrl: Core.safeHttpUrl(team && team.rosterUrl),
            logoUrl: Core.safeHttpUrl(team && team.logoUrl),
            teamId: extractRegistryTeamId(team && team.rosterUrl)
        })).filter(team => team.name)
    };
}

async function readRegistry() {
    try {
        return normalizeRegistry(JSON.parse(await fsp.readFile(registryPath(), 'utf8')));
    } catch (error) {
        return { updatedAt: 0, teams: [] };
    }
}

// ---------- ARCHIVIO GIOCATORI ----------
// I campi che appartengono al giocatore (non alla squadra) vivono in
// players.json con chiave playerId IPBA: foto, regolazioni e dati anagrafici
// personalizzati seguono il giocatore anche quando viene prestato.
const ARCHIVE_GLOBAL_FIELDS = ['firstName', 'lastName', 'displayName', 'number', 'role', 'nickname'];
const DEFAULT_PLAYER_IMAGE = Core.defaultPlayer('', {}, 0).image;

function archivePath() {
    return path.join(DATA_ROOT, 'players.json');
}

async function readArchive() {
    try {
        const raw = JSON.parse(await fsp.readFile(archivePath(), 'utf8'));
        return {
            updatedAt: Math.max(0, Number(raw && raw.updatedAt) || 0),
            players: raw && raw.players && typeof raw.players === 'object' ? raw.players : {}
        };
    } catch (error) {
        return { updatedAt: 0, players: {} };
    }
}

function archiveEntryFromPlayer(player) {
    const entry = { customData: {}, image: Object.assign({}, player.image) };
    ARCHIVE_GLOBAL_FIELDS.forEach(field => { entry.customData[field] = player.customData[field]; });
    return entry;
}

function overlayArchiveEntry(player, entry) {
    const data = entry && entry.customData && typeof entry.customData === 'object' ? entry.customData : {};
    ARCHIVE_GLOBAL_FIELDS.forEach(field => { player.customData[field] = data[field] == null ? '' : data[field]; });
    player.image = Object.assign({}, player.image, entry && entry.image && typeof entry.image === 'object' ? entry.image : {});
}

function hasArchivableConfig(player) {
    return !!(player.image.customImageUrl ||
        player.image.selectedSource === 'CUSTOM' ||
        ARCHIVE_GLOBAL_FIELDS.some(field => player.customData[field]) ||
        Object.keys(DEFAULT_PLAYER_IMAGE).some(field => player.image[field] !== DEFAULT_PLAYER_IMAGE[field]));
}

// Lettura: overlay dell'archivio sui giocatori con playerId; le configurazioni
// inline pre-archivio creano la voce mancante (seed di migrazione).
// Scrittura esplicita (updateArchive): write-through dei campi globali.
// Gli import NON usano updateArchive, altrimenti una rosa appena importata
// (tutta default) azzererebbe le configurazioni archiviate.
async function syncRosterWithArchive(roster, updateArchive) {
    const archive = await readArchive();
    let changed = false;
    roster.players.forEach(player => {
        const id = player.source.playerId;
        if (!id) return;
        const entry = archive.players[id];
        if (updateArchive) {
            if (entry || hasArchivableConfig(player)) {
                const next = archiveEntryFromPlayer(player);
                if (JSON.stringify(entry) !== JSON.stringify(next)) {
                    archive.players[id] = next;
                    changed = true;
                }
            }
        } else if (entry) {
            overlayArchiveEntry(player, entry);
        } else if (hasArchivableConfig(player)) {
            archive.players[id] = archiveEntryFromPlayer(player);
            changed = true;
        }
    });
    if (changed) {
        archive.updatedAt = Date.now();
        await atomicWrite(archivePath(), JSON.stringify(archive, null, 2));
    }
    return Core.normalizeRoster(roster, roster.team.id);
}

function configPath(teamId) {
    return path.join(teamDir(teamId), 'roster.json');
}

async function atomicWrite(file, data) {
    await fsp.mkdir(path.dirname(file), { recursive: true });
    const temp = file + '.tmp-' + process.pid + '-' + Date.now();
    if (fs.existsSync(file)) {
        try {
            await fsp.copyFile(file, file + '.bak');
        } catch (error) {
            // Il backup è prudenziale: un errore qui non deve bloccare il salvataggio atomico.
        }
    }
    await fsp.writeFile(temp, data);
    await fsp.rename(temp, file);
}

// ---------- SERIALIZZAZIONE DELLE SCRITTURE ----------
// roster.json e players.json si aggiornano con un ciclo leggi-modifica-scrivi.
// setup_rose.html apre le due squadre in parallelo (Promise.all + ?fresh=1):
// due importazioni simultanee leggevano lo STESSO players.json e la seconda
// riscriveva sopra le voci appena aggiunte dalla prima, perdendole. atomicWrite
// rende atomico il singolo file, non serializza gli scrittori: serve una coda.
//
// ATTENZIONE: il lock NON e' rientrante. Va preso solo dai punti di ingresso
// (readRoster / saveRoster / la sezione critica di importRoster, savePhoto,
// deletePhoto e della POST registry) e MAI dalle funzioni *Unlocked che quei
// punti richiamano, altrimenti si blocca tutto in attesa di se stesso.
let rosterQueue = Promise.resolve();

function withRosterLock(task) {
    // Il secondo argomento di then() fa proseguire la coda anche quando
    // l'operazione precedente e' fallita: un errore non deve incastrarla.
    const run = rosterQueue.then(task, task);
    rosterQueue = run.then(() => undefined, () => undefined);
    return run;
}

async function readRosterUnlocked(teamId) {
    let raw;
    try {
        raw = JSON.parse(await fsp.readFile(configPath(teamId), 'utf8'));
    } catch (error) {
        return null;
    }
    return syncRosterWithArchive(Core.normalizeRoster(raw, teamId), false);
}

async function saveRosterUnlocked(roster, options) {
    const id = roster && roster.team && roster.team.id;
    let clean = Core.normalizeRoster(roster, id);
    if (!clean.team.id) throw Object.assign(new Error('ID squadra non valido'), { status: 400 });
    clean = await syncRosterWithArchive(clean, !!(options && options.updateArchive));
    clean.updatedAt = Date.now();
    await atomicWrite(configPath(clean.team.id), JSON.stringify(clean, null, 2));
    return clean;
}

// readRoster scrive comunque: syncRosterWithArchive semina in players.json le
// configurazioni inline pre-archivio. Anche la lettura va quindi serializzata.
function readRoster(teamId) {
    return withRosterLock(() => readRosterUnlocked(teamId));
}

function saveRoster(roster, options) {
    return withRosterLock(() => saveRosterUnlocked(roster, options));
}

function readBody(req, limit) {
    return new Promise((resolve, reject) => {
        const chunks = [];
        let total = 0;
        let finished = false;
        const fail = error => {
            if (finished) return;
            finished = true;
            reject(error);
            try {
                req.destroy();
            } catch (destroyError) {
                // Nessuna azione necessaria.
            }
        };
        req.on('data', chunk => {
            total += chunk.length;
            if (total > limit) {
                fail(Object.assign(new Error('Payload troppo grande'), { status: 413 }));
                return;
            }
            chunks.push(chunk);
        });
        req.on('end', () => {
            if (!finished) {
                finished = true;
                resolve(Buffer.concat(chunks));
            }
        });
        req.on('error', fail);
    });
}

async function readJson(req, limit) {
    const body = await readBody(req, limit);
    try {
        return body.length ? JSON.parse(body.toString('utf8')) : {};
    } catch (error) {
        throw Object.assign(new Error('JSON non valido'), { status: 400 });
    }
}

function allowedIpbaUrl(value) {
    try {
        const url = new URL(value);
        return (url.protocol === 'https:' || url.protocol === 'http:') &&
            /(^|\.)ipba\.it$/i.test(url.hostname)
            ? url
            : null;
    } catch (error) {
        return null;
    }
}

function fetchText(target, depth) {
    depth = depth || 0;
    return new Promise((resolve, reject) => {
        const url = allowedIpbaUrl(target);
        if (!url) {
            reject(new Error('URL IPBA non consentito'));
            return;
        }
        const protocol = url.protocol === 'http:' ? http : https;
        const request = protocol.get(url, {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) IPBA-Roster/2.0',
                Accept: 'text/html,application/xhtml+xml'
            }
        }, response => {
            if (response.statusCode >= 300 && response.statusCode < 400 && response.headers.location && depth < 3) {
                response.resume();
                let next;
                try {
                    next = new URL(response.headers.location, url).href;
                } catch (error) {
                    reject(new Error('Redirect IPBA non valido'));
                    return;
                }
                fetchText(next, depth + 1).then(resolve, reject);
                return;
            }
            if (response.statusCode !== 200) {
                response.resume();
                reject(new Error('IPBA HTTP ' + response.statusCode));
                return;
            }
            const chunks = [];
            let total = 0;
            response.on('data', chunk => {
                total += chunk.length;
                if (total <= 3 * 1024 * 1024) chunks.push(chunk);
                else request.destroy(new Error('Pagina IPBA troppo grande'));
            });
            response.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
        });
        request.setTimeout(20000, () => request.destroy(new Error('Timeout IPBA')));
        request.on('error', reject);
    });
}

function absoluteIpbaUrl(value) {
    try {
        return Core.safeHttpUrl(value ? new URL(String(value), 'https://www.ipba.it/').href : '');
    } catch (error) {
        return '';
    }
}

function findPlayerBlock($, image) {
    let node = $(image).closest('table');
    while (node && node.length) {
        if (node.find('img[src*="/public/user_"]').length === 1 && node.find('b, strong').length) return node;
        node = node.parent().closest('table');
    }
    return null;
}

function findTeamHeader($, logo) {
    let node = logo.closest('table');
    while (node && node.length) {
        const text = Core.cleanText(node.text(), 700);
        if (/codice\s+(?:fidasc|societ[aà])/i.test(text) || node.find('h1,h2,h3').length) return node;
        node = node.parent().closest('table, div');
    }
    return logo.parent();
}

function parseIpbaRoster(html, teamId) {
    const id = Core.safeTeamId(teamId);
    const roster = Core.defaultTeam(id);
    const $ = cheerio.load(String(html || ''), { xmlMode: false, decodeEntities: true });

    const logo = $('img[src*="/public/team_' + id + '/"]').first();
    if (logo.length) {
        roster.team.originalLogoUrl = absoluteIpbaUrl(logo.attr('src'));
        const header = findTeamHeader($, logo);
        roster.team.name = Core.cleanText(header.find('h1,h2,h3').first().text(), 100) ||
            Core.cleanText(header.find('b,strong').first().text(), 100) ||
            roster.team.name;
        const raw = Core.cleanText(header.text(), 700);
        const code = raw.match(/codice\s+(?:fidasc|societ[aà])\s*([A-Za-z0-9/-]+)/i);
        roster.team.companyCode = code ? Core.cleanText(code[1], 50) : '';
        roster.team.companyName = Core.cleanText(
            raw.replace(roster.team.name, '').replace(/codice\s+(?:fidasc|societ[aà]).*$/i, ''),
            180
        );
    }

    const seen = new Set();
    $('img[src*="/public/user_"]').each((index, image) => {
        const block = findPlayerBlock($, image);
        if (!block || !block.length) return;

        const photoUrl = absoluteIpbaUrl($(image).attr('src'));
        const playerIdMatch = photoUrl.match(/\/public\/user_([^/]+)/i);
        const playerId = playerIdMatch ? Core.safeTeamId(playerIdMatch[1]) : '';
        const fullName = Core.cleanText(block.find('b,strong').first().text(), 100);
        if (!fullName) return;

        let number = '';
        block.find('div,span,td').each((_, element) => {
            if (number) return;
            const value = Core.cleanText($(element).text(), 20);
            if (/^\d{1,3}$/.test(value)) number = value;
        });
        const detail = Core.cleanText(block.text(), 700)
            .match(/(\d{1,3})\s*anni(?:\s*-\s*([A-Za-zÀ-ÿ0-9 /_-]+))?/i);
        const link = $(image).closest('a[href]').attr('href') || block.find('a[href*="id="]').first().attr('href');
        const player = Core.defaultPlayer(id, {
            source: {
                type: 'IPBA',
                playerId,
                profileUrl: absoluteIpbaUrl(link) || (playerId ? 'https://www.ipba.it/profilo.aspx?id=' + playerId : ''),
                originalPhotoUrl: photoUrl,
                markupId: $(image).attr('data-player-id') || ''
            },
            originalData: {
                fullName,
                number,
                role: detail && detail[2] ? Core.cleanText(detail[2], 40) : '',
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
    return Core.normalizeRoster(roster, id);
}

async function importRoster(teamId) {
    const id = Core.safeTeamId(teamId);
    if (!id) throw Object.assign(new Error('ID squadra non valido'), { status: 400 });
    const sourceUrl = 'https://www.ipba.it/video-team-giocatori.aspx?id=' + encodeURIComponent(id);
    const imported = parseIpbaRoster(await fetchText(sourceUrl), id);
    if (!imported.team.name || imported.team.name === 'TEAM ' + id) {
        throw Object.assign(new Error('La pagina IPBA non contiene una squadra valida'), { status: 502 });
    }
    // Il download da IPBA resta FUORI dal lock (fino a 20 s di timeout): dentro
    // ci sta solo il leggi-fondi-scrivi, che deve essere indivisibile perche'
    // tocca anche players.json condiviso fra tutte le squadre.
    return withRosterLock(async () => {
        const merged = Core.mergeImported(await readRosterUnlocked(id), imported);
        return saveRosterUnlocked(merged);
    });
}

// Una rosa mostrata in diretta con ?fresh=1 viene riscaricata da IPBA se
// l'ultima lettura è più vecchia del throttle: così i prestiti del match in
// corso arrivano senza riavviare il server. Se IPBA non risponde si continua
// con la copia locale. (importRoster passa da module.exports per i test.)
const FRESH_REFRESH_MS = 60 * 1000;

async function maybeRefreshRoster(roster, teamId, wantsFresh, req) {
    if (!roster || !wantsFresh || !isLocalRequest(req)) return roster;
    if (Date.now() - roster.sourceUpdatedAt <= FRESH_REFRESH_MS) return roster;
    try {
        return await module.exports.importRoster(teamId);
    } catch (error) {
        return roster;
    }
}

// Aggiorna in sequenza tutte le squadre del registry (pausa tra le richieste
// per non sovraccaricare ipba.it). Un errore su una squadra non ferma le altre.
async function importAllFromRegistry(options) {
    options = options || {};
    const importer = options.importer || importRoster;
    const delayMs = options.delayMs == null ? 1500 : options.delayMs;
    const log = options.log || (() => { });
    const registry = await readRegistry();
    const results = [];
    for (const team of registry.teams) {
        if (!team.teamId) continue;
        if (results.length && delayMs) await new Promise(resolve => setTimeout(resolve, delayMs));
        try {
            const roster = await importer(team.teamId);
            results.push({ teamId: team.teamId, name: roster.team.name, ok: true, players: roster.players.length });
            log('[ROSE] ' + roster.team.name + ' (id ' + team.teamId + '): rosa aggiornata, ' + roster.players.length + ' giocatori.');
        } catch (error) {
            results.push({ teamId: team.teamId, name: team.name, ok: false, error: error.message });
            log('[ROSE] ' + (team.name || 'Squadra ' + team.teamId) + ': ERRORE ' + error.message);
        }
    }
    return results;
}

function imageInfo(buffer, mime) {
    if (mime === 'image/png') {
        if (buffer.length < 24 || buffer.toString('hex', 0, 8) !== '89504e470d0a1a0a') return null;
        return { ext: '.png', width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
    }
    if (mime === 'image/jpeg') {
        if (buffer.length < 4 || buffer[0] !== 0xff || buffer[1] !== 0xd8) return null;
        let offset = 2;
        while (offset + 9 < buffer.length) {
            if (buffer[offset] !== 0xff) {
                offset += 1;
                continue;
            }
            const marker = buffer[offset + 1];
            if ([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf].includes(marker)) {
                return {
                    ext: '.jpg',
                    height: buffer.readUInt16BE(offset + 5),
                    width: buffer.readUInt16BE(offset + 7)
                };
            }
            if (offset + 4 >= buffer.length) break;
            const length = buffer.readUInt16BE(offset + 2);
            if (length < 2) break;
            offset += 2 + length;
        }
        return null;
    }
    if (mime === 'image/webp') {
        if (buffer.length < 30 ||
            buffer.toString('ascii', 0, 4) !== 'RIFF' ||
            buffer.toString('ascii', 8, 12) !== 'WEBP') return null;
        const type = buffer.toString('ascii', 12, 16);
        if (type === 'VP8X') {
            return {
                ext: '.webp',
                width: 1 + buffer.readUIntLE(24, 3),
                height: 1 + buffer.readUIntLE(27, 3)
            };
        }
        if (type === 'VP8L') {
            const bits = buffer.readUInt32LE(21);
            return {
                ext: '.webp',
                width: (bits & 0x3fff) + 1,
                height: ((bits >> 14) & 0x3fff) + 1
            };
        }
        if (type === 'VP8 ' && buffer.length >= 30) {
            return {
                ext: '.webp',
                width: buffer.readUInt16LE(26) & 0x3fff,
                height: buffer.readUInt16LE(28) & 0x3fff
            };
        }
    }
    return null;
}

function validateImageDimensions(info) {
    return info &&
        info.width >= 40 &&
        info.height >= 40 &&
        info.width <= MAX_DIMENSION &&
        info.height <= MAX_DIMENSION &&
        info.width * info.height <= MAX_PIXELS;
}

async function savePhoto(req, teamId, playerKey) {
    const id = Core.safeTeamId(teamId);
    const key = Core.safePlayerKey(playerKey);
    const roster = await readRoster(id);
    const player = roster && roster.players.find(item => item.playerKey === key);
    if (!player) throw Object.assign(new Error('Giocatore non trovato'), { status: 404 });

    const mime = String(req.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
    if (!['image/png', 'image/webp', 'image/jpeg'].includes(mime)) {
        throw Object.assign(new Error('Formato non ammesso: usa PNG, WebP o JPEG'), { status: 415 });
    }
    const buffer = await readBody(req, MAX_PHOTO);
    const info = imageInfo(buffer, mime);
    if (!validateImageDimensions(info)) {
        throw Object.assign(new Error('Firma o dimensioni immagine non valide'), { status: 415 });
    }

    // Le foto dei giocatori IPBA sono condivise tra tutte le squadre
    // (archivio per playerId); quelle dei giocatori manuali restano di squadra.
    const pid = player.source.playerId;
    const assets = pid ? path.join(DATA_ROOT, 'players', 'assets') : path.join(teamDir(id), 'assets');
    const baseName = pid || key;
    await fsp.mkdir(assets, { recursive: true });
    const filename = baseName + info.ext;
    await atomicWrite(path.join(assets, filename), buffer);
    try {
        const oldFiles = (await fsp.readdir(assets)).filter(name =>
            name.startsWith(baseName + '.') &&
            name !== filename &&
            name !== filename + '.bak'
        );
        await Promise.all(oldFiles.map(name => fsp.unlink(path.join(assets, name)).catch(() => undefined)));
    } catch (error) {
        // La nuova foto è già stata salvata; la pulizia dei vecchi formati è secondaria.
    }

    const url = (pid
        ? 'data/rosters/players/assets/'
        : 'data/rosters/team-' + encodeURIComponent(id) + '/assets/') + encodeURIComponent(filename);
    const hasTransparency = mime !== 'image/jpeg' && req.headers['x-image-transparency'] === '1';

    // La rosa va riletta DENTRO il lock: fra il controllo iniziale e qui sono
    // passati l'upload del file e la scrittura su disco, durante i quali un
    // altro salvataggio puo' aver modificato roster.json o players.json.
    await withRosterLock(async () => {
        const fresh = await readRosterUnlocked(id);
        const target = fresh && fresh.players.find(item => item.playerKey === key);
        if (!target) throw Object.assign(new Error('Giocatore non trovato'), { status: 404 });
        target.image.customImageUrl = url;
        target.image.selectedSource = 'CUSTOM';
        target.image.hasTransparency = hasTransparency;
        target.image.width = info.width;
        target.image.height = info.height;
        await saveRosterUnlocked(fresh, { updateArchive: true });
    });

    return {
        url,
        width: info.width,
        height: info.height,
        hasTransparency
    };
}

async function deletePhoto(teamId, playerKey) {
    const id = Core.safeTeamId(teamId);
    const key = Core.safePlayerKey(playerKey);

    // Cancellazione file e aggiornamento rosa sono un'unica sezione critica:
    // sono tutte operazioni locali e veloci, non c'e' attesa di rete da tenere
    // fuori dal lock come invece serve nell'upload.
    await withRosterLock(async () => {
        const roster = await readRosterUnlocked(id);
        const player = roster && roster.players.find(item => item.playerKey === key);
        if (!player) throw Object.assign(new Error('Giocatore non trovato'), { status: 404 });

        const pid = player.source.playerId;
        const assets = pid ? path.join(DATA_ROOT, 'players', 'assets') : path.join(teamDir(id), 'assets');
        const baseName = pid || key;
        try {
            const files = await fsp.readdir(assets);
            await Promise.all(files
                .filter(name => name.startsWith(baseName + '.'))
                .map(name => fsp.unlink(path.join(assets, name)).catch(() => undefined)));
        } catch (error) {
            // L'assenza della cartella assets equivale a una foto già rimossa.
        }
        player.image.customImageUrl = '';
        player.image.selectedSource = 'ORIGINAL';
        player.image.hasTransparency = false;
        player.image.width = 0;
        player.image.height = 0;
        await saveRosterUnlocked(roster, { updateArchive: true });
    });
}

async function handleAuthRoute(req, res, parts) {
    const action = parts[3] || '';
    if (!isLocalRequest(req)) {
        json(res, 403, {
            error: 'Il setup rose è disponibile soltanto sul PC di regia.',
            authenticated: false,
            localOnly: true
        });
        return true;
    }
    if (action === 'status' && req.method === 'GET') {
        json(res, 200, {
            authenticated: !!authenticatedSession(req),
            localOnly: true
        });
        return true;
    }
    if (action === 'login' && req.method === 'POST') {
        const address = clientAddress(req);
        if (!canAttemptLogin(address)) {
            json(res, 429, { error: 'Troppi tentativi. Attendi un minuto e riprova.' });
            return true;
        }
        const payload = await readJson(req, 8 * 1024);
        const password = typeof payload.password === 'string' ? payload.password : '';
        if (!password || password.length > 200 || !safeEqual(password, setupPassword)) {
            registerLoginFailure(address);
            json(res, 401, { error: 'Password non corretta.' });
            return true;
        }
        loginFailures.delete(address);
        const token = crypto.randomBytes(32).toString('base64url');
        sessions.set(token, {
            address,
            createdAt: Date.now(),
            expiresAt: Date.now() + SESSION_MAX_AGE_MS
        });
        json(res, 200, { authenticated: true }, {
            'Set-Cookie': cookieHeader(token, Math.floor(SESSION_MAX_AGE_MS / 1000))
        });
        return true;
    }
    if (action === 'logout' && req.method === 'POST') {
        const token = readCookies(req).pm_roster_session;
        if (token) sessions.delete(token);
        json(res, 200, { authenticated: false }, {
            'Set-Cookie': cookieHeader('', 0)
        });
        return true;
    }
    json(res, 405, { error: 'Metodo di autenticazione non supportato.' });
    return true;
}

async function handleRosterApi(req, res, parsedUrl) {
    const pathname = parsedUrl.pathname;
    if (!pathname.startsWith('/api/rosters/')) return false;

    const parts = pathname.split('/').filter(Boolean).map(value => {
        try {
            return decodeURIComponent(value);
        } catch (error) {
            return '';
        }
    });

    try {
        if (parts[2] === 'auth') return await handleAuthRoute(req, res, parts);
        if (parts[2] === 'registry') {
            if (!isLocalRequest(req)) {
                json(res, 403, { error: 'Il registry rose è disponibile soltanto sul PC di regia.' });
                return true;
            }
            if (parts.length === 3 && req.method === 'GET') {
                json(res, 200, await readRegistry());
                return true;
            }
            if (parts.length === 3 && req.method === 'POST') {
                // Scrivere il registry cambia da quali link vengono riscaricate
                // le rose. Non si puo' pretendere la sessione di setup (il
                // pannello GESTIONE ROSE di streaming.html salva senza login),
                // ma il solo "richiesta locale" lasciava passare il CSRF: un
                // sito qualunque aperto sul PC di regia poteva riscriverlo
                // (body JSON senza header custom = nessun preflight).
                if (!isSameOriginRequest(req)) {
                    json(res, 403, { error: 'Origine non consentita per la scrittura del registry.' });
                    return true;
                }
                const registry = normalizeRegistry(await readJson(req, 512 * 1024));
                // Anche qui il ciclo e' leggi-fondi-scrivi: due SALVA MODIFICHE
                // ravvicinati si sovrascrivevano a vicenda perdendo le squadre
                // conservate dal merge. Il body e' gia' stato letto: dentro il
                // lock resta solo lavoro locale.
                const savedRegistry = await withRosterLock(async () => {
                    // Il pannello streaming può avere campi URL vuoti e nomi
                    // diversi da quelli ufficiali IPBA: un URL già registrato per
                    // la stessa squadra non deve andare perso, e le squadre note
                    // solo al registry (con link valido) vengono conservate.
                    const existing = await readRegistry();
                    const byName = new Map(existing.teams.map(team => [team.name.toLowerCase(), team]));
                    registry.teams = registry.teams.map(team => {
                        if (team.rosterUrl) return team;
                        const old = byName.get(team.name.toLowerCase());
                        return old && old.rosterUrl
                            ? Object.assign({}, team, { rosterUrl: old.rosterUrl, teamId: old.teamId })
                            : team;
                    });
                    const incomingNames = new Set(registry.teams.map(team => team.name.toLowerCase()));
                    existing.teams.forEach(team => {
                        if (team.teamId && !incomingNames.has(team.name.toLowerCase())) registry.teams.push(team);
                    });
                    registry.teams = registry.teams.slice(0, 100);
                    registry.updatedAt = Date.now();
                    await atomicWrite(registryPath(), JSON.stringify(registry, null, 2));
                    return registry;
                });
                json(res, 200, savedRegistry);
                return true;
            }
            if (parts.length === 4 && parts[3] === 'import-all' && req.method === 'POST') {
                if (!authenticatedSession(req)) {
                    json(res, 401, { error: 'Sessione setup scaduta. Inserisci nuovamente la password.' });
                    return true;
                }
                json(res, 200, { results: await importAllFromRegistry({ delayMs: 400 }) });
                return true;
            }
            json(res, 405, { error: 'Metodo o endpoint non supportato' });
            return true;
        }
        if (req.method === 'OPTIONS') {
            json(res, 204, {});
            return true;
        }

        const teamId = Core.safeTeamId(parts[2]);
        if (!teamId || teamId !== parts[2]) {
            json(res, 400, { error: 'ID squadra non valido' });
            return true;
        }

        if (parts.length === 3 && req.method === 'GET') {
            let roster = await readRoster(teamId);
            if (!roster && parsedUrl.searchParams.get('noImport') !== '1' && isLocalRequest(req)) {
                roster = await importRoster(teamId);
            }
            roster = await maybeRefreshRoster(roster, teamId, parsedUrl.searchParams.get('fresh') === '1', req);
            if (!roster) {
                json(res, 404, { error: 'Rosa non trovata' });
                return true;
            }
            json(res, 200, { roster, storage: 'SERVER_LOCALE' });
            return true;
        }

        if (!authenticatedSession(req)) {
            json(res, 401, { error: 'Sessione setup scaduta. Inserisci nuovamente la password.' });
            return true;
        }

        if (parts.length === 3 && req.method === 'POST') {
            const payload = await readJson(req, MAX_JSON);
            const roster = Core.normalizeRoster(payload, teamId);
            if (roster.team.id !== teamId) throw Object.assign(new Error('ID squadra incoerente'), { status: 400 });
            json(res, 200, { roster: await saveRoster(roster, { updateArchive: true }), storage: 'SERVER_LOCALE' });
            return true;
        }

        if (parts.length === 4 && parts[3] === 'import' && req.method === 'POST') {
            json(res, 200, { roster: await importRoster(teamId), storage: 'SERVER_LOCALE' });
            return true;
        }

        if (parts.length === 6 && parts[3] === 'players' && parts[5] === 'photo') {
            const key = Core.safePlayerKey(parts[4]);
            if (!key || key !== parts[4]) throw Object.assign(new Error('playerKey non valida'), { status: 400 });
            if (req.method === 'POST') {
                json(res, 200, await savePhoto(req, teamId, key));
                return true;
            }
            if (req.method === 'DELETE') {
                await deletePhoto(teamId, key);
                json(res, 200, { ok: true });
                return true;
            }
        }

        json(res, 405, { error: 'Metodo o endpoint non supportato' });
        return true;
    } catch (error) {
        // I messaggi con uno "status" sono quelli scritti da noi apposta per
        // l'operatore ("Rosa non trovata", "Formato non ammesso"...) e vanno
        // mostrati. Tutto il resto e' un errore imprevisto il cui testo puo'
        // contenere percorsi del disco o dettagli delle librerie: resta nella
        // finestra del server e al client va un messaggio generico.
        if (error && error.status) {
            json(res, error.status, { error: error.message || 'Errore gestione rose' });
        } else {
            console.error('[ROSE] Errore non gestito su ' + pathname + ':', error && error.stack ? error.stack : error);
            json(res, 500, { error: 'Errore interno del sistema rose. Controlla la finestra del server.' });
        }
        return true;
    }
}

module.exports = {
    handleRosterApi,
    parseIpbaRoster,
    importRoster,
    readRoster,
    saveRoster,
    imageInfo,
    isLocalRequest,
    isSameOriginRequest,
    getSetupAuthInfo,
    readRegistry,
    extractRegistryTeamId,
    importAllFromRegistry,
    DATA_ROOT
};
