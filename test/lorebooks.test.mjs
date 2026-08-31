// @ts-check

import '../test-helpers/stub-runtime.mjs';
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { resetCtx } from '../test-helpers/stub-runtime.mjs';
import { state } from '../src/core.js';
import {
    LORE_META_KEY,
    LORE_MODE,
    LORE_SCOPE,
    loreRefKey,
    normalizeLoreConfig,
    getChatLoreConfig,
    saveChatLoreConfig,
    listLorebookNames,
    loadLorebookEntries,
    resolveManualLore,
    collectAutomaticLore,
    resolveAttachedLorebooks,
    resolveAttachedLorebookSources,
    buildGenerationFingerprintInput,
    buildGenerationFingerprint,
} from '../src/lorebooks.js';

beforeEach(() => {
    resetCtx();
    state.lastActivatedWorldInfo = null;
});

test('exports stable lore metadata constants', () => {
    assert.equal(LORE_META_KEY, 'dscomments_lorebook');
    assert.deepEqual(LORE_MODE, { AUTOMATIC: 'automatic', MANUAL: 'manual' });
    assert.equal(Object.isFrozen(LORE_MODE), true);
});

test('loreRefKey uses the normalized book and numeric uid identity', () => {
    assert.equal(loreRefKey({ book: '  Main Lore  ', uid: '12' }), 'Main Lore\u000012');
});

test('loreRefKey does not throw for Symbol or hostile-coercion UIDs', () => {
    const hostileUid = {
        [Symbol.toPrimitive]() {
            throw new Error('uid coercion failed');
        },
    };

    assert.doesNotThrow(() => loreRefKey({ book: 'Main Lore', uid: Symbol('invalid') }));
    assert.doesNotThrow(() => loreRefKey({ book: 'Main Lore', uid: hostileUid }));
});

test('normalizeLoreConfig returns fresh-chat defaults for missing or invalid input', () => {
    assert.deepEqual(normalizeLoreConfig(), {
        enabled: false, mode: 'automatic', manualBooks: [], selectedEntries: [], autoScope: undefined,
    });
    assert.deepEqual(normalizeLoreConfig(null), {
        enabled: false, mode: 'automatic', manualBooks: [], selectedEntries: [], autoScope: undefined,
    });
});

test('normalizeLoreConfig migrates legacy configs: enabled true, manualBooks derived from refs', () => {
    assert.deepEqual(normalizeLoreConfig({ mode: 'invalid', selectedEntries: null }), {
        enabled: true, mode: 'automatic', manualBooks: [], selectedEntries: [], autoScope: undefined,
    });
    assert.deepEqual(normalizeLoreConfig({
        mode: 'manual',
        selectedEntries: [{ book: 'Zulu', uid: 3 }, { book: 'Alpha', uid: 2 }, { book: 'Zulu', uid: 5 }],
    }), {
        enabled: true,
        mode: 'manual',
        manualBooks: ['Alpha', 'Zulu'],
        selectedEntries: [
            { book: 'Alpha', uid: 2 },
            { book: 'Zulu', uid: 3 },
            { book: 'Zulu', uid: 5 },
        ],
        autoScope: undefined,
    });
});

test('normalizeLoreConfig keeps explicit enabled/manualBooks and filters refs to panel books', () => {
    assert.deepEqual(normalizeLoreConfig({
        enabled: false,
        mode: 'manual',
        manualBooks: [' Alpha ', 'Beta', 'beta', '', 'Alpha', 42],
        selectedEntries: [
            { book: 'Alpha', uid: 2 },
            { book: 'Gone', uid: 9 },
        ],
    }), {
        enabled: false,
        mode: 'manual',
        manualBooks: ['Alpha', 'Beta', 'beta'],
        selectedEntries: [{ book: 'Alpha', uid: 2 }],
        autoScope: undefined,
    });
});

test('normalizeLoreConfig validates, normalizes, deduplicates, and sorts refs', () => {
    const config = normalizeLoreConfig({
        mode: 'manual',
        selectedEntries: [
            { book: 'Zulu', uid: 3 },
            { book: ' Alpha ', uid: '10' },
            { book: 'Alpha', uid: 2 },
            { book: 'Alpha', uid: '2' },
            { book: '', uid: 1 },
            { book: 'Bad uid', uid: Infinity },
            { book: 'Null uid', uid: null },
            { book: 'Empty uid', uid: '' },
            { book: 'Boolean uid', uid: true },
            { book: 'Symbol uid', uid: Symbol('invalid') },
            { book: 'Missing uid' },
            null,
        ],
    });

    assert.deepEqual(config, {
        enabled: true,
        mode: 'manual',
        manualBooks: ['Alpha', 'Zulu'],
        selectedEntries: [
            { book: 'Alpha', uid: 2 },
            { book: 'Alpha', uid: 10 },
            { book: 'Zulu', uid: 3 },
        ],
        autoScope: undefined,
    });
});

