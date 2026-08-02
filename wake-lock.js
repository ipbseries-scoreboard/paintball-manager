/*
 * WAKE-LOCK — tiene acceso lo schermo di tablet e monitor per tutta la gara.
 *
 * PERCHE' NON BASTA navigator.wakeLock
 * ------------------------------------
 * La Wake Lock API e' esposta SOLO nei "secure context": https, oppure
 * localhost. Il tablet dell'arbitro pero' apre
 *     http://192.168.1.113:9000/referee.html?id=1674
 * che secure context NON e'. Li' `navigator.wakeLock` e' proprio `undefined`,
 * quindi una versione basata solo sull'API non farebbe nulla dove serve di piu'.
 * (Verificato: su http://192.168.x.x -> isSecureContext false, wakeLock assente.)
 *
 * Percio' ci sono due strade, provate in ordine:
 *   1. navigator.wakeLock  — PC di regia (localhost), HTTPS, GitHub Pages.
 *   2. Un video minuscolo, muto e in loop, generato al volo con
 *      canvas.captureStream() + MediaRecorder. Finche' un video e' in
 *      riproduzione il sistema operativo non spegne lo schermo. Il file non e'
 *      incorporato nel sorgente: viene prodotto dal browser (~350 byte).
 *
 * Uso: basta includere lo script, si avvia da solo.
 *     <script src="wake-lock.js?v=1.0.0"></script>
 * Stato leggibile da PMWakeLock.status() per la diagnostica.
 */
