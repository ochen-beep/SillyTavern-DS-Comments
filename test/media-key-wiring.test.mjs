// @ts-check
/**
 * DS Comments — settings wiring regression tests (behavioral).
 *
 * The media provider API key (dsc_media_giphy_key) is a localforage-backed
 * password field and is deliberately NOT registered in FIELD_MAP. Its
 * input/change routes in index.js must therefore run BEFORE the
 * `if (!cfg) return;` FIELD_MAP gate — a regression here silently drops every
 * keystroke and the resolver runs with an empty key (observed live: Giphy
 * selected + key typed, comments still rendered text-only).
 *
 * The routing lives in the exported handleSettingsInput / handleSettingsChange
 * (extracted verbatim from the panel listeners), so these tests drive the
 * exact functions the live DOM dispatches into — no source-text greps.
 */

import { install, uninstall } from '../test-helpers/lifecycle-runtime.mjs';
import { beforeEach, afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { state, getGiphyKey, flushGiphyKey, resetGiphyKeyCache, LF_GIPHY_KEY } from '../src/core.js';

let wiring = null;       // index.js module, imported after install()
let store = null;        // the stub localforage in-memory Map

beforeEach(async () => {
    install();
    // Dynamic import AFTER install() so index.js and its deps capture the
    // lifecycle fakes (same pattern as on-clean-parallel.test.mjs).
    wiring = await import('../index.js');
    store = globalThis.SillyTavern.libs.localforage._store;
    store.clear();
    resetGiphyKeyCache();
});

afterEach(() => {
    resetGiphyKeyCache();
    uninstall();
});

test('input on the giphy key field reaches setGiphyKey before the FIELD_MAP gate', async () => {
    wiring.handleSettingsInput({ id: 'dsc_media_giphy_key', value: 'gk_typed' });
    // The resolver's source must hold the typed key immediately — if the
    // FIELD_MAP gate ever runs first, it drops the event and the cache
    // stays empty (the live regression).
    assert.equal(await getGiphyKey(), 'gk_typed', 'the typed key reached the resolver\'s source');
});

test('change on the giphy key field flushes the cached key to localforage', async () => {
    wiring.handleSettingsInput({ id: 'dsc_media_giphy_key', value: 'gk_flush' });
    wiring.handleSettingsChange({ id: 'dsc_media_giphy_key' });
    await flushGiphyKey();
    assert.equal(store.get(LF_GIPHY_KEY), 'gk_flush', 'flush persisted the typed key');
});

test('a non-FIELD_MAP id is dropped by the gate and never touches the key path', async () => {
    wiring.handleSettingsInput({ id: 'dsc_not_a_setting', value: 'x' });
    wiring.handleSettingsChange({ id: 'dsc_not_a_setting' });
    assert.equal(store.has(LF_GIPHY_KEY), false, 'no giphy write from an unrelated id');
    assert.equal(await getGiphyKey(), '', 'the empty key path stays empty (no spill from the drop)');
});

test('control: a registered text setting still flows through the common FIELD_MAP path', () => {
    wiring.handleSettingsInput({ id: 'dsc_extrabody', value: '{"a":1}' });
    assert.equal(state.settings.extraBody, '{"a":1}', 'the gate must keep passing registered settings (giphy early-return must not break it)');
});
