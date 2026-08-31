// @ts-check
/**
 * DS Comments — UI: Theme sync.
 *
 * Computes OPAQUE, theme-aware background tokens from SillyTavern's translucent
 * `--SmartThemeBlurTintColor` and writes them back as CSS custom properties on
 * `:root`. This guarantees the comments window and its overlays are never
 * see-through, regardless of browser support for CSS relative-color syntax.
 *
 * Why JS and not pure CSS:
 *   The original fix (`@supports (color: rgb(from white r g b))` in style.css)
 *   strips the tint's alpha via relative-color syntax — but that syntax only
 *   reached full support in Chrome/Edge 131, Safari 18, Firefox 133. On older
 *   engines (notably ST desktop on older Electron, Firefox < 133), `@supports`
 *   evaluates false, `--dsc-bg` falls back to the raw translucent tint, and on
 *   transparent themes (alpha ≈ 0) the window becomes glass — text from the
 *   underlying post bleeds through and comments become unreadable.
 *
 *   SillyTavern applies themes synchronously by writing `--SmartTheme*`
 *   variables via `document.documentElement.style.setProperty(...)` in
 *   power-user.js `applyThemeColor()`. It emits NO theme-change event, so we
 *   observe the `style` attribute on `<html>` (the documented cross-browser way
 *   to catch inline-style custom-property mutations) and recompute on change.
 *
 * Contract: idempotent init/teardown, mirroring window.js. Pure color helpers
 * are exported under a NODE_TEST guard for unit testing without a DOM.
 */

import { debounce, warn } from '../core.js';

// ── Module-owned runtime handles (teardown targets) ──
let _observer = null;
let _recompute = null;
let _bound = false;

// Tokens we own on :root. teardown removes exactly these so the CSS fallbacks
// (relative-color @supports / raw tint) take over again.
const OWNED_TOKENS = ['--dsc-bg', '--dsc-overlay-bg', '--dsc-color-scheme'];

/**
 * Parse a CSS `rgb()` / `rgba()` color string into channels.
 * SillyTavern stores theme colors verbatim as `rgba(r, g, b, a)` strings
 * (written by applyThemeColor()), so this is the only form we must handle; hex
 * and named colors return null and callers fall back to the CSS default.
 *
 * @param {string} str
 * @returns {{r:number,g:number,b:number,a:number}|null}
 */
export function parseRgba(str) {
    if (typeof str !== 'string') return null;
    const m = str.match(/rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)\s*(?:,\s*([\d.]+)\s*)?\)/i);
    if (!m) return null;
    const r = Number(m[1]), g = Number(m[2]), b = Number(m[3]);
    if (!Number.isFinite(r) || !Number.isFinite(g) || !Number.isFinite(b)) return null;
    return { r, g, b, a: m[4] === undefined ? 1 : Number(m[4]) };
}

/**
 * Render channels as an opaque `rgb(r g b)` (space-separated, CSS Color 4 —
 * also valid in legacy parsers). Alpha is dropped by construction.
 * @param {{r:number,g:number,b:number}} c
 * @returns {string}
 */
export function toOpaque({ r, g, b }) {
    return `rgb(${Math.round(r)} ${Math.round(g)} ${Math.round(b)})`;
}

/**
 * WCAG relative luminance (0..1). Used to classify a theme as light/dark so the
 * transparent-black-on-light-theme edge case can be corrected.
 * @param {{r:number,g:number,b:number}} c
 * @returns {number}
 */
export function luminance({ r, g, b }) {
    const f = v => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; };
    return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
}

// A tint is treated as "near-black" when every channel is very low — this is the
// signature of a no-blur dark tint (`rgba(0,0,0,0)`) some light themes set.
const NEAR_BLACK_MAX = 40;

/**
 * Derive the opaque window + overlay backgrounds and the native color-scheme
 * hint from the current theme tokens. Pure function — reads nothing from the DOM.
 *
 * @param {string|null} tintRaw  `--SmartThemeBlurTintColor` value
 * @param {string|null} bodyRaw  `--SmartThemeBodyColor` value (text color; classifies light/dark)
 * @returns {{bg:string, overlayBg:string, colorScheme:'dark'|'light'}}
 */
