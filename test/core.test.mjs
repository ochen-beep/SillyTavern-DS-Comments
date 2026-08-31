// @ts-check
/**
 * DS Comments — core unit tests.
 *
 * Pure helpers from core.js, not tied to the ST runtime: hashHue, escapeHtml,
 * eligibility, buildPrompt, extractText, resolveSTMacro, message navigation
 * over ctx.chat, and loadSettings (apiSource migration / default
 * normalization).
 *
 * Context functions (getCtx-dependent) are mocked via resetCtx() from the stub:
 * tests mutate _stCtx.chat / .extensionSettings per case.
 */

import '../test-helpers/stub-runtime.mjs';
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import {
    defaultSettings, state, MODULE_NAME, NUMERIC_SETTINGS,
    hashHue, escapeHtml, extractText,
    isCommentaryDisplayEligible, isCommentaryGenerationEligible,
    aiPostIndices, resolveLastAIPost, getMessageSwipeIdx,
    buildPrompt, resolveSTMacro, loadSettings,
    notifyUser, observePersistence, persistSettingsNow, flushSettings, setApiKey, flushApiKey,
} from '../src/core.js';

// ── go
const ai = (mes, swipe_id = 0) => ({ mes, is_user: false, is_system: false, is_hidden: false, swipe_id });
const user = (mes) => ({ mes, is_user: true, is_system: false });
const hiddenAi = (mes) => ({ mes, is_user: false, is_system: false, is_hidden: true, swipe_id: 0 });

// ── pure helpers ──

test('defaultSettings is frozen and has expected shape', () => {
    assert.equal(Object.isFrozen(defaultSettings), true);
    assert.equal(defaultSettings.apiSource, 'profile');
    assert.equal(defaultSettings.userCount, 5);
    assert.equal(typeof defaultSettings.jailbreakText, 'string');
    assert.ok(defaultSettings.windowGeom && typeof defaultSettings.windowGeom.width === 'number');
});

test('defaultSettings excludes removed local token budget settings', () => {
    assert.equal('customMaxContext' in defaultSettings, false);
    assert.equal('customMaxTokens' in defaultSettings, false);
    assert.equal('customMaxContext' in NUMERIC_SETTINGS, false);
    assert.equal('customMaxTokens' in NUMERIC_SETTINGS, false);
});
test('hashHue: deterministic, in range [0,360), stable across calls', () => {
    const a = hashHue('neon_dreamer42');
    const b = hashHue('neon_dreamer42');
    assert.equal(a, b);
    assert.ok(a >= 0 && a < 360, `hue ${a} out of range`);
    assert.ok(Number.isInteger(a));
});

test('hashHue: empty / nullish input produces a number (no throw)', () => {
    assert.equal(typeof hashHue(''), 'number');
    assert.equal(typeof hashHue(null), 'number');
    assert.equal(typeof hashHue(undefined), 'number');
});

test('escapeHtml: maps the 5 XML entities, coerces null/undefined to ""', () => {
    assert.equal(escapeHtml('<b>&"\'</b>'), '&lt;b&gt;&amp;&quot;&#39;&lt;/b&gt;');
    assert.equal(escapeHtml(null), '');
    assert.equal(escapeHtml(undefined), '');
    assert.equal(escapeHtml(42), '42');
});

test('extractText: strips tags, collapses nested html to text', () => {
    assert.equal(extractText('<p>hello</p>').trim(), 'hello');
    assert.equal(extractText('<b>hi</b> there').trim(), 'hi there');
    assert.equal(extractText(''), '');
});

// ── eligibility ──

test('isCommentaryDisplayEligible: AI true, user/system/null false', () => {
    assert.equal(isCommentaryDisplayEligible(ai('x')), true);
    assert.equal(isCommentaryDisplayEligible(user('x')), false);
    assert.equal(isCommentaryDisplayEligible({ is_user: false, is_system: true }), false);
    assert.equal(isCommentaryDisplayEligible(null), false);
});

test('isCommentaryGenerationEligible: excludes hidden AI posts too', () => {
    assert.equal(isCommentaryGenerationEligible(ai('x')), true);
    assert.equal(isCommentaryGenerationEligible(hiddenAi('x')), false);
    assert.equal(isCommentaryGenerationEligible(user('x')), false);
});

// ── ctx.chat navigation ──

test('aiPostIndices: returns indices of display-eligible AI posts in order (hidden included)', () => {
    // aiPostIndices uses display-eligible (no is_hidden filter) — hidden AI
    // posts join the navigation list, unlike generation-eligible.
    globalThis._stCtx.chat = [user('u0'), ai('a1'), hiddenAi('h2'), ai('a3'), user('u4')];
    assert.deepEqual(aiPostIndices(), [1, 2, 3]);
});

