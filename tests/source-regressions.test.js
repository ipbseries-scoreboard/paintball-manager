'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const root = path.resolve(__dirname, '..');
const control = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
const referee = fs.readFileSync(path.join(root, 'referee.html'), 'utf8');
const pmClient = fs.readFileSync(path.join(root, 'pm-client.js'), 'utf8');
const relay = fs.readFileSync(path.join(root, 'server.js'), 'utf8');
const streaming = fs.readFileSync(path.join(root, 'streaming.html'), 'utf8');
const board = fs.readFileSync(path.join(root, 'board.html'), 'utf8');

test('schedule selection uses the safe resume path', () => {
    assert.match(control, /item\.onclick\s*=\s*\(e\)[\s\S]{0,180}selectScheduledMatch\(idx\)/);
    assert.doesNotMatch(control, /item\.onclick\s*=\s*\(e\)[\s\S]{0,180}loadMatch\(idx\)/);
    assert.match(control, /loadMatch\(idx,\s*!!target\.savedState,\s*false,\s*targetFinished\)/);
});

test('skipped and unfinished matches do not affect standings', () => {
    assert.match(control, /!m\.savedState\s*\|\|\s*!m\.savedState\.finished\s*\|\|\s*m\.savedState\.skipped/);
    assert.match(control, /item\.m\.savedState\.finished\s*&&\s*!item\.m\.savedState\.skipped/);
});

test('NO POINT changes match turn but never swaps A and B sides', () => {
    const noPointStart = control.indexOf('function handleNoPoint');
    const noPoint = control.slice(noPointStart, control.indexOf('function skipCurrentSlot', noPointStart));
    assert.match(noPoint, /rotateMatch\(false\)/);
    assert.doesNotMatch(noPoint, /basesSwapped\s*=\s*!state\.basesSwapped/);
    assert.match(control, /basesSwappedNext:\s*shouldSwapNext\s*\?\s*!state\.basesSwapped\s*:\s*state\.basesSwapped/);
});