test('getChatLoreConfig reads and normalizes per-chat metadata', () => {
    const ctx = {
        chatMetadata: {
            [LORE_META_KEY]: {
                mode: 'manual',
                selectedEntries: [{ book: ' Lore ', uid: '7' }],
            },
        },
    };

    assert.deepEqual(getChatLoreConfig(ctx), {
        enabled: true,
        mode: 'manual',
        manualBooks: ['Lore'],
        selectedEntries: [{ book: 'Lore', uid: 7 }],
        autoScope: undefined,
    });
    assert.deepEqual(getChatLoreConfig({ chatMetadata: {} }), {
        enabled: false, mode: 'automatic', manualBooks: [], selectedEntries: [], autoScope: undefined,
    });
});

test('saveChatLoreConfig creates metadata, writes normalized config, and saves once', () => {
    let saveCalls = 0;
    const ctx = {
        chatMetadata: undefined,
        saveMetadata: () => { saveCalls++; },
    };

    const saved = saveChatLoreConfig({
        mode: 'manual',
        selectedEntries: [{ book: ' Book ', uid: '5' }],
    }, ctx);

    assert.deepEqual(saved, {
        enabled: true,
        mode: 'manual',
        manualBooks: ['Book'],
        selectedEntries: [{ book: 'Book', uid: 5 }],
        autoScope: undefined,
    });
    assert.deepEqual(ctx.chatMetadata[LORE_META_KEY], saved);
    assert.equal(saveCalls, 1);
});

test('saveChatLoreConfig reports rejected persistence with a defined user message', async () => {
    const toastrCalls = [];
    globalThis.toastr = { error: (message, title) => toastrCalls.push([message, title]) };
    const ctx = {
        chatMetadata: {},
        saveMetadata: async () => { throw new Error('metadata write failed'); },
    };

    saveChatLoreConfig({ mode: 'automatic' }, ctx);
    await new Promise(resolve => setTimeout(resolve, 10));

    assert.deepEqual(toastrCalls, [[
        'Could not save lorebook settings.',
        'DS Comments',
    ]]);
    delete globalThis.toastr;
});

test('saveChatLoreConfig observes a synchronous saveMetadata throw without crashing', async () => {
    const errorCalls = [];
    const originalError = console.error;
    console.error = (...args) => errorCalls.push(args);
    const ctx = {
        chatMetadata: {},
        saveMetadata: () => { throw new Error('synchronous metadata failure'); },
    };

    try {
        assert.doesNotThrow(() => saveChatLoreConfig({ mode: 'manual' }, ctx));
        await new Promise(resolve => setTimeout(resolve, 10));

        assert.equal(errorCalls.length, 1);
        assert.match(errorCalls[0][1], /save lorebook configuration persistence failed/);
        assert.match(errorCalls[0][2].message, /synchronous metadata failure/);
    } finally {
        console.error = originalError;
    }
});

test('loadLorebookEntries normalizes object entries in numeric UID order', async () => {
    const ctx = {
        loadWorldInfo: async () => ({
            entries: {
                8: { name: 'Named', content: '' },
                2: { uid: 2, comment: 'Commented', content: 'two', disable: true },
                5: { uid: '5', key: ['Keyword'], content: 'five', vectorized: true },
                6: { uid: 'nope', content: 'fallback uid' },
                7: { uid: Symbol('invalid'), content: 'hostile uid' },
                9: { uid: null, content: 'null uid' },
                10: { uid: '', content: 'blank uid' },
                11: { uid: '   ', content: 'whitespace uid' },
                12: { uid: false, content: 'boolean uid' },
                bad: { uid: 'nope', content: 'invalid' },
            },
        }),
    };

    assert.deepEqual(await loadLorebookEntries(ctx, 'Object Book'), [
        { book: 'Object Book', uid: 2, label: 'Commented', content: 'two', vectorized: false },
        { book: 'Object Book', uid: 5, label: 'Keyword', content: 'five', vectorized: true },
        { book: 'Object Book', uid: 6, label: 'Entry 6', content: 'fallback uid', vectorized: false },
        { book: 'Object Book', uid: 7, label: 'Entry 7', content: 'hostile uid', vectorized: false },
        { book: 'Object Book', uid: 8, label: 'Named', content: '', vectorized: false },
        { book: 'Object Book', uid: 9, label: 'Entry 9', content: 'null uid', vectorized: false },
        { book: 'Object Book', uid: 10, label: 'Entry 10', content: 'blank uid', vectorized: false },
        { book: 'Object Book', uid: 11, label: 'Entry 11', content: 'whitespace uid', vectorized: false },
        { book: 'Object Book', uid: 12, label: 'Entry 12', content: 'boolean uid', vectorized: false },
    ]);
});

