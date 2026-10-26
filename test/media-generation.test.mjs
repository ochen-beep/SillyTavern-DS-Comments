// @ts-check
/**
 * DS Comments — media generation integration tests.
 *
 * Drives the REAL generateFeed pipeline (_testGenerateFeed) with a fake LLM
 * response containing a "gif" request and a mocked Giphy search, then asserts
 * the persisted feed HTML: resolved URL placeholder when the key exists,
 * bracketed fallback when it doesn't. Guards the end-to-end wiring observed
 * failing live (Giphy selected, key typed, feed still text-only).
 */
import '../test-helpers/stub-runtime.mjs';
import test, { beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { state, getCtx } from '../src/core.js';
import { _testGenerateFeed } from '../src/generator.js';
import { _resetFeedFileStore, getFeedSlot } from '../src/feed-file-store.js';

const aiMsg = (mes) => ({ mes, is_user: false, is_system: false, is_hidden: false, swipe_id: 0, swipes: [mes] });

const gifResponse = JSON.stringify([
    { username: 'mikey_j_glue', content: '', gif: 'man rubbing temples stressed' },
    { username: 'plain', content: 'обычный текст', reactions: [] },
]);

beforeEach(() => {
    Object.assign(state, {
        settings: {},
        generationInProgress: false, generationOwner: null, abortController: null,
        generationTarget: null, generationObservedTarget: null, queuedGeneration: null,
        pendingActivatedWorldInfo: null,
    });
    state.pinnedFeeds?.clear();
    const ctx = getCtx();
    Object.assign(ctx, { chatId: 'chatMedia', chat: [aiMsg('a post')], chatMetadata: {}, saveMetadata: () => {}, name1: 'User', name2: 'Char', substituteParams: t => t });
    _resetFeedFileStore();
    globalThis._stFilesReset?.();
    // Giphy key persisted in localforage.
    globalThis.SillyTavern.libs.localforage = {
        getItem: async (k) => (k === 'DSComments_giphyKey' ? 'TESTKEY' : null),
        setItem: async () => {},
        removeItem: async () => {},
    };
});

function setupMediaGeneration() {
    state.settings = {
        enabled: true, noSaveMode: false,
        apiSource: 'custom', customEndpoint: 'http://x', customModel: 'm',
        promptTemplate: 'main', userCount: 3, includeChatHistory: false,
        contextDepth: 4, includePersona: false, includeCharacterDescription: false,
        enableJailbreakBlock: false, jailbreakRole: 'system',
        profileId: '', soundEnabled: false,
        promptTemplates: { main: 'Generate {{count}} comments.' },
        includeImages: 'off',
        mediaProvider: 'giphy', mediaRating: 'medium', mediaStickers: true, mediaMemes: true,
    };
}

test('generateFeed: gif request resolves through Giphy and lands in the feed HTML', async () => {
    setupMediaGeneration();
    const realFetch = globalThis.fetch;
    let giphyCalled = 0;
    globalThis.fetch = async (url) => {
        const u = String(url);
        if (u.startsWith('https://api.giphy.com/v1/gifs/search')) {
            giphyCalled++;
            assert.ok(u.includes('api_key=TESTKEY'), 'resolver must send the stored key');
            assert.ok(u.includes('q=man+rubbing'), 'resolver must send the model query');
            return {
                ok: true,
                json: async () => ({ data: [{ images: { downsized: { url: 'https://media.giphy.com/media/abc/giphy-downsized.gif' } } }] }),
            };
        }
        if (u.startsWith('https://api.memegen.link/templates/')) {
            return { ok: true, json: async () => [] };
        }
        return realFetch(url);
    };
    try {
        await _testGenerateFeed('0', 0, true, async () => gifResponse);
    } finally {
        globalThis.fetch = realFetch;
    }
    assert.equal(giphyCalled, 1, 'exactly one Giphy search for one unique query');
    const slot = getFeedSlot('0', 0);
    assert.ok(slot?.html, 'feed stored');
    assert.match(slot.html, /data-dsc-media-src="https:\/\/media\.giphy\.com\/media\/abc\/giphy-downsized\.gif"/, 'placeholder with resolved URL in stored HTML');
    // threads mirror (community memory) carries the media request too
    // entry.threads is the flat message array (collectPastCommentThreads shape)
    assert.equal(slot.threads?.[0]?.gif, 'man rubbing temples stressed');
});

test('generateFeed: missing key degrades the media-only comment to a bracketed tag', async () => {
    setupMediaGeneration();
    globalThis.SillyTavern.libs.localforage = {
        getItem: async () => null,
        setItem: async () => {},
        removeItem: async () => {},
    };
    await _testGenerateFeed('0', 0, true, async () => gifResponse);
    const slot = getFeedSlot('0', 0);
    assert.match(slot.html, /dsc_media_fallback">\[gif: man rubbing temples stressed\]/, 'bracketed fallback for the media-only comment');
    assert.match(slot.html, /обычный текст/, 'text comment unaffected');
});

test('generateFeed: all media off keeps the feed free of placeholders (legacy shape)', async () => {
    setupMediaGeneration();
    state.settings.mediaProvider = 'off';
    state.settings.mediaMemes = false;
    await _testGenerateFeed('0', 0, true, async () => gifResponse);
    const slot = getFeedSlot('0', 0);
    assert.ok(!slot.html.includes('data-dsc-media-src'));
    assert.match(slot.html, /dsc_media_fallback/, 'unresolved gif request still degrades visibly');
});
