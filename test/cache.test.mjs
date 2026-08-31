// @ts-check
/**
 * DS Comments — cache integration tests.
 */

import '../test-helpers/stub-runtime.mjs';
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { state, getCtx, LF_PINNED, START_SCREEN_KEY, dumpDebugLog, clearDebugLog } from '../src/core.js';
import {
    getCachedPost, getCachedPostForCurrentGeneration, saveGeneratedCommentary, storeFeed,
    getCurrentFeed, clearFeed,
    initCacheRestore, selectCommentaryTarget, resolvePreferredCommentaryTarget,
    restoreCachedCommentary, restoreForCurrentChatPost, showCurrentFeed,
} from '../src/cache.js';
import { _seedSaveCache, _resetFeedFileStore, getFeedSlot } from '../src/feed-file-store.js';
import { initFeedController } from '../src/ui/feed-controller.js';
import { initLifecycle, onNoSaveModeChanged } from '../src/lifecycle.js';
import { flushPinnedPersist } from '../src/pinned-store.js';

let feed;

beforeEach(() => {
    state.settings = { enabled: true };
    state.currentPostId = null;
    state.currentSwipeIdx = 0;
    state.currentChatId = 'chat-1';
    state.generationEpoch = 0;
    state.pinnedFeeds.clear();
    const ctx = getCtx();
    ctx.chat = [];
    ctx.chatId = 'chat-1';
    ctx.chatMetadata = {};
    ctx.saveMetadata = () => { ctx._saveCalls = (ctx._saveCalls || 0) + 1; };
    ctx._saveCalls = 0;
    _resetFeedFileStore();
    feed = { innerHTML: '', scrollTop: 0, querySelector: () => null };
    document.getElementById = id => id === 'dscFeed' ? feed : null;
    initFeedController({ generateFeed: () => {} });
    initCacheRestore({ getGenerationFingerprint: async () => 'generation-current' });
});
test('restoreCachedCommentary returns true for both hit and soft-stale targets', async () => {
    const ctx = getCtx();
    ctx.chat = [
        { mes: 'hit post', is_user: false, is_system: false, swipe_id: 0, swipes: ['hit post'] },
        { mes: 'soft-stale post', is_user: false, is_system: false, swipe_id: 0, swipes: ['soft-stale post'] },
    ];
    _seedSaveCache({
        '0': { '0': { html: '<p>hit commentary</p>', timestamp: 100, generationFp: 'generation-current' } },
        '1': { '0': { html: '<p>soft stale commentary</p>', timestamp: 100, generationFp: 'generation-old' } },
    });

    const hit = await restoreCachedCommentary('0', 0);
    assert.equal(hit, true);
    assert.match(feed.innerHTML, /hit commentary/);

    const softStale = await restoreCachedCommentary('1', 0);
    assert.equal(softStale, true, 'soft-stale cache should still count as a successful restore');
    assert.match(feed.innerHTML, /soft stale commentary/);
});

test('resolvePreferredCommentaryTarget prioritizes the actually visible AI post, then the state pointer, then last AI fallback', () => {
    const ctx = getCtx();
    ctx.chat = [
        { mes: 'A', is_user: false, is_system: false, swipe_id: 0, swipes: ['A'] },
        { mes: 'B', is_user: false, is_system: false, swipe_id: 1, swipes: ['B0', 'B1'] },
        { mes: 'C', is_user: false, is_system: false, swipe_id: 0, swipes: ['C'] },
    ];
    const visible = { getAttribute: (name) => name === 'mesid' ? '1' : null, getBoundingClientRect: () => ({ top: 20, bottom: 220, height: 200 }) };
    const offscreen = { getAttribute: (name) => name === 'mesid' ? '2' : null, getBoundingClientRect: () => ({ top: 1200, bottom: 1400, height: 200 }) };
    document.getElementById = id => {
        if (id === 'dscFeed') return feed;
        if (id === 'chat') return { querySelectorAll: () => [visible, offscreen] };
        return null;
    };
    window.innerHeight = 800;

    state.currentPostId = '0';
    state.currentSwipeIdx = 0;
    assert.deepEqual(resolvePreferredCommentaryTarget(), { msgId: '1', swipeIdx: 1 });

    // No visible DOM evidence → fall back to the state pointer, then last AI.
    document.getElementById = id => (id === 'dscFeed' ? feed : null);
    state.currentPostId = '1';
    state.currentSwipeIdx = 1;
    assert.deepEqual(resolvePreferredCommentaryTarget(), { msgId: '1', swipeIdx: 1 });
});

