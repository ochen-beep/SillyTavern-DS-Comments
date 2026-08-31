// @ts-check
/**
 * DS Comments — header regenerate handler regression tests.
 *
 * Locks the contract of makeRegenHandler():
 *   - it must NOT resolve the target itself (no currentPostId injection);
 *     the generator owns target resolution, so the button passes (null, null, true);
 *   - it must not throw when invoked (regression: a previous refactor left a
 *     bare getCtx() reference that was never imported, so the button silently
 *     did nothing — a ReferenceError inside a click handler is swallowed);
 *   - while a generation is in progress, the button aborts it instead of
 *     starting a second concurrent generation.
 */
import '../test-helpers/stub-runtime.mjs';
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { state } from '../src/core.js';
import { makeRegenHandler, setStatus } from '../src/ui/chrome.js';

let feedHtml;
beforeEach(() => {
    state.settings = { enabled: true };
    state.generationInProgress = false;
    state.abortController = null;
    state.currentPostId = '7';
    state.currentSwipeIdx = 3;
    feedHtml = 'previous feed';
    document.getElementById = (id) => id === 'dscFeed'
        ? {
            set innerHTML(v) { feedHtml = String(v ?? ''); },
            get innerHTML() { return feedHtml; },
            _dscLastHtml: '',
            scrollTop: 0,
            querySelector: () => null,
        }
        : null;
});

function stubOverlay() {
    let html = '';
    const overlay = {
        _classActive: false,
        set innerHTML(v) { html = String(v ?? ''); },
        get innerHTML() { return html; },
        classList: { remove() {}, toggle(_c, on) { overlay._classActive = !!on; } },
        querySelector: () => null,
    };
    const saved = document.getElementById;
    document.getElementById = (id) => (id === 'dscStatusOverlay' ? overlay : saved(id));
    return { overlay, restore: () => { document.getElementById = saved; }, get html() { return html; } };
}

test('regen delegates target resolution to the generator with a null target', () => {
    const calls = [];
    const handleRegen = makeRegenHandler((msgId, swipe, force) => {
        calls.push({ msgId, swipe, force });
        return Promise.resolve();
    });

    handleRegen();

    assert.equal(calls.length, 1, 'generateFeed must be called exactly once');
    assert.deepEqual(
        calls[0],
        { msgId: null, swipe: null, force: true },
        'the header button must NOT inject currentPostId — the generator resolves the target',
    );
});

test('regen does not throw (regression: undefined getCtx reference)', () => {
    const handleRegen = makeRegenHandler(() => Promise.resolve());
    assert.doesNotThrow(() => handleRegen());
});

test('regen while generating aborts the in-flight generation instead of starting another', () => {
    let aborted = false;
    state.generationInProgress = true;
    state.abortController = { abort() { aborted = true; } };
    const calls = [];
    const handleRegen = makeRegenHandler((...args) => { calls.push(args); return Promise.resolve(); });

    handleRegen();

    assert.equal(calls.length, 0, 'no second generation must be started');
    assert.equal(aborted, true, 'the in-flight generation must be aborted');
    assert.equal(state.abortController, null);
    assert.equal(state.generationInProgress, false);
});

test('setStatus escapes the message and the action label (innerHTML injection regression)', () => {
    const stub = stubOverlay();
    try {
        setStatus('<img src=x onerror=alert(1)>', { isAction: true, actionLabel: '<b>Cancel</b>' });
        assert.match(stub.html, /&lt;img src=x onerror=alert\(1\)&gt;/, 'message must be entity-escaped');
        assert.match(stub.html, /&lt;b&gt;Cancel&lt;\/b&gt;/, 'action label must be entity-escaped');
        assert.ok(!/<img/.test(stub.html) && !/<b>/.test(stub.html), 'no raw tags may reach the overlay');
    } finally {
        stub.restore();
    }
});

test('setStatus(\'\') hides the overlay and clears it', () => {
    const stub = stubOverlay();
    try {
        setStatus('');
        assert.equal(stub.overlay._classActive, false, 'active class removed');
        assert.equal(stub.html, '', 'overlay content cleared');
    } finally {
        stub.restore();
    }
});
