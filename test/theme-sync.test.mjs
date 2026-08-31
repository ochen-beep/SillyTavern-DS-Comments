// @ts-check
/**
 * DS Comments — theme-sync tests.
 *
 * Covers the pure color helpers that derive opaque, theme-aware backgrounds
 * from SillyTavern's translucent `--SmartThemeBlurTintColor`. The DOM observer
 * (initThemeSync/teardown) is intentionally not unit-tested — it's thin glue
 * over MutationObserver + getComputedStyle, validated by the CSS contract test
 * and manual theme-switch checks.
 *
 * Regression target: on browsers without CSS relative-color support (Firefox
 * < 133, older Electron), the window could become see-through on transparent
 * themes. computeTokens must ALWAYS return an opaque background (no alpha) and
 * keep the window readable on every theme.
 */

import '../test-helpers/stub-runtime.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { _testThemeSync } from '../src/ui/theme-sync.js';

const { parseRgba, toOpaque, luminance, computeTokens } = _testThemeSync;

// ── parseRgba ──

test('parseRgba parses rgba() with alpha', () => {
    assert.deepEqual(parseRgba('rgba(20, 20, 25, 0.88)'), { r: 20, g: 20, b: 25, a: 0.88 });
});

test('parseRgba parses rgba() with spaces and decimals', () => {
    assert.deepEqual(parseRgba('rgba( 10 , 20 , 30 , 1 )'), { r: 10, g: 20, b: 30, a: 1 });
});

test('parseRgba treats rgb() as fully opaque', () => {
    assert.deepEqual(parseRgba('rgb(10, 20, 30)'), { r: 10, g: 20, b: 30, a: 1 });
});

test('parseRgba returns null for hex, named colors, and garbage', () => {
    assert.equal(parseRgba('#ffffff'), null);
    assert.equal(parseRgba('white'), null);
    assert.equal(parseRgba('garbage'), null);
    assert.equal(parseRgba(''), null);
    assert.equal(parseRgba(null), null);
    assert.equal(parseRgba(undefined), null);
});

test('parseRgba returns null for non-finite channels', () => {
    assert.equal(parseRgba('rgba(abc, 20, 30, 1)'), null);
});

// ── toOpaque ──

test('toOpaque drops alpha and rounds channels', () => {
    assert.equal(toOpaque({ r: 20.4, g: 20.6, b: 25 }), 'rgb(20 21 25)');
    // No alpha component present in output, ever.
    assert.doesNotMatch(toOpaque({ r: 0, g: 0, b: 0 }), /alpha|,/i);
});

// ── luminance (sanity: white > black, used for light/dark classification) ──

test('luminance ranks white above black', () => {
    assert.ok(luminance({ r: 255, g: 255, b: 255 }) > luminance({ r: 0, g: 0, b: 0 }));
    assert.ok(luminance({ r: 255, g: 255, b: 255 }) > 0.99);
    assert.ok(luminance({ r: 0, g: 0, b: 0 }) < 0.01);
});

// ── computeTokens: the core regression ──

test('computeTokens forces opaque background from a translucent dark tint', () => {
    // Transparent dark theme: alpha ~0 used to make the window see-through.
    const { bg } = computeTokens('rgba(20, 20, 25, 0.0)', 'rgba(220, 221, 222, 1)');
    assert.equal(bg, 'rgb(20 20 25)', 'alpha stripped, hue kept');
    assert.doesNotMatch(bg, /,\s*[\d.]+\)/, 'no rgba() alpha tail');
});

test('computeTokens keeps a normal dark tint opaque', () => {
    const { bg, colorScheme } = computeTokens('rgba(30, 30, 40, 0.5)', 'rgba(220, 221, 222, 1)');
    assert.equal(bg, 'rgb(30 30 40)');
    assert.equal(colorScheme, 'dark');
});

test('computeTokens keeps a light tint opaque on a light theme', () => {
    const { bg, colorScheme } = computeTokens('rgba(240, 240, 244, 0.3)', 'rgba(40, 40, 45, 1)');
    assert.equal(bg, 'rgb(240 240 244)');
    assert.equal(colorScheme, 'light');
});

test('computeTokens corrects transparent-black tint on a light theme', () => {
    // Edge case: a light theme (dark body text) sets a near-black transparent
    // tint as a "no-blur" placeholder. Keeping the hue would paint a black
    // window behind dark text → unreadable. Must invert to a light surface.
    const { bg, colorScheme } = computeTokens('rgba(0, 0, 0, 0)', 'rgba(40, 40, 45, 1)');
    assert.equal(bg, 'rgb(240 240 244)', 'near-black tint on light theme is inverted to light');
    assert.equal(colorScheme, 'light');
});