test('resolvePreferredCommentaryTarget rejects a nonzero swipe when swipes are absent', () => {
    const ctx = getCtx();
    ctx.chat = [
        { mes: 'legacy post', is_user: false, is_system: false, swipe_id: 1 },
        { mes: 'fallback', is_user: false, is_system: false, swipe_id: 0, swipes: ['fallback'] },
    ];
    state.currentPostId = '0';
    state.currentSwipeIdx = 1;

    // Last AI post 'fallback' (#1) wins; the state pointer's invalid swipe is not used.
    assert.deepEqual(resolvePreferredCommentaryTarget(), { msgId: '1', swipeIdx: 0 });
});

test('resolvePreferredCommentaryTarget rejects an invalid last AI fallback', () => {
    const ctx = getCtx();
    ctx.chat = [{ mes: 'only AI', is_user: false, is_system: false, swipe_id: 1 }];

    assert.equal(resolvePreferredCommentaryTarget(), null);
});



test('restoreForCurrentChatPost invalidates an older pending restore when no target remains', async () => {
    const ctx = getCtx();
    ctx.chat = [{ mes: 'old post', is_user: false, is_system: false, swipe_id: 0, swipes: ['old post'] }];
    _seedSaveCache({
        '0': { '0': { html: '<p>old commentary</p>', timestamp: 100, generationFp: 'generation-current' } },
    });
    const pendingFingerprint = Promise.withResolvers();
    initCacheRestore({ getGenerationFingerprint: () => pendingFingerprint.promise });

    const pending = restoreCachedCommentary('0', 0);
    ctx.chat = [];
    ctx.chatId = 'chat-1';
    state.currentChatId = 'chat-1';
    const restored = await restoreForCurrentChatPost();

    assert.equal(restored, false);
    assert.equal(state.currentPostId, null);
    assert.doesNotMatch(feed.innerHTML, /old commentary/);
    pendingFingerprint.resolve('generation-current');
    assert.equal(await pending, false);
    assert.equal(state.currentPostId, null);
    assert.doesNotMatch(feed.innerHTML, /old commentary/);
});

test('selectCommentaryTarget rejects an invalid direct target without changing visible state', async () => {
    const ctx = getCtx();
    ctx.chat = [{ mes: 'valid post', is_user: false, is_system: false, swipe_id: 0, swipes: ['valid post'] }];
    state.currentPostId = '0';
    feed.innerHTML = '<p>previous commentary</p>';

    const result = await selectCommentaryTarget('not-a-message', 0);

    assert.deepEqual(result, { status: 'missing', msgId: 'not-a-message', swipeIdx: 0 });
    assert.equal(state.currentPostId, '0');
    assert.equal(feed.innerHTML, '<p>previous commentary</p>');
});
test('restoreForCurrentChatPost renders commentary despite a drifted lore generation fingerprint (soft invalidate)', async () => {
    const ctx = getCtx();
    ctx.chat = [{ mes: 'current post', is_user: false, is_system: false, swipe_id: 0, swipes: ['current post'] }];
    _seedSaveCache({
        '0': { '0': { html: '<p>old lore</p>', timestamp: 100, generationFp: 'generation-old' } },
    });
    feed.innerHTML = '<p>previously visible</p>';

    const restored = await restoreForCurrentChatPost();

    // Drifted generation fingerprint is a soft signal — the cached feed is still
    // shown rather than wiped (the user regenerates explicitly if they want a
    // context-matched feed). Wiping on drift broke the chat→window sync on mobile.
    assert.equal(restored, true);
    assert.match(feed.innerHTML, /old lore/);
    assert.equal(state.currentPostId, '0');
    assert.equal(state.currentSwipeIdx, 0);
});
test('restoreForCurrentChatPost reopens the actually visible chat post (B), not a stale selected A', async () => {
    const ctx = getCtx();
    ctx.chat = [
        { mes: 'A', is_user: false, is_system: false, swipe_id: 0, swipes: ['A'] },
        { mes: 'B', is_user: false, is_system: false, swipe_id: 0, swipes: ['B'] },
    ];
    const visible = { getAttribute: (name) => name === 'mesid' ? '1' : null, getBoundingClientRect: () => ({ top: 20, bottom: 220, height: 200 }) };
    document.getElementById = id => {
        if (id === 'dscFeed') return feed;
        if (id === 'chat') return { querySelectorAll: () => [visible] };
        return null;
    };
    // Stale in-memory pointer at A — left over from scrolling the chat while the
    // panel was collapsed. Reopen must follow the actually visible post B.
    state.currentPostId = '0';
    _seedSaveCache({
        '1': { '0': { html: '<p>B commentary</p>', timestamp: 100, generationFp: 'generation-current' } },
    });
    assert.equal(await restoreForCurrentChatPost(), true);
    assert.equal(state.currentPostId, '1');
    assert.match(feed.innerHTML, /B commentary/);
});

