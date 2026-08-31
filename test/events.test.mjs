// @ts-check
import '../test-helpers/stub-runtime.mjs';
import test, { afterEach, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { state, getCtx } from '../src/core.js';
import { initCacheRestore } from '../src/cache.js';
import { _seedSaveCache, _resetFeedFileStore, feedStoreSnapshot } from '../src/feed-file-store.js';
import { initFeedController } from '../src/ui/feed-controller.js';
import { bindEvents, disconnectObservers, initPostScrollObserver, unbindEvents } from '../src/events.js';
import { _testReleaseGenerationCleanup } from '../src/generator.js';

const eventTypes = {
    CHAT_CHANGED: 'CHAT_CHANGED', CHARACTER_MESSAGE_RENDERED: 'CHARACTER_MESSAGE_RENDERED',
    MESSAGE_SWIPED: 'MESSAGE_SWIPED', MESSAGE_DELETED: 'MESSAGE_DELETED', MESSAGE_EDITED: 'MESSAGE_EDITED',
    MESSAGE_SWIPE_DELETED: 'MESSAGE_SWIPE_DELETED',
};

function makeEventSource() {
    const listeners = new Map();
    return {
        on(name, fn) { listeners.set(name, fn); },
        removeListener(name) { listeners.delete(name); },
        handler(name) { return listeners.get(name); },
    };
}

function makeMessageElement(mesid, rect) {
    return {
        dataset: {},
        _rect: { ...rect },
        getAttribute(name) { return name === 'mesid' ? String(mesid) : null; },
        getBoundingClientRect() { return { ...this._rect }; },
    };
}

let feed, chatEl, observed, intersectionCallback, rafQueue;
let originalIntersectionObserver, originalMutationObserver, originalRequestAnimationFrame, originalCancelAnimationFrame;
let timeoutQueue, originalSetTimeout, originalClearTimeout;
let originalDateNow;

beforeEach(() => {
    unbindEvents();
    disconnectObservers();
    Object.assign(state, {
        settings: { enabled: true, autoUpdate: true, noSaveMode: false },
        currentChatId: 'chat-1', currentPostId: null, currentSwipeIdx: 0,
        generationEpoch: 0, generationInProgress: false, navLockUntil: 0,
    });
    const ctx = getCtx();
    Object.assign(ctx, {
        chatId: 'chat-1', chat: [], chatMetadata: {}, saveMetadata: () => {},
        eventTypes, eventSource: makeEventSource(),
    });
    globalThis._stFilesReset();
    _resetFeedFileStore();
    feed = { innerHTML: '', scrollTop: 0, querySelector: () => null };
    observed = [];
    chatEl = {
        parentElement: null, scrollHeight: 1000, clientHeight: 500, scrollTop: 0,
        querySelectorAll: () => observed, addEventListener(name, handler) {
            if (name === 'scroll') this._scrollHandler = handler;
        }, removeEventListener(name, handler) {
            if (name === 'scroll' && this._scrollHandler === handler) this._scrollHandler = null;
        },
        contains: el => observed.includes(el),
    };
    document.body = {};
    document.documentElement = {};
    document.getElementById = id => id === 'chat' ? chatEl : id === 'dscFeed' ? feed : null;
    window.innerHeight = 800;
    window.innerWidth = 1024;   // desktop by default; mobile cases override per-test
    window.getComputedStyle = () => ({ overflowY: 'visible', overflow: 'visible' });
    window.addEventListener = () => {};
    window.removeEventListener = () => {};
    originalIntersectionObserver = globalThis.IntersectionObserver;
    originalMutationObserver = globalThis.MutationObserver;
    originalRequestAnimationFrame = globalThis.requestAnimationFrame;
    originalCancelAnimationFrame = globalThis.cancelAnimationFrame;
    originalSetTimeout = globalThis.setTimeout;
    originalClearTimeout = globalThis.clearTimeout;
    originalDateNow = Date.now;
    globalThis.IntersectionObserver = class {
        constructor(callback) { intersectionCallback = callback; }
        observe() {}
        disconnect() {}
    };
    globalThis.MutationObserver = class { observe() {} disconnect() {} };
    rafQueue = [];
    timeoutQueue = [];
    globalThis.requestAnimationFrame = callback => { rafQueue.push(callback); return rafQueue.length; };
    globalThis.cancelAnimationFrame = () => {};
    globalThis.setTimeout = (callback, delay = 0) => {
        const id = timeoutQueue.length + 1;
        timeoutQueue.push({ id, callback, delay, cleared: false });
        return id;
    };
    globalThis.clearTimeout = (id) => {
        const entry = timeoutQueue.find(item => item.id === id);
        if (entry) entry.cleared = true;
    };
    initFeedController({ generateFeed: () => {} });
    initCacheRestore({ getGenerationFingerprint: async () => 'generation-current' });
});

afterEach(() => {
    unbindEvents();
    disconnectObservers();
    globalThis.IntersectionObserver = originalIntersectionObserver;
    globalThis.MutationObserver = originalMutationObserver;
    globalThis.requestAnimationFrame = originalRequestAnimationFrame;
    globalThis.cancelAnimationFrame = originalCancelAnimationFrame;
    globalThis.setTimeout = originalSetTimeout;
    globalThis.clearTimeout = originalClearTimeout;
    Date.now = originalDateNow;
});

async function flushAsync() { await Promise.resolve(); await Promise.resolve(); }
function runNextTimeout(expectedDelay) {
    const next = timeoutQueue.find(entry => !entry.cleared);
    assert.ok(next, 'expected a scheduled timeout');
    if (expectedDelay !== undefined) {
        assert.equal(next.delay, expectedDelay, `expected timeout delay ${expectedDelay}ms, got ${next.delay}ms`);
    }
    next.cleared = true;
    next.callback();
}
function runTimeoutByDelay(expectedDelay) {
    const next = timeoutQueue.find(entry => !entry.cleared && entry.delay === expectedDelay);
    assert.ok(next, `expected a scheduled timeout with delay ${expectedDelay}ms; pending=${timeoutQueue.filter(entry => !entry.cleared).map(entry => entry.delay).join(',')}`);
    next.cleared = true;
    next.callback();
}
async function selectVisible(element, ratio = 1) {
    intersectionCallback([{ target: element, isIntersecting: true, intersectionRatio: ratio }]);
    const frame = rafQueue.shift();
    assert.ok(frame, 'visible selection schedules a frame');
    frame();
    await flushAsync();
}

test('cached visible post displays its cached commentary', async () => {
    const ctx = getCtx();
    ctx.chat = [{ mes: 'visible AI message', swipe_id: 0, swipes: ['visible AI message'] }];
    _seedSaveCache({
        '0': { '0': { html: '<p>cached visible</p>', generationFp: 'generation-current' } },
    });
    const element = makeMessageElement(0, { top: 10, bottom: 110, height: 100 });
    observed.push(element);
    initPostScrollObserver();
    await selectVisible(element);
    assert.match(feed.innerHTML, /cached visible/);
    assert.equal(state.currentPostId, '0');
});

test('uncached visible post displays the empty CTA', async () => {
    const ctx = getCtx();
    ctx.chat = [{ mes: 'visible AI message', swipe_id: 0, swipes: ['visible AI message'] }];
    feed.innerHTML = '<p>previous commentary</p>';
    const element = makeMessageElement(0, { top: 10, bottom: 110, height: 100 });
    observed.push(element);
    initPostScrollObserver();
    await selectVisible(element);
    assert.match(feed.innerHTML, /dscEmptyGenerate/);
    assert.doesNotMatch(feed.innerHTML, /previous commentary/);
    assert.equal(state.currentPostId, '0');
});

test('eligible visible message below 40px remains selectable', async () => {
    const ctx = getCtx();
    ctx.chat = [{ mes: 'short DOM but eligible message', swipe_id: 0, swipes: ['short DOM but eligible message'] }];
    _seedSaveCache({
        '0': { '0': { html: '<p>small message commentary</p>', generationFp: 'generation-current' } },
    });
    const element = makeMessageElement(0, { top: 10, bottom: 30, height: 20 });
    observed.push(element);
    initPostScrollObserver();
    await selectVisible(element);
    assert.equal(state.currentPostId, '0');
    assert.match(feed.innerHTML, /small message commentary/);
});

test('visible ranking skips malformed and ineligible candidates', async () => {
    const ctx = getCtx();
    ctx.chat = [
        { mes: 'eligible lower-ratio message', swipe_id: 0, swipes: ['eligible lower-ratio message'] },
        { mes: 'message reached by malformed id', swipe_id: 0, swipes: ['message reached by malformed id'] },
        { mes: 'ineligible user message', is_user: true, swipe_id: 0, swipes: ['ineligible user message'] },
    ];
    _seedSaveCache({
        '0': { '0': { html: '<p>eligible commentary</p>', generationFp: 'generation-current' } },
    });
    const eligible = makeMessageElement(0, { top: 10, bottom: 60, height: 100 });
    const malformed = makeMessageElement('1x', { top: 10, bottom: 110, height: 100 });
    const ineligible = makeMessageElement(2, { top: 10, bottom: 100, height: 100 });
    observed.push(eligible, malformed, ineligible);
    initPostScrollObserver();
    intersectionCallback([
        { target: eligible, isIntersecting: true, intersectionRatio: 0.5 },
        { target: malformed, isIntersecting: true, intersectionRatio: 1 },
        { target: ineligible, isIntersecting: true, intersectionRatio: 0.9 },
    ]);
    const frame = rafQueue.shift();
    assert.ok(frame, 'visible selection schedules a frame');
    frame();
    await flushAsync();
    assert.equal(state.currentPostId, '0');
    assert.match(feed.innerHTML, /eligible commentary/);
});

test('newer target prevents an older async visible transition from updating the feed', async () => {
    const ctx = getCtx();
    ctx.chat = [
        { mes: 'older visible message', swipe_id: 0, swipes: ['older visible message'] },
        { mes: 'newer swiped message', swipe_id: 0, swipes: ['newer swiped message'] },
    ];
    _seedSaveCache({
        '0': { '0': { html: '<p>older commentary</p>', generationFp: 'generation-current' } },
        '1': { '0': { html: '<p>newer commentary</p>', generationFp: 'generation-current' } },
    });
    const firstFingerprint = Promise.withResolvers();
    let fingerprintCalls = 0;
    initCacheRestore({ getGenerationFingerprint: () => ++fingerprintCalls === 1
        ? firstFingerprint.promise : Promise.resolve('generation-current') });
    const element = makeMessageElement(0, { top: 10, bottom: 110, height: 100 });
    observed.push(element);
    initPostScrollObserver();
    intersectionCallback([{ target: element, isIntersecting: true, intersectionRatio: 1 }]);
    rafQueue.shift()();
    bindEvents(() => {}, ctx);
    await ctx.eventSource.handler(eventTypes.MESSAGE_SWIPED)(1);
    firstFingerprint.resolve('generation-current');
    await flushAsync();
    assert.equal(state.currentPostId, '1');
    assert.match(feed.innerHTML, /newer commentary/);
    assert.doesNotMatch(feed.innerHTML, /older commentary/);
});

test('after overscroll suppression expires, the next chat scroll pick follows the newly visible post', async () => {
    const ctx = getCtx();
    ctx.chat = [
        { mes: 'overscrolled target', swipe_id: 0, swipes: ['overscrolled target'] },
        { mes: 'manually scrolled target', swipe_id: 0, swipes: ['manually scrolled target'] },
    ];
    _seedSaveCache({
        '0': { '0': { html: '<p>overscroll commentary</p>', generationFp: 'generation-current' } },
        '1': { '0': { html: '<p>manual scroll commentary</p>', generationFp: 'generation-current' } },
    });

    // The panel has just restored #0 via overscroll and left a short nav lock.
    state.currentPostId = '0';
    state.currentSwipeIdx = 0;
    feed.innerHTML = '<p>overscroll commentary</p>';
    state.navLockUntil = Date.now() + 700;

    const overscrolled = makeMessageElement(0, { top: 10, bottom: 110, height: 100 });
    const manuallyVisible = makeMessageElement(1, { top: 120, bottom: 220, height: 100 });
    observed.push(overscrolled, manuallyVisible);
    const currentObserved = observed;
    chatEl.querySelectorAll = () => currentObserved;
    initPostScrollObserver();

    // During suppression, picks are dropped.
    intersectionCallback([
        { target: overscrolled, isIntersecting: true, intersectionRatio: 1 },
        { target: manuallyVisible, isIntersecting: true, intersectionRatio: 1 },
    ]);
    let frame = rafQueue.shift();
    assert.ok(frame, 'suppressed selection schedules a frame');
    frame();
    await flushAsync();
    assert.equal(state.currentPostId, '0', 'suppressed pick must not move the feed yet');

    // After the lock expires, a real chat scroll event should pick the new post.
    state.navLockUntil = Date.now() - 1;
    intersectionCallback([
        { target: overscrolled, isIntersecting: false, intersectionRatio: 0 },
        { target: manuallyVisible, isIntersecting: true, intersectionRatio: 1 },
    ]);
    frame = rafQueue.shift();
    assert.ok(frame, 'post-suppression scroll schedules a new frame');
    frame();
    await flushAsync();

    assert.equal(state.currentPostId, '1');
    assert.match(feed.innerHTML, /manual scroll commentary/);
});

test('after suppression expires without new scroll events, observer re-picks the current visible post', async () => {
    const ctx = getCtx();
    ctx.chat = [
        { mes: 'overscrolled target', swipe_id: 0, swipes: ['overscrolled target'] },
        { mes: 'manually scrolled target', swipe_id: 0, swipes: ['manually scrolled target'] },
    ];
    _seedSaveCache({
        '0': { '0': { html: '<p>overscroll commentary</p>', generationFp: 'generation-current' } },
        '1': { '0': { html: '<p>manual scroll commentary</p>', generationFp: 'generation-current' } },
    });

    let fakeNow = 1_000;
    Date.now = () => fakeNow;

    state.currentPostId = '0';
    state.currentSwipeIdx = 0;
    feed.innerHTML = '<p>overscroll commentary</p>';
    state.navLockUntil = fakeNow + 700;

    const overscrolled = makeMessageElement(0, { top: 10, bottom: 110, height: 100 });
    const manuallyVisible = makeMessageElement(1, { top: 120, bottom: 220, height: 100 });
    observed.push(overscrolled, manuallyVisible);
    const currentObserved = observed;
    chatEl.querySelectorAll = () => currentObserved;
    initPostScrollObserver();

    // Initial IO arrives during suppression.
    intersectionCallback([
        { target: overscrolled, isIntersecting: false, intersectionRatio: 0 },
        { target: manuallyVisible, isIntersecting: true, intersectionRatio: 1 },
    ]);
    let frame = rafQueue.shift();
    assert.ok(frame, 'suppressed selection schedules a frame');
    frame();
    await flushAsync();
    assert.equal(state.currentPostId, '0');

    // Geometry changes while the smooth scroll continues, but no fresh IO event
    // will arrive after suppression ends in the real mobile browser.
    overscrolled._rect = { top: -220, bottom: -120, height: 100 };
    manuallyVisible._rect = { top: 20, bottom: 220, height: 200 };

    fakeNow += 700;
    runTimeoutByDelay(700);
    frame = rafQueue.shift();
    assert.ok(frame, 'delayed re-pick schedules a new animation frame');
    frame();
    await flushAsync();

    assert.equal(state.currentPostId, '1');
    assert.match(feed.innerHTML, /manual scroll commentary/);
});

test('MESSAGE_SWIPED clears previous commentary on a cache miss', async () => {
    const ctx = getCtx();
    ctx.chat = [{ mes: 'swiped AI message', swipe_id: 0, swipes: ['swiped AI message'] }];
    feed.innerHTML = '<p>previous commentary</p>';
    bindEvents(() => {}, ctx);
    await ctx.eventSource.handler(eventTypes.MESSAGE_SWIPED)(0);
    assert.equal(state.currentPostId, '0');
    assert.match(feed.innerHTML, /dscEmptyGenerate/);
    assert.doesNotMatch(feed.innerHTML, /previous commentary/);
});

test('MESSAGE_EDITED clears previous commentary on a cache miss', async () => {
    const ctx = getCtx();
    ctx.chat = [{ mes: 'edited AI message', swipe_id: 0, swipes: ['edited AI message'] }];
    state.currentPostId = '0';
    feed.innerHTML = '<p>previous commentary</p>';
    bindEvents(() => {}, ctx);
    await ctx.eventSource.handler(eventTypes.MESSAGE_EDITED)(0);
    assert.match(feed.innerHTML, /dscEmptyGenerate/);
    assert.doesNotMatch(feed.innerHTML, /previous commentary/);
});

test('reopen window suppresses scroll-driven clobber of the restored target', async () => {
    const ctx = getCtx();
    ctx.chat = [
        { mes: 'older visible AI message', swipe_id: 0, swipes: ['older visible AI message'] },
        { mes: 'newer restored AI message', swipe_id: 0, swipes: ['newer restored AI message'] },
    ];
    // Only the restored post (1) has cached commentary; post 0 is uncached, so a
    // scroll-driven switch to post 0 would replace the feed with the empty CTA.
    _seedSaveCache({
        '1': { '0': { html: '<p>restored commentary</p>', generationFp: 'generation-current' } },
    });
    // Simulate reopen restore: target P (post 1) is current and its feed is shown.
    // restoreFeedForCurrentContext() raises navLockUntil for the restore window;
    // the very first IntersectionObserver pick right after reveal must NOT clobber.
    state.currentPostId = '1';
    state.currentSwipeIdx = 0;
    state.navLockUntil = Date.now() + 1500;   // reopen window active
    feed.innerHTML = '<p>restored commentary</p>';

    const older = makeMessageElement(0, { top: 10, bottom: 110, height: 100 });
    const restored = makeMessageElement(1, { top: 120, bottom: 220, height: 100 });
    observed.push(older, restored);
    initPostScrollObserver();
    // Both posts are fully visible (ratio 1.0). While the reopen lock is active
    // the pick is suppressed, so the restored target survives.
    intersectionCallback([
        { target: older, isIntersecting: true, intersectionRatio: 1 },
        { target: restored, isIntersecting: true, intersectionRatio: 1 },
    ]);
    const frame = rafQueue.shift();
    assert.ok(frame, 'a frame is scheduled');
    frame();
    await flushAsync();

    assert.equal(state.currentPostId, '1', 'restored target survives the reopen window');
    assert.match(feed.innerHTML, /restored commentary/);
    assert.doesNotMatch(feed.innerHTML, /dscEmptyGenerate/);
});

test('scroll-follow resumes after the reopen window expires (mobile regression)', async () => {
    const ctx = getCtx();
    ctx.chat = [
        { mes: 'older visible AI message', swipe_id: 0, swipes: ['older visible AI message'] },
        { mes: 'newer restored AI message', swipe_id: 0, swipes: ['newer restored AI message'] },
    ];
    _seedSaveCache({
        '1': { '0': { html: '<p>restored commentary</p>', generationFp: 'generation-current' } },
    });
    state.currentPostId = '1';
    state.currentSwipeIdx = 0;
    feed.innerHTML = '<p>restored commentary</p>';
    // Mobile viewport. The old code permanently disabled scroll-follow here
    // whenever the panel was open; the fix gates it ONLY on the reopen window.
    window.innerWidth = 375;
    state.navLockUntil = 0;   // reopen window has expired — auto-follow is live

    const older = makeMessageElement(0, { top: 10, bottom: 110, height: 100 });
    const restored = makeMessageElement(1, { top: 120, bottom: 220, height: 100 });
    observed.push(older, restored);
    initPostScrollObserver();
    intersectionCallback([
        { target: older, isIntersecting: true, intersectionRatio: 1 },
        { target: restored, isIntersecting: true, intersectionRatio: 1 },
    ]);
    const frame = rafQueue.shift();
    assert.ok(frame, 'visible selection schedules a frame');
    frame();
    await flushAsync();

    // Auto-follow is restored on mobile once the reopen window is over: the
    // pick switches to the best-visible post (oldest wins the ratio tie).
    assert.equal(state.currentPostId, '0');
    assert.match(feed.innerHTML, /dscEmptyGenerate/);
});

// ── Simplified sync contract (2026-07-26) ──
// Chat is the source of truth. Scroll-follow is the primary restore path and
// must NOT be starved by long nav locks. MESSAGE_SWIPED remains the canonical
// swipe path. See the simplified-sync contract in src/ui/st-swipe-bridge.js (file header).

test('scroll observer restores cache after the nav lock has expired (chat is source of truth)', async () => {
    const ctx = getCtx();
    ctx.chat = [{
        mes: 'visible AI post with swipes',
        is_user: false, is_system: false, is_hidden: false,
        swipe_id: 2, swipes: ['s0', 's1', 's2'],
    }];
    _seedSaveCache({
        '0': { '2': { html: '<div class="dsc_message">cached swipe-2</div>', generationFp: 'generation-current' } },
    });
    // navLockUntil just expired — observer picks must run.
    state.navLockUntil = Date.now() - 1;
    const element = makeMessageElement(0, { top: 10, bottom: 110, height: 100 });
    observed.push(element);
    initPostScrollObserver();
    await selectVisible(element);
    assert.equal(state.currentPostId, '0');
    assert.equal(state.currentSwipeIdx, 2, 'swipe index comes from the chat source-of-truth swipe_id');
    assert.match(feed.innerHTML, /dsc_message/);
    assert.match(feed.innerHTML, /cached swipe-2/);
});

test('MESSAGE_SWIPED remains the canonical chat swipe -> comments path', async () => {
    const ctx = getCtx();
    ctx.chat = [{
        mes: 'swiped AI post',
        is_user: false, is_system: false, is_hidden: false,
        swipe_id: 1, swipes: ['s0', 's1'],
    }];
    _seedSaveCache({
        '0': { '1': { html: '<div class="dsc_message">swipe cache</div>', generationFp: 'generation-current' } },
    });
    bindEvents(() => {}, ctx);
    await ctx.eventSource.handler(eventTypes.MESSAGE_SWIPED)(0);
    assert.equal(state.currentPostId, '0');
    assert.equal(state.currentSwipeIdx, 1);
    assert.match(feed.innerHTML, /dsc_message/);
    assert.match(feed.innerHTML, /swipe cache/);
});

test('scroll during generation records observed target without changing generation target', async () => {
    const ctx = getCtx();
    ctx.chat = [
        { mes: 'generation target', swipe_id: 0, swipes: ['generation target'] },
        { mes: 'user scrolled here', swipe_id: 2, swipes: ['s0', 's1', 's2'] },
    ];
    state.generationInProgress = true;
    state.generationTarget = { chatId: 'chat-1', msgId: '0', swipeIdx: 0 };
    state.generationObservedTarget = null;
    state.currentPostId = '0';
    state.currentSwipeIdx = 0;

    const element = makeMessageElement(1, { top: 10, bottom: 110, height: 100 });
    observed.push(element);
    initPostScrollObserver();
    await selectVisible(element);

    assert.deepEqual(state.generationTarget, { chatId: 'chat-1', msgId: '0', swipeIdx: 0 });
    assert.deepEqual(state.generationObservedTarget, { msgId: '1', swipeIdx: 2, source: 'scroll' });
    assert.equal(state.currentPostId, '0', 'scroll observation must not retarget the in-flight generation');
});

test('generation completion does not suppress scroll-follow for long periods', () => {
    // Simulate a stale long lock left over from a pre-simplification world, then
    // release the cleanup tail. After cleanup, navLockUntil must be a short
    // settle window (<1s) so the scroll observer resumes immediately.
    state.navLockUntil = Date.now() + 15000;
    _testReleaseGenerationCleanup();
    assert.ok(state.navLockUntil - Date.now() < 1000,
        `cleanup must trim navLockUntil to a short settle, got ${state.navLockUntil - Date.now()}ms`);
    assert.equal(state.generationInProgress, false);
});

test('desktop still switches to the best-visible post (no reopen lock, default state)', async () => {
    const ctx = getCtx();
    ctx.chat = [
        { mes: 'older visible AI message', swipe_id: 0, swipes: ['older visible AI message'] },
        { mes: 'newer restored AI message', swipe_id: 0, swipes: ['newer restored AI message'] },
    ];
    _seedSaveCache({
        '1': { '0': { html: '<p>restored commentary</p>', generationFp: 'generation-current' } },
    });
    state.currentPostId = '1';
    state.currentSwipeIdx = 0;
    feed.innerHTML = '<p>restored commentary</p>';
    window.innerWidth = 1024;   // desktop, no reopen lock — auto-follow is live

    const older = makeMessageElement(0, { top: 10, bottom: 110, height: 100 });
    const restored = makeMessageElement(1, { top: 120, bottom: 220, height: 100 });
    observed.push(older, restored);
    initPostScrollObserver();
    intersectionCallback([
        { target: older, isIntersecting: true, intersectionRatio: 1 },
        { target: restored, isIntersecting: true, intersectionRatio: 1 },
    ]);
    const frame = rafQueue.shift();
    assert.ok(frame, 'visible selection schedules a frame');
    frame();
    await flushAsync();

    // Desktop auto-follow is preserved: the pick switches to the best-visible
    // post (oldest wins the ratio tie).
    assert.equal(state.currentPostId, '0');
    assert.match(feed.innerHTML, /dscEmptyGenerate/);
});

test('MutationObserver observes direct children only (no subtree — avoids per-token scan during streaming)', () => {
    let observeOptions;
    globalThis.MutationObserver = class {
        observe(_target, options) { observeOptions = options; }
        disconnect() {}
    };
    const ctx = getCtx();
    ctx.chat = [{ mes: 'AI', is_user: false, is_system: false, is_hidden: false, swipe_id: 0, swipes: ['AI'] }];
    observed.push(makeMessageElement(0, { top: 0, bottom: 100, height: 100 }));
    initPostScrollObserver();

    assert.ok(observeOptions, 'MutationObserver.observe was called');
    assert.deepEqual(observeOptions, { childList: true },
        '.mes are direct children of #chat — subtree would fire on every streaming token for nothing');
});

// ── Server-file store integration (v2 storage) ──

test('CHAT_CHANGED loads the chat file from the server before restoring', async () => {
    const ctx = getCtx();
    ctx.chat = [{ mes: 'restored AI', swipe_id: 0, swipes: ['restored AI'], swipe_info: [{ send_date: '2026-08-19T10:00:00.000Z' }] }];
    ctx.chatMetadata.dscomments_commentary = { guid: 'gg' };
    // Server file exists with an entry for this chat's only slot:
    globalThis._stFiles['dsc_gg.json'] = JSON.stringify({
        v: 2,
        entries: { '2026-08-19T10:00:00.000Z': { html: '<p>from server file</p>', ts: 1, generationFp: 'generation-current' } },
    });
    state.currentChatId = 'chat-other';   // force the switch branch
    bindEvents(() => {}, ctx);
    await ctx.eventSource.handler(eventTypes.CHAT_CHANGED)();

    assert.equal(feedStoreSnapshot().loaded, true, 'mirror was loaded');
    assert.match(feed.innerHTML, /from server file/, 'restore read the server-loaded mirror');
});

test('MESSAGE_SWIPE_DELETED GCs the dead swipe entry and keeps survivors', async () => {
    const ctx = getCtx();
    ctx.chat = [{
        mes: 's1', is_user: false, is_system: false, is_hidden: false,
        swipe_id: 0, swipes: ['s0', 's1'],
        swipe_info: [{ send_date: '2026-08-19T10:00:00.000Z' }, { send_date: '2026-08-19T11:00:00.000Z' }],
    }];
    _seedSaveCache({
        '0': {
            '0': { html: '<p>survivor</p>', timestamp: 1, generationFp: 'generation-current' },
            '1': { html: '<p>dead swipe</p>', timestamp: 2, generationFp: 'generation-current' },
        },
    });
    bindEvents(() => {}, ctx);
    // ST already spliced swipe 1 away before emitting:
    ctx.chat[0].swipes.splice(1, 1);
    ctx.chat[0].swipe_info.splice(1, 1);

    await ctx.eventSource.handler(eventTypes.MESSAGE_SWIPE_DELETED)({ messageId: 0, swipeId: 1, newSwipeId: 0 });

    const entries = feedStoreSnapshot().entries;
    const values = Object.values(entries).map(e => e.html);
    assert.ok(values.includes('<p>survivor</p>'), 'surviving swipe keeps its entry');
    assert.ok(!values.includes('<p>dead swipe</p>'), 'dead swipe entry is pruned');
});

test('MESSAGE_DELETED GCs the dead message entries and falls back to the last AI post', async () => {
    const ctx = getCtx();
    ctx.chat = [
        { mes: 'gone', is_user: false, is_system: false, is_hidden: false, swipe_id: 0, swipes: ['gone'], swipe_info: [{ send_date: '2026-08-19T10:00:00.000Z' }] },
        { mes: 'stays', is_user: false, is_system: false, is_hidden: false, swipe_id: 0, swipes: ['stays'], swipe_info: [{ send_date: '2026-08-19T11:00:00.000Z' }] },
    ];
    _seedSaveCache({
        '0': { '0': { html: '<p>dead message feed</p>', timestamp: 1, generationFp: 'generation-current' } },
        '1': { '0': { html: '<p>fallback feed</p>', timestamp: 2, generationFp: 'generation-current' } },
    });
    state.currentPostId = '0';   // viewing the post that is about to die
    bindEvents(() => {}, ctx);
    // ST removed message 0:
    ctx.chat.splice(0, 1);

    await ctx.eventSource.handler(eventTypes.MESSAGE_DELETED)(ctx.chat.length);

    assert.equal(state.currentPostId, '0', 'pointer fell back to the surviving last AI post');
    assert.match(feed.innerHTML, /fallback feed/, 'panel shows the fallback post feed');
    const values = Object.values(feedStoreSnapshot().entries).map(e => e.html);
    assert.ok(!values.includes('<p>dead message feed</p>'), 'dead message entries pruned');
});
