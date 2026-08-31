// @ts-check
/**
 * DS Comments — ST event binding lifecycle tests.
 *
 * src/events.js must be the single owner of SillyTavern event subscriptions.
 */

import '../test-helpers/stub-runtime.mjs';
import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { state } from '../src/core.js';
import { bindEvents, unbindEvents, isEventsBound } from '../src/events.js';
import { _resetFeedFileStore, _seedSaveCache } from '../src/feed-file-store.js';

const eventTypes = {
    CHAT_CHANGED: 'CHAT_CHANGED',
    CHARACTER_MESSAGE_RENDERED: 'CHARACTER_MESSAGE_RENDERED',
    MESSAGE_SWIPED: 'MESSAGE_SWIPED',
    MESSAGE_DELETED: 'MESSAGE_DELETED',
    MESSAGE_EDITED: 'MESSAGE_EDITED',
    CHAT_RENAMED: 'CHAT_RENAMED',
    WORLD_INFO_ACTIVATED: 'WORLD_INFO_ACTIVATED',
    CONNECTION_PROFILE_UPDATED: 'CONNECTION_PROFILE_UPDATED',
};

function makeEventSource() {
    const listeners = new Map();
    const removed = new Map();
    return {
        listenerCount(name) { return listeners.get(name)?.length || 0; },
        addedFor(name) { return listeners.get(name) ? [...listeners.get(name)] : []; },
        removedFor(name) { return removed.get(name) ? [...removed.get(name)] : []; },
        on(name, fn) {
            if (!listeners.has(name)) listeners.set(name, []);
            listeners.get(name).push(fn);
        },
        removeListener(name, fn) {
            const arr = listeners.get(name);
            if (!arr) return;
            const idx = arr.indexOf(fn);
            if (idx !== -1) {
                arr.splice(idx, 1);
                if (!removed.has(name)) removed.set(name, []);
                removed.get(name).push(fn);
            }
        },
    };
}

function makeCtx(overrides = {}) {
    return {
        eventSource: overrides.eventSource ?? makeEventSource(),
        eventTypes,
        chat: [],
        chatMetadata: {},
        ...overrides,
    };
}

function generateFeed() {}

const originalGetContext = globalThis.SillyTavern.getContext;
afterEach(() => {
    unbindEvents();
    _resetFeedFileStore();
    globalThis.SillyTavern.getContext = originalGetContext;
    state.generationInProgress = false;
    state.generationOwner = null;
    state.abortController = null;
    state.lastActivatedWorldInfo = null;
    state.pendingActivatedWorldInfo = null;
});

async function flushAsync() {
    await Promise.resolve();
    await Promise.resolve();
}

test('bind/unbind contract', () => {
    const source = makeEventSource();
    const ctx = makeCtx({ eventSource: source });

    assert.equal(bindEvents(generateFeed, makeCtx({ eventSource: null })), false);
    assert.equal(isEventsBound(), false);
    assert.equal(bindEvents(generateFeed, ctx), true);
    assert.equal(bindEvents(generateFeed, ctx), true);
    assert.equal(source.listenerCount(eventTypes.CHAT_CHANGED), 1);

    const added = source.addedFor(eventTypes.CHAT_CHANGED)[0];
    assert.equal(unbindEvents(), true);
    assert.strictEqual(source.removedFor(eventTypes.CHAT_CHANGED)[0], added);
    assert.equal(isEventsBound(), false);
});

test('bind -> unbind -> bind attaches fresh handlers', () => {
    const source = makeEventSource();
    const ctx = makeCtx({ eventSource: source });

    bindEvents(generateFeed, ctx);
    const first = source.addedFor(eventTypes.CHAT_CHANGED)[0];
    unbindEvents();
    bindEvents(generateFeed, ctx);
    const second = source.addedFor(eventTypes.CHAT_CHANGED)[1];
    assert.notStrictEqual(first, second);
    assert.equal(source.listenerCount(eventTypes.CHAT_CHANGED), 1);
    unbindEvents();
});