test('restoreForCurrentChatPost reopens the actually visible chat post instead of flashing the latest AI post first', async () => {
    const ctx = getCtx();
    ctx.chat = Array.from({ length: 55 }, (_, index) => ({
        mes: `post-${index}`,
        is_user: false,
        is_system: false,
        swipe_id: index === 27 ? 3 : (index === 51 ? 29 : 0),
        swipes: Array.from({ length: Math.max(1, (index === 27 ? 4 : (index === 51 ? 30 : 1))) }, (_, swipe) => `post-${index}-swipe-${swipe}`),
    }));
    // Reopen while chat is visibly around post #27; latest AI post #51 still exists
    // in ctx.chat, but must NOT be rendered first.
    const visible = { getAttribute: (name) => name === 'mesid' ? '27' : null, getBoundingClientRect: () => ({ top: 20, bottom: 220, height: 200 }) };
    const latest = { getAttribute: (name) => name === 'mesid' ? '51' : null, getBoundingClientRect: () => ({ top: 1200, bottom: 1400, height: 200 }) };
    document.getElementById = id => {
        if (id === 'dscFeed') return feed;
        if (id === 'chat') {
            return {
                querySelectorAll: () => [visible, latest],
                contains: (el) => el === visible || el === latest,
                scrollTop: 43044,
                clientHeight: 948,
            };
        }
        return null;
    };
    globalThis.window.innerHeight = 800;
    // Cache exists for both posts. A buggy reopen would momentarily render #51.
    _seedSaveCache({
        '27': { '3': { html: '<p>visible commentary</p>', timestamp: 100, generationFp: 'generation-current' } },
        '51': { '29': { html: '<p>latest commentary</p>', timestamp: 100, generationFp: 'generation-current' } },
    });

    const restored = await restoreForCurrentChatPost();

    assert.equal(restored, true);
    assert.equal(state.currentPostId, '27');
    assert.equal(state.currentSwipeIdx, 3);
    assert.match(feed.innerHTML, /visible commentary/);
    assert.doesNotMatch(feed.innerHTML, /latest commentary/);
});

test('restoreForCurrentChatPost shows empty CTA when the actually visible chat post (B) is uncached', async () => {
    const ctx = getCtx();
    ctx.chat = [
        { mes: 'A', is_user: false, is_system: false, swipe_id: 0, swipes: ['A'] },
        { mes: 'B', is_user: false, is_system: false, swipe_id: 0, swipes: ['B'] },
    ];
    const visible = { getAttribute: (name) => name === 'mesid' ? '1' : null, getBoundingClientRect: () => ({ top: 20, bottom: 220, height: 200 }) };
    document.getElementById = id => {
        if (id === 'dscFeed') return feed;
        if (id === 'chat') return { querySelectorAll: () => [visible] };
        return null;
    };
    // Only A has cache; visible B does not → empty CTA.
    state.currentPostId = '0';
    _seedSaveCache({
        '0': { '0': { html: '<p>A commentary</p>', timestamp: 100, generationFp: 'generation-current' } },
    });
    assert.equal(await restoreForCurrentChatPost(), false);
    assert.equal(state.currentPostId, '1');
    assert.match(feed.innerHTML, /dscEmptyGenerate/);
    assert.doesNotMatch(feed.innerHTML, /A commentary/);
});



test('restoreCachedCommentary shows cached feed despite settings fingerprint drift (soft invalidate)', async () => {
    const ctx = getCtx();
    ctx.chat = [null, null, { mes: 'post', is_user: false, is_system: false, swipe_id: 0, swipes: ['post'] }];
    _seedSaveCache({
        '2': { '0': { html: '<p>old settings</p>', timestamp: 100, generationFp: 'settings-old' } },
    });
    initCacheRestore({ getGenerationFingerprint: async () => 'settings-new' });

    const restored = await restoreCachedCommentary('2', 0);

    // Fingerprint drift must NEVER hide the cached feed (matches the working old
    // behaviour): Connection Manager readiness differs between save and restore
    // on mobile (ST via Termux), which would otherwise wipe every restore.
    assert.equal(restored, true);
    assert.match(feed.innerHTML, /old settings/);
});

test('selectCommentaryTarget returns hit and renders the exact cached target', async () => {
    const ctx = getCtx();
    ctx.chat = [null, null, { mes: 'post', is_user: false, is_system: false, swipe_id: 0, swipes: ['post'] }];
    _seedSaveCache({
        '2': { '0': { html: '<p>target commentary</p>', timestamp: 100, generationFp: 'generation-current' } },
    });

    const result = await selectCommentaryTarget('2', 0);

    assert.deepEqual(result, { status: 'hit', msgId: '2', swipeIdx: 0 });
    assert.match(feed.innerHTML, /target commentary/);
    assert.equal(state.currentPostId, '2');
});

