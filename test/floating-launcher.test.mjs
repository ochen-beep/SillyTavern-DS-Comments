// @ts-check
/**
 * DS Comments — floating launcher (FAB) position math tests.
 *
 * Covers the pure helpers: default anchor positions (desktop vs mobile),
 * viewport clamping (including the ST top-bar inset — the bar paints above the
 * FAB's layer, so a position in the top strip must be pushed below it), and
 * restore-position validation. The localStorage payload
 * is untrusted — stale coordinates saved on a larger viewport must fall back to
 * the corner default, never strand the FAB off-screen or partially outside.
 *
 * The DOM/drag glue (ensureFloatingLauncher, Pointer Events, resize listener)
 * is intentionally not unit-tested — same policy as theme-sync's observer
 * glue; layering is locked separately in window-stacking.test.mjs.
 */

import '../test-helpers/stub-runtime.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { _testFloatingLauncher } from '../src/ui/floating-launcher.js';

const { defaultPosition, clampPosition, clampFabPosition, computeRestoredPosition, FAB_SIZE } = _testFloatingLauncher;

const VP = { width: 1920, height: 1080 };

// ── defaultPosition ──

test('defaultPosition anchors to the bottom-right corner (desktop)', () => {
    assert.deepEqual(defaultPosition(VP, FAB_SIZE, false), { left: 1920 - 36 - 20, top: 1080 - 36 - 80 });
});

test('defaultPosition clears the send form on mobile', () => {
    const vp = { width: 390, height: 844 };
    const pos = defaultPosition(vp, FAB_SIZE, true);
    assert.deepEqual(pos, { left: 390 - 36 - 16, top: 844 - 36 - 120 });
});

test('defaultPosition never goes negative on tiny viewports', () => {
    assert.deepEqual(defaultPosition({ width: 40, height: 40 }, FAB_SIZE, true), { left: 0, top: 0 });
});

// ── clampPosition ──

test('clampPosition keeps the FAB fully inside the viewport', () => {
    assert.deepEqual(clampPosition({ left: -50, top: 9999 }, VP, FAB_SIZE), { left: 0, top: 1080 - 36 });
    // in-range coordinates pass through untouched
    assert.deepEqual(clampPosition({ left: 100, top: 200 }, VP, FAB_SIZE), { left: 100, top: 200 });
});

// ── clampFabPosition (ST top-bar inset) ──

test('clampFabPosition pushes a parked FAB out from under the ST top bar', () => {
    // The bar (z-index 3005) paints over the FAB (2999): a position in the top
    // strip would make the button permanently unclickable.
    assert.deepEqual(clampFabPosition({ left: 100, top: 10 }, VP, FAB_SIZE, 44), { left: 100, top: 44 });
});

test('clampFabPosition leaves positions below the top bar untouched', () => {
    assert.deepEqual(clampFabPosition({ left: 100, top: 200 }, VP, FAB_SIZE, 44), { left: 100, top: 200 });
    // no measurable bar (hidden/scrolled away) → plain viewport clamp
    assert.deepEqual(clampFabPosition({ left: 100, top: 10 }, VP, FAB_SIZE, 0), { left: 100, top: 10 });
});

test('clampFabPosition still respects the viewport when the inset is huge', () => {
    assert.deepEqual(
        clampFabPosition({ left: 100, top: 10 }, { width: 1920, height: 60 }, FAB_SIZE, 44),
        { left: 100, top: 60 - 36 },
    );
});

// ── computeRestoredPosition ──

test('computeRestoredPosition accepts an in-viewport saved position', () => {
    const saved = { left: 500, top: 300 };
    assert.deepEqual(computeRestoredPosition(saved, VP, FAB_SIZE, false), saved);
});

test('computeRestoredPosition rejects coordinates stranded outside a smaller viewport', () => {
    // Saved on a 1920×1080 window, restored on 1280×720: the FAB would be
    // unreachable — must fall back to the corner default instead.
    const pos = computeRestoredPosition({ left: 1700, top: 900 }, { width: 1280, height: 720 }, FAB_SIZE, false);
    assert.deepEqual(pos, { left: 1280 - 36 - 20, top: 720 - 36 - 80 });
});

test('computeRestoredPosition rejects malformed payloads', () => {
    const fallback = defaultPosition(VP, FAB_SIZE, false);
    const badPayloads = [null, undefined, {}, { left: 'x', top: 5 }, { left: NaN, top: 10 }, { left: -1, top: 10 }];
    for (const bad of badPayloads) {
        assert.deepEqual(computeRestoredPosition(bad, VP, FAB_SIZE, false), fallback);
    }
});
