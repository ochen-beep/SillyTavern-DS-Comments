// @ts-check
/**
 * DS Comments — media lightbox smoke tests (src/ui/lightbox.js against the
 * stub DOM): allowlist gate, singleton dialog, tap-to-close, pinch-to-close.
 */
import '../test-helpers/stub-runtime.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openMediaLightbox, closeMediaLightbox } from '../src/ui/lightbox.js';

const findDialog = () => globalThis.document.body.children.find(d => d.id === 'dsc_lightbox');

test('lightbox: opens allow-listed media in a reused fullscreen dialog', () => {
    openMediaLightbox('https://media.giphy.com/media/abc/giphy.gif', 'cat');
    const dlg = findDialog();
    assert.ok(dlg, 'dialog appended to body');
    assert.equal(dlg.open, true);
    assert.equal(dlg._dscImg.src, 'https://media.giphy.com/media/abc/giphy.gif');
    assert.equal(dlg._dscImg.alt, 'cat');
    // second open reuses the singleton and swaps the image
    openMediaLightbox('https://api.memegen.link/images/drake/a/b.png', 'meme');
    assert.equal(globalThis.document.body.children.filter(d => d.id === 'dsc_lightbox').length, 1);
    assert.equal(dlg._dscImg.src, 'https://api.memegen.link/images/drake/a/b.png');
});

test('lightbox: non-allowlisted URL is refused', () => {
    const dlg = findDialog();
    const before = dlg._dscImg.src;
    openMediaLightbox('https://evil.example.com/x.gif');
    assert.equal(dlg._dscImg.src, before);
});

test('lightbox: click closes; pinch-in closes; small two-finger drift does not', () => {
    const dlg = findDialog();
    openMediaLightbox('https://media.giphy.com/media/abc/giphy.gif');
    assert.equal(dlg.open, true);
    dlg._listeners.click();
    assert.equal(dlg.open, false);
    // pinch: span shrinks below 70% of the opening distance → close
    openMediaLightbox('https://media.giphy.com/media/abc/giphy.gif');
    dlg._listeners.touchstart({ touches: [{ clientX: 0, clientY: 0 }, { clientX: 100, clientY: 0 }] });
    dlg._listeners.touchmove({ touches: [{ clientX: 0, clientY: 0 }, { clientX: 50, clientY: 0 }] });
    assert.equal(dlg.open, false);
    // drift above the threshold → stays open
    openMediaLightbox('https://media.giphy.com/media/abc/giphy.gif');
    dlg._listeners.touchstart({ touches: [{ clientX: 0, clientY: 0 }, { clientX: 100, clientY: 0 }] });
    dlg._listeners.touchmove({ touches: [{ clientX: 0, clientY: 0 }, { clientX: 95, clientY: 0 }] });
    assert.equal(dlg.open, true);
    closeMediaLightbox();
    assert.equal(dlg.open, false);
});
