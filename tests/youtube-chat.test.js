'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const YouTubeChat = require('../youtube-chat.js');

test('extracts a YouTube video id from supported live links', () => {
    const id = 'dQw4w9WgXcQ';
    assert.equal(YouTubeChat.extractVideoId(id), id);
    assert.equal(YouTubeChat.extractVideoId('https://www.youtube.com/watch?v=' + id), id);
    assert.equal(YouTubeChat.extractVideoId('https://youtu.be/' + id + '?si=test'), id);
    assert.equal(YouTubeChat.extractVideoId('https://youtube.com/live/' + id), id);
    assert.equal(YouTubeChat.extractVideoId('https://example.com/watch?v=' + id), '');
    assert.equal(YouTubeChat.extractVideoId('not-valid-video-id'), '');
});

test('normalizes YouTube messages and strips unsafe public data', () => {
    const message = YouTubeChat.normalizeMessage({
        id: 'msg-1',
        snippet: { type: 'textMessageEvent', displayMessage: '<b>Ciao</b>\u0000 mondo', publishedAt: '2026-07-18T20:00:00Z' },
        authorDetails: {
            displayName: '<Mario>', channelId: 'UC123', profileImageUrl: 'https://yt3.ggpht.com/avatar',
            isChatModerator: true
        }
    });
    assert.equal(message.author, 'Mario');
    assert.equal(message.text, 'b Ciao /b mondo');
    assert.equal(message.isModerator, true);
    assert.equal(message.avatarUrl, 'https://yt3.ggpht.com/avatar');

    const sanitized = YouTubeChat.sanitizeOverlayMessage(Object.assign({}, message, { avatarUrl: 'javascript:alert(1)' }));
    assert.equal(sanitized.avatarUrl, '');
});

test('live chat client resolves the active chat and emits normalized messages', async () => {
    const calls = [];
    const responses = [
        { items: [{ snippet: { title: 'Finale IPBA' }, liveStreamingDetails: { activeLiveChatId: 'CHAT-123' } }] },
        {
            nextPageToken: 'NEXT', pollingIntervalMillis: 9000,
            items: [{
                id: 'm1', snippet: { type: 'textMessageEvent', displayMessage: 'Forza!', publishedAt: '2026-07-18T20:00:00Z' },
                authorDetails: { displayName: 'Tifoso', profileImageUrl: 'https://yt3.ggpht.com/a' }
            }]
        }
    ];
    const batches = [];
    const client = new YouTubeChat.LiveChatClient({
        fetchFn: async url => {
            calls.push(url);
            const data = responses.shift();
            return { ok: true, status: 200, json: async () => data };
        },
        onBatch: messages => batches.push(messages)
    });
    const info = await client.connect('https://youtube.com/live/dQw4w9WgXcQ', 'TEST-KEY');
    client.stop();
    assert.equal(info.liveChatId, 'CHAT-123');
    assert.equal(info.title, 'Finale IPBA');
    assert.equal(batches[0][0].author, 'Tifoso');
    assert.equal(batches[0][0].text, 'Forza!');
    assert.match(calls[0], /videos\?part=liveStreamingDetails/);
    assert.match(calls[1], /liveChat\/messages\?part=id,snippet,authorDetails/);
});