export function computeTokens(tintRaw, bodyRaw) {
    const tint = parseRgba(tintRaw);
    const body = parseRgba(bodyRaw);
    // --SmartThemeBodyColor is the TEXT color, not the background: dark text
    // (low luminance) means a LIGHT theme, light text (high luminance) a dark one.
    const themeIsLight = body ? luminance(body) < 0.5 : false;
    const tintIsNearBlack = tint && tint.r < NEAR_BLACK_MAX && tint.g < NEAR_BLACK_MAX && tint.b < NEAR_BLACK_MAX;

    let bg;
    if (!tint) {
        // Unparseable: keep the window readable with a neutral dark fallback.
        bg = 'rgb(20 20 25)';
    } else if (tintIsNearBlack && themeIsLight) {
        // Edge case: a light theme sets a transparent *black* tint as its
        // "no-blur" placeholder. Keeping the hue would paint a black window
        // behind dark text → unreadable. Invert to a light surface.
        bg = 'rgb(240 240 244)';
    } else {
        // Normal path: keep the tint's hue, force alpha to 1.
        bg = toOpaque(tint);
    }

    // Overlay (popovers/menus/status): slightly darker than the window on dark
    // themes for separation; equal to the window on light themes so popovers
    // don't read as a brighter white than the panel they float over.
    const overlayBg = (!themeIsLight && tint)
        ? toOpaque({ r: Math.max(0, tint.r - 10), g: Math.max(0, tint.g - 10), b: Math.max(0, tint.b - 10) })
        : bg;

    return { bg, overlayBg, colorScheme: themeIsLight ? 'light' : 'dark' };
}

/** Read the live theme tokens and push derived tokens onto :root. */
function applyTokens() {
    try {
        const cs = getComputedStyle(document.documentElement);
        const tintRaw = cs.getPropertyValue('--SmartThemeBlurTintColor').trim();
        const bodyRaw = cs.getPropertyValue('--SmartThemeBodyColor').trim();
        const { bg, overlayBg, colorScheme } = computeTokens(tintRaw, bodyRaw);
        const root = document.documentElement;
        root.style.setProperty('--dsc-bg', bg);
        root.style.setProperty('--dsc-overlay-bg', overlayBg);
        root.style.setProperty('--dsc-color-scheme', colorScheme);
    } catch (e) {
        warn('theme-sync: failed to apply tokens:', e);
    }
}

/**
 * Start observing theme changes. Idempotent. Recomputes once immediately (the
 * theme is already applied by the time init runs) and on every subsequent
 * `style` mutation of `<html>` (SillyTavern's applyThemeColor write path).
 */
export function initThemeSync() {
    if (_bound) return;
    _bound = true;
    applyTokens();
    // ST writes several --SmartTheme* properties in quick succession during one
    // applyThemeColor pass; debounce so we recompute once per pass, not N times.
    _recompute = debounce(applyTokens, 60);
    _observer = new MutationObserver(_recompute);
    _observer.observe(document.documentElement, { attributes: true, attributeFilter: ['style'] });
}

/**
 * Stop observing and restore CSS-only behavior. Removes exactly the tokens we
 * own, so the style.css fallbacks take over again.
 */
export function teardownThemeSync() {
    if (!_bound) return;
    _observer?.disconnect();
    _observer = null;
    _recompute?.cancel?.();
    _recompute = null;
    for (const token of OWNED_TOKENS) document.documentElement.style.removeProperty(token);
    _bound = false;
}

// Test-only exports (NODE_TEST guard — invisible in the ST browser host).
const _test = typeof process !== 'undefined' && process?.env?.NODE_TEST === '1'
    ? { parseRgba, toOpaque, luminance, computeTokens }
    : undefined;
export { _test as _testThemeSync };