test('double unbind is safe and returns false', () => {
    const source = makeEventSource();
    bindEvents(generateFeed, makeCtx({ eventSource: source }));
    assert.equal(unbindEvents(), true);
    assert.equal(unbindEvents(), false);
    assert.equal(source.listenerCount(eventTypes.CHAT_CHANGED), 0);
});

test('CHAT_CHANGED refreshes lore against the fresh context', async () => {
    const source = makeEventSource();
    const boundCtx = makeCtx({ eventSource: source, chatId: 'old-chat' });
    const freshCtx = makeCtx({ eventSource: source, chatId: 'new-chat' });
    globalThis.SillyTavern.getContext = () => freshCtx;
    const seen = [];

    bindEvents(generateFeed, boundCtx, {
        onChatChanged: ctx => { seen.push(ctx); },
    });
    source.addedFor(eventTypes.CHAT_CHANGED)[0]();
    await flushAsync();

    assert.deepEqual(seen, [freshCtx]);
    unbindEvents();
});

test('CHAT_CHANGED invokes refresh once only for a changed identity after state update', async () => {
    const source = makeEventSource();
    const ctx = makeCtx({ eventSource: source, chatId: 'chat-b' });
    globalThis.SillyTavern.getContext = () => ctx;
    state.currentChatId = 'chat-a';
    const seen = [];

    bindEvents(generateFeed, ctx, {
        onChatChanged: freshCtx => seen.push([freshCtx.chatId, state.currentChatId]),
    });
    const handler = source.addedFor(eventTypes.CHAT_CHANGED)[0];
    handler();
    handler();
    await flushAsync();

    assert.deepEqual(seen, [['chat-b', 'chat-b']]);
});

test('CHAT_CHANGED contains rejected async refresh callbacks', async () => {
    const source = makeEventSource();
    const ctx = makeCtx({ eventSource: source, chatId: 'new-chat' });
    globalThis.SillyTavern.getContext = () => ctx;
    const reasons = [];
    const onUnhandled = reason => reasons.push(reason);
    process.on('unhandledRejection', onUnhandled);

    try {
        bindEvents(generateFeed, ctx, {
            onChatChanged: async () => { throw new Error('refresh failed'); },
        });
        source.addedFor(eventTypes.CHAT_CHANGED)[0]();
        await flushAsync();
        assert.deepEqual(reasons, []);
    } finally {
        process.removeListener('unhandledRejection', onUnhandled);
    }
});

test('CHARACTER_MESSAGE_RENDERED skips cache with the current generation fingerprint', async () => {
    const source = makeEventSource();
    const ctx = makeCtx({
        eventSource: source,
        chatId: 'chat-a',
        chat: [{ mes: 'long enough AI message', swipe_id: 0 }],
    });
    _seedSaveCache({ '0': { '0': { html: '<p>cached</p>', generationFp: 'fp-current' } } }, ctx.chat);
    globalThis.SillyTavern.getContext = () => ctx;
    state.settings = { enabled: true, autoUpdate: true, noSaveMode: false };
    const calls = [];

    bindEvents((...args) => calls.push(args), ctx, {
        getGenerationFingerprint: async () => 'fp-current',
    });
    source.addedFor(eventTypes.CHARACTER_MESSAGE_RENDERED)[0](0);
    await flushAsync();

    assert.deepEqual(calls, []);
});