test('selectCommentaryTarget reads the current entry after fingerprint resolution', async () => {
    const ctx = getCtx();
    ctx.chat = [null, null, { mes: 'post', is_user: false, is_system: false, swipe_id: 0, swipes: ['post'] }];
    _seedSaveCache({
        '2': { '0': { html: '<p>old commentary</p>', timestamp: 100, generationFp: 'generation-old' } },
    });
    const deferred = Promise.withResolvers();
    initCacheRestore({ getGenerationFingerprint: () => deferred.promise });

    const transition = selectCommentaryTarget('2', 0);
    _seedSaveCache({
        '2': { '0': { html: '<p>new commentary</p>', timestamp: 200, generationFp: 'generation-current' } },
    });
    deferred.resolve('generation-current');

    assert.deepEqual(await transition, { status: 'hit', msgId: '2', swipeIdx: 0 });
    assert.match(feed.innerHTML, /new commentary/);
    assert.doesNotMatch(feed.innerHTML, /old commentary/);
});

test('selectCommentaryTarget replaces prior feed before asynchronous fingerprint resolution', async () => {
    const ctx = getCtx();
    ctx.chat = [
        { mes: 'post A', is_user: false, is_system: false, swipe_id: 0, swipes: ['post A'] },
        { mes: 'post B', is_user: false, is_system: false, swipe_id: 0, swipes: ['post B'] },
    ];
    _seedSaveCache({
        '1': { '0': { html: '<p>post B commentary</p>', timestamp: 100, generationFp: 'generation-current' } },
    });
    feed.innerHTML = '<p>post A commentary</p>';
    const deferred = Promise.withResolvers();
    initCacheRestore({ getGenerationFingerprint: () => deferred.promise });

    const transition = selectCommentaryTarget('1', 0, { source: 'reopen' });

    assert.match(feed.innerHTML, /post B commentary/);
    assert.doesNotMatch(feed.innerHTML, /post A commentary/);
    deferred.resolve('generation-current');
    assert.deepEqual(await transition, { status: 'hit', msgId: '1', swipeIdx: 0 });
});

test('selectCommentaryTarget renders empty state before asynchronous fingerprint resolution for uncached target', async () => {
    const ctx = getCtx();
    ctx.chat = [
        { mes: 'post A', is_user: false, is_system: false, swipe_id: 0, swipes: ['post A'] },
        { mes: 'post B', is_user: false, is_system: false, swipe_id: 0, swipes: ['post B'] },
    ];
    feed.innerHTML = '<p>post A commentary</p>';
    const deferred = Promise.withResolvers();
    initCacheRestore({ getGenerationFingerprint: () => deferred.promise });

    const transition = selectCommentaryTarget('1', 0, { source: 'reopen' });

    assert.match(feed.innerHTML, /dscEmptyGenerate/);
    assert.doesNotMatch(feed.innerHTML, /post A commentary/);
    deferred.resolve('generation-current');
    assert.deepEqual(await transition, { status: 'missing', msgId: '1', swipeIdx: 0 });
});

test('selectCommentaryTarget returns missing, selects target, and renders empty CTA', async () => {
    const ctx = getCtx();
    ctx.chat = [null, null, { mes: 'post', is_user: false, is_system: false, swipe_id: 0, swipes: ['post'] }];
    feed.innerHTML = '<p>previous target</p>';

    const result = await selectCommentaryTarget('2', 0);

    assert.deepEqual(result, { status: 'missing', msgId: '2', swipeIdx: 0 });
    assert.equal(state.currentPostId, '2');
    assert.match(feed.innerHTML, /dscEmptyGenerate/);
    assert.doesNotMatch(feed.innerHTML, /previous target/);
});

test('selectCommentaryTarget shows cached feed as soft-stale on fingerprint drift', async () => {
    const ctx = getCtx();
    ctx.chat = [null, null, { mes: 'post', is_user: false, is_system: false, swipe_id: 0, swipes: ['post'] }];
    _seedSaveCache({
        '2': { '0': { html: '<p>stale commentary</p>', timestamp: 100, generationFp: 'generation-old' } },
    });
    feed.innerHTML = '<p>previous target</p>';

    const result = await selectCommentaryTarget('2', 0);

    // Drifted fingerprint → soft-stale, but the cached feed is STILL shown.
    // Only a genuinely missing entry clears the feed.
    assert.deepEqual(result, { status: 'soft-stale', msgId: '2', swipeIdx: 0 });
    assert.equal(state.currentPostId, '2');
    assert.match(feed.innerHTML, /stale commentary/);
    assert.doesNotMatch(feed.innerHTML, /dscEmptyGenerate|previous target/);
});

