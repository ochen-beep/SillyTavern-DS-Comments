// @ts-check
/**
 * DS Comments — generation-epoch guard unit tests.
 *
 * The epoch guard prevents a stale generation result (started in chat A,
 * completed after the user switched to chat B) from being rendered or stored.
 * ST's generateRaw/quietPrompt take no AbortSignal and don't auto-cancel on
 * chat switch, so the extension must invalidate by epoch itself.
 */
import '../test-helpers/stub-runtime.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { state, bumpGenerationEpoch, beginGenerationEpoch, isEpochCurrent } from '../src/core.js';
import { createInitializationController } from '../src/lifecycle.js';

test('initialization controller serializes starts and invalidates suspended work on stop', async () => {
    const firstGate = Promise.withResolvers();
    const secondGate = Promise.withResolvers();
    const calls = [];
    let runCount = 0;
    const controller = createInitializationController(async isCancelled => {
        const run = ++runCount;
        calls.push(['start', run]);
        await (run === 1 ? firstGate.promise : secondGate.promise);
        if (isCancelled()) return;
        calls.push(['commit', run]);
    });

    const firstRun = controller.start();
    assert.strictEqual(controller.start(), firstRun, 'overlapping starts share one run');
    controller.stop();
    controller.start();
    firstGate.resolve();
    await firstRun;
    assert.deepEqual(calls, [['start', 1], ['start', 2]]);

    secondGate.resolve();
    await controller.whenIdle();
    assert.deepEqual(calls, [['start', 1], ['start', 2], ['commit', 2]]);
});

test('state.generationEpoch starts at 0', () => {
    assert.equal(state.generationEpoch, 0);
});

test('bumpGenerationEpoch increments by exactly 1 each call', () => {
    const before = state.generationEpoch;
    bumpGenerationEpoch();
    assert.equal(state.generationEpoch, before + 1);
    bumpGenerationEpoch();
    assert.equal(state.generationEpoch, before + 2);
});

test('beginGenerationEpoch returns a snapshot token equal to current epoch', () => {
    state.generationEpoch = 0;
    bumpGenerationEpoch();           // now 1
    const token = beginGenerationEpoch();
    assert.equal(token, 1);
});

test('isEpochCurrent: true when token matches, false after a bump', () => {
    state.generationEpoch = 0;
    const token = beginGenerationEpoch();
    assert.equal(isEpochCurrent(token), true);
    bumpGenerationEpoch();
    assert.equal(isEpochCurrent(token), false);
});

test('isEpochCurrent: a fresh token taken after a bump is current again', () => {
    state.generationEpoch = 0;
    bumpGenerationEpoch();
    const token = beginGenerationEpoch();
    assert.equal(isEpochCurrent(token), true);
});
