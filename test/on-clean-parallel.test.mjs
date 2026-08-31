// @ts-check
/**
 * DS Comments — onClean parallel removal tests (spec F1).
 *
 * Verifies onClean removes localforage keys via Promise.allSettled (parallel),
 * not a sequenced `await removeItem` loop. ST's callExtensionHook races every
 * hook against HOOK_TIMEOUT=5000; sequenced removal of many custom sounds can
 * exceed that on slow devices.
 */

import {
    install, uninstall,
} from '../test-helpers/lifecycle-runtime.mjs';
import { beforeEach, afterEach, test } from 'node:test';
import assert from 'node:assert/strict';

let indexModule;

beforeEach(async () => {
    install();
    // Dynamic import AFTER install() so index.js and its deps capture the
    // lifecycle-runtime fakes (window/document/observers), matching the
    // window-lifecycle test pattern.
    indexModule = await import('../index.js');
});

afterEach(() => {
    uninstall();
});

/**
 * Instrument localforage so the first TARGET key's removeItem blocks until
 * `release()` is called, while others resolve immediately. In a parallel
 * Promise.allSettled, all target removeItem calls fire synchronously in the
 * .map() before any resolves - so removeCalls fills to N even while the
 * blocker is pending. In a sequenced `for-await` loop, the 2nd call only
 * fires after the 1st resolves - so removeCalls stays at 1 while blocked.
 */
function installBlockingLocalforage(targetKeys, nonTargetKey) {
    const removeCalls = [];
    const blockers = new Map();   // key -> resolve fn
    let releaseFns = [];
    // Store-backed: keys() reflects prior removeItem calls, like real IndexedDB.
    // This matters because onClean now deletes DSComments_pinned via clearAllFeeds
    // (clearPinnedPersist) BEFORE the keys() scan, so it must drop out of the
    // subsequent filter — otherwise the same key would be removed twice.
    const store = new Map();
    for (const k of [...targetKeys, nonTargetKey]) store.set(k, true);
    globalThis.SillyTavern.libs.localforage = {
        keys: async () => Array.from(store.keys()),
        removeItem: async (k) => {
            removeCalls.push(k);
            store.delete(k);
            if (targetKeys.indexOf(k) === 0) {
                // First target blocks until released.
                return new Promise(resolve => { releaseFns.push(resolve); });
            }
            // Others resolve on the next microtask.
        },
        getItem: async () => null,
        setItem: async () => {},
    };
    const release = () => { for (const r of releaseFns) r(); releaseFns = []; };
    return { removeCalls, release };
}

/** Flush the microtask queue enough turns for `await keys()` + filter + allSettled map to run. */
async function flushMicrotasks(n = 20) {
    for (let i = 0; i < n; i++) await Promise.resolve();
}

test('onClean removes all DS Comments localforage keys in parallel (not sequenced)', async () => {
    const targets = ['DSComments_prompts', 'DSComments_apiKey', 'DSComments_pinned', 'DSComments_eventlog', 'DSComments_sound_a', 'DSComments_sound_b'];
    const nonTarget = 'some_other_extension_key';
    const { removeCalls, release } = installBlockingLocalforage(targets, nonTarget);

    const done = indexModule.onClean();
    // Let keys() resolve, filter run, and Promise.allSettled's .map() fire all
    // removeItem calls synchronously. The first target is still blocked.
    await flushMicrotasks();

    // Parallel proof: even though the first target's removeItem is blocked,
    // all four target removeItem calls have already been issued. A sequenced
    // loop would still be stuck at 1.
    assert.equal(removeCalls.length, targets.length,
        `all ${targets.length} target removeItem calls fired in parallel (got ${removeCalls.length})`);
    for (const k of targets) {
        assert.ok(removeCalls.includes(k), `target ${k} was removed`);
    }
    assert.ok(!removeCalls.includes(nonTarget), 'non-target key was NOT removed');

    // Release the blocker and let onClean finish.
    release();
    await done;
});

test('onClean completes and removes keys even when one removeItem rejects', async () => {
    const targets = ['DSComments_prompts', 'DSComments_apiKey', 'DSComments_pinned', 'DSComments_eventlog', 'DSComments_sound_a'];
    const nonTarget = 'other_key';
    const removeCalls = [];
    globalThis.SillyTavern.libs.localforage = {
        keys: async () => [...targets, nonTarget],
        removeItem: async (k) => {
            removeCalls.push(k);
            if (k === 'DSComments_apiKey') throw new Error('IndexedDB locked');
        },
        getItem: async () => null,
        setItem: async () => {},
    };

    // allSettled: one rejection must not abort the others or throw out of onClean.
    await indexModule.onClean();

    for (const k of targets) {
        assert.ok(removeCalls.includes(k), `target ${k} was still attempted (allSettled)`);
    }
    assert.ok(!removeCalls.includes(nonTarget), 'non-target key untouched');
});
