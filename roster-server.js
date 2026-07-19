'use strict';

const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const https = require('https');
const http = require('http');
const crypto = require('crypto');
const cheerio = require('cheerio');
const Core = require('./roster-core');

const ROOT = __dirname;
const DATA_ROOT = path.join(ROOT, 'data', 'rosters');
const MAX_JSON = 2 * 1024 * 1024;
const MAX_PHOTO = 10 * 1024 * 1024;
const MAX_DIMENSION = 6000;
const MAX_PIXELS = 25 * 1000 * 1000;
const WRITE_TOKEN = String(process.env.PM_ROSTER_TOKEN || '');

function json(res, status, value) {
    const body = Buffer.from(JSON.stringify(value));
    res.writeHead(status, {
        'Content-Type': 'application/json; charset=utf-8',
        'Content-Length': body.length,
        'Cache-Control': 'no-store',
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Headers': 'Content-Type, X-Roster-Token, X-Image-Transparency, X-Image-Width, X-Image-Height',
        'Access-Control-Allow-Methods': 'GET,POST,DELETE,OPTIONS'
    });
    res.end(body);
}

function safeEqual(a, b) {
    const left = Buffer.from(String(a || '')), right = Buffer.from(String(b || ''));
    return left.length === right.length && left.length > 0 && crypto.timingSafeEqual(left, right);
}

function canWrite(req) {
    if (WRITE_TOKEN) return safeEqual(WRITE_TOKEN, req.headers['x-roster-token']);
    const origin = String(req.headers.origin || '');
    if (!origin) return true;
    try { return new URL(origin).host.toLowerCase() === String(req.headers.host || '').toLowerCase(); }
    catch (error) { return false; }
}

function teamDir(teamId) { return path.join(DATA_ROOT, 'team-' + Core.safeTeamId(teamId)); }
function configPath(teamId) { return path.join(teamDir(teamId), 'roster.json'); }

async function atomicWrite(file, data) {
    await fsp.mkdir(path.dirname(file), { recursive: true });
    const temp = file + '.tmp-' + process.pid + '-' + Date.now();
    if (fs.existsSync(file)) {
        const backup = file + '.bak';
        try { await fsp.copyFile(file, backup); } catch (error) { }
    }
    await fsp.writeFile(temp, data);
    await fsp.rename(temp, file);
}

async function readRoster(teamId) {
    try { return Core.normalizeRoster(JSON.parse(await fsp.readFile(configPath(teamId), 'utf8')), teamId); }
    catch (error) { return null; }
}

async function saveRoster(roster) {
    const clean = Core.normalizeRoster(roster, roster && roster.team && roster.team.id);
    clean.updatedAt = Date.now();
    await atomicWrite(configPath(clean.team.id), JSON.stringify(clean, null, 2));
    return clean;
}

function readBody(req, limit) {
    return new Promise((resolve, reject) => {
        const chunks = []; let total = 0, done = false;
        const fail = error => { if (done) return; done = true; reject(error); try { req.destroy(); } catch (e) { } };
        req.on('data', chunk => {
            total += chunk.length;
            if (total > limit) { fail(Object.assign(new Error('Payload troppo grande'), { status: 413 })); return; }
            chunks.push(chunk);
        });
        req.on('end', () => { if (!done) { done = true; resolve(Buffer.concat(chunks)); } });
        req.on('error', fail);
    });
}

function allowedIpbaUrl(value) {
    try {
        const url = new URL(value);
        return (url.protocol === 'https:' || url.protocol === 'http:') && /(^|\.)ipba\.it$/i.test(url.hostname) ? url : null;
    } catch (error) { return null; }
}

function fetchText(target, depth) {
    depth = depth || 0;
    return new Promise((resolve, reject) => {
        const url = allowedIpbaUrl(target);
        if (!url) { reject(new Error('URL IPBA non consentito')); return; }
        const lib = url.protocol === 'http:' ? http : https;
        const request = lib.get(url, { headers: { 'User-Agent': 'Mozilla/5.0 (IPBA Roster Importer)', Accept: 'text/html' } }, response => {
            if (response.statusCode >= 300 && response.statusCode < 400 && response.headers.location && depth < 3) {
                response.resume();
                const next = new URL(response.headers.location, url).href;
                fetchText(next, depth + 1).then(resolve, reject); return;
            }
            if (response.statusCode !== 200) { response.resume(); reject(new Error('IPBA HTTP ' + response.statusCode)); return; }
            const chunks = []; let total = 0;
            response.on('data', chunk => { total += chunk.length; if (total <= 3 * 1024 * 1024) chunks.push(chunk); else request.destroy(new Error('Pagina IPBA troppo grande')); });
            response.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
        });
        request.setTimeout(20000, () => request.destroy(new Error('Timeout IPBA')));
        request.on('error', reject);
    });
}