test('CHARACTER_MESSAGE_RENDERED treats fingerprint rejection as a hard cache miss', async () => {
    const source = makeEventSource();
    const ctx = makeCtx({
        eventSource: source,
        chatId: 'chat-a',
        chat: [{ mes: 'long enough AI message', swipe_id: 0 }],
    });
    _seedSaveCache({ '0': { '0': { html: '<p>cached</p>', generationFp: 'fp-current' } } }, ctx.chat);
    globalThis.SillyTavern.getContext = () => ctx;
    state.settings = { enabled: true, autoUpdate: true, noSaveMode: false };
    const calls = [];

    bindEvents((...args) => calls.push(args), ctx, {
        getGenerationFingerprint: async () => { throw new Error('fingerprint failed'); },
    });
    source.addedFor(eventTypes.CHARACTER_MESSAGE_RENDERED)[0](0);
    await flushAsync();

    assert.deepEqual(calls, [['0', 0, false]]);
});

test('CHARACTER_MESSAGE_RENDERED abandons fingerprint result after chat identity changes', async () => {
    const source = makeEventSource();
    const oldCtx = makeCtx({
        eventSource: source,
        chatId: 'chat-a',
        chat: [{ mes: 'long enough AI message', swipe_id: 0 }],
    });
    let currentCtx = oldCtx;
    globalThis.SillyTavern.getContext = () => currentCtx;
    state.settings = { enabled: true, autoUpdate: true, noSaveMode: false };
    state.generationEpoch = 10;
    const deferred = Promise.withResolvers();
    const calls = [];

    bindEvents((...args) => calls.push(args), oldCtx, {
        getGenerationFingerprint: () => deferred.promise,
    });
    source.addedFor(eventTypes.CHARACTER_MESSAGE_RENDERED)[0](0);
    currentCtx = makeCtx({ eventSource: source, chatId: 'chat-b', chat: oldCtx.chat });
    state.generationEpoch++;
    deferred.resolve('fp-current');
    await flushAsync();

    assert.deepEqual(calls, []);
});

test('CHARACTER_MESSAGE_RENDERED abandons fingerprint result after generation epoch changes', async () => {
    const source = makeEventSource();
    const ctx = makeCtx({
        eventSource: source,
        chatId: 'chat-a',
        chat: [{ mes: 'long enough AI message', swipe_id: 0 }],
    });
    globalThis.SillyTavern.getContext = () => ctx;
    state.settings = { enabled: true, autoUpdate: true, noSaveMode: false };
    state.generationEpoch = 20;
    const deferred = Promise.withResolvers();
    const calls = [];

    bindEvents((...args) => calls.push(args), ctx, {
        getGenerationFingerprint: () => deferred.promise,
    });
    source.addedFor(eventTypes.CHARACTER_MESSAGE_RENDERED)[0](0);
    state.generationEpoch++;
    deferred.resolve('fp-current');
    await flushAsync();

    assert.deepEqual(calls, []);
});

test('CHARACTER_MESSAGE_RENDERED regenerates when cached fingerprint is stale', async () => {
    const source = makeEventSource();
    const ctx = makeCtx({
        eventSource: source,
        chatId: 'chat-a',
        chat: [{ mes: 'long enough AI message', swipe_id: 0 }],
        chatMetadata: {
            dscomments_commentary: {
                posts: { '0': { '0': { html: '<p>cached</p>', generationFp: 'fp-old' } } },
            },
        },
    });
    globalThis.SillyTavern.getContext = () => ctx;
    state.settings = { enabled: true, autoUpdate: true, noSaveMode: false };
    const calls = [];

    bindEvents((...args) => calls.push(args), ctx, {
        getGenerationFingerprint: () => Promise.resolve('fp-current'),
    });
    source.addedFor(eventTypes.CHARACTER_MESSAGE_RENDERED)[0](0);
    await flushAsync();

    assert.deepEqual(calls, [['0', 0, false]]);
});

