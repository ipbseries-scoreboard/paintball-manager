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
    assert.match(pmClient, /stateStale/);
    assert.match(pmClient, /parseInt\(global\.location\.port, 10\)/);
    assert.match(pmClient, /target\.secure \? 'wss:\/\/' : 'ws:\/\/'/);
    assert.match(pmClient, /function normalizeId\(raw\)[\s\S]{0,360}slice\(0, 80\)/);
    assert.match(control, /location\.port \|\| \(location\.protocol === 'file:'/);
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
    assert.match(control, /function stopRegiaNetworking\(\)[\s\S]{0,900}wsRelayActive = false/);
    assert.match(control, /function stopRegiaNetworking\(\)[\s\S]{0,1000}wsClientCount = 0/);
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
    assert.match(control, /function handleRemoteCommand\(cmd\)[\s\S]{0,140}ensureCurrentRegiaLease\(\)/);
    assert.match(control, /function saveTournamentState\(\)[\s\S]{0,100}canControlRegiaState\(\)/);
    assert.match(control, /function broadcastState\(forceFullSync = false\)[\s\S]{0,100}canControlRegiaState\(\)/);
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
