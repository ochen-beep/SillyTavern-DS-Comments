// @ts-check
/**
 * DS Comments — flat slash command builder tests.
 *
 * Regression (code review P0-1): the command was registered with a
 * `subcommands` array, which SillyTavern 1.18.0 does not support — the parser
 * invokes `command.callback(args, value)` directly and fromProps performs no
 * validation, so every `/dscomments …` input threw a TypeError at runtime.
 * The contract locked here:
 *   - the built command ALWAYS carries a callable callback and no dead
 *     `subcommands` property;
 *   - dispatch: first unnamed argument, case/whitespace-insensitive;
 *   - empty/missing argument defaults to 'toggle';
 *   - unknown action returns a message and calls no handler;
 *   - the unnamed-argument declaration is attached only when the ST surface
 *     provides SlashCommandArgument/ARGUMENT_TYPE (graceful degradation).
 */
import '../test-helpers/stub-runtime.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildDscommentsCommand } from '../src/slash-commands.js';

const passthrough = (props) => ({ ...props });
const ST_FULL = {
    SlashCommand: { fromProps: passthrough },
    SlashCommandArgument: { fromProps: passthrough },
    ARGUMENT_TYPE: { STRING: 'string' },
};

function makeHandlers() {
    const calls = [];
    return {
        calls,
        toggle: () => { calls.push('toggle'); return 't'; },
        regenerate: () => { calls.push('regenerate'); return 'r'; },
        clear: () => { calls.push('clear'); return 'c'; },
    };
}

test('registered command always has a callable callback (ST 1.18 subcommands regression)', () => {
    const cmd = buildDscommentsCommand(ST_FULL, makeHandlers());
    assert.equal(cmd.name, 'dscomments');
    assert.equal(typeof cmd.callback, 'function', 'a flat command MUST have a callback');
    assert.ok(!('subcommands' in cmd), 'no dead subcommands property may remain');
});

test('dispatch routes the first unnamed argument to its handler', () => {
    const h = makeHandlers();
    const cmd = buildDscommentsCommand(ST_FULL, h);
    assert.equal(cmd.callback({}, 'regenerate'), 'r');
    assert.equal(cmd.callback({}, 'clear'), 'c');
    assert.equal(cmd.callback({}, 'toggle'), 't');
    assert.deepEqual(h.calls, ['regenerate', 'clear', 'toggle']);
});

test('empty or missing argument defaults to toggle; case/whitespace insensitive', () => {
    const h = makeHandlers();
    const cmd = buildDscommentsCommand(ST_FULL, h);
    cmd.callback({}, '');
    cmd.callback({}, undefined);
    cmd.callback({}, '  TOGGLE  ');
    assert.deepEqual(h.calls, ['toggle', 'toggle', 'toggle']);
});

test('unknown action returns a message naming the action and calls no handler', () => {
    const h = makeHandlers();
    const cmd = buildDscommentsCommand(ST_FULL, h);
    const out = String(cmd.callback({}, 'bogus'));
    assert.match(out, /bogus/);
    assert.match(out, /toggle/);
    assert.deepEqual(h.calls, []);
});

test('unnamedArgumentList declares the enum when the ST surface provides it', () => {
    const cmd = buildDscommentsCommand(ST_FULL, makeHandlers());
    assert.equal(cmd.unnamedArgumentList.length, 1);
    assert.equal(cmd.unnamedArgumentList[0].typeList, 'string');
    assert.equal(cmd.unnamedArgumentList[0].defaultValue, 'toggle');
    assert.deepEqual(cmd.unnamedArgumentList[0].enumList, ['toggle', 'regenerate', 'clear']);
});

test('unnamedArgumentList is omitted on builds without SlashCommandArgument', () => {
    const cmd = buildDscommentsCommand({ SlashCommand: ST_FULL.SlashCommand }, makeHandlers());
    assert.equal(cmd.unnamedArgumentList, undefined);
    assert.equal(typeof cmd.callback, 'function');
});