test('loadLorebookEntries accepts arrays and supplies fallback labels', async () => {
    const ctx = {
        loadWorldInfo: async () => ({ entries: [
            { uid: 7, content: 'seven' },
            { uid: 3, comment: '', name: '', key: [], content: 42 },
            { uid: null, content: 'discard null' },
            { uid: '', content: 'discard blank' },
            { uid: '   ', content: 'discard whitespace' },
            { uid: true, content: 'discard boolean' },
            null,
        ] }),
    };

    assert.deepEqual(await loadLorebookEntries(ctx, 'Array Book'), [
        { book: 'Array Book', uid: 3, label: 'Entry 3', content: '', vectorized: false },
        { book: 'Array Book', uid: 7, label: 'Entry 7', content: 'seven', vectorized: false },
    ]);
});

test('listLorebookNames returns sorted string names without loading entries', async () => {
    let loadCalls = 0;
    const ctx = {
        getWorldInfoNames: async () => ['Zulu', 'Alpha', 42, null, 'Beta'],
        loadWorldInfo: async () => { loadCalls++; return { entries: {} }; },
    };

    assert.deepEqual(await listLorebookNames(ctx), ['Alpha', 'Beta', 'Zulu']);
    assert.equal(loadCalls, 0);
});

test('listLorebookNames normalizes a malformed API result to an empty list', async () => {
    assert.deepEqual(await listLorebookNames({ getWorldInfoNames: async () => null }), []);
});

test('collectAutomaticLore calls the ST API exactly once and returns only its string', async () => {
    const chatMessages = [{ mes: 'hello' }];
    const globalScanData = { persona: 'scan data' };
    const calls = [];
    let loadCalls = 0;
    const ctx = {
        maxContext: 8192,
        getWorldInfoPrompt: async (...args) => {
            calls.push(args);
            return { worldInfoString: 'automatic lore', entries: ['ignored'] };
        },
        loadWorldInfo: async () => { loadCalls++; },
    };

    assert.deepEqual(await collectAutomaticLore(ctx, { chatMessages, globalScanData }), {
        text: 'automatic lore',
        entries: [],
        missing: [],
    });
    // F2: isDryRun MUST be true — a non-dry-run scan re-emits
    // WORLD_INFO_ACTIVATED and writes timed-effects into chat_metadata
    // (see the contract comment in lorebooks.js).
    assert.deepEqual(calls, [[chatMessages, 8192, true, globalScanData]]);
    assert.equal(loadCalls, 0);
});

test('collectAutomaticLore uses the context fallback and safely handles unavailable or malformed APIs', async () => {
    const args = [];
    const ctx = {
        maxContext: 0,
        getWorldInfoPrompt: async (...callArgs) => {
            args.push(callArgs);
            return { worldInfoString: 42 };
        },
        loadWorldInfo: () => { throw new Error('must not load lorebooks'); },
    };

    assert.deepEqual(await collectAutomaticLore(ctx, {
        chatMessages: undefined,
        globalScanData: null,
    }), { text: '', entries: [], missing: [] });
    assert.deepEqual(args, [[undefined, 4096, true, null]]);
    assert.deepEqual(await collectAutomaticLore({}, {
        chatMessages: [],
        globalScanData: undefined,
    }), { text: '', entries: [], missing: [] });

    for (const result of [undefined, null, 'text', {}, { worldInfoString: null }]) {
        assert.deepEqual(await collectAutomaticLore({
            getWorldInfoPrompt: async () => result,
        }, { chatMessages: [], globalScanData: {} }), {
            text: '',
            entries: [],
            missing: [],
        });
    }
});

test('collectAutomaticLore without cache uses only getWorldInfoPrompt', async () => {
    state.lastActivatedWorldInfo = null;
    const ctx = {
        chatId: 'chatA',
        maxContext: 4096,
        getWorldInfoPrompt: async () => ({ worldInfoString: 'KEYWORD_LORE' }),
    };
    const result = await collectAutomaticLore(ctx, {
        chatMessages: [],
        globalScanData: {},
        anchorMsgId: '5',
        anchorSwipeIdx: 0,
    });
    assert.equal(result.text, 'KEYWORD_LORE');
    assert.deepEqual(result.entries, []);
});