test('CHAT_CHANGED releases generation ownership before a non-cancellable request settles', () => {
    const source = makeEventSource();
    const ctx = makeCtx({ eventSource: source, chatId: 'new-chat' });
    globalThis.SillyTavern.getContext = () => ctx;
    const controller = { abortCalls: 0, abort() { this.abortCalls++; } };
    state.generationInProgress = true;
    state.generationOwner = Symbol('old-generation');
    state.abortController = controller;

    bindEvents(generateFeed, ctx);
    source.addedFor(eventTypes.CHAT_CHANGED)[0]();

    assert.equal(controller.abortCalls, 1);
    assert.equal(state.abortController, null);
    assert.equal(state.generationOwner, null);
    assert.equal(state.generationInProgress, false);
    unbindEvents();
});

test('transactional rollback if one on() throws', () => {
    const source = makeEventSource();
    const ctx = makeCtx({ eventSource: source });
    const realOn = source.on.bind(source);
    let calls = 0;
    source.on = (name, fn) => {
        calls++;
        if (calls === 2) throw new Error('boom');
        realOn(name, fn);
    };

    assert.throws(() => bindEvents(generateFeed, ctx), /boom/);
    assert.equal(isEventsBound(), false);
    assert.equal(source.listenerCount(eventTypes.CHAT_CHANGED), 0);
    assert.equal(source.listenerCount(eventTypes.CHARACTER_MESSAGE_RENDERED), 0);
});

// ── F2: WORLD_INFO_ACTIVATED stores a PENDING payload; RENDERED claims it ──
// The event fires during ST's prompt build BEFORE the new message is pushed to
// chat, so the handler must NOT bind to "the last AI post at event time" — that
// was the H3 bug (masked by our own non-dry-run rescan re-emitting the event).
// CHARACTER_MESSAGE_RENDERED claims the pending and binds it to the message
// that actually rendered.

test('F2: WORLD_INFO_ACTIVATED stashes a PENDING payload (no post binding)', async () => {
    const source = makeEventSource();
    const ctx = makeCtx({
        eventSource: source,
        chatId: 'chat-a',
        chat: [
            { mes: 'user', is_user: true },
            { mes: 'ai1', is_user: false, is_system: false, is_hidden: false, swipe_id: 1 },
            { mes: 'ai2', is_user: false, is_system: false, is_hidden: false, swipe_id: 0 },
        ],
    });
    globalThis.SillyTavern.getContext = () => ctx;
    bindEvents(generateFeed, ctx);

    const handler = source.addedFor(eventTypes.WORLD_INFO_ACTIVATED)[0];
    await handler([
        { uid: 10, content: 'vec lore', world: 'Book', comment: 'Vec', vectorized: true },
        { uid: 11, content: 42, world: 'Book', comment: 'Bad' },
    ]);

    // Pending stash: entries normalized, no msgId binding yet.
    assert.ok(state.pendingActivatedWorldInfo, 'payload stashed as pending');
    assert.equal(state.pendingActivatedWorldInfo.chatId, 'chat-a');
    assert.equal('msgId' in state.pendingActivatedWorldInfo, false,
        'pending не привязан к посту — привязка происходит на RENDERED');
    assert.deepEqual(state.pendingActivatedWorldInfo.entries, [
        { uid: 10, content: 'vec lore', world: 'Book', comment: 'Vec', vectorized: true },
        { uid: 11, content: '', world: 'Book', comment: 'Bad', vectorized: false },
    ]);
    assert.ok(state.pendingActivatedWorldInfo.ts > 0);

    unbindEvents();
});