test('runtime recovery persists pause origin and a live checkpoint', () => {
    assert.match(control, /prevMode:\s*state\.prevMode/);
    assert.match(control, /pm_runtime_checkpoint/);
    assert.match(control, /restoredMatch[\s\S]{0,320}saveMatchState\(/);
    assert.match(control, /timer:\s*state\.timerMode\s*===\s*'GAME'\s*\?\s*state\.timer\s*:\s*state\.gameTimeRemaining/);
    assert.match(control, /pendingRotationAction:\s*state\.pendingRotationAction/);
    assert.match(control, /resumePendingPitTransition\(\)/);
});

test('referee commands are idempotent across local and network transports', () => {
    assert.match(referee, /commandId:\s*commandId/);
    assert.match(referee, /sentAt:\s*sentAt/);
    assert.match(referee, /pendingCommands\.set\(commandId, entry\)/);
    assert.match(referee, /transmitPendingCommand\(entry\)/);
    assert.match(control, /const previousAck = getRecentRemoteAck\(cmd\)/);
    assert.match(control, /dispatchRemoteAck\(previousAck\)/);
    assert.match(control, /rememberRemoteAck\(cmd\.commandId, ack\)/);
    assert.match(control, /REMOTE_ACK_STORAGE_KEY\s*=\s*'pm_remote_ack_cache_v1'/);
    assert.match(control, /persistRecentRemoteAcks\(\)/);
    assert.match(control, /loadRecentRemoteAcksFromStorage\(\)/);
    assert.match(referee, /if \(!pointRequestPayload\) pointRequestPayload = createCommandPayload\('POINT', requestedSide\)/);
    assert.match(referee, /queueCommandPayload\(pointRequestPayload\)/);
    assert.match(referee, /if \(!pointDecisionPayload\)[\s\S]{0,160}createCommandPayload\(commandType, side, null, decision\)/);
    assert.match(referee, /handleLatePointAck\(ack\)/);
    assert.match(referee, /pointDecisionPayload && pointDecisionPayload\.decision !== decision/);
});

test('referee resume toggles pause and settings can be saved', () => {
    assert.match(referee, /currentMode\s*===\s*'PAUSED'[\s\S]{0,160}sendCommand\('PAUSE'\)/);
    assert.match(referee, /function saveSettings\(\)/);
    assert.match(referee, /sendCommand\('UPDATE_SETTINGS'/);
    assert.match(referee, /onclick="openSettings\(\)"/);
    assert.match(control, /settings:\s*\{[\s\S]{0,300}pointIntervalDuration:/);
    assert.doesNotMatch(control, /settings:\s*state\.settings/);
});

test('relay roles, PIN and host ownership are enforced', () => {
    assert.match(relay, /role === 'host' \|\| role === 'controller' \|\| role === 'viewer'/);
    assert.match(relay, /HOST_TOKEN_INVALID/);
    assert.match(relay, /ws\._role === 'controller'/);
    assert.match(relay, /ws\._role === 'viewer'[\s\S]{0,260}requestState/);
    assert.match(control, /hostToken:\s*regiaHostToken/);
    assert.match(control, /controlToken:\s*state\.settings\.controlPin/);
    assert.match(control, /isAuthorizedRemoteCommand\(cmd\)/);
    assert.match(referee, /role:\s*'controller'/);
    assert.match(referee, /controlToken:\s*controlToken/);
    assert.match(relay, /AUTH_MAX_FAILURES/);
    assert.match(relay, /AUTH_RATE_LIMIT/);
    assert.doesNotMatch(relay, /recoveryAllowed/);
    assert.match(relay, /!\/\^\\d\{6\}\$\/\.test\(readToken\(hello\.token\)\)/);
});

test('stale data uses Regia states rather than relay heartbeat and custom ports are preserved', () => {
    assert.match(pmClient, /lastStateReceived/);
    assert.match(pmClient, /_hb aggiorna solo il trasporto/);
    assert.match(pmClient, /function isRegiaStatePacket\(d\)/);
    assert.match(pmClient, /if \(isRegiaStatePacket\(d\)\) lastStateReceived = Date\.now\(\)/);
    assert.match(pmClient, /initialStateMissing/);
    assert.match(pmClient, /!connOpen \|\| transportStale \|\| initialStateMissing/);
    assert.doesNotMatch(pmClient, /now - stateReference > STALE_AFTER_MS/);
    assert.match(pmClient, /parseInt\(global\.location\.port, 10\)/);
    assert.match(pmClient, /target\.secure \? 'wss:\/\/' : 'ws:\/\/'/);
    assert.match(pmClient, /function normalizeId\(raw\)[\s\S]{0,360}slice\(0, 80\)/);
    assert.match(control, /location\.port \|\| \(location\.protocol === 'file:'/);
});

test('public iPhone viewers go straight to CLOUD and recover without churn', () => {
    assert.match(pmClient, /var isGithubPage = \/\\\.github\\\.io\$\/i/);
    assert.match(pmClient, /var cloudOnly = !localOnly && \(p\.get\('local'\) === '0' \|\| \(isGithubPage && !forced\)\)/);
    assert.match(pmClient, /if \(!cloudOnly\) \{[\s\S]{0,180}addWs\(localHost/);
    assert.match(pmClient, /if \(!cloudOnly\) \{[\s\S]{0,180}addPeer\(localHost/);
    assert.match(pmClient, /var dataChannelAlive = connOpen && conn && conn\.open/);
    assert.match(pmClient, /if \(dataChannelAlive && err\.type !== 'browser-incompatible'\)[\s\S]{0,320}return;/);
    assert.match(pmClient, /visibilitychange[\s\S]{0,180}pageshow[\s\S]{0,180}online/);
    assert.match(pmClient, /function requestFreshState\(force\)/);
    assert.match(board, /pm-client\.js\?v=2\.1\.1-controller-cloud/);
    assert.match(streaming, /pm-client\.js\?v=2\.1\.1-controller-cloud/);
    assert.match(control, /function bindPeer\(p, tag, targetId\)[\s\S]{0,700}hasOpenDataChannels/);
    assert.match(control, /signalingOnlyError && !p\.destroyed && hasOpenDataChannels\(\)[\s\S]{0,420}return;/);
    assert.match(control, /p\.disconnected && !hasOpenDataChannels\(\)[\s\S]{0,180}scheduleCloudReconnect/);
});

test('GitHub CLOUD authenticates controllers before opening Streaming or Referee', () => {
    const helpersStart = pmClient.indexOf('var ICE_CONFIG');
    const helpersEnd = pmClient.indexOf('function connect(cfg)', helpersStart);
    assert.ok(helpersStart >= 0 && helpersEnd > helpersStart);

    const page = {
        location: {
            search: '?matchId=IPBA-1674',
            hostname: 'ipbseries-scoreboard.github.io',
            port: '',
            protocol: 'https:'
        }
    };
    const buildCandidates = new Function(
        'global',
        pmClient.slice(helpersStart, helpersEnd) + '; return buildCandidates;'
    )(page);
    const routes = (role, token) => buildCandidates(role, token).map(candidate =>
        candidate.kind === 'ws'
            ? `ws:${candidate.url}`
            : `peer:${candidate.options.host}:${candidate.options.port}`
    );

    assert.deepEqual(routes('controller', '123456'), ['peer:0.peerjs.com:443']);
    assert.deepEqual(routes('controller', '12345'), []);
    assert.deepEqual(routes('viewer', ''), ['peer:0.peerjs.com:443']);

    page.location.search = '?matchId=IPBA-1674&local=1';
    assert.deepEqual(routes('controller', '123456'), ['ws:ws://localhost:9000/ws']);
    assert.deepEqual(routes('viewer', ''), [
        'ws:ws://localhost:9000/ws',
        'peer:localhost:9000'
    ]);

    assert.match(pmClient, /type:\s*'AUTH_CONTROLLER'[\s\S]{0,120}controlToken:\s*token/);
    assert.match(pmClient, /d\.type === 'COMMAND_ACK' && d\.commandId === authCommandId/);
    assert.match(pmClient, /d\.accepted === true \|\| legacyAccepted[\s\S]{0,160}completePeerOpen\(\)/);
    assert.match(pmClient, /authRejected = true[\s\S]{0,260}clearTimeout\(watchdog\)[\s\S]{0,180}Accesso negato/);
    assert.match(pmClient, /Object\.assign\(\{\}, data, \{ controlToken: token \}\)/);
    assert.match(control, /case 'AUTH_CONTROLLER':[\s\S]{0,500}Controller autorizzato/);
    assert.match(control, /data\.type === 'AUTH_CONTROLLER'[\s\S]{0,100}initialSnapshotTimer/);
});

test('PeerJS snapshots are targeted, compact and never contain embedded logos', () => {
    const peerConnectionStart = control.indexOf("p.on('connection', (conn) =>");
    const peerConnectionBlock = control.slice(peerConnectionStart, control.indexOf('function initPeer()', peerConnectionStart));
    const remoteStart = control.indexOf('function handleRemoteCommand');
    const remoteBlock = control.slice(remoteStart, control.indexOf('function saveTournamentState', remoteStart));

    assert.doesNotMatch(peerConnectionBlock, /broadcastState\(true\)/);
    assert.match(peerConnectionBlock, /sendPeerSnapshot\(conn, false\)/);
    assert.match(peerConnectionBlock, /handleRemoteCommand\(data, \{ peerConn: conn \}\)/);
    assert.match(peerConnectionBlock, /conn\.on\('error'/);
    assert.match(remoteBlock, /source && source\.peerConn[\s\S]{0,180}sendPeerSnapshot/);
    assert.match(control, /MAX_PEER_PAYLOAD_BYTES = 64 \* 1024/);
    assert.match(control, /function safeRemoteLogoUrl/);
    assert.match(control, /function compactPeerPacket/);
    assert.match(control, /const peerConnections = peerTarget \? \[peerTarget\] : connections/);

    const helpersStart = control.indexOf('const MAX_PEER_PAYLOAD_BYTES');
    const helpersEnd = control.indexOf('function sendPeerSnapshot', helpersStart);
    const helpersSource = control.slice(helpersStart, helpersEnd);
    const helpers = new Function(helpersSource + '; return { safeRemoteLogoUrl, peerSafePayload };')();

    assert.equal(helpers.safeRemoteLogoUrl('data:image/png;base64,AAAA'), null);
    assert.equal(helpers.safeRemoteLogoUrl('blob:https://example.test/1'), null);
    assert.equal(helpers.safeRemoteLogoUrl('http://example.test/logo.png'), null);
    assert.equal(helpers.safeRemoteLogoUrl('https://example.test/logo.png'), 'https://example.test/logo.png');

    const hugePacket = {
        type: 'FULL_SYNC', stateRevision: 7, stateSentAt: Date.now(), timer: '05:00.00', mode: 'READY',
        teamLeft: { name: 'A', score: 1, logoUrl: 'data:image/png;base64,' + 'A'.repeat(1024 * 1024) },
        teamRight: { name: 'B', score: 2, logoUrl: 'blob:https://example.test/2' },
        tournament: {
            active: true, currentIndex: 0, name: 'Evento', data: 'X'.repeat(100 * 1024),
            matches: [
                { time: '09:30', teamA: 'A', teamB: 'B', phase: 'GIRONI', field: 'Campo 1', savedState: null },
                { time: '10:00', teamA: 'C', teamB: 'D', phase: 'GIRONI', field: 'Campo 1', savedState: { finished: true } }
            ]
        },
        standingsData: {
            data: 'Y'.repeat(100 * 1024),
            standings: [{ name: 'A', played: 1, wins: 1, losses: 0, draws: 0, rw: 3, rl: 1, pen: 0, tech: 99 }],
            bracket: { rounds: [{ name: 'FINALE', matches: [{ teamA: 'A', teamB: 'B', scoreA: 3, scoreB: 1, winner: 'A', finished: true }] }] },
            matchHistory: [{ id: 1, teamA: 'A', scoreA: 3, teamB: 'B', scoreB: 1, winner: 'A' }],
            techUsage: [{ name: 'A', tech: 99 }]
        },
        h2h: { data: 'H'.repeat(100 * 1024) }, teamHistory: { data: 'T'.repeat(100 * 1024) },
        archivioTop: { data: 'Z'.repeat(100 * 1024) }
    };
    const safePayload = helpers.peerSafePayload(hugePacket, JSON.stringify(hugePacket));
    const safePacket = JSON.parse(safePayload);
    assert.ok(Buffer.byteLength(safePayload, 'utf8') <= 64 * 1024);
    assert.equal(safePacket.type, 'FULL_SYNC');
    assert.equal(safePacket.timer, '05:00.00');
    assert.equal(safePacket.teamLeft.logoUrl, undefined);
    assert.equal(safePacket.teamRight.logoUrl, undefined);
    assert.equal(safePacket.tournament.matches.length, 2);
    assert.equal(safePacket.standingsData.standings[0].name, 'A');
    assert.equal(safePacket.standingsData.bracket.rounds[0].name, 'FINALE');
    assert.equal(safePacket.standingsData.techUsage, undefined);
    assert.equal(safePacket.h2h, undefined);
    assert.equal(safePacket.teamHistory, undefined);
    assert.equal(safePacket.archivioTop, undefined);
    assert.doesNotMatch(safePayload, /data:image|blob:/);

    const pathological = {
        ...hugePacket,
        layoutUrl: 'data:image/png;base64,' + 'L'.repeat(1024 * 1024),
        teamLeft: { name: 'A'.repeat(200000), score: 1, logoUrl: 'data:image/png;base64,AAAA' },
        h2h: null,
        teamHistory: null,
        archivioTop: null,
        tournament: {
            active: true,
            currentIndex: 0,
            matches: Array.from({ length: 1500 }, (_, i) => ({
                time: String(i), teamA: 'A'.repeat(200), teamB: 'B'.repeat(200),
                phase: 'GIRONI', field: 'Campo 1', savedState: null
            }))
        }
    };
    const pathologicalPayload = helpers.peerSafePayload(pathological, JSON.stringify(pathological));
    assert.ok(Buffer.byteLength(pathologicalPayload, 'utf8') <= 64 * 1024);
    const pathologicalPacket = JSON.parse(pathologicalPayload);
    assert.equal(pathologicalPacket.type, 'PARTIAL_SYNC');
    assert.equal(pathologicalPacket.layoutUrl, null);
    assert.ok(pathologicalPacket.teamLeft.name.length <= 160);
    assert.doesNotMatch(pathologicalPayload, /data:image|blob:/);
});

test('display overlays request and consume asynchronous full snapshots', () => {
    for (const source of [board, streaming]) {
        const scheduleStart = source.indexOf('function toggleSchedule()');
        const scheduleBlock = source.slice(scheduleStart, source.indexOf('//', scheduleStart + 30));
        assert.match(scheduleBlock, /requestState[\s\S]{0,80}full:\s*true/);
        const updateStart = source.indexOf('function updateBoard(d)');
        const updateBlock = source.slice(updateStart, source.indexOf('setInterval', updateStart));
        assert.match(updateBlock, /stats-overlay[\s\S]{0,260}renderStandingsTable\(d\.standingsData\)/);
    }
});

test('CLOUD retries are isolated from the local WebSocket relay', () => {
    const initStart = control.indexOf('function initPeer()');
    const initBlock = control.slice(initStart, control.indexOf('// ---------- RELAY WEBSOCKET', initStart));
    const cloudRetryStart = control.indexOf('function scheduleCloudReconnect');
    const cloudRetry = control.slice(cloudRetryStart, control.indexOf('function bindPeer', cloudRetryStart));
    const relayStart = control.indexOf('function startWsHostLoop()');
    const relayLoop = control.slice(relayStart, control.indexOf('function restartWsHost', relayStart));
    const toggleStart = control.indexOf("document.getElementById('cloud-sync-toggle').addEventListener");
    const toggleBlock = control.slice(toggleStart, control.indexOf('populateVoiceList()', toggleStart));

    // La porta 9000 è HTTP + /ws e non deve essere trattata come un PeerServer legacy.
    assert.doesNotMatch(initBlock, /new Peer\(targetId,\s*localOptions\)/);
    assert.doesNotMatch(initBlock, /host:\s*'localhost'[\s\S]{0,80}port:\s*9000/);

    // Un guasto CLOUD ricrea solo peerCloud; non re-inizializza la rete intera.
    assert.match(cloudRetry, /destroyCloudPeer\(\)[\s\S]{0,100}startCloudPeer\(\)/);
    assert.doesNotMatch(cloudRetry, /initPeer\(|peerLocal/);

    // La caduta del relay e il toggle CLOUD non devono distruggersi a vicenda.
    assert.doesNotMatch(relayLoop, /scheduleReconnect\(/);
    assert.doesNotMatch(toggleBlock, /scheduleReconnect\(|peerLocal\.destroy/);
    assert.match(toggleBlock, /destroyCloudPeer\(\)/);
    assert.match(toggleBlock, /startCloudPeer\(\)/);

    // Tre normali eventi open non sono prova di una seconda Regia.
    assert.doesNotMatch(control, /detectCloudFlap|cloudOpenTimes|Causa più probabile: la Regia è aperta anche ALTROVE/);
    assert.match(control, /err\.type === 'unavailable-id'[\s\S]{0,500}MATCH ID GIÀ REGISTRATO SUL CLOUD/);
});

test('only one Regia tab can mutate state', () => {
    assert.match(control, /function acquireRegiaLeadership/);
    assert.match(control, /function enterRegiaStandby/);
    assert.match(control, /REGIA SECONDARIA/);
    assert.match(control, /if \(!canControlRegiaState\(\)\) return;[\s\S]{0,100}if \(!state\.tournament/);
    assert.match(control, /if \(canControlRegiaState\(\) && event\.data/);
    assert.doesNotMatch(control, /sessionStorage\.getItem\('pm_regia_tab_id'\)/);
    assert.match(control, /window\.addEventListener\('beforeunload'/);

    const takeoverStart = control.indexOf('function takeOverRegia');
    const takeover = control.slice(takeoverStart, control.indexOf('function startRegiaStateHeartbeat', takeoverStart));
    assert.match(takeover, /acquireRegiaLeadership\(true\)/);
    assert.match(takeover, /pendingTowelSide\s*=\s*null/);
    assert.match(takeover, /pendingPointSide\s*=\s*null/);
    assert.match(takeover, /historyStack\.length\s*=\s*0/);
    assert.match(takeover, /querySelectorAll\('\.overlay'\)/);
    assert.match(takeover, /reloadSettingsForRegiaTakeover\(\)/);
    assert.match(takeover, /loadRecentRemoteAcksFromStorage\(\)/);
    assert.match(takeover, /regiaTakeoverPending\s*=\s*true/);
    assert.match(takeover, /setTimeout\([\s\S]{0,1800},\s*250\)/);
    assert.match(takeover, /regiaTakeoverPending\s*=\s*false[\s\S]{0,100}loadTournamentState\(\)/);
    assert.match(takeover, /loadTournamentState\(\)/);
    assert.match(takeover, /initPeer\(\)/);
    assert.match(takeover, /startWsHostLoop\(\)/);
    assert.doesNotMatch(takeover, /location\.reload\(\)/);
    assert.ok(takeover.indexOf('loadTournamentState()') < takeover.indexOf('initPeer()'));
    assert.ok(takeover.indexOf('reloadSettingsForRegiaTakeover()') < takeover.indexOf('loadRecentRemoteAcksFromStorage()'));
    assert.ok(takeover.indexOf('loadRecentRemoteAcksFromStorage()') < takeover.indexOf('initPeer()'));
    assert.match(control, /function stopRegiaNetworking\(\)[\s\S]{0,260}initPeerGeneration \+= 1/);
    assert.match(control, /function stopRegiaNetworking\(\)[\s\S]{0,1400}wsRelayActive = false/);
    assert.match(control, /function stopRegiaNetworking\(\)[\s\S]{0,1500}wsClientCount = 0/);
    assert.match(control, /function reloadSettingsForRegiaTakeover\(\)[\s\S]{0,3200}state\.settings\.controlPin\s*=\s*controlPin/);
    assert.match(control, /function reloadSettingsForRegiaTakeover\(\)[\s\S]{0,6500}CONFIG\.singleSlotInterTime/);
    assert.match(control, /function reloadSettingsForRegiaTakeover\(\)[\s\S]{0,6500}state\.settings\.buzzerMapping\s*=\s*mapping/);
    assert.doesNotMatch(control, /Object\.keys\(mapping\)\.length[\s\S]{0,80}state\.settings\.buzzerMapping/);
    assert.match(control, /function reloadSettingsForRegiaTakeover\(\)[\s\S]{0,6500}TEAM_STYLE\s*=\s*nextStyle/);
    assert.match(control, /scaleX >= 0\.1[\s\S]{0,220}scaleY >= 0\.1/);
    assert.match(control, /storedStyle\.dot\.length <= 5/);
    assert.match(control, /function reloadSettingsForRegiaTakeover\(\)[\s\S]{0,6500}state\.clanConfig\s*=\s*storedClans/);
    assert.match(control, /function reloadSettingsForRegiaTakeover\(\)[\s\S]{0,6500}cloudToggle\.checked/);
    assert.match(control, /function canControlRegiaState\(\)/);
    assert.match(control, /function tick\(\)[\s\S]{0,120}ensureCurrentRegiaLease\(\)/);
    assert.match(control, /function handleRemoteCommand\(cmd(?:, source = null)?\)[\s\S]{0,180}ensureCurrentRegiaLease\(\)/);
    assert.match(control, /function saveTournamentState\(\)[\s\S]{0,100}canControlRegiaState\(\)/);
    assert.match(control, /function broadcastState\(forceFullSync = false(?:, syncOptions = \{\})?\)[\s\S]{0,140}canControlRegiaState\(\)/);
    assert.match(control, /function normalizeMatchIdValue\(value\)[\s\S]{0,300}slice\(0, 80\)/);
    assert.match(control, /normalizeMatchIdValue\(value\)[\s\S]{0,220}\\u007f-\\u009f/);
    assert.match(pmClient, /function normalizeId\(raw\)[\s\S]{0,260}\\u007f-\\u009f/);
});

test('NO POINT confirmation, outdoor persistence and event backup are active', () => {
    const noPointStart = control.indexOf('function handleNoPoint');
    const noPoint = control.slice(noPointStart, control.indexOf('function skipCurrentSlot', noPointStart));
    assert.match(noPoint, /state\.settings\.confirmNoPoint/);
    assert.match(noPoint, /rotateMatch\(false\)/);
    assert.match(control, /outdoorMode:\s*state\.outdoorMode/);
    assert.match(control, /EventBackup\.build\(localStorage\)/);
    assert.match(control, /EventBackup\.restore\(localStorage, parsed\)/);
    assert.match(control, /event-backup\.js/);

    const importStart = control.indexOf('async function importCompleteEventBackup');
    const importBackup = control.slice(importStart, control.indexOf('function resetTournamentData', importStart));
    assert.ok(importBackup.indexOf('EventBackup.restore(localStorage, parsed)') < importBackup.indexOf('stopTimerLoop()'));
});

test('control pages require a complete six-digit PIN before connecting', () => {
    assert.match(referee, /if \(!\/\^\\d\{6\}\$\/\.test\(pinInput\)\)/);
    assert.match(streaming, /\^\\d\{6\}\$/);
});

test('connection counters and smart action declarations are unique', () => {
    assert.equal((control.match(/id="conn-count"/g) || []).length, 1);
    assert.equal((control.match(/id="conn-count-topbar"/g) || []).length, 1);
    assert.equal((control.match(/function handleSmartAction\s*\(/g) || []).length, 1);
});

test('streaming controller carries the PIN and does not auto-connect twice', () => {
    assert.match(streaming, /role:\s*controlPin \? 'controller' : 'viewer'/);
    assert.match(streaming, /UPDATE_CLANS[\s\S]{0,120}controlToken:\s*controlPin/);
    assert.match(streaming, /<meta name="referrer" content="no-referrer">/);
    assert.match(streaming, /urlParams\.delete\('pin'\)[\s\S]{0,220}history\.replaceState/);
    assert.match(streaming, /isError && \/pin\|credenzial\|accesso negato\/i/);
    assert.doesNotMatch(streaming, /type:\s*'FORCE_SYNC'/);
    assert.doesNotMatch(board, /type:\s*'FORCE_SYNC'/);
    assert.equal((streaming.match(/startClient\(id\)/g) || []).length, 1);
});

test('closing a referee point verification rejects it safely', () => {
    assert.match(referee, /function closeModal\(\)[\s\S]{0,180}CONFIRM_POINT[\s\S]{0,120}REJECT/);
    assert.match(control, /if\s*\(!pendingPointSide\)[\s\S]{0,180}CONFERMA PUNTO IGNORATA/);
    assert.match(control, /cmd\.side\s*!==\s*pendingPointSide/);
});

test('reset button has only the guarded event-handler path', () => {
    const openingTag = control.match(/<button[^>]*id="btn-reset-tournament"[^>]*>/);
    assert.ok(openingTag);
    assert.doesNotMatch(openingTag[0], /onclick=/);
    assert.match(control, /btn-reset-tournament'\)\.addEventListener\('click'/);
});

test('undo is bound exactly once and terminal edits preserve finished state', () => {
    assert.equal((control.match(/btn-undo'\)\.addEventListener\('click', undoLastAction\)/g) || []).length, 1);
    assert.match(control, /function saveMatchState\(idx, finished = null/);
    assert.match(control, /resolvedFinished = finished === null \? !!previous\.finished/);
});

test('towel and automatic-penalty points are persisted before rotation', () => {
    const towelStart = control.indexOf('function executeTowel');
    const penaltyStart = control.indexOf('function addPenalty');
    const towel = control.slice(towelStart, control.indexOf('function handleSmartAction', towelStart));
    const penalty = control.slice(penaltyStart, control.indexOf('function editPenalty', penaltyStart));
    assert.match(towel, /saveMatchState\(state\.tournament\.currentIndex, false, false\)/);
    assert.match(towel, /schedulePitTransition\('ROTATE'\)/);
    assert.match(towel, /TOWEL BLOCCATO: rotazione pit già in corso/);
    assert.match(penalty, /saveMatchState\(state\.tournament\.currentIndex, false, false\)/);
    assert.match(penalty, /schedulePitTransition\('ROTATE'\)/);
});