test('collectAutomaticLore appends only VECTORIZED cached entries when anchor matches', async () => {
    state.lastActivatedWorldInfo = {
        chatId: 'chatA',
        msgId: '5',
        swipeIdx: 0,
        entries: [
            { uid: 1, content: 'VEC_CONTENT', world: 'Book', comment: '', vectorized: true },
            // Non-vectorized entry: its content already lives in scanText
            // (worldInfoString). It must NOT be re-appended from the cache.
            { uid: 2, content: 'KEYWORD_DUPLICATE', world: 'Book', comment: 'kw', vectorized: false },
            { uid: 3, content: '', world: 'Book', comment: 'Empty vec', vectorized: true },
        ],
        ts: Date.now(),
    };
    // collectAutomaticLore compares the cache against the passed ctx (not getCtx()).
    const ctx = {
        chatId: 'chatA',
        maxContext: 4096,
        getWorldInfoPrompt: async () => ({ worldInfoString: 'KEYWORD' }),
        substituteParams: t => t,
    };
    const result = await collectAutomaticLore(ctx, {
        chatMessages: [],
        globalScanData: {},
        anchorMsgId: '5',
        anchorSwipeIdx: 0,
    });
    // KEYWORD from scan + VEC_CONTENT from vectorized cache entries only.
    // KEYWORD_DUPLICATE is excluded (already in scanText); empty vectorized entry
    // is filtered out by the content-length check.
    assert.equal(result.text, 'KEYWORD\n\nVEC_CONTENT');
    assert.deepEqual(result.entries, []);
});

test('collectAutomaticLore ignores stale cache when anchor mismatches', async () => {
    state.lastActivatedWorldInfo = {
        chatId: 'chatA',
        msgId: '3',
        swipeIdx: 0,
        entries: [{ uid: 1, content: 'STALE_VEC', world: 'Book', comment: '' }],
        ts: Date.now(),
    };
    const ctx = {
        chatId: 'chatA',
        maxContext: 4096,
        getWorldInfoPrompt: async () => ({ worldInfoString: 'KEYWORD' }),
        substituteParams: t => t,
    };
    const result = await collectAutomaticLore(ctx, {
        chatMessages: [],
        globalScanData: {},
        anchorMsgId: '5',
        anchorSwipeIdx: 0,
    });
    assert.equal(result.text, 'KEYWORD');
    assert.deepEqual(result.entries, []);
});

test('collectAutomaticLore ignores cache from a different chat', async () => {
    state.lastActivatedWorldInfo = {
        chatId: 'otherChat',
        msgId: '5',
        swipeIdx: 0,
        entries: [{ uid: 1, content: 'WRONG_CHAT_VEC', world: 'Book', comment: '' }],
        ts: Date.now(),
    };
    const ctx = {
        chatId: 'chatA',
        maxContext: 4096,
        getWorldInfoPrompt: async () => ({ worldInfoString: 'KEYWORD' }),
    };
    const result = await collectAutomaticLore(ctx, {
        chatMessages: [],
        globalScanData: {},
        anchorMsgId: '5',
        anchorSwipeIdx: 0,
    });
    assert.equal(result.text, 'KEYWORD');
});

test('collectAutomaticLore applies substituteParams to activated cache entries', async () => {
    state.lastActivatedWorldInfo = {
        chatId: 'chatA',
        msgId: '0',
        swipeIdx: 0,
        entries: [{ uid: 1, content: 'Hello {{user}}', world: 'Book', comment: '', vectorized: true }],
        ts: Date.now(),
    };
    const ctx = {
        chatId: 'chatA',
        maxContext: 4096,
        getWorldInfoPrompt: async () => ({ worldInfoString: '' }),
        substituteParams: text => text.replace('{{user}}', 'Alice'),
    };
    const result = await collectAutomaticLore(ctx, {
        chatMessages: [],
        globalScanData: {},
        anchorMsgId: '0',
        anchorSwipeIdx: 0,
    });
    assert.equal(result.text, 'Hello Alice');
});

test('buildGenerationFingerprint is stable across equivalent normalized inputs and ref order', () => {
    const base = {
        loreConfig: {
            mode: 'manual',
            selectedEntries: [
                { book: 'Zulu', uid: 3 },
                { book: ' Alpha ', uid: '2' },
            ],
        },
        includeChatHistory: true,
        contextDepth: 6,
        includePersona: false,
        includeCharacterDescription: true,
        promptTemplate: 'main',
        stylePrompt: 'concise',
    };
    const reordered = {
        ...base,
        loreConfig: {
            mode: 'manual',
            selectedEntries: [
                { book: 'Alpha', uid: 2 },
                { book: 'Zulu', uid: 3 },
                { book: 'Alpha', uid: '2' },
            ],
        },
    };

    const fingerprint = buildGenerationFingerprint(base);
    assert.match(fingerprint, /^v1-[a-z0-9]+$/);
    assert.equal(buildGenerationFingerprint(reordered), fingerprint);
});

