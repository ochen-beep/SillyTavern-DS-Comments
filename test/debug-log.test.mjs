// @ts-check
/**
 * DS Comments — debug log ring-buffer tests.
 *
 * Full debug log: interception of log/warn/error from core.js into the
 * ring-buffer when debugMode is on, buffer limit and clearing. Verifies that
 * with debugMode off nothing is written (the probe must not grind in normal mode).
 */

import '../test-helpers/stub-runtime.mjs';
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { state, log, warn, error, trace, dumpDebugLog, clearDebugLog } from '../src/core.js';

beforeEach(() => {
    clearDebugLog();
    state.settings.debugMode = true;
});

afterEach(() => {
    clearDebugLog();
    state.settings.debugMode = false;
});

// ── interception of log/warn/error ──

test('log() captured into debug buffer when debugMode on', () => {
    log('hello', 'world');
    const dump = dumpDebugLog();
    assert.ok(dump.includes('[log]'), 'level tag present');
    assert.ok(dump.includes('hello'), 'first arg present');
    assert.ok(dump.includes('world'), 'second arg present');
});

test('warn() and error() captured with correct level tags', () => {
    warn('careful');
    error('boom');
    const dump = dumpDebugLog();
    assert.ok(dump.includes('[warn] careful'));
    assert.ok(dump.includes('[error] boom'));
});

test('objects serialized into the buffer', () => {
    log('obj', { a: 1, b: ['x', 'y'] });
    const dump = dumpDebugLog();
    assert.ok(dump.includes('"a":1'), 'object serialized as JSON');
    assert.ok(dump.includes('"b":["x","y"]'));
});

test('Error objects serialized with name, message, stack', () => {
    const e = new Error('kaboom');
    log('caught', e);
    const dump = dumpDebugLog();
    assert.ok(dump.includes('Error: kaboom'), 'error name:message present');
    assert.ok(dump.includes('kaboom'), 'message present');
});

// ── off mode ──

test('nothing captured when debugMode off', () => {
    state.settings.debugMode = false;
    log('should', 'vanish');
    warn('also');
    error('gone');
    const dump = dumpDebugLog();
    assert.equal(dump, '(дебаг-лог пуст: Debug-режим выключен)');
    assert.ok(!dump.includes('should'));
});

// ── trace: ring-only, console stays silent ──

test('trace() captured into debug buffer when debugMode on', () => {
    trace('quiet', 'path');
    const dump = dumpDebugLog();
    assert.ok(dump.includes('[log]'), 'level tag present');
    assert.ok(dump.includes('quiet'), 'first arg present');
    assert.ok(dump.includes('path'), 'second arg present');
});

test('trace() writes nothing to the console', () => {
    const calls = [];
    const originalLog = console.log;
    console.log = (...args) => calls.push(args);
    try {
        trace('must', 'not', 'print');
    } finally {
        console.log = originalLog;
    }
    assert.equal(calls.length, 0);
});

test('trace() is a no-op when debugMode off', () => {
    state.settings.debugMode = false;
    trace('invisible');
    state.settings.debugMode = true;
    const dump = dumpDebugLog();
    assert.ok(!dump.includes('invisible'));
});

// ── ring-buffer limit ──

test('ring-buffer caps at 200 entries (oldest evicted)', () => {
    for (let i = 0; i < 250; i++) log(`line-${i}`);
    const dump = dumpDebugLog();
    const lines = dump.split('\n');
    assert.equal(lines.length, 200, 'buffer capped at 200');
    assert.ok(dump.includes('line-249'), 'newest entry present');
    assert.ok(!dump.includes('line-0'), 'oldest entry evicted');
    assert.ok(dump.includes('line-50'), 'entry within window present');
});

// ── clearing ──

test('clearDebugLog empties buffer', () => {
    log('before');
    clearDebugLog();
    assert.equal(dumpDebugLog(), '(дебаг-лог пуст — log/warn/error ещё не вызывались в этой сессии)');
});

// ── large object is truncated ──

test('oversized serialized arg truncated with marker', () => {
    const huge = 'x'.repeat(3000);
    log('big', { payload: huge });
    const dump = dumpDebugLog();
    assert.ok(dump.includes('truncated'), 'truncation marker present');
    assert.ok(!dump.includes('x'.repeat(3000)), 'full payload not in buffer');
});
