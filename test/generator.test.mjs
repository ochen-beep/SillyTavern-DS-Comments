// @ts-check
/**
 * DS Comments — generator unit tests.
 *
 * Covers buildChatHistory swipe-idx threading: the anchor text and the cache key
 * must refer to the SAME swipe. ST keeps msg.mes in sync with msg.swipes[swipe_id];
 * if our local swipe index differs, we must read msg.swipes[idx] explicitly.
 *
 * buildChatHistory is internal, so these tests go through _testBuildChatHistory.
 */
import '../test-helpers/stub-runtime.mjs';
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { state, bumpGenerationEpoch, dumpDebugLog, clearDebugLog } from '../src/core.js';
import { setCurrentPost } from '../src/cache.js';
import { _seedSaveCache, _resetFeedFileStore, getFeedSlot } from '../src/feed-file-store.js';
import { buildGenerationFingerprint, buildGenerationFingerprintInput } from '../src/lorebooks.js';
import { createSettingsLorebookLifecycle } from '../src/ui/settings-sync.js';
import { _testBuildChatHistory, _testBuildLoreScanInput, _testGenerateFeed, getCurrentGenerationFingerprint } from '../src/generator.js';

const ai = (mes, swipe_id = 0, swipes) =>
    swipes ? { mes, is_user: false, is_system: false, is_hidden: false, swipe_id, swipes }
           : { mes, is_user: false, is_system: false, is_hidden: false, swipe_id };

beforeEach(() => {
    state.settings = { includeChatHistory: true, contextDepth: 4 };
    state.lastActivatedWorldInfo = null;
    globalThis._stCtx.name1 = 'User';
    globalThis._stCtx.chat = [];
    globalThis._stCtx.chatMetadata = {};
    globalThis._stCtx.substituteParams = text => text;
    delete globalThis._stCtx.getWorldInfoPrompt;
    delete globalThis._stCtx.loadWorldInfo;
    _resetFeedFileStore();
});

test('buildChatHistory: anchor reads msg.swipes[idx] when idx !== swipe_id', () => {
    // msg.mes = "active swipe 0 text" (swipe_id 0), but we ask for swipe 1.
    globalThis._stCtx.chat = [ai('active swipe 0 text', 0, ['active swipe 0 text', 'swipe one text'])];
    const html = _testBuildChatHistory(0, 1);
    assert.ok(html.includes('swipe one text'), 'anchor must read the requested swipe, not msg.mes');
    assert.ok(!html.includes('active swipe 0 text'), 'the non-requested active-swipe text must not appear in the anchor');
});

test('buildChatHistory: anchor reads msg.mes when idx === swipe_id (no swipes array)', () => {
    globalThis._stCtx.chat = [ai('only mes text', 0)];
    const html = _testBuildChatHistory(0, 0);
    assert.ok(html.includes('only mes text'));
});

test('buildChatHistory: idx out of swipes range falls back to msg.mes', () => {
    // Defensive: requested swipe index beyond the array → don't crash, use mes.
    globalThis._stCtx.chat = [ai('fallback mes', 0, ['fallback mes'])];
    const html = _testBuildChatHistory(0, 5);
    assert.ok(html.includes('fallback mes'));
});

test('buildChatHistory: includeChatHistory=false returns empty', () => {
    state.settings.includeChatHistory = false;
    globalThis._stCtx.chat = [ai('x', 0)];
    assert.equal(_testBuildChatHistory(0, 0), '');
});

test('current generation fingerprint uses generator inputs without loading lore entries', async () => {
    setupGeneration({
        loreConfig: { mode: 'manual', selectedEntries: [{ book: 'Book', uid: 7 }] },
    });
    let loreLoads = 0;
    globalThis._stCtx.loadWorldInfo = async () => { loreLoads++; return { entries: {} }; };

    const actual = await getCurrentGenerationFingerprint(globalThis._stCtx);
    const expected = buildGenerationFingerprint(buildGenerationFingerprintInput({
        settings: state.settings,
        loreConfig: { mode: 'manual', selectedEntries: [{ book: 'Book', uid: 7 }] },
        stylePrompt: 'Generate {{count}} comments.',
    }));

    assert.equal(actual, expected);
    assert.equal(loreLoads, 0);
});

// ── Lore scan input and generation integration ──

test('old non-cancellable generation cleanup does not release the newer generation owner', async () => {
    setupGeneration();
    const first = Promise.withResolvers();
    const second = Promise.withResolvers();
    const firstStarted = Promise.withResolvers();
    const secondStarted = Promise.withResolvers();
    let pickerOptions;
    const lifecycle = createSettingsLorebookLifecycle({
        createPicker: options => {
            pickerOptions = options;
            return { setConfig() {}, async refresh() {}, destroy() {} };
        },
        getContext: () => globalThis._stCtx,
        readConfig: () => ({ mode: 'automatic', selectedEntries: [] }),
        persistConfig: () => {},
        invalidate: bumpGenerationEpoch,
        getState: () => state,
    });
    await lifecycle.mount({});

    const oldRun = _testGenerateFeed('1', 0, true, () => {
        firstStarted.resolve();
        return first.promise;
    });
    await firstStarted.promise;
    pickerOptions.onChange({ mode: 'automatic', selectedEntries: [] });
    const newRun = _testGenerateFeed('1', 0, true, () => {
        secondStarted.resolve();
        return second.promise;
    });
    await secondStarted.promise;
    const newOwner = state.generationOwner;
    const newController = state.abortController;

    first.resolve('1. **old**: stale');
    await oldRun;
    assert.equal(state.generationInProgress, true);
    assert.strictEqual(state.generationOwner, newOwner);
    assert.strictEqual(state.abortController, newController);

    second.resolve('1. **new**: current');
    await newRun;
    assert.equal(state.generationInProgress, false);
    assert.equal(state.generationOwner, null);
    assert.equal(state.abortController, null);
});