test('Unicode-equivalent book names have deterministic normalize order and fingerprints', () => {
    const precomposed = '\u00e9';
    const decomposed = 'e\u0301';
    const forward = [
        { book: precomposed, uid: 1 },
        { book: decomposed, uid: 1 },
    ];
    const reversed = [...forward].reverse();

    assert.deepEqual(normalizeLoreConfig({ mode: 'manual', selectedEntries: forward }).selectedEntries, [
        { book: decomposed, uid: 1 },
        { book: precomposed, uid: 1 },
    ]);
    assert.deepEqual(
        normalizeLoreConfig({ mode: 'manual', selectedEntries: reversed }).selectedEntries,
        normalizeLoreConfig({ mode: 'manual', selectedEntries: forward }).selectedEntries,
    );
    assert.equal(
        buildGenerationFingerprint({ loreConfig: { mode: 'manual', selectedEntries: forward } }),
        buildGenerationFingerprint({ loreConfig: { mode: 'manual', selectedEntries: reversed } }),
    );
});

test('buildGenerationFingerprint changes for every generation-relevant field', () => {
    const base = buildGenerationFingerprintInput({
        settings: {
            userCount: 5,
            enableJailbreakBlock: true,
            jailbreakRole: 'system',
            jailbreakText: 'jailbreak',
            apiSource: 'profile',
            profileId: 'profile-1',
            customEndpoint: 'https://unused.example/v1',
            customModel: 'unused-model',
            includeChatHistory: true,
            contextDepth: 4,
            includePersona: true,
            includeCharacterDescription: true,
            promptTemplate: 'main',
        },
        loreConfig: {
            mode: 'manual',
            selectedEntries: [{ book: 'Book', uid: 1 }],
        },
        stylePrompt: 'style',
        profile: { id: 'profile-1', name: 'Primary', api: 'openai', model: 'model-a' },
    });
    const fingerprint = buildGenerationFingerprint(base);
    const changes = [
        { loreConfig: { ...base.loreConfig, mode: 'automatic' } },
        { loreConfig: { ...base.loreConfig, selectedEntries: [{ book: 'Book', uid: 2 }] } },
        { loreConfig: { ...base.loreConfig, enabled: false } },
        { loreConfig: { ...base.loreConfig, manualBooks: ['Other'] } },
        { includeChatHistory: false },
        { contextDepth: 5 },
        { includePersona: false },
        { includeCharacterDescription: false },
        { promptTemplate: 'alternate' },
        { stylePrompt: 'different style' },
        { userCount: 6 },
        { enableJailbreakBlock: false },
        { jailbreakRole: 'user' },
        { jailbreakRole: 'assistant' },
        { jailbreakText: 'different jailbreak' },
        { apiSource: 'custom' },
        { profileId: 'profile-2' },
        { customEndpoint: 'https://other.example/v1' },
        { customModel: 'other-model' },
        { profileApi: 'anthropic' },
        { profileModel: 'model-b' },
    ];

    for (const change of changes) {
        assert.notEqual(buildGenerationFingerprint({ ...base, ...change }), fingerprint);
    }
});

test('buildGenerationFingerprintInput applies deterministic defaults without undefined fields', () => {
    const input = buildGenerationFingerprintInput({ settings: {}, loreConfig: undefined, stylePrompt: undefined });

    assert.deepEqual(input, {
        loreConfig: { enabled: false, mode: 'automatic', manualBooks: [], selectedEntries: [], autoScope: undefined },
        includeChatHistory: false,
        contextDepth: null,
        includePersona: false,
        includeCharacterDescription: false,
        promptTemplate: '',
        stylePrompt: '',
        userCount: 5,
        enableJailbreakBlock: false,
        jailbreakRole: 'system',
        jailbreakText: '',
        apiSource: '',
        profileId: '',
        customEndpoint: '',
        customModel: '',
        profileApi: '',
        profileModel: '',
    });
    assert.equal(JSON.stringify(input).includes('undefined'), false);
});

test('buildGenerationFingerprint normalizes malformed scalar fields deterministically', () => {
    const malformed = {
        loreConfig: { mode: 'manual', selectedEntries: [{ book: 'B', uid: 1 }] },
        includeChatHistory: 1,
        contextDepth: Infinity,
        includePersona: 'yes',
        includeCharacterDescription: null,
        promptTemplate: null,
        stylePrompt: 42,
    };
    const normalized = {
        loreConfig: { mode: 'manual', selectedEntries: [{ book: 'B', uid: 1 }] },
        includeChatHistory: true,
        contextDepth: null,
        includePersona: true,
        includeCharacterDescription: false,
        promptTemplate: '',
        stylePrompt: '',
    };

    assert.equal(buildGenerationFingerprint(malformed), buildGenerationFingerprint(normalized));
});

