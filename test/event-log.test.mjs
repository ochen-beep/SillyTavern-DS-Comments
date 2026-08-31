// @ts-check
import '../test-helpers/stub-runtime.mjs';
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { LF_EVENTLOG } from '../src/core.js';
import {
    recordEvent, loadEventLog, flushEventLog, clearEventLog, dumpEventLog, _resetEventLog,
} from '../src/event-log.js';

function makeForage() {
    const store = new Map();
    return {
        store,
        getItem: async k => store.has(k) ? store.get(k) : null,
        setItem: async (k, v) => { store.set(k, v); },
        removeItem: async k => { store.delete(k); },
    };
}

const settle = () => new Promise(r => setTimeout(r, 0));
let forage;
beforeEach(() => {
    forage = makeForage();
    globalThis.SillyTavern.libs.localforage = forage;
    _resetEventLog();
});

test('loadEventLog merges persisted history with events recorded before load', async () => {
    forage.store.set(LF_EVENTLOG, ['old event']);
    recordEvent('log', 'current event');
    await loadEventLog();
    flushEventLog();
    await settle();

    const dump = dumpEventLog();
    assert.match(dump, /old event/);
    assert.match(dump, /current event/);
    assert.deepEqual(forage.store.get(LF_EVENTLOG), dump.split('\n'));
});

test('loadEventLog marks the log loaded when storage is empty', async () => {
    await loadEventLog();
    recordEvent('warn', 'after load');
    flushEventLog();
    await settle();
    assert.match(dumpEventLog(), /after load/);
    assert.ok(forage.store.get(LF_EVENTLOG)?.some(line => line.includes('after load')));
});

test('events include ISO timestamps, session ids, and safe truncation', async () => {
    await loadEventLog();
    recordEvent('warn', `line one\n${'x'.repeat(1400)}`);
    const line = dumpEventLog().split('\n').at(-1);
    assert.match(line, /^\d{4}-\d{2}-\d{2}T[^ ]+Z \[warn\] session=[^ ]+ /);
    assert.doesNotMatch(line, /\n/);
    assert.match(line, /…\(truncated\)$/);
});

test('event log exposes loaded state and rotates diagnostic session on reset', async () => {
    const { isEventLogLoaded, getDiagnosticSessionId } = await import('../src/event-log.js');
    assert.equal(isEventLogLoaded(), false);
    const before = getDiagnosticSessionId();
    await loadEventLog();
    assert.equal(isEventLogLoaded(), true);
    _resetEventLog();
    assert.equal(isEventLogLoaded(), false);
    assert.notEqual(getDiagnosticSessionId(), before);
});


test('clearEventLog cancels pending persistence and removes the record', async () => {
    await loadEventLog();
    recordEvent('log', 'should disappear');
    await clearEventLog();
    await settle();
    assert.equal(forage.store.has(LF_EVENTLOG), false);
    assert.equal(dumpEventLog(), '(события не зафиксированы)');
});

test('event log keeps only the newest 150 events', async () => {
    await loadEventLog();
    for (let i = 0; i < 180; i++) recordEvent('log', `event-${i}`);
    flushEventLog();
    await settle();
    const lines = forage.store.get(LF_EVENTLOG);
    assert.equal(lines.length, 150);
    assert.match(lines[0], /event-30/);
    assert.match(lines.at(-1), /event-179/);
});

// ── F5: clearEventLog vs in-flight writes ──

test('F5: recordEvent during clearEventLog does not resurrect the key', async () => {
    const order = [];
    forage.setItem = async (k, v) => { await new Promise(r => setTimeout(r, 10)); order.push('setItem'); forage.store.set(k, v); };
    forage.removeItem = async (k) => { order.push('removeItem'); forage.store.delete(k); };

    await loadEventLog();
    recordEvent('log', 'before clear');       // schedules a (stub-)immediate write
    const clearing = clearEventLog();
    // Event lands while the clear is waiting for the in-flight setItem —
    // it must be recorded in memory but NOT schedule a resurrection write.
    recordEvent('log', 'during clear');
    await clearing;
    await settle();

    assert.equal(forage.store.has(LF_EVENTLOG), false, 'key did not resurrect after clearing');
    assert.ok(order.includes('setItem') && order.includes('removeItem'), 'write played out to removeItem');
    assert.equal(order.indexOf('removeItem') > order.indexOf('setItem'), true, 'removeItem after setItem');
});
