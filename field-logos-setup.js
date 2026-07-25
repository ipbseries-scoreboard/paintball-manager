/*
 * FIELD-LOGOS-SETUP v1.0 — sezione "Loghi sul green" di streaming.html
 *
 * Editor visuale completo per proiettare i loghi delle due squadre sul green:
 *   - screenshot di calibrazione (carica/incolla, salvato in IndexedDB);
 *   - corner pin prospettico a 4 maniglie per ciascun logo;
 *   - campionamento del green + maschera HSV con regolazioni;
 *   - strumenti di esclusione: selezione, poligono, lazo, rettangolo, ellisse,
 *     pennello, gomma/ripristina, mano, zoom — tutto SENZA coordinate numeriche;
 *   - pannello oggetti stile livelli, undo/redo completo;
 *   - persistenza (localStorage + IndexedDB), import/export JSON;
 *   - pubblicazione della configurazione verso field-logos-overlay.html
 *     (API del server locale, BroadcastChannel/localStorage, URL con ?cfg=).
 *
 * La UI viene iniettata nel DOM alla prima apertura: streaming.html contiene
 * solo il bottone di apertura. Nessuna dipendenza esterna.
 */
(function (global) {
    'use strict';

    var Core = global.FieldLogosCore;
    if (!Core) { console.error('[FieldLogos] field-logos-core.js mancante'); return; }

    var W = Core.W, H = Core.H;
    var LS_DOC_KEY = 'pm_field_logos_doc';
    var LS_PUB_KEY = 'pm_field_logos_pub';
    var BC_NAME = 'pm_field_logos';
    var IDB_NAME = 'pm_field_logos';
    var IDB_STORE = 'assets';
    // Relativo alla pagina: sul server locale diventa /api/..., su GitHub Pages
    // resta dentro il progetto (e risponde 404 HTML, che è il segnale corretto).
    var API_PATH = new URL('api/field-logos/default', location.href).href;

    // ------------------------------------------------------------
    // STATO
    // ------------------------------------------------------------
    var doc = null;                 // documento di configurazione (vedi Core.defaultDoc)
    var built = false;              // DOM creato
    var isOpen = false;

    var screenshotCanvas = null;    // canvas 1920×1080
    var screenshotData = null;      // ImageData per il campionamento/maschera

    var caches = {
        greenMask: null,            // Uint8Array
        greenViz: null,             // canvas per la preview della maschera
        exclLeft: null, exclRight: null,      // canvas (alpha = consentito)
        combLeft: null, combRight: null,      // green × esclusioni
        shade: null,                // trama prato
        greenDirty: true, exclDirty: true, shadeDirty: true
    };

    var renderer = null;            // Core.createRenderer()
    var resultCanvas = null;        // composito finale 1920×1080 (preview)
    var resultCtx = null;

    var view = { scale: 0.5, x: 0, y: 0 };
    var previewMode = 'config';     // config | screenshot | logos | green | excl | final
    var tool = 'select';
    var drawing = null;             // stato disegno in corso
    var dragCtx = null;             // stato trascinamento in corso
    var selectedId = null;
    var selectedVertex = -1;
    var spaceDown = false;
    var pointerPos = null;          // ultima posizione (logica) per cursore pennello

    var undoStack = [], redoStack = [];
    var HIST_MAX = 120;

    var teams = {
        left: { name: '', logoUrl: null, img: null, status: 'In attesa della partita...' },
        right: { name: '', logoUrl: null, img: null, status: 'In attesa della partita...' }
    };

    var bc = null;
    var apiAvailable = null;        // null = da verificare
    var lastPublishedAt = 0;
    var autosaveTimer = null;
    var greenTimer = null;
    var teamTimer = null;
    var renderQueued = false;
    var objSeq = 1;

    var stage, stageCtx, editor, editorCtx, wrapEl;

    // ------------------------------------------------------------
    // UTILITY
    // ------------------------------------------------------------
    function $(id) { return document.getElementById(id); }
    function clamp(v, a, b) { return v < a ? a : (v > b ? b : v); }
    function esc(s) {
        return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
            return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
        });
    }
    function snap() { return JSON.stringify(doc); }
    function setStatus(msg, kind) {
        var el = $('flg-status');
        if (!el) return;
        el.textContent = msg || '';
        el.className = kind || '';
    }

    // ------------------------------------------------------------
    // INDEXEDDB (screenshot: mai in localStorage come base64 gigante)
    // ------------------------------------------------------------
    function idbOpen() {
        return new Promise(function (resolve, reject) {
            var rq = indexedDB.open(IDB_NAME, 1);
            rq.onupgradeneeded = function () { rq.result.createObjectStore(IDB_STORE); };
            rq.onsuccess = function () { resolve(rq.result); };
            rq.onerror = function () { reject(rq.error); };
        });
    }
    function idbPut(key, value) {
        return idbOpen().then(function (db) {
            return new Promise(function (resolve, reject) {
                var tx = db.transaction(IDB_STORE, 'readwrite');
                tx.objectStore(IDB_STORE).put(value, key);
                tx.oncomplete = function () { db.close(); resolve(); };
                tx.onerror = function () { db.close(); reject(tx.error); };
            });
        });
    }
    function idbGet(key) {
        return idbOpen().then(function (db) {
            return new Promise(function (resolve, reject) {
                var tx = db.transaction(IDB_STORE, 'readonly');
                var rq = tx.objectStore(IDB_STORE).get(key);
                rq.onsuccess = function () { db.close(); resolve(rq.result); };
                rq.onerror = function () { db.close(); reject(rq.error); };
            });
        });
    }
    function idbDel(key) {
        return idbOpen().then(function (db) {
            return new Promise(function (resolve) {
                var tx = db.transaction(IDB_STORE, 'readwrite');
                tx.objectStore(IDB_STORE).delete(key);
                tx.oncomplete = function () { db.close(); resolve(); };
                tx.onerror = function () { db.close(); resolve(); };
            });
        });
    }

    // ------------------------------------------------------------
    // DOCUMENTO: caricamento, salvataggio, migrazione
    // ------------------------------------------------------------
    function sanitizeDoc(raw) {
        var d = Core.defaultDoc();
        if (!raw || typeof raw !== 'object') return d;
        function num(v, fb) { return typeof v === 'number' && isFinite(v) ? v : fb; }
        function boolOr(v, fb) { return typeof v === 'boolean' ? v : fb; }
        d.enabled = boolOr(raw.enabled, d.enabled);
        d.showLeft = boolOr(raw.showLeft, d.showLeft);
        d.showRight = boolOr(raw.showRight, d.showRight);
        d.linkLogos = boolOr(raw.linkLogos, d.linkLogos);
        d.margin = clamp(num(raw.margin, 0), -40, 80);
        d.updatedAt = num(raw.updatedAt, 0);
        ['left', 'right'].forEach(function (side) {
            var src = raw[side], dst = d[side];
            if (!src) return;
            dst.visible = boolOr(src.visible, dst.visible);
            dst.opacity = clamp(num(src.opacity, dst.opacity), 0, 1);
            dst.scale = clamp(num(src.scale, dst.scale), 0.1, 4);
            dst.feather = clamp(num(src.feather, dst.feather), 0, 60);
            dst.blur = clamp(num(src.blur, dst.blur), 0, 8);
            dst.desat = clamp(num(src.desat, dst.desat), 0, 1);
            dst.fusion = clamp(num(src.fusion, dst.fusion), 0, 1);
            dst.dx = clamp(num(src.dx, 0), -1500, 1500);
            dst.dy = clamp(num(src.dy, 0), -900, 900);
            dst.rot = clamp(num(src.rot, 0), -180, 180);
            if (Array.isArray(src.quad) && src.quad.length === 4) {
                dst.quad = src.quad.map(function (p) {
                    return { x: clamp(num(p.x, 0), -2000, 4000), y: clamp(num(p.y, 0), -2000, 3000) };
                });
            }
        });
        if (raw.green && typeof raw.green === 'object') {
            var g = raw.green, gd = d.green;
            gd.enabled = boolOr(g.enabled, gd.enabled);
            gd.tol = clamp(num(g.tol, gd.tol), 0.3, 3);
            gd.soft = clamp(num(g.soft, gd.soft), 0, 0.5);
            gd.hMin = clamp(num(g.hMin, gd.hMin), 0, 360);
            gd.hMax = clamp(num(g.hMax, gd.hMax), 0, 360);
            gd.sMin = clamp(num(g.sMin, gd.sMin), 0, 1);
            gd.sMax = clamp(num(g.sMax, gd.sMax), 0, 1);
            gd.vMin = clamp(num(g.vMin, gd.vMin), 0, 1);
            gd.vMax = clamp(num(g.vMax, gd.vMax), 0, 1);
            gd.erode = clamp(num(g.erode, 0), 0, 30);
            gd.dilate = clamp(num(g.dilate, 0), 0, 30);
            gd.feather = clamp(num(g.feather, 3), 0, 40);
            gd.despeckle = clamp(num(g.despeckle, 2), 0, 12);
            gd.fillHoles = clamp(num(g.fillHoles, 2), 0, 12);
            if (Array.isArray(g.samples)) {
                gd.samples = g.samples.slice(0, 64).filter(function (s) {
                    return s && isFinite(s.h) && isFinite(s.s) && isFinite(s.v);
                });
            }
        }
        if (Array.isArray(raw.objects)) {
            d.objects = raw.objects.slice(0, 400).map(sanitizeObject).filter(Boolean);
        }
        return d;
    }

    function sanitizeObject(o) {
        if (!o || typeof o !== 'object') return null;
        var types = ['polygon', 'lasso', 'rect', 'ellipse', 'brush'];
        if (types.indexOf(o.type) === -1) return null;
        var out = {
            id: typeof o.id === 'string' ? o.id : 'obj' + (objSeq++),
            type: o.type,
            name: typeof o.name === 'string' ? o.name.slice(0, 60) : o.type,
            mode: o.mode === 'restore' ? 'restore' : 'exclude',
            target: ['both', 'left', 'right'].indexOf(o.target) !== -1 ? o.target : 'both',
            visible: o.visible !== false,
            enabled: o.enabled !== false,
            locked: o.locked === true
        };
        function pts(list, max) {
            if (!Array.isArray(list)) return null;
            return list.slice(0, max).map(function (p) {
                return { x: +p.x || 0, y: +p.y || 0 };
            });
        }
        if (o.type === 'rect' || o.type === 'ellipse') {
            var r = o.rect || {};
            out.rect = {
                cx: +r.cx || 0, cy: +r.cy || 0,
                w: Math.max(4, +r.w || 10), h: Math.max(4, +r.h || 10),
                rot: +r.rot || 0
            };
        } else {
            out.points = pts(o.points, o.type === 'brush' ? 4000 : 600);
            if (!out.points || out.points.length < (o.type === 'brush' ? 1 : 3)) return null;
        }
        if (o.type === 'brush') {
            var b = o.brush || {};
            out.brush = {
                radius: clamp(+b.radius || 20, 1, 200),
                hardness: clamp(typeof b.hardness === 'number' ? b.hardness : 0.8, 0, 1)
            };
        }
        return out;
    }

    function loadDoc() {
        var raw = null;
        try { raw = JSON.parse(localStorage.getItem(LS_DOC_KEY) || 'null'); } catch (e) { }
        doc = sanitizeDoc(raw);
        // continua la numerazione oggetti dopo l'ultimo id noto
        doc.objects.forEach(function (o) {
            var m = /^obj(\d+)$/.exec(o.id);
            if (m) objSeq = Math.max(objSeq, parseInt(m[1], 10) + 1);
        });
    }

    function scheduleAutosave() {
        if (autosaveTimer) clearTimeout(autosaveTimer);
        autosaveTimer = setTimeout(saveDoc, 600);
    }

    function saveDoc() {
        try {
            localStorage.setItem(LS_DOC_KEY, snap());
            var el = $('flg-save-ind');
            if (el) { el.textContent = '💾 Salvato ' + new Date().toLocaleTimeString(); }
        } catch (e) {
            setStatus('Errore di salvataggio: ' + e.message, 'err');
        }
    }

    // ------------------------------------------------------------
    // HISTORY (undo/redo) — uno stato prima e uno dopo per operazione
    // ------------------------------------------------------------
    function pushHistory(preJson) {
        undoStack.push(preJson);
        if (undoStack.length > HIST_MAX) undoStack.shift();
        redoStack.length = 0;
        updateHistButtons();
    }

    function commit(preJson, flags) {
        // flags: {green, excl} — cosa invalidare
        if (preJson === snap()) return; // nessuna modifica reale
        pushHistory(preJson);
        afterDocChange(flags);
    }

    function afterDocChange(flags) {
        doc.updatedAt = Date.now();
        if (!flags || flags.excl) caches.exclDirty = true;
        if (flags && flags.green) caches.greenDirty = true;
        scheduleAutosave();
        updatePublishState();
        requestRender();
    }

    function restoreDoc(json, flags) {
        doc = sanitizeDoc(JSON.parse(json));
        caches.greenDirty = true;
        caches.exclDirty = true;
        selectedId = null; selectedVertex = -1;
        drawing = null;
        scheduleAutosave();
        refreshAllPanels();
        updatePublishState();
        requestRender();
    }

    function undo() {
        if (!undoStack.length) return;
        redoStack.push(snap());
        restoreDoc(undoStack.pop());
        updateHistButtons();
        setStatus('Operazione annullata', '');
    }

    function redo() {
        if (!redoStack.length) return;
        undoStack.push(snap());
        restoreDoc(redoStack.pop());
        updateHistButtons();
        setStatus('Operazione ripristinata', '');
    }

    function updateHistButtons() {
        var u = $('flg-undo'), r = $('flg-redo');
        if (u) u.disabled = !undoStack.length;
        if (r) r.disabled = !redoStack.length;
    }

    // ------------------------------------------------------------
    // GEOMETRIA QUAD EFFETTIVO (base + regolazioni fini dx/dy/rot/scale)
    // ------------------------------------------------------------
    function quadCentroid(q) {
        var cx = 0, cy = 0;
        for (var i = 0; i < 4; i++) { cx += q[i].x / 4; cy += q[i].y / 4; }
        return { x: cx, y: cy };
    }

    function effectiveQuad(side) {
        var p = doc[side];
        var c = quadCentroid(p.quad);
        var rot = (p.rot || 0) * Math.PI / 180;
        var s = p.scale || 1;
        var cos = Math.cos(rot), sin = Math.sin(rot);
        return p.quad.map(function (pt) {
            var x = (pt.x - c.x) * s, y = (pt.y - c.y) * s;
            return {
                x: c.x + (p.dx || 0) + x * cos - y * sin,
                y: c.y + (p.dy || 0) + x * sin + y * cos
            };
        });
    }

    // maniglia trascinata → nuovo punto base (inverte dx/dy, rot, scale)
    function effectiveToBase(side, pt) {
        var p = doc[side];
        var c = quadCentroid(p.quad);
        var rot = -(p.rot || 0) * Math.PI / 180;
        var s = 1 / (p.scale || 1);
        var cos = Math.cos(rot), sin = Math.sin(rot);
        var x = pt.x - c.x - (p.dx || 0), y = pt.y - c.y - (p.dy || 0);
        return {
            x: c.x + (x * cos - y * sin) * s,
            y: c.y + (x * sin + y * cos) * s
        };
    }

    // ------------------------------------------------------------
    // VISTA (zoom / pan) — coordinate logiche 1920×1080 invisibili all'utente
    // ------------------------------------------------------------
    function fitView() {
        if (!wrapEl) return;
        var cw = stage.width, ch = stage.height;
        view.scale = Math.min(cw / W, ch / H) * 0.97;
        view.x = (cw - W * view.scale) / 2;
        view.y = (ch - H * view.scale) / 2;
        updateZoomLabel();
        requestRender();
    }

    function setZoom(newScale, centerCss) {
        var rect = wrapEl.getBoundingClientRect();
        var dpr = global.devicePixelRatio || 1;
        var cx = centerCss ? (centerCss.x - rect.left) * dpr : stage.width / 2;
        var cy = centerCss ? (centerCss.y - rect.top) * dpr : stage.height / 2;
        newScale = clamp(newScale, 0.04, 12);
        var lx = (cx - view.x) / view.scale;
        var ly = (cy - view.y) / view.scale;
        view.scale = newScale;
        view.x = cx - lx * newScale;
        view.y = cy - ly * newScale;
        updateZoomLabel();
        requestRender();
    }

    function updateZoomLabel() {
        var dpr = global.devicePixelRatio || 1;
        var el = $('flg-zoom-pct');
        if (el) el.textContent = Math.round(view.scale / dpr * 100) + '%';
    }

    function toLogical(ev) {
        var rect = wrapEl.getBoundingClientRect();
        var dpr = global.devicePixelRatio || 1;
        var px = (ev.clientX - rect.left) * dpr;
        var py = (ev.clientY - rect.top) * dpr;
        return { x: (px - view.x) / view.scale, y: (py - view.y) / view.scale };
    }

    function toScreen(p) {
        return { x: p.x * view.scale + view.x, y: p.y * view.scale + view.y };
    }

    function screenDist(aLogical, bLogical) {
        return Math.hypot(aLogical.x - bLogical.x, aLogical.y - bLogical.y) * view.scale;
    }

    // ------------------------------------------------------------
    // CACHE MASCHERE / SHADE
    // ------------------------------------------------------------
    function ensureShade() {
        if (!caches.shadeDirty) return;
        caches.shade = screenshotCanvas ? Core.buildShade(screenshotCanvas) : null;
        caches.shadeDirty = false;
    }

    function ensureGreen() {
        if (!caches.greenDirty) return;
        if (!screenshotData || !doc.green.enabled) {
            caches.greenMask = null;
            caches.greenViz = null;
            caches.greenDirty = false;
            caches.exclDirty = true;
            return;
        }
        var t0 = performance.now();
        caches.greenMask = Core.computeGreenMask(screenshotData, doc.green);
        caches.greenViz = null;
        caches.greenDirty = false;
        caches.exclDirty = true;
        console.log('[FieldLogos] Maschera green calcolata in ' + Math.round(performance.now() - t0) + 'ms');
    }

    function ensureExcl() {
        if (!caches.exclDirty) return;
        caches.exclLeft = Core.rasterizeExclusions(doc.objects, 'left', doc.margin, W, H);
        var sameForBoth = !doc.objects.some(function (o) { return o.target && o.target !== 'both'; });
        caches.exclRight = sameForBoth ? caches.exclLeft :
            Core.rasterizeExclusions(doc.objects, 'right', doc.margin, W, H);
        caches.combLeft = Core.combineMasks(doc.green.enabled ? caches.greenMask : null, caches.exclLeft, W, H);
        caches.combRight = sameForBoth && caches.combLeft ? caches.combLeft :
            Core.combineMasks(doc.green.enabled ? caches.greenMask : null, caches.exclRight, W, H);
        caches.exclDirty = false;
    }

    function ensureAllMasks() { ensureGreen(); ensureExcl(); ensureShade(); }

    function greenVizCanvas() {
        if (caches.greenViz || !caches.greenMask) return caches.greenViz;
        var c = Core.makeCanvas(W, H);
        var ctx = c.getContext('2d');
        var img = ctx.createImageData(W, H);
        var d = img.data;
        for (var px = 0; px < W * H; px++) {
            var v = caches.greenMask[px];
            var i = px * 4;
            d[i] = v; d[i + 1] = v; d[i + 2] = v; d[i + 3] = 255;
        }
        ctx.putImageData(img, 0, 0);
        caches.greenViz = c;
        return c;
    }

    // ------------------------------------------------------------
    // RENDER PREVIEW
    // ------------------------------------------------------------
    function requestRender() {
        if (renderQueued || !isOpen) return;
        renderQueued = true;
        var done = false;
        function run() {
            if (done) return;
            done = true;
            renderQueued = false;
            renderStage();
            renderEditor();
        }
        // fallback se rAF è sospeso (scheda in background)
        requestAnimationFrame(run);
        setTimeout(run, 250);
    }

    function buildModel(withMasks) {
        return {
            left: {
                image: teams.left.img,
                quad: effectiveQuad('left'),
                scale: 1,
                opacity: doc.left.opacity,
                feather: doc.left.feather,
                blur: doc.left.blur,
                desat: doc.left.desat,
                fusion: doc.left.fusion,
                visible: doc.showLeft && doc.left.visible
            },
            right: {
                image: teams.right.img,
                quad: effectiveQuad('right'),
                scale: 1,
                opacity: doc.right.opacity,
                feather: doc.right.feather,
                blur: doc.right.blur,
                desat: doc.right.desat,
                fusion: doc.right.fusion,
                visible: doc.showRight && doc.right.visible
            },
            maskLeft: withMasks ? caches.combLeft : null,
            maskRight: withMasks ? caches.combRight : null,
            shade: caches.shade,
            featherBaked: false
        };
    }

    function renderStage() {
        if (!stage) return;
        var ctx = stageCtx;
        ctx.setTransform(1, 0, 0, 1, 0, 0);
        ctx.clearRect(0, 0, stage.width, stage.height);
        ctx.setTransform(view.scale, 0, 0, view.scale, view.x, view.y);
        ctx.imageSmoothingQuality = 'high';

        if (screenshotCanvas) {
            ctx.drawImage(screenshotCanvas, 0, 0);
        } else {
            ctx.fillStyle = '#0b1220';
            ctx.fillRect(0, 0, W, H);
            ctx.fillStyle = '#334155';
            ctx.font = '46px Oswald, sans-serif';
            ctx.textAlign = 'center';
            ctx.fillText('Carica o incolla lo screenshot della telecamera centrale', W / 2, H / 2);
        }
        // bordo dell'area 1920×1080
        ctx.strokeStyle = 'rgba(34,211,238,0.5)';
        ctx.lineWidth = 2 / view.scale;
        ctx.strokeRect(0, 0, W, H);

        if (previewMode === 'screenshot') return;

        if (previewMode === 'green') {
            ensureGreen();
            var viz = greenVizCanvas();
            if (viz) {
                ctx.globalAlpha = 0.85;
                ctx.drawImage(viz, 0, 0);
                ctx.globalAlpha = 1;
            } else if (!doc.green.enabled) {
                drawCenteredNote(ctx, 'Maschera verde disattivata');
            } else {
                drawCenteredNote(ctx, 'Campiona il green per generare la maschera');
            }
            return;
        }

        if (previewMode === 'excl') {
            ensureAllMasks();
            // zone NON consentite (per il logo sinistro) in rosso semitrasparente
            if (caches.combLeft) {
                var vz = Core.makeCanvas(W, H);
                var vctx = vz.getContext('2d');
                vctx.fillStyle = 'rgba(239,68,68,0.55)';
                vctx.fillRect(0, 0, W, H);
                vctx.globalCompositeOperation = 'destination-out';
                vctx.drawImage(caches.combLeft, 0, 0);
                ctx.drawImage(vz, 0, 0);
            }
            return;
        }

        // config | logos | final → composito dei loghi
        var withMasks = previewMode !== 'logos';
        if (withMasks) ensureAllMasks(); else ensureShade();
        if (renderer && resultCanvas) {
            renderer.render(resultCtx, buildModel(withMasks));
            ctx.drawImage(resultCanvas, 0, 0);
        }
    }

    function drawCenteredNote(ctx, text) {
        ctx.fillStyle = 'rgba(15,23,42,0.75)';
        ctx.fillRect(W / 2 - 460, H / 2 - 42, 920, 84);
        ctx.fillStyle = '#fbbf24';
        ctx.font = '34px Oswald, sans-serif';
        ctx.textAlign = 'center';
        ctx.fillText(text, W / 2, H / 2 + 12);
    }

    // ------------------------------------------------------------
    // RENDER EDITOR (maniglie, contorni, disegno in corso)
    // ------------------------------------------------------------
    function renderEditor() {
        if (!editor) return;
        var ctx = editorCtx;
        ctx.setTransform(1, 0, 0, 1, 0, 0);
        ctx.clearRect(0, 0, editor.width, editor.height);
        if (previewMode === 'final' || previewMode === 'screenshot' || previewMode === 'green') return;

        var showQuads = previewMode === 'config' || previewMode === 'logos';
        var showObjects = previewMode === 'config' || previewMode === 'excl';

        if (showObjects) {
            doc.objects.forEach(function (o) {
                if (o.visible === false) return;
                drawObjectOutline(ctx, o, o.id === selectedId);
            });
        }
        if (showQuads) {
            if (doc.showLeft && doc.left.visible) drawQuad(ctx, 'left');
            if (doc.showRight && doc.right.visible) drawQuad(ctx, 'right');
        }
        if (drawing) drawInProgress(ctx);

        // cursore del pennello
        if ((tool === 'brush' || tool === 'eraser') && pointerPos && !drawing) {
            var sp = toScreen(pointerPos);
            var r = brushOpts.radius * view.scale;
            ctx.beginPath();
            ctx.arc(sp.x, sp.y, r, 0, Math.PI * 2);
            ctx.strokeStyle = tool === 'eraser' ? '#4ade80' : '#f87171';
            ctx.lineWidth = 1.5;
            ctx.stroke();
        }

        // mirini dei campioni green
        if (tool === 'sample') {
            doc.green.samples.forEach(function (s) {
                if (typeof s.x !== 'number') return;
                var sp = toScreen(s);
                ctx.beginPath();
                ctx.arc(sp.x, sp.y, 6, 0, Math.PI * 2);
                ctx.strokeStyle = '#fff';
                ctx.lineWidth = 2;
                ctx.stroke();
                ctx.beginPath();
                ctx.arc(sp.x, sp.y, 8, 0, Math.PI * 2);
                ctx.strokeStyle = 'rgba(0,0,0,0.6)';
                ctx.lineWidth = 1;
                ctx.stroke();
            });
        }
    }

    function objectScreenPath(o) {
        // Path2D in coordinate schermo (per disegno contorni)
        var path = new Path2D();
        var m = new DOMMatrix([view.scale, 0, 0, view.scale, view.x, view.y]);
        path.addPath(Core.objectPath(o), m);
        return path;
    }

    function drawObjectOutline(ctx, o, isSel) {
        var isRestore = o.mode === 'restore';
        var stroke = isSel ? '#22d3ee' : (isRestore ? 'rgba(74,222,128,0.9)' : 'rgba(248,113,113,0.9)');
        var fill = isRestore ? 'rgba(74,222,128,0.18)' : 'rgba(239,68,68,0.2)';
        var path = objectScreenPath(o);
        if (o.type === 'brush') {
            ctx.save();
            ctx.lineWidth = (o.brush.radius * 2 + (o.mode !== 'restore' ? doc.margin * 2 : 0)) * view.scale;
            ctx.lineCap = 'round';
            ctx.lineJoin = 'round';
            ctx.strokeStyle = fill;
            if (o.points.length === 1) {
                var sp = toScreen(o.points[0]);
                ctx.beginPath();
                ctx.arc(sp.x, sp.y, ctx.lineWidth / 2, 0, Math.PI * 2);
                ctx.fillStyle = fill;
                ctx.fill();
            } else {
                ctx.stroke(path);
            }
            if (isSel) {
                ctx.lineWidth = 1.5;
                ctx.strokeStyle = stroke;
                ctx.setLineDash([5, 4]);
                ctx.stroke(path);
                ctx.setLineDash([]);
            }
            ctx.restore();
        } else {
            ctx.fillStyle = fill;
            ctx.fill(path, 'evenodd');
            ctx.lineWidth = isSel ? 2 : 1.3;
            ctx.strokeStyle = stroke;
            ctx.stroke(path);
        }
        if (isSel && !o.locked) drawSelectionHandles(ctx, o);
        if (o.enabled === false) {
            var b = objectBBox(o);
            var c = toScreen({ x: (b.x0 + b.x1) / 2, y: (b.y0 + b.y1) / 2 });
            ctx.fillStyle = '#94a3b8';
            ctx.font = '12px sans-serif';
            ctx.textAlign = 'center';
            ctx.fillText('(disattivato)', c.x, c.y);
        }
    }

    function handleRect(ctx, sx, sy, size, color) {
        ctx.fillStyle = color || '#fff';
        ctx.strokeStyle = '#0f172a';
        ctx.lineWidth = 1;
        ctx.fillRect(sx - size / 2, sy - size / 2, size, size);
        ctx.strokeRect(sx - size / 2, sy - size / 2, size, size);
    }

    function handleDot(ctx, sx, sy, r, color) {
        ctx.beginPath();
        ctx.arc(sx, sy, r, 0, Math.PI * 2);
        ctx.fillStyle = color;
        ctx.fill();
        ctx.strokeStyle = '#0f172a';
        ctx.lineWidth = 1;
        ctx.stroke();
    }

    function drawSelectionHandles(ctx, o) {
        var i, sp;
        if (o.type === 'rect' || o.type === 'ellipse') {
            var corners = rectCorners(o.rect);
            for (i = 0; i < 4; i++) {
                sp = toScreen(corners[i]);
                handleRect(ctx, sp.x, sp.y, 9, '#22d3ee');
            }
            var mids = rectMidpoints(o.rect);
            for (i = 0; i < 4; i++) {
                sp = toScreen(mids[i]);
                handleRect(ctx, sp.x, sp.y, 7, '#e2e8f0');
            }
            var rp = rectRotHandle(o.rect);
            sp = toScreen(rp);
            var top = toScreen(mids[0]);
            ctx.beginPath();
            ctx.moveTo(top.x, top.y);
            ctx.lineTo(sp.x, sp.y);
            ctx.strokeStyle = '#22d3ee';
            ctx.lineWidth = 1;
            ctx.stroke();
            handleDot(ctx, sp.x, sp.y, 6, '#fbbf24');
        } else if (o.type === 'polygon' || o.type === 'lasso') {
            var pts = o.points;
            for (i = 0; i < pts.length; i++) {
                var mid = {
                    x: (pts[i].x + pts[(i + 1) % pts.length].x) / 2,
                    y: (pts[i].y + pts[(i + 1) % pts.length].y) / 2
                };
                sp = toScreen(mid);
                handleDot(ctx, sp.x, sp.y, 4, 'rgba(226,232,240,0.85)');
            }
            for (i = 0; i < pts.length; i++) {
                sp = toScreen(pts[i]);
                handleRect(ctx, sp.x, sp.y, 8, i === selectedVertex ? '#fbbf24' : '#22d3ee');
            }
        } else if (o.type === 'brush') {
            // il pennello si sposta come oggetto intero: mostra solo il bbox
            var b = objectBBox(o);
            var p0 = toScreen({ x: b.x0, y: b.y0 });
            var p1 = toScreen({ x: b.x1, y: b.y1 });
            ctx.strokeStyle = '#22d3ee';
            ctx.setLineDash([4, 4]);
            ctx.lineWidth = 1;
            ctx.strokeRect(p0.x, p0.y, p1.x - p0.x, p1.y - p0.y);
            ctx.setLineDash([]);
        }
    }

    function drawQuad(ctx, side) {
        var q = effectiveQuad(side);
        var valid = Core.validateQuad(Core.scaledQuad(q, 1)).ok;
        var color = valid ? (side === 'left' ? '#38bdf8' : '#fb923c') : '#ef4444';
        ctx.beginPath();
        var s0 = toScreen(q[0]);
        ctx.moveTo(s0.x, s0.y);
        for (var i = 1; i < 4; i++) {
            var sp = toScreen(q[i]);
            ctx.lineTo(sp.x, sp.y);
        }
        ctx.closePath();
        ctx.strokeStyle = color;
        ctx.lineWidth = 1.6;
        ctx.setLineDash([7, 5]);
        ctx.stroke();
        ctx.setLineDash([]);
        var labels = ['↖', '↗', '↘', '↙'];
        for (i = 0; i < 4; i++) {
            var h = toScreen(q[i]);
            handleDot(ctx, h.x, h.y, 7, color);
            ctx.fillStyle = '#0f172a';
            ctx.font = '9px sans-serif';
            ctx.textAlign = 'center';
            ctx.textBaseline = 'middle';
            ctx.fillText(labels[i], h.x, h.y);
            ctx.textBaseline = 'alphabetic';
        }
        var c = toScreen(quadCentroid(q));
        ctx.fillStyle = color;
        ctx.font = 'bold 12px Oswald, sans-serif';
        ctx.textAlign = 'center';
        ctx.fillText(side === 'left' ? 'LOGO SX' : 'LOGO DX', c.x, c.y - 8);
        if (!valid) {
            ctx.fillStyle = '#ef4444';
            ctx.fillText('PROSPETTIVA NON VALIDA', c.x, c.y + 12);
        }
    }

    function drawInProgress(ctx) {
        var i, sp;
        if (drawing.type === 'polygon') {
            ctx.beginPath();
            for (i = 0; i < drawing.points.length; i++) {
                sp = toScreen(drawing.points[i]);
                if (i === 0) ctx.moveTo(sp.x, sp.y); else ctx.lineTo(sp.x, sp.y);
            }
            if (pointerPos) {
                sp = toScreen(pointerPos);
                ctx.lineTo(sp.x, sp.y);
            }
            ctx.strokeStyle = '#f87171';
            ctx.lineWidth = 1.6;
            ctx.stroke();
            for (i = 0; i < drawing.points.length; i++) {
                sp = toScreen(drawing.points[i]);
                handleRect(ctx, sp.x, sp.y, 8, i === 0 ? '#fbbf24' : '#f87171');
            }
        } else if (drawing.type === 'lasso' || drawing.type === 'brush' || drawing.type === 'eraser') {
            if (drawing.points.length > 1) {
                ctx.beginPath();
                for (i = 0; i < drawing.points.length; i++) {
                    sp = toScreen(drawing.points[i]);
                    if (i === 0) ctx.moveTo(sp.x, sp.y); else ctx.lineTo(sp.x, sp.y);
                }
                if (drawing.type === 'lasso') {
                    ctx.strokeStyle = '#f87171';
                    ctx.lineWidth = 1.6;
                    ctx.stroke();
                } else {
                    ctx.lineCap = 'round';
                    ctx.lineJoin = 'round';
                    ctx.lineWidth = drawing.radius * 2 * view.scale;
                    ctx.strokeStyle = drawing.type === 'eraser'
                        ? 'rgba(74,222,128,' + brushOpts.previewAlpha + ')'
                        : 'rgba(239,68,68,' + brushOpts.previewAlpha + ')';
                    ctx.stroke();
                }
            }
        } else if (drawing.type === 'rect' || drawing.type === 'ellipse') {
            var r = dragShapeRect();
            var p0 = toScreen({ x: r.cx - r.w / 2, y: r.cy - r.h / 2 });
            ctx.strokeStyle = '#f87171';
            ctx.fillStyle = 'rgba(239,68,68,0.15)';
            ctx.lineWidth = 1.6;
            if (drawing.type === 'rect') {
                ctx.fillRect(p0.x, p0.y, r.w * view.scale, r.h * view.scale);
                ctx.strokeRect(p0.x, p0.y, r.w * view.scale, r.h * view.scale);
            } else {
                ctx.beginPath();
                var cs = toScreen({ x: r.cx, y: r.cy });
                ctx.ellipse(cs.x, cs.y, r.w / 2 * view.scale, r.h / 2 * view.scale, 0, 0, Math.PI * 2);
                ctx.fill();
                ctx.stroke();
            }
        }
    }

    // ------------------------------------------------------------
    // GEOMETRIA OGGETTI (bbox, maniglie rect, hit-test)
    // ------------------------------------------------------------
    function objectBBox(o) {
        var x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
        var pts = o.points;
        if (o.type === 'rect' || o.type === 'ellipse') pts = rectCorners(o.rect);
        var pad = o.type === 'brush' ? o.brush.radius : 0;
        pts.forEach(function (p) {
            if (p.x - pad < x0) x0 = p.x - pad;
            if (p.y - pad < y0) y0 = p.y - pad;
            if (p.x + pad > x1) x1 = p.x + pad;
            if (p.y + pad > y1) y1 = p.y + pad;
        });
        return { x0: x0, y0: y0, x1: x1, y1: y1 };
    }

    function rectCorners(r) {
        var cos = Math.cos(r.rot || 0), sin = Math.sin(r.rot || 0);
        function pt(dx, dy) {
            return { x: r.cx + dx * cos - dy * sin, y: r.cy + dx * sin + dy * cos };
        }
        return [pt(-r.w / 2, -r.h / 2), pt(r.w / 2, -r.h / 2), pt(r.w / 2, r.h / 2), pt(-r.w / 2, r.h / 2)];
    }

    function rectMidpoints(r) {
        var c = rectCorners(r);
        function mid(a, b) { return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }; }
        return [mid(c[0], c[1]), mid(c[1], c[2]), mid(c[2], c[3]), mid(c[3], c[0])];
    }

    function rectRotHandle(r) {
        var mids = rectMidpoints(r);
        var top = mids[0];
        var dx = top.x - r.cx, dy = top.y - r.cy;
        var len = Math.max(1, Math.hypot(dx, dy));
        var off = 28 / view.scale;
        return { x: top.x + dx / len * off, y: top.y + dy / len * off };
    }

    var hitCtx = Core.makeCanvas(1, 1).getContext('2d');

    function hitObject(p) {
        // dall'ultimo (prevale) al primo
        for (var i = doc.objects.length - 1; i >= 0; i--) {
            var o = doc.objects[i];
            if (o.visible === false) continue;
            var path = Core.objectPath(o);
            if (o.type === 'brush') {
                hitCtx.lineWidth = o.brush.radius * 2;
                hitCtx.lineCap = 'round';
                hitCtx.lineJoin = 'round';
                if (o.points.length === 1) {
                    if (Math.hypot(p.x - o.points[0].x, p.y - o.points[0].y) <= o.brush.radius) return o;
                } else if (hitCtx.isPointInStroke(path, p.x, p.y)) return o;
            } else if (hitCtx.isPointInPath(path, p.x, p.y)) {
                return o;
            }
        }
        return null;
    }

    function pointInQuad(p, q) {
        var path = new Path2D();
        path.moveTo(q[0].x, q[0].y);
        for (var i = 1; i < 4; i++) path.lineTo(q[i].x, q[i].y);
        path.closePath();
        return hitCtx.isPointInPath(path, p.x, p.y);
    }

    function getSelected() {
        if (!selectedId) return null;
        for (var i = 0; i < doc.objects.length; i++) {
            if (doc.objects[i].id === selectedId) return doc.objects[i];
        }
        return null;
    }

    // ------------------------------------------------------------
    // STRUMENTI — opzioni correnti
    // ------------------------------------------------------------
    var brushOpts = { radius: 30, hardness: 0.75, previewAlpha: 0.5, stabilize: 0.35 };
    var lassoOpts = { minDist: 3, simplify: 2.5, smooth: 1 };

    var TOOLS = [
        { id: 'select', icon: '⬚', label: 'Selezione (V) — clicca un oggetto, trascina maniglie e angoli' },
        { id: 'polygon', icon: '⬠', label: 'Poligono (P) — clic per aggiungere angoli, clic sul primo punto/Invio per chiudere' },
        { id: 'lasso', icon: '➰', label: 'Lazo libero (L) — tieni premuto e disegna intorno al gonfiabile' },
        { id: 'rect', icon: '▭', label: 'Rettangolo (R) — clicca e trascina' },
        { id: 'ellipse', icon: '◯', label: 'Ellisse (E) — clicca e trascina' },
        { id: 'brush', icon: '🖌', label: 'Pennello esclusione (B) — colora dove il logo NON deve comparire' },
        { id: 'eraser', icon: '🧽', label: 'Ripristina area / Gomma (G) — riporta disponibile una zona esclusa' },
        { id: 'sep' },
        { id: 'sample', icon: '💧', label: 'Campiona green — clicca più punti del prato' },
        { id: 'sep' },
        { id: 'hand', icon: '✋', label: 'Mano (H o barra spazio) — sposta la visuale' },
        { id: 'zoom', icon: '🔍', label: 'Zoom (Z) — clic avvicina, Alt+clic allontana, rotella sempre attiva' }
    ];

    function setTool(id) {
        if (drawing) cancelDrawing();
        tool = id;
        document.querySelectorAll('.flg-tool').forEach(function (b) {
            b.classList.toggle('active', b.dataset.tool === id);
        });
        var cursors = {
            select: 'default', polygon: 'crosshair', lasso: 'crosshair', rect: 'crosshair',
            ellipse: 'crosshair', brush: 'none', eraser: 'none', sample: 'crosshair',
            hand: 'grab', zoom: 'zoom-in'
        };
        editor.style.cursor = cursors[id] || 'default';
        updateToolOptions();
        updateHint();
        requestRender();
    }

    function updateHint() {
        var hints = {
            select: 'Clicca un oggetto per selezionarlo. Trascina gli angoli, le maniglie intermedie (aggiungono un angolo) o l\'intera forma. Doppio clic su un angolo lo elimina.',
            polygon: 'Clicca intorno al gonfiabile per aggiungere angoli. Chiudi cliccando sul primo punto, con doppio clic o Invio. Esc annulla, Backspace rimuove l\'ultimo punto.',
            lasso: 'Tieni premuto il mouse e disegna intorno alla sagoma: al rilascio la forma si chiude da sola e resta modificabile.',
            rect: 'Clicca e trascina per creare la zona rettangolare. Shift = quadrato.',
            ellipse: 'Clicca e trascina per creare la zona ellittica. Shift = cerchio.',
            brush: 'Colora le zone dove il logo non deve comparire. Regola dimensione e durezza qui sopra.',
            eraser: 'Trascina sulla zona esclusa per errore: torna disponibile solo la parte attraversata.',
            sample: 'Clicca più punti del prato (sole, ombra, zone chiare e scure): ogni clic aggiunge un campione di colore.',
            hand: 'Trascina per spostare la visuale. Scorciatoia: tieni premuta la barra spaziatrice.',
            zoom: 'Clic = zoom avanti, Alt+clic = zoom indietro. La rotella del mouse funziona con qualsiasi strumento.'
        };
        $('flg-hint').textContent = hints[tool] || '';
    }

    function updateToolOptions() {
        var elOpt = $('flg-tooloptions');
        var html = '';
        if (tool === 'polygon') {
            html = '<button class="flg-btn" id="flg-poly-undo">↩ Annulla ultimo punto</button>' +
                '<button class="flg-btn accent" id="flg-poly-close">✔ Completa forma</button>' +
                '<button class="flg-btn danger" id="flg-poly-cancel">✕ Annulla disegno</button>';
        } else if (tool === 'lasso') {
            html = optSlider('Precisione', 'flg-lasso-prec', 1, 10, 1, 11 - lassoOpts.minDist) +
                optSlider('Semplificazione', 'flg-lasso-simp', 0, 10, 0.5, lassoOpts.simplify) +
                optSlider('Morbidezza', 'flg-lasso-smooth', 0, 3, 1, lassoOpts.smooth);
        } else if (tool === 'brush' || tool === 'eraser') {
            html = optSlider('Dimensione', 'flg-brush-size', 2, 150, 1, brushOpts.radius) +
                optSlider('Durezza', 'flg-brush-hard', 0, 100, 1, Math.round(brushOpts.hardness * 100)) +
                optSlider('Opacità preview', 'flg-brush-alpha', 10, 100, 1, Math.round(brushOpts.previewAlpha * 100)) +
                optSlider('Stabilizzazione', 'flg-brush-stab', 0, 90, 1, Math.round(brushOpts.stabilize * 100));
        } else if (tool === 'sample') {
            html = '<span>Campioni: <b id="flg-sample-count">' + doc.green.samples.length + '</b></span>' +
                '<button class="flg-btn danger" id="flg-sample-clear">🗑 Svuota campioni</button>';
        }
        elOpt.innerHTML = html;
        elOpt.classList.toggle('visible', !!html);

        if (tool === 'polygon') {
            $('flg-poly-undo').onclick = polyUndoPoint;
            $('flg-poly-close').onclick = polyClose;
            $('flg-poly-cancel').onclick = cancelDrawing;
        } else if (tool === 'lasso') {
            bindOpt('flg-lasso-prec', function (v) { lassoOpts.minDist = 11 - v; });
            bindOpt('flg-lasso-simp', function (v) { lassoOpts.simplify = v; });
            bindOpt('flg-lasso-smooth', function (v) { lassoOpts.smooth = v; });
        } else if (tool === 'brush' || tool === 'eraser') {
            bindOpt('flg-brush-size', function (v) { brushOpts.radius = v; requestRender(); });
            bindOpt('flg-brush-hard', function (v) { brushOpts.hardness = v / 100; });
            bindOpt('flg-brush-alpha', function (v) { brushOpts.previewAlpha = v / 100; });
            bindOpt('flg-brush-stab', function (v) { brushOpts.stabilize = v / 100; });
        } else if (tool === 'sample') {
            $('flg-sample-clear').onclick = function () {
                var pre = snap();
                doc.green.samples = [];
                commit(pre, { green: true, excl: true });
                refreshGreenPanel();
                updateToolOptions();
            };
        }
    }

    function optSlider(label, id, min, max, step, val) {
        return '<label>' + label + ' <input type="range" id="' + id + '" min="' + min +
            '" max="' + max + '" step="' + step + '" value="' + val + '"></label>';
    }

    function bindOpt(id, fn) {
        var el = $(id);
        if (el) el.addEventListener('input', function () { fn(parseFloat(el.value)); });
    }

    // ------------------------------------------------------------
    // DISEGNO: poligono, lazo, forme, pennello
    // ------------------------------------------------------------
    function cancelDrawing() {
        drawing = null;
        setStatus('Disegno annullato', '');
        requestRender();
    }

    function polyUndoPoint() {
        if (!drawing || drawing.type !== 'polygon') return;
        drawing.points.pop();
        if (!drawing.points.length) drawing = null;
        requestRender();
    }

    function polyClose() {
        if (!drawing || drawing.type !== 'polygon') return;
        if (drawing.points.length < 3) {
            setStatus('Un poligono ha bisogno di almeno 3 angoli', 'warn');
            return;
        }
        var pre = snap();
        var obj = {
            id: 'obj' + (objSeq++),
            type: 'polygon',
            name: 'Poligono ' + countType('polygon'),
            mode: 'exclude', target: 'both',
            visible: true, enabled: true, locked: false,
            points: drawing.points
        };
        doc.objects.push(obj);
        drawing = null;
        selectedId = obj.id;
        selectedVertex = -1;
        commit(pre, { excl: true });
        refreshObjectsPanel();
        setStatus('Poligono creato (' + obj.points.length + ' angoli)', 'ok');
    }

    function countType(t) {
        return doc.objects.filter(function (o) { return o.type === t; }).length + 1;
    }

    function finishLasso() {
        var pts = drawing.points;
        drawing = null;
        if (pts.length < 3) { setStatus('Tracciato troppo breve', 'warn'); requestRender(); return; }
        // semplificazione (Douglas-Peucker) senza alterare visibilmente il contorno
        var simplified = lassoOpts.simplify > 0 ? simplifyPath(pts, lassoOpts.simplify) : pts.slice();
        for (var s = 0; s < lassoOpts.smooth; s++) simplified = chaikin(simplified);
        if (simplified.length > 600) simplified = simplifyPath(simplified, lassoOpts.simplify + 1);
        if (simplified.length < 3) { setStatus('Tracciato troppo breve', 'warn'); requestRender(); return; }
        var pre = snap();
        var obj = {
            id: 'obj' + (objSeq++),
            type: 'lasso',
            name: 'Lazo ' + countType('lasso'),
            mode: 'exclude', target: 'both',
            visible: true, enabled: true, locked: false,
            points: simplified
        };
        doc.objects.push(obj);
        selectedId = obj.id;
        selectedVertex = -1;
        commit(pre, { excl: true });
        refreshObjectsPanel();
        setStatus('Lazo creato (' + obj.points.length + ' punti, modificabile con Selezione)', 'ok');
    }

    function dragShapeRect() {
        var a = drawing.start, b = pointerPos || drawing.start;
        var w = Math.abs(b.x - a.x), h = Math.abs(b.y - a.y);
        if (drawing.shift) { w = h = Math.max(w, h); }
        var cx = a.x + (b.x >= a.x ? w / 2 : -w / 2);
        var cy = a.y + (b.y >= a.y ? h / 2 : -h / 2);
        return { cx: cx, cy: cy, w: Math.max(4, w), h: Math.max(4, h) };
    }

    function finishShape() {
        var r = dragShapeRect();
        var type = drawing.type;
        drawing = null;
        if (r.w < 8 && r.h < 8) { requestRender(); return; }
        var pre = snap();
        var obj = {
            id: 'obj' + (objSeq++),
            type: type,
            name: (type === 'rect' ? 'Rettangolo ' : 'Ellisse ') + countType(type),
            mode: 'exclude', target: 'both',
            visible: true, enabled: true, locked: false,
            rect: { cx: r.cx, cy: r.cy, w: r.w, h: r.h, rot: 0 }
        };
        doc.objects.push(obj);
        selectedId = obj.id;
        commit(pre, { excl: true });
        refreshObjectsPanel();
        setStatus((type === 'rect' ? 'Rettangolo' : 'Ellisse') + ' creato', 'ok');
    }

    function finishBrush() {
        var d = drawing;
        drawing = null;
        if (!d.points.length) { requestRender(); return; }
        var pre = snap();
        var isEraser = d.type === 'eraser';
        var obj = {
            id: 'obj' + (objSeq++),
            type: 'brush',
            name: (isEraser ? 'Ripristino ' : 'Pennellata ') + countType('brush'),
            mode: isEraser ? 'restore' : 'exclude',
            target: 'both',
            visible: true, enabled: true, locked: false,
            points: simplifyPath(d.points, 1.2),
            brush: { radius: d.radius, hardness: d.hardness }
        };
        doc.objects.push(obj);
        selectedId = obj.id;
        commit(pre, { excl: true });
        refreshObjectsPanel();
        setStatus(isEraser ? 'Area ripristinata' : 'Esclusione dipinta', 'ok');
    }

    // Douglas-Peucker
    function simplifyPath(pts, tolerance) {
        if (pts.length < 3) return pts.slice();
        var keep = new Array(pts.length);
        keep[0] = keep[pts.length - 1] = true;
        var stack = [[0, pts.length - 1]];
        while (stack.length) {
            var seg = stack.pop();
            var a = seg[0], b = seg[1];
            var maxD = 0, maxI = -1;
            var A = pts[a], B = pts[b];
            var dx = B.x - A.x, dy = B.y - A.y;
            var len2 = dx * dx + dy * dy;
            for (var i = a + 1; i < b; i++) {
                var t = len2 ? ((pts[i].x - A.x) * dx + (pts[i].y - A.y) * dy) / len2 : 0;
                t = clamp(t, 0, 1);
                var px = A.x + t * dx, py = A.y + t * dy;
                var dist = Math.hypot(pts[i].x - px, pts[i].y - py);
                if (dist > maxD) { maxD = dist; maxI = i; }
            }
            if (maxD > tolerance && maxI > 0) {
                keep[maxI] = true;
                stack.push([a, maxI], [maxI, b]);
            }
        }
        return pts.filter(function (_, i) { return keep[i]; });
    }

    // Chaikin: arrotonda gli angoli del lazo
    function chaikin(pts) {
        if (pts.length < 3) return pts.slice();
        var out = [];
        for (var i = 0; i < pts.length; i++) {
            var a = pts[i], b = pts[(i + 1) % pts.length];
            out.push({ x: a.x * 0.75 + b.x * 0.25, y: a.y * 0.75 + b.y * 0.25 });
            out.push({ x: a.x * 0.25 + b.x * 0.75, y: a.y * 0.25 + b.y * 0.75 });
        }
        return out;
    }

    // ------------------------------------------------------------
    // POINTER EVENTS
    // ------------------------------------------------------------
    function bindPointerEvents() {
        editor.addEventListener('pointerdown', onPointerDown);
        editor.addEventListener('pointermove', onPointerMove);
        editor.addEventListener('pointerup', onPointerUp);
        editor.addEventListener('pointercancel', onPointerUp);
        editor.addEventListener('dblclick', onDblClick);
        editor.addEventListener('wheel', onWheel, { passive: false });
        editor.addEventListener('contextmenu', function (e) { e.preventDefault(); });
    }

    function onWheel(e) {
        e.preventDefault();
        var factor = e.deltaY < 0 ? 1.12 : 1 / 1.12;
        setZoom(view.scale * factor, { x: e.clientX, y: e.clientY });
    }

    function onPointerDown(e) {
        if (e.button === 2) return;
        try { editor.setPointerCapture(e.pointerId); } catch (err) { /* eventi sintetici/penna */ }
        var p = toLogical(e);
        pointerPos = p;

        // pan: strumento mano, barra spazio o tasto centrale
        if (tool === 'hand' || spaceDown || e.button === 1) {
            dragCtx = { kind: 'pan', startX: e.clientX, startY: e.clientY, ox: view.x, oy: view.y };
            editor.style.cursor = 'grabbing';
            return;
        }

        if (tool === 'zoom') {
            setZoom(view.scale * (e.altKey ? 1 / 1.4 : 1.4), { x: e.clientX, y: e.clientY });
            return;
        }

        if (tool === 'sample') { addGreenSample(p); return; }

        if (tool === 'polygon') {
            if (!drawing) drawing = { type: 'polygon', points: [] };
            // clic sul primo punto → chiusura
            if (drawing.points.length >= 3 && screenDist(p, drawing.points[0]) < 12) {
                polyClose();
                return;
            }
            drawing.points.push(p);
            requestRender();
            return;
        }

        if (tool === 'lasso') {
            drawing = { type: 'lasso', points: [p] };
            return;
        }

        if (tool === 'rect' || tool === 'ellipse') {
            drawing = { type: tool, start: p, shift: e.shiftKey };
            return;
        }

        if (tool === 'brush' || tool === 'eraser') {
            drawing = {
                type: tool, points: [p],
                radius: brushOpts.radius, hardness: brushOpts.hardness,
                smoothed: p
            };
            requestRender();
            return;
        }

        // ---- SELEZIONE ----
        var showQuads = previewMode === 'config' || previewMode === 'logos';

        // 1. maniglie corner pin dei loghi
        if (showQuads) {
            var sides = ['left', 'right'];
            for (var s = 0; s < 2; s++) {
                var side = sides[s];
                if (!(side === 'left' ? doc.showLeft && doc.left.visible : doc.showRight && doc.right.visible)) continue;
                var q = effectiveQuad(side);
                for (var i = 0; i < 4; i++) {
                    if (screenDist(p, q[i]) < 11) {
                        dragCtx = { kind: 'quad-corner', side: side, idx: i, pre: snap() };
                        return;
                    }
                }
            }
        }

        // 2. maniglie dell'oggetto selezionato
        var sel = getSelected();
        if (sel && !sel.locked && startHandleDrag(sel, p)) return;

        // 3. oggetti (l'ultimo disegnato prevale)
        var hit = hitObject(p);
        if (hit) {
            if (selectedId !== hit.id) {
                selectedId = hit.id;
                selectedVertex = -1;
                refreshObjectsPanel();
                requestRender();
            }
            if (!hit.locked) {
                dragCtx = { kind: 'move-object', id: hit.id, start: p, pre: snap(), moved: false };
            }
            return;
        }

        // 4. interno del quad → sposta l'intero logo
        if (showQuads) {
            for (s = 0; s < 2; s++) {
                side = sides[s];
                if (!(side === 'left' ? doc.showLeft && doc.left.visible : doc.showRight && doc.right.visible)) continue;
                if (pointInQuad(p, effectiveQuad(side))) {
                    dragCtx = { kind: 'quad-move', side: side, start: p, pre: snap() };
                    return;
                }
            }
        }

        // 5. vuoto → deseleziona
        if (selectedId) {
            selectedId = null;
            selectedVertex = -1;
            refreshObjectsPanel();
            requestRender();
        }
    }

    function startHandleDrag(sel, p) {
        var i;
        if (sel.type === 'polygon' || sel.type === 'lasso') {
            for (i = 0; i < sel.points.length; i++) {
                if (screenDist(p, sel.points[i]) < 10) {
                    selectedVertex = i;
                    dragCtx = { kind: 'vertex', idx: i, pre: snap() };
                    requestRender();
                    return true;
                }
            }
            // maniglia intermedia → inserisce un nuovo angolo e lo trascina
            for (i = 0; i < sel.points.length; i++) {
                var nxt = (i + 1) % sel.points.length;
                var mid = { x: (sel.points[i].x + sel.points[nxt].x) / 2, y: (sel.points[i].y + sel.points[nxt].y) / 2 };
                if (screenDist(p, mid) < 8) {
                    var pre = snap();
                    sel.points.splice(nxt, 0, { x: mid.x, y: mid.y });
                    selectedVertex = nxt;
                    dragCtx = { kind: 'vertex', idx: nxt, pre: pre };
                    requestRender();
                    return true;
                }
            }
        } else if (sel.type === 'rect' || sel.type === 'ellipse') {
            var rp = rectRotHandle(sel.rect);
            if (screenDist(p, rp) < 10) {
                dragCtx = { kind: 'rect-rotate', pre: snap(), startAngle: Math.atan2(p.y - sel.rect.cy, p.x - sel.rect.cx), origRot: sel.rect.rot || 0 };
                return true;
            }
            var corners = rectCorners(sel.rect);
            for (i = 0; i < 4; i++) {
                if (screenDist(p, corners[i]) < 10) {
                    dragCtx = { kind: 'rect-corner', idx: i, pre: snap() };
                    return true;
                }
            }
            var mids = rectMidpoints(sel.rect);
            for (i = 0; i < 4; i++) {
                if (screenDist(p, mids[i]) < 9) {
                    dragCtx = { kind: 'rect-side', idx: i, pre: snap() };
                    return true;
                }
            }
        }
        return false;
    }

    function onPointerMove(e) {
        var p = toLogical(e);
        pointerPos = p;

        if (dragCtx) {
            handleDrag(p, e);
            return;
        }

        if (drawing) {
            if (drawing.type === 'lasso') {
                var last = drawing.points[drawing.points.length - 1];
                if (Math.hypot(p.x - last.x, p.y - last.y) * view.scale >= lassoOpts.minDist) {
                    drawing.points.push(p);
                }
                requestRender();
            } else if (drawing.type === 'brush' || drawing.type === 'eraser') {
                // stabilizzazione: media mobile esponenziale del puntatore
                var k = 1 - brushOpts.stabilize;
                drawing.smoothed = {
                    x: drawing.smoothed.x + (p.x - drawing.smoothed.x) * k,
                    y: drawing.smoothed.y + (p.y - drawing.smoothed.y) * k
                };
                var lastB = drawing.points[drawing.points.length - 1];
                if (Math.hypot(drawing.smoothed.x - lastB.x, drawing.smoothed.y - lastB.y) > 1.5) {
                    drawing.points.push({ x: drawing.smoothed.x, y: drawing.smoothed.y });
                }
                requestRender();
            } else {
                requestRender(); // preview poligono/forme
            }
            return;
        }

        if (tool === 'brush' || tool === 'eraser' || tool === 'polygon') requestRender();
    }

    function handleDrag(p, e) {
        var sel = getSelected();
        switch (dragCtx.kind) {
            case 'pan': {
                var dpr = global.devicePixelRatio || 1;
                view.x = dragCtx.ox + (e.clientX - dragCtx.startX) * dpr;
                view.y = dragCtx.oy + (e.clientY - dragCtx.startY) * dpr;
                requestRender();
                break;
            }
            case 'quad-corner': {
                var base = effectiveToBase(dragCtx.side, p);
                doc[dragCtx.side].quad[dragCtx.idx] = base;
                requestRender();
                break;
            }
            case 'quad-move': {
                // Trasla i 4 punti base, non dx/dy: gli slider "Posizione" restano
                // l'unico proprietario di quel campo, altrimenti un trascinamento
                // farebbe saltare i cursori a un valore che l'utente non ha scelto.
                var q = doc[dragCtx.side].quad;
                var mdx = p.x - dragCtx.start.x, mdy = p.y - dragCtx.start.y;
                for (var qi = 0; qi < 4; qi++) { q[qi].x += mdx; q[qi].y += mdy; }
                dragCtx.start = p;
                requestRender();
                break;
            }
            case 'vertex': {
                if (sel) {
                    sel.points[dragCtx.idx] = { x: p.x, y: p.y };
                    requestRender();
                }
                break;
            }
            case 'move-object': {
                if (sel) {
                    var dx = p.x - dragCtx.start.x, dy = p.y - dragCtx.start.y;
                    if (dx || dy) dragCtx.moved = true;
                    translateObject(sel, dx, dy);
                    dragCtx.start = p;
                    requestRender();
                }
                break;
            }
            case 'rect-rotate': {
                if (sel) {
                    var ang = Math.atan2(p.y - sel.rect.cy, p.x - sel.rect.cx);
                    sel.rect.rot = dragCtx.origRot + (ang - dragCtx.startAngle);
                    requestRender();
                }
                break;
            }
            case 'rect-corner': {
                if (sel) resizeRectByCorner(sel.rect, dragCtx.idx, p, e.shiftKey);
                requestRender();
                break;
            }
            case 'rect-side': {
                if (sel) resizeRectBySide(sel.rect, dragCtx.idx, p);
                requestRender();
                break;
            }
        }
    }

    function translateObject(o, dx, dy) {
        if (o.type === 'rect' || o.type === 'ellipse') {
            o.rect.cx += dx; o.rect.cy += dy;
        } else {
            o.points.forEach(function (pt) { pt.x += dx; pt.y += dy; });
        }
    }

    function resizeRectByCorner(r, idx, p, keepAspect) {
        // porta il punto nel sistema locale del rettangolo
        var cos = Math.cos(-(r.rot || 0)), sin = Math.sin(-(r.rot || 0));
        var lx = (p.x - r.cx) * cos - (p.y - r.cy) * sin;
        var ly = (p.x - r.cx) * sin + (p.y - r.cy) * cos;
        // l'angolo opposto resta fermo
        var sx = idx === 0 || idx === 3 ? -1 : 1;
        var sy = idx === 0 || idx === 1 ? -1 : 1;
        var fixedX = -sx * r.w / 2, fixedY = -sy * r.h / 2;
        var newW = Math.max(6, Math.abs(lx - fixedX));
        var newH = Math.max(6, Math.abs(ly - fixedY));
        if (keepAspect) {
            var k = Math.max(newW / r.w, newH / r.h);
            newW = r.w * k; newH = r.h * k;
        }
        var newCxL = fixedX + (lx >= fixedX ? newW / 2 : -newW / 2);
        var newCyL = fixedY + (ly >= fixedY ? newH / 2 : -newH / 2);
        if (keepAspect) { newCxL = fixedX + sx * newW / 2; newCyL = fixedY + sy * newH / 2; }
        var cosR = Math.cos(r.rot || 0), sinR = Math.sin(r.rot || 0);
        r.cx += newCxL * cosR - newCyL * sinR;
        r.cy += newCxL * sinR + newCyL * cosR;
        r.w = newW; r.h = newH;
    }

    function resizeRectBySide(r, idx, p) {
        var cos = Math.cos(-(r.rot || 0)), sin = Math.sin(-(r.rot || 0));
        var lx = (p.x - r.cx) * cos - (p.y - r.cy) * sin;
        var ly = (p.x - r.cx) * sin + (p.y - r.cy) * cos;
        var cosR = Math.cos(r.rot || 0), sinR = Math.sin(r.rot || 0);
        var newW = r.w, newH = r.h, axis = 'y';
        // il lato opposto resta fermo
        var fixed, delta;
        if (idx === 0) { fixed = r.h / 2; newH = Math.max(6, fixed - ly); delta = fixed - newH / 2; axis = 'y'; }
        else if (idx === 2) { fixed = -r.h / 2; newH = Math.max(6, ly - fixed); delta = fixed + newH / 2; axis = 'y'; }
        else if (idx === 1) { fixed = -r.w / 2; newW = Math.max(6, lx - fixed); delta = fixed + newW / 2; axis = 'x'; }
        else { fixed = r.w / 2; newW = Math.max(6, fixed - lx); delta = fixed - newW / 2; axis = 'x'; }
        var dxL = axis === 'x' ? delta : 0;
        var dyL = axis === 'y' ? delta : 0;
        r.cx += dxL * cosR - dyL * sinR;
        r.cy += dxL * sinR + dyL * cosR;
        r.w = newW; r.h = newH;
    }

    function onPointerUp(e) {
        if (dragCtx) {
            var ctx = dragCtx;
            dragCtx = null;
            if (ctx.kind === 'pan') {
                // ripristina solo il cursore: setTool() annullerebbe un
                // eventuale poligono in corso durante il pan con la barra spazio
                var cursors = {
                    select: 'default', polygon: 'crosshair', lasso: 'crosshair', rect: 'crosshair',
                    ellipse: 'crosshair', brush: 'none', eraser: 'none', sample: 'crosshair',
                    hand: 'grab', zoom: 'zoom-in'
                };
                editor.style.cursor = spaceDown ? 'grab' : (cursors[tool] || 'default');
                return;
            }
            if (ctx.kind === 'quad-corner') {
                var q = effectiveQuad(ctx.side);
                var check = Core.validateQuad(q);
                if (!check.ok) {
                    // configurazione impossibile: torna allo stato precedente
                    restoreDoc(ctx.pre);
                    setStatus('Prospettiva non valida (' + check.reason + '): modifica annullata', 'err');
                    return;
                }
                commit(ctx.pre, {});
                return;
            }
            if (ctx.kind === 'quad-move') { commit(ctx.pre, {}); return; }
            if (ctx.pre) {
                // vertex / move-object / rect-* → invalidano le maschere
                commit(ctx.pre, { excl: true });
            }
            return;
        }

        if (drawing) {
            if (drawing.type === 'lasso') finishLasso();
            else if (drawing.type === 'rect' || drawing.type === 'ellipse') finishShape();
            else if (drawing.type === 'brush' || drawing.type === 'eraser') finishBrush();
            // il poligono resta aperto finché non viene chiuso esplicitamente
        }
    }

    function onDblClick(e) {
        var p = toLogical(e);
        if (tool === 'polygon' && drawing && drawing.points.length >= 3) {
            polyClose();
            return;
        }
        if (tool !== 'select') return;
        var sel = getSelected();
        if (sel && (sel.type === 'polygon' || sel.type === 'lasso') && !sel.locked) {
            // doppio clic su un angolo → elimina l'angolo
            for (var i = 0; i < sel.points.length; i++) {
                if (screenDist(p, sel.points[i]) < 10) {
                    if (sel.points.length <= 3) {
                        setStatus('Un poligono non può avere meno di 3 angoli', 'warn');
                        return;
                    }
                    var pre = snap();
                    sel.points.splice(i, 1);
                    selectedVertex = -1;
                    commit(pre, { excl: true });
                    setStatus('Angolo eliminato', '');
                    return;
                }
            }
            // doppio clic su una linea → aggiunge un angolo
            for (i = 0; i < sel.points.length; i++) {
                var a = sel.points[i], b = sel.points[(i + 1) % sel.points.length];
                var d = distToSegment(p, a, b);
                if (d * view.scale < 7) {
                    var pre2 = snap();
                    sel.points.splice(i + 1, 0, { x: p.x, y: p.y });
                    selectedVertex = i + 1;
                    commit(pre2, { excl: true });
                    setStatus('Angolo aggiunto', '');
                    return;
                }
            }
        }
    }

    function distToSegment(p, a, b) {
        var dx = b.x - a.x, dy = b.y - a.y;
        var len2 = dx * dx + dy * dy;
        var t = len2 ? clamp(((p.x - a.x) * dx + (p.y - a.y) * dy) / len2, 0, 1) : 0;
        return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
    }

    // ------------------------------------------------------------
    // TASTIERA
    // ------------------------------------------------------------
    function onKeyDown(e) {
        if (!isOpen) return;
        var tag = (e.target.tagName || '').toLowerCase();
        if (tag === 'input' || tag === 'textarea' || tag === 'select') return;

        if (e.code === 'Space') { spaceDown = true; if (!dragCtx) editor.style.cursor = 'grab'; e.preventDefault(); return; }

        if (e.ctrlKey || e.metaKey) {
            if (e.key.toLowerCase() === 'z') { e.preventDefault(); e.shiftKey ? redo() : undo(); return; }
            if (e.key.toLowerCase() === 'y') { e.preventDefault(); redo(); return; }
        }

        if (e.key === 'Escape') { if (drawing) cancelDrawing(); return; }
        if (e.key === 'Enter') { if (drawing && drawing.type === 'polygon') polyClose(); return; }
        if (e.key === 'Backspace') {
            if (drawing && drawing.type === 'polygon') { polyUndoPoint(); e.preventDefault(); return; }
        }
        if (e.key === 'Delete' || e.key === 'Backspace') {
            var sel = getSelected();
            if (sel && !sel.locked) {
                if (selectedVertex >= 0 && (sel.type === 'polygon' || sel.type === 'lasso')) {
                    if (sel.points.length <= 3) { setStatus('Un poligono non può avere meno di 3 angoli', 'warn'); return; }
                    var pre = snap();
                    sel.points.splice(selectedVertex, 1);
                    selectedVertex = -1;
                    commit(pre, { excl: true });
                } else {
                    deleteObject(sel.id);
                }
                e.preventDefault();
            }
            return;
        }

        var shortcuts = { v: 'select', p: 'polygon', l: 'lasso', r: 'rect', e: 'ellipse', b: 'brush', g: 'eraser', h: 'hand', z: 'zoom' };
        var t = shortcuts[e.key.toLowerCase()];
        if (t) setTool(t);
    }

    function onKeyUp(e) {
        if (e.code === 'Space') {
            spaceDown = false;
            if (isOpen && !dragCtx) {
                var cursors = {
                    select: 'default', polygon: 'crosshair', lasso: 'crosshair', rect: 'crosshair',
                    ellipse: 'crosshair', brush: 'none', eraser: 'none', sample: 'crosshair',
                    hand: 'grab', zoom: 'zoom-in'
                };
                editor.style.cursor = cursors[tool] || 'default';
            }
        }
    }

    // ------------------------------------------------------------
    // CAMPIONAMENTO GREEN
    // ------------------------------------------------------------
    function addGreenSample(p) {
        if (!screenshotData) { setStatus('Carica prima lo screenshot', 'warn'); return; }
        var x = Math.round(clamp(p.x, 2, W - 3));
        var y = Math.round(clamp(p.y, 2, H - 3));
        // media 5×5 per stabilità
        var r = 0, g = 0, b = 0, n = 0;
        for (var dy = -2; dy <= 2; dy++) {
            for (var dx = -2; dx <= 2; dx++) {
                var i = ((y + dy) * W + (x + dx)) * 4;
                r += screenshotData.data[i]; g += screenshotData.data[i + 1]; b += screenshotData.data[i + 2];
                n++;
            }
        }
        r /= n; g /= n; b /= n;
        var hsv = Core.rgbToHsv(r, g, b);
        var pre = snap();
        doc.green.samples.push({ h: hsv.h, s: hsv.s, v: hsv.v, r: Math.round(r), g: Math.round(g), b: Math.round(b), x: x, y: y });
        applySampleRanges();
        commit(pre, { green: true, excl: true });
        refreshGreenPanel();
        var cnt = $('flg-sample-count');
        if (cnt) cnt.textContent = doc.green.samples.length;
        setStatus('Campione aggiunto (' + doc.green.samples.length + ')', 'ok');
    }

    function applySampleRanges() {
        var ranges = Core.rangesFromSamples(doc.green.samples, doc.green.tol);
        if (!ranges) return;
        doc.green.hMin = ranges.hMin; doc.green.hMax = ranges.hMax;
        doc.green.sMin = ranges.sMin; doc.green.sMax = ranges.sMax;
        doc.green.vMin = ranges.vMin; doc.green.vMax = ranges.vMax;
    }

    function removeGreenSample(idx) {
        var pre = snap();
        doc.green.samples.splice(idx, 1);
        applySampleRanges();
        commit(pre, { green: true, excl: true });
        refreshGreenPanel();
    }

    // il ricalcolo della maschera è pesante: debounce sugli slider (la dirty
    // flag viene alzata solo allo scadere, altrimenti il render immediato
    // ricalcolerebbe la maschera a ogni evento input)
    function scheduleGreenRecompute() {
        if (greenTimer) clearTimeout(greenTimer);
        greenTimer = setTimeout(function () {
            greenTimer = null;
            caches.greenDirty = true;
            caches.exclDirty = true;
            requestRender();
        }, 250);
    }

    // ------------------------------------------------------------
    // SCREENSHOT
    // ------------------------------------------------------------
    function setScreenshotFromImage(img) {
        var c = Core.makeCanvas(W, H);
        var ctx = c.getContext('2d');
        // cover mantenendo 16:9 (lo screenshot della camera è già 1920×1080)
        var iw = img.naturalWidth || img.width, ih = img.naturalHeight || img.height;
        var k = Math.max(W / iw, H / ih);
        var dw = iw * k, dh = ih * k;
        ctx.drawImage(img, (W - dw) / 2, (H - dh) / 2, dw, dh);
        screenshotCanvas = c;
        screenshotData = ctx.getImageData(0, 0, W, H);
        caches.greenDirty = true;
        caches.exclDirty = true;
        caches.shadeDirty = true;
        c.toBlob(function (blob) {
            if (blob) idbPut('screenshot', blob).catch(function (e) {
                console.warn('[FieldLogos] Screenshot non salvato in IndexedDB:', e);
            });
        }, 'image/webp', 0.9);
        refreshScreenshotPanel();
        updatePublishState();
        requestRender();
        setStatus('Screenshot caricato (1920×1080)', 'ok');
    }

    function loadScreenshotFile(file) {
        if (!file || !/^image\//.test(file.type)) { setStatus('Il file non è un\'immagine', 'err'); return; }
        var url = URL.createObjectURL(file);
        Core.loadImageAny(url).then(function (img) {
            URL.revokeObjectURL(url);
            setScreenshotFromImage(img);
        }).catch(function () {
            URL.revokeObjectURL(url);
            setStatus('Screenshot non leggibile', 'err');
        });
    }

    function pasteScreenshot() {
        if (!navigator.clipboard || !navigator.clipboard.read) {
            setStatus('Incolla non supportato: usa Ctrl+V con l\'editor aperto', 'warn');
            return;
        }
        navigator.clipboard.read().then(function (items) {
            for (var i = 0; i < items.length; i++) {
                var types = items[i].types;
                for (var j = 0; j < types.length; j++) {
                    if (/^image\//.test(types[j])) {
                        return items[i].getType(types[j]).then(function (blob) {
                            loadScreenshotFile(new File([blob], 'clipboard.png', { type: blob.type }));
                        });
                    }
                }
            }
            setStatus('Nessuna immagine negli appunti', 'warn');
        }).catch(function (e) {
            setStatus('Lettura appunti negata: ' + e.message, 'err');
        });
    }

    function onPaste(e) {
        if (!isOpen || !e.clipboardData) return;
        var items = e.clipboardData.items;
        for (var i = 0; i < items.length; i++) {
            if (/^image\//.test(items[i].type)) {
                loadScreenshotFile(items[i].getAsFile());
                e.preventDefault();
                return;
            }
        }
    }

    function removeScreenshot() {
        screenshotCanvas = null;
        screenshotData = null;
        caches.greenDirty = true;
        caches.exclDirty = true;
        caches.shadeDirty = true;
        idbDel('screenshot');
        refreshScreenshotPanel();
        requestRender();
        setStatus('Screenshot rimosso', '');
    }

    function restoreScreenshotFromIdb() {
        idbGet('screenshot').then(function (blob) {
            if (!blob) return;
            var url = URL.createObjectURL(blob);
            Core.loadImageAny(url).then(function (img) {
                URL.revokeObjectURL(url);
                var c = Core.makeCanvas(W, H);
                var ctx = c.getContext('2d');
                ctx.drawImage(img, 0, 0, W, H);
                screenshotCanvas = c;
                screenshotData = ctx.getImageData(0, 0, W, H);
                caches.greenDirty = true;
                caches.exclDirty = true;
                caches.shadeDirty = true;
                refreshScreenshotPanel();
                requestRender();
            }).catch(function () { URL.revokeObjectURL(url); });
        }).catch(function (e) {
            console.warn('[FieldLogos] IndexedDB non disponibile:', e);
        });
    }

    // ------------------------------------------------------------
    // SQUADRE E LOGHI (stessa fonte dati di streaming.html)
    // ------------------------------------------------------------
    function bridge() {
        return global.__pmFieldLogosBridge || null;
    }

    function pollTeams() {
        var br = bridge();
        var state = br && br.getState ? br.getState() : null;
        var clans = br && br.getClans ? br.getClans() : [];
        if (!state) {
            // fallback: ultimo stato salvato dalla Regia in questo browser
            try { state = JSON.parse(localStorage.getItem('pm_last_state') || 'null'); } catch (e) { }
        }
        if (!state || !state.teamLeft || !state.teamRight) return;
        updateTeam('left', state.teamLeft, clans);
        updateTeam('right', state.teamRight, clans);
    }

    function updateTeam(side, teamData, clans) {
        var name = Core.cleanTeamName(teamData.name || '');
        var t = teams[side];
        if (t.name === name && (t.img || t.status === 'CORS' || t.status === 'NOTFOUND')) return;
        t.name = name;
        if (Core.isPlaceholderName(name)) {
            t.img = null; t.logoUrl = null; t.status = 'Squadra non ancora selezionata';
            refreshTeamTags();
            requestRender();
            return;
        }
        t.status = 'Ricerca logo...';
        refreshTeamTags();
        Core.resolveLogoUrl(name, teamData.logoUrl, clans, null).then(function (url) {
            if (teams[side].name !== name) return; // nel frattempo è cambiata squadra
            if (!url) {
                t.img = null; t.logoUrl = null; t.status = 'Logo non trovato';
                refreshTeamTags(); requestRender(); updatePublishState();
                return;
            }
            t.logoUrl = url;
            Core.loadLogoImage(url).then(function (img) {
                if (teams[side].name !== name) return;
                t.img = img; t.status = 'OK';
                refreshTeamTags(); requestRender(); updatePublishState();
            }).catch(function (err) {
                if (teams[side].name !== name) return;
                t.img = null; t.status = err.code === 'CORS' ? 'CORS' : 'NOTFOUND';
                setStatus(err.message, 'err');
                refreshTeamTags(); requestRender();
            });
        });
    }

    function refreshTeamTags() {
        ['left', 'right'].forEach(function (side) {
            var el = $('flg-team-' + side);
            if (!el) return;
            var t = teams[side];
            var stateTxt = t.status === 'OK' ? '✓ logo caricato'
                : t.status === 'CORS' ? '⚠ logo bloccato (CORS)'
                    : t.status === 'NOTFOUND' ? '⚠ logo non trovato'
                        : t.status;
            el.innerHTML =
                (t.img ? '<img src="' + esc(t.logoUrl) + '" alt="">' : '<span style="width:26px;text-align:center;">🏳</span>') +
                '<span class="flg-team-name">' + esc(t.name || (side === 'left' ? 'Squadra sinistra' : 'Squadra destra')) + '</span>' +
                '<span class="flg-team-state">' + esc(stateTxt) + '</span>';
        });
    }

    // ------------------------------------------------------------
    // PUBBLICAZIONE VERSO L'OVERLAY
    // ------------------------------------------------------------
    function getMatchId() {
        var br = bridge();
        var id = br && br.getMatchId ? br.getMatchId() : '';
        if (!id) { try { id = localStorage.getItem('last_match_id') || ''; } catch (e) { } }
        return String(id || '').replace(/^IPBA-/, '');
    }

    function checkApi() {
        // Il server locale (server.js) risponde SEMPRE application/json su questo
        // endpoint (200 con config o 404 JSON). GitHub Pages risponde 404 HTML:
        // così distinguiamo i due contesti senza configurazione manuale.
        if (!/^https?:$/.test(location.protocol)) {
            apiAvailable = false;
            return Promise.resolve(false);
        }
        return fetch(API_PATH, { method: 'GET', cache: 'no-store' }).then(function (r) {
            var ct = r.headers.get('Content-Type') || '';
            apiAvailable = (r.ok || r.status === 404) && ct.indexOf('application/json') !== -1;
            return apiAvailable;
        }).catch(function () {
            apiAvailable = false;
            return false;
        });
    }

    // Maschera finale per lato con feather del logo già "cotto" (l'overlay non
    // ha lo screenshot e riceve il raster pronto)
    function bakedMaskDataUrl(side, outW, outH, quality) {
        ensureAllMasks();
        var comb = side === 'left' ? caches.combLeft : caches.combRight;
        if (!comb) return null;
        var feather = doc[side].feather || 0;
        var src = comb;
        if (feather > 0) {
            var f = Core.makeCanvas(W, H);
            var ctx = f.getContext('2d');
            ctx.filter = 'blur(' + feather + 'px)';
            ctx.drawImage(comb, 0, 0);
            ctx.filter = 'none';
            src = f;
        }
        return Core.maskToDataUrl(src, outW, outH, quality);
    }

    function buildPayload(compact) {
        ensureAllMasks();
        var mw = compact ? 480 : 960;
        var mh = compact ? 270 : 540;
        var q = compact ? 0.6 : 0.82;
        var sameMask = caches.combRight === caches.combLeft && (doc.left.feather || 0) === (doc.right.feather || 0);
        var maskL = screenshotCanvas || doc.objects.length ? bakedMaskDataUrl('left', mw, mh, q) : null;
        var maskR = sameMask ? '=L' : (screenshotCanvas || doc.objects.length ? bakedMaskDataUrl('right', mw, mh, q) : null);
        var anyFusion = (doc.left.fusion > 0 || doc.right.fusion > 0) && caches.shade;
        return {
            type: 'pm-field-logos',
            v: Core.CONFIG_VERSION,
            // istante di PUBBLICAZIONE: ogni "Aggiorna overlay" deve prevalere
            // sulle config già ricevute dall'overlay, anche a documento invariato
            updatedAt: Date.now(),
            matchId: getMatchId(),
            enabled: doc.enabled,
            showLeft: doc.showLeft && doc.left.visible,
            showRight: doc.showRight && doc.right.visible,
            teams: {
                left: { name: teams.left.name, logoUrl: teams.left.logoUrl },
                right: { name: teams.right.name, logoUrl: teams.right.logoUrl }
            },
            left: {
                quad: effectiveQuad('left'),
                opacity: doc.left.opacity, blur: doc.left.blur,
                desat: doc.left.desat, fusion: doc.left.fusion
            },
            right: {
                quad: effectiveQuad('right'),
                opacity: doc.right.opacity, blur: doc.right.blur,
                desat: doc.right.desat, fusion: doc.right.fusion
            },
            maskL: maskL,
            maskR: maskR,
            shade: anyFusion ? Core.shadeToDataUrl(caches.shade, compact ? 480 : 960, compact ? 270 : 540, compact ? 0.55 : 0.72) : null
        };
    }

    function publishOverlay() {
        if (!doc.enabled) setStatus('Nota: overlay disabilitato — pubblico comunque la configurazione', 'warn');
        var payload;
        try {
            payload = buildPayload(false);
        } catch (e) {
            setStatus('Errore nella preparazione della configurazione: ' + e.message, 'err');
            return Promise.reject(e);
        }
        var json = JSON.stringify(payload);

        // 1. stesso browser: localStorage + BroadcastChannel
        try { localStorage.setItem(LS_PUB_KEY, json); } catch (e) {
            console.warn('[FieldLogos] localStorage pieno, pubblico solo via canale/API:', e.message);
        }
        try {
            if (!bc) bc = new BroadcastChannel(BC_NAME);
            bc.postMessage({ type: 'FLG_CONFIG', payload: payload });
        } catch (e) { }

        // 2. server locale (per il browser separato di vMix)
        var apiPromise = Promise.resolve(false);
        if (apiAvailable !== false && /^https?:$/.test(location.protocol)) {
            apiPromise = fetch(API_PATH, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: json
            }).then(function (r) {
                apiAvailable = r.ok;
                return r.ok;
            }).catch(function () { apiAvailable = false; return false; });
        }

        return apiPromise.then(function (viaApi) {
            lastPublishedAt = payload.updatedAt;
            updatePublishState();
            if (viaApi) {
                setStatus('Overlay aggiornato ✓ (server locale + browser)', 'ok');
            } else {
                setStatus('Overlay aggiornato nel browser. Per vMix su un altro browser usa "Copia URL per vMix".', 'warn');
            }
            return viaApi;
        });
    }

    function overlayUrl(withCfg) {
        var url = new URL('field-logos-overlay.html', location.href);
        var id = getMatchId();
        if (id) url.searchParams.set('id', id);
        if (!withCfg) return Promise.resolve(url.toString());
        var payload = buildPayload(true);
        return Core.compressPayload(payload).then(function (cfg) {
            url.searchParams.set('cfg', cfg);
            return url.toString();
        });
    }

    function updatePublishState() {
        var el = $('flg-pub-state');
        if (!el) return;
        if (!lastPublishedAt) {
            el.textContent = '● Configurazione non ancora pubblicata';
            el.style.color = '#f59e0b';
        } else if (doc.updatedAt > lastPublishedAt) {
            el.textContent = '● Modifiche non pubblicate: premi "Aggiorna overlay"';
            el.style.color = '#f59e0b';
        } else {
            el.textContent = '● Overlay aggiornato (' + new Date(lastPublishedAt).toLocaleTimeString() + ')';
            el.style.color = '#4ade80';
        }
    }

    // ------------------------------------------------------------
    // IMPORT / EXPORT / RESET
    // ------------------------------------------------------------
    function exportConfig() {
        var out = {
            type: 'pm-field-logos-config',
            v: Core.CONFIG_VERSION,
            exportedAt: new Date().toISOString(),
            doc: JSON.parse(snap()),
            screenshot: screenshotCanvas ? screenshotCanvas.toDataURL('image/webp', 0.85) : null
        };
        var blob = new Blob([JSON.stringify(out)], { type: 'application/json' });
        var a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = 'loghi-sul-green-' + new Date().toISOString().slice(0, 10) + '.json';
        a.click();
        setTimeout(function () { URL.revokeObjectURL(a.href); }, 5000);
        setStatus('Configurazione esportata', 'ok');
    }

    function importConfig(file) {
        var reader = new FileReader();
        reader.onload = function () {
            try {
                var data = JSON.parse(reader.result);
                if (!data || data.type !== 'pm-field-logos-config' || !data.doc) {
                    throw new Error('file non riconosciuto (atteso: export "Loghi sul green")');
                }
                if (typeof data.v === 'number' && data.v > Core.CONFIG_VERSION) {
                    throw new Error('versione configurazione più recente di questa pagina');
                }
                var pre = snap();
                doc = sanitizeDoc(data.doc);
                pushHistory(pre);
                afterDocChange({ green: true, excl: true });
                refreshAllPanels();
                if (data.screenshot) {
                    Core.loadImageAny(data.screenshot).then(setScreenshotFromImage).catch(function () {
                        setStatus('Configurazione importata, ma screenshot non leggibile', 'warn');
                    });
                }
                setStatus('Configurazione importata ✓', 'ok');
            } catch (e) {
                setStatus('JSON non valido: ' + e.message, 'err');
            }
        };
        reader.onerror = function () { setStatus('Errore di lettura del file', 'err'); };
        reader.readAsText(file);
    }

    function resetAll() {
        if (!confirm('Ripristinare TUTTA la configurazione "Loghi sul green"?\n(screenshot, prospettive, maschera green ed esclusioni)')) return;
        var pre = snap();
        doc = Core.defaultDoc();
        pushHistory(pre);
        afterDocChange({ green: true, excl: true });
        removeScreenshot();
        refreshAllPanels();
        setStatus('Configurazione ripristinata ai valori iniziali', 'ok');
    }

    function resetLogos() {
        var pre = snap();
        doc.left = Core.defaultLogoParams('left');
        doc.right = Core.defaultLogoParams('right');
        commit(pre, {});
        refreshAllPanels();
        setStatus('Impostazioni dei loghi ripristinate', 'ok');
    }

    function resetExclusions() {
        if (!confirm('Eliminare tutti gli oggetti di esclusione/ripristino?')) return;
        var pre = snap();
        doc.objects = [];
        selectedId = null;
        commit(pre, { excl: true });
        refreshObjectsPanel();
        setStatus('Esclusioni eliminate', 'ok');
    }

    function resetGreen() {
        var pre = snap();
        doc.green = Core.defaultGreen();
        commit(pre, { green: true, excl: true });
        refreshGreenPanel();
        setStatus('Maschera green ripristinata', 'ok');
    }

    function resetPerspective(side) {
        var pre = snap();
        var def = Core.defaultLogoParams(side);
        doc[side].quad = def.quad;
        doc[side].dx = 0; doc[side].dy = 0; doc[side].rot = 0; doc[side].scale = 1;
        commit(pre, {});
        refreshLogoPanel(side);
        setStatus('Prospettiva ' + (side === 'left' ? 'sinistra' : 'destra') + ' ripristinata', 'ok');
    }

    // ------------------------------------------------------------
    // OGGETTI: operazioni pannello
    // ------------------------------------------------------------
    function deleteObject(id) {
        var pre = snap();
        doc.objects = doc.objects.filter(function (o) { return o.id !== id; });
        if (selectedId === id) { selectedId = null; selectedVertex = -1; }
        commit(pre, { excl: true });
        refreshObjectsPanel();
        setStatus('Oggetto eliminato', '');
    }

    function duplicateObject(id) {
        var src = doc.objects.find(function (o) { return o.id === id; });
        if (!src) return;
        var pre = snap();
        var copy = JSON.parse(JSON.stringify(src));
        copy.id = 'obj' + (objSeq++);
        copy.name = src.name + ' (copia)';
        translateObject(copy, 25, 25);
        doc.objects.push(copy);
        selectedId = copy.id;
        commit(pre, { excl: true });
        refreshObjectsPanel();
        setStatus('Oggetto duplicato', 'ok');
    }

    function moveObjectOrder(id, dir) {
        var idx = doc.objects.findIndex(function (o) { return o.id === id; });
        var to = idx + dir;
        if (idx < 0 || to < 0 || to >= doc.objects.length) return;
        var pre = snap();
        var tmp = doc.objects[idx];
        doc.objects[idx] = doc.objects[to];
        doc.objects[to] = tmp;
        commit(pre, { excl: true });
        refreshObjectsPanel();
    }

    function toggleObjectFlag(id, flag) {
        var o = doc.objects.find(function (x) { return x.id === id; });
        if (!o) return;
        var pre = snap();
        o[flag] = !o[flag];
        commit(pre, { excl: flag !== 'locked' });
        refreshObjectsPanel();
    }

    function cycleObjectMode(id) {
        var o = doc.objects.find(function (x) { return x.id === id; });
        if (!o) return;
        var pre = snap();
        o.mode = o.mode === 'restore' ? 'exclude' : 'restore';
        commit(pre, { excl: true });
        refreshObjectsPanel();
    }

    function cycleObjectTarget(id) {
        var o = doc.objects.find(function (x) { return x.id === id; });
        if (!o) return;
        var pre = snap();
        var order = ['both', 'left', 'right'];
        o.target = order[(order.indexOf(o.target || 'both') + 1) % 3];
        commit(pre, { excl: true });
        refreshObjectsPanel();
    }

    function convertToPath(id) {
        var o = doc.objects.find(function (x) { return x.id === id; });
        if (!o || (o.type !== 'rect' && o.type !== 'ellipse')) return;
        var pre = snap();
        if (o.type === 'rect') {
            o.points = rectCorners(o.rect);
        } else {
            var pts = [];
            for (var i = 0; i < 24; i++) {
                var a = i / 24 * Math.PI * 2;
                var lx = Math.cos(a) * o.rect.w / 2, ly = Math.sin(a) * o.rect.h / 2;
                var cos = Math.cos(o.rect.rot || 0), sin = Math.sin(o.rect.rot || 0);
                pts.push({ x: o.rect.cx + lx * cos - ly * sin, y: o.rect.cy + lx * sin + ly * cos });
            }
            o.points = pts;
        }
        o.type = 'polygon';
        delete o.rect;
        o.name += ' (tracciato)';
        commit(pre, { excl: true });
        refreshObjectsPanel();
        setStatus('Convertito in tracciato modificabile', 'ok');
    }

    // ------------------------------------------------------------
    // COSTRUZIONE UI
    // ------------------------------------------------------------
    var OBJ_ICONS = { polygon: '⬠', lasso: '➰', rect: '▭', ellipse: '◯', brush: '🖌' };

    function buildUI() {
        if (built) return;
        built = true;

        var root = document.createElement('div');
        root.id = 'flg-modal';
        root.innerHTML =
            '<div id="flg-header">' +
            '  <h2>🌿 LOGHI SUL GREEN</h2>' +
            '  <label class="flg-check" title="Abilita/disabilita l\'intero overlay"><input type="checkbox" id="flg-enabled"> Abilita overlay</label>' +
            '  <button class="flg-btn accent" id="flg-btn-update" title="Pubblica la configurazione verso la pagina overlay">📡 Aggiorna overlay</button>' +
            '  <button class="flg-btn" id="flg-btn-open" title="Apre field-logos-overlay.html in una nuova scheda">🔗 Apri overlay</button>' +
            '  <button class="flg-btn" id="flg-btn-copyurl" title="Copia l\'URL da incollare nel Browser Input di vMix">📋 Copia URL per vMix</button>' +
            '  <button class="flg-btn good" id="flg-btn-save" title="Salvataggio manuale (il salvataggio automatico è comunque attivo)">💾 Salva</button>' +
            '  <button class="flg-btn" id="flg-btn-export">⬇ Esporta</button>' +
            '  <button class="flg-btn" id="flg-btn-import">⬆ Importa</button>' +
            '  <input type="file" id="flg-import-file" class="flg-hidden-input" accept="application/json,.json">' +
            '  <button class="flg-btn danger" id="flg-btn-reset">♻ Ripristina...</button>' +
            '  <span id="flg-status"></span>' +
            '  <button class="flg-btn danger" id="flg-btn-close">✕ CHIUDI</button>' +
            '</div>' +
            '<div id="flg-main">' +
            '  <div id="flg-toolbar"></div>' +
            '  <div id="flg-stage-wrap">' +
            '    <canvas id="flg-stage"></canvas>' +
            '    <canvas id="flg-editor-canvas"></canvas>' +
            '    <div id="flg-viewtabs"></div>' +
            '    <div id="flg-tooloptions"></div>' +
            '    <div id="flg-zoombar">' +
            '      <button class="flg-btn" id="flg-zoom-out" title="Zoom indietro">−</button>' +
            '      <span id="flg-zoom-pct">100%</span>' +
            '      <button class="flg-btn" id="flg-zoom-in" title="Zoom avanti">+</button>' +
            '      <button class="flg-btn" id="flg-zoom-100" title="Zoom 100%">1:1</button>' +
            '      <button class="flg-btn" id="flg-zoom-fit" title="Adatta alla finestra">⛶</button>' +
            '    </div>' +
            '    <div id="flg-hint"></div>' +
            '    <div id="flg-histbar">' +
            '      <button class="flg-btn" id="flg-undo" title="Annulla (Ctrl+Z)">↩ Annulla</button>' +
            '      <button class="flg-btn" id="flg-redo" title="Ripristina (Ctrl+Y)">↪ Ripristina</button>' +
            '    </div>' +
            '  </div>' +
            '  <div id="flg-side"></div>' +
            '</div>';
        document.body.appendChild(root);

        var link = document.querySelector('link[href^="field-logos-setup.css"]');
        if (!link) {
            link = document.createElement('link');
            link.rel = 'stylesheet';
            link.href = 'field-logos-setup.css?v=1.0.0';
            document.head.appendChild(link);
        }

        wrapEl = $('flg-stage-wrap');
        stage = $('flg-stage');
        stageCtx = stage.getContext('2d');
        editor = $('flg-editor-canvas');
        editorCtx = editor.getContext('2d');

        buildToolbar();
        buildViewTabs();
        buildSidePanels();
        bindHeader();
        bindPointerEvents();

        renderer = Core.createRenderer();
        resultCanvas = Core.makeCanvas(W, H);
        resultCtx = resultCanvas.getContext('2d');
        if (!renderer.usesWebGL) {
            setStatus('WebGL non disponibile: uso il rendering di riserva (più lento ma identico)', 'warn');
        }

        window.addEventListener('keydown', onKeyDown);
        window.addEventListener('keyup', onKeyUp);
        window.addEventListener('paste', onPaste);
        window.addEventListener('resize', onResize);
    }

    function onResize() {
        if (!isOpen) return;
        sizeCanvases();
        fitView();
    }

    function sizeCanvases() {
        var dpr = global.devicePixelRatio || 1;
        var rect = wrapEl.getBoundingClientRect();
        var w = Math.max(200, Math.round(rect.width * dpr));
        var h = Math.max(200, Math.round(rect.height * dpr));
        if (stage.width !== w || stage.height !== h) {
            stage.width = w; stage.height = h;
            editor.width = w; editor.height = h;
        }
    }

    function buildToolbar() {
        var bar = $('flg-toolbar');
        TOOLS.forEach(function (t) {
            if (t.id === 'sep') {
                var sep = document.createElement('div');
                sep.className = 'flg-tool-sep';
                bar.appendChild(sep);
                return;
            }
            var b = document.createElement('button');
            b.className = 'flg-tool';
            b.dataset.tool = t.id;
            b.title = t.label;
            b.textContent = t.icon;
            b.onclick = function () { setTool(t.id); };
            bar.appendChild(b);
        });
    }

    var VIEW_TABS = [
        { id: 'config', label: 'Configurazione' },
        { id: 'screenshot', label: 'Screenshot' },
        { id: 'logos', label: 'Loghi' },
        { id: 'green', label: 'Maschera verde' },
        { id: 'excl', label: 'Esclusioni' },
        { id: 'final', label: 'Risultato finale' }
    ];

    function buildViewTabs() {
        var wrap = $('flg-viewtabs');
        VIEW_TABS.forEach(function (t) {
            var b = document.createElement('button');
            b.className = 'flg-viewtab' + (t.id === previewMode ? ' active' : '');
            b.dataset.mode = t.id;
            b.textContent = t.label;
            b.onclick = function () {
                previewMode = t.id;
                wrap.querySelectorAll('.flg-viewtab').forEach(function (x) {
                    x.classList.toggle('active', x.dataset.mode === t.id);
                });
                requestRender();
            };
            wrap.appendChild(b);
        });
    }

    function section(id, title, bodyHtml, closed) {
        return '<div class="flg-sec' + (closed ? ' closed' : '') + '" id="' + id + '">' +
            '<div class="flg-sec-head">' + title + '<span class="flg-caret">▼</span></div>' +
            '<div class="flg-sec-body">' + bodyHtml + '</div></div>';
    }

    function sliderRow(id, label, min, max, step, val, fmt) {
        return '<div class="flg-slider"><span>' + label + '</span>' +
            '<input type="range" id="' + id + '" min="' + min + '" max="' + max + '" step="' + step + '" value="' + val + '">' +
            '<span class="flg-val" id="' + id + '-val">' + (fmt || val) + '</span></div>';
    }

    function logoSectionHtml(side) {
        var s = side === 'left' ? 'sx' : 'dx';
        var p = 'flg-' + side + '-';
        return '<div class="flg-team-tag" id="flg-team-' + side + '"></div>' +
            '<label class="flg-check"><input type="checkbox" id="' + p + 'visible"> Mostra logo ' + (side === 'left' ? 'sinistro' : 'destro') + '</label>' +
            sliderRow(p + 'opacity', 'Opacità', 0, 100, 1, 75) +
            sliderRow(p + 'size', 'Dimensione', 120, 1400, 5, 600) +
            sliderRow(p + 'scale', 'Scala', 20, 300, 1, 100) +
            sliderRow(p + 'dx', 'Posizione orizz.', -900, 900, 1, 0) +
            sliderRow(p + 'dy', 'Posizione vert.', -600, 600, 1, 0) +
            sliderRow(p + 'rot', 'Rotazione fine', -45, 45, 0.5, 0) +
            sliderRow(p + 'feather', 'Feather bordi', 0, 40, 1, 6) +
            sliderRow(p + 'blur', 'Blur leggero', 0, 6, 0.2, 0.6) +
            sliderRow(p + 'desat', 'Desaturazione', 0, 100, 1, 25) +
            sliderRow(p + 'fusion', 'Fusione col prato', 0, 100, 1, 55) +
            '<div class="flg-row compact">' +
            '<button class="flg-btn" id="' + p + 'reset">↺ Reset logo ' + s + '</button>' +
            '<button class="flg-btn" id="' + p + 'resetquad">↺ Reset prospettiva ' + s + '</button>' +
            '</div>';
    }

    function buildSidePanels() {
        var side = $('flg-side');
        side.innerHTML =
            section('flg-sec-general', '⚙ GENERALE',
                '<div class="flg-row compact">' +
                '<button class="flg-btn" id="flg-show-both">👁 Mostra entrambi</button>' +
                '<button class="flg-btn" id="flg-hide-both">🚫 Nascondi entrambi</button>' +
                '</div>' +
                '<label class="flg-check"><input type="checkbox" id="flg-show-left"> Mostra logo sinistro</label>' +
                '<label class="flg-check"><input type="checkbox" id="flg-show-right"> Mostra logo destro</label>' +
                '<label class="flg-check" title="Applica a entrambi i loghi le regolazioni comuni (opacità, scala, feather, blur, desaturazione, fusione)"><input type="checkbox" id="flg-link"> Modifica entrambi i loghi</label>' +
                sliderRow('flg-margin', 'Margine esclusione', -20, 60, 1, 0) +
                '<div id="flg-pub-state" class="flg-note"></div>' +
                '<div id="flg-save-ind" class="flg-note"></div>' +
                '<div class="flg-row compact">' +
                '<button class="flg-btn" id="flg-reset-logos">↺ Reset loghi</button>' +
                '<button class="flg-btn" id="flg-reset-excl">↺ Reset esclusioni</button>' +
                '<button class="flg-btn" id="flg-reset-green">↺ Reset green</button>' +
                '</div>') +
            section('flg-sec-shot', '🖼 SCREENSHOT DI CALIBRAZIONE',
                '<div class="flg-row compact">' +
                '<button class="flg-btn accent" id="flg-shot-load">📂 Carica screenshot</button>' +
                '<button class="flg-btn" id="flg-shot-paste">📋 Incolla dagli appunti</button>' +
                '</div>' +
                '<div class="flg-row compact">' +
                '<button class="flg-btn" id="flg-shot-replace">🔄 Sostituisci</button>' +
                '<button class="flg-btn danger" id="flg-shot-remove">🗑 Rimuovi</button>' +
                '</div>' +
                '<input type="file" id="flg-shot-file" class="flg-hidden-input" accept="image/*">' +
                '<div class="flg-note" id="flg-shot-info">Nessuno screenshot caricato. Serve solo per la calibrazione: non appare mai nell\'output per vMix.</div>') +
            section('flg-sec-left', '🔵 LOGO SINISTRO', logoSectionHtml('left')) +
            section('flg-sec-right', '🟠 LOGO DESTRO', logoSectionHtml('right')) +
            section('flg-sec-green', '🌿 MASCHERA GREEN',
                '<label class="flg-check"><input type="checkbox" id="flg-green-on"> Maschera verde attiva</label>' +
                '<div class="flg-row compact"><button class="flg-btn accent" id="flg-green-sample">💧 Campiona green</button></div>' +
                '<div id="flg-green-samples"></div>' +
                sliderRow('flg-g-tol', 'Tolleranza colore', 30, 300, 5, 100) +
                sliderRow('flg-g-soft', 'Morbidezza', 0, 50, 1, 12) +
                sliderRow('flg-g-hmin', 'Tonalità min', 0, 360, 1, 60) +
                sliderRow('flg-g-hmax', 'Tonalità max', 0, 360, 1, 170) +
                sliderRow('flg-g-smin', 'Saturazione min', 0, 100, 1, 15) +
                sliderRow('flg-g-smax', 'Saturazione max', 0, 100, 1, 100) +
                sliderRow('flg-g-vmin', 'Luminosità min', 0, 100, 1, 10) +
                sliderRow('flg-g-vmax', 'Luminosità max', 0, 100, 1, 95) +
                sliderRow('flg-g-erode', 'Erosione', 0, 20, 1, 0) +
                sliderRow('flg-g-dilate', 'Dilatazione', 0, 20, 1, 0) +
                sliderRow('flg-g-feather', 'Feather', 0, 30, 1, 3) +
                sliderRow('flg-g-despeckle', 'Rimuovi puntini', 0, 10, 1, 2) +
                sliderRow('flg-g-fill', 'Riempi buchi', 0, 10, 1, 2)) +
            section('flg-sec-objects', '📚 OGGETTI DI ESCLUSIONE',
                '<div class="flg-note">L\'ordine è l\'ordine di esecuzione: l\'ultimo prevale. ' +
                'Modalità: <b style="color:#f87171">Escludi</b> / <b style="color:#4ade80">Ripristina</b>. ' +
                'Applica a: 2 = entrambi, SX/DX = solo un logo.</div>' +
                '<div id="flg-objects"></div>') +
            section('flg-sec-guide', '📖 GUIDA RAPIDA',
                '<div id="flg-guide">' +
                '<ol>' +
                '<li>Carica o <b>incolla</b> lo screenshot della telecamera centrale.</li>' +
                '<li>Con <b>💧 Campiona green</b> clicca più punti del prato (sole e ombra).</li>' +
                '<li>Trascina le <b>4 maniglie</b> di ciascun logo per stenderlo sul terreno.</li>' +
                '<li>Seleziona il <b>Poligono</b> e clicca intorno al gonfiabile; aggiungi tutti gli angoli necessari e chiudi sul primo punto.</li>' +
                '<li>Usa il <b>Lazo</b> per le sagome irregolari, <b>Rettangolo/Ellisse</b> per quelle semplici.</li>' +
                '<li>Con <b>Selezione</b> trascini angoli e maniglie intermedie (aggiungono un angolo); doppio clic su un angolo lo elimina.</li>' +
                '<li>Il <b>Pennello</b> esclude a mano libera; <b>Ripristina area</b> cancella una parte della maschera.</li>' +
                '<li>Controlla <b>Risultato finale</b>, poi premi <b>📡 Aggiorna overlay</b>.</li>' +
                '<li>In vMix: Add Input → Web Browser → incolla l\'URL copiato (1920×1080).</li>' +
                '</ol></div>', true);

        // comportamenti sezioni richiudibili
        side.querySelectorAll('.flg-sec-head').forEach(function (head) {
            head.onclick = function () { head.parentElement.classList.toggle('closed'); };
        });

        bindGeneralPanel();
        bindScreenshotPanel();
        bindLogoPanel('left');
        bindLogoPanel('right');
        bindGreenPanel();
        refreshAllPanels();
    }

    // ---------- BINDING PANNELLI ----------
    function bindHeader() {
        $('flg-btn-close').onclick = closeSetup;
        $('flg-btn-save').onclick = function () { saveDoc(); setStatus('Configurazione salvata', 'ok'); };
        $('flg-btn-export').onclick = exportConfig;
        $('flg-btn-import').onclick = function () { $('flg-import-file').click(); };
        $('flg-import-file').onchange = function () {
            if (this.files && this.files[0]) importConfig(this.files[0]);
            this.value = '';
        };
        $('flg-btn-reset').onclick = resetAll;
        $('flg-btn-update').onclick = publishOverlay;
        $('flg-btn-open').onclick = function () {
            publishOverlay().finally(function () {
                overlayUrl(false).then(function (url) { window.open(url, '_blank'); });
            });
        };
        $('flg-btn-copyurl').onclick = function () {
            publishOverlay().then(function (viaApi) {
                // con il server locale basta l'URL semplice (la config viaggia via API);
                // su GitHub Pages/file la config viene incorporata nell'URL
                return overlayUrl(!viaApi);
            }).then(function (url) {
                return navigator.clipboard.writeText(url).then(function () {
                    setStatus('URL overlay copiato (' + (url.length > 500 ? 'config incorporata, ' + Math.round(url.length / 1024) + ' KB' : 'config via server locale') + ')', 'ok');
                }, function () {
                    prompt('Copia manualmente questo URL per vMix:', url);
                });
            }).catch(function (e) {
                setStatus('Errore generazione URL: ' + e.message, 'err');
            });
        };
        $('flg-enabled').onchange = function () {
            var pre = snap();
            doc.enabled = this.checked;
            commit(pre, {});
        };
        $('flg-undo').onclick = undo;
        $('flg-redo').onclick = redo;
        $('flg-zoom-in').onclick = function () { setZoom(view.scale * 1.25); };
        $('flg-zoom-out').onclick = function () { setZoom(view.scale / 1.25); };
        $('flg-zoom-100').onclick = function () { setZoom(global.devicePixelRatio || 1); };
        $('flg-zoom-fit').onclick = fitView;
    }

    function bindGeneralPanel() {
        $('flg-show-left').onchange = function () {
            var pre = snap(); doc.showLeft = this.checked; commit(pre, {});
        };
        $('flg-show-right').onchange = function () {
            var pre = snap(); doc.showRight = this.checked; commit(pre, {});
        };
        $('flg-show-both').onclick = function () {
            var pre = snap(); doc.showLeft = doc.showRight = true; commit(pre, {}); refreshGeneralPanel();
        };
        $('flg-hide-both').onclick = function () {
            var pre = snap(); doc.showLeft = doc.showRight = false; commit(pre, {}); refreshGeneralPanel();
        };
        $('flg-link').onchange = function () {
            var pre = snap(); doc.linkLogos = this.checked; commit(pre, {});
            if (doc.linkLogos) setStatus('Le regolazioni comuni ora si applicano a entrambi i loghi', '');
        };
        bindDocSlider('flg-margin', function (v) { doc.margin = v; }, { excl: true }, function () { return doc.margin; });
        $('flg-reset-logos').onclick = resetLogos;
        $('flg-reset-excl').onclick = resetExclusions;
        $('flg-reset-green').onclick = resetGreen;
    }

    function bindScreenshotPanel() {
        $('flg-shot-load').onclick = function () { $('flg-shot-file').click(); };
        $('flg-shot-replace').onclick = function () { $('flg-shot-file').click(); };
        $('flg-shot-file').onchange = function () {
            if (this.files && this.files[0]) loadScreenshotFile(this.files[0]);
            this.value = '';
        };
        $('flg-shot-paste').onclick = pasteScreenshot;
        $('flg-shot-remove').onclick = function () {
            if (confirm('Rimuovere lo screenshot di calibrazione?')) removeScreenshot();
        };
    }

    // slider con history corretta: uno stato prima e uno dopo il trascinamento
    var sliderPre = {};
    function bindDocSlider(id, apply, flags, read) {
        var el = $(id);
        if (!el) return;
        el.addEventListener('input', function () {
            if (!(id in sliderPre)) sliderPre[id] = snap();
            apply(parseFloat(el.value));
            var valEl = $(id + '-val');
            if (valEl) valEl.textContent = el.value;
            if (flags && flags.green) { scheduleGreenRecompute(); scheduleAutosave(); requestRender(); }
            else { caches.exclDirty = flags && flags.excl ? true : caches.exclDirty; scheduleAutosave(); requestRender(); }
        });
        el.addEventListener('change', function () {
            var pre = sliderPre[id];
            delete sliderPre[id];
            if (pre != null) commit(pre, flags || {});
        });
    }

    function bindLogoPanel(side) {
        var p = 'flg-' + side + '-';
        var other = side === 'left' ? 'right' : 'left';

        $(p + 'visible').onchange = function () {
            var pre = snap();
            doc[side].visible = this.checked;
            commit(pre, {});
        };

        function linked(apply) {
            return function (v) {
                apply(doc[side], v);
                if (doc.linkLogos) { apply(doc[other], v); refreshLogoPanel(other); }
            };
        }

        bindDocSlider(p + 'opacity', linked(function (d, v) { d.opacity = v / 100; }), {});
        bindDocSlider(p + 'scale', linked(function (d, v) { d.scale = v / 100; }), {});
        bindDocSlider(p + 'feather', linked(function (d, v) { d.feather = v; }), {});
        bindDocSlider(p + 'blur', linked(function (d, v) { d.blur = v; }), {});
        bindDocSlider(p + 'desat', linked(function (d, v) { d.desat = v / 100; }), {});
        bindDocSlider(p + 'fusion', linked(function (d, v) { d.fusion = v / 100; }), {});
        // posizione/rotazione/dimensione: sempre indipendenti
        bindDocSlider(p + 'dx', function (v) { doc[side].dx = v; }, {});
        bindDocSlider(p + 'dy', function (v) { doc[side].dy = v; }, {});
        bindDocSlider(p + 'rot', function (v) { doc[side].rot = v; }, {});
        bindDocSlider(p + 'size', function (v) {
            // "Dimensione" = larghezza di base del quadrilatero (riscala i punti)
            var q = doc[side].quad;
            var c = quadCentroid(q);
            var curW = Math.max(20, (Math.hypot(q[1].x - q[0].x, q[1].y - q[0].y) + Math.hypot(q[2].x - q[3].x, q[2].y - q[3].y)) / 2);
            var k = v / curW;
            doc[side].quad = q.map(function (pt) {
                return { x: c.x + (pt.x - c.x) * k, y: c.y + (pt.y - c.y) * k };
            });
        }, {});

        $(p + 'reset').onclick = function () {
            var pre = snap();
            var q = doc[side].quad;
            doc[side] = Core.defaultLogoParams(side);
            doc[side].quad = q; // il reset del logo non tocca la prospettiva
            commit(pre, {});
            refreshLogoPanel(side);
        };
        $(p + 'resetquad').onclick = function () { resetPerspective(side); };
    }

    function bindGreenPanel() {
        $('flg-green-on').onchange = function () {
            var pre = snap();
            doc.green.enabled = this.checked;
            commit(pre, { green: true, excl: true });
        };
        $('flg-green-sample').onclick = function () { setTool('sample'); };
        bindDocSlider('flg-g-tol', function (v) { doc.green.tol = v / 100; applySampleRanges(); refreshGreenPanel(true); }, { green: true, excl: true });
        bindDocSlider('flg-g-soft', function (v) { doc.green.soft = v / 100; }, { green: true, excl: true });
        bindDocSlider('flg-g-hmin', function (v) { doc.green.hMin = v; }, { green: true, excl: true });
        bindDocSlider('flg-g-hmax', function (v) { doc.green.hMax = v; }, { green: true, excl: true });
        bindDocSlider('flg-g-smin', function (v) { doc.green.sMin = v / 100; }, { green: true, excl: true });
        bindDocSlider('flg-g-smax', function (v) { doc.green.sMax = v / 100; }, { green: true, excl: true });
        bindDocSlider('flg-g-vmin', function (v) { doc.green.vMin = v / 100; }, { green: true, excl: true });
        bindDocSlider('flg-g-vmax', function (v) { doc.green.vMax = v / 100; }, { green: true, excl: true });
        bindDocSlider('flg-g-erode', function (v) { doc.green.erode = v; }, { green: true, excl: true });
        bindDocSlider('flg-g-dilate', function (v) { doc.green.dilate = v; }, { green: true, excl: true });
        bindDocSlider('flg-g-feather', function (v) { doc.green.feather = v; }, { green: true, excl: true });
        bindDocSlider('flg-g-despeckle', function (v) { doc.green.despeckle = v; }, { green: true, excl: true });
        bindDocSlider('flg-g-fill', function (v) { doc.green.fillHoles = v; }, { green: true, excl: true });
    }

    // ---------- REFRESH PANNELLI ----------
    function setVal(id, v, fmt) {
        var el = $(id);
        if (el) el.value = v;
        var valEl = $(id + '-val');
        if (valEl) valEl.textContent = fmt != null ? fmt : v;
    }

    function refreshGeneralPanel() {
        $('flg-enabled').checked = doc.enabled;
        $('flg-show-left').checked = doc.showLeft;
        $('flg-show-right').checked = doc.showRight;
        $('flg-link').checked = doc.linkLogos;
        setVal('flg-margin', doc.margin);
        updatePublishState();
    }

    function refreshScreenshotPanel() {
        var info = $('flg-shot-info');
        if (!info) return;
        info.textContent = screenshotCanvas
            ? 'Screenshot 1920×1080 caricato ✓ (salvato in locale, non appare nell\'output).'
            : 'Nessuno screenshot caricato. Serve solo per la calibrazione: non appare mai nell\'output per vMix.';
    }

    function refreshLogoPanel(side) {
        var p = 'flg-' + side + '-';
        var d = doc[side];
        $(p + 'visible').checked = d.visible;
        setVal(p + 'opacity', Math.round(d.opacity * 100));
        setVal(p + 'scale', Math.round(d.scale * 100));
        setVal(p + 'dx', Math.round(d.dx || 0));
        setVal(p + 'dy', Math.round(d.dy || 0));
        setVal(p + 'rot', d.rot || 0);
        setVal(p + 'feather', d.feather);
        setVal(p + 'blur', d.blur);
        setVal(p + 'desat', Math.round(d.desat * 100));
        setVal(p + 'fusion', Math.round(d.fusion * 100));
        var q = d.quad;
        var wNow = Math.round((Math.hypot(q[1].x - q[0].x, q[1].y - q[0].y) + Math.hypot(q[2].x - q[3].x, q[2].y - q[3].y)) / 2);
        setVal(p + 'size', clamp(wNow, 120, 1400));
    }

    function refreshGreenPanel(skipSliders) {
        $('flg-green-on').checked = doc.green.enabled;
        if (!skipSliders) {
            setVal('flg-g-tol', Math.round(doc.green.tol * 100));
            setVal('flg-g-soft', Math.round(doc.green.soft * 100));
        }
        setVal('flg-g-hmin', Math.round(doc.green.hMin));
        setVal('flg-g-hmax', Math.round(doc.green.hMax));
        setVal('flg-g-smin', Math.round(doc.green.sMin * 100));
        setVal('flg-g-smax', Math.round(doc.green.sMax * 100));
        setVal('flg-g-vmin', Math.round(doc.green.vMin * 100));
        setVal('flg-g-vmax', Math.round(doc.green.vMax * 100));
        setVal('flg-g-erode', doc.green.erode);
        setVal('flg-g-dilate', doc.green.dilate);
        setVal('flg-g-feather', doc.green.feather);
        setVal('flg-g-despeckle', doc.green.despeckle);
        setVal('flg-g-fill', doc.green.fillHoles);
        // campioni
        var wrap = $('flg-green-samples');
        wrap.innerHTML = '';
        doc.green.samples.forEach(function (s, idx) {
            var sw = document.createElement('div');
            sw.className = 'flg-swatch';
            sw.style.background = 'rgb(' + (s.r || 0) + ',' + (s.g || 128) + ',' + (s.b || 0) + ')';
            sw.title = 'Campione ' + (idx + 1) + ' — clicca per rimuovere';
            sw.onclick = function () { removeGreenSample(idx); };
            wrap.appendChild(sw);
        });
    }

    function refreshObjectsPanel() {
        var wrap = $('flg-objects');
        if (!wrap) return;
        wrap.innerHTML = '';
        if (!doc.objects.length) {
            wrap.innerHTML = '<div class="flg-note">Nessun oggetto: disegna con Poligono, Lazo, Rettangolo, Ellisse o Pennello direttamente sopra lo screenshot.</div>';
            requestRender();
            return;
        }
        doc.objects.forEach(function (o, idx) {
            var row = document.createElement('div');
            row.className = 'flg-obj' + (o.id === selectedId ? ' selected' : '') + (o.enabled === false ? ' disabled' : '');
            row.innerHTML =
                '<span class="flg-obj-ico">' + (OBJ_ICONS[o.type] || '❓') + '</span>' +
                '<span class="flg-obj-name" title="Doppio clic per rinominare">' + esc(o.name) + '</span>' +
                '<span class="flg-obj-mode ' + (o.mode === 'restore' ? 'restore' : 'exclude') + '" title="Cambia modalità Escludi/Ripristina">' +
                (o.mode === 'restore' ? 'Ripristina' : 'Escludi') + '</span>' +
                '<span class="flg-obj-target" title="Applica a: entrambi / solo sinistro / solo destro">' +
                (o.target === 'left' ? 'SX' : o.target === 'right' ? 'DX' : '2') + '</span>' +
                '<button class="flg-mini" data-act="up" title="Sposta su (prima)">▲</button>' +
                '<button class="flg-mini" data-act="down" title="Sposta giù (dopo, prevale)">▼</button>' +
                '<button class="flg-mini" data-act="vis" title="Mostra/nascondi">' + (o.visible === false ? '🚫' : '👁') + '</button>' +
                '<button class="flg-mini" data-act="ena" title="Attiva/disattiva">' + (o.enabled === false ? '⭘' : '⏻') + '</button>' +
                '<button class="flg-mini" data-act="lock" title="Blocca/sblocca">' + (o.locked ? '🔒' : '🔓') + '</button>' +
                '<button class="flg-mini" data-act="dup" title="Duplica">⧉</button>' +
                (o.type === 'rect' || o.type === 'ellipse' ? '<button class="flg-mini" data-act="conv" title="Converti in tracciato modificabile">⬠</button>' : '') +
                '<button class="flg-mini warn" data-act="del" title="Elimina">🗑</button>';

            row.onclick = function (e) {
                var act = e.target && e.target.dataset ? e.target.dataset.act : null;
                if (act === 'up') { moveObjectOrder(o.id, -1); return; }
                if (act === 'down') { moveObjectOrder(o.id, 1); return; }
                if (act === 'vis') { toggleObjectFlag(o.id, 'visible'); return; }
                if (act === 'ena') { toggleObjectFlag(o.id, 'enabled'); return; }
                if (act === 'lock') { toggleObjectFlag(o.id, 'locked'); return; }
                if (act === 'dup') { duplicateObject(o.id); return; }
                if (act === 'del') { deleteObject(o.id); return; }
                if (act === 'conv') { convertToPath(o.id); return; }
                if (e.target.classList.contains('flg-obj-mode')) { cycleObjectMode(o.id); return; }
                if (e.target.classList.contains('flg-obj-target')) { cycleObjectTarget(o.id); return; }
                selectedId = o.id;
                selectedVertex = -1;
                refreshObjectsPanel();
                requestRender();
            };
            row.ondblclick = function (e) {
                if (!e.target.classList.contains('flg-obj-name')) return;
                var nameSpan = row.querySelector('.flg-obj-name');
                var inputEl = document.createElement('input');
                inputEl.className = 'flg-obj-rename';
                inputEl.value = o.name;
                nameSpan.replaceWith(inputEl);
                inputEl.focus();
                inputEl.select();
                function done(save) {
                    if (save && inputEl.value.trim()) {
                        var pre = snap();
                        o.name = inputEl.value.trim().slice(0, 60);
                        commit(pre, {});
                    }
                    refreshObjectsPanel();
                }
                inputEl.onblur = function () { done(true); };
                inputEl.onkeydown = function (ev) {
                    if (ev.key === 'Enter') done(true);
                    if (ev.key === 'Escape') done(false);
                    ev.stopPropagation();
                };
            };
            wrap.appendChild(row);
        });
        requestRender();
    }

    function refreshAllPanels() {
        refreshGeneralPanel();
        refreshScreenshotPanel();
        refreshLogoPanel('left');
        refreshLogoPanel('right');
        refreshGreenPanel();
        refreshObjectsPanel();
        refreshTeamTags();
        updateHistButtons();
    }

    // ------------------------------------------------------------
    // APERTURA / CHIUSURA
    // ------------------------------------------------------------
    function openSetup() {
        if (!doc) loadDoc();
        buildUI();
        isOpen = true;
        $('flg-modal').classList.add('open');
        sizeCanvases();
        fitView();
        setTool('select');
        refreshAllPanels();
        restoreScreenshotFromIdb();
        checkApi().then(function (ok) {
            if (ok) setStatus('Server locale rilevato: l\'overlay si aggiorna via rete ✓', 'ok');
        });
        pollTeams();
        if (teamTimer) clearInterval(teamTimer);
        teamTimer = setInterval(pollTeams, 2000);
        requestRender();
    }

    function closeSetup() {
        isOpen = false;
        var m = $('flg-modal');
        if (m) m.classList.remove('open');
        if (teamTimer) { clearInterval(teamTimer); teamTimer = null; }
        if (drawing) drawing = null;
        saveDoc();
    }

    // API pubblica
    global.FieldLogos = {
        openSetup: openSetup,
        closeSetup: closeSetup,
        publish: publishOverlay,
        isOpen: function () { return isOpen; }
    };
})(window);