test('resolveManualLore resolves pairs, includes inactive rows, expands macros, and loads once', async () => {
    const loads = new Map();
    const ctx = {
        loadWorldInfo: async book => {
            loads.set(book, (loads.get(book) ?? 0) + 1);
            return { entries: {
                1: { uid: 1, comment: `${book} one`, content: `${book} {{user}}`, disabled: true },
                2: { uid: 2, name: `${book} two`, content: `${book} second`, vectorized: true },
            } };
        },
        substituteParams: text => text.replace('{{user}}', 'Alice'),
    };

    const result = await resolveManualLore(ctx, [
        { book: 'Beta', uid: 2 },
        { book: 'Alpha', uid: 1 },
        { book: 'Beta', uid: 1 },
        { book: 'Beta', uid: '1' },
    ]);

    assert.deepEqual(result, {
        text: 'Alpha Alice\n\nBeta Alice\n\nBeta second',
        entries: [
            { book: 'Alpha', uid: 1, label: 'Alpha one' },
            { book: 'Beta', uid: 1, label: 'Beta one' },
            { book: 'Beta', uid: 2, label: 'Beta two' },
        ],
        missing: [],
    });
    assert.deepEqual(Object.fromEntries(loads), { Alpha: 1, Beta: 1 });
});

test('resolveManualLore reports missing refs while failed and malformed books do not block others', async () => {
    const ctx = {
        loadWorldInfo: async book => {
            if (book === 'Broken') throw new Error('load failed');
            if (book === 'Malformed') return { entries: 'not a container' };
            return { entries: { 1: { uid: 1, content: 'available' } } };
        },
    };

    assert.deepEqual(await resolveManualLore(ctx, [
        { book: 'Good', uid: 2 },
        { book: 'Broken', uid: 1 },
        { book: 'Good', uid: 1 },
        { book: 'Malformed', uid: 4 },
    ]), {
        text: 'available',
        entries: [{ book: 'Good', uid: 1, label: 'Entry 1' }],
        missing: [
            { book: 'Broken', uid: 1 },
            { book: 'Good', uid: 2 },
            { book: 'Malformed', uid: 4 },
        ],
    });
});

test('resolveManualLore resolves empty content metadata but omits it from text', async () => {
    let substitutions = 0;
    const ctx = {
        loadWorldInfo: async () => ({ entries: {
            1: { uid: 1, comment: 'Empty', content: '' },
            2: { uid: 2, comment: 'Filled', content: 'kept' },
        } }),
        substituteParams: content => {
            substitutions++;
            return content;
        },
    };

    assert.deepEqual(await resolveManualLore(ctx, [
        { book: 'Book', uid: 1 },
        { book: 'Book', uid: 2 },
    ]), {
        text: 'kept',
        entries: [
            { book: 'Book', uid: 1, label: 'Empty' },
            { book: 'Book', uid: 2, label: 'Filled' },
        ],
        missing: [],
    });
    assert.equal(substitutions, 2);
});

test('loadLorebookEntries extracts vectorized flag from raw entries', async () => {
    const ctx = {
        loadWorldInfo: async () => ({ entries: {
            1: { uid: 1, comment: 'Plain', content: 'one' },
            2: { uid: 2, comment: 'Vec', content: 'two', vectorized: true },
            3: { uid: 3, comment: 'Bad vec', content: 'three', vectorized: 'yes' },
            4: { uid: 4, comment: 'Falsy zero', content: 'four', vectorized: 0 },
            5: { uid: 5, comment: 'Falsy empty', content: 'five', vectorized: '' },
        } }),
    };
    assert.deepEqual(await loadLorebookEntries(ctx, 'Book'), [
        { book: 'Book', uid: 1, label: 'Plain', content: 'one', vectorized: false },
        { book: 'Book', uid: 2, label: 'Vec', content: 'two', vectorized: true },
        { book: 'Book', uid: 3, label: 'Bad vec', content: 'three', vectorized: true },
        { book: 'Book', uid: 4, label: 'Falsy zero', content: 'four', vectorized: false },
        { book: 'Book', uid: 5, label: 'Falsy empty', content: 'five', vectorized: false },
    ]);
});

test('resolveManualLore includes vectorized entry content same as normal', async () => {
    const ctx = {
        loadWorldInfo: async () => ({ entries: {
            1: { uid: 1, comment: 'Vec', content: 'vec content', vectorized: true },
        } }),
    };
    const result = await resolveManualLore(ctx, [{ book: 'B', uid: 1 }]);
    assert.equal(result.text, 'vec content');
    assert.deepEqual(result.entries, [{ book: 'B', uid: 1, label: 'Vec' }]);
});

// ── Auto-scope: attached-only lorebooks ──

test('normalizeLoreConfig keeps an explicit attached scope and coerces garbage to undefined', () => {
    const attached = normalizeLoreConfig({ mode: 'automatic', autoScope: 'attached' });
    assert.equal(attached.autoScope, 'attached');

    for (const garbage of ['all', 'ALL', 'Attached', '', null, 42, {}]) {
        assert.equal(
            normalizeLoreConfig({ autoScope: garbage }).autoScope,
            undefined,
            `autoScope ${String(garbage)} must normalize to undefined`,
        );
    }
});