test('F2: RENDERED claims the pending and binds it to the RENDERED message (not the previous post)', async () => {
    const source = makeEventSource();
    // Chat state as seen at RENDERED time: the NEW message (#3) already pushed.
    // The pending was created when only #1/#2 existed — old code bound it to #2.
    const chat = [
        { mes: 'user', is_user: true },
        { mes: 'ai1', is_user: false, is_system: false, is_hidden: false, swipe_id: 0, swipes: ['ai1'] },
        { mes: 'ai2', is_user: false, is_system: false, is_hidden: false, swipe_id: 0, swipes: ['ai2'] },
        { mes: 'ai3 fresh', is_user: false, is_system: false, is_hidden: false, swipe_id: 2, swipes: ['s0', 's1', 'ai3 fresh'] },
    ];
    const ctx = makeCtx({ eventSource: source, chatId: 'chat-a', chat });
    globalThis.SillyTavern.getContext = () => ctx;
    bindEvents(generateFeed, ctx);

    const wiHandler = source.addedFor(eventTypes.WORLD_INFO_ACTIVATED)[0];
    await wiHandler([{ uid: 10, content: 'vec', world: 'B', comment: 'v', vectorized: true }]);

    const rendered = source.addedFor(eventTypes.CHARACTER_MESSAGE_RENDERED)[0];
    await rendered(3);   // the NEW message renders

    assert.ok(state.lastActivatedWorldInfo, 'pending claimed into lastActivatedWorldInfo');
    assert.equal(state.lastActivatedWorldInfo.msgId, '3',
        'привязан к фактически отрендеренному посту (не к предыдущему #2)');
    assert.equal(state.lastActivatedWorldInfo.swipeIdx, 2);
    assert.equal(state.pendingActivatedWorldInfo, null, 'pending consumed');

    unbindEvents();
});

test('F2: expired TTL pending is dropped, not claimed', async () => {
    const source = makeEventSource();
    const chat = [
        { mes: 'ai fresh enough', is_user: false, is_system: false, is_hidden: false, swipe_id: 0, swipes: ['ai fresh enough'] },
    ];
    const ctx = makeCtx({ eventSource: source, chatId: 'chat-a', chat });
    globalThis.SillyTavern.getContext = () => ctx;
    bindEvents(generateFeed, ctx);

    await source.addedFor(eventTypes.WORLD_INFO_ACTIVATED)[0]([{ uid: 1, content: 'x', world: 'W', comment: '' }]);
    // Age the stash past the 120 s TTL.
    state.pendingActivatedWorldInfo.ts = Date.now() - 121_000;

    const prev = state.lastActivatedWorldInfo;
    await source.addedFor(eventTypes.CHARACTER_MESSAGE_RENDERED)[0](0);

    assert.equal(state.pendingActivatedWorldInfo, null, 'stale pending consumed (discarded)');
    assert.equal(state.lastActivatedWorldInfo, prev, 'stale pending NOT taken — cache not overwritten');

    unbindEvents();
});

test('F2: CHAT_CHANGED clears the pending stash', async () => {
    const source = makeEventSource();
    const ctx = makeCtx({ eventSource: source, chatId: 'chat-a', chat: [] });
    globalThis.SillyTavern.getContext = () => ctx;
    bindEvents(generateFeed, ctx);

    await source.addedFor(eventTypes.WORLD_INFO_ACTIVATED)[0]([{ uid: 1, content: 'x', world: 'W', comment: '' }]);
    assert.ok(state.pendingActivatedWorldInfo);

    await source.addedFor(eventTypes.CHAT_CHANGED)[0]();
    assert.equal(state.pendingActivatedWorldInfo, null, 'CHAT_CHANGED cleared pending');

    unbindEvents();
});

test('F2: pending from another chat is not claimed (chatId guard)', async () => {
    const source = makeEventSource();
    const chat = [
        { mes: 'ai fresh enough', is_user: false, is_system: false, is_hidden: false, swipe_id: 0, swipes: ['ai fresh enough'] },
    ];
    const ctx = makeCtx({ eventSource: source, chatId: 'chat-b', chat });
    globalThis.SillyTavern.getContext = () => ctx;
    bindEvents(generateFeed, ctx);

    await source.addedFor(eventTypes.WORLD_INFO_ACTIVATED)[0]([{ uid: 1, content: 'x', world: 'W', comment: '' }]);
    state.pendingActivatedWorldInfo.chatId = 'chat-a';   // foreign chat

    const prev = state.lastActivatedWorldInfo;
    await source.addedFor(eventTypes.CHARACTER_MESSAGE_RENDERED)[0](0);

    assert.equal(state.pendingActivatedWorldInfo, null, 'foreign pending consumed (discarded)');
    assert.equal(state.lastActivatedWorldInfo, prev, 'foreign pending NOT taken');

    unbindEvents();
});

