// Segnale acustico di chiamata: deve partire quando viene chiamato un punto
// dalle basi o un timeout/towel, da qualunque origine (buzzer fisico, pulsanti
// della Regia, tablet arbitro), e non deve ripartire piu' volte per la stessa
// pressione mentre attraversa le funzioni in cascata.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');

function slice(startMarker, endMarker) {
  const a = html.indexOf(startMarker);
  assert.ok(a > 0, `marcatore iniziale non trovato: ${startMarker}`);
  const b = html.indexOf(endMarker, a);
  assert.ok(b > a, `marcatore finale non trovato: ${endMarker}`);
  return html.slice(a, b);
}

// Estrae il corpo di una funzione dal sorgente, bilanciando le graffe.
function functionBody(name) {
  const start = html.indexOf(`function ${name}(`);
  assert.ok(start > 0, `funzione non trovata: ${name}`);
  const open = html.indexOf('{', start);
  let depth = 0;
  for (let i = open; i < html.length; i++) {
    if (html[i] === '{') depth++;
    else if (html[i] === '}') {
      depth--;
      if (depth === 0) return html.slice(open, i + 1);
    }
  }
  throw new Error(`graffe non bilanciate in ${name}`);
}

const alertBlock = slice('// --- SEGNALE DI CHIAMATA (BUZZER / TIMEOUT / TOWEL) ---', 'function playBeep(type)');
const nowBlock = slice('function buzzerNow()', 'function formatBuzzerGap');

function makeSandbox() {
  const plays = [];
  let clock = 10000;

  const sandbox = {
    console,
    plays,
    setClock: (v) => { clock = v; },
    performance: { now: () => clock },
    Date: { now: () => 1770000000000 + clock },
    log: () => {},
    Audio: function (src) {
      this.src = src;
      this.currentTime = null;
      this.preload = null;
      this.play = () => { plays.push({ src: this.src, from: this.currentTime, at: clock }); return Promise.resolve(); };
    }
  };
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(nowBlock + '\n' + alertBlock, sandbox, { filename: 'index.html:alert' });
  return sandbox;
}

test('una pressione fa partire il file una volta sola', () => {
  const s = makeSandbox();
  s.playBuzzerAlert();
  assert.strictEqual(s.plays.length, 1);
  assert.strictEqual(s.plays[0].src, 'buzzer-alert.mp3');
  assert.strictEqual(s.plays[0].from, 0, 'il file deve ripartire dallinizio');
});

test('le chiamate in cascata della stessa pressione non lo fanno ripartire', () => {
  const s = makeSandbox();
  // buzzer -> azione smart -> pausa tecnica: tre chiamate, un solo suono.
  s.playBuzzerAlert();
  s.setClock(10050);
  s.playBuzzerAlert();
  s.setClock(10120);
  s.playBuzzerAlert();
  assert.strictEqual(s.plays.length, 1, `atteso 1 suono, trovati ${s.plays.length}`);
});

test('una chiamata successiva e distinta suona di nuovo', () => {
  const s = makeSandbox();
  s.playBuzzerAlert();
  s.setClock(10600); // oltre la finestra anti-ripetizione
  s.playBuzzerAlert();
  assert.strictEqual(s.plays.length, 2);
});

test('un file mancante non fa saltare la logica di gioco', () => {
  const s = makeSandbox();
  s.Audio = function () {
    this.play = () => { throw new Error('NotSupportedError'); };
  };
  assert.doesNotThrow(() => s.playBuzzerAlert());
});

// --- aggancio ai punti di ingresso -----------------------------------------
// Il buzzer fisico e' coperto dai test comportamentali in buzzer-race.test.js;
// qui si verifica che gli altri percorsi (Regia e tablet arbitro, che passano
// per queste tre funzioni) chiamino davvero il segnale.

test('la richiesta punto fa partire il segnale', () => {
  assert.match(functionBody('handleTeamAction'), /playBuzzerAlert\(\)/);
});

test('lazione smart (towel) fa partire il segnale', () => {
  assert.match(functionBody('handleSmartAction'), /playBuzzerAlert\(\)/);
});

test('il timeout fa partire il segnale anche se poi viene rifiutato', () => {
  const body = functionBody('handleTechPause');
  assert.match(body, /playBuzzerAlert\(\)/);
  // Deve stare prima del controllo sui 10 secondi: la chiamata va segnalata
  // comunque, altrimenti un rifiuto resta muto.
  assert.ok(
    body.indexOf('playBuzzerAlert()') < body.indexOf('state.timer <= 10'),
    'il segnale deve precedere i controlli di validita'
  );
});

// --- asset ------------------------------------------------------------------

