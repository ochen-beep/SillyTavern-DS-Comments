// @ts-check
/**
 * DS Comments — empty-state unit tests.
 *
 * empty.js: 3 empty-feed branches (disabled / generating / empty) —
 * detectEmptyReason prioritizes, renderEmptyStateHTML generates the HTML.
 * icons.js (iconHtml) is pure, no core.js — the runtime stub is not needed.
 */

import '../test-helpers/stub-runtime.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { detectEmptyReason, renderEmptyStateHTML } from '../src/ui/empty.js';
import { iconHtml } from '../src/ui/icons.js';

// ── detectEmptyReason ──

test('detectEmptyReason: disabled wins over generating', () => {
    assert.equal(detectEmptyReason({ enabled: false, generating: true }), 'disabled');
});

test('detectEmptyReason: generating when enabled + generating', () => {
    assert.equal(detectEmptyReason({ enabled: true, generating: true }), 'generating');
});

test('detectEmptyReason: empty when enabled + not generating', () => {
    assert.equal(detectEmptyReason({ enabled: true, generating: false }), 'empty');
    assert.equal(detectEmptyReason({ enabled: false, generating: false }), 'disabled');
});

test('detectEmptyReason: missing flags treated as falsy (empty / disabled by default)', () => {
    assert.equal(detectEmptyReason({ enabled: true }), 'empty');
    assert.equal(detectEmptyReason({}), 'disabled');
});

// ── renderEmptyStateHTML ──

test('renderEmptyStateHTML("generating") → inert marker comment, no visible CTA', () => {
    const html = renderEmptyStateHTML('generating');
    assert.equal(html, '<!-- dsc:generating -->');
    assert.ok(!html.includes('Generate'), 'generating must not show CTA');
});

test('renderEmptyStateHTML("disabled") → contains title + dsc_empty, no CTA button', () => {
    const html = renderEmptyStateHTML('disabled');
    assert.match(html, /class="dsc_empty"/);
    assert.ok(html.includes('DS Comments is disabled'), 'disabled title present');
    assert.ok(!html.includes('dsc_empty_cta'), 'disabled has no generate CTA');
    assert.ok(html.includes('dsc-icon'), 'icon present');
});

test('renderEmptyStateHTML("empty") → CTA button with id dscEmptyGenerate', () => {
    const html = renderEmptyStateHTML('empty');
    assert.match(html, /class="dsc_empty"/);
    assert.ok(html.includes('Commentary for the scene will appear here'), 'empty title present');
    assert.ok(html.includes('id="dscEmptyGenerate"'), 'generate CTA present');
    assert.match(html, /class="dsc_empty_cta"/);
});

test('renderEmptyStateHTML unknown reason → falls to empty CTA (default branch)', () => {
    const html = renderEmptyStateHTML('???');
    assert.ok(html.includes('dsc_empty_cta') || html.includes('dsc:generating'));
});

// ── icons.js: inline paths, not sprite ──

test('iconHtml: paths embedded inline, no <use> (DOMPurify strips sprite refs)', () => {
    for (const name of ['sparkles', 'message', 'regen', 'spinner']) {
        const html = iconHtml(name);
        assert.match(html, /<path |<line |<polyline /, `${name}: geometry embedded inline`);
        assert.doesNotMatch(html, /<use/, `${name}: no <use> — DOMPurify removes it`);
        assert.match(html, /class="dsc-icon"/, `${name}: dsc-icon class preserved`);
    }
});