// @ts-check
/**
 * DS Comments — feed gesture navigation tests.
 *
 * Regression: pulling the feed (overscroll) or flipping swipes onto an adjacent
 * post/swipe WITHOUT cached commentary must show the empty-state CTA, not leave
 * the previous post's commentary on screen.
 *
 * Root cause: restoreCachedCommentary only mutates state.currentPostId on a cache
 * HIT. On a miss it returns false leaving currentPostId unchanged, so the old
 * guard `currentPostId === msgId` was false and the empty CTA never rendered.
 * Fix: setCurrentPost + setFeedText('') run UNCONDITIONALLY on a miss.
 */

import '../test-helpers/stub-runtime.mjs';
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { state, getCtx } from '../src/core.js';
import {
    initCacheRestore,
    selectCommentaryTarget,
    restoreCachedCommentary,
} from '../src/cache.js';
import { _seedSaveCache, _resetFeedFileStore } from '../src/feed-file-store.js';
import { initFeedController } from '../src/ui/feed-controller.js';
import { initFeedGestures, _testGoToAdjacentPost, _testGoToAdjacentSwipe } from '../src/ui/feed-gestures.js';
import { _testInject } from '../src/ui/st-swipe-bridge.js';

let feed;

beforeEach(() => {
    state.settings = { enabled: true, autoUpdate: true, noSaveMode: false };
    state.currentPostId = null;
    state.currentSwipeIdx = 0;
    state.generationInProgress = false;
    state.generationEpoch = 0;
    state.navLockUntil = 0;
    state.pinnedFeeds.clear();
    const ctx = getCtx();
    ctx.chatId = 'chat-1';
    ctx.chatMetadata = {};
    ctx.saveMetadata = () => {};
    _resetFeedFileStore();
    feed = { innerHTML: '', scrollTop: 0, querySelector: () => null };
    document.getElementById = (id) => (id === 'dscFeed' ? feed : null);
    initFeedController({ generateFeed: () => {} });
    initCacheRestore({ getGenerationFingerprint: async () => 'fp-current' });
    _testInject(null);   // reset swipe mock
});

/**
 * Two AI posts: #0 cached, #1 uncached. Positioned on the cached post so the
 * feed shows commentary (the precondition for the bug).
 */
