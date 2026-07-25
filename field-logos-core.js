/*
 * FIELD-LOGOS-CORE v1.0 — "Loghi sul green"
 *
 * Modulo CONDIVISO tra il setup (streaming.html) e l'output (field-logos-overlay.html).
 * Contiene tutto ciò che deve produrre lo STESSO identico risultato nei due contesti:
 *
 *   - modello/versione della configurazione e del payload pubblicato;
 *   - matematica dell'omografia (corner pin: quadrato unitario → quadrilatero);
 *   - validazione del quadrilatero (convessità, area minima, punti coincidenti);
 *   - riconoscimento del green in HSV (campioni → soglie → morfologia → feather);
 *   - rasterizzazione degli oggetti di esclusione/ripristino (in ordine, con margine);
 *   - warp prospettico del logo (WebGL, con fallback a mesh triangolare 2D);
 *   - compositing finale (logo × maschera green × maschera esclusioni × effetto prato);
 *   - codec della configurazione (deflate+base64url per l'URL overlay);
 *   - risoluzione dei loghi squadra (stessa logica fuzzy GitHub di obs_bar/streaming).
 *
 * Nessuna dipendenza esterna: deve funzionare su GitHub Pages, in Chrome/Edge e
 * nel Browser Input (Chromium/CEF) di vMix. Tutto il lavoro pesante è statico:
 * si ricalcola solo quando cambia qualcosa, mai a 60 fps.
 */