test('selectCommentaryTarget treats legacy entries (no generationFp) as a clean hit', async () => {
    const ctx = getCtx();
    ctx.chat = [null, null, { mes: 'post', is_user: false, is_system: false, swipe_id: 0, swipes: ['post'] }];
    // Legacy entry saved before generationFp existed — the field is absent
    // (undefined), not null. It must be treated as a hit (no drift signal),
    // not soft-stale, so old caches don't surface a spurious drift warning.
    _seedSaveCache({
        '2': { '0': { html: '<p>legacy commentary</p>', timestamp: 100 } },
    });
    feed.innerHTML = '<p>previous target</p>';

    const result = await selectCommentaryTarget('2', 0);

    assert.deepEqual(result, { status: 'hit', msgId: '2', swipeIdx: 0 });
    assert.match(feed.innerHTML, /legacy commentary/);
});

test('selectCommentaryTarget does not overwrite a newer feed after its fingerprint resolution is superseded', async () => {
    const ctx = getCtx();
    ctx.chat = [null, null, { mes: 'post', is_user: false, is_system: false, swipe_id: 0, swipes: ['post'] }];
    const deferred = Promise.withResolvers();
    initCacheRestore({ getGenerationFingerprint: () => deferred.promise });

    const transition = selectCommentaryTarget('2', 0);
    ctx.chatId = 'chat-2';
    feed.innerHTML = '<p>newer visible feed</p>';
    state.currentPostId = '9';
    deferred.resolve('generation-current');

    assert.deepEqual(await transition, { status: 'superseded', msgId: '2', swipeIdx: 0 });
    assert.equal(feed.innerHTML, '<p>newer visible feed</p>');
    assert.equal(state.currentPostId, '9');
});

test('restoreForCurrentChatPost does not clear a newer transition when reopen is superseded', async () => {
    const ctx = getCtx();
    ctx.chat = [
        { mes: 'reopen post', is_user: false, is_system: false, swipe_id: 0, swipes: ['reopen post'] },
        { mes: 'newer post', is_user: false, is_system: false, swipe_id: 0, swipes: ['newer post'] },
    ];
    _seedSaveCache({
        '0': { '0': { html: '<p>reopen commentary</p>', timestamp: 100, generationFp: 'generation-current' } },
        '1': { '0': { html: '<p>newer commentary</p>', timestamp: 100, generationFp: 'generation-current' } },
    });
    const reopenFingerprint = Promise.withResolvers();
    const newerFingerprint = Promise.withResolvers();
    let calls = 0;
    initCacheRestore({ getGenerationFingerprint: () => (++calls === 1 ? reopenFingerprint.promise : newerFingerprint.promise) });

    const reopen = restoreForCurrentChatPost();
    const newer = selectCommentaryTarget('1', 0);
    newerFingerprint.resolve('generation-current');
    assert.deepEqual(await newer, { status: 'hit', msgId: '1', swipeIdx: 0 });
    reopenFingerprint.resolve('generation-current');

    assert.equal(await reopen, false);
    assert.match(feed.innerHTML, /newer commentary/);
    assert.doesNotMatch(feed.innerHTML, /reopen commentary|dscEmptyGenerate/);
    assert.equal(state.currentPostId, '1');
});

test('restoreCachedCommentary discards a resolved fingerprint after chat changes', async () => {
    const ctx = getCtx();
    _seedSaveCache({
        '1': { '0': { html: '<p>chat one</p>', timestamp: 100, generationFp: 'generation-current' } },
    });
    const deferred = Promise.withResolvers();
    initCacheRestore({ getGenerationFingerprint: () => deferred.promise });

    const restore = restoreCachedCommentary('1', 0);
    ctx.chatId = 'chat-2';
    deferred.resolve('generation-current');

    // Superseded by the chat switch: never reported as a hit/soft-stale restore.
    // (The pre-await paint of the old chat's entry is transient by design —
    // CHAT_CHANGED re-renders the new chat's feed right after.)
    assert.equal(await restore, false);
});

