import assert from 'node:assert/strict';
import test from 'node:test';

import { normalizeDesktopGeometry } from '../src/ui/window-geometry.js';

test('leaves fitting geometry unchanged without mutating the source', () => {
    const geometry = { left: 120, top: 80, width: 380, height: 360 };
    const viewport = { left: 0, top: 0, width: 700, height: 500 };

    const result = normalizeDesktopGeometry(geometry, viewport);

    assert.deepEqual(result, geometry);
    assert.notStrictEqual(result, geometry);
    assert.deepEqual(geometry, { left: 120, top: 80, width: 380, height: 360 });
});

test('leaves a narrow viewport position unchanged when 60px remains visible', () => {
    const geometry = { left: 600, top: 80, width: 380, height: 360 };
    const viewport = { left: 0, top: 0, width: 700, height: 500 };

    const result = normalizeDesktopGeometry(geometry, viewport);

    assert.deepEqual(result, { left: 600, top: 80, width: 380, height: 360 });
    assert.deepEqual(geometry, { left: 600, top: 80, width: 380, height: 360 });
});

test('clamps right overflow to preserve 60px of the header', () => {
    assert.deepEqual(normalizeDesktopGeometry(
        { left: 800, top: 80, width: 380, height: 360 },
        { left: 0, top: 0, width: 700, height: 500 },
    ), { left: 640, top: 80, width: 380, height: 360 });
});

test('raises undersized display dimensions without mutating saved geometry', () => {
    const geometry = { left: 120, top: 80, width: 180, height: 90 };
    const viewport = { left: 0, top: 0, width: 700, height: 500 };

    assert.deepEqual(normalizeDesktopGeometry(geometry, viewport), {
        left: 120,
        top: 80,
        width: 240,
        height: 120,
    });
    assert.deepEqual(geometry, { left: 120, top: 80, width: 180, height: 90 });
});

test('renders oversized saved geometry at viewport dimensions and clamps it', () => {
    const geometry = { left: -30, top: -20, width: 900, height: 700 };
    const viewport = { left: 0, top: 0, width: 700, height: 500 };

    assert.deepEqual(normalizeDesktopGeometry(geometry, viewport), {
        left: 0,
        top: 0,
        width: 700,
        height: 500,
    });
});

test('respects visual viewport offsets', () => {
    const geometry = { left: 20, top: 30, width: 380, height: 360 };
    const viewport = { left: 100, top: 50, width: 700, height: 500 };

    assert.deepEqual(normalizeDesktopGeometry(geometry, viewport), {
        left: 20,
        top: 50,
        width: 380,
        height: 360,
    });
});

test('preserves decimal geometry values', () => {
    const geometry = { left: 120.25, top: 80.5, width: 380.75, height: 360.125 };
    const viewport = { left: 0, top: 0, width: 700.5, height: 500.25 };

    assert.deepEqual(normalizeDesktopGeometry(geometry, viewport), geometry);
});

test('keeps a 60px horizontal header segment available', () => {
    const result = normalizeDesktopGeometry(
        { left: 900, top: 80, width: 380, height: 360 },
        { left: 0, top: 0, width: 700, height: 500 },
    );

    assert.equal(result.left, 640);
    assert.equal(700 - result.left, 60);
});

test('keeps the full 44px header accessible at the bottom', () => {
    const result = normalizeDesktopGeometry(
        { left: 120, top: 900, width: 380, height: 360 },
        { left: 0, top: 0, width: 700, height: 500 },
    );

    assert.equal(result.top, 456);
    assert.equal(500 - result.top, 44);
});

test('clamps right and bottom positions within an offset viewport', () => {
    assert.deepEqual(normalizeDesktopGeometry(
        { left: 900, top: 900, width: 380, height: 360 },
        { left: 100, top: 50, width: 700, height: 500 },
    ), { left: 740, top: 506, width: 380, height: 360 });
});

test('anchors top to an undersized viewport', () => {
    const result = normalizeDesktopGeometry(
        { left: 120, top: 0, width: 380, height: 360 },
        { left: 0, top: 50, width: 700, height: 30 },
    );

    assert.equal(result.top, 50);
});