// Conta i frame MPEG audio: per MPEG1 Layer III ogni frame vale 1152 campioni.
function mp3Duration(buf) {
  let i = 0;
  // Salta un eventuale tag ID3v2 in testa.
  if (buf.slice(0, 3).toString('latin1') === 'ID3') {
    const size = ((buf[6] & 0x7f) << 21) | ((buf[7] & 0x7f) << 14) | ((buf[8] & 0x7f) << 7) | (buf[9] & 0x7f);
    i = 10 + size;
  }
  const BITRATES = [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 0];
  const RATES = [44100, 48000, 32000, 0];
  let frames = 0, sampleRate = 0;
  while (i < buf.length - 4) {
    if (buf[i] === 0xff && (buf[i + 1] & 0xe0) === 0xe0) {
      const bitrate = BITRATES[(buf[i + 2] & 0xf0) >> 4];
      sampleRate = RATES[(buf[i + 2] & 0x0c) >> 2];
      const padding = (buf[i + 2] & 0x02) >> 1;
      if (!bitrate || !sampleRate) { i++; continue; }
      frames++;
      i += Math.floor((144000 * bitrate) / sampleRate) + padding;
    } else {
      i++;
    }
  }
  return (frames * 1152) / sampleRate;
}

test('il file del segnale esiste e dura 3 secondi', () => {
  const file = path.join(ROOT, 'buzzer-alert.mp3');
  assert.ok(fs.existsSync(file), 'buzzer-alert.mp3 mancante nella cartella del progetto');
  const seconds = mp3Duration(fs.readFileSync(file));
  assert.ok(
    Math.abs(seconds - 3) < 0.1,
    `il segnale deve durare 3 secondi, misurati ${seconds.toFixed(3)}s`
  );
});

// Legge un campo di bit dalle informazioni laterali del frame.
function readBits(buf, base, bitOff, len) {
  let v = 0;
  for (let b = 0; b < len; b++) {
    const p = bitOff + b;
    v = (v << 1) | ((buf[base + (p >> 3)] >> (7 - (p & 7))) & 1);
  }
  return v;
}

// Un frame senza dati principali (part2_3_length a zero su tutti i granuli e
// canali) e' un frame muto: basta questo per distinguere suono e pausa senza
// dover decodificare l'audio.
function mp3ToneBlocks(buf) {
  let i = 0;
  if (buf.slice(0, 3).toString('latin1') === 'ID3') {
    const size = ((buf[6] & 0x7f) << 21) | ((buf[7] & 0x7f) << 14) | ((buf[8] & 0x7f) << 7) | (buf[9] & 0x7f);
    i = 10 + size;
  }
  const BITRATES = [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 0];
  const RATES = [44100, 48000, 32000, 0];
  const blocks = [];
  let sounding = 0, current = null;
  while (i < buf.length - 4) {
    if (buf[i] === 0xff && (buf[i + 1] & 0xe0) === 0xe0) {
      const bitrate = BITRATES[(buf[i + 2] & 0xf0) >> 4];
      const sampleRate = RATES[(buf[i + 2] & 0x0c) >> 2];
      const padding = (buf[i + 2] & 0x02) >> 1;
      if (!bitrate || !sampleRate) { i++; continue; }
      const mono = ((buf[i + 3] & 0xc0) >> 6) === 3;
      const nch = mono ? 1 : 2;
      const crc = (buf[i + 1] & 0x01) === 0 ? 2 : 0;
      const side = i + 4 + crc;
      // main_data_begin + private_bits + scfsi, poi 59 bit per granulo/canale.
      const head = mono ? 9 + 5 + 4 : 9 + 3 + 8;
      let bits = 0;
      for (let u = 0; u < 2 * nch; u++) bits += readBits(buf, side, head + u * 59, 12);

      const frameSeconds = 1152 / sampleRate;
      if (bits > 0) {
        if (!current) { current = { start: sounding, seconds: 0 }; blocks.push(current); }
        current.seconds += frameSeconds;
      } else {
        current = null;
      }
      sounding += frameSeconds;
      i += Math.floor((144000 * bitrate) / sampleRate) + padding;
    } else {
      i++;
    }
  }
  return blocks;
}

test('il segnale e un beep solo, lungo quanto il file', () => {
  const buf = fs.readFileSync(path.join(ROOT, 'buzzer-alert.mp3'));
  const blocks = mp3ToneBlocks(buf);
  assert.strictEqual(
    blocks.length, 1,
    `atteso un unico beep continuo, trovati ${blocks.length} blocchi di suono ` +
    `(${blocks.map(b => `${b.start.toFixed(2)}s+${b.seconds.toFixed(2)}s`).join(', ')})`
  );
  assert.ok(
    blocks[0].seconds > 2.8,
    `il beep deve coprire i 3 secondi, ne copre ${blocks[0].seconds.toFixed(3)}s`
  );
});