test('resolveLastAIPost: last non-hidden AI post; swipe_id fallback 0; empty → null', () => {
    globalThis._stCtx.chat = [user('u0'), ai('a1', 2), hiddenAi('h2')];
    assert.deepEqual(resolveLastAIPost(), { msgId: '1', swipeIdx: 2 });

    globalThis._stCtx.chat = [{ is_user: false, is_system: false, is_hidden: false }]; // no swipe_id
    assert.deepEqual(resolveLastAIPost(), { msgId: '0', swipeIdx: 0 });

    globalThis._stCtx.chat = [];
    assert.equal(resolveLastAIPost(), null);
});

test('getMessageSwipeIdx: returns swipe_id or 0 fallback', () => {
    globalThis._stCtx.chat = [user('u0'), ai('a1', 3)];
    assert.equal(getMessageSwipeIdx('1'), 3);
    assert.equal(getMessageSwipeIdx('0'), 0);              // user msg, no swipe_id
    assert.equal(getMessageSwipeIdx('999'), 0);           // out of range
});

// ── buildPrompt / resolveSTMacro ──

test('buildPrompt: contract + vibe glued with \\n\\n, then {{count}} substituted', () => {
    const out = buildPrompt('vibe {{count}} here', { count: 5, contract: 'HEADER' });
    assert.equal(out, 'HEADER\n\nvibe 5 here');
});

test('buildPrompt: without contract (back-compat) — only vibe + count + macro passthrough', () => {
    const out = buildPrompt('just vibe {{count}}', { count: 3 });
    assert.equal(out, 'just vibe 3');
});

test('buildPrompt: count defaults to "" when undefined', () => {
    const out = buildPrompt('v={{count}}', {});
    assert.equal(out, 'v=');
});

test('buildPrompt: nullish vibe coerced to ""', () => {
    const out = buildPrompt(null, { count: 1, contract: 'H' });
    assert.equal(out, 'H\n\n');
});

test('resolveSTMacro: passes through ctx.substituteParams', () => {
    let captured = null;
    globalThis._stCtx.substituteParams = (t) => { captured = t; return t.toUpperCase(); };
    assert.equal(resolveSTMacro('hello'), 'HELLO');
    assert.equal(captured, 'hello');
    delete globalThis._stCtx.substituteParams;
});

test('resolveSTMacro: passthrough on missing substituteParams', () => {
    delete globalThis._stCtx.substituteParams;
    assert.equal(resolveSTMacro('plain'), 'plain');
});

// ── loadSettings (migration / default normalization) ──

beforeEach(() => {
    // state is a module singleton, mutated by loadSettings; reset between cases.
    state.settings = {};
    resetExtensionSettings();
});

function resetExtensionSettings() {
    globalThis._stCtx.extensionSettings = {};
}

test('loadSettings: defaults applied when no stored settings', async () => {
    await loadSettings();
    assert.equal(state.settings.enabled, false);
    assert.equal(state.settings.apiSource, 'profile');
    assert.equal(state.settings.userCount, 5);
});

test('loadSettings: stored values override defaults', async () => {
    globalThis._stCtx.extensionSettings[MODULE_NAME] = { userCount: 9, enabled: true };
    await loadSettings();
    assert.equal(state.settings.userCount, 9);
    assert.equal(state.settings.enabled, true);
    // fields not overwritten remain from defaults
    assert.equal(state.settings.apiSource, 'profile');
});

test('loadSettings: invalid apiSource migrated to default "profile" (legacy "main" removed)', async () => {
    globalThis._stCtx.extensionSettings[MODULE_NAME] = { apiSource: 'main' };
    await loadSettings();
    assert.equal(state.settings.apiSource, 'profile');
});

test('loadSettings removes legacy token settings without discarding unknown settings', async () => {
    let saves = 0;
    globalThis._stCtx.extensionSettings[MODULE_NAME] = {
        customMaxContext: 16_384,
        customMaxTokens: 1_024,
        futureSetting: { retained: true },
    };
    globalThis._stCtx.saveSettingsDebounced = () => { saves++; };

    await loadSettings();

    assert.equal('customMaxContext' in state.settings, false);
    assert.equal('customMaxTokens' in state.settings, false);
    assert.equal('customMaxContext' in globalThis._stCtx.extensionSettings[MODULE_NAME], false);
    assert.equal('customMaxTokens' in globalThis._stCtx.extensionSettings[MODULE_NAME], false);
    assert.deepEqual(globalThis._stCtx.extensionSettings[MODULE_NAME].futureSetting, { retained: true });
    assert.equal(saves, 1);
});
test('loadSettings: soundFiles / soundId defaulted when missing or falsy', async () => {
    globalThis._stCtx.extensionSettings[MODULE_NAME] = { soundId: '' };
    await loadSettings();
    assert.deepEqual(state.settings.soundFiles, {});
    assert.equal(state.settings.soundId, 'default');
});