async function positionedOnCachedPost() {
    const ctx = getCtx();
    ctx.chat = [
        { mes: 'cached AI post body', is_user: false, is_system: false, is_hidden: false, swipe_id: 0, swipes: ['cached AI post body'] },
        { mes: 'uncached AI post body', is_user: false, is_system: false, is_hidden: false, swipe_id: 0, swipes: ['uncached AI post body'] },
    ];
    _seedSaveCache({
        '0': { '0': { html: '<p>cached comments for #0</p>', timestamp: 1, generationFp: 'fp-current' } },
    });
    await restoreCachedCommentary('0', 0);
    assert.match(feed.innerHTML, /cached comments for #0/);
}

test('pull down to an uncached adjacent post shows the empty CTA (regression)', async () => {
    await positionedOnCachedPost();

    await _testGoToAdjacentPost(1);   // #0 → #1 (uncached)

    assert.equal(state.currentPostId, '1', 'position advanced to the uncached post');
    assert.ok(
        feed.innerHTML.includes('dscEmptyGenerate'),
        `feed must show the empty CTA for the uncached post, got: ${feed.innerHTML}`,
    );
    assert.doesNotMatch(
        feed.innerHTML, /cached comments for #0/,
        'previous post commentary must be cleared',
    );
});

test('pull up back to a cached adjacent post restores its commentary', async () => {
    await positionedOnCachedPost();
    // #0 → #1 (uncached): CTA shown.
    await _testGoToAdjacentPost(1);
    assert.ok(feed.innerHTML.includes('dscEmptyGenerate'));
    // In real use a second gesture comes well after the 800ms nav lock.
    state.navLockUntil = 0;
    // #1 → #0 (cached): commentary restored.
    await _testGoToAdjacentPost(-1);
    assert.match(feed.innerHTML, /cached comments for #0/);
    assert.ok(!feed.innerHTML.includes('dscEmptyGenerate'));
});

test('overscroll sequence restores cached A after uncached B shows the empty CTA', async () => {
    await positionedOnCachedPost();

    await _testGoToAdjacentPost(1);   // cached A -> uncached B
    assert.equal(state.currentPostId, '1');
    assert.match(feed.innerHTML, /dscEmptyGenerate/);
    state.navLockUntil = 0;

    await _testGoToAdjacentPost(-1);  // uncached B -> cached A
    assert.equal(state.currentPostId, '0');
    assert.match(feed.innerHTML, /cached comments for #0/);
    assert.doesNotMatch(feed.innerHTML, /dscEmptyGenerate/);
});

test('superseded old overscroll cannot erase a newer selected feed', async () => {
    const ctx = getCtx();
    ctx.chat = [
        { mes: 'A', is_user: false, is_system: false, is_hidden: false, swipe_id: 0, swipes: ['A'] },
        { mes: 'B', is_user: false, is_system: false, is_hidden: false, swipe_id: 0, swipes: ['B'] },
    ];
    _seedSaveCache({
        '0': { '0': { html: '<p>newer A</p>', timestamp: 1, generationFp: 'fp-current' } },
    });
    const oldFingerprint = Promise.withResolvers();
    const newFingerprint = Promise.withResolvers();
    let calls = 0;
    initCacheRestore({
        getGenerationFingerprint: () => (++calls === 1 ? oldFingerprint.promise : newFingerprint.promise),
    });
    state.currentPostId = '1';
    feed.innerHTML = '<p>previously visible</p>';

    const oldOverscroll = _testGoToAdjacentPost(-1); // B -> A, delayed
    state.navLockUntil = 0;
    const newerSelection = selectCommentaryTarget('0', 0, { source: 'overscroll' });
    newFingerprint.resolve('fp-current');
    assert.deepEqual(await newerSelection, { status: 'hit', msgId: '0', swipeIdx: 0 });
    oldFingerprint.resolve('fp-current');
    await oldOverscroll;

    assert.match(feed.innerHTML, /newer A/);
    assert.doesNotMatch(feed.innerHTML, /dscEmptyGenerate/);
    assert.equal(state.currentPostId, '0');
});

// ── Simplified sync contract (2026-07-26) ──
// Horizontal panel swipe restores cached local commentary directly; it no
// longer depends on the ST swipe bridge for correctness. See
// See the simplified-sync contract in src/ui/st-swipe-bridge.js (file header).

test('panel horizontal swipe no longer depends on the ST bridge for correctness', async () => {
    const ctx = getCtx();
    ctx.chat = [{
        mes: 'swipe-0 text', is_user: false, is_system: false, is_hidden: false,
        swipe_id: 1, swipes: ['swipe-0 text', 'swipe-1 text', 'swipe-2 text'],
    }];
    state.currentPostId = '0';
    state.currentSwipeIdx = 1;
    // Seed cache for the adjacent swipes only — the bridge mock records any
    // call so we can prove the gesture path never reached it.
    _seedSaveCache({
        '0': {
            '0': { html: '<div class="dsc_message">prev</div>', timestamp: 1, generationFp: 'fp-current' },
            '2': { html: '<div class="dsc_message">next</div>', timestamp: 1, generationFp: 'fp-current' },
        },
    });
    const bridgeCalls = [];
    _testInject({
        swipe: async () => { bridgeCalls.push('called'); },
        SWIPE_DIRECTION: { LEFT: 'LEFT', RIGHT: 'RIGHT' },
        SWIPE_SOURCE: { SWIPE_PICKER: 'SWIPE_PICKER' },
    });

    await _testGoToAdjacentSwipe(1);   // swipe 1 → 2 (cached 'next')

    assert.equal(bridgeCalls.length, 0, 'simplified mode must NOT reach the ST swipe bridge');
    assert.equal(state.currentPostId, '0');
    assert.equal(state.currentSwipeIdx, 2);
    assert.match(feed.innerHTML, /next/);
});

test('panel vertical overscroll still scrolls chat and restores target post commentary', async () => {
    const ctx = getCtx();
    ctx.chat = [
        { mes: 'A', is_user: false, is_system: false, is_hidden: false, swipe_id: 0, swipes: ['A'] },
        { mes: 'B', is_user: false, is_system: false, is_hidden: false, swipe_id: 0, swipes: ['B'] },
        { mes: 'C', is_user: false, is_system: false, is_hidden: false, swipe_id: 4, swipes: ['c0', 'c1', 'c2', 'c3', 'c4'] },
    ];
    state.currentPostId = '1';
    state.currentSwipeIdx = 0;
    _seedSaveCache({
        '2': { '4': { html: '<div class="dsc_message">target</div>', timestamp: 1, generationFp: 'fp-current' } },
    });
    // Stub scrollChatToPost (DOM scrollIntoView) — non-critical in tests.
    document.querySelector = () => null;

    await _testGoToAdjacentPost(1);   // #1 → #2

    assert.equal(state.currentPostId, '2');
    assert.equal(state.currentSwipeIdx, 4, 'overscroll reads swipe_id from the chat target');
    assert.match(feed.innerHTML, /target/);
});

test('pull at the last post does nothing (edge guard)', async () => {
    await positionedOnCachedPost();
    // Position on the last post (#1, uncached) via two steps.
    await _testGoToAdjacentPost(1);
    state.navLockUntil = 0;
    const htmlBefore = feed.innerHTML;
    // dir=+1 at the last index is a no-op (stays on #1).
    await _testGoToAdjacentPost(1);
    assert.equal(feed.innerHTML, htmlBefore);
});

// ── Horizontal swipe (local-only, simplified sync model) ──
// The panel horizontal swipe restores cached commentary LOCALLY via
// selectCommentaryTarget. The ST swipe bridge is deferred and must never be
// reached from the gesture path. These tests cover the local-only edges.

/**
 * Set up a single AI post with 3 swipes. Position on swipe 0, inject a mock
 * swipe() that records calls — the simplified path must NEVER invoke it.
 */
function setupMultiSwipePost() {
    const ctx = getCtx();
    ctx.chat = [
        {
            mes: 'swipe-0 text', is_user: false, is_system: false, is_hidden: false,
            swipe_id: 0, swipes: ['swipe-0 text', 'swipe-1 text', 'swipe-2 text'],
        },
    ];
    state.currentPostId = '0';
    state.currentSwipeIdx = 0;
}

test('horizontal swipe restores the next cached swipe locally (no bridge)', async () => {
    setupMultiSwipePost();
    _seedSaveCache({
        '0': { '1': { html: '<p>swipe-1 comments</p>', timestamp: 1, generationFp: 'fp-current' } },
    });
    const bridgeCalls = [];
    _testInject({
        swipe: async () => { bridgeCalls.push('called'); },
        SWIPE_DIRECTION: { LEFT: 'LEFT', RIGHT: 'RIGHT' },
        SWIPE_SOURCE: { SWIPE_PICKER: 'SWIPE_PICKER' },
    });

    await _testGoToAdjacentSwipe(1);   // swipe 0 → 1

    assert.equal(bridgeCalls.length, 0, 'simplified mode must NOT call ST swipe()');
    assert.equal(state.currentSwipeIdx, 1, 'local restore advances currentSwipeIdx');
    assert.match(feed.innerHTML, /swipe-1 comments/);
});

test('horizontal swipe back restores the previous cached swipe locally', async () => {
    setupMultiSwipePost();
    getCtx().chat[0].swipe_id = 2;
    state.currentSwipeIdx = 2;
    _seedSaveCache({
        '0': { '1': { html: '<p>swipe-1 comments</p>', timestamp: 1, generationFp: 'fp-current' } },
    });
    const bridgeCalls = [];
    _testInject({
        swipe: async () => { bridgeCalls.push('called'); },
        SWIPE_DIRECTION: { LEFT: 'LEFT', RIGHT: 'RIGHT' },
        SWIPE_SOURCE: { SWIPE_PICKER: 'SWIPE_PICKER' },
    });

    await _testGoToAdjacentSwipe(-1);  // swipe 2 → 1

    assert.equal(bridgeCalls.length, 0, 'simplified mode must NOT call ST swipe()');
    assert.equal(state.currentSwipeIdx, 1);
    assert.match(feed.innerHTML, /swipe-1 comments/);
});

test('horizontal swipe at the first swipe is a no-op (edge guard)', async () => {
    setupMultiSwipePost();
    state.currentSwipeIdx = 0;

    const bridgeCalls = [];
    _testInject({
        swipe: async () => { bridgeCalls.push('called'); },
        SWIPE_DIRECTION: { LEFT: 'LEFT', RIGHT: 'RIGHT' },
        SWIPE_SOURCE: { SWIPE_PICKER: 'SWIPE_PICKER' },
    });

    await _testGoToAdjacentSwipe(-1);  // dir=-1 at swipe 0: already at edge

    assert.equal(bridgeCalls.length, 0, 'swipe() should NOT be called at the first swipe boundary');
    assert.equal(state.currentSwipeIdx, 0);
});

test('horizontal swipe at the last swipe is a no-op (edge guard)', async () => {
    setupMultiSwipePost();
    getCtx().chat[0].swipe_id = 2;
    state.currentSwipeIdx = 2;

    const bridgeCalls = [];
    _testInject({
        swipe: async () => { bridgeCalls.push('called'); },
        SWIPE_DIRECTION: { LEFT: 'LEFT', RIGHT: 'RIGHT' },
        SWIPE_SOURCE: { SWIPE_PICKER: 'SWIPE_PICKER' },
    });

    await _testGoToAdjacentSwipe(1);   // dir=+1 at last swipe: already at edge

    assert.equal(bridgeCalls.length, 0, 'swipe() should NOT be called at the last swipe boundary');
    assert.equal(state.currentSwipeIdx, 2);
});

test('horizontal swipe to an uncached adjacent swipe shows the empty CTA', async () => {
    setupMultiSwipePost();
    state.currentSwipeIdx = 0;
    feed.innerHTML = '<p>previous swipe commentary</p>';

    const bridgeCalls = [];
    _testInject({
        swipe: async () => { bridgeCalls.push('called'); },
        SWIPE_DIRECTION: { LEFT: 'LEFT', RIGHT: 'RIGHT' },
        SWIPE_SOURCE: { SWIPE_PICKER: 'SWIPE_PICKER' },
    });

    await _testGoToAdjacentSwipe(1);   // swipe 0 → 1 (uncached)

    assert.equal(bridgeCalls.length, 0);
    assert.equal(state.currentSwipeIdx, 1, 'position still advances to show the empty CTA');
    assert.match(feed.innerHTML, /dscEmptyGenerate/);
    assert.doesNotMatch(feed.innerHTML, /previous swipe commentary/);
});

test('vertical overscroll is a complete no-op in noSaveMode', async () => {
    state.settings.noSaveMode = true;
    const ctx = getCtx();
    ctx.chat = [
        { mes: 'A', is_user: false, is_system: false, is_hidden: false, swipe_id: 0, swipes: ['A'] },
        { mes: 'B', is_user: false, is_system: false, is_hidden: false, swipe_id: 1, swipes: ['b0', 'B'] },
    ];
    state.currentPostId = '0';
    state.currentSwipeIdx = 0;
    state.navLockUntil = 0;
    feed.innerHTML = '<p>pinned feed remains visible</p>';

    await _testGoToAdjacentPost(1);

    assert.equal(state.currentPostId, '0');
    assert.equal(state.currentSwipeIdx, 0);
    assert.equal(state.navLockUntil, 0);
    assert.match(feed.innerHTML, /pinned feed remains visible/);
});

test('horizontal swipe is a no-op in noSaveMode', async () => {
    state.settings.noSaveMode = true;
    setupMultiSwipePost();

    const bridgeCalls = [];
    _testInject({
        swipe: async () => { bridgeCalls.push('called'); },
        SWIPE_DIRECTION: { LEFT: 'LEFT', RIGHT: 'RIGHT' },
        SWIPE_SOURCE: { SWIPE_PICKER: 'SWIPE_PICKER' },
    });

    await _testGoToAdjacentSwipe(1);

    assert.equal(bridgeCalls.length, 0, 'swipe() should NOT be called in noSaveMode');
    assert.equal(state.currentSwipeIdx, 0, 'noSaveMode leaves the swipe pointer untouched');
});

function makeGestureFeed() {
    const listeners = new Map();
    const gestureFeed = {
        innerHTML: '',
        scrollTop: 0,
        clientHeight: 100,
        scrollHeight: 100,
        parentElement: { insertBefore() {} },
        addEventListener(type, handler) { listeners.set(type, handler); },
        querySelector: () => null,
    };
    document.getElementById = id => id === 'dscFeed' ? gestureFeed : null;
    return { feed: gestureFeed, listeners };
}

function touchEvent(x, y) {
    let prevented = false;
    return {
        touches: [{ clientX: x, clientY: y }],
        preventDefault() { prevented = true; },
        get prevented() { return prevented; },
    };
}

test('noSave touch gestures neither navigate nor consume horizontal movement', async () => {
    state.settings.noSaveMode = true;
    const ctx = getCtx();
    ctx.chat = [
        { mes: 'A', is_user: false, is_system: false, is_hidden: false, swipe_id: 0, swipes: ['A', 'A-alt'] },
        { mes: 'B', is_user: false, is_system: false, is_hidden: false, swipe_id: 0, swipes: ['B'] },
    ];
    state.currentPostId = '0';
    state.currentSwipeIdx = 0;
    const { feed: gestureFeed, listeners } = makeGestureFeed();
    gestureFeed.innerHTML = '<p>pinned feed remains visible</p>';
    initFeedGestures();

    listeners.get('touchstart')(touchEvent(40, 40));
    const horizontal = touchEvent(120, 40);
    listeners.get('touchmove')(horizontal);
    listeners.get('touchend')();

    assert.equal(horizontal.prevented, false, 'noSave must not capture horizontal touch');
    assert.equal(state.currentPostId, '0');
    assert.equal(state.currentSwipeIdx, 0);
    assert.equal(state.navLockUntil, 0);
    assert.match(gestureFeed.innerHTML, /pinned feed remains visible/);
});

test('noSave wheel ignores edge input without indicator or navigation work', () => {
    state.settings.noSaveMode = true;
    const { feed: gestureFeed, listeners } = makeGestureFeed();
    let layoutReads = 0;
    Object.defineProperties(gestureFeed, {
        scrollTop: { get() { layoutReads++; return 0; } },
        clientHeight: { get() { layoutReads++; return 100; } },
        scrollHeight: { get() { layoutReads++; return 100; } },
    });
    let indicatorCreates = 0;
    document.createElement = () => { indicatorCreates++; return {}; };
    initFeedGestures();

    listeners.get('wheel')({ deltaY: 500 });

    assert.equal(layoutReads, 0, 'noSave wheel must exit before edge layout reads');
    assert.equal(indicatorCreates, 0, 'noSave wheel must not create an indicator');
    assert.equal(state.navLockUntil, 0);
});
