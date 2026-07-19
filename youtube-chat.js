(function (root, factory) {
    const api = factory();
    if (typeof module !== 'undefined' && module.exports) module.exports = api;
    else root.PMYouTubeChat = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
    'use strict';

    const VIDEO_ID_RE = /^[A-Za-z0-9_-]{11}$/;
    const MAX_TEXT = 300;
    const MAX_NAME = 80;

    function cleanText(value, max) {
        return String(value == null ? '' : value)
            .replace(/[<>]/g, ' ')
            .replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028\u2029\ufeff]/g, ' ')
            .replace(/\s+/g, ' ').trim().slice(0, max || MAX_TEXT);
    }

    function extractVideoId(input) {
        const raw = String(input || '').trim();
        if (VIDEO_ID_RE.test(raw)) return raw;
        let url;
        try { url = new URL(/^https?:\/\//i.test(raw) ? raw : 'https://' + raw); }
        catch (e) { return ''; }
        const host = url.hostname.toLowerCase().replace(/^www\./, '');
        let candidate = '';
        if (host === 'youtu.be') candidate = url.pathname.split('/').filter(Boolean)[0] || '';
        else if (host === 'youtube.com' || host.endsWith('.youtube.com')) {
            candidate = url.searchParams.get('v') || '';
            if (!candidate) {
                const parts = url.pathname.split('/').filter(Boolean);
                if (parts[0] === 'live' || parts[0] === 'embed' || parts[0] === 'shorts') candidate = parts[1] || '';
            }
        }
        return VIDEO_ID_RE.test(candidate) ? candidate : '';
    }

    function safeAvatarUrl(value) {
        try {
            const url = new URL(String(value || ''));
            const host = url.hostname.toLowerCase();
            if (url.protocol !== 'https:') return '';
            if (host === 'yt3.ggpht.com' || host.endsWith('.ggpht.com') || host.endsWith('.googleusercontent.com')) return url.href;
        } catch (e) { }
        return '';
    }

    function normalizeMessage(item) {
        if (!item || typeof item !== 'object') return null;
        const snippet = item.snippet || {};
        const author = item.authorDetails || {};
        const type = cleanText(snippet.type, 40);
        let text = cleanText(snippet.displayMessage || (snippet.textMessageDetails && snippet.textMessageDetails.messageText), MAX_TEXT);
        const superDetails = snippet.superChatDetails || snippet.superStickerDetails || null;
        const amount = cleanText(superDetails && superDetails.amountDisplayString, 30);
        if (!text && amount) text = type === 'superStickerEvent' ? 'Super Sticker' : 'Super Chat';
        if (!text || !cleanText(author.displayName, MAX_NAME)) return null;
        return {
            id: cleanText(item.id, 140),
            type,
            text,
            author: cleanText(author.displayName, MAX_NAME),
            authorChannelId: cleanText(author.channelId, 80),
            avatarUrl: safeAvatarUrl(author.profileImageUrl),
            publishedAt: cleanText(snippet.publishedAt, 40),
            isOwner: !!author.isChatOwner,
            isModerator: !!author.isChatModerator,
            isMember: !!author.isChatSponsor,
            isVerified: !!author.isVerified,
            amount
        };
    }

    function sanitizeOverlayMessage(raw) {
        if (!raw || typeof raw !== 'object') return null;
        const text = cleanText(raw.text, MAX_TEXT);
        const author = cleanText(raw.author, MAX_NAME);
        if (!text || !author) return null;
        return {
            id: cleanText(raw.id, 140), type: cleanText(raw.type, 40), text, author,
            authorChannelId: cleanText(raw.authorChannelId, 80), avatarUrl: safeAvatarUrl(raw.avatarUrl),
            publishedAt: cleanText(raw.publishedAt, 40), amount: cleanText(raw.amount, 30),
            isOwner: !!raw.isOwner, isModerator: !!raw.isModerator,
            isMember: !!raw.isMember, isVerified: !!raw.isVerified
        };
    }

    function apiErrorMessage(data, fallback) {
        const err = data && data.error;
        const detail = err && Array.isArray(err.errors) && err.errors[0];
        return cleanText((detail && (detail.reason || detail.message)) || (err && err.message) || fallback || 'Errore YouTube', 160);
    }

    class LiveChatClient {
        constructor(options) {
            const opts = options || {};
            this.fetchFn = opts.fetchFn || (typeof fetch === 'function' ? fetch.bind(globalThis) : null);
            this.onBatch = typeof opts.onBatch === 'function' ? opts.onBatch : function () { };
            this.onStatus = typeof opts.onStatus === 'function' ? opts.onStatus : function () { };
            this.timer = null;
            this.abortController = null;
            this.running = false;
            this.apiKey = '';
            this.videoId = '';
            this.liveChatId = '';
            this.pageToken = '';
        }

        stop() {
            this.running = false;
            clearTimeout(this.timer);
            this.timer = null;
            if (this.abortController) {
                try { this.abortController.abort(); } catch (e) { }
                this.abortController = null;
            }
        }

        async connect(source, apiKey) {
            this.stop();
            if (!this.fetchFn) throw new Error('Fetch non disponibile nel browser');
            this.videoId = extractVideoId(source);
            this.apiKey = String(apiKey || '').trim();
            if (!this.videoId) throw new Error('Link o Video ID YouTube non valido');
            if (!this.apiKey) throw new Error('Chiave API YouTube mancante');
            this.running = true;
            this.onStatus('RICERCA LIVE CHAT...');
            const url = 'https://www.googleapis.com/youtube/v3/videos?part=liveStreamingDetails,snippet&id=' +
                encodeURIComponent(this.videoId) + '&key=' + encodeURIComponent(this.apiKey);
            const data = await this.requestJson(url);
            const video = data && data.items && data.items[0];
            this.liveChatId = cleanText(video && video.liveStreamingDetails && video.liveStreamingDetails.activeLiveChatId, 160);
            if (!this.liveChatId) {
                this.stop();
                throw new Error('Il video non è in diretta oppure la chat non è attiva');
            }
            this.pageToken = '';
            this.onStatus('CONNESSIONE ALLA CHAT...');
            await this.poll(true);
            return { videoId: this.videoId, liveChatId: this.liveChatId, title: cleanText(video && video.snippet && video.snippet.title, 140) };
        }

        async requestJson(url) {
            this.abortController = typeof AbortController !== 'undefined' ? new AbortController() : null;
            const response = await this.fetchFn(url, this.abortController ? { signal: this.abortController.signal } : undefined);
            let data = null;
            try { data = await response.json(); } catch (e) { }
            if (!response.ok) throw new Error(apiErrorMessage(data, 'YouTube HTTP ' + response.status));
            return data || {};
        }

        async poll(initial) {
            if (!this.running) return;
            try {
                let url = 'https://www.googleapis.com/youtube/v3/liveChat/messages?part=id,snippet,authorDetails&hl=it&maxResults=200&profileImageSize=48&liveChatId=' +
                    encodeURIComponent(this.liveChatId) + '&key=' + encodeURIComponent(this.apiKey);
                if (this.pageToken) url += '&pageToken=' + encodeURIComponent(this.pageToken);
                const data = await this.requestJson(url);
                if (!this.running) return;
                this.pageToken = cleanText(data.nextPageToken, 500);
                const messages = (Array.isArray(data.items) ? data.items : []).map(normalizeMessage).filter(Boolean);
                this.onBatch(messages, { initial: !!initial, offlineAt: cleanText(data.offlineAt, 40) });
                if (data.offlineAt) {
                    this.stop();
                    this.onStatus('DIRETTA TERMINATA');
                    return;
                }
                const wait = Math.max(1500, Math.min(30000, Number(data.pollingIntervalMillis) || 5000));
                this.onStatus('🟢 CHAT COLLEGATA');
                this.timer = setTimeout(() => this.poll(false), wait);
            } catch (error) {
                if (!this.running || (error && error.name === 'AbortError')) return;
                const msg = cleanText(error && error.message, 160) || 'Errore YouTube';
                this.onStatus('⚠️ ' + msg);
                this.timer = setTimeout(() => this.poll(false), 10000);
            }
        }
    }

    return { cleanText, extractVideoId, safeAvatarUrl, normalizeMessage, sanitizeOverlayMessage, LiveChatClient };
});
