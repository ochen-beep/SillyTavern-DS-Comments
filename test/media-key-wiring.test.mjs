// @ts-check
/**
 * DS Comments — settings wiring regression tests (source-level).
 *
 * The media provider API key (dsc_media_giphy_key) is a localforage-backed
 * password field and is deliberately NOT registered in FIELD_MAP. Its
 * input/change handlers in index.js must therefore run BEFORE the
 * `if (!cfg) return;` FIELD_MAP gate — a regression here silently drops every
 * keystroke and the resolver runs with an empty key (observed live: Giphy
 * selected + key typed, comments still rendered text-only).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const src = readFileSync(path.join(root, 'index.js'), 'utf8');

/** Index of the FIELD_MAP gate inside the handler containing `anchor`. */
function gateIndexAfter(anchor) {
    const start = src.indexOf(anchor);
    assert.ok(start !== -1, `anchor not found: ${anchor}`);
    const gate = src.indexOf("const cfg = FIELD_MAP[el.id];\n        if (!cfg) return;", start);
    assert.ok(gate !== -1, 'FIELD_MAP gate not found after anchor');
    return gate;
}

test('input handler: media key setter runs BEFORE the FIELD_MAP gate', () => {
    const setInput = src.indexOf("if (el.id === 'dsc_apikey') { setApiKey(el.value); return; }");
    assert.ok(setInput !== -1, 'input apikey handler not found');
    const gate = src.lastIndexOf("const cfg = FIELD_MAP[el.id];\n        if (!cfg) return;", setInput);
    const giphy = src.indexOf("setGiphyKey(el.value)");
    assert.ok(giphy !== -1, 'media key setter not wired');
    assert.ok(giphy < gate, 'setGiphyKey call must precede the FIELD_MAP gate');
});

test('change handler: media key flush runs BEFORE the FIELD_MAP gate', () => {
    const flush = src.indexOf("if (el.id === 'dsc_media_giphy_key') { flushGiphyKey(); return; }");
    assert.ok(flush !== -1, 'media key flush not wired');
    const gate = gateIndexAfter('dsc_sound_file');
    assert.ok(flush < gate, 'flushGiphyKey must precede the FIELD_MAP gate');
});

test('media key id is hidden by updateMediaVisibility, key synced from localforage', () => {
    const sync = readFileSync(path.join(root, 'src/ui/settings-sync.js'), 'utf8');
    assert.match(sync, /getElementById\('dsc_media_giphy_key'\)/);
    assert.match(sync, /getGiphyKey\(\)/);
    // visibility: giphy key hidden unless provider === 'giphy'
    assert.match(sync, /giphyKey\.hidden = provider !== 'giphy'/);
});
