// @ts-check
/**
 * DS Comments — bundled sounds disk-consistency test.
 *
 * Guards the invariant that broke once: BUNDLED_SOUNDS (the dropdown list)
 * must mirror the sounds/ directory exactly. A listed sound without a file on
 * disk is a silent 404 at playback; a file on disk without a list entry is
 * dead weight.
 */

import '../test-helpers/stub-runtime.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdir } from 'node:fs/promises';
import { BUNDLED_SOUNDS, DEFAULT_SOUND_FILENAME } from '../src/sound.js';

const soundsDir = new URL('../sounds/', import.meta.url);
const FOLDER_PREFIX = 'folder:';

test('every bundled sound has its file in sounds/', async () => {
    const onDisk = new Set(await readdir(soundsDir));
    for (const s of BUNDLED_SOUNDS) {
        assert.ok(s.key.startsWith(FOLDER_PREFIX), `key is not folder:-typed: ${s.key}`);
        const file = s.key.slice(FOLDER_PREFIX.length);
        assert.ok(onDisk.has(file), `no file on disk: ${file}`);
    }
});

test('every file in sounds/ is listed in BUNDLED_SOUNDS (no dead files)', async () => {
    const listed = new Set(BUNDLED_SOUNDS.map(s => s.key.slice(FOLDER_PREFIX.length)));
    for (const file of await readdir(soundsDir)) {
        assert.ok(listed.has(file), `file not registered in BUNDLED_SOUNDS: ${file}`);
    }
});

test('default sound fallback exists on disk', async () => {
    const onDisk = new Set(await readdir(soundsDir));
    assert.ok(onDisk.has(DEFAULT_SOUND_FILENAME), `no default sound: ${DEFAULT_SOUND_FILENAME}`);
});

test('bundled sound keys are unique', async () => {
    const keys = BUNDLED_SOUNDS.map(s => s.key);
    assert.equal(new Set(keys).size, keys.length);
});
