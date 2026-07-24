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
    let entry = loginFailures.get(address);
    if (!entry || now - entry.windowStartedAt > AUTH_WINDOW_MS) {
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

async function readRoster(teamId) {
    try {
        const raw = JSON.parse(await fsp.readFile(configPath(teamId), 'utf8'));
        return Core.normalizeRoster(raw, teamId);
    } catch (error) {
        return null;
    }
}

async function saveRoster(roster) {
    const id = roster && roster.team && roster.team.id;
    const clean = Core.normalizeRoster(roster, id);
    if (!clean.team.id) throw Object.assign(new Error('ID squadra non valido'), { status: 400 });
    clean.updatedAt = Date.now();
    await atomicWrite(configPath(clean.team.id), JSON.stringify(clean, null, 2));
    return clean;
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
    const merged = Core.mergeImported(await readRoster(id), imported);
    return saveRoster(merged);
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

    const assets = path.join(teamDir(id), 'assets');
    await fsp.mkdir(assets, { recursive: true });
    const filename = key + info.ext;
    await atomicWrite(path.join(assets, filename), buffer);
    try {
        const oldFiles = (await fsp.readdir(assets)).filter(name =>
            name.startsWith(key + '.') &&
            name !== filename &&
            name !== filename + '.bak'
        );
        await Promise.all(oldFiles.map(name => fsp.unlink(path.join(assets, name)).catch(() => undefined)));
    } catch (error) {
        // La nuova foto è già stata salvata; la pulizia dei vecchi formati è secondaria.
    }

    const url = 'data/rosters/team-' + encodeURIComponent(id) + '/assets/' + encodeURIComponent(filename);
    const hasTransparency = mime !== 'image/jpeg' && req.headers['x-image-transparency'] === '1';
    player.image.customImageUrl = url;
    player.image.selectedSource = 'CUSTOM';
    player.image.hasTransparency = hasTransparency;
    player.image.width = info.width;
    player.image.height = info.height;
    await saveRoster(roster);

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
    const roster = await readRoster(id);
    const player = roster && roster.players.find(item => item.playerKey === key);
    if (!player) throw Object.assign(new Error('Giocatore non trovato'), { status: 404 });

    const assets = path.join(teamDir(id), 'assets');
    try {
        const files = await fsp.readdir(assets);
        await Promise.all(files
            .filter(name => name.startsWith(key + '.'))
            .map(name => fsp.unlink(path.join(assets, name)).catch(() => undefined)));
    } catch (error) {
        // L'assenza della cartella assets equivale a una foto già rimossa.
    }
    player.image.customImageUrl = '';
    player.image.selectedSource = 'ORIGINAL';
    player.image.hasTransparency = false;
    player.image.width = 0;
    player.image.height = 0;
    await saveRoster(roster);
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
            json(res, 200, { roster: await saveRoster(roster), storage: 'SERVER_LOCALE' });
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
        json(res, error.status || 500, { error: error.message || 'Errore gestione rose' });
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
    getSetupAuthInfo,
    DATA_ROOT
};
