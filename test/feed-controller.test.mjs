// @ts-check
/**
 * DS Comments — feed controller unit tests.
 *
 * Verifies the single owner of the #dscFeed DOM state: deduplication,
 * scroll reset, safety when the element is absent, and all empty states.
 */

import '../test-helpers/stub-runtime.mjs';
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { state } from '../src/core.js';
import {
    createFeedController,
    initFeedController,
    showFeedEmpty,
    applyPendingFeedScrollReset,
} from '../src/ui/feed-controller.js';

let feed;
let generateCalls;

beforeEach(() => {
    state.settings = { enabled: true };
    state.generationInProgress = false;
    generateCalls = [];
    feed = {
        innerHTML: '',
        scrollTop: 42,
        _dscLastHtml: undefined,
        querySelector: (sel) => {
            if (sel === '#dscEmptyGenerate') {
                return feed._cta || null;
            }
            return null;
        },
    };
    feed._cta = {
        addEventListener: (ev, fn) => { feed._cta._listeners = feed._cta._listeners || []; feed._cta._listeners.push([ev, fn]); },
    };
});

function makeController() {
    return createFeedController({
        getFeedElement: () => feed,
        onGenerate: (...args) => generateCalls.push(args),
    });
}

test('showHtml with new HTML replaces content and resets scrollTop', () => {
    const c = makeController();
    assert.equal(c.showHtml('<p>hello</p>'), true);
    assert.equal(feed.innerHTML, '<p>hello</p>');
    assert.equal(feed.scrollTop, 0);
});

test('showHtml with same HTML preserves DOM identity and scrollTop', () => {
    const c = makeController();
    c.showHtml('<p>hello</p>');
    feed.scrollTop = 99;
    assert.equal(c.showHtml('<p>hello</p>'), false);
    assert.equal(feed.innerHTML, '<p>hello</p>');
    assert.equal(feed.scrollTop, 99);
});

test('showHtml with empty string renders empty-state CTA when enabled and not generating', () => {
    const c = makeController();
    assert.equal(c.showHtml(''), true);
    assert.ok(feed.innerHTML.includes('dscEmptyGenerate'));
    assert.equal(feed.scrollTop, 0);
    assert.equal(feed._cta._listeners.length, 1);
});

test('showEmpty renders CTA only when enabled and not generating', () => {
    const c = makeController();
    assert.equal(c.showEmpty(), true);
    assert.ok(feed.innerHTML.includes('dscEmptyGenerate'));

    state.settings.enabled = false;
    assert.equal(c.showEmpty(), true);
    assert.ok(!feed.innerHTML.includes('dscEmptyGenerate'));
    assert.ok(feed.innerHTML.includes('dsc_empty'));
});

test('showGenerating has no CTA and resets DOM', () => {
    const c = makeController();
    c.showHtml('<p>old</p>');
    assert.equal(c.showGenerating(), true);
    assert.ok(!feed.innerHTML.includes('dscEmptyGenerate'));
    assert.ok(feed.innerHTML.includes('dsc:generating'));
    assert.equal(feed.scrollTop, 0);
});

test('showDisabled has no generation CTA', () => {
    const c = makeController();
    assert.equal(c.showDisabled(), true);
    assert.ok(!feed.innerHTML.includes('dscEmptyGenerate'));
    assert.ok(feed.innerHTML.includes('dsc_empty'));
});

test('methods are safe when the feed element is absent', () => {
    const c = createFeedController({ getFeedElement: () => null });
    assert.equal(c.showHtml('<p>x</p>'), false);
    assert.equal(c.showEmpty(), false);
    assert.equal(c.showGenerating(), false);
    assert.equal(c.showDisabled(), false);
});

test('empty-state CTA uses generator registered after production controller creation', () => {
    const originalDocument = globalThis.document;
    let registeredClick;
    const productionFeed = {
        innerHTML: '',
        scrollTop: 42,
        _dscLastHtml: undefined,
        querySelector: (sel) => sel === '#dscEmptyGenerate'
            ? { addEventListener: (ev, fn) => { if (ev === 'click') registeredClick = fn; } }
            : null,
    };
    const calls = [];

    try {
        globalThis.document = {
            getElementById: (id) => id === 'dscFeed' ? productionFeed : null,
        };
        initFeedController({ generateFeed: (...args) => calls.push(args) });
        assert.equal(showFeedEmpty(), true);
        registeredClick();
        assert.deepEqual(calls, [[null, null, true]]);
    } finally {
        globalThis.document = originalDocument;
    }
});