test('buildLoreScanInput preserves visible reverse chat and global scan fields', () => {
    const ctx = {
        name1: 'Alice', name2: 'Bob', characterId: 0,
        chat: [
            { mes: 'first', is_user: true },
            { mes: 'hidden', is_hidden: true },
            { mes: 'system', is_system: true },
            { mes: 'last', name: 'Robert' },
        ],
        characters: [{ description: 'desc', personality: 'personality', scenario: 'scenario' }],
        powerUserSettings: { persona_description: 'persona' },
    };

    assert.deepEqual(_testBuildLoreScanInput(ctx), {
        chatMessages: ['Robert: last', 'Alice: first'],
        globalScanData: {
            trigger: 'quiet',
            characterDescription: 'desc',
            characterPersonality: 'personality',
            scenario: 'scenario',
            personaDescription: 'persona',
        },
    });
});

function setupGeneration({ loreConfig, cachedGenerationFp } = {}) {
    state.pinnedFeeds.clear();
    state.settings = {
        enabled: true, autoUpdate: true, noSaveMode: false,
        apiSource: 'custom', customEndpoint: 'http://x', customModel: 'm',
        promptTemplate: 'main', userCount: 3, includeChatHistory: false,
        contextDepth: 4, includePersona: false, includeCharacterDescription: false,
        enableJailbreakBlock: false, jailbreakRole: 'system',
        profileId: '', soundEnabled: false,
    };
    globalThis._stCtx.chat = [
        { is_user: true, is_system: false, mes: 'u0' },
        { is_user: false, is_system: false, is_hidden: false, mes: 'a1', swipe_id: 0, swipes: ['a1'] },
    ];
    globalThis._stCtx.chatId = 'chatA';
    globalThis._stCtx.chatMetadata = {
        dscomments_lorebook: loreConfig,
        dscomments_commentary: { posts: {}, current: { msgId: null, swipeIdx: 0 } },
    };
    globalThis._stCtx.saveMetadata = () => {};
    globalThis.SillyTavern.libs.localforage.getItem = async key =>
        key === 'DSComments_prompts' ? { main: 'Generate {{count}} comments.' } : null;
    state.generationEpoch = 0;
    state.generationInProgress = false;
    state.generationOwner = null;
    state.abortController = null;
    state.generationTarget = null;
    state.generationObservedTarget = null;
    state.lastGenerationDiagnostics = null;
    setCurrentPost('1', 0);
    let feedHtml = '';
    globalThis.document.getElementById = id => id === 'dscFeed'
        ? {
            set innerHTML(value) { feedHtml = value; },
            get innerHTML() { return feedHtml; },
            _dscLastHtml: '', scrollTop: 0, querySelector: () => null,
        }
        : null;
    if (cachedGenerationFp) {
        _seedSaveCache({
            1: { 0: { html: '<p>cached</p>', timestamp: 1, generationFp: cachedGenerationFp } },
        });
    }
    return { get feedHtml() { return feedHtml; } };
}

const validResponse = JSON.stringify([
    { username: 'coder_42', content: 'nice', reactions: [] },
    { username: 'bot', content: 'cool', reactions: [] },
]);

const generatorSource = readFileSync(
    path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'generator.js'),
    'utf8',
);

test('generator no longer contains local prompt budget or truncation mechanics', () => {
    for (const removed of ['resolvePromptBudget', 'countPromptTokens', 'assembleBoundedPrompt', 'context-truncated', 'token-count-fallback']) {
        assert.doesNotMatch(generatorSource, new RegExp(removed));
    }
});

