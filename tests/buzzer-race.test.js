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
  // Riga sotto il titolo del modale di verifica: e' cio' che l'arbitro legge
  // per decidere, quindi va controllata come un output a tutti gli effetti.
  const marginEl = { style: { display: 'none', color: '' }, innerText: '' };
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
    marginEl,
    document: { getElementById: (id) => (id === 'verify-margin' ? marginEl : null) },
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

// --- chi ha premuto per primo ----------------------------------------------
// Il primo buzzer registrato e' quello che ha premuto per primo: e' quello che
// apre la verifica del punto, e il modale deve nominarlo SEMPRE. Il distacco
// in millisecondi e' un'informazione in piu' e si aggiunge solo quando supera
// la soglia dell'impianto (433 MHz: frequenza condivisa, codice ripetuto,
// rele' meccanico, quindi ~100-250 ms di ritardo variabile).

test('il modale nomina sempre chi ha premuto per primo', () => {
  const s = makeSandbox(racePads(4998.2, 4994.1)); // GP1 (TEAM B) ha premuto prima
  s.pollGamepads();
  assert.match(s.marginEl.innerText, /^PRIMO BUZZER: TEAM B/, `va nominato il primo: ${s.marginEl.innerText}`);
  assert.strictEqual(s.teamActions[0].side, 'right', 'la verifica si apre sul primo');
});

test('uno scarto sotto la soglia nomina il primo senza numero', () => {
  const s = makeSandbox(racePads(4994.1, 4994.5)); // 0.4 ms: sotto la soglia
  s.pollGamepads();
  assert.strictEqual(s.marginEl.innerText, 'PRIMO BUZZER: TEAM A', `atteso il solo nome: ${s.marginEl.innerText}`);
});

test('uno scarto sopra la soglia aggiunge il distacco', () => {
  const s = makeSandbox(racePads(4994.1, 5394.1)); // 400 ms
  s.pollGamepads();
  assert.strictEqual(s.marginEl.innerText, 'PRIMO BUZZER: TEAM A · +400 ms', `distacco atteso: ${s.marginEl.innerText}`);
});

test('il distacco non porta decimali che il sensore non puo produrre', () => {
  const s = makeSandbox(racePads(4994.1, 5394.6)); // 400.5 ms
  s.pollGamepads();
  assert.doesNotMatch(s.marginEl.innerText, /\d\.\d/, `precisione inventata: ${s.marginEl.innerText}`);
});

test('pareggio esatto di timestamp assegna comunque un vincitore unico', () => {
  const s = makeSandbox(racePads(4994.1, 4994.1)); // driver che non discrimina
  s.pollGamepads();
  const first = s.events.filter(e => e.type === 'BUZZER_FIRST');
  const late = s.events.filter(e => e.type === 'BUZZER_LATE');
  assert.strictEqual(first.length, 1, 'anche in pareggio deve esserci un solo primo');
  assert.strictEqual(late.length, 1);
  assert.strictEqual(s.teamActions.length, 1, 'il punto non deve restare senza assegnatario');
  assert.match(s.marginEl.innerText, /^PRIMO BUZZER: /, `il primo va nominato comunque: ${s.marginEl.innerText}`);
});

// --- stessa base che preme due volte ---------------------------------------
// Regressione coperta: la seconda pressione veniva trattata come "l'altra
// squadra ha chiamato" senza mai confrontare i due lati. L'arbitro che ribatte
// perche' non vede reazione (o il pulsante che rimbalza) produceva a referto la
// stessa squadra come prima E come seconda, piu' un distacco mai esistito.

function sameSidePads(ts0, ts1) {
  return {
    pads: [
      { index: 0, timestamp: ts0, buttons: [{ pressed: true, value: 1 }] },
      { index: 1, timestamp: ts1, buttons: [{ pressed: true, value: 1 }] }
    ],
    mapping: { GP0_B0: 'POINT_A', GP1_B0: 'POINT_A' }
  };
}

test('la stessa base che preme due volte non genera un ALTRO BUZZER', () => {
  const cfg = sameSidePads(4994.1, 4998.2);
  const s = makeSandbox(cfg.pads, cfg.mapping);
  s.pollGamepads();

  assert.strictEqual(s.events.filter(e => e.type === 'BUZZER_FIRST').length, 1);
  assert.strictEqual(
    s.events.filter(e => e.type === 'BUZZER_LATE').length, 0,
    `la stessa squadra non puo risultare anche seconda: ${JSON.stringify(s.events)}`
  );
  assert.strictEqual(s.events.filter(e => e.type === 'BUZZER_REPEAT').length, 1);
});

test('la ripetizione non fa comparire un distacco nel modale', () => {
  const cfg = sameSidePads(4994.1, 4998.2);
  const s = makeSandbox(cfg.pads, cfg.mapping);
  s.pollGamepads();

  assert.strictEqual(s.marginEl.innerText, '', `nessuna gara, nessun distacco: ${s.marginEl.innerText}`);
  assert.strictEqual(s.marginEl.style.display, 'none');
});

test('la ripetizione non apre un secondo punto', () => {
  const cfg = sameSidePads(4994.1, 4998.2);
  const s = makeSandbox(cfg.pads, cfg.mapping);
  s.pollGamepads();
  assert.strictEqual(s.teamActions.length, 1);
  assert.strictEqual(s.teamActions[0].side, 'left');
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