(function (global) {
    'use strict';

    var wantActive = false;   // vogliamo lo schermo acceso
    var sentinel = null;      // WakeLockSentinel dell'API nativa
    var video = null;         // elemento del fallback
    var videoUrl = '';
    var method = 'nessuno';
    var lastError = '';
    var gestureHooked = false;

    function log(msg) {
        try { console.log('[WakeLock] ' + msg); } catch (e) { }
    }

    // ---------- 1. API NATIVA ----------
    function nativeAvailable() {
        return !!(global.navigator && global.navigator.wakeLock &&
            typeof global.navigator.wakeLock.request === 'function');
    }

    function requestNative() {
        if (!nativeAvailable()) return Promise.resolve(false);
        // Richiederlo a pagina nascosta lancia NotAllowedError: inutile provarci.
        if (global.document && global.document.visibilityState !== 'visible') return Promise.resolve(false);
        if (sentinel && !sentinel.released) return Promise.resolve(true);
        return global.navigator.wakeLock.request('screen').then(function (lock) {
            sentinel = lock;
            method = 'API nativa';
            lastError = '';
            log('acquisito (API nativa).');
            lock.addEventListener('release', function () {
                log('rilasciato dal sistema.');
                // Non azzeriamo wantActive: al ritorno in primo piano si riprova.
            });
            return true;
        }).catch(function (err) {
            lastError = (err && err.name ? err.name : 'Errore') + ': ' + (err && err.message ? err.message : '');
            return false;
        });
    }

    // ---------- 2. FALLBACK VIDEO ----------
    function buildVideoBlob() {
        return new Promise(function (resolve, reject) {
            try {
                var canvas = global.document.createElement('canvas');
                canvas.width = 2;
                canvas.height = 2;
                var ctx = canvas.getContext('2d');
                if (!ctx || typeof canvas.captureStream !== 'function' || typeof global.MediaRecorder === 'undefined') {
                    reject(new Error('MediaRecorder non disponibile'));
                    return;
                }
                var types = ['video/webm;codecs=vp8', 'video/webm', 'video/mp4'];
                var mime = '';
                for (var i = 0; i < types.length; i++) {
                    if (global.MediaRecorder.isTypeSupported(types[i])) { mime = types[i]; break; }
                }
                if (!mime) { reject(new Error('nessun formato video supportato')); return; }

                ctx.fillStyle = '#000';
                ctx.fillRect(0, 0, 2, 2);
                var stream = canvas.captureStream(10);
                var recorder = new global.MediaRecorder(stream, { mimeType: mime });
                var chunks = [];
                recorder.ondataavailable = function (e) { if (e.data && e.data.size) chunks.push(e.data); };
                recorder.onerror = function (e) { reject(new Error('registrazione fallita')); };
                recorder.onstop = function () {
                    try { stream.getTracks().forEach(function (t) { t.stop(); }); } catch (e) { }
                    if (!chunks.length) { reject(new Error('nessun dato registrato')); return; }
                    resolve(new Blob(chunks, { type: mime }));
                };
                recorder.start();
                // Serve una durata reale: con una clip troppo corta il WebM di
                // MediaRecorder esce con duration 0 e il loop non ricicla in modo
                // affidabile. Un secondo di fotogrammi che cambiano basta e
                // avanza (il file resta di pochi KB).
                var frames = 0;
                var paint = setInterval(function () {
                    frames += 1;
                    ctx.fillStyle = (frames % 2) ? '#010101' : '#000000';
                    ctx.fillRect(0, 0, 2, 2);
                }, 100);
                setTimeout(function () {
                    clearInterval(paint);
                    try { recorder.stop(); } catch (e) { reject(e); }
                }, 1000);
            } catch (err) {
                reject(err);
            }
        });
    }

    function ensureVideoElement() {
        if (video) return Promise.resolve(video);
        return buildVideoBlob().then(function (blob) {
            var el = global.document.createElement('video');
            el.setAttribute('playsinline', '');   // iOS: senza, va a schermo intero
            el.setAttribute('muted', '');
            el.setAttribute('loop', '');
            el.muted = true;
            el.loop = true;
            el.playsInline = true;
            el.style.cssText = 'position:fixed;right:0;bottom:0;width:1px;height:1px;' +
                'opacity:0;pointer-events:none;z-index:-1;';
            videoUrl = global.URL.createObjectURL(blob);
            el.src = videoUrl;
            // Se il sistema lo mette in pausa (cambio scheda, risparmio
            // energetico) va rifatto partire, altrimenti lo schermo si spegne
            // in silenzio e nessuno se ne accorge fino a meta' partita.
            el.addEventListener('pause', function () {
                if (!wantActive) return;
                setTimeout(function () {
                    if (wantActive && video && video.paused) {
                        try { video.play().catch(function () { }); } catch (e) { }
                    }
                }, 500);
            });
            (global.document.body || global.document.documentElement).appendChild(el);
            video = el;
            return el;
        });
    }

    function requestVideo() {
        return ensureVideoElement().then(function (el) {
            // La promise di play() puo' rigettare con AbortError perche' il
            // caricamento della sorgente la interrompe, e NONOSTANTE questo il
            // video parte lo stesso. Fidarsi dell'esito della promise faceva
            // riportare "non attivo" mentre lo schermo era gia' tenuto acceso:
            // l'unica verita' e' el.paused, controllato dopo un giro di loop.
            var settle = function () {
                return new Promise(function (resolve) { setTimeout(resolve, 60); }).then(function () {
                    if (!el.paused) {
                        method = 'video di riserva';
                        lastError = '';
                        log('acquisito (video di riserva).');
                        return true;
                    }
                    // Fermo davvero: qui serve un gesto dell'utente (iOS).
                    hookGesture();
                    return false;
                });
            };
            var playing;
            try { playing = el.play(); } catch (e) { return settle(); }
            if (!playing || typeof playing.then !== 'function') return settle();
            return playing.then(settle, function (err) {
                lastError = (err && err.name ? err.name : 'Errore') + ' durante play()';
                return settle();
            });
        }).catch(function (err) {
            lastError = err && err.message ? err.message : 'fallback non disponibile';
            return false;
        });
    }

    function hookGesture() {
        if (gestureHooked || !global.document) return;
        gestureHooked = true;
        var retry = function () {
            if (!wantActive) return;
            acquire();
        };
        ['pointerdown', 'touchstart', 'click', 'keydown'].forEach(function (ev) {
            global.document.addEventListener(ev, retry, { once: true, passive: true });
        });
    }

    // ---------- ORCHESTRAZIONE ----------
    function acquire() {
        if (!wantActive) return Promise.resolve(false);
        return requestNative().then(function (ok) {
            if (ok) return true;
            // Se l'API nativa ESISTE non si ripiega sul video: un rifiuto qui
            // significa quasi sempre "pagina non in primo piano", condizione
            // temporanea che si risolve da sola al ritorno in visibilita'.
            // Creare comunque il video sarebbe spreco e terrebbe due meccanismi
            // accesi insieme. Il fallback serve solo dove wakeLock non c'e'
            // proprio, cioe' su http://IP (niente secure context).
            if (nativeAvailable()) return false;
            return requestVideo();
        }).then(function (ok) {
            if (!ok && method === 'nessuno' && !nativeAvailable()) {
                log('non attivabile su questo dispositivo (' + (lastError || 'motivo sconosciuto') + ').');
            }
            return ok;
        });
    }

    function enable() {
        wantActive = true;
        return acquire();
    }

    function disable() {
        wantActive = false;
        if (sentinel && !sentinel.released) {
            try { sentinel.release(); } catch (e) { }
        }
        sentinel = null;
        if (video) {
            try { video.pause(); } catch (e) { }
        }
        method = 'nessuno';
    }

    function status() {
        return {
            attivo: wantActive && (method !== 'nessuno'),
            metodo: method,
            apiNativa: nativeAvailable(),
            secureContext: !!global.isSecureContext,
            ultimoErrore: lastError
        };
    }

    // Il lock nativo viene rilasciato dal sistema ogni volta che la pagina passa
    // in secondo piano: al ritorno va SEMPRE richiesto di nuovo. Le versioni
    // precedenti in index.html e board.html controllavano "wakeLock !== null",
    // quindi se il primo tentativo falliva (tipico: pagina caricata mentre non
    // e' in primo piano) non riprovavano mai piu'.
    if (global.document) {
        global.document.addEventListener('visibilitychange', function () {
            if (wantActive && global.document.visibilityState === 'visible') acquire();
        });
    }
    global.addEventListener('pageshow', function () { if (wantActive) acquire(); });
    global.addEventListener('focus', function () { if (wantActive) acquire(); });

    global.PMWakeLock = { enable: enable, disable: disable, status: status, acquire: acquire };

    // Avvio automatico: ogni pagina che include questo file vuole lo schermo acceso.
    if (global.document && global.document.readyState === 'loading') {
        global.document.addEventListener('DOMContentLoaded', enable);
    } else {
        enable();
    }
})(window);
