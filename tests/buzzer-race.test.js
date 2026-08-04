// Gara al buzzer: quando due squadre premono quasi insieme deve risultare
// UN solo vincitore, deciso dall'istante reale di pressione.
//
// Regressione coperta: prima "chi e' primo" veniva dedotto da delayMs <= 0.
// Due pressioni nello stesso frame di polling davano delta 0 ed entrambe
// finivano registrate come PRIMO BUZZER: a referto comparivano due vincitori
// e l'arbitro non poteva assegnare il punto a nessuno dei due.
//
// Il test non ricopia la logica: estrae dal vero index.html il blocco BUZZER
// PRIORITY e pollGamepads, e li esegue in sandbox con stub minimi.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');

function slice(startMarker, endMarker) {
  const a = html.indexOf(startMarker);
  assert.ok(a > 0, `marcatore iniziale non trovato: ${startMarker}`);
  const b = html.indexOf(endMarker, a);
  assert.ok(b > a, `marcatore finale non trovato: ${endMarker}`);
  return html.slice(a, b);
}

const priorityBlock = slice('// --- BUZZER PRIORITY LOGIC ---', '// MAPPING UI HELPERS (Global)');
const pollBlock = slice('function pollGamepads() {', '// Start Gamepad Polling');

function makeSandbox(gamepads, mapping) {
  const events = [];
  const logs = [];
  const teamActions = [];
  const alerts = []; // ogni riproduzione del segnale acustico di chiamata
  const clock = 5000;

  const sandbox = {
    console,
    events,
    logs,
    teamActions,
    alerts,
    playBuzzerAlert: () => alerts.push(clock),
    gamepadStates: {},
    pendingPointSide: null,
    pendingPointOpenedAt: null,
    performance: { now: () => clock },
    Date: { now: () => 1770000000000 + clock },
    setTimeout: () => 1,
    clearTimeout: () => {},
    requestAnimationFrame: () => 0, // niente loop: si esegue un giro solo
    log: (m) => logs.push(m),
    recordRefereeEvent: (type, msg) => events.push({ type, msg }),
    broadcastState: () => {},
    handleTeamAction: (side, action) => {
      teamActions.push({ side, action });
      sandbox.pendingPointSide = side;
      return true;
    },
    handleSmartAction: () => {},
    handleTechPause: () => {},
    handleNoPoint: () => {},
    confirmPoint: () => {},
    pause: () => {},
    startPoint: () => {},
    document: { getElementById: () => null },
    navigator: { getGamepads: () => gamepads },
    state: {
      basesSwapped: false,
      teams: { A: { name: 'TEAM A' }, B: { name: 'TEAM B' } },
      settings: { buzzerMapping: mapping || { GP0_B0: 'POINT_A', GP1_B0: 'POINT_B' } }
    }
  };
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(priorityBlock + '\n' + pollBlock, sandbox, { filename: 'index.html:buzzer' });
  return sandbox;
}

// Due buzzer premuti nello stesso frame di polling, su due device distinti.
function racePads(tsPad0, tsPad1) {
  return [
    { index: 0, timestamp: tsPad0, buttons: [{ pressed: true, value: 1 }] },
    { index: 1, timestamp: tsPad1, buttons: [{ pressed: true, value: 1 }] }
  ];
}

test('due buzzer nello stesso frame producono un solo PRIMO BUZZER', () => {
  const s = makeSandbox(racePads(4998.2, 4994.1));
  s.pollGamepads();

  const first = s.events.filter(e => e.type === 'BUZZER_FIRST');
  const late = s.events.filter(e => e.type === 'BUZZER_LATE');
  assert.strictEqual(first.length, 1, `atteso 1 PRIMO BUZZER, trovati ${first.length}: ${JSON.stringify(s.events)}`);
  assert.strictEqual(late.length, 1, `atteso 1 ALTRO BUZZER, trovati ${late.length}`);
});

