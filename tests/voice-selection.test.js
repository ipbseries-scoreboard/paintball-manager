// Voce degli annunci: deve essere maschile, al volume massimo consentito dal
// browser, e la scelta automatica non deve essere scavalcata dalla voce
// "default" del sistema (che su molti PC e' femminile).
//
// Il test estrae dal vero index.html isMaleVoice/populateVoiceList/speak e li
// esegue in sandbox con una lista voci realistica di Windows + Chrome.
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

const voiceBlock = slice('// La Web Speech API non espone il genere', 'if (speechSynthesis.onvoiceschanged !== undefined)');
const speakBlock = slice('function speak(textIT, textEN) {', 'function updateTimerDisplay()');

function v(name, lang, localService, isDefault) {
  return { name, lang, voiceURI: name, localService: !!localService, default: !!isDefault };
}

// Lista tipica di un PC Windows con Chrome: la default di sistema e' femminile.
const WINDOWS_VOICES = [
  v('Google US English', 'en-US', false, true),
  v('Google UK English Female', 'en-GB', false),
  v('Google UK English Male', 'en-GB', false),
  v('Microsoft David - English (United States)', 'en-US', true),
  v('Microsoft Mark - English (United States)', 'en-US', true),
  v('Microsoft Zira - English (United States)', 'en-US', true),
  v('Microsoft Elsa - Italian (Italy)', 'it-IT', true),
  v('Google italiano', 'it-IT', false)
];

function makeSandbox(voiceList, savedVoiceURI = null) {
  const select = { innerHTML: '', value: null, options: [], appendChild(o) { this.options.push(o); } };
  const spoken = [];

  const sandbox = {
    console,
    spoken,
    select,
    voices: [],
    synth: { getVoices: () => voiceList, cancel() {}, speak(u) { spoken.push(u); } },
    document: {
      getElementById: (id) => (id === 'voice-select' ? select : null),
      createElement: () => ({ textContent: '', value: '' })
    },
    SpeechSynthesisUtterance: function (text) { this.text = text; this.voice = null; },
    state: { settings: { voice: true, lang: 'en-US', voiceURI: savedVoiceURI } }
  };
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(voiceBlock + '\n' + speakBlock, sandbox, { filename: 'index.html:voice' });
  return sandbox;
}

test('sceglie una voce maschile locale invece della default femminile', () => {
  const s = makeSandbox(WINDOWS_VOICES);
  s.populateVoiceList();
  assert.strictEqual(
    s.state.settings.voiceURI,
    'Microsoft David - English (United States)',
    `scelta sbagliata: ${s.state.settings.voiceURI}`
  );
});

test('la voce scelta a mano dallutente non viene sovrascritta', () => {
  const s = makeSandbox(WINDOWS_VOICES, 'Microsoft Zira - English (United States)');
  s.populateVoiceList();
  assert.strictEqual(s.state.settings.voiceURI, 'Microsoft Zira - English (United States)');
});

test('le voci maschili sono marcate nella tendina', () => {
  const s = makeSandbox(WINDOWS_VOICES);
  s.populateVoiceList();
  const david = s.select.options.find(o => o.textContent.includes('Microsoft David'));
  const zira = s.select.options.find(o => o.textContent.includes('Microsoft Zira'));
  assert.match(david.textContent, /^♂ /);
  assert.doesNotMatch(zira.textContent, /♂/);
  assert.strictEqual(s.select.options.length, WINDOWS_VOICES.length, 'nessuna voce deve sparire dalla lista');
});

test('speak usa la voce maschile, volume massimo e timbro grave', () => {
  const s = makeSandbox(WINDOWS_VOICES);
  s.populateVoiceList();
  s.speak('Timeout', 'Timeout');

  assert.strictEqual(s.spoken.length, 1);
  const u = s.spoken[0];
  assert.strictEqual(u.text, 'Timeout');
  assert.strictEqual(u.voice.name, 'Microsoft David - English (United States)');
  assert.strictEqual(u.volume, 1.0, 'il volume deve restare al massimo consentito dalla Web Speech API');
  assert.ok(u.pitch < 1.0, `il timbro deve essere piu' grave di quello neutro: ${u.pitch}`);
});

test('su un PC con sole voci femminili abbassa molto il timbro', () => {
  const onlyFemale = [
    v('Microsoft Zira - English (United States)', 'en-US', true, true),
    v('Google UK English Female', 'en-GB', false)
  ];
  const s = makeSandbox(onlyFemale);
  s.populateVoiceList();
  s.speak('Timeout', 'Timeout');
  const u = s.spoken[0];
  assert.ok(u.pitch <= 0.6, `serve un pitch basso per mascolinizzare una voce femminile: ${u.pitch}`);
  assert.strictEqual(u.volume, 1.0);
});

test('la voce muta resta muta', () => {
  const s = makeSandbox(WINDOWS_VOICES);
  s.populateVoiceList();
  s.state.settings.voice = false;
  s.speak('Timeout', 'Timeout');
  assert.strictEqual(s.spoken.length, 0);
});
