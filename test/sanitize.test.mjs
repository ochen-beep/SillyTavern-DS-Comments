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
import { sanitize, escapeHtml } from '../src/core.js';

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

test('sanitize: forbidden <img> is stripped by the FORBID_TAGS stub', () => {
    // Fresh string (not cached by previous tests) — otherwise the cache returns.
    const html = `<div>pre</div><img src="x" onerror="alert(1)"><span>post</span>`;
    const out = sanitize(html);
    assert.match(out, /pre/);
    assert.match(out, /post/);
    assert.doesNotMatch(out, /<img/i, 'img stripped');
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