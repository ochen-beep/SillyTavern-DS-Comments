// @ts-check
/**
 * DS Comments — pinned-store unit tests.
 *
 * The store persists state.pinnedFeeds (noSave mode) to localforage so a feed
 * survives F5. These tests use a Map-backed localforage mock and exercise the
 * module in isolation (no cache.js / DOM wiring).
 */

import '../test-helpers/stub-runtime.mjs';
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { state, LF_PINNED, START_SCREEN_KEY } from '../src/core.js';
import {
    loadPinnedFeeds, schedulePinnedPersist, flushPinnedPersist, clearPinnedPersist, _MAX_CHATS, _resetPinnedState,
} from '../src/pinned-store.js';

/** Microtask drain — flush() may return undefined (lodash) or a promise (stub),
 *  so we let the host spin once to settle the async setItem. */
const settle = () => new Promise(r => setTimeout(r, 0));

function makeForage() {
    const store = new Map();
    return {
        store,
        getItem: async (k) => store.has(k) ? store.get(k) : null,
        setItem: async (k, v) => { store.set(k, v); },
        removeItem: async (k) => { store.delete(k); },
        keys: async () => Array.from(store.keys()),
    };
}

let forage;
beforeEach(() => {
    forage = makeForage();
    globalThis.SillyTavern.libs.localforage = forage;
    state.pinnedFeeds.clear();
    _resetPinnedState();
});

test('loadPinnedFeeds hydrates the Map from a persisted record', async () => {
    forage.store.set(LF_PINNED, {
        'chat-a': { html: '<p>a</p>', msgId: '3', swipeIdx: 1, ts: 1000 },
        'chat-b': { html: '<p>b</p>', msgId: '0', swipeIdx: 0, ts: 2000 },
    });

    await loadPinnedFeeds(state.pinnedFeeds);

    assert.equal(state.pinnedFeeds.size, 2);
    assert.deepEqual(state.pinnedFeeds.get('chat-a'), { html: '<p>a</p>', msgId: '3', swipeIdx: 1, ts: 1000 });
    assert.deepEqual(state.pinnedFeeds.get('chat-b'), { html: '<p>b</p>', msgId: '0', swipeIdx: 0, ts: 2000 });
});

test('loadPinnedFeeds clears the Map first (no stale leftovers from a prior chat)', async () => {
    state.pinnedFeeds.set('stale', { html: '<p>x</p>', msgId: '0', swipeIdx: 0, ts: 1 });
    forage.store.set(LF_PINNED, { 'fresh': { html: '<p>y</p>', msgId: '0', swipeIdx: 0, ts: 2 } });

    await loadPinnedFeeds(state.pinnedFeeds);

    assert.equal(state.pinnedFeeds.has('stale'), false);
    assert.equal(state.pinnedFeeds.get('fresh').html, '<p>y</p>');
});

test('loadPinnedFeeds drops corrupt entries without throwing', async () => {
    forage.store.set(LF_PINNED, {
        'good': { html: '<p>ok</p>', msgId: '0', swipeIdx: 0, ts: 1 },
        'bad-nohtml': { msgId: '0', swipeIdx: 0, ts: 1 },
        'bad-wrongtype': 'not an object',
        'bad-null': null,
    });

    await loadPinnedFeeds(state.pinnedFeeds);

    assert.equal(state.pinnedFeeds.size, 1);
    assert.ok(state.pinnedFeeds.has('good'));
});

test('loadPinnedFeeds migrates legacy undefined start-screen entry', async () => {
    forage.store.set(LF_PINNED, {
        undefined: { html: '<p>legacy start</p>', msgId: '0', swipeIdx: 0, ts: 1000 },
    });

    await loadPinnedFeeds(state.pinnedFeeds, { currentChatId: null });

    assert.equal(state.pinnedFeeds.has('undefined'), false);
    assert.equal(state.pinnedFeeds.get(START_SCREEN_KEY)?.html, '<p>legacy start</p>');
});

test('loadPinnedFeeds keeps the newer entry when legacy and stable start keys coexist', async () => {
    forage.store.set(LF_PINNED, {
        undefined: { html: '<p>legacy newer</p>', msgId: '0', swipeIdx: 0, ts: 2000 },
        [START_SCREEN_KEY]: { html: '<p>stable older</p>', msgId: '0', swipeIdx: 0, ts: 1000 },
    });

    await loadPinnedFeeds(state.pinnedFeeds);

    assert.equal(state.pinnedFeeds.size, 1);
    assert.equal(state.pinnedFeeds.get(START_SCREEN_KEY)?.html, '<p>legacy newer</p>');
});

test('loadPinnedFeeds drops null and empty legacy keys', async () => {
    forage.store.set(LF_PINNED, {
        null: { html: '<p>null</p>', msgId: '0', swipeIdx: 0, ts: 1 },
        '': { html: '<p>empty</p>', msgId: '0', swipeIdx: 0, ts: 2 },
    });

    await loadPinnedFeeds(state.pinnedFeeds);

    assert.equal(state.pinnedFeeds.size, 0);
});

test('loadPinnedFeeds is a no-op when nothing is persisted', async () => {
    state.pinnedFeeds.set('pre', { html: '<p>pre</p>', msgId: '0', swipeIdx: 0, ts: 1 });
    // No record at LF_PINNED → must NOT clear in-memory state either (early return).
    forage.store.set('something_else', {});

    await loadPinnedFeeds(state.pinnedFeeds);

    // Null/missing record → early return BEFORE map.clear(): in-memory feed survives.
    assert.equal(state.pinnedFeeds.size, 1);
});