test('newer restore wins when async fingerprint resolutions finish out of order', async () => {
    const ctx = getCtx();
    ctx.chat = [
        null,
        { mes: 'first', is_user: false, is_system: false, swipe_id: 0, swipes: ['first'] },
        { mes: 'second', is_user: false, is_system: false, swipe_id: 0, swipes: ['second'] },
    ];
    const first = Promise.withResolvers();
    const second = Promise.withResolvers();
    let calls = 0;
    initCacheRestore({ getGenerationFingerprint: () => (++calls === 1 ? first.promise : second.promise) });
    _seedSaveCache({
        '1': { '0': { html: '<p>first post</p>', timestamp: 100, generationFp: 'generation-current' } },
        '2': { '0': { html: '<p>second post</p>', timestamp: 100, generationFp: 'generation-current' } },
    });

    const olderRestore = restoreCachedCommentary('1', 0);
    const newerRestore = restoreCachedCommentary('2', 0);
    second.resolve('generation-current');
    assert.equal(await newerRestore, true);
    first.resolve('generation-current');
    assert.equal(await olderRestore, false);

    assert.match(feed.innerHTML, /second post/);
    assert.doesNotMatch(feed.innerHTML, /first post/);
    assert.equal(state.currentPostId, '2');
});

test('showCurrentFeed rejects stale save-mode commentary through the current fingerprint provider', async () => {
    state.settings.noSaveMode = false;
    state.currentPostId = '3';
    state.currentSwipeIdx = 0;
    _seedSaveCache({
        '3': { '0': { html: '<p>old generation</p>', timestamp: 100, generationFp: 'generation-old' } },
    });
    feed.innerHTML = '<p>previously visible</p>';

    const result = await showCurrentFeed();

    assert.equal(result, false);
    assert.doesNotMatch(feed.innerHTML, /old generation|previously visible/);
});

test('showCurrentFeed renders matching save-mode commentary after async fingerprint validation', async () => {
    state.settings.noSaveMode = false;
    state.currentPostId = '4';
    state.currentSwipeIdx = 0;
    _seedSaveCache({
        '4': { '0': { html: '<p>current generation</p>', timestamp: 100, generationFp: 'generation-current' } },
    });

    const result = showCurrentFeed();
    assert.equal(typeof result?.then, 'function');
    assert.equal(await result, true);
    assert.match(feed.innerHTML, /current generation/);
});

test('onNoSaveModeChanged does not pin a cache entry from an old generation', async () => {
    const ctx = getCtx();
    ctx.extensionSettings = {};
    state.settings.noSaveMode = true;
    state.currentPostId = '5';
    state.currentSwipeIdx = 0;
    _seedSaveCache({
        '5': { '0': { html: '<p>old generation</p>', timestamp: 100, generationFp: 'generation-old' } },
    });
    initLifecycle({
        getCachedPostForCurrentGeneration,
        storeFeed,
        showCurrentFeed: () => {},
        syncRegenVisual: () => {},
    });

    await onNoSaveModeChanged();

    assert.equal(state.pinnedFeeds.has(ctx.chatId), false);
});

test('onNoSaveModeChanged pins a cache entry from the current generation', async () => {
    const ctx = getCtx();
    ctx.extensionSettings = {};
    state.settings.noSaveMode = true;
    state.currentPostId = '6';
    state.currentSwipeIdx = 0;
    _seedSaveCache({
        '6': { '0': { html: '<p>current generation</p>', timestamp: 100, generationFp: 'generation-current' } },
    });
    initLifecycle({
        getCachedPostForCurrentGeneration,
        storeFeed,
        showCurrentFeed: () => {},
        syncRegenVisual: () => {},
    });

    await onNoSaveModeChanged();

    assert.equal(state.pinnedFeeds.get(ctx.chatId)?.html, '<p>current generation</p>');
});
test('cache hit makes no server or metadata writes', () => {
    _seedSaveCache({ '1': { '0': { html: '<p>hi</p>', timestamp: 100, fp: 'fp:hi' } } });
    const html = getCachedPost('1', 0);
    assert.equal(html, '<p>hi</p>');
    assert.equal(getFeedSlot('1', 0)?.ts, 100);
    assert.equal(getCtx()._saveCalls, 0);
});

test('cache miss does nothing and returns null', () => {
    const html = getCachedPost('99', 0);
    assert.equal(html, null);
    assert.equal(getCtx()._saveCalls, 0);
});

// ── noSave persistence invariant: storeFeed touches localforage ONLY in noSave mode ──
// The whole point of the LF_PINNED store is to keep noSave out of chatMetadata.
// This invariant guards against a future refactor that accidentally persists
// a save-mode feed to LF_PINNED (which would survive F5 under the wrong mode)
// or forgets to persist a noSave feed (regressing the F5-survival feature).

function withMapForage(fn) {
    return async () => {
        const orig = globalThis.SillyTavern.libs.localforage;
        const store = new Map();
        globalThis.SillyTavern.libs.localforage = {
            getItem: async (k) => store.has(k) ? store.get(k) : null,
            setItem: async (k, v) => { store.set(k, v); },
            removeItem: async (k) => { store.delete(k); },
            keys: async () => Array.from(store.keys()),
        };
        try {
            await fn(store);
        } finally {
            globalThis.SillyTavern.libs.localforage = orig;
        }
    };
}