test('vince chi ha premuto prima, non chi ha indice piu basso', () => {
  const s = makeSandbox(racePads(4998.2, 4994.1)); // GP1 ha premuto 4.1 ms prima
  s.pollGamepads();

  const first = s.events.find(e => e.type === 'BUZZER_FIRST');
  assert.match(first.msg, /TEAM B/, `doveva vincere TEAM B (GP1_B0): ${first.msg}`);
  assert.match(first.msg, /GP1_B0/);
  assert.strictEqual(s.teamActions.length, 1, 'il punto va aperto una volta sola');
  assert.strictEqual(s.teamActions[0].side, 'right');
});

test('vince GP0 quando e GP0 ad aver premuto prima', () => {
  const s = makeSandbox(racePads(4994.1, 4998.2));
  s.pollGamepads();
  const first = s.events.find(e => e.type === 'BUZZER_FIRST');
  assert.match(first.msg, /TEAM A/);
  assert.strictEqual(s.teamActions[0].side, 'left');
});

test('il distacco sotto il millisecondo compare a referto invece di +0.00s', () => {
  const s = makeSandbox(racePads(4994.1, 4994.5)); // 0.4 ms
  s.pollGamepads();
  const late = s.events.find(e => e.type === 'BUZZER_LATE');
  assert.match(late.msg, /0\.4 ms/, `distacco perso nell'arrotondamento: ${late.msg}`);
});

test('pareggio esatto di timestamp assegna comunque un vincitore unico', () => {
  const s = makeSandbox(racePads(4994.1, 4994.1)); // driver che non discrimina
  s.pollGamepads();
  const first = s.events.filter(e => e.type === 'BUZZER_FIRST');
  const late = s.events.filter(e => e.type === 'BUZZER_LATE');
  assert.strictEqual(first.length, 1, 'anche in pareggio deve esserci un solo primo');
  assert.strictEqual(late.length, 1);
  assert.strictEqual(s.teamActions.length, 1, 'il punto non deve restare senza assegnatario');
  assert.match(late[0].msg, /PHOTO FINISH/, `il pareggio va segnalato: ${late[0].msg}`);
});

test('driver che non aggiorna timestamp (0) non manda in tilt lordine', () => {
  const s = makeSandbox(racePads(0, 0));
  s.pollGamepads();
  assert.strictEqual(s.events.filter(e => e.type === 'BUZZER_FIRST').length, 1);
  assert.strictEqual(s.teamActions.length, 1);
});

test('un solo buzzer premuto resta un PRIMO BUZZER senza ALTRO BUZZER', () => {
  const s = makeSandbox([
    { index: 0, timestamp: 4994.1, buttons: [{ pressed: true, value: 1 }] },
    { index: 1, timestamp: 4994.1, buttons: [{ pressed: false, value: 0 }] }
  ]);
  s.pollGamepads();
  assert.strictEqual(s.events.filter(e => e.type === 'BUZZER_FIRST').length, 1);
  assert.strictEqual(s.events.filter(e => e.type === 'BUZZER_LATE').length, 0);
});

// --- segnale acustico di chiamata ------------------------------------------

function pressOne(action) {
  const s = makeSandbox(
    [{ index: 0, timestamp: 4994.1, buttons: [{ pressed: true, value: 1 }] }],
    { GP0_B0: action }
  );
  s.pollGamepads();
  return s;
}

test('i buzzer delle basi fanno partire il segnale acustico', () => {
  for (const action of ['POINT_A', 'POINT_B']) {
    assert.strictEqual(pressOne(action).alerts.length, 1, `${action} deve suonare`);
  }
});

test('i buzzer di timeout e towel fanno partire il segnale acustico', () => {
  for (const action of ['TECH_A', 'TECH_B', 'TOWEL_A', 'TOWEL_B']) {
    assert.strictEqual(pressOne(action).alerts.length, 1, `${action} deve suonare`);
  }
});

test('i comandi di regia non fanno partire il segnale acustico', () => {
  for (const action of ['START', 'PAUSE', 'NO_POINT', 'VERIFY_APPROVE', 'VERIFY_REJECT']) {
    assert.strictEqual(pressOne(action).alerts.length, 0, `${action} non deve suonare`);
  }
});

test('il secondo buzzer della gara non fa ripartire il segnale a meta', () => {
  const s = makeSandbox(racePads(4994.1, 4994.5));
  s.pollGamepads();
  assert.strictEqual(s.alerts.length, 1, `atteso un solo suono, trovati ${s.alerts.length}`);
});