function absoluteIpbaUrl(value) {
    try { return new URL(String(value || ''), 'https://www.ipba.it/').href; } catch (error) { return ''; }
}

function findPlayerBlock($, image) {
    let node = $(image).closest('table');
    while (node.length) {
        if (node.find('img[src*="/public/user_"]').length === 1 && node.find('b').length) return node;
        node = node.parent().closest('table');
    }
    return null;
}

function parseIpbaRoster(html, teamId) {
    const id = Core.safeTeamId(teamId);
    const roster = Core.defaultTeam(id);
    const $ = cheerio.load(String(html || ''), { xmlMode: false, decodeEntities: true });
    const logo = $('img[src*="/public/team_' + id + '/"]').first();
    if (logo.length) {
        roster.team.originalLogoUrl = absoluteIpbaUrl(logo.attr('src'));
        const header = logo.closest('div').length ? logo.closest('div') : logo.closest('table');
        roster.team.name = Core.cleanText(header.find('h3 b, h3').first().text(), 100) || roster.team.name;
        const raw = Core.cleanText(header.text(), 500);
        const code = raw.match(/codice\s+(?:fidasc|societ[aà])\s*([A-Za-z0-9/-]+)/i);
        roster.team.companyCode = code ? Core.cleanText(code[1], 50) : '';
        roster.team.companyName = Core.cleanText(raw.replace(roster.team.name, '').replace(/codice\s+(?:fidasc|societ[aà]).*$/i, ''), 180);
    }
    const seen = new Set();
    $('img[src*="/public/user_"]').each((index, image) => {
        const block = findPlayerBlock($, image); if (!block || !block.length) return;
        const photo = absoluteIpbaUrl($(image).attr('src'));
        const match = photo.match(/\/public\/user_([^/]+)/i);
        const playerId = match ? Core.safeTeamId(match[1]) : '';
        const fullName = Core.cleanText(block.find('b').first().text(), 100);
        if (!fullName) return;
        let number = '';
        block.find('div').each((_, div) => { const value = Core.cleanText($(div).text(), 20); if (!number && /^\d{1,3}$/.test(value)) number = value; });
        const detail = Core.cleanText(block.text(), 500).match(/(\d{1,3})\s*anni(?:\s*-\s*([A-Za-zÀ-ÿ0-9 /_-]+))?/i);
        const player = Core.defaultPlayer(id, {
            source: { type: 'IPBA', playerId, profileUrl: playerId ? 'https://www.ipba.it/profilo.aspx?id=' + playerId : '', originalPhotoUrl: photo },
            originalData: { fullName, number, role: detail && detail[2] ? Core.cleanText(detail[2], 40) : '', age: detail ? detail[1] : '' }
        }, index);
        if (!seen.has(player.playerKey)) { seen.add(player.playerKey); roster.players.push(player); }
    });
    roster.sourceUpdatedAt = Date.now(); roster.updatedAt = Date.now();
    return Core.normalizeRoster(roster, id);
}

async function importRoster(teamId) {
    const id = Core.safeTeamId(teamId);
    const sourceUrl = 'https://www.ipba.it/video-team-giocatori.aspx?id=' + encodeURIComponent(id);
    const imported = parseIpbaRoster(await fetchText(sourceUrl), id);
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
            if (buffer[offset] !== 0xff) { offset++; continue; }
            const marker = buffer[offset + 1];
            if ([0xc0,0xc1,0xc2,0xc3,0xc5,0xc6,0xc7,0xc9,0xca,0xcb,0xcd,0xce,0xcf].includes(marker)) {
                return { ext: '.jpg', height: buffer.readUInt16BE(offset + 5), width: buffer.readUInt16BE(offset + 7) };
            }
            const length = buffer.readUInt16BE(offset + 2); if (length < 2) break; offset += 2 + length;
        }
        return null;
    }
    if (mime === 'image/webp') {
        if (buffer.length < 30 || buffer.toString('ascii', 0, 4) !== 'RIFF' || buffer.toString('ascii', 8, 12) !== 'WEBP') return null;
        const type = buffer.toString('ascii', 12, 16);
        if (type === 'VP8X') return { ext: '.webp', width: 1 + buffer.readUIntLE(24, 3), height: 1 + buffer.readUIntLE(27, 3) };
        if (type === 'VP8L') {
            const bits = buffer.readUInt32LE(21); return { ext: '.webp', width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1 };
        }
        if (type === 'VP8 ' && buffer.length >= 30) return { ext: '.webp', width: buffer.readUInt16LE(26) & 0x3fff, height: buffer.readUInt16LE(28) & 0x3fff };
        return null;
    }
    return null;
}