test('storeFeed in save mode does NOT touch the noSave pinned-forage', withMapForage(async (store) => {
    state.settings.noSaveMode = false;
    state.currentPostId = '1';
    state.currentSwipeIdx = 0;
    const ctx = getCtx();
    ctx.chat = [{ mes: 'a', is_user: false, is_system: false, is_hidden: false, swipe_id: 0, swipes: ['a'] },
        { mes: 'b', is_user: false, is_system: false, is_hidden: false, swipe_id: 0, swipes: ['b'] }];

    storeFeed('<p>save-mode feed</p>', '1', 0, 'fp');
    // No schedule → debounced writer never fires; no drain needed. (We do NOT
    // call flushPinnedPersist here: a prior noSave test in this file may have
    // set the module-level Map ref, and flush would write an empty payload,
    // which has nothing to do with save mode's contract.)
    await new Promise(r => setTimeout(r, 0));

    assert.equal(store.has(LF_PINNED), false, 'save mode must never write to LF_PINNED');
    // And the feed landed in the server-file mirror instead.
    assert.equal(getFeedSlot('1', 0)?.html, '<p>save-mode feed</p>');
    // …and out of chatMetadata (save mode no longer writes the chat).
    assert.equal(ctx.chatMetadata?.dscomments_commentary?.posts, undefined);
}));

test('storeFeed in noSave mode persists to LF_PINNED and stays out of chatMetadata', withMapForage(async (store) => {
    state.settings.noSaveMode = true;
    const ctx = getCtx();

    storeFeed('<p>nosave feed</p>', '2', 0);
    flushPinnedPersist();
    await new Promise(r => setTimeout(r, 0));

    const stored = store.get(LF_PINNED);
    assert.ok(stored?.[ctx.chatId], 'noSave feed must be persisted under its chatId');
    assert.equal(stored[ctx.chatId].html, '<p>nosave feed</p>');
    // And nothing leaked into chatMetadata.
    const meta = ctx.chatMetadata?.dscomments_commentary;
    assert.equal(meta?.posts?.['2'], undefined, 'noSave mode must never write to chatMetadata');
}));

test('start screen noSave uses the stable key and survives adapter reads and clears', withMapForage(async (store) => {
    state.settings.noSaveMode = true;
    const ctx = getCtx();
    ctx.chatId = undefined;
    ctx.chatMetadata = undefined;

    storeFeed('<p>start screen feed</p>', '0', 0);
    flushPinnedPersist();
    await new Promise(r => setTimeout(r, 0));

    assert.equal(state.pinnedFeeds.has('undefined'), false);
    assert.equal(state.pinnedFeeds.get(START_SCREEN_KEY)?.html, '<p>start screen feed</p>');
    assert.equal((await getCurrentFeed())?.html, '<p>start screen feed</p>');
    assert.equal(store.get(LF_PINNED)?.[START_SCREEN_KEY]?.html, '<p>start screen feed</p>');

    clearFeed();
    flushPinnedPersist();
    await new Promise(r => setTimeout(r, 0));
    assert.equal(await getCurrentFeed(), null);
    assert.equal(store.get(LF_PINNED)?.[START_SCREEN_KEY], undefined);
}));

test('start screen save mode stays session-only and never writes pinned storage', withMapForage(async (store) => {
    state.settings.noSaveMode = false;
    const ctx = getCtx();
    ctx.chatId = undefined;
    ctx.chatMetadata = undefined;

    storeFeed('<p>save start screen</p>', '0', 0, 'fp');
    await new Promise(r => setTimeout(r, 0));

    assert.equal(store.has(LF_PINNED), false);
    assert.equal(await getCurrentFeed(), null);
    assert.equal(ctx._saveCalls, 0);
}));

test('fingerprint mismatch remains a soft signal and still returns the cached html', () => {
    const ctx = getCtx();
    ctx.chat = [{ mes: 'changed text', is_user: false, is_system: false, is_hidden: false, swipe_id: 0, swipes: ['changed text'] }];
    _seedSaveCache({ '0': { '0': { html: '<p>old</p>', timestamp: 100, fp: 'fp:old' } } });
    const html = getCachedPost('0', 0);
    assert.equal(html, '<p>old</p>');
});

test('generation fingerprint match returns cached html', () => {
    _seedSaveCache({ '1': { '0': { html: '<p>matched</p>', timestamp: 100, fp: 'message-fp', generationFp: 'generation-fp' } } });

    const html = getCachedPost('1', 0, 'generation-fp');

    assert.equal(html, '<p>matched</p>');
    assert.equal(getFeedSlot('1', 0)?.ts, 100);
});