test('generateFeed sends all selected history and context blocks without local truncation', async () => {
    setupGeneration({ loreConfig: { enabled: true, mode: 'manual', selectedEntries: [{ book: 'Book', uid: 1 }] } });
    state.settings = {
        ...state.settings,
        includeChatHistory: true,
        contextDepth: 15,
        includePersona: true,
        includeCharacterDescription: true,
    };
    globalThis._stCtx.powerUserSettings = { persona_description: 'PERSONA_SELECTED' };
    globalThis._stCtx.characterId = 0;
    globalThis._stCtx.characters = [{ name: 'CHARACTER', description: 'CHARACTER_SELECTED' }];
    globalThis._stCtx.name1 = 'Alice';
    globalThis._stCtx.chat = Array.from({ length: 6 }, (_, index) => ({
        is_user: index % 2 === 0,
        is_system: false,
        is_hidden: false,
        name: index % 2 === 0 ? undefined : 'Character',
        mes: `HISTORY_${index}_SELECTED ` + 'context '.repeat(40),
        swipe_id: 0,
    }));
    globalThis._stCtx.loadWorldInfo = async () => ({ entries: {
        1: { uid: 1, comment: 'LORE_SELECTED', content: 'LORE_SELECTED ' + 'details '.repeat(40) },
    } });

    let userPrompt = '';
    await _testGenerateFeed('5', 0, true, async (_system, userMessages) => {
        userPrompt = userMessages.join('\n\n');
        return validResponse;
    });

    for (let index = 0; index < 5; index++) {
        assert.match(userPrompt, new RegExp(`HISTORY_${index}_SELECTED`));
    }
    assert.match(userPrompt, /HISTORY_5_SELECTED/);
    assert.match(userPrompt, /PERSONA_SELECTED/);
    assert.match(userPrompt, /CHARACTER_SELECTED/);
    assert.match(userPrompt, /LORE_SELECTED/);
});