test('computeTokens overlay is darker than window bg on dark themes, equal on light', () => {
    const dark = computeTokens('rgba(30, 30, 40, 0.5)', 'rgba(220, 221, 222, 1)');
    assert.notEqual(dark.bg, dark.overlayBg, 'overlay darkened on dark theme');

    const light = computeTokens('rgba(240, 240, 244, 0.3)', 'rgba(40, 40, 45, 1)');
    assert.equal(light.bg, light.overlayBg, 'overlay equals window on light theme');
});

test('computeTokens overlay is always opaque', () => {
    for (const tint of ['rgba(0,0,0,0)', 'rgba(30,30,40,0.5)', 'rgba(240,240,244,0.3)']) {
        const { overlayBg } = computeTokens(tint, 'rgba(220,221,222,1)');
        assert.match(overlayBg, /^rgb\(\d+ \d+ \d+\)$/, `opaque for tint ${tint}`);
    }
});

test('computeTokens falls back to a readable dark surface on unparseable input', () => {
    const { bg } = computeTokens(null, null);
    assert.equal(bg, 'rgb(20 20 25)');
});

test('computeTokens never emits an alpha channel (the whole point)', () => {
    const cases = [
        ['rgba(0,0,0,0)', 'rgba(220,221,222,1)'],
        ['rgba(255,255,255,0)', 'rgba(40,40,45,1)'],
        ['rgba(128,64,200,0.01)', 'rgba(200,200,200,1)'],
        [null, null],
    ];
    for (const [tint, body] of cases) {
        const { bg, overlayBg } = computeTokens(tint, body);
        for (const c of [bg, overlayBg]) {
            assert.doesNotMatch(c, /rgba\(/i, `no rgba() for ${tint}`);
            assert.doesNotMatch(c, /,\s*[\d.]+\s*\)/, `no alpha tail for ${tint}`);
        }
    }
});

// ── CSS contract: style.css no longer hardcodes dark overlay backgrounds ──

test('style.css routes every overlay background through --dsc-overlay-bg', async () => {
    const css = await readFile(new URL('../style.css', import.meta.url), 'utf8');

    // The hardcoded dark values that made overlays unreadable on light themes.
    assert.doesNotMatch(css, /#15161b/, 'no hardcoded #15161b option background');
    assert.doesNotMatch(css, /rgba\(0,\s*0,\s*0,\s*0\.9[0-9]\)/, 'no near-opaque black status overlay bg');
    assert.doesNotMatch(css, /rgba\(0,\s*0,\s*0,\s*0\.85\)/, 'no hardcoded pull-indicator bg');
    assert.doesNotMatch(css, /rgba\(12,\s*14,\s*20,\s*0\.98\)/, 'no hardcoded menu/popover bg');

    // The transparent-black-on-light-theme fix must have a JS companion, so the
    // @supports relative-color block stays as a second line of defense.
    assert.match(css, /rgb\(from var\(--SmartThemeBlurTintColor/, 'relative-color fallback retained');

    // Every overlay/menu element must consume the token, not a raw background.
    for (const sel of ['.dsc_status_overlay', '.dsc_pull_indicator', '.dsc_qs_menu', '.dsc_popover', '.dsc_nav_select option']) {
        const rule = css.match(new RegExp(`${sel.replace(/\./g, '\\.')}\\s*\\{([\\s\\S]*?)\\n\\}`));
        assert.ok(rule, `${sel} rule exists`);
        assert.match(rule[1], /var\(--dsc-overlay-bg\)/, `${sel} uses --dsc-overlay-bg`);
    }

    // color-scheme must follow the theme token, not be pinned to dark on any
    // element. (The --dsc-color-scheme *token* default of 'dark' is fine — it is
    // overridden by theme-sync.js — so exclude token-declaration lines.)
    const elementColorScheme = css
        .split('\n')
        .filter(l => /color-scheme\s*:/.test(l) && !/--dsc-color-scheme\s*:/.test(l))
        .map(l => l.trim());
    assert.deepEqual(elementColorScheme, ['color-scheme: var(--dsc-color-scheme);'],
        'the only element-level color-scheme is the token reference');
});

test('style.css declares the --dsc-overlay-bg and --dsc-color-scheme tokens', async () => {
    const css = await readFile(new URL('../style.css', import.meta.url), 'utf8');
    assert.match(css, /--dsc-overlay-bg:\s*var\(--dsc-bg\)/, '--dsc-overlay-bg token declared');
    assert.match(css, /--dsc-color-scheme:\s*dark/, '--dsc-color-scheme token declared with dark default');
});