test('empty state replaces cached comments after an empty-comments-empty transition', () => {
    const c = makeController();
    assert.equal(c.showEmpty(), true);
    assert.equal(c.showHtml('<p>comments</p>'), true);
    assert.equal(c.showEmpty(), true);
    assert.ok(feed.innerHTML.includes('dscEmptyGenerate'));
    assert.ok(!feed.innerHTML.includes('<p>comments</p>'));
});

test('same empty reason does not overwrite DOM', () => {
    const c = makeController();
    assert.equal(c.showEmpty(), true);
    feed.scrollTop = 77;
    assert.equal(c.showEmpty(), false);
    assert.equal(feed.scrollTop, 77);
});

// ── F1: re-sanitization of the feed HTML (XSS content-path) ──
// Cache (chatMetadata) and pinned feeds travel with exported chats, so a
// forged META_KEY must not execute on open. Every innerHTML write goes
// through core.js sanitize() (DOMPurify + media/link FORBID list).

test('F1: showHtml sanitizes injected <img onerror> — no <img in innerHTML', () => {
    const c = makeController();
    const payload = '<div>ok</div><img src="x" onerror="alert(1)"><span>tail</span>';
    assert.equal(c.showHtml(payload), true);
    assert.doesNotMatch(feed.innerHTML, /<img/i, 'img stripped by sanitize()');
    assert.match(feed.innerHTML, /ok/);
    assert.match(feed.innerHTML, /tail/);
});

test('F1: re-showing already-sanitized HTML is a no-op (dedup by sanitized form)', () => {
    const c = makeController();
    c.showHtml('<div>same</div>');
    feed.scrollTop = 55;
    // Same sanitized result → no DOM rebuild, scrollTop preserved.
    assert.equal(c.showHtml('<div>same</div>'), false);
    assert.equal(feed.scrollTop, 55);
});

test('F1: empty-state CTA survives sanitize (dscEmptyGenerate present)', () => {
    const c = makeController();
    assert.equal(c.showHtml(''), true);
    assert.ok(feed.innerHTML.includes('dscEmptyGenerate'),
        'empty-state CTA прошла sanitize без потерь');
});

// ── Deferred scroll reset (content swapped while the panel is hidden) ──
// CSSOM View: the scrollTop setter is a no-op while the element has no layout
// box (display:none), and Chromium restores the hide-time offset on reveal.
// replace() arms a pending reset; the panel reveal tail (ui/window.js) calls
// applyPendingFeedScrollReset() to land it after that restoration.

test('replace() while the feed has no layout box arms the pending scroll reset', () => {
    const c = createFeedController({
        getFeedElement: () => feed,
        onGenerate: () => {},
        isFeedRendered: () => false,   // panel hidden (display:none)
    });
    assert.equal(c.showHtml('<p>new</p>'), true);
    assert.equal(feed._dscPendingScrollReset, true);
});

test('replace() on a rendered feed does not arm the pending reset', () => {
    const c = createFeedController({
        getFeedElement: () => feed,
        onGenerate: () => {},
        isFeedRendered: () => true,    // panel visible
    });
    assert.equal(c.showHtml('<p>new</p>'), true);
    assert.equal(feed.scrollTop, 0);
    assert.notEqual(feed._dscPendingScrollReset, true);
});

test('dedup no-op never arms the pending reset (plain reopen keeps position)', () => {
    const c = createFeedController({
        getFeedElement: () => feed,
        onGenerate: () => {},
        isFeedRendered: () => false,
    });
    c.showHtml('<p>same</p>');
    feed._dscPendingScrollReset = false;   // simulate: reveal already consumed it
    assert.equal(c.showHtml('<p>same</p>'), false);
    assert.equal(feed._dscPendingScrollReset, false);
});

test('applyPendingFeedScrollReset consumes the flag, zeroes scrollTop, idempotent', () => {
    const originalDocument = globalThis.document;
    const liveFeed = {
        innerHTML: '<p>new gen</p>',
        scrollTop: 895,                    // Chromium-restored stale offset
        _dscLastHtml: '<p>new gen</p>',
        _dscPendingScrollReset: true,
    };
    try {
        globalThis.document = {
            getElementById: (id) => id === 'dscFeed' ? liveFeed : null,
        };
        applyPendingFeedScrollReset();
        assert.equal(liveFeed.scrollTop, 0);
        assert.equal(liveFeed._dscPendingScrollReset, false);
        // Second call is a no-op: the flag is gone, a later user scroll survives.
        liveFeed.scrollTop = 42;
        applyPendingFeedScrollReset();
        assert.equal(liveFeed.scrollTop, 42);
    } finally {
        globalThis.document = originalDocument;
    }
});