test('source blocks reach the API as separate user messages (persona / character / lorebook / previously / current chapter)', async () => {
    setupGeneration({ loreConfig: { enabled: true, mode: 'manual', selectedEntries: [{ book: 'Book', uid: 1 }] } });
    state.settings = {
        ...state.settings,
        includeChatHistory: true,
        contextDepth: 4,
        includePersona: true,
        includeCharacterDescription: true,
    };
    globalThis._stCtx.powerUserSettings = { persona_description: 'PERSONA_SELECTED' };
    globalThis._stCtx.characterId = 0;
    globalThis._stCtx.characters = [{ name: 'CHARACTER', description: 'CHARACTER_SELECTED' }];
    globalThis._stCtx.name1 = 'Alice';
    globalThis._stCtx.chat = Array.from({ length: 6 }, (_, index) => ({
        is_user: index % 2 === 0,
        is_system: false,
        is_hidden: false,
        name: index % 2 === 0 ? undefined : 'Character',
        mes: `HISTORY_${index}_SELECTED ` + 'context '.repeat(40),
        swipe_id: 0,
    }));
    globalThis._stCtx.loadWorldInfo = async () => ({ entries: {
        1: { uid: 1, comment: 'LORE_SELECTED', content: 'LORE_SELECTED ' + 'details '.repeat(40) },
    } });

    let captured = null;
    await _testGenerateFeed('5', 0, true, async (_system, userMessages) => {
        captured = userMessages;
        return validResponse;
    });

    assert.ok(Array.isArray(captured), 'user side must be an array of messages');
    assert.equal(captured.length, 5, 'persona + character + lorebook + previously + current chapter');
    assert.equal(captured[0], '[Persona: PERSONA_SELECTED]');
    assert.equal(captured[1], '[Character: CHARACTER\nCHARACTER_SELECTED]');
    assert.match(captured[2], /^\[Details of the fictional world the RP is set in:\nLORE_SELECTED /);
    assert.match(captured[3], /^\[Previously — earlier chapters/);
    assert.match(captured[4], /^\[Current chapter:\nCharacter: HISTORY_5_SELECTED /);
});

test('jailbreak role routing: system appends to the system prompt, user prepends to the first message, assistant becomes the prefill', async () => {
    setupGeneration();
    state.settings = {
        ...state.settings,
        enableJailbreakBlock: true,
        jailbreakText: 'JB_TEXT',
    };

    const capture = {};
    const fakeApi = (systemPrompt, userMessages, assistantPrefill) => {
        capture.systemPrompt = systemPrompt;
        capture.userMessages = userMessages;
        capture.assistantPrefill = assistantPrefill;
        return validResponse;
    };

    state.settings.jailbreakRole = 'system';
    await _testGenerateFeed('1', 0, true, fakeApi);
    assert.match(capture.systemPrompt, /\n\nJB_TEXT$/);
    assert.equal(capture.assistantPrefill, '');

    state.settings.jailbreakRole = 'user';
    await _testGenerateFeed('1', 0, true, fakeApi);
    assert.match(capture.userMessages[0], /^JB_TEXT\n\n/);
    assert.equal(capture.assistantPrefill, '');

    state.settings.jailbreakRole = 'assistant';
    await _testGenerateFeed('1', 0, true, fakeApi);
    assert.equal(capture.assistantPrefill, 'JB_TEXT',
        'assistant role must deliver the jailbreak as a trailing-assistant prefill');
    assert.ok(!capture.systemPrompt.includes('JB_TEXT'),
        'prefill must not leak into the system prompt');
    assert.ok(capture.userMessages.every(m => !m.includes('JB_TEXT')),
        'prefill must not leak into user messages');
});

test('generateFeed automatic mode uses activation path only and attaches its text', async () => {
    setupGeneration({ loreConfig: { enabled: true, mode: 'automatic' } });
    const calls = [];
    globalThis._stCtx.getWorldInfoPrompt = async (...args) => {
        calls.push(args);
        return { worldInfoString: 'AUTO_LORE' };
    };
    globalThis._stCtx.loadWorldInfo = () => { throw new Error('raw load must not run'); };
    let userPrompt = '';

    await _testGenerateFeed('1', 0, true, async (_system, userMessages) => {
        userPrompt = userMessages.join('\n\n');
        return validResponse;
    });

    assert.equal(calls.length, 1);
    assert.match(userPrompt, /Details of the fictional world the RP is set in:\nAUTO_LORE/);
});

test('generateFeed attached scope skips the scan and uses only anchor-bound attached lore', async () => {
    setupGeneration({ loreConfig: {
        enabled: true, mode: 'automatic', autoScope: 'attached',
    } });
    globalThis._stCtx.chatMetadata.world_info = 'Chat Book';
    globalThis._stCtx.getWorldInfoPrompt = () => { throw new Error('dry-run scan must not run in attached scope'); };
    state.lastActivatedWorldInfo = {
        chatId: 'chatA',
        msgId: '1',
        swipeIdx: 0,
        entries: [
            { uid: 1, content: 'ATTACHED_ENTRY', world: 'Chat Book', comment: '', vectorized: false },
            { uid: 2, content: 'GLOBAL_ENTRY', world: 'Global Book', comment: '', vectorized: true },
        ],
        ts: Date.now(),
    };
    let userPrompt = '';

    await _testGenerateFeed('1', 0, true, async (_system, userMessages) => {
        userPrompt = userMessages.join('\n\n');
        return validResponse;
    });

    assert.match(userPrompt, /Details of the fictional world the RP is set in:\nATTACHED_ENTRY/);
    assert.ok(!userPrompt.includes('GLOBAL_ENTRY'),
        'entries from non-attached books must not reach an attached-scope prompt');
});

test('generateFeed attached scope without cache adds no fictional-world block', async () => {
    setupGeneration({ loreConfig: {
        enabled: true, mode: 'automatic', autoScope: 'attached',
    } });
    globalThis._stCtx.chatMetadata.world_info = 'Chat Book';
    globalThis._stCtx.getWorldInfoPrompt = () => { throw new Error('dry-run scan must not run in attached scope'); };
    state.lastActivatedWorldInfo = null;
    let userPrompt = '';

    await _testGenerateFeed('1', 0, true, async (_system, userMessages) => {
        userPrompt = userMessages.join('\n\n');
        return validResponse;
    });

    // Documented degradation: no fresh activation data → no lore block, no error.
    assert.equal(userPrompt, 'Generate the commentary now.');
});

test('generateFeed skips lore resolution entirely on a fresh chat (lore disabled by default)', async () => {
    setupGeneration();   // no dscomments_lorebook metadata → enabled defaults to false
    globalThis._stCtx.getWorldInfoPrompt = () => { throw new Error('activation must not run'); };
    globalThis._stCtx.loadWorldInfo = () => { throw new Error('raw load must not run'); };
    let userPrompt = '';

    await _testGenerateFeed('1', 0, true, async (_system, userMessages) => {
        userPrompt = userMessages.join('\n\n');
        return validResponse;
    });

    assert.equal(userPrompt, 'Generate the commentary now.');
});

test('generateFeed skips lore resolution when lore is explicitly disabled', async () => {
    setupGeneration({ loreConfig: {
        enabled: false, mode: 'manual',
        manualBooks: ['Book'],
        selectedEntries: [{ book: 'Book', uid: 1 }],
    } });
    globalThis._stCtx.getWorldInfoPrompt = () => { throw new Error('activation must not run'); };
    globalThis._stCtx.loadWorldInfo = () => { throw new Error('raw load must not run'); };
    let userPrompt = '';

    await _testGenerateFeed('1', 0, true, async (_system, userMessages) => {
        userPrompt = userMessages.join('\n\n');
        return validResponse;
    });

    assert.equal(userPrompt, 'Generate the commentary now.');
});

test('generateFeed manual mode loads duplicate-UID identities without activation and expands macros', async () => {
    setupGeneration({ loreConfig: { enabled: true, mode: 'manual', selectedEntries: [
        { book: 'Book A', uid: 7 }, { book: 'Book B', uid: 7 },
    ] } });
    globalThis._stCtx.getWorldInfoPrompt = () => { throw new Error('activation must not run'); };
    globalThis._stCtx.loadWorldInfo = async book => ({ entries: {
        7: { uid: 7, comment: `${book} label`, content: `${book} {{user}}`, disable: true, vectorized: true },
    } });
    globalThis._stCtx.substituteParams = text => text.replace('{{user}}', 'Alice');
    let userPrompt = '';

    await _testGenerateFeed('1', 0, true, async (_system, userMessages) => {
        userPrompt = userMessages.join('\n\n');
        return validResponse;
    });

    assert.match(userPrompt, /Book A Alice\n\nBook B Alice/);
});

test('generateFeed empty manual lore adds no fictional-world block', async () => {
    setupGeneration({ loreConfig: { enabled: true, mode: 'manual', selectedEntries: [] } });
    globalThis._stCtx.getWorldInfoPrompt = () => { throw new Error('activation must not run'); };
    let userPrompt = '';
    await _testGenerateFeed('1', 0, true, async (_system, userMessages) => {
        userPrompt = userMessages.join('\n\n');
        return validResponse;
    });
    assert.equal(userPrompt, 'Generate the commentary now.');
});

test('generateFeed logs manual identifiers and missing refs without lore content', async () => {
    setupGeneration({ loreConfig: { enabled: true, mode: 'manual', selectedEntries: [
        { book: 'Book', uid: 1 }, { book: 'Book', uid: 2 },
    ] } });
    globalThis._stCtx.loadWorldInfo = async () => ({ entries: {
        1: { uid: 1, comment: 'Safe label', content: 'SECRET_LORE_CONTENT' },
    } });
    clearDebugLog();
    state.settings.debugMode = true;
    let dump = '';
    try {
        await _testGenerateFeed('1', 0, true, async () => validResponse);
    } finally {
        // dumpDebugLog() gates on debugMode — read the ring BEFORE turning it off.
        dump = dumpDebugLog();
        state.settings.debugMode = false;
    }
    clearDebugLog();

    // The trace line is JSON-serialized in the ring; assert on the parsed
    // object after the "Lorebook context attached" prefix line.
    const line = dump.split('\n').find(l => l.includes('Lorebook context attached'));
    assert.ok(line, 'lore trace line present in debug ring');
    const payload = JSON.parse(line.slice(line.indexOf('{')));
    assert.deepEqual(payload, {
        enabled: true, mode: 'manual', scope: 'all', attached: true,
        entries: [{ book: 'Book', uid: 1, label: 'Safe label' }],
        missing: [{ book: 'Book', uid: 2 }],
    });
    assert.ok(!dump.includes('SECRET_LORE_CONTENT'));
});

test('manual noSave regeneration follows the displayed pinned source, not a later scroll pointer', async () => {
    setupGeneration();
    state.settings.noSaveMode = true;
    globalThis._stCtx.chat = [
        { is_user: false, is_system: false, is_hidden: false, mes: 'pinned post', swipe_id: 1, swipes: ['old', 'pinned post'] },
        { is_user: false, is_system: false, is_hidden: false, mes: 'later post', swipe_id: 0, swipes: ['later post'] },
    ];
    state.currentPostId = '1';
    state.currentSwipeIdx = 0;
    state.pinnedFeeds.set('chatA', {
        html: '<p>old pinned commentary</p>',
        msgId: '0',
        swipeIdx: 1,
        ts: Date.now(),
    });

    await _testGenerateFeed(null, null, true, async () => validResponse);

    const pinned = state.pinnedFeeds.get('chatA');
    assert.equal(pinned.msgId, '0');
    assert.equal(pinned.swipeIdx, 1);
    assert.match(pinned.html, /dsc_message/);
});

test('manual noSave regeneration falls back from an invalid pin to current eligible post', async () => {
    setupGeneration();
    state.settings.noSaveMode = true;
    state.currentPostId = '1';
    state.currentSwipeIdx = 0;
    state.pinnedFeeds.set('chatA', {
        html: '<p>stale</p>', msgId: '99', swipeIdx: 0, ts: Date.now(),
    });

    await _testGenerateFeed(null, null, true, async () => validResponse);

    assert.equal(state.pinnedFeeds.get('chatA').msgId, '1');
    assert.equal(state.pinnedFeeds.get('chatA').swipeIdx, 0);
});

test('explicit autoUpdate target still overrides a different noSave pinned source', async () => {
    setupGeneration();
    state.settings.noSaveMode = true;
    globalThis._stCtx.chat = [
        { is_user: false, is_system: false, is_hidden: false, mes: 'pinned post', swipe_id: 0, swipes: ['pinned post'] },
        { is_user: false, is_system: false, is_hidden: false, mes: 'auto-updated post', swipe_id: 0, swipes: ['auto-updated post'] },
    ];
    state.pinnedFeeds.set('chatA', {
        html: '<p>pinned</p>', msgId: '0', swipeIdx: 0, ts: Date.now(),
    });

    await _testGenerateFeed('1', 0, false, async () => validResponse);

    assert.equal(state.pinnedFeeds.get('chatA').msgId, '1');
    assert.equal(state.pinnedFeeds.get('chatA').swipeIdx, 0);
});

test('generateFeed uses generation fingerprint for cache hit, miss, and store', async () => {
    const loreConfig = { mode: 'manual', selectedEntries: [] };
    const view = setupGeneration({ loreConfig });
    const generationFp = buildGenerationFingerprint(buildGenerationFingerprintInput({
        settings: state.settings,
        loreConfig,
        stylePrompt: 'Generate {{count}} comments.',
    }));
    _seedSaveCache({
        1: { 0: { html: '<p>cached</p>', timestamp: 1, generationFp } },
    });
    let apiCalls = 0;
    await _testGenerateFeed('1', 0, false, async () => { apiCalls++; return validResponse; });
    assert.equal(apiCalls, 0);
    assert.equal(view.feedHtml, '<p>cached</p>');

    setupGeneration({ loreConfig: { mode: 'manual', selectedEntries: [{ book: 'Book', uid: 1 }] }, cachedGenerationFp: generationFp });
    globalThis._stCtx.loadWorldInfo = async () => ({ entries: { 1: { uid: 1, content: 'lore' } } });
    await _testGenerateFeed('1', 0, false, async () => { apiCalls++; return validResponse; });
    assert.equal(apiCalls, 1, 'changed lore config must miss cache');
    assert.notEqual(getFeedSlot('1', 0)?.generationFp, generationFp);
    assert.match(getFeedSlot('1', 0)?.generationFp, /^v1-/);
});

// ── generateFeed epoch guard ──

test('generateFeed: epoch change during style load skips matching cache access and render', async () => {
    const loreConfig = { mode: 'manual', selectedEntries: [] };
    const view = setupGeneration({ loreConfig });
    const generationFp = buildGenerationFingerprint(buildGenerationFingerprintInput({
        settings: state.settings,
        loreConfig,
        stylePrompt: 'Generate {{count}} comments.',
    }));
    _seedSaveCache({
        1: { 0: { html: '<p>cached</p>', timestamp: 1, generationFp } },
    });
    const originalTimestamp = getFeedSlot('1', 0)?.ts;

    let resolveStyle;
    let styleLoadStarted = false;
    globalThis.SillyTavern.libs.localforage.getItem = key => {
        if (key !== 'DSComments_prompts') return Promise.resolve(null);
        styleLoadStarted = true;
        return new Promise(resolve => { resolveStyle = resolve; });
    };
    let apiCalls = 0;
    const genPromise = _testGenerateFeed('1', 0, false, async () => {
        apiCalls++;
        return validResponse;
    });

    while (!styleLoadStarted) await new Promise(resolve => setImmediate(resolve));
    bumpGenerationEpoch();
    resolveStyle({ main: 'Generate {{count}} comments.' });
    await genPromise;

    assert.equal(getFeedSlot('1', 0)?.ts, originalTimestamp, 'stale generation must not access matching cache');
    assert.notEqual(view.feedHtml, '<p>cached</p>', 'stale generation must not render matching cache');
    assert.equal(apiCalls, 0);
});

test('generateFeed: a result completed after CHAT_CHANGED is NOT stored (stale discard)', async () => {
    // Arrange: chat A has one AI post. generationEpoch = 0 at start.
    state.settings = {
        enabled: true, autoUpdate: true, noSaveMode: false,
        apiSource: 'custom', customEndpoint: 'http://x', customModel: 'm',
        promptTemplate: 'main', userCount: 3, includeChatHistory: false,
        contextDepth: 4, includePersona: false, includeCharacterDescription: false,
        enableJailbreakBlock: false, jailbreakRole: 'system',
        profileId: '', soundEnabled: false,
    };
    globalThis._stCtx.chat = [
        { is_user: true, is_system: false, mes: 'u0' },
        { is_user: false, is_system: false, is_hidden: false, mes: 'a1', swipe_id: 0, swipes: ['a1'] },
    ];
    globalThis._stCtx.chatId = 'chatA';
    globalThis._stCtx.chatMetadata = { dscomments_commentary: { posts: {}, current: { msgId: null, swipeIdx: 0 } } };
    globalThis._stCtx.saveMetadata = () => {};
    globalThis.SillyTavern.libs.localforage.getItem = async (key) =>
        key === 'DSComments_prompts' ? { main: 'Generate {{count}} comments.' } : null;
    state.generationEpoch = 0;

    // Fake API: resolves with valid model output, but only AFTER we bump the epoch.
    let resolveApi;
    let apiCalled = false;
    const fakeApi = () => {
        apiCalled = true;
        return new Promise((res) => { resolveApi = res; });
    };
    setCurrentPost('1', 0);

    // Document stub: cache.js needs #dscFeed to exist for setFeedText.
    let feedHtml = '';
    globalThis.document.getElementById = (id) => id === 'dscFeed'
        ? {
            set innerHTML(v){feedHtml=v;},
            get innerHTML(){return feedHtml;},
            _dscLastHtml: '',
            scrollTop: 0,
            querySelector: () => null,
        }
        : null;

    const genPromise = _testGenerateFeed('1', 0, true, fakeApi);

    // Wait until generateFeed has reached callGenerationAPI and created the deferred.
    while (!apiCalled) await new Promise(r => setImmediate(r));

    // Simulate the user switching to chat B while generation is in flight.
    state.generationEpoch = 99;   // = bumpGenerationEpoch from CHAT_CHANGED

    // Now the API completes.
    resolveApi(JSON.stringify([
        { username: 'coder_42', content: 'nice', reactions: [] },
        { username: 'bot', content: 'cool', reactions: [] },
    ]));

    await genPromise;

    // Assert: nothing was stored for the stale epoch.
    assert.equal(getFeedSlot('1', 0), null,
        'stale result must not be written to the feed mirror');
});

test('generateFeed: chat-change abort discards the result and clears the launcher spinner', async () => {
    // Regression for H1: CHAT_CHANGED bumps the epoch + nulls the owner while a
    // generation is in flight, then the aborted request rejects with AbortError.
    // The catch must discard (epoch changed) instead of overwriting the restored
    // feed with a "Generation cancelled" overlay, and the finally must still clear
    // the launcher spinner / status even though the owner is already null.
    state.settings = {
        enabled: true, autoUpdate: true, noSaveMode: false,
        apiSource: 'custom', customEndpoint: 'http://x', customModel: 'm',
        promptTemplate: 'main', userCount: 3, includeChatHistory: false,
        contextDepth: 4, includePersona: false, includeCharacterDescription: false,
        enableJailbreakBlock: false, jailbreakRole: 'system',
        profileId: '', soundEnabled: false,
    };
    globalThis._stCtx.chat = [
        { is_user: true, is_system: false, mes: 'u0' },
        { is_user: false, is_system: false, is_hidden: false, mes: 'a1', swipe_id: 0, swipes: ['a1'] },
    ];
    globalThis._stCtx.chatId = 'chatA';
    globalThis._stCtx.chatMetadata = { dscomments_commentary: { posts: {}, current: { msgId: null, swipeIdx: 0 } } };
    globalThis._stCtx.saveMetadata = () => {};
    globalThis.SillyTavern.libs.localforage.getItem = async (key) =>
        key === 'DSComments_prompts' ? { main: 'Generate {{count}} comments.' } : null;
    state.generationEpoch = 0;

    let rejectApi;
    let apiCalled = false;
    const fakeApi = () => {
        apiCalled = true;
        return new Promise((_, rej) => { rejectApi = rej; });
    };
    setCurrentPost('1', 0);

    // Feed stub captures innerHTML; launcher stub records classList changes.
    let feedHtml = '';
    const launcherClasses = new Set();
    const launcherBtn = {
        classList: {
            add: (c) => launcherClasses.add(c),
            remove: (c) => launcherClasses.delete(c),
            contains: (c) => launcherClasses.has(c),
            toggle: (c, f) => { const on = f === undefined ? !launcherClasses.has(c) : !!f; on ? launcherClasses.add(c) : launcherClasses.delete(c); },
        },
        dataset: {},
    };
    globalThis.document.getElementById = (id) => {
        if (id === 'dscFeed') return {
            set innerHTML(v) { feedHtml = v; },
            get innerHTML() { return feedHtml; },
            _dscLastHtml: '',
            scrollTop: 0,
            querySelector: () => null,
        };
        if (id === 'dsc_launcher') return launcherBtn;
        return null;
    };

    const genPromise = _testGenerateFeed('1', 0, true, fakeApi);
    while (!apiCalled) await new Promise(r => setImmediate(r));

    // Simulate CHAT_CHANGED mid-generation (mirrors events.js: bump epoch,
    // release ownership, mark not-in-progress, drop the controller).
    state.generationEpoch = 99;
    state.generationOwner = null;
    state.generationInProgress = false;
    state.abortController = null;

    // The abort surfaces as an AbortError rejection.
    const abortErr = new Error('aborted');
    abortErr.name = 'AbortError';
    rejectApi(abortErr);

    await genPromise;

    // Catch fix: no "cancelled" overlay overwrote the feed.
    assert.ok(!feedHtml.includes('dsc_cancelled'),
        'a chat-change abort must NOT write the "cancelled" overlay (epoch discard)');
    // Finally fix: the launcher spinner was cleared even though the owner was
    // already null (no newer generation owned the UI).
    assert.ok(!launcherClasses.has('dsc_generating'),
        'the launcher spinner must be cleared on a chat-change abort');
});

test('generateFeed: a plain API error renders the error overlay with an escaped message', async () => {
    const ctx = setupGeneration();

    await _testGenerateFeed('1', 0, true, async () => {
        throw new Error('BOOM <script>alert(1)</script>');
    });

    const html = ctx.feedHtml;
    assert.ok(html.includes('dsc_error'), 'error overlay rendered in the feed');
    assert.ok(html.includes('Error:'), 'localized error prefix');
    assert.ok(html.includes('BOOM'), 'error message visible to the user');
    assert.ok(!html.includes('<script>alert'), 'error message is HTML-escaped before innerHTML');
    assert.equal(state.generationInProgress, false, 'generation state released after the error');
});

test('generateFeed: a user abort (AbortError, epoch intact) renders the cancelled overlay', async () => {
    const ctx = setupGeneration();

    await _testGenerateFeed('1', 0, true, async () => {
        throw new DOMException('Aborted', 'AbortError');
    });

    const html = ctx.feedHtml;
    assert.ok(html.includes('dsc_cancelled'), 'cancelled overlay rendered in the feed');
    assert.ok(html.includes('Generation cancelled'), 'localized cancel text');
    assert.ok(!html.includes('dsc_error'), 'a user abort is a cancel, not an error');
    assert.equal(state.generationInProgress, false, 'generation state released after the cancel');
});

test('generateFeed: a result completed in the same epoch IS stored', async () => {
    state.settings = {
        enabled: true, autoUpdate: true, noSaveMode: false,
        apiSource: 'custom', customEndpoint: 'http://x', customModel: 'm',
        promptTemplate: 'main', userCount: 3, includeChatHistory: false,
        contextDepth: 4, includePersona: false, includeCharacterDescription: false,
        enableJailbreakBlock: false, jailbreakRole: 'system',
        profileId: '', soundEnabled: false,
    };
    globalThis._stCtx.chat = [
        { is_user: true, is_system: false, mes: 'u0' },
        { is_user: false, is_system: false, is_hidden: false, mes: 'a1', swipe_id: 0, swipes: ['a1'] },
    ];
    globalThis._stCtx.chatId = 'chatA';
    globalThis._stCtx.chatMetadata = { dscomments_commentary: { posts: {}, current: { msgId: null, swipeIdx: 0 } } };
    globalThis._stCtx.saveMetadata = () => {};
    globalThis.SillyTavern.libs.localforage.getItem = async (key) =>
        key === 'DSComments_prompts' ? { main: 'Generate {{count}} comments.' } : null;
    state.generationEpoch = 0;

    const fakeApi = async () => JSON.stringify([
        { username: 'coder_42', content: 'nice', reactions: [] },
        { username: 'bot', content: 'cool', reactions: [] },
    ]);
    setCurrentPost('1', 0);
    let feedHtml = '';
    globalThis.document.getElementById = (id) => id === 'dscFeed'
        ? {
            set innerHTML(v){feedHtml=v;},
            get innerHTML(){return feedHtml;},
            _dscLastHtml: '',
            scrollTop: 0,
            querySelector: () => null,
        }
        : null;

    await _testGenerateFeed('1', 0, true, fakeApi);

    const entry = getFeedSlot('1', 0);
    assert.ok(entry?.html, 'same-epoch result must be stored');
});

test('navigation during API does not retarget generation or storage', async () => {
    setupGeneration();
    globalThis._stCtx.chat.push({
        is_user: false, is_system: false, is_hidden: false,
        mes: 'a2', swipe_id: 0, swipes: ['a2'],
    });
    const api = Promise.withResolvers();
    let apiStarted = false;

    const run = _testGenerateFeed('1', 0, true, async () => {
        apiStarted = true;
        return api.promise;
    });
    while (!apiStarted) await new Promise(r => setImmediate(r));

    state.generationObservedTarget = { msgId: '2', swipeIdx: 0, source: 'scroll' };
    api.resolve(validResponse);
    await run;

    assert.ok(getFeedSlot('1', 0)?.html, 'result is stored for the original generation target');
    assert.equal(getFeedSlot('2', 0), null, 'navigation does not move the result to the observed post');
    assert.deepEqual(state.lastGenerationDiagnostics?.target, { chatId: 'chatA', msgId: '1', swipeIdx: 0 });
    assert.deepEqual(state.lastGenerationDiagnostics?.observedTarget, { msgId: '2', swipeIdx: 0, source: 'scroll' });
    assert.equal(state.lastGenerationDiagnostics?.viewChanged, true);
    assert.equal(state.lastGenerationDiagnostics?.outcome, 'stored-and-rendered');
    assert.equal(typeof state.lastGenerationDiagnostics?.phaseMs?.api, 'number');
});

test('generateFeed automatic mode merges keyword lore with cached VECTORIZED WORLD_INFO_ACTIVATED entries', async () => {
    setupGeneration({ loreConfig: { enabled: true, mode: 'automatic' } });
    state.lastActivatedWorldInfo = {
        chatId: 'chatA',
        msgId: '1',
        swipeIdx: 0,
        entries: [{ uid: 99, content: 'VEC_TEXT', world: 'Book', comment: 'Vec', vectorized: true }],
        ts: Date.now(),
    };
    const ctx = globalThis._stCtx;
    ctx.getWorldInfoPrompt = async () => ({ worldInfoString: 'KEYWORD_LORE' });
    ctx.loadWorldInfo = () => { throw new Error('raw load must not run'); };
    ctx.substituteParams = text => text;
    let userPrompt = '';

    await _testGenerateFeed('1', 0, true, async (_system, userMessages) => {
        userPrompt = userMessages.join('\n\n');
        return validResponse;
    });

    assert.match(userPrompt, /KEYWORD_LORE/);
    assert.match(userPrompt, /VEC_TEXT/);
});

// ── F10: navLockUntil must not be lowered by the generator finally ──
// The restore path (index.js) sets a higher navLockUntil; the generator's
// finally must use Math.max so a generation finishing during a restore
// window does not shorten the existing lock.

test('F10: finally does not lower a higher navLockUntil set by the restore path', async () => {
    setupGeneration();
    // Restore path set a 2s lock well beyond the generator's 250ms settle.
    const restoreLock = Date.now() + 2000;
    state.navLockUntil = restoreLock;

    await _testGenerateFeed('1', 0, true, async () => validResponse);

    assert.ok(state.navLockUntil >= restoreLock,
        `finally must not lower the lock: got ${state.navLockUntil}, restore set ${restoreLock}`);
});