(function (global) {
    'use strict';

    var W = 1920, H = 1080;
    var CONFIG_VERSION = 1;

    // ============================================================
    // MODELLO DI DEFAULT
    // ============================================================

    function defaultLogoParams(side) {
        // Quadrilatero iniziale: trapezio appoggiato "a terra" nella rispettiva metà campo
        var cx = side === 'left' ? 480 : 1440;
        var cy = 700;
        return {
            visible: true,
            opacity: 0.75,          // leggermente trasparente per default
            scale: 1.0,             // scala extra applicata al quadrilatero
            feather: 6,             // px: morbidezza del bordo della maschera
            blur: 0.6,              // px: leggero blur del logo (in spazio logo)
            desat: 0.25,            // 0..1 desaturazione
            fusion: 0.55,           // 0..1 fusione con la trama del prato (da screenshot)
            quad: [                 // TL, TR, BR, BL in coordinate logiche 1920×1080
                { x: cx - 260, y: cy - 110 },
                { x: cx + 260, y: cy - 110 },
                { x: cx + 340, y: cy + 130 },
                { x: cx - 340, y: cy + 130 }
            ]
        };
    }

    function defaultGreen() {
        return {
            enabled: true,
            samples: [],            // [{h,s,v,r,g,b}]
            tol: 1.0,               // moltiplicatore di tolleranza sui range campionati
            soft: 0.12,             // morbidezza della transizione (0..0.5)
            hMin: 60, hMax: 170,    // range HSV correnti (ricalcolati dai campioni)
            sMin: 0.15, sMax: 1,
            vMin: 0.10, vMax: 0.95,
            erode: 0,               // px
            dilate: 0,              // px
            feather: 3,             // px
            despeckle: 2,           // px: rimozione puntini isolati (apertura morfologica)
            fillHoles: 2            // px: riempimento piccoli buchi (chiusura morfologica)
        };
    }

    function defaultDoc() {
        return {
            v: CONFIG_VERSION,
            enabled: true,
            showLeft: true,
            showRight: true,
            linkLogos: false,       // "Modifica entrambi i loghi"
            margin: 0,              // margine esclusioni (px, può essere negativo)
            left: defaultLogoParams('left'),
            right: defaultLogoParams('right'),
            green: defaultGreen(),
            objects: [],            // oggetti di esclusione/ripristino, in ordine di composizione
            updatedAt: 0
        };
    }

    // ============================================================
    // OMOGRAFIA (corner pin)
    // ============================================================

    // Heckbert: quadrato unitario (0,0)(1,0)(1,1)(0,1) → quad [TL,TR,BR,BL].
    // Matrice 3×3 row-major [a b c; d e f; g h 1].
    function squareToQuad(q) {
        var x0 = q[0].x, y0 = q[0].y, x1 = q[1].x, y1 = q[1].y;
        var x2 = q[2].x, y2 = q[2].y, x3 = q[3].x, y3 = q[3].y;
        var sx = x0 - x1 + x2 - x3;
        var sy = y0 - y1 + y2 - y3;
        if (Math.abs(sx) < 1e-9 && Math.abs(sy) < 1e-9) {
            return [x1 - x0, x3 - x0, x0, y1 - y0, y3 - y0, y0, 0, 0, 1];
        }
        var dx1 = x1 - x2, dy1 = y1 - y2, dx2 = x3 - x2, dy2 = y3 - y2;
        var den = dx1 * dy2 - dx2 * dy1;
        if (Math.abs(den) < 1e-12) return null;
        var g = (sx * dy2 - sy * dx2) / den;
        var h = (dx1 * sy - dy1 * sx) / den;
        var a = x1 - x0 + g * x1, b = x3 - x0 + h * x3, c = x0;
        var d = y1 - y0 + g * y1, e = y3 - y0 + h * y3, f = y0;
        return [a, b, c, d, e, f, g, h, 1];
    }

    function invert3(m) {
        var a = m[0], b = m[1], c = m[2], d = m[3], e = m[4], f = m[5], g = m[6], h = m[7], i = m[8];
        var A = e * i - f * h, B = c * h - b * i, C = b * f - c * e;
        var D = f * g - d * i, E = a * i - c * g, F = c * d - a * f;
        var G = d * h - e * g, Hh = b * g - a * h, I = a * e - b * d;
        var det = a * A + b * D + c * G;
        if (Math.abs(det) < 1e-12) return null;
        var s = 1 / det;
        return [A * s, B * s, C * s, D * s, E * s, F * s, G * s, Hh * s, I * s];
    }

    function applyH(m, x, y) {
        var w = m[6] * x + m[7] * y + m[8];
        if (Math.abs(w) < 1e-12) w = 1e-12;
        return { x: (m[0] * x + m[1] * y + m[2]) / w, y: (m[3] * x + m[4] * y + m[5]) / w };
    }

    // Validazione: punti distinti, quadrilatero convesso non auto-intersecante
    // (verso orario TL→TR→BR→BL), area minima. Ritorna {ok, reason}.
    function validateQuad(q) {
        var i, j;
        for (i = 0; i < 4; i++) {
            for (j = i + 1; j < 4; j++) {
                var dx = q[i].x - q[j].x, dy = q[i].y - q[j].y;
                if (dx * dx + dy * dy < 9) return { ok: false, reason: 'Punti prospettici sovrapposti' };
            }
        }
        var area = 0, sign = 0;
        for (i = 0; i < 4; i++) {
            var p0 = q[i], p1 = q[(i + 1) % 4], p2 = q[(i + 2) % 4];
            var cross = (p1.x - p0.x) * (p2.y - p1.y) - (p1.y - p0.y) * (p2.x - p1.x);
            if (cross !== 0) {
                var s = cross > 0 ? 1 : -1;
                if (sign === 0) sign = s;
                else if (s !== sign) return { ok: false, reason: 'Quadrilatero auto-intersecante o concavo' };
            }
            area += p0.x * p1.y - p1.x * p0.y;
        }
        if (Math.abs(area / 2) < 400) return { ok: false, reason: 'Area del quadrilatero quasi nulla' };
        return { ok: true };
    }

    // Applica la scala extra del logo attorno al baricentro del quadrilatero
    function scaledQuad(quad, scale) {
        if (!scale || scale === 1) return quad;
        var cx = 0, cy = 0, k;
        for (k = 0; k < 4; k++) { cx += quad[k].x / 4; cy += quad[k].y / 4; }
        return quad.map(function (p) {
            return { x: cx + (p.x - cx) * scale, y: cy + (p.y - cy) * scale };
        });
    }

    // Adatta il rapporto del logo dentro il quadrilatero SENZA deformarlo prima
    // del warp: il logo viene centrato in "letterbox" nello spazio unitario.
    // Ritorna i sub-range u/v da usare come area utile della texture.
    function logoFitUV(logoW, logoH, quad) {
        // Stima del rapporto del quadrilatero a terra: media dei lati opposti
        var topLen = Math.hypot(quad[1].x - quad[0].x, quad[1].y - quad[0].y);
        var botLen = Math.hypot(quad[2].x - quad[3].x, quad[2].y - quad[3].y);
        var leftLen = Math.hypot(quad[3].x - quad[0].x, quad[3].y - quad[0].y);
        var rightLen = Math.hypot(quad[2].x - quad[1].x, quad[2].y - quad[1].y);
        var quadAR = ((topLen + botLen) / 2) / Math.max(1, (leftLen + rightLen) / 2);
        var logoAR = logoW / Math.max(1, logoH);
        var u0 = 0, v0 = 0, u1 = 1, v1 = 1;
        if (logoAR > quadAR) {
            // logo più largo: bande sopra/sotto
            var vs = quadAR / logoAR;
            v0 = (1 - vs) / 2; v1 = 1 - v0;
        } else {
            var us = logoAR / quadAR;
            u0 = (1 - us) / 2; u1 = 1 - u0;
        }
        return { u0: u0, v0: v0, u1: u1, v1: v1 };
    }

    // ============================================================
    // COLORE / HSV
    // ============================================================

    function rgbToHsv(r, g, b) {
        r /= 255; g /= 255; b /= 255;
        var max = Math.max(r, g, b), min = Math.min(r, g, b);
        var d = max - min, h = 0;
        if (d > 0) {
            if (max === r) h = 60 * (((g - b) / d) % 6);
            else if (max === g) h = 60 * ((b - r) / d + 2);
            else h = 60 * ((r - g) / d + 4);
        }
        if (h < 0) h += 360;
        return { h: h, s: max === 0 ? 0 : d / max, v: max };
    }

    // Range dai campioni: media circolare della tonalità + deviazione massima,
    // min/max di saturazione e luminosità, il tutto espanso dalla tolleranza.
    function rangesFromSamples(samples, tol) {
        if (!samples || !samples.length) return null;
        var sumX = 0, sumY = 0, i, s;
        for (i = 0; i < samples.length; i++) {
            var rad = samples[i].h * Math.PI / 180;
            sumX += Math.cos(rad); sumY += Math.sin(rad);
        }
        var meanH = Math.atan2(sumY, sumX) * 180 / Math.PI;
        if (meanH < 0) meanH += 360;
        var maxDev = 0, sMin = 1, sMax = 0, vMin = 1, vMax = 0;
        for (i = 0; i < samples.length; i++) {
            s = samples[i];
            var dev = Math.abs(((s.h - meanH + 540) % 360) - 180);
            if (dev > maxDev) maxDev = dev;
            if (s.s < sMin) sMin = s.s;
            if (s.s > sMax) sMax = s.s;
            if (s.v < vMin) vMin = s.v;
            if (s.v > vMax) vMax = s.v;
        }
        var hPad = (maxDev + 8) * tol;
        var sPad = 0.06 + 0.10 * (tol - 1) + (sMax - sMin) * 0.15;
        var vPad = 0.06 + 0.10 * (tol - 1) + (vMax - vMin) * 0.15;
        return {
            hMin: (meanH - hPad + 360) % 360,
            hMax: (meanH + hPad) % 360,
            sMin: Math.max(0, sMin - sPad),
            sMax: Math.min(1, sMax + sPad),
            vMin: Math.max(0, vMin - vPad),
            vMax: Math.min(1, vMax + vPad)
        };
    }

    // ============================================================
    // MORFOLOGIA SEPARABILE (finestre min/max O(n) + box blur)
    // ============================================================

    // Min/max separabile. Entrambe le passate scorrono la memoria in modo
    // sequenziale (la passata verticale combina righe intere): è questo, più
    // dell'algoritmo, a decidere i tempi su maschere da 2 milioni di pixel.
    function minMaxHorizontal(src, dst, w, h, radius, isMax) {
        for (var y = 0; y < h; y++) {
            var base = y * w;
            for (var i = 0; i < w; i++) {
                var lo = i - radius; if (lo < 0) lo = 0;
                var hi = i + radius; if (hi >= w) hi = w - 1;
                var m = src[base + lo];
                for (var j = lo + 1; j <= hi; j++) {
                    var v = src[base + j];
                    if (isMax ? v > m : v < m) m = v;
                }
                dst[base + i] = m;
            }
        }
    }

    function minMaxVertical(src, dst, w, h, radius, isMax) {
        for (var y = 0; y < h; y++) {
            var lo = y - radius; if (lo < 0) lo = 0;
            var hi = y + radius; if (hi >= h) hi = h - 1;
            var out = y * w, rowLo = lo * w, x;
            for (x = 0; x < w; x++) dst[out + x] = src[rowLo + x];
            for (var j = lo + 1; j <= hi; j++) {
                var row = j * w;
                if (isMax) {
                    for (x = 0; x < w; x++) { var v = src[row + x]; if (v > dst[out + x]) dst[out + x] = v; }
                } else {
                    for (x = 0; x < w; x++) { var v2 = src[row + x]; if (v2 < dst[out + x]) dst[out + x] = v2; }
                }
            }
        }
    }

    function morph(mask, w, h, radius, isDilate) {
        if (radius <= 0) return mask;
        radius = Math.round(radius);
        var tmp = new Uint8Array(w * h);
        var out = new Uint8Array(w * h);
        minMaxHorizontal(mask, tmp, w, h, radius, isDilate);
        minMaxVertical(tmp, out, w, h, radius, isDilate);
        return out;
    }

    function boxBlurPass(src, dst, w, h, radius, horizontal) {
        var div = radius * 2 + 1;
        var i, x, y;
        if (horizontal) {
            for (y = 0; y < h; y++) {
                var base = y * w, acc = 0;
                for (i = -radius; i <= radius; i++) {
                    acc += src[base + Math.min(w - 1, Math.max(0, i))];
                }
                for (i = 0; i < w; i++) {
                    dst[base + i] = acc / div;
                    var addI = i + radius + 1; if (addI >= w) addI = w - 1;
                    var subI = i - radius; if (subI < 0) subI = 0;
                    acc += src[base + addI] - src[base + subI];
                }
            }
        } else {
            // verticale con accumulatore per riga: memoria sempre sequenziale
            var acc2 = new Float64Array(w);
            for (i = -radius; i <= radius; i++) {
                var ci = Math.min(h - 1, Math.max(0, i)) * w;
                for (x = 0; x < w; x++) acc2[x] += src[ci + x];
            }
            for (y = 0; y < h; y++) {
                var out = y * w;
                for (x = 0; x < w; x++) dst[out + x] = acc2[x] / div;
                var addY = y + radius + 1; if (addY >= h) addY = h - 1;
                var subY = y - radius; if (subY < 0) subY = 0;
                var aB = addY * w, sB = subY * w;
                for (x = 0; x < w; x++) acc2[x] += src[aB + x] - src[sB + x];
            }
        }
    }

    function blurMask(mask, w, h, radius) {
        if (radius <= 0) return mask;
        radius = Math.max(1, Math.round(radius));
        var a = new Float32Array(mask);
        var b = new Float32Array(w * h);
        // 2 passaggi di box blur ≈ gaussiana (sufficiente per una maschera)
        for (var p = 0; p < 2; p++) {
            boxBlurPass(a, b, w, h, radius, true);
            boxBlurPass(b, a, w, h, radius, false);
        }
        var out = new Uint8Array(w * h);
        for (var i = 0; i < w * h; i++) out[i] = a[i];
        return out;
    }

    // ============================================================
    // MASCHERA GREEN
    // ============================================================

    function hueScore(h, hMin, hMax, softDeg) {
        // range circolare: se hMin>hMax il range attraversa 0°
        var inside;
        if (hMin <= hMax) inside = h >= hMin && h <= hMax;
        else inside = h >= hMin || h <= hMax;
        if (inside) return 1;
        var dMin = Math.min(Math.abs(((h - hMin + 540) % 360) - 180), Math.abs(((h - hMax + 540) % 360) - 180));
        return Math.max(0, 1 - dMin / Math.max(1, softDeg));
    }

    function linScore(v, min, max, soft) {
        if (v >= min && v <= max) return 1;
        var d = v < min ? min - v : v - max;
        return Math.max(0, 1 - d / Math.max(0.001, soft));
    }

    // Calcola la maschera del green (0..255) dallo screenshot. Operazione una
    // tantum sullo screenshot statico: MAI chiamata nel loop di rendering.
    function computeGreenMask(imageData, green) {
        var w = imageData.width, h = imageData.height;
        var data = imageData.data;
        var mask = new Uint8Array(w * h);
        var softDeg = Math.max(2, green.soft * 120);
        var softLin = Math.max(0.02, green.soft);
        // HSV calcolato inline: niente allocazioni nel loop da 2 milioni di pixel
        for (var i = 0, px = 0; px < w * h; px++, i += 4) {
            var r = data[i] / 255, g = data[i + 1] / 255, b = data[i + 2] / 255;
            var max = r > g ? (r > b ? r : b) : (g > b ? g : b);
            var min = r < g ? (r < b ? r : b) : (g < b ? g : b);
            var d = max - min, hue = 0;
            if (d > 0) {
                if (max === r) hue = 60 * (((g - b) / d) % 6);
                else if (max === g) hue = 60 * ((b - r) / d + 2);
                else hue = 60 * ((r - g) / d + 4);
                if (hue < 0) hue += 360;
            }
            var score = hueScore(hue, green.hMin, green.hMax, softDeg);
            if (score > 0) {
                var s2 = linScore(max === 0 ? 0 : d / max, green.sMin, green.sMax, softLin);
                if (s2 < score) score = s2;
                if (score > 0) {
                    var s3 = linScore(max, green.vMin, green.vMax, softLin);
                    if (s3 < score) score = s3;
                }
            }
            mask[px] = score * 255;
        }
        // Morfologia (pulizia → riempimento → regolazioni utente). Le operazioni
        // consecutive dello stesso tipo vengono fuse (dilate a + dilate b =
        // dilate a+b): meno passate sulla maschera intera.
        var ops = [];
        if (green.despeckle > 0) { ops.push(-green.despeckle, green.despeckle); }
        if (green.fillHoles > 0) { ops.push(green.fillHoles, -green.fillHoles); }
        if (green.erode > 0) ops.push(-green.erode);
        if (green.dilate > 0) ops.push(green.dilate);
        var merged = [];
        ops.forEach(function (r) {
            if (merged.length && (merged[merged.length - 1] > 0) === (r > 0)) merged[merged.length - 1] += r;
            else merged.push(r);
        });
        merged.forEach(function (r) { mask = morph(mask, w, h, Math.abs(r), r > 0); });
        if (green.feather > 0) mask = blurMask(mask, w, h, green.feather);
        return mask; // Uint8Array w*h
    }

    // ============================================================
    // OGGETTI DI ESCLUSIONE — geometria e rasterizzazione
    // ============================================================

    function makeCanvas(w, h) {
        var c = document.createElement('canvas');
        c.width = w; c.height = h;
        return c;
    }

    // Path2D dell'oggetto in coordinate logiche (senza margine)
    function objectPath(obj) {
        var path = new Path2D();
        var i;
        if (obj.type === 'rect' || obj.type === 'ellipse') {
            var r = obj.rect;
            var cos = Math.cos(r.rot || 0), sin = Math.sin(r.rot || 0);
            var m = new DOMMatrix([cos, sin, -sin, cos, r.cx, r.cy]);
            var local = new Path2D();
            if (obj.type === 'rect') local.rect(-r.w / 2, -r.h / 2, r.w, r.h);
            else local.ellipse(0, 0, Math.abs(r.w / 2), Math.abs(r.h / 2), 0, 0, Math.PI * 2);
            path.addPath(local, m);
        } else if (obj.points && obj.points.length) {
            path.moveTo(obj.points[0].x, obj.points[0].y);
            for (i = 1; i < obj.points.length; i++) path.lineTo(obj.points[i].x, obj.points[i].y);
            if (obj.type !== 'brush') path.closePath();
        }
        return path;
    }

    function objectMatchesSide(obj, side) {
        var t = obj.target || 'both';
        return t === 'both' || t === side;
    }

    // Stampa un singolo oggetto (bianco pieno, bordi eventualmente morbidi,
    // margine applicato) su un canvas di lavoro trasparente.
    function stampObject(scratch, obj, margin) {
        var ctx = scratch.getContext('2d');
        ctx.setTransform(1, 0, 0, 1, 0, 0);
        ctx.clearRect(0, 0, scratch.width, scratch.height);
        ctx.fillStyle = '#fff';
        ctx.strokeStyle = '#fff';
        ctx.lineJoin = 'round';
        ctx.lineCap = 'round';

        var isExclude = obj.mode !== 'restore';
        var m = isExclude ? (margin || 0) : 0; // il margine allarga solo le esclusioni
        var soft = 0;

        if (obj.type === 'brush') {
            var radius = Math.max(1, (obj.brush && obj.brush.radius) || 20);
            var hardness = obj.brush && typeof obj.brush.hardness === 'number' ? obj.brush.hardness : 1;
            soft = radius * (1 - hardness);
            var width = Math.max(1, radius * 2 + m * 2);
            var path = objectPath(obj);
            ctx.lineWidth = width;
            if (obj.points.length === 1) {
                ctx.beginPath();
                ctx.arc(obj.points[0].x, obj.points[0].y, width / 2, 0, Math.PI * 2);
                ctx.fill();
            } else {
                ctx.stroke(path);
            }
        } else {
            var p = objectPath(obj);
            ctx.fill(p);
            if (m > 0) { ctx.lineWidth = m * 2; ctx.stroke(p); }
            else if (m < 0) {
                // margine negativo: restringe la forma erodendo il bordo
                ctx.globalCompositeOperation = 'destination-out';
                ctx.lineWidth = Math.abs(m) * 2;
                ctx.stroke(p);
                ctx.globalCompositeOperation = 'source-over';
            }
        }

        if (soft > 0.5) {
            // Bordo morbido del pennello: sfoca la stampa in un passaggio extra
            var tmp = makeCanvas(scratch.width, scratch.height);
            var tctx = tmp.getContext('2d');
            tctx.filter = 'blur(' + soft.toFixed(1) + 'px)';
            tctx.drawImage(scratch, 0, 0);
            ctx.clearRect(0, 0, scratch.width, scratch.height);
            ctx.drawImage(tmp, 0, 0);
        }
    }

    // Maschera esclusioni per un lato: canvas W×H dove ALPHA = zona consentita.
    // Gli oggetti vengono eseguiti nell'ordine dell'elenco: Escludi rimuove,
    // Ripristina riaggiunge. L'ultima operazione prevale sulle precedenti.
    function rasterizeExclusions(objects, side, margin, w, h) {
        w = w || W; h = h || H;
        var out = makeCanvas(w, h);
        var ctx = out.getContext('2d');
        ctx.fillStyle = '#fff';
        ctx.fillRect(0, 0, w, h);
        if (!objects || !objects.length) return out;
        var scratch = makeCanvas(w, h);
        for (var i = 0; i < objects.length; i++) {
            var obj = objects[i];
            if (!obj || obj.enabled === false || obj.visible === false) continue;
            if (!objectMatchesSide(obj, side)) continue;
            stampObject(scratch, obj, margin);
            ctx.globalCompositeOperation = obj.mode === 'restore' ? 'source-over' : 'destination-out';
            ctx.drawImage(scratch, 0, 0);
        }
        ctx.globalCompositeOperation = 'source-over';
        return out;
    }

    // Combina green (Uint8Array|null) × esclusioni (canvas) in un canvas la cui
    // ALPHA è la maschera finale del lato richiesto.
    function combineMasks(greenMask, exclusionCanvas, w, h) {
        w = w || W; h = h || H;
        var out = makeCanvas(w, h);
        var ctx = out.getContext('2d');
        var img = ctx.createImageData(w, h);
        var data = img.data;
        var exData = exclusionCanvas.getContext('2d').getImageData(0, 0, w, h).data;
        for (var px = 0, i = 3; px < w * h; px++, i += 4) {
            var a = exData[i];
            if (greenMask) a = (a * greenMask[px]) / 255;
            data[i] = a;
            data[i - 1] = 255; data[i - 2] = 255; data[i - 3] = 255;
        }
        ctx.putImageData(img, 0, 0);
        return out;
    }

    // ============================================================
    // WARP PROSPETTICO (WebGL con fallback mesh 2D)
    // ============================================================

    var VERT_SRC =
        'attribute vec2 aPos;\n' +
        'varying vec2 vPix;\n' +
        'uniform vec2 uSize;\n' +
        'void main(){\n' +
        '  vPix = (aPos * 0.5 + 0.5) * uSize;\n' +
        '  gl_Position = vec4(aPos.x, -aPos.y, 0.0, 1.0);\n' + // y giù = riga in alto
        '}';

    var FRAG_SRC =
        'precision highp float;\n' +
        'varying vec2 vPix;\n' +
        'uniform sampler2D uTex;\n' +
        'uniform mat3 uHinv;\n' +
        'uniform vec4 uUV;\n' + // sub-range u0,v0,u1,v1 (letterbox del logo)
        'void main(){\n' +
        '  vec3 p = uHinv * vec3(vPix, 1.0);\n' +
        '  if (p.z <= 0.0) { gl_FragColor = vec4(0.0); return; }\n' +
        '  vec2 uv = p.xy / p.z;\n' +
        '  if (uv.x < uUV.x || uv.y < uUV.y || uv.x > uUV.z || uv.y > uUV.w) { gl_FragColor = vec4(0.0); return; }\n' +
        '  vec2 tuv = vec2((uv.x - uUV.x) / (uUV.z - uUV.x), (uv.y - uUV.y) / (uUV.w - uUV.y));\n' +
        '  gl_FragColor = texture2D(uTex, tuv);\n' +
        '}';

    function createWarper() {
        var glCanvas = makeCanvas(W, H);
        var gl = null, prog = null, texture = null, uHinv = null, uUV = null, uSize = null;

        try {
            gl = glCanvas.getContext('webgl2', { alpha: true, premultipliedAlpha: true, preserveDrawingBuffer: true }) ||
                glCanvas.getContext('webgl', { alpha: true, premultipliedAlpha: true, preserveDrawingBuffer: true });
        } catch (e) { gl = null; }

        if (gl) {
            try {
                function compile(type, src) {
                    var sh = gl.createShader(type);
                    gl.shaderSource(sh, src);
                    gl.compileShader(sh);
                    if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(sh));
                    return sh;
                }
                prog = gl.createProgram();
                gl.attachShader(prog, compile(gl.VERTEX_SHADER, VERT_SRC));
                gl.attachShader(prog, compile(gl.FRAGMENT_SHADER, FRAG_SRC));
                gl.linkProgram(prog);
                if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(prog));
                gl.useProgram(prog);
                var buf = gl.createBuffer();
                gl.bindBuffer(gl.ARRAY_BUFFER, buf);
                gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
                var aPos = gl.getAttribLocation(prog, 'aPos');
                gl.enableVertexAttribArray(aPos);
                gl.vertexAttribPointer(aPos, 2, gl.FLOAT, false, 0, 0);
                uHinv = gl.getUniformLocation(prog, 'uHinv');
                uUV = gl.getUniformLocation(prog, 'uUV');
                uSize = gl.getUniformLocation(prog, 'uSize');
                gl.uniform2f(uSize, W, H);
                texture = gl.createTexture();
                gl.bindTexture(gl.TEXTURE_2D, texture);
                gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
                gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
                gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
                gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
                gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, true);
                gl.disable(gl.BLEND);
                gl.disable(gl.DEPTH_TEST);
                gl.viewport(0, 0, W, H);
            } catch (e) {
                console.warn('[FieldLogos] WebGL non disponibile, uso il fallback 2D:', e.message);
                gl = null;
            }
        }

        // Fallback: mesh di triangoli con trasformazioni affini locali.
        function meshWarp(src, Hm, fit, outCtx) {
            var N = 44; // suddivisione sufficiente a rendere invisibile l'errore affine
            var sw = src.width, sh = src.height;
            var uSpan = fit.u1 - fit.u0, vSpan = fit.v1 - fit.v0;
            for (var row = 0; row < N; row++) {
                for (var col = 0; col < N; col++) {
                    var u0 = fit.u0 + uSpan * col / N, u1 = fit.u0 + uSpan * (col + 1) / N;
                    var v0 = fit.v0 + vSpan * row / N, v1 = fit.v0 + vSpan * (row + 1) / N;
                    var p00 = applyH(Hm, u0, v0), p10 = applyH(Hm, u1, v0);
                    var p01 = applyH(Hm, u0, v1), p11 = applyH(Hm, u1, v1);
                    var s00 = { x: sw * col / N, y: sh * row / N };
                    var s10 = { x: sw * (col + 1) / N, y: sh * row / N };
                    var s01 = { x: sw * col / N, y: sh * (row + 1) / N };
                    var s11 = { x: sw * (col + 1) / N, y: sh * (row + 1) / N };
                    drawTri(outCtx, src, s00, s10, s11, p00, p10, p11);
                    drawTri(outCtx, src, s00, s11, s01, p00, p11, p01);
                }
            }
        }

        function drawTri(ctx, img, s0, s1, s2, d0, d1, d2) {
            var denom = s0.x * (s1.y - s2.y) + s1.x * (s2.y - s0.y) + s2.x * (s0.y - s1.y);
            if (Math.abs(denom) < 1e-9) return;
            var a = (d0.x * (s1.y - s2.y) + d1.x * (s2.y - s0.y) + d2.x * (s0.y - s1.y)) / denom;
            var b = (d0.y * (s1.y - s2.y) + d1.y * (s2.y - s0.y) + d2.y * (s0.y - s1.y)) / denom;
            var c = (d0.x * (s2.x - s1.x) + d1.x * (s0.x - s2.x) + d2.x * (s1.x - s0.x)) / denom;
            var d = (d0.y * (s2.x - s1.x) + d1.y * (s0.x - s2.x) + d2.y * (s1.x - s0.x)) / denom;
            var e = d0.x - a * s0.x - c * s0.y;
            var f = d0.y - b * s0.x - d * s0.y;
            ctx.save();
            ctx.beginPath();
            // centroide leggermente espanso per coprire le cuciture tra triangoli
            var cx = (d0.x + d1.x + d2.x) / 3, cy = (d0.y + d1.y + d2.y) / 3;
            var g = 0.35;
            ctx.moveTo(d0.x + (d0.x - cx > 0 ? g : -g), d0.y + (d0.y - cy > 0 ? g : -g));
            ctx.lineTo(d1.x + (d1.x - cx > 0 ? g : -g), d1.y + (d1.y - cy > 0 ? g : -g));
            ctx.lineTo(d2.x + (d2.x - cx > 0 ? g : -g), d2.y + (d2.y - cy > 0 ? g : -g));
            ctx.closePath();
            ctx.clip();
            ctx.setTransform(a, b, c, d, e, f);
            ctx.drawImage(img, 0, 0);
            ctx.restore();
            ctx.setTransform(1, 0, 0, 1, 0, 0);
        }

        return {
            usesWebGL: !!gl,
            // Disegna src deformato secondo il quad sul canvas di output (W×H, pulito prima)
            warp: function (src, quad, fit, outCanvas) {
                var Hm = squareToQuad(quad);
                if (!Hm) return false;
                var outCtx = outCanvas.getContext('2d');
                outCtx.setTransform(1, 0, 0, 1, 0, 0);
                outCtx.clearRect(0, 0, outCanvas.width, outCanvas.height);
                if (gl) {
                    var Hinv = invert3(Hm);
                    if (!Hinv) return false;
                    gl.bindTexture(gl.TEXTURE_2D, texture);
                    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, src);
                    // colonna-major per GLSL
                    gl.uniformMatrix3fv(uHinv, false, [
                        Hinv[0], Hinv[3], Hinv[6],
                        Hinv[1], Hinv[4], Hinv[7],
                        Hinv[2], Hinv[5], Hinv[8]
                    ]);
                    gl.uniform4f(uUV, fit.u0, fit.v0, fit.u1, fit.v1);
                    gl.clearColor(0, 0, 0, 0);
                    gl.clear(gl.COLOR_BUFFER_BIT);
                    gl.drawArrays(gl.TRIANGLES, 0, 3);
                    outCtx.drawImage(glCanvas, 0, 0);
                } else {
                    meshWarp(src, Hm, fit, outCtx);
                }
                return true;
            },
            destroy: function () {
                if (gl) {
                    try {
                        var ext = gl.getExtension('WEBGL_lose_context');
                        if (ext) ext.loseContext();
                    } catch (e) { }
                }
                gl = null;
            }
        };
    }

    // ============================================================
    // RENDERER (compositing completo, condiviso preview/output)
    // ============================================================

    // model = {
    //   left / right: { image, quad, scale, opacity, feather, blur, desat, fusion, visible },
    //   maskLeft, maskRight: canvas con alpha = maschera (o null),
    //   shade: canvas "trama prato" (o null),
    //   featherBaked: true se le maschere arrivano già sfumate (overlay)
    // }
    function createRenderer() {
        var warper = createWarper();
        var srcCanvas = makeCanvas(16, 16);
        var warpCanvas = makeCanvas(W, H);
        var sideCanvas = makeCanvas(W, H);
        var featherCache = { left: null, right: null }; // {key, canvas}

        function prepareSource(image, params) {
            var iw = image.naturalWidth || image.width;
            var ih = image.naturalHeight || image.height;
            if (!iw || !ih) return null;
            var maxDim = 1024;
            var k = Math.min(1, maxDim / Math.max(iw, ih));
            var sw = Math.max(2, Math.round(iw * k));
            var sh = Math.max(2, Math.round(ih * k));
            if (srcCanvas.width !== sw || srcCanvas.height !== sh) {
                srcCanvas.width = sw; srcCanvas.height = sh;
            }
            var ctx = srcCanvas.getContext('2d');
            ctx.setTransform(1, 0, 0, 1, 0, 0);
            ctx.clearRect(0, 0, sw, sh);
            var filters = [];
            if (params.desat > 0) filters.push('saturate(' + (1 - Math.min(1, params.desat)).toFixed(3) + ')');
            if (params.blur > 0) filters.push('blur(' + (params.blur * sw / 640).toFixed(2) + 'px)');
            ctx.filter = filters.length ? filters.join(' ') : 'none';
            ctx.drawImage(image, 0, 0, sw, sh);
            ctx.filter = 'none';
            return { w: iw, h: ih };
        }

        function featheredMask(side, maskCanvas, featherPx) {
            if (!maskCanvas) return null;
            if (featherPx <= 0) return maskCanvas;
            var key = featherPx + ':' + maskCanvas.width + ':' + (maskCanvas.__rev || 0);
            var cached = featherCache[side];
            if (cached && cached.key === key && cached.src === maskCanvas) return cached.canvas;
            var out = makeCanvas(maskCanvas.width, maskCanvas.height);
            var ctx = out.getContext('2d');
            ctx.filter = 'blur(' + featherPx + 'px)';
            ctx.drawImage(maskCanvas, 0, 0);
            ctx.filter = 'none';
            featherCache[side] = { key: key, src: maskCanvas, canvas: out };
            return out;
        }

        function renderSide(targetCtx, side, model) {
            var p = side === 'left' ? model.left : model.right;
            if (!p || !p.visible || !p.image) return;
            var quad = scaledQuad(p.quad, p.scale || 1);
            var check = validateQuad(quad);
            if (!check.ok) { console.warn('[FieldLogos] Quadrilatero ' + side + ' non valido: ' + check.reason); return; }
            var dims = prepareSource(p.image, p);
            if (!dims) return;
            var fit = logoFitUV(dims.w, dims.h, quad);
            if (!warper.warp(srcCanvas, quad, fit, warpCanvas)) return;

            var ctx = sideCanvas.getContext('2d');
            ctx.setTransform(1, 0, 0, 1, 0, 0);
            ctx.globalCompositeOperation = 'source-over';
            ctx.globalAlpha = 1;
            ctx.clearRect(0, 0, W, H);
            ctx.drawImage(warpCanvas, 0, 0);

            // Fusione con il prato: modula il logo con la trama reale dell'erba
            // (luminanza dello screenshot, telecamera fissa) preservando l'alpha.
            if (model.shade && p.fusion > 0) {
                ctx.globalCompositeOperation = 'multiply';
                ctx.globalAlpha = Math.min(1, p.fusion);
                ctx.drawImage(model.shade, 0, 0, W, H);
                ctx.globalAlpha = 1;
                ctx.globalCompositeOperation = 'destination-in';
                ctx.drawImage(warpCanvas, 0, 0);
            }

            // Maschera green × esclusioni (già combinate a monte)
            var mask = side === 'left' ? model.maskLeft : model.maskRight;
            if (mask) {
                var fm = model.featherBaked ? mask : featheredMask(side, mask, p.feather || 0);
                ctx.globalCompositeOperation = 'destination-in';
                ctx.drawImage(fm, 0, 0, W, H);
            }
            ctx.globalCompositeOperation = 'source-over';

            targetCtx.globalAlpha = Math.max(0, Math.min(1, p.opacity));
            targetCtx.drawImage(sideCanvas, 0, 0);
            targetCtx.globalAlpha = 1;
        }

        return {
            usesWebGL: warper.usesWebGL,
            render: function (targetCtx, model) {
                targetCtx.setTransform(1, 0, 0, 1, 0, 0);
                targetCtx.clearRect(0, 0, W, H);
                renderSide(targetCtx, 'left', model);
                renderSide(targetCtx, 'right', model);
            },
            destroy: function () { warper.destroy(); }
        };
    }

    // ============================================================
    // TRAMA PRATO (shade) dallo screenshot
    // ============================================================

    // Luminanza normalizzata attorno al grigio medio: moltiplicarla per il logo
    // trasferisce fili d'erba/ombre senza scurire complessivamente l'immagine.
    function buildShade(screenshotCanvas) {
        var w = W, h = H;
        var c = makeCanvas(w, h);
        var ctx = c.getContext('2d');
        ctx.drawImage(screenshotCanvas, 0, 0, w, h);
        var img = ctx.getImageData(0, 0, w, h);
        var d = img.data;
        var sum = 0, px;
        var n = w * h;
        for (px = 0; px < n; px++) {
            var i = px * 4;
            var l = (d[i] * 0.299 + d[i + 1] * 0.587 + d[i + 2] * 0.114);
            d[i] = l; sum += l;
        }
        var mean = Math.max(30, sum / n);
        for (px = 0; px < n; px++) {
            var j = px * 4;
            var val = Math.max(0, Math.min(255, 128 * d[j] / mean));
            d[j] = d[j + 1] = d[j + 2] = val;
            d[j + 3] = 255;
        }
        ctx.putImageData(img, 0, 0);
        return c;
    }

    // ============================================================
    // SERIALIZZAZIONE MASCHERE (per il payload pubblicato)
    // ============================================================

    // canvas con alpha=maschera → dataURL WebP in scala di grigi
    function maskToDataUrl(maskCanvas, outW, outH, quality) {
        var c = makeCanvas(outW, outH);
        var ctx = c.getContext('2d');
        ctx.fillStyle = '#000';
        ctx.fillRect(0, 0, outW, outH);
        // il bianco pieno filtrato dall'alpha della maschera dà il grigio giusto
        ctx.drawImage(maskCanvas, 0, 0, outW, outH);
        var url = c.toDataURL('image/webp', quality);
        if (url.indexOf('image/webp') === -1) url = c.toDataURL('image/png');
        return url;
    }

    // dataURL grigia → canvas W×H con alpha=luminanza
    function dataUrlToAlphaMask(dataUrl) {
        return new Promise(function (resolve, reject) {
            var img = new Image();
            img.onload = function () {
                try {
                    var c = makeCanvas(W, H);
                    var ctx = c.getContext('2d');
                    ctx.drawImage(img, 0, 0, W, H);
                    var id = ctx.getImageData(0, 0, W, H);
                    var d = id.data;
                    for (var px = 0; px < W * H; px++) {
                        var i = px * 4;
                        d[i + 3] = (d[i] * 0.299 + d[i + 1] * 0.587 + d[i + 2] * 0.114);
                        d[i] = d[i + 1] = d[i + 2] = 255;
                    }
                    ctx.putImageData(id, 0, 0);
                    resolve(c);
                } catch (e) { reject(e); }
            };
            img.onerror = function () { reject(new Error('Maschera non leggibile')); };
            img.src = dataUrl;
        });
    }

    function shadeToDataUrl(shadeCanvas, outW, outH, quality) {
        var c = makeCanvas(outW, outH);
        c.getContext('2d').drawImage(shadeCanvas, 0, 0, outW, outH);
        var url = c.toDataURL('image/webp', quality);
        if (url.indexOf('image/webp') === -1) url = c.toDataURL('image/jpeg', quality);
        return url;
    }

    function loadImageAny(src) {
        return new Promise(function (resolve, reject) {
            var img = new Image();
            img.onload = function () { resolve(img); };
            img.onerror = function () { reject(new Error('Immagine non caricabile: ' + String(src).slice(0, 120))); };
            img.src = src;
        });
    }

    // Caricamento logo con CORS: senza crossOrigin il canvas verrebbe "tainted"
    // e WebGL/toDataURL fallirebbero. Se il server del logo non manda CORS,
    // distinguiamo l'errore per dare un messaggio chiaro all'operatore.
    function loadLogoImage(url) {
        return new Promise(function (resolve, reject) {
            if (!url) { reject(Object.assign(new Error('URL logo mancante'), { code: 'MISSING' })); return; }
            var img = new Image();
            if (!/^data:/i.test(url)) img.crossOrigin = 'anonymous';
            img.onload = function () { resolve(img); };
            img.onerror = function () {
                var probe = new Image();
                probe.onload = function () {
                    reject(Object.assign(new Error('Il logo esiste ma il server non consente CORS: ' + url), { code: 'CORS' }));
                };
                probe.onerror = function () {
                    reject(Object.assign(new Error('Logo non trovato o non leggibile: ' + url), { code: 'NOTFOUND' }));
                };
                probe.src = url;
            };
            img.src = url;
        });
    }

    // ============================================================
    // CODEC CONFIG (deflate + base64url) per l'URL overlay
    // ============================================================

    function bytesToBase64Url(bytes) {
        var bin = '';
        for (var i = 0; i < bytes.length; i += 8192) {
            bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 8192));
        }
        return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    }

    function base64UrlToBytes(str) {
        str = str.replace(/-/g, '+').replace(/_/g, '/');
        while (str.length % 4) str += '=';
        var bin = atob(str);
        var out = new Uint8Array(bin.length);
        for (var i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
        return out;
    }

    function compressPayload(obj) {
        var json = JSON.stringify(obj);
        if (typeof CompressionStream === 'undefined') {
            return Promise.resolve('0.' + bytesToBase64Url(new TextEncoder().encode(json)));
        }
        var stream = new Blob([json]).stream().pipeThrough(new CompressionStream('deflate-raw'));
        return new Response(stream).arrayBuffer().then(function (buf) {
            return '1.' + bytesToBase64Url(new Uint8Array(buf));
        });
    }

    function decompressPayload(str) {
        if (!str || str.length < 3 || str[1] !== '.') return Promise.reject(new Error('Config URL non valida'));
        var mode = str[0];
        var bytes = base64UrlToBytes(str.slice(2));
        if (mode === '0') {
            return Promise.resolve(JSON.parse(new TextDecoder().decode(bytes)));
        }
        if (typeof DecompressionStream === 'undefined') {
            return Promise.reject(new Error('Browser senza DecompressionStream: usare la config via API o localStorage'));
        }
        var stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
        return new Response(stream).text().then(function (json) { return JSON.parse(json); });
    }

    // ============================================================
    // RISOLUZIONE LOGHI SQUADRA (stessa logica di streaming/obs_bar)
    // ============================================================

    var GITHUB_LOGO_API = 'https://api.github.com/repos/ipbseries-scoreboard/paintball-manager/contents/NO%20SFONDO';
    var GITHUB_LOGO_RAW = 'https://raw.githubusercontent.com/ipbseries-scoreboard/paintball-manager/main/NO%20SFONDO/';
    var githubList = null;
    var githubFetchPromise = null;

    function fetchGithubLogoList() {
        if (githubList) return Promise.resolve(githubList);
        if (githubFetchPromise) return githubFetchPromise;
        githubFetchPromise = fetch(GITHUB_LOGO_API)
            .then(function (r) { return r.ok ? r.json() : Promise.reject(new Error('HTTP ' + r.status)); })
            .then(function (data) {
                githubList = data.map(function (f) { return f.name; });
                return githubList;
            })
            .catch(function (e) {
                githubFetchPromise = null;
                console.warn('[FieldLogos] Elenco loghi GitHub non disponibile:', e.message);
                return [];
            });
        return githubFetchPromise;
    }

    function cleanTeamName(name) {
        if (!name) return '';
        var cleaned = String(name).trim();
        if (cleaned.indexOf(' - ') !== -1) {
            var parts = cleaned.split(' - ');
            if (/QUARTI|SEMIFINALI|FINALE|FINALI|OTTAVI|ROUND|PLAYOFF|POSTO|QUALIFICAZIONI/i.test(parts[0])) {
                cleaned = parts[1].trim();
            }
        }
        return cleaned.replace(/^SQUADRA\s+[A-Z]$/i, '').replace(/^TEAM\s+[A-Z]$/i, '').trim() || name;
    }

    function isPlaceholderName(name) {
        return !name || /^(TEAM|SQUADRA)\s+[A-Z]$/i.test(String(name).trim());
    }

    function findFuzzyGithubLogo(teamName, list) {
        if (!list || !list.length || !teamName) return null;
        var cleanTarget = teamName.toLowerCase().replace(/[^a-z0-9]/g, '');
        if (!cleanTarget) return null;
        var match = null, i, f, cleanFile;
        for (i = 0; i < list.length; i++) {
            f = list[i];
            cleanFile = f.toLowerCase().replace(/[^a-z0-9.]/g, '');
            if (cleanFile === cleanTarget + '.png' || cleanFile === cleanTarget) { match = f; break; }
        }
        if (!match) {
            for (i = 0; i < list.length; i++) {
                f = list[i];
                cleanFile = f.toLowerCase().replace(/[^a-z0-9]/g, '').replace(/png$|jpg$/, '');
                if (cleanFile.length > 2 && (cleanFile.indexOf(cleanTarget) !== -1 || cleanTarget.indexOf(cleanFile) !== -1)) {
                    match = f; break;
                }
            }
        }
        return match;
    }

    // Ordine di risoluzione: logoUrl nel pacchetto Regia → clanConfig → fuzzy GitHub → fallback
    function resolveLogoUrl(teamName, packetLogoUrl, clanConfig, fallbackUrl) {
        var clean = cleanTeamName(teamName);
        if (isPlaceholderName(clean)) return Promise.resolve(null);
        if (packetLogoUrl) return Promise.resolve(packetLogoUrl);
        if (clanConfig && clanConfig.length) {
            var tag = clean.trim().toLowerCase();
            var cfg = clanConfig.find(function (c) {
                return c && c.name && c.name.trim().toLowerCase() === tag;
            });
            if (cfg && cfg.logoUrl) return Promise.resolve(cfg.logoUrl);
        }
        return fetchGithubLogoList().then(function (list) {
            var file = findFuzzyGithubLogo(clean, list);
            if (file) return GITHUB_LOGO_RAW + encodeURIComponent(file);
            return fallbackUrl || null;
        });
    }

    // ============================================================
    // EXPORT
    // ============================================================

    global.FieldLogosCore = {
        W: W, H: H,
        CONFIG_VERSION: CONFIG_VERSION,
        defaultDoc: defaultDoc,
        defaultLogoParams: defaultLogoParams,
        defaultGreen: defaultGreen,
        squareToQuad: squareToQuad,
        invert3: invert3,
        applyH: applyH,
        validateQuad: validateQuad,
        scaledQuad: scaledQuad,
        logoFitUV: logoFitUV,
        rgbToHsv: rgbToHsv,
        rangesFromSamples: rangesFromSamples,
        computeGreenMask: computeGreenMask,
        morph: morph,
        blurMask: blurMask,
        objectPath: objectPath,
        objectMatchesSide: objectMatchesSide,
        rasterizeExclusions: rasterizeExclusions,
        combineMasks: combineMasks,
        createWarper: createWarper,
        createRenderer: createRenderer,
        buildShade: buildShade,
        maskToDataUrl: maskToDataUrl,
        dataUrlToAlphaMask: dataUrlToAlphaMask,
        shadeToDataUrl: shadeToDataUrl,
        loadImageAny: loadImageAny,
        loadLogoImage: loadLogoImage,
        compressPayload: compressPayload,
        decompressPayload: decompressPayload,
        fetchGithubLogoList: fetchGithubLogoList,
        cleanTeamName: cleanTeamName,
        isPlaceholderName: isPlaceholderName,
        findFuzzyGithubLogo: findFuzzyGithubLogo,
        resolveLogoUrl: resolveLogoUrl,
        makeCanvas: makeCanvas
    };
})(typeof window !== 'undefined' ? window : this);
