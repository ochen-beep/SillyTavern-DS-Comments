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
import { makeRegenHandler } from '../src/ui/chrome.js';

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