test('fingerprint is IDENTICAL for configs without autoScope and with explicit all', () => {
    const base = {
        settings: { userCount: 5 },
        loreConfig: { enabled: true, mode: 'automatic' },
        stylePrompt: 'vibe',
    };
    const explicitAll = {
        ...base,
        loreConfig: { enabled: true, mode: 'automatic', autoScope: 'all' },
    };
    const legacyUndefined = {
        ...base,
        loreConfig: { enabled: true, mode: 'automatic', autoScope: undefined },
    };
    const attached = {
        ...base,
        loreConfig: { enabled: true, mode: 'automatic', autoScope: 'attached' },
    };

    const baseFp = buildGenerationFingerprint(buildGenerationFingerprintInput(base));
    assert.equal(
        buildGenerationFingerprint(buildGenerationFingerprintInput(explicitAll)),
        baseFp,
        'explicit all must hash identically to the default — cache must not invalidate',
    );
    assert.equal(
        buildGenerationFingerprint(buildGenerationFingerprintInput(legacyUndefined)),
        baseFp,
        'undefined autoScope must hash identically to the default',
    );
    assert.notEqual(
        buildGenerationFingerprint(buildGenerationFingerprintInput(attached)),
        baseFp,
        'attached scope changes the fingerprint (old feeds are legitimately stale)',
    );
});

test('resolveAttachedLorebookSources lists char/chat/persona books with roles and trims', () => {
    const sources = resolveAttachedLorebookSources({
        characterId: 0,
        characters: [{ data: { extensions: { world: ' Char Book ' } } }],
        chatMetadata: { world_info: 'Chat Book' },
        powerUserSettings: { persona_description_lorebook: 'Persona Book' },
    });
    assert.deepEqual(sources, [
        { role: 'char', book: 'Char Book' },
        { role: 'chat', book: 'Chat Book' },
        { role: 'persona', book: 'Persona Book' },
    ]);
    assert.deepEqual([...resolveAttachedLorebooks({
        characterId: 0,
        characters: [{ data: { extensions: { world: ' Char Book ' } } }],
        chatMetadata: { world_info: 'Chat Book' },
        powerUserSettings: { persona_description_lorebook: 'Persona Book' },
    })], ['Char Book', 'Chat Book', 'Persona Book']);
});

test('resolveAttachedLorebookSources tolerates missing sources, blanks, and a broken ctx', () => {
    // One source only.
    assert.deepEqual(resolveAttachedLorebookSources({
        chatMetadata: { world_info: 'Only Chat' },
    }), [{ role: 'chat', book: 'Only Chat' }]);
    // Blank and non-string values are dropped; missing fields are fine.
    assert.deepEqual(resolveAttachedLorebookSources({
        characterId: 0,
        characters: [{ data: { extensions: { world: '   ' } } }],
        chatMetadata: {},
    }), []);
    assert.deepEqual(resolveAttachedLorebookSources(undefined), []);
    assert.deepEqual(resolveAttachedLorebookSources(null), []);
    assert.deepEqual(resolveAttachedLorebookSources({ characters: null }), []);
    // Same book bound twice: Set view deduplicates, sources keep both roles.
    const ctx = {
        characterId: 0,
        characters: [{ data: { extensions: { world: 'Same' } } }],
        chatMetadata: { world_info: 'Same' },
    };
    assert.deepEqual(resolveAttachedLorebookSources(ctx), [
        { role: 'char', book: 'Same' },
        { role: 'chat', book: 'Same' },
    ]);
    assert.deepEqual([...resolveAttachedLorebooks(ctx)], ['Same']);
});

test('collectAutomaticLore attached scope never calls getWorldInfoPrompt', async () => {
    state.lastActivatedWorldInfo = {
        chatId: 'chatA',
        msgId: '5',
        swipeIdx: 0,
        entries: [{ uid: 1, content: 'ATTACHED_LORE', world: 'Chat Book', comment: 'Attached', vectorized: false }],
        ts: Date.now(),
    };
    let scanCalls = 0;
    const ctx = {
        chatId: 'chatA',
        maxContext: 4096,
        getWorldInfoPrompt: async () => { scanCalls++; return { worldInfoString: 'MUST_NOT_APPEAR' }; },
        substituteParams: t => t,
        chatMetadata: { world_info: 'Chat Book' },
    };
    const result = await collectAutomaticLore(ctx, {
        chatMessages: [],
        globalScanData: {},
        anchorMsgId: '5',
        anchorSwipeIdx: 0,
        scope: LORE_SCOPE.ATTACHED,
    });
    assert.equal(scanCalls, 0, 'the dry-run scan is skipped entirely in attached scope');
    assert.equal(result.text, 'ATTACHED_LORE');
    // Provenance is reported (unlike the 'all' path) so the trace shows the source.
    assert.deepEqual(result.entries, [{ book: 'Chat Book', uid: 1, label: 'Attached' }]);
    assert.deepEqual(result.missing, []);
});