test('schedulePinnedPersist + flush writes the serialized Map', async () => {
    state.pinnedFeeds.set('chat-a', { html: '<p>a</p>', msgId: '3', swipeIdx: 0, ts: 1000 });

    schedulePinnedPersist(state.pinnedFeeds);
    flushPinnedPersist();
    await settle();

    const stored = forage.store.get(LF_PINNED);
    assert.deepEqual(stored, { 'chat-a': { html: '<p>a</p>', msgId: '3', swipeIdx: 0, ts: 1000 } });
});

test('F5: schedulePinnedPersist writes immediately — two rapid writes both land, last wins', async () => {
    state.pinnedFeeds.set('chat-a', { html: '<p>v1</p>', msgId: '1', swipeIdx: 0, ts: 1000 });
    const first = schedulePinnedPersist(state.pinnedFeeds);
    await first;
    assert.equal(forage.store.get(LF_PINNED)['chat-a'].html, '<p>v1</p>',
        'первая запись записана немедленно (без дебаунса)');

    state.pinnedFeeds.set('chat-a', { html: '<p>v2</p>', msgId: '1', swipeIdx: 0, ts: 2000 });
    const second = schedulePinnedPersist(state.pinnedFeeds);
    await second;
    await flushPinnedPersist();

    assert.equal(forage.store.get(LF_PINNED)['chat-a'].html, '<p>v2</p>',
        'вторая запись перезаписала первую; порядок сохранён');
});

test('persist prunes to MAX_CHATS, evicting the oldest by ts', async () => {
    for (let i = 0; i < _MAX_CHATS + 5; i++) {
        state.pinnedFeeds.set(`chat-${i}`, { html: `<p>${i}</p>`, msgId: '0', swipeIdx: 0, ts: 1000 + i });
    }

    schedulePinnedPersist(state.pinnedFeeds);
    flushPinnedPersist();
    await settle();

    const stored = forage.store.get(LF_PINNED);
    assert.equal(Object.keys(stored).length, _MAX_CHATS);
    // ts asc = chat-0..chat-4 (1000..1004) evicted; chat-5..chat-(MAX+4) kept.
    assert.equal(stored['chat-4'], undefined, 'oldest entry must be evicted');
    assert.ok(stored['chat-5'], 'first surviving entry after pruning');
    assert.ok(stored[`chat-${_MAX_CHATS + 4}`], 'newest entry kept');
});

test('clearPinnedPersist removes the record', async () => {
    forage.store.set(LF_PINNED, { 'chat-a': { html: '<p>a</p>', msgId: '0', swipeIdx: 0, ts: 1 } });

    await clearPinnedPersist();

    assert.equal(forage.store.has(LF_PINNED), false);
});

test('flushPinnedPersist without a prior schedule is a safe no-op', async () => {
    // No schedule → _mapRef is null → flush must neither throw nor write.
    flushPinnedPersist();
    await settle();

    assert.equal(forage.store.has(LF_PINNED), false);
});

// ── F5: clearPinnedPersist vs in-flight / queued writes ──

test('F5: slow in-flight setItem settles BEFORE removeItem — key not resurrected', async () => {
    let setItemDone = false;
    const order = [];
    forage.setItem = async (k, v) => {
        await new Promise(r => setTimeout(r, 15));   // slow IndexedDB transaction
        forage.store.set(k, v);
        setItemDone = true;
        order.push('setItem');
    };
    forage.removeItem = async (k) => { order.push('removeItem'); forage.store.delete(k); };

    state.pinnedFeeds.set('chat-a', { html: '<p>a</p>', msgId: '0', swipeIdx: 0, ts: 1 });
    const write = schedulePinnedPersist(state.pinnedFeeds);
    await settle();                       // setItem called, still in flight
    assert.equal(setItemDone, false, 'write is in flight');

    await Promise.all([write, clearPinnedPersist()]);
    await settle();

    assert.equal(forage.store.has(LF_PINNED), false, 'key not recreated by an unfinished write');
    assert.deepEqual(order, ['setItem', 'removeItem'], 'removeItem strictly after the write completed');
});

test('F5: writes queued before clear are suppressed (no Map → no-op)', async () => {
    const order = [];
    forage.setItem = async (k, v) => {
        await new Promise(r => setTimeout(r, 15));   // slow transaction
        order.push(`setItem:${Object.keys(v).length}`);
        forage.store.set(k, v);
    };
    forage.removeItem = async (k) => { order.push('removeItem'); forage.store.delete(k); };

    state.pinnedFeeds.set('chat-a', { html: '<p>a</p>', msgId: '0', swipeIdx: 0, ts: 1 });
    const first = schedulePinnedPersist(state.pinnedFeeds);   // queued (slow setItem)
    const second = schedulePinnedPersist(state.pinnedFeeds);  // queued behind it
    // Clear runs synchronously BEFORE either write starts: _mapRef is nulled
    // first, so both chain jobs no-op and removeItem is the only storage call.
    // (The in-flight variant — setItem already called — is covered above.)
    const clearing = clearPinnedPersist();
    await Promise.all([first, second, clearing]);
    await settle();

    assert.equal(forage.store.has(LF_PINNED), false, 'writes did not resurrect the key');
    assert.deepEqual(order, ['removeItem'],
        'обе запланированные записи подавлены; removeItem — единственный вызов хранилища');
});