test('generation fingerprint mismatch returns null', () => {
    _seedSaveCache({ '1': { '0': { html: '<p>stale</p>', timestamp: 100, fp: 'message-fp', generationFp: 'old-generation' } } });
    clearDebugLog();
    state.settings.debugMode = true;
    let dump = '';
    try {
        const html = getCachedPost('1', 0, 'new-generation');
        assert.equal(html, null);
    } finally {
        // dumpDebugLog() gates on debugMode — read the ring BEFORE turning it off.
        dump = dumpDebugLog();
        state.settings.debugMode = false;
    }
    clearDebugLog();

    assert.equal(getFeedSlot('1', 0)?.ts, 100);
    assert.match(dump, /context mismatch/);
    assert.doesNotMatch(dump, /old-generation|new-generation|stale/);
});

test('legacy entry without generation fingerprint misses when one is supplied', () => {
    _seedSaveCache({ '1': { '0': { html: '<p>legacy</p>', timestamp: 100, fp: 'message-fp' } } });

    const html = getCachedPost('1', 0, 'generation-fp');

    assert.equal(html, null);
    assert.equal(getFeedSlot('1', 0)?.ts, 100);
});

test('lookup without generation fingerprint preserves legacy compatibility', () => {
    _seedSaveCache({ '1': { '0': { html: '<p>legacy</p>', timestamp: 100, fp: 'message-fp' } } });

    const html = getCachedPost('1', 0);

    assert.equal(html, '<p>legacy</p>');
});

test('message fingerprint mismatch stays soft when generation fingerprint matches', () => {
    const ctx = getCtx();
    ctx.chat = [{ mes: 'changed text', is_user: false, is_system: false, is_hidden: false, swipe_id: 0, swipes: ['changed text'] }];
    _seedSaveCache({ '0': { '0': { html: '<p>old</p>', timestamp: 100, fp: 'old-message-fp', generationFp: 'generation-fp' } } });

    const html = getCachedPost('0', 0, 'generation-fp');

    assert.equal(html, '<p>old</p>');
});

test('saveGeneratedCommentary writes both fingerprint fields', () => {
    const ctx = getCtx();
    ctx.chat = [null, { mes: 'text', is_user: false, is_system: false, is_hidden: false, swipe_id: 0, swipes: ['text'] }];
    saveGeneratedCommentary('<p>one</p>', '1', 0, 'generation-fp');
    const entry = getFeedSlot('1', 0);
    assert.equal(entry.html, '<p>one</p>');
    assert.match(entry.fp, /^v2:/);
    assert.equal(entry.generationFp, 'generation-fp');
    assert.equal(ctx._saveCalls, 1);
});

test('saveGeneratedCommentary records null when generation fingerprint is omitted', () => {
    const ctx = getCtx();
    ctx.chat = [null, { mes: 'text', is_user: false, is_system: false, is_hidden: false, swipe_id: 0, swipes: ['text'] }];
    saveGeneratedCommentary('<p>legacy call</p>', '1', 0);

    assert.equal(getFeedSlot('1', 0)?.generationFp, null);
});

test('storeFeed forwards generation fingerprint to save-mode persistence', () => {
    state.settings.noSaveMode = false;
    const ctx = getCtx();
    ctx.chat = [{ mes: 'a', is_user: false, is_system: false, is_hidden: false, swipe_id: 0, swipes: ['a'] },
        null, null,
        { mes: 'b0', is_user: false, is_system: false, is_hidden: false, swipe_id: 1, swipes: ['b0', 'b1'] }];

    storeFeed('<p>stored</p>', '3', 1, 'generation-fp');

    assert.equal(getFeedSlot('3', 1)?.generationFp, 'generation-fp');
});

test('saveGeneratedCommentary observes a rejected saveMetadata without throwing', async () => {
    const ctx = getCtx();
    ctx.chat = [{ mes: 'a', is_user: false, is_system: false, is_hidden: false, swipe_id: 0, swipes: ['a'] },
        { mes: 'b', is_user: false, is_system: false, is_hidden: false, swipe_id: 0, swipes: ['b'] },
        { mes: 'text', is_user: false, is_system: false, is_hidden: false, swipe_id: 0, swipes: ['text'] }];
    const toastrCalls = [];
    globalThis.toastr = { error: (msg, title) => toastrCalls.push([msg, title]) };
    ctx.saveMetadata = async () => { throw new Error('metadata write failed'); };
    saveGeneratedCommentary('<p>fail</p>', '2', 0);
    // Give the observePersistence microtask a chance to run.
    await new Promise(r => setTimeout(r, 10));
    assert.equal(toastrCalls.length, 1);
    assert.equal(toastrCalls[0][0], 'Failed to save the chat identifier for the comments cache.');
    delete globalThis.toastr;
});