test('loadSettings: insecureHttpOrigins keeps only unique valid non-loopback http origins', async () => {
    globalThis._stCtx.extensionSettings[MODULE_NAME] = {
        insecureHttpOrigins: [
            'http://lan.local:5000',
            'http://lan.local:5000',   // duplicate
            'https://secure.example.com', // wrong scheme
            'http://localhost:5000',   // loopback
            'http://127.0.0.1:5000',   // loopback
            'not-a-url',
        ],
    };
    await loadSettings();
    assert.deepEqual(state.settings.insecureHttpOrigins, ['http://lan.local:5000']);
});

test('loadSettings: numeric settings are normalized to bounded integers', async () => {
    globalThis._stCtx.extensionSettings[MODULE_NAME] = {
        userCount: 500,       // clamped to max 100
        fontSize: '12.9',      // truncated to 12
        contextDepth: 500,     // legacy max → clamped to 50
        soundVolume: -10,      // below min 0 → fallback 0
        unknownNumber: 42,     // not a numeric setting → left as-is
    };
    await loadSettings();
    assert.equal(state.settings.userCount, 100);
    assert.equal(state.settings.fontSize, 12);
    assert.equal(state.settings.contextDepth, 50);
    assert.equal(state.settings.soundVolume, 0);
    assert.equal(state.settings.unknownNumber, 42);
});

// ── persistence error infrastructure ──

test('notifyUser: calls toastr level safely and dedupes by key', () => {
    const calls = [];
    globalThis.toastr = { error: (msg, title) => calls.push([msg, title]) };
    assert.equal(notifyUser('error', 'msg1', 'key1'), true);
    assert.equal(notifyUser('error', 'msg1', 'key1'), false);
    assert.equal(notifyUser('error', 'msg2', 'key2'), true);
    assert.deepEqual(calls, [['msg1', 'DS Comments'], ['msg2', 'DS Comments']]);
    delete globalThis.toastr;
});

test('observePersistence: resolves true on success, false on rejection without unhandled rejection', async () => {
    const ok = await observePersistence(Promise.resolve('x'), 'op1', 'user msg');
    assert.equal(ok, true);

    const bad = await observePersistence(Promise.reject(new Error('boom')), 'op2', 'user msg');
    assert.equal(bad, false);
});

test('persistSettingsNow: flushes debounced save and rejects on strict failure', async () => {
    globalThis._stCtx.extensionSettings[MODULE_NAME] = { enabled: true };
    state.settings = { enabled: true };
    globalThis._stCtx.saveSettingsDebounced = Object.assign(() => {}, { flush: async () => 'flushed' });
    assert.equal(await persistSettingsNow('strict-op'), true);

    globalThis._stCtx.saveSettingsDebounced = Object.assign(() => {}, { flush: async () => { throw new Error('save failed'); } });
    await assert.rejects(() => persistSettingsNow('strict-op'), /strict-op persistence failed/);
});

test('persistSettingsNow: reports scheduled persistence when the debounce has no flush API', async () => {
    let scheduled = 0;
    globalThis._stCtx.extensionSettings[MODULE_NAME] = {};
    state.settings = { enabled: true };
    globalThis._stCtx.saveSettingsDebounced = () => { scheduled++; };

    assert.equal(await persistSettingsNow('strict-op'), false);
    assert.equal(scheduled, 1);
    assert.equal(globalThis._stCtx.extensionSettings[MODULE_NAME].enabled, true);
});

test('flushSettings: schedules persistence without claiming an unavailable debounce flush', () => {
    let scheduled = 0;
    globalThis._stCtx.extensionSettings[MODULE_NAME] = {};
    state.settings = { enabled: true };
    globalThis._stCtx.saveSettingsDebounced = () => { scheduled++; };

    assert.equal(flushSettings(), false);
    assert.equal(scheduled, 1);
    assert.equal(globalThis._stCtx.extensionSettings[MODULE_NAME].enabled, true);
});

test('setApiKey: reports localforage failure with a single notification', async () => {
    const toastrCalls = [];
    globalThis.toastr = { error: (msg, title) => toastrCalls.push([msg, title]) };
    globalThis.SillyTavern.libs.localforage.setItem = async () => { throw new Error('db full'); };
    setApiKey('secret');
    const flushResult = flushApiKey();
    assert.notEqual(flushResult, undefined);
    await flushResult;
    assert.equal(toastrCalls.length, 1);
    assert.equal(toastrCalls[0][0], 'Could not save the API key.');
    delete globalThis.toastr;
});