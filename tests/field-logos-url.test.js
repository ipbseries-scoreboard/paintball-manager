// I link copiati dall'interfaccia web di GitHub (github.com/.../blob/... o
// /raw/...) non sono utilizzabili dall'overlay: il primo e' una pagina HTML, il
// secondo e' un redirect che non manda intestazioni CORS, quindi il canvas
// diventa "tainted" e l'esportazione fallisce. Solo raw.githubusercontent.com
// risponde con "Access-Control-Allow-Origin: *". Questi test fissano la
// riscrittura automatica da una forma all'altra.
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');

function loadCore() {
  const sandbox = { console };
  vm.createContext(sandbox);
  vm.runInContext(
    fs.readFileSync(path.join(ROOT, 'field-logos-core.js'), 'utf8'),
    sandbox,
    { filename: 'field-logos-core.js' }
  );
  assert.ok(sandbox.FieldLogosCore, 'FieldLogosCore non esposto');
  return sandbox.FieldLogosCore;
}

const Core = loadCore();
const RAW = 'https://raw.githubusercontent.com/ipbseries-scoreboard/paintball-manager/main/NO%20SFONDO/PARMA%20KIDS.png';

test('il link "blob" della pagina GitHub diventa raw.githubusercontent', () => {
  assert.strictEqual(
    Core.normalizeLogoUrl('https://github.com/ipbseries-scoreboard/paintball-manager/blob/main/NO%20SFONDO/PARMA%20KIDS.png'),
    RAW
  );
});

test('il link "raw" di github.com diventa raw.githubusercontent', () => {
  assert.strictEqual(
    Core.normalizeLogoUrl('https://github.com/ipbseries-scoreboard/paintball-manager/raw/main/NO%20SFONDO/PARMA%20KIDS.png'),
    RAW
  );
});

test('il flag ?raw=1 e lancora vengono tolti, il resto della query resta', () => {
  assert.strictEqual(
    Core.normalizeLogoUrl('https://github.com/ipbseries-scoreboard/paintball-manager/blob/main/NO%20SFONDO/PARMA%20KIDS.png?raw=1'),
    RAW
  );
  assert.strictEqual(
    Core.normalizeLogoUrl('https://github.com/ipbseries-scoreboard/paintball-manager/blob/main/NO%20SFONDO/PARMA%20KIDS.png#anteprima'),
    RAW
  );
  assert.strictEqual(
    Core.normalizeLogoUrl('https://github.com/o/r/blob/main/x.png?token=abc'),
    'https://raw.githubusercontent.com/o/r/main/x.png?token=abc'
  );
});

test('varianti di scrittura del dominio: www e http', () => {
  assert.strictEqual(
    Core.normalizeLogoUrl('https://www.github.com/o/r/blob/main/x.png'),
    'https://raw.githubusercontent.com/o/r/main/x.png'
  );
  assert.strictEqual(
    Core.normalizeLogoUrl('http://github.com/o/r/raw/main/x.png'),
    'https://raw.githubusercontent.com/o/r/main/x.png'
  );
});

test('gli spazi intorno allurl incollato non contano', () => {
  assert.strictEqual(
    Core.normalizeLogoUrl('  https://github.com/o/r/blob/main/x.png  '),
    'https://raw.githubusercontent.com/o/r/main/x.png'
  );
});

test('quello che gia funziona non viene toccato', () => {
  const invariati = [
    RAW,
    'NO%20SFONDO/PARMA%20KIDS.png',
    '/NO%20SFONDO/PARMA%20KIDS.png',
    'https://ipbseries-scoreboard.github.io/paintball-manager/NO%20SFONDO/PARMA%20KIDS.png',
    'https://www.ipba.it/loghi/parma.png',
    'data:image/png;base64,iVBORw0KGgo='
  ];
  invariati.forEach(u => assert.strictEqual(Core.normalizeLogoUrl(u), u, `modificato per sbaglio: ${u}`));
});

test('le pagine github che non sono file restano come sono', () => {
  // Senza blob/raw non c'e' un file da servire: riscriverlo darebbe un 404
  // silenzioso al posto di un errore comprensibile.
  const u = 'https://github.com/ipbseries-scoreboard/paintball-manager';
  assert.strictEqual(Core.normalizeLogoUrl(u), u);
});

test('valori vuoti o non stringa non fanno saltare nulla', () => {
  assert.strictEqual(Core.normalizeLogoUrl(''), '');
  assert.strictEqual(Core.normalizeLogoUrl(null), null);
  assert.strictEqual(Core.normalizeLogoUrl(undefined), undefined);
});

// --- aggancio ai punti di ingresso -----------------------------------------

test('lurl che arriva nel pacchetto della Regia viene riscritto', async () => {
  const url = await Core.resolveLogoUrl(
    'Parma Kids',
    'https://github.com/ipbseries-scoreboard/paintball-manager/blob/main/NO%20SFONDO/PARMA%20KIDS.png',
    [],
    null
  );
  assert.strictEqual(url, RAW);
});

test('lurl configurato nella lista squadre viene riscritto', async () => {
  const clans = [{
    name: 'Parma Kids',
    logoUrl: 'https://github.com/ipbseries-scoreboard/paintball-manager/raw/main/NO%20SFONDO/PARMA%20KIDS.png'
  }];
  const url = await Core.resolveLogoUrl('Parma Kids', null, clans, null);
  assert.strictEqual(url, RAW);
});

test('il caricamento del logo riscrive lurl anche se arriva da altrove', () => {
  // field-logos-overlay.html passa gli url del payload pubblicato senza
  // ripassare da resolveLogoUrl: la rete di sicurezza sta in loadLogoImage.
  const src = fs.readFileSync(path.join(ROOT, 'field-logos-core.js'), 'utf8');
  const start = src.indexOf('function loadLogoImage(');
  assert.ok(start > 0, 'loadLogoImage non trovata');
  const body = src.slice(start, src.indexOf('\n    }', start));
  assert.match(body, /normalizeLogoUrl\(/);
});

test('lurl incollato nella lista squadre viene ripulito subito', () => {
  // streaming.html: updateClan e' il punto in cui l'operatore incolla il link,
  // e quello che scrive finisce in pm_stream_clans per tutte le altre pagine.
  const src = fs.readFileSync(path.join(ROOT, 'streaming.html'), 'utf8');
  const start = src.indexOf('function updateClan(');
  assert.ok(start > 0, 'updateClan non trovata');
  const body = src.slice(start, start + 600);
  assert.match(body, /normalizeLogoUrl/);
});

test('anche le liste gia salvate vengono riparate quando si aprono', () => {
  const src = fs.readFileSync(path.join(ROOT, 'streaming.html'), 'utf8');
  const start = src.indexOf('function normalizeClanList(');
  assert.ok(start > 0, 'normalizeClanList non trovata in streaming.html');
  assert.match(src.slice(start, start + 600), /normalizeLogoUrl/);
});
