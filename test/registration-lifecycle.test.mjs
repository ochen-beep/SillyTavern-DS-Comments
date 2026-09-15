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
        buildSlashCommand: (st) => ({ name: 'dscomments', st }),
        debugDefinitions: () => [],
        warn: () => {},
    });

    assert.equal(controller.ensureSlashCommandRegistered(), true);
    assert.equal(controller.ensureSlashCommandRegistered(), true);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].name, 'dscomments');
    // The builder receives the full command surface object (Fix P0-1).
    assert.equal(calls[0].st.SlashCommand, ctx.SlashCommand);
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

test('debug callbacks present their result (console + toastr) and pass it through', async () => {
    const logs = [];
    const toasts = [];
    const origLog = console.log;
    console.log = (...a) => logs.push(a.map(x => String(x)).join(' '));
    globalThis.toastr = { info: (msg, title) => toasts.push({ msg, title }) };
    try {
        const definitions = [
            { id: 'dump', name: 'Dump', description: 'd', callback: () => ({ ok: true, message: 'RESTORE_LINE_1\nRESTORE_LINE_2' }) },
        ];
        let registered = null;
        const ctx = {
            registerDebugFunction: (id, name, description, fn) => { registered = { id, name, fn }; },
        };
        const controller = createPermanentRegistrationController({
            getContext: () => ctx,
            buildSlashCommand: () => ({}),
            debugDefinitions: () => definitions,
            warn: () => {},
        });
        controller.ensureDebugFunctionsRegistered();

        const result = await registered.fn();
        // ST's Debug Menu discards the return value — the wrapper must still
        // pass it through unchanged for any caller that does read it.
        assert.deepEqual(result, { ok: true, message: 'RESTORE_LINE_1\nRESTORE_LINE_2' });
        assert.ok(logs.some(l => l.includes('[DS Comments] Dump:') && l.includes('RESTORE_LINE_1')), 'console receives the full dump');
        assert.equal(toasts.length, 1, 'toastr preview is shown');
        assert.equal(toasts[0].title, 'Dump');
        assert.match(toasts[0].msg, /RESTORE_LINE_1/);
    } finally {
        console.log = origLog;
        delete globalThis.toastr;
    }
});

test('long debug results are truncated in the toastr preview only', async () => {
    const logs = [];
    const toasts = [];
    const origLog = console.log;
    console.log = (...a) => logs.push(a.map(x => String(x)).join(' '));
    globalThis.toastr = { info: (msg, title) => toasts.push({ msg, title }) };
    try {
        const longMessage = 'X'.repeat(1000);
        const definitions = [
            { id: 'big', name: 'Big', description: 'd', callback: () => ({ ok: true, message: longMessage }) },
        ];
        let registered = null;
        const ctx = { registerDebugFunction: (id, name, description, fn) => { registered = { fn }; } };
        const controller = createPermanentRegistrationController({
            getContext: () => ctx,
            buildSlashCommand: () => ({}),
            debugDefinitions: () => definitions,
            warn: () => {},
        });
        controller.ensureDebugFunctionsRegistered();

        const result = await registered.fn();
        assert.equal(result.message.length, 1000, 'full result is untouched');
        assert.ok(logs.some(l => l.length >= 1000), 'console receives the full text');
        assert.ok(toasts[0].msg.length < longMessage.length, 'toastr preview is truncated');
        assert.match(toasts[0].msg, /полный вывод в консоли/);
    } finally {
        console.log = origLog;
        delete globalThis.toastr;
    }
});
