// @ts-check
/**
 * DS Comments — layering contract tests (style.css, static analysis).
 *
 * Locks two contracts:
 *   1. Layering: #dscWindow (2999) and its popovers/menus (3500) sit BELOW
 *      native SillyTavern popups (#dialogue_popup / #shadow_popup / .popup are
 *      z-index 9999 in ST's own style.css) — and the extension must NEVER
 *      override host popup stacking (a previous `z-index: 4000 !important`
 *      rule pushed native popups below ST's own 4001-4100 layers).
 *   2. Header scoping: the window chrome header is styled by #dscHeader; the
 *      per-message header by .dsc_message .dsc_header. Bare .dsc_header rules
 *      collided at equal specificity (code review P1-2) and must not return.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';

const stylePath = new URL('../style.css', import.meta.url);

test('preserves comments window layering contract', async () => {
    const css = await readFile(stylePath, 'utf8');

    const windowRule = css.match(/#dscWindow\s*\{([\s\S]*?)\n\}/);
    assert.ok(windowRule, '#dscWindow rule should exist');
    assert.match(windowRule[1], /z-index:\s*2999;/, '#dscWindow should remain at z-index 2999');
    assert.match(
        windowRule[1],
        /\/\*[^*]*host panels and modals above the comments window[^*]*\*\//,
        '#dscWindow should explain that host panels and modals remain above it',
    );

    for (const selector of ['.dsc_qs_menu', '.dsc_popover']) {
        const rule = css.match(new RegExp(`\\${selector}\\s*\\{([\\s\\S]*?)\\n\\}`));
        assert.ok(rule, `${selector} rule should exist`);
        assert.match(rule[1], /z-index:\s*3500;/, `${selector} should remain at z-index 3500`);
    }
});

test('extension must not override host popup stacking (P2-2 regression)', async () => {
    const css = await readFile(stylePath, 'utf8');
    assert.ok(!/\.popup,/.test(css), 'no global .popup/#dialogue_popup/#shadow_popup override may exist');
    assert.ok(!/z-index:\s*4000\s*!important/.test(css), 'no !important 4000 override above host layers');
});

test('no bare .dsc_header rules (P1-2 window-vs-message collision regression)', async () => {
    const css = await readFile(stylePath, 'utf8');
    assert.doesNotMatch(css, /(^|\n)\.dsc_header\s*\{/, 'bare .dsc_header { rule must not return');
    assert.match(css, /#dscHeader\s*\{[^}]*height:\s*var\(--dsc-header-h\)/, 'window header rule keeps its height');
    assert.match(css, /\.dsc_message \.dsc_header\s*\{/, 'message header rule is scoped to .dsc_message');
    assert.match(css, /#dscWindow\.dsc_mobile > \.dsc_header/, 'mobile rule targets the window chrome only (direct child)');
});