async function savePhoto(req, teamId, playerKey) {
    const mime = String(req.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
    if (!['image/png', 'image/webp', 'image/jpeg'].includes(mime)) throw Object.assign(new Error('Formato non ammesso: usa PNG, WebP o JPEG'), { status: 415 });
    const buffer = await readBody(req, MAX_PHOTO);
    const info = imageInfo(buffer, mime);
    if (!info) throw Object.assign(new Error('Firma o dimensioni immagine non valide'), { status: 415 });
    if (info.width < 40 || info.height < 40 || info.width > MAX_DIMENSION || info.height > MAX_DIMENSION || info.width * info.height > MAX_PIXELS) {
        throw Object.assign(new Error('Dimensioni immagine non ammesse'), { status: 413 });
    }
    const id = Core.safeTeamId(teamId), key = Core.safePlayerKey(playerKey);
    const assets = path.join(teamDir(id), 'assets'); await fsp.mkdir(assets, { recursive: true });
    const oldFiles = (await fsp.readdir(assets)).filter(name => name.startsWith(key + '.'));
    for (const name of oldFiles) { try { await fsp.unlink(path.join(assets, name)); } catch (error) { } }
    const filename = key + info.ext;
    await atomicWrite(path.join(assets, filename), buffer);
    const url = 'data/rosters/team-' + encodeURIComponent(id) + '/assets/' + encodeURIComponent(filename);
    const roster = await readRoster(id);
    if (roster) {
        const player = roster.players.find(item => item.playerKey === key);
        if (player) {
            player.image.customImageUrl = url; player.image.customImageStorageKey = '';
            player.image.selectedSource = 'CUSTOM'; player.image.hasTransparency = req.headers['x-image-transparency'] === '1';
            player.image.width = info.width; player.image.height = info.height;
            await saveRoster(roster);
        }
    }
    return { url, width: info.width, height: info.height, hasTransparency: req.headers['x-image-transparency'] === '1' };
}

async function deletePhoto(teamId, playerKey) {
    const id = Core.safeTeamId(teamId), key = Core.safePlayerKey(playerKey), assets = path.join(teamDir(id), 'assets');
    try {
        for (const name of await fsp.readdir(assets)) if (name.startsWith(key + '.')) await fsp.unlink(path.join(assets, name));
    } catch (error) { }
    const roster = await readRoster(id);
    if (roster) {
        const player = roster.players.find(item => item.playerKey === key);
        if (player) { player.image.customImageUrl = ''; player.image.customImageStorageKey = ''; player.image.selectedSource = 'ORIGINAL'; player.image.hasTransparency = false; await saveRoster(roster); }
    }
}

async function handleRosterApi(req, res, parsedUrl) {
    const pathname = parsedUrl.pathname;
    if (!pathname.startsWith('/api/rosters/')) return false;
    if (req.method === 'OPTIONS') { json(res, 204, {}); return true; }
    const parts = pathname.split('/').filter(Boolean).map(value => decodeURIComponent(value));
    const teamId = Core.safeTeamId(parts[2]);
    if (!teamId || teamId !== parts[2]) { json(res, 400, { error: 'ID squadra non valido' }); return true; }
    try {
        if (parts.length === 3 && req.method === 'GET') {
            let roster = await readRoster(teamId);
            if (!roster && parsedUrl.searchParams.get('noImport') !== '1') roster = await importRoster(teamId);
            if (!roster) { json(res, 404, { error: 'Rosa non trovata' }); return true; }
            json(res, 200, { roster, storage: 'SERVER' }); return true;
        }
        if (!canWrite(req)) { json(res, 401, { error: 'Token gestione rose non valido' }); return true; }
        if (parts.length === 3 && req.method === 'POST') {
            const body = await readBody(req, MAX_JSON); let payload;
            try { payload = JSON.parse(body.toString('utf8')); } catch (error) { throw Object.assign(new Error('JSON non valido'), { status: 400 }); }
            const roster = Core.normalizeRoster(payload, teamId);
            if (roster.team.id !== teamId) throw Object.assign(new Error('ID squadra incoerente'), { status: 400 });
            json(res, 200, { roster: await saveRoster(roster), storage: 'SERVER' }); return true;
        }
        if (parts.length === 4 && parts[3] === 'import' && req.method === 'POST') {
            json(res, 200, { roster: await importRoster(teamId), storage: 'SERVER' }); return true;
        }
        if (parts.length === 6 && parts[3] === 'players' && parts[5] === 'photo') {
            const key = Core.safePlayerKey(parts[4]);
            if (!key || key !== parts[4]) throw Object.assign(new Error('playerKey non valida'), { status: 400 });
            if (req.method === 'POST') { json(res, 200, await savePhoto(req, teamId, key)); return true; }
            if (req.method === 'DELETE') { await deletePhoto(teamId, key); json(res, 200, { ok: true }); return true; }
        }
        json(res, 405, { error: 'Metodo o endpoint non supportato' }); return true;
    } catch (error) {
        json(res, error.status || 500, { error: error.message || 'Errore gestione rose' }); return true;
    }
}

module.exports = { handleRosterApi, parseIpbaRoster, importRoster, readRoster, saveRoster, imageInfo, DATA_ROOT };