test('collectAutomaticLore attached scope filters cached entries to attached books', async () => {
    state.lastActivatedWorldInfo = {
        chatId: 'chatA',
        msgId: '5',
        swipeIdx: 0,
        entries: [
            { uid: 1, content: 'FROM_GLOBAL', world: 'Global Book', comment: '', vectorized: true },
            { uid: 2, content: 'FROM_CHAT', world: 'Chat Book', comment: '', vectorized: true },
            { uid: 3, content: 'NO_WORLD', world: '', comment: '', vectorized: true },
            { uid: 4, content: 'UNWORLDED', comment: '', vectorized: true },
            { uid: 5, content: 'FROM_PERSONA', world: 'Persona Book', comment: '', vectorized: true },
        ],
        ts: Date.now(),
    };
    const ctx = {
        chatId: 'chatA',
        chatMetadata: { world_info: 'Chat Book' },
        powerUserSettings: { persona_description_lorebook: 'Persona Book' },
        substituteParams: t => t,
    };
    const result = await collectAutomaticLore(ctx, {
        chatMessages: [],
        globalScanData: {},
        anchorMsgId: '5',
        anchorSwipeIdx: 0,
        scope: LORE_SCOPE.ATTACHED,
    });
    // Only chat/persona books pass; the global-panel book and unattributed
    // entries (empty or missing world) are excluded.
    assert.equal(result.text, 'FROM_CHAT\n\nFROM_PERSONA');
    assert.deepEqual(result.entries, [
        { book: 'Chat Book', uid: 2, label: 'Entry 2' },
        { book: 'Persona Book', uid: 5, label: 'Entry 5' },
    ]);
});

test('collectAutomaticLore attached scope applies substituteParams', async () => {
    state.lastActivatedWorldInfo = {
        chatId: 'chatA',
        msgId: '5',
        swipeIdx: 0,
        entries: [{ uid: 1, content: 'Hello {{user}}', world: 'Chat Book', comment: '', vectorized: true }],
        ts: Date.now(),
    };
    const ctx = {
        chatId: 'chatA',
        chatMetadata: { world_info: 'Chat Book' },
        substituteParams: text => text.replace('{{user}}', 'Alice'),
    };
    const result = await collectAutomaticLore(ctx, {
        chatMessages: [],
        globalScanData: {},
        anchorMsgId: '5',
        anchorSwipeIdx: 0,
        scope: LORE_SCOPE.ATTACHED,
    });
    assert.equal(result.text, 'Hello Alice');
});

test('collectAutomaticLore attached scope degrades to empty on cache miss or no attached books', async () => {
    const ctx = {
        chatId: 'chatA',
        chatMetadata: { world_info: 'Chat Book' },
        getWorldInfoPrompt: async () => { throw new Error('activation must not run'); },
    };
    // Anchor mismatch (regen of an older post) — empty, not an error.
    state.lastActivatedWorldInfo = {
        chatId: 'chatA',
        msgId: '3',
        swipeIdx: 0,
        entries: [{ uid: 1, content: 'OTHER_POST', world: 'Chat Book', comment: '', vectorized: true }],
        ts: Date.now(),
    };
    assert.deepEqual(await collectAutomaticLore(ctx, {
        chatMessages: [],
        globalScanData: {},
        anchorMsgId: '5',
        anchorSwipeIdx: 0,
        scope: LORE_SCOPE.ATTACHED,
    }), { text: '', entries: [], missing: [] });

    // No cache at all.
    state.lastActivatedWorldInfo = null;
    assert.deepEqual(await collectAutomaticLore(ctx, {
        chatMessages: [],
        globalScanData: {},
        anchorMsgId: '5',
        anchorSwipeIdx: 0,
        scope: LORE_SCOPE.ATTACHED,
    }), { text: '', entries: [], missing: [] });

    // Cache present but no books are attached to this chat.
    state.lastActivatedWorldInfo = {
        chatId: 'chatA',
        msgId: '5',
        swipeIdx: 0,
        entries: [{ uid: 1, content: 'SOMEWHERE', world: 'Chat Book', comment: '', vectorized: true }],
        ts: Date.now(),
    };
    assert.deepEqual(await collectAutomaticLore({
        chatId: 'chatA',
        getWorldInfoPrompt: async () => { throw new Error('activation must not run'); },
    }, {
        chatMessages: [],
        globalScanData: {},
        anchorMsgId: '5',
        anchorSwipeIdx: 0,
        scope: LORE_SCOPE.ATTACHED,
    }), { text: '', entries: [], missing: [] });
});
