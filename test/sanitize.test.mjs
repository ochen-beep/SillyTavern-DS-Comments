// @ts-check
/**
 * DS Comments — F12: sanitize() contract tests.
 *
 * core.js sanitize wraps SillyTavern.libs.DOMPurify with a fixed FORBID_TAGS
 * list and an LRU cache. Three contracts that were not covered before F12 are
 * checked here: (a) FORBID_TAGS reaches DOMPurify with the expected list;
 * (b) fail-closed — when the stub throws, the result equals escapeHtml and
 * the tag becomes text; (c) LRU cache — calling the same string again does
 * not hit the stub a second time. Real DOMPurify behavior is not modeled
 * (see the comment in stub-runtime.mjs) — the stub only approximates FORBID.
 */

import '../test-helpers/stub-runtime.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sanitize, escapeHtml, _resetPurifyForTest } from '../src/core.js';

// ── (a) FORBID_TAGS reaches DOMPurify with the expected list ──

test('sanitize: passes FORBID_TAGS with media/link tags to DOMPurify', () => {
    let capturedCfg = null;
    const original = globalThis.SillyTavern.libs.DOMPurify.sanitize;
    globalThis.SillyTavern.libs.DOMPurify.sanitize = (html, cfg) => {
        capturedCfg = cfg;
        return original(html, cfg);
    };
    try {
        sanitize('<div>ok</div>');
        assert.ok(capturedCfg, 'config passed to DOMPurify');
        assert.ok(Array.isArray(capturedCfg.FORBID_TAGS), 'FORBID_TAGS is an array');
        for (const tag of ['img', 'a', 'video', 'audio', 'source', 'iframe', 'object', 'embed']) {
            assert.ok(capturedCfg.FORBID_TAGS.includes(tag), `FORBID_TAGS includes ${tag}`);
        }
    } finally {
        globalThis.SillyTavern.libs.DOMPurify.sanitize = original;
    }
});

// ── (b) fail-closed: when the stub throws the result equals escapeHtml ──

test('sanitize: fail-closed returns escapeHtml when DOMPurify throws', () => {
    const html = `<img src=x onerror=alert(1)>`;
    const original = globalThis.SillyTavern.libs.DOMPurify.sanitize;
    globalThis.SillyTavern.libs.DOMPurify.sanitize = () => { throw new Error('boom'); };
    try {
        const out = sanitize(html);
        assert.equal(out, escapeHtml(html), 'on error HTML is escaped, not raw');
        assert.doesNotMatch(out, /<img/i, 'tag became text, not markup');
    } finally {
        globalThis.SillyTavern.libs.DOMPurify.sanitize = original;
    }
});

// ── (c) LRU cache: a repeated call with the same string does not hit the stub ──

test('sanitize: a repeated call with the same string takes the cached result', () => {
    const html = `<div>cache-probe-${Math.random()}</div>`;
    let calls = 0;
    const original = globalThis.SillyTavern.libs.DOMPurify.sanitize;
    globalThis.SillyTavern.libs.DOMPurify.sanitize = (h, cfg) => { calls++; return original(h, cfg); };
    try {
        const first = sanitize(html);
        const firstCalls = calls;
        assert.equal(firstCalls, 1, 'first call reached the stub');
        const second = sanitize(html);
        assert.equal(calls, firstCalls, 'second call did not hit the stub — taken from cache');
        assert.equal(second, first, 'result identical');
    } finally {
        globalThis.SillyTavern.libs.DOMPurify.sanitize = original;
    }
});
// ── hook isolation: the style hook must live on an ISOLATED DOMPurify ──
// Regression: the hook used to be registered on the shared SillyTavern.libs
// instance, whose hooks run for EVERY sanitize app-wide — chat message
// renders included — stripping the style attributes that message-coloring
// regexes emit (the live "regex breaks after any swipe" report).

test('sanitize: style hook goes to an isolated DOMPurify instance, not the shared one', async () => {
    const libs = globalThis.SillyTavern.libs;
    let sharedHooks = 0;
    const sharedSanitizeCalls = [];
    const shared = {
        sanitize(html, cfg) { sharedSanitizeCalls.push(html); return html; },
        addHook() { sharedHooks++; },
    };
    const factoryWins = [];
    const isolatedHooks = [];
    const isolated = {
        sanitize(html, cfg) {
            for (const h of isolatedHooks) h({ getAttribute: null, removeAttribute: null });
            return html;
        },
        addHook(type, fn) { isolatedHooks.push(fn); },
    };
    const factory = (win) => { factoryWins.push(win); return isolated; };

    libs.DOMPurify = factory;
    _resetPurifyForTest();
    try {
        sanitize('<div>isolation-probe</div>');
        assert.equal(factoryWins.length, 1, 'DOMPurify called as a factory exactly once');
        assert.equal(factoryWins[0], globalThis.window, 'factory received window');
        assert.equal(sharedHooks, 0, 'NO hook on the shared instance');
        assert.equal(isolatedHooks.length, 1, 'style hook registered on the isolated instance');
        assert.equal(sharedSanitizeCalls.length, 0, 'sanitize does not run on the shared instance');
        // second call reuses the isolated instance (no repeated factory calls)
        sanitize('<div>isolation-probe-2</div>');
        assert.equal(factoryWins.length, 1, 'isolated instance is cached');
    } finally {
        libs.DOMPurify = shared;
        _resetPurifyForTest();
    }
});
