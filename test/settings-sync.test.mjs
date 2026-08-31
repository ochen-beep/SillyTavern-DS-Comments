// @ts-check
/**
 * DS Comments — settings-sync unit tests.
 *
 * syncPromptEditor stale-completion guard: when the user switches templates fast,
 * the async load of the first template must not overwrite the editor after the
 * second has already loaded.
 */
import '../test-helpers/stub-runtime.mjs';
import { test, beforeEach, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { state } from '../src/core.js';
import {
    FIELD_MAP,
    createSettingsLorebookLifecycle,
    syncPromptEditor,
    syncNumericInput,
    savePromptAs,
} from '../src/ui/settings-sync.js';

// Minimal DOM stub: record the last value written to the textarea.
function makeTextarea() {
    return { value: '', _dscLastHtml: '' };
}

beforeEach(() => {
    state.settings = { promptTemplate: 'main' };
    globalThis._stCtx.chat = [];
    let feedEl = { innerHTML: '', _dscLastHtml: '', scrollTop: 0 };
    // Shared mutable DOM map.
    const els = {
        dsc_template: { value: '', innerHTML: '', options: [],
            appendChild(o){this.options.push(o);}, set _v(x){this.value=x;}, get _v(){return this.value;} },
        dsc_template_text: makeTextarea(),
        dsc_template_contract: { textContent: '' },
        dsc_template_del: { hidden: false, disabled: false },
        dsc_template_reset: { hidden: false, disabled: false },
    };
    // Options created by syncPromptEditor need a textContent setter.
    const origCreateElement = globalThis.document.createElement;
    globalThis.document.createElement = (tag) => {
        const el = origCreateElement(tag);
        let _text = '';
        Object.defineProperty(el, 'textContent', {
            get() { return _text; },
            set(v) { _text = String(v ?? ''); },
            configurable: true,
        });
        return el;
    };
    globalThis.document.getElementById = (id) => els[id] ?? null;
    globalThis._els = els;
});

test('settings template contains the static lore skeleton and no legacy picker root', async () => {
    const html = await readFile(new URL('../settings.html', import.meta.url), 'utf8');

    assert.equal(Object.hasOwn(FIELD_MAP, 'dsc_wi'), false);
    assert.doesNotMatch(html, /id=["']dsc_wi["']/);
    assert.doesNotMatch(html, /id=["']dsc_lorebook_context["']/);
    assert.match(html, /id=["']dsc_lore_enable["']/);
    assert.match(html, /id=["']dsc_lore_mode_auto["']/);
    assert.match(html, /id=["']dsc_lore_mode_manual["']/);
    assert.doesNotMatch(html, /id=["']dsc_lore_picker["']/);
});

test('lorebook lifecycle mounts once and initializes from the current chat', async () => {
    const calls = [];
    const picker = {
        setConfig: config => calls.push(['setConfig', config]),
        refresh: async () => calls.push(['refresh']),
        destroy: () => calls.push(['destroy']),
    };
    const ctx = { chatId: 'chat-a' };
    const lifecycle = createSettingsLorebookLifecycle({
        createPicker: options => { calls.push(['create', options.root]); return picker; },
        getContext: () => ctx,
        readConfig: value => ({ mode: 'manual', chatId: value.chatId }),
        persistConfig: () => {},
        invalidate: () => {},
        getState: () => ({}),
    });
    const root = {};

    await lifecycle.mount(root);
    await lifecycle.mount(root);

    assert.deepEqual(calls, [
        ['create', root],
        ['setConfig', { mode: 'manual', chatId: 'chat-a' }],
        ['refresh'],
    ]);
});

test('lorebook onChange invalidates, aborts, and persists per-chat without global save', async () => {
    const calls = [];
    const abortController = { abort: () => calls.push('abort') };
    const lifecycleState = {
        abortController,
        generationInProgress: true,
        generationOwner: Symbol('old-generation'),
    };
    let pickerOptions;
    const lifecycle = createSettingsLorebookLifecycle({
        createPicker: options => {
            pickerOptions = options;
            return { setConfig() {}, async refresh() {}, destroy() {} };
        },
        getContext: () => ({ chatId: 'chat-a' }),
        readConfig: () => ({ mode: 'automatic', selectedEntries: [] }),
        persistConfig: (config, ctx) => calls.push(['persist', config, ctx.chatId]),
        invalidate: () => calls.push('invalidate'),
        getState: () => lifecycleState,
    });
    await lifecycle.mount({});

    const config = { mode: 'manual', selectedEntries: [{ book: 'Main', uid: 2 }] };
    pickerOptions.onChange(config);

    assert.deepEqual(calls, [
        'invalidate',
        'abort',
        ['persist', config, 'chat-a'],
    ]);
    assert.equal(lifecycleState.generationInProgress, false);
    assert.equal(lifecycleState.generationOwner, null);
    assert.equal(lifecycleState.abortController, null);
});

test('lorebook refresh reads the new chat config and teardown permits a clean remount', async () => {
    const calls = [];
    let ctx = { chatId: 'chat-a' };
    let pickerNumber = 0;
    const lifecycle = createSettingsLorebookLifecycle({
        createPicker: () => {
            const number = ++pickerNumber;
            return {
                setConfig: config => calls.push(['setConfig', number, config.chatId]),
                refresh: async () => calls.push(['refresh', number]),
                destroy: () => calls.push(['destroy', number]),
            };
        },
        getContext: () => ctx,
        readConfig: value => ({ chatId: value.chatId }),
        persistConfig: () => {},
        invalidate: () => {},
        getState: () => ({}),
    });

    await lifecycle.mount({});
    ctx = { chatId: 'chat-b' };
    await lifecycle.refresh();
    lifecycle.destroy();
    await lifecycle.mount({});

    assert.deepEqual(calls, [
        ['setConfig', 1, 'chat-a'], ['refresh', 1],
        ['setConfig', 1, 'chat-b'], ['refresh', 1],
        ['destroy', 1],
        ['setConfig', 2, 'chat-b'], ['refresh', 2],
    ]);
});

test('syncPromptEditor: a stale (older) template load does NOT overwrite the textarea', async () => {
    // Template A resolves slowly, B fast. Switch A→B before A resolves.
    let resolveA;
    let aStarted = false;
    globalThis.SillyTavern.libs.localforage.getItem = async () => {
        // The first getItem of the first syncPromptEditor call is held;
        // every later call (including the whole second syncPromptEditor) resolves fast.
        if (!aStarted) {
            aStarted = true;
            return new Promise((res) => { resolveA = res; });
        }
        return { main: 'A_TEXT', A: 'A_TEXT', B: 'B_TEXT' };
    };
    // Make the first call slow and the second fast by ordering: we call
    // syncPromptEditor twice with different templates and resolve A in between.
    state.settings.promptTemplate = 'A';
    const p1 = syncPromptEditor();
    state.settings.promptTemplate = 'B';
    const p2 = syncPromptEditor();
    await p2;                 // B wins first
    assert.equal(globalThis._els.dsc_template_text.value, 'B_TEXT');
    resolveA({ main: 'A_TEXT', A: 'A_TEXT', B: 'B_TEXT' });   // A finally resolves
    await p1;
    // B must still be showing — A is stale.
    assert.equal(globalThis._els.dsc_template_text.value, 'B_TEXT',
        'stale template A must not overwrite the currently-shown template B');
});

describe('savePromptAs: builtin name is reserved (H-N2)', () => {
    let setItemCalls;
    beforeEach(() => {
        setItemCalls = [];
        globalThis.SillyTavern.libs.localforage.getItem = async () => ({});
        globalThis.SillyTavern.libs.localforage.setItem = async (k, v) => { setItemCalls.push([k, v]); };
        state.settings.promptTemplate = 'main';
    });

    test("rejects 'main' without writing to localforage", async () => {
        const ok = await savePromptAs('main', 'overriding content');
        assert.equal(ok, false, 'builtin name must be rejected');
        assert.equal(setItemCalls.length, 0, 'no localforage write when name is reserved');
        assert.equal(state.settings.promptTemplate, 'main', 'active template unchanged');
    });

    test('accepts a non-builtin name and persists it', async () => {
        const ok = await savePromptAs('my-vibe', 'content');
        assert.equal(ok, true);
        assert.equal(setItemCalls.length, 1, 'user template written to localforage');
        assert.equal(state.settings.promptTemplate, 'my-vibe');
    });
});

describe('syncNumericInput', () => {
    beforeEach(() => {
        state.settings = {};
        globalThis._numericEls = {};
        globalThis.document.getElementById = (id) => globalThis._numericEls[id] ?? null;
    });

    function makeInput(id, value) {
        let _v = String(value);
        const el = {
            id,
            get value() { return _v; },
            set value(v) { _v = String(v); },
            style: {},
        };
        globalThis._numericEls[id] = el;
        return el;
    }

    test('clamps count, depth and fontSize and writes back to the element', () => {
        const countEl = makeInput('dsc_count', '999');
        const depthEl = makeInput('dsc_depth', '-5');
        const fontEl = makeInput('dsc_fontsize', '7.9');
        globalThis._numericEls.dscWindow = { style: { setProperty(k, v) { this[k] = v; } } };

        assert.equal(syncNumericInput(countEl), 100);
        assert.equal(syncNumericInput(depthEl), 2);
        assert.equal(syncNumericInput(fontEl), 8);

        assert.equal(state.settings.userCount, 100);
        assert.equal(state.settings.contextDepth, 2);
        assert.equal(state.settings.fontSize, 8);

        assert.equal(countEl.value, '100');
        assert.equal(depthEl.value, '2');
        assert.equal(fontEl.value, '8');
    });

    test('updates sound volume label and clamps to [0,100]', () => {
        const volEl = makeInput('dsc_sound_volume', '150');
        const lbl = { textContent: '' };
        globalThis._numericEls.dsc_sound_volume_val = lbl;

        assert.equal(syncNumericInput(volEl), 100);
        assert.equal(state.settings.soundVolume, 100);
        assert.equal(volEl.value, '100');
        assert.equal(lbl.textContent, '100%');
    });

    test('falls back to policy default for empty/non-numeric input', () => {
        const countEl = makeInput('dsc_count', '');
        assert.equal(syncNumericInput(countEl), 5);
        assert.equal(state.settings.userCount, 5);
        assert.equal(countEl.value, '5');
    });

    test('ignores non-numeric and unknown fields', () => {
        const textEl = makeInput('dsc_endpoint', 'http://example.com');
        assert.equal(syncNumericInput(textEl), null);
        assert.equal(state.settings.customEndpoint, undefined);

        const unknownEl = { id: 'dsc_unknown', value: '10' };
        assert.equal(syncNumericInput(unknownEl), null);
    });
});

// ── F11: populateProfiles stale-completion guard ──
// Rapid refreshes fire several calls; the first async load must not overwrite
// the select after a newer call has already rendered. Profiles come from
// ctx.extensionSettings.connectionManager.profiles (connection.js _getCMProfiles).
// The guard is the monotonic _profilesReq token checked after every await.

describe('F11: populateProfiles stale-completion guard', () => {
    let _origGetElementById;
    let _profileSelect;

    function installProfileSelect() {
        _profileSelect = {
            innerHTML: '',
            title: '',
            options: [],
            appendChild(o) { this.options.push(o); },
        };
        _origGetElementById = globalThis.document.getElementById;
        globalThis.document.getElementById = (id) =>
            id === 'dsc_profile' ? _profileSelect : _origGetElementById(id);
    }

    function setProfiles(list) {
        globalThis._stCtx.extensionSettings.connectionManager = { profiles: list };
    }

    beforeEach(() => {
        setProfiles([]);
        state.settings = { profileId: '' };
        installProfileSelect();
    });

    test('a stale first refresh does not overwrite the select after a newer second refresh', async () => {
        const { populateProfiles } = await import('../src/ui/settings-sync.js');
        // First refresh: one profile. We let it start but NOT await it yet.
        setProfiles([{ id: 'p1', name: 'Stale One', api: 'openai', model: 'gpt-slow' }]);
        const stale = populateProfiles();
        // Second refresh supersedes it: a different batch, different selection.
        setProfiles([
            { id: 'a', name: 'Alpha', api: 'openai', model: 'gpt-a' },
            { id: 'b', name: 'Beta', api: 'koboldcpp', model: 'kobold-b' },
        ]);
        state.settings.profileId = 'a';
        const fresh = populateProfiles();
        await Promise.all([stale, fresh]);

        // The select must reflect the SECOND (non-stale) batch only.
        const values = _profileSelect.options.map(o => o.value).filter(Boolean);
        assert.deepEqual(values.sort(), ['a', 'b'],
            `select has the second batch; got [${values.join(',')}]`);
        const labels = _profileSelect.options.map(o => o.textContent).filter(t => t && !t.includes('Выберите'));
        assert.ok(labels.some(l => l.includes('Alpha')), 'Alpha present');
        assert.ok(!labels.some(l => l.includes('Stale One')),
            'stale first-batch profile did NOT overwrite the select');
    });
});
