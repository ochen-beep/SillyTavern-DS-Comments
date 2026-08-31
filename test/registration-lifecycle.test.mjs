// @ts-check
/**
 * DS Comments — permanent SillyTavern registration lifecycle tests.
 *
 * Slash commands and debug functions are registered once per page lifetime.
 * This module guards that contract against repeated registrations on
 * enable/disable cycles.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { createPermanentRegistrationController } from '../src/registration-lifecycle.js';

function makeSlashContext(opts = {}) {
    const calls = [];
    const ctx = {
        SlashCommandParser: {
            addCommandObject: (command) => {
                calls.push(command);
                if (opts.throw) throw new Error('addCommandObject boom');
            },
        },
        SlashCommand: {},
    };
    return { ctx, calls };
}

function makeDebugContext(opts = {}) {
    const calls = [];
    const definitions = [
        { id: 'a', name: 'A', description: 'desc A' },
        { id: 'b', name: 'B', description: 'desc B' },
        { id: 'c', name: 'C', description: 'desc C' },
        { id: 'd', name: 'D', description: 'desc D' },
    ];
    const ctx = {
        registerDebugFunction: (id, name, description) => {
            calls.push({ id, name, description });
            if (opts.fail?.includes(id)) throw new Error(`${id} boom`);
        },
    };
    return { ctx, calls, definitions };
}

test('slash registration succeeds once and is idempotent', () => {
    const { ctx, calls } = makeSlashContext();
    const controller = createPermanentRegistrationController({
        getContext: () => ctx,
        buildSlashCommand: (SlashCommand) => ({ name: 'dscomments', SlashCommand }),
        debugDefinitions: () => [],
        warn: () => {},
    });

    assert.equal(controller.ensureSlashCommandRegistered(), true);
    assert.equal(controller.ensureSlashCommandRegistered(), true);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].name, 'dscomments');
    assert.equal(controller.snapshot().slashRegistered, true);
});

test('missing slash API returns false and leaves guard unset; later retry succeeds', () => {
    let ctx = { SlashCommand: {} };
    const controller = createPermanentRegistrationController({
        getContext: () => ctx,
        buildSlashCommand: () => ({}),
        debugDefinitions: () => [],
        warn: () => {},
    });

    assert.equal(controller.ensureSlashCommandRegistered(), false);
    assert.equal(controller.snapshot().slashRegistered, false);

    ctx = makeSlashContext().ctx;
    // Need a fresh controller? No — we mutate getContext's return, simulating
    // late API availability. The original controller still sees the new ctx.
    assert.equal(controller.ensureSlashCommandRegistered(), true);
    assert.equal(controller.snapshot().slashRegistered, true);
});

test('thrown addCommandObject leaves the guard unset', () => {
    const { ctx, calls } = makeSlashContext({ throw: true });
    const warnings = [];
    const controller = createPermanentRegistrationController({
        getContext: () => ctx,
        buildSlashCommand: () => ({ name: 'dscomments' }),
        debugDefinitions: () => [],
        warn: (...a) => warnings.push(a),
    });

    assert.equal(controller.ensureSlashCommandRegistered(), false);
    assert.equal(calls.length, 1);
    assert.equal(controller.snapshot().slashRegistered, false);
    assert.ok(warnings.some(w => String(w).includes('Failed to register')));
});

test('four debug definitions register once', () => {
    const { ctx, calls, definitions } = makeDebugContext();
    const controller = createPermanentRegistrationController({
        getContext: () => ctx,
        buildSlashCommand: () => ({}),
        debugDefinitions: () => definitions,
        warn: () => {},
    });

    assert.equal(controller.ensureDebugFunctionsRegistered(), true);
    assert.equal(controller.ensureDebugFunctionsRegistered(), true);
    assert.equal(calls.length, 4);
    assert.deepEqual(calls.map(c => c.id), ['a', 'b', 'c', 'd']);
});

test('partial debug failure retries only failed definition and never appends names twice', () => {
    const { ctx, calls, definitions } = makeDebugContext({ fail: ['b'] });
    const warnings = [];
    const controller = createPermanentRegistrationController({
        getContext: () => ctx,
        buildSlashCommand: () => ({}),
        debugDefinitions: () => definitions,
        warn: (...a) => warnings.push(a),
    });

    assert.equal(controller.ensureDebugFunctionsRegistered(), false);
    assert.equal(calls.length, 4); // a ok, b throws, c ok, d ok
    assert.deepEqual(calls.map(c => c.id), ['a', 'b', 'c', 'd']);

    // Retry with b now succeeding.
    delete ctx.registerDebugFunction;
    const newCalls = [];
    const newCtx = {
        registerDebugFunction: (id, name, description) => {
            newCalls.push({ id, name, description });
        },
    };
    // Simulate the same context object mutating (common in tests).
    Object.assign(ctx, newCtx);

    assert.equal(controller.ensureDebugFunctionsRegistered(), true);
    assert.equal(newCalls.length, 1);
    assert.equal(newCalls[0].id, 'b');
    assert.deepEqual(
        new Set(controller.snapshot().registeredDebugNames),
        new Set(['a', 'b', 'c', 'd']),
    );
});

test('snapshot returns copies, not mutable internal collections', () => {
    const { ctx, definitions } = makeDebugContext();
    const controller = createPermanentRegistrationController({
        getContext: () => ctx,
        buildSlashCommand: () => ({}),
        debugDefinitions: () => definitions,
        warn: () => {},
    });
    controller.ensureDebugFunctionsRegistered();

    const snap = controller.snapshot();
    snap.registeredDebugNames.push('evil');
    assert.deepEqual(controller.snapshot().registeredDebugNames, ['a', 'b', 'c', 'd']);
});
