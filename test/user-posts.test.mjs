// @ts-check
/**
 * DS Comments — {{user}} post commentary tests.
 *
 * Covers the commentUserPosts feature: eligibility gate (core), the
 * USER_MESSAGE_RENDERED trigger (events), the one-slot generation queue
 * (generator) and community-memory inclusion of user-post threads
 * (feed-file-store).
 */
import '../test-helpers/stub-runtime.mjs';
import test, { afterEach, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import {
    state, getCtx,
    isCommentaryDisplayEligible, isCommentaryGenerationEligible, aiPostIndices,
} from '../src/core.js';
import { bindEvents, unbindEvents, disconnectObservers } from '../src/events.js';
import { _testGenerateFeed } from '../src/generator.js';
import { _seedMirror, _resetFeedFileStore, collectPastCommentThreads, getFeedSlot } from '../src/feed-file-store.js';
import { dumpEventLog, _resetEventLog } from '../src/event-log.js';

const ai = (mes, swipe_id = 0) => ({ mes, is_user: false, is_system: false, is_hidden: false, swipe_id, swipes: [mes] });
const user = (mes, swipe_id = 0) => ({ mes, is_user: true, is_system: false, is_hidden: false, swipe_id, swipes: [mes] });

function makeEventSource() {
    const listeners = new Map();
    return {
        on(name, fn) { listeners.set(name, fn); },
        removeListener(name) { listeners.delete(name); },
        handler(name) { return listeners.get(name); },
    };
}

beforeEach(() => {
    unbindEvents();
    disconnectObservers();
    Object.assign(state, {
        settings: {},
        currentChatId: 'chat-1', currentPostId: null, currentSwipeIdx: 0,
        generationEpoch: 0, generationInProgress: false, generationOwner: null,
        abortController: null, generationTarget: null, generationObservedTarget: null,
        queuedGeneration: null, pendingActivatedWorldInfo: null, navLockUntil: 0,
    });
    const ctx = getCtx();
    Object.assign(ctx, {
        chatId: 'chat-1', chat: [], chatMetadata: {}, saveMetadata: () => {},
        name1: 'User', name2: 'Char',
        eventTypes: {
            CHAT_CHANGED: 'CHAT_CHANGED',
            CHARACTER_MESSAGE_RENDERED: 'CHARACTER_MESSAGE_RENDERED',
            USER_MESSAGE_RENDERED: 'USER_MESSAGE_RENDERED',
        },
        eventSource: makeEventSource(),
        substituteParams: text => text,
    });
    delete ctx.getWorldInfoPrompt;
    delete ctx.loadWorldInfo;
    globalThis._stFilesReset?.();
    _resetFeedFileStore();
    _resetEventLog();
});

afterEach(() => {
    unbindEvents();
    disconnectObservers();
});

async function flushAsync() {
    for (let i = 0; i < 10; i++) await Promise.resolve();
}

// ── core: eligibility gate ──

test('eligibility: user posts excluded by default, included when commentUserPosts is on', () => {
    state.settings = {};
    assert.equal(isCommentaryDisplayEligible(user('x')), false);
    assert.equal(isCommentaryGenerationEligible(user('x')), false);

    state.settings = { commentUserPosts: true };
    assert.equal(isCommentaryDisplayEligible(user('x')), true);
    assert.equal(isCommentaryGenerationEligible(user('x')), true);
    // system/hidden stay excluded regardless of the setting
    assert.equal(isCommentaryDisplayEligible({ ...user('x'), is_system: true }), false);
    assert.equal(isCommentaryGenerationEligible({ ...user('x'), is_hidden: true }), false);
    // AI posts unaffected
    assert.equal(isCommentaryDisplayEligible(ai('x')), true);
});

test('aiPostIndices: user posts join navigation only while the setting is on', () => {
    getCtx().chat = [user('u0'), ai('a1'), user('u2')];
    state.settings = {};
    assert.deepEqual(aiPostIndices(), [1]);
    state.settings = { commentUserPosts: true };
    assert.deepEqual(aiPostIndices(), [0, 1, 2]);
});

// ── events: USER_MESSAGE_RENDERED trigger ──

function bindWithRecording(generateFeedCalls) {
    const ctx = getCtx();
    bindEvents(
        (msgId, swipeIdx, force) => { generateFeedCalls.push([msgId, swipeIdx, force]); return Promise.resolve(); },
        ctx,
        { getGenerationFingerprint: async () => 'fp-test' },
    );
    return ctx.eventSource;
}

test('USER_MESSAGE_RENDERED: generates for the user post when master+auto settings are on', async () => {
    state.settings = { enabled: true, commentUserPosts: true, autoUpdateUserPosts: true, noSaveMode: true };
    getCtx().chat = [user('hello there, this is a user post')];
    const calls = [];
    const es = bindWithRecording(calls);

    await es.handler('USER_MESSAGE_RENDERED')(0);
    await flushAsync();
    assert.deepEqual(calls, [['0', 0, false]]);
});

test('USER_MESSAGE_RENDERED: gated off without commentUserPosts or autoUpdateUserPosts', async () => {
    getCtx().chat = [user('hello there, this is a user post')];

    for (const settings of [
        { enabled: true, commentUserPosts: false, autoUpdateUserPosts: true, noSaveMode: true },
        { enabled: true, commentUserPosts: true, autoUpdateUserPosts: false, noSaveMode: true },
        { enabled: false, commentUserPosts: true, autoUpdateUserPosts: true, noSaveMode: true },
    ]) {
        unbindEvents();
        state.settings = settings;
        const calls = [];
        const es = bindWithRecording(calls);
        await es.handler('USER_MESSAGE_RENDERED')(0);
        await flushAsync();
        assert.deepEqual(calls, [], `no generation for settings=${JSON.stringify(settings)}`);
    }
});

test('USER_MESSAGE_RENDERED: never claims the pending WORLD_INFO stash (it belongs to the AI reply)', async () => {
    state.settings = { enabled: true, commentUserPosts: true, autoUpdateUserPosts: true, noSaveMode: true };
    getCtx().chat = [user('hello there, this is a user post')];
    state.pendingActivatedWorldInfo = { chatId: 'chat-1', entries: [], ts: Date.now() };
    const calls = [];
    const es = bindWithRecording(calls);

    await es.handler('USER_MESSAGE_RENDERED')(0);
    await flushAsync();
    assert.equal(calls.length, 1, 'generation still runs');
    assert.ok(state.pendingActivatedWorldInfo, 'pending WI stash untouched by the user-post trigger');
});

test('USER_MESSAGE_RENDERED: skips non-user messages and trivial text', async () => {
    state.settings = { enabled: true, commentUserPosts: true, autoUpdateUserPosts: true, noSaveMode: true };
    getCtx().chat = [ai('an ai post, not user'), user('...'), user('ok')];
    const calls = [];
    const es = bindWithRecording(calls);

    await es.handler('USER_MESSAGE_RENDERED')(0);   // AI post under a user event
    await es.handler('USER_MESSAGE_RENDERED')(1);   // streaming-placeholder text
    await es.handler('USER_MESSAGE_RENDERED')(2);   // too short
    await flushAsync();
    assert.deepEqual(calls, []);
});

// ── generator: one-slot queue ──

function setupGeneration() {
    state.pinnedFeeds.clear();
    state.settings = {
        enabled: true, autoUpdate: true, noSaveMode: false,
        apiSource: 'custom', customEndpoint: 'http://x', customModel: 'm',
        promptTemplate: 'main', userCount: 3, includeChatHistory: false,
        contextDepth: 4, includePersona: false, includeCharacterDescription: false,
        enableJailbreakBlock: false, jailbreakRole: 'system',
        profileId: '', soundEnabled: false,
        promptTemplates: { main: 'Generate {{count}} comments.' },
        commentUserPosts: true,
    };
    getCtx().chat = [user('u0 post text'), ai('a1 reply text')];
    getCtx().chatId = 'chatA';
    getCtx().chatMetadata = { dscomments_commentary: { posts: {}, current: { msgId: null, swipeIdx: 0 } } };
}

const validResponse = JSON.stringify([
    { username: 'coder_42', content: 'nice', reactions: [] },
    { username: 'bot', content: 'cool', reactions: [] },
]);

test('generateFeed: a request arriving mid-generation is queued, then drained on completion', async () => {
    setupGeneration();
    let release;
    const gate = new Promise(r => { release = r; });

    // First generation (user post) blocks inside the API call.
    const first = _testGenerateFeed('0', 0, true, async () => { await gate; return validResponse; });
    await flushAsync();
    assert.equal(state.generationInProgress, true);

    // The AI reply renders while the user-post generation is in flight: its
    // request must be parked, not dropped (pre-queue behaviour lost it).
    const { generateFeed } = await import('../src/generator.js');
    await generateFeed('1', 0, false);
    assert.deepEqual(
        state.queuedGeneration && { msg: state.queuedGeneration.targetMsgId, swipe: state.queuedGeneration.targetSwipeIdx },
        { msg: '1', swipe: 0 },
    );

    release();
    await first;
    await flushAsync();

    assert.equal(state.queuedGeneration, null, 'queue drained');
    assert.match(dumpEventLog(), /event=generation_queue action=drain target=#1\[0\]/);
    // The drained run goes through the real generateFeed (the fake API is
    // already uninstalled by then, so it errors out via the unreachable custom
    // endpoint) — what matters is that it runs and settles, not wedging the
    // generator.
    for (let i = 0; i < 100 && state.generationInProgress; i++) {
        await new Promise(r => setTimeout(r, 10));
    }
    assert.equal(state.generationInProgress, false);
});

test('generateFeed: latest queued request wins while busy', async () => {
    setupGeneration();
    state.generationInProgress = true;
    const { generateFeed } = await import('../src/generator.js');
    await generateFeed('0', 0, false);
    await generateFeed('1', 2, true);
    assert.equal(state.queuedGeneration.targetMsgId, '1');
    assert.equal(state.queuedGeneration.targetSwipeIdx, 2);
    assert.equal(state.queuedGeneration.forceRegenerate, true);
    state.generationInProgress = false;
    state.queuedGeneration = null;
});

test('CHAT_CHANGED drops a parked queued generation', async () => {
    setupGeneration();
    state.queuedGeneration = { targetMsgId: '1', targetSwipeIdx: 0, forceRegenerate: false };
    const calls = [];
    const es = bindWithRecording(calls);
    getCtx().chatId = 'chatB';
    getCtx().chat = [];
    state.settings.noSaveMode = true;   // skip the server-store restore path
    await es.handler('CHAT_CHANGED')('chatB');
    await flushAsync();
    assert.equal(state.queuedGeneration, null);
});

// ── feed-file-store: community memory includes user-post threads when enabled ──

function slotInfo(send_date) { return { send_date }; }

test('collectPastCommentThreads: user-post threads join the memory only when commentUserPosts is on', () => {
    const ctx = getCtx();
    ctx.chatId = 'c1';
    ctx.chat = [
        { ...user('u0'), send_date: '2026-08-19T10:00:00.001Z', swipe_info: [slotInfo('2026-08-19T10:00:00.001Z')] },
        { ...ai('a1'), send_date: '2026-08-19T10:00:00.002Z', swipe_info: [slotInfo('2026-08-19T10:00:00.002Z')] },
        { ...ai('anchor'), send_date: '2026-08-19T10:00:00.003Z', swipe_info: [slotInfo('2026-08-19T10:00:00.003Z')] },
    ];
    _seedMirror({
        '2026-08-19T10:00:00.001Z': { html: 'u', ts: 1, threads: [{ username: 'n', content: 'USER_THREAD' }] },
        '2026-08-19T10:00:00.002Z': { html: 'a', ts: 1, threads: [{ username: 'n', content: 'AI_THREAD' }] },
    });

    state.settings = {};
    let threads = collectPastCommentThreads({ msgId: '2', swipeIdx: 0 }, 5);
    assert.deepEqual(threads.map(t => t.msgId), ['1'], 'user post skipped by default');

    state.settings = { commentUserPosts: true };
    threads = collectPastCommentThreads({ msgId: '2', swipeIdx: 0 }, 5);
    assert.deepEqual(threads.map(t => t.msgId), ['0', '1'], 'user thread included, oldest first');
    assert.equal(threads[0].messages[0].content, 'USER_THREAD');
});