test('WORLD_INFO_ACTIVATED handler ignores non-array payloads', async () => {
    const source = makeEventSource();
    const ctx = makeCtx({ eventSource: source, chatId: 'chat-a', chat: [] });
    globalThis.SillyTavern.getContext = () => ctx;
    bindEvents(generateFeed, ctx);

    const handler = source.addedFor(eventTypes.WORLD_INFO_ACTIVATED)[0];
    await handler(null);
    await handler('string');
    await handler(42);

    assert.equal(state.lastActivatedWorldInfo, null);
    unbindEvents();
});

test('F2: pending stash is independent of chat contents (binding deferred to RENDERED)', async () => {
    // Under the old last-AI-post binding an empty/user-only chat produced a
    // msgId=null cache; now the stash carries no post identity at all.
    const source = makeEventSource();
    const ctx = makeCtx({ eventSource: source, chatId: 'chat-a', chat: [
        { mes: 'user', is_user: true },
        { mes: 'sys', is_system: true },
        { mes: 'hidden', is_hidden: true },
    ] });
    globalThis.SillyTavern.getContext = () => ctx;
    bindEvents(generateFeed, ctx);

    const handler = source.addedFor(eventTypes.WORLD_INFO_ACTIVATED)[0];
    await handler([{ uid: 1, content: 'x', world: 'W', comment: '' }]);

    assert.ok(state.pendingActivatedWorldInfo);
    assert.equal('msgId' in state.pendingActivatedWorldInfo, false);
    assert.equal(state.lastActivatedWorldInfo, null);
    unbindEvents();
});

// ── F3: CONNECTION_PROFILE_UPDATED invalidates the fingerprint epoch ──
// Changing the model/API inside the selected CM profile keeps profileId, so
// only an epoch bump (→ fp-cache miss) makes the next fingerprint fresh.

test('F3: CONNECTION_PROFILE_UPDATED bumps the epoch when the SELECTED profile changes', async () => {
    const source = makeEventSource();
    const ctx = makeCtx({ eventSource: source });
    globalThis.SillyTavern.getContext = () => ctx;
    bindEvents(generateFeed, ctx);

    state.settings.profileId = 'p-42';
    state.generationEpoch = 7;
    const handler = source.addedFor(eventTypes.CONNECTION_PROFILE_UPDATED)[0];

    // Update matches by id (old side)…
    handler({ id: 'p-42', name: 'Old' }, { id: 'p-42', name: 'Renamed', model: 'new-model' });
    assert.equal(state.generationEpoch, 8, 'epoch bumped — fp cache invalidated');

    // …and by name (settings store id || name).
    state.settings.profileId = 'byname';
    handler({ id: 'x', name: 'byname' }, { id: 'x', name: 'byname', model: 'm2' });
    assert.equal(state.generationEpoch, 9, 'epoch bumped on name match');

    unbindEvents();
});

test('F3: CONNECTION_PROFILE_UPDATED ignores unrelated profiles', async () => {
    const source = makeEventSource();
    const ctx = makeCtx({ eventSource: source });
    globalThis.SillyTavern.getContext = () => ctx;
    bindEvents(generateFeed, ctx);

    state.settings.profileId = 'p-42';
    state.generationEpoch = 3;
    const handler = source.addedFor(eventTypes.CONNECTION_PROFILE_UPDATED)[0];

    handler({ id: 'other', name: 'Other' }, { id: 'other', name: 'Other', model: 'm' });
    assert.equal(state.generationEpoch, 3, 'foreign profile does not touch epoch');

    unbindEvents();
});
