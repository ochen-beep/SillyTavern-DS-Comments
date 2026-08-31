// @ts-check
/**
 * DS Comments — sound module unit tests.
 *
 * Covers volume normalization before it reaches the browser Audio API, the
 * resolve paths for bundled / custom sounds (custom = server user-files URL),
 * atomic server-side persistence of uploads (upload → settings → flush, with
 * rollback), the one-time localforage → server migration, and missing-file
 * diagnostics. The /api/files/* + /user/files/* routes are served by the
 * stub-runtime in-memory FS (globalThis._stFiles).
 */

import '../test-helpers/stub-runtime.mjs';
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { state, getCtx } from '../src/core.js';
import {
    playNotificationSound, addCustomSound, migrateCustomSoundsToServer,
    missingCustomSoundKeys, initSoundKeyCounter, SOUND_EXTENSIONS,
} from '../src/sound.js';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

let _lastAudio = null;

beforeEach(() => {
    state.settings = { soundEnabled: true, soundVolume: 30, soundId: 'default', soundFiles: {} };
    getCtx().extensionSettings['dscomments'] = {};
    globalThis._stFilesReset();
    _lastAudio = null;
    globalThis.SillyTavern.libs.localforage = {
        keys: async () => [],
        getItem: async () => null,
        setItem: async () => {},
        removeItem: async () => {},
    };
    globalThis.Audio = class Audio {
        constructor(src) {
            this.src = src;
            this._volume = 1;
            _lastAudio = this;
        }
        set volume(v) {
            // Mirror the browser contract: HTMLMediaElement.volume throws if
            // the value is outside 0..1. Our production code must normalize
            // before assignment.
            if (v < 0 || v > 1 || !Number.isFinite(v)) {
                throw new Error(`Invalid volume ${v}`);
            }
            this._volume = v;
        }
        get volume() { return this._volume; }
        async play() {
            this.playCalled = true;
        }
    };
});

test('playNotificationSound does nothing when sound is disabled', async () => {
    state.settings.soundEnabled = false;
    await playNotificationSound();
    assert.equal(_lastAudio, null);
});

test('playNotificationSound sets volume from normalized soundVolume', async () => {
    state.settings.soundVolume = 75;
    await playNotificationSound();
    assert.ok(_lastAudio);
    assert.equal(_lastAudio.volume, 0.75);
    assert.equal(_lastAudio.playCalled, true);
});

test('volume is clamped to 1.0 when soundVolume exceeds maximum', async () => {
    state.settings.soundVolume = 200;
    await playNotificationSound();
    assert.ok(_lastAudio);
    assert.equal(_lastAudio.volume, 1);
});

test('volume is clamped to 0.0 when soundVolume is below minimum', async () => {
    state.settings.soundVolume = -50;
    await playNotificationSound();
    assert.ok(_lastAudio);
    assert.equal(_lastAudio.volume, 0);
});

test('volume falls back to default when soundVolume is non-numeric', async () => {
    state.settings.soundVolume = 'loud';
    await playNotificationSound();
    assert.ok(_lastAudio);
    assert.equal(_lastAudio.volume, 0.30);
});

test('default sound resolves to the bundled sounds folder', async () => {
    await playNotificationSound();
    assert.ok(_lastAudio.src.includes('/sounds/'), _lastAudio.src);
    // '#' in the filename must be encoded, not become a URL fragment.
    assert.ok(_lastAudio.src.includes(encodeURIComponent('Tiny_minimalist_bubb_#4-1780921666702.wav')));
});

test('folder:<file> sound resolves to the bundled sounds folder', async () => {
    state.settings.soundId = 'folder:Tiny_crystalline_gla_#2-1780921518367.wav';
    await playNotificationSound();
    assert.ok(_lastAudio.src.includes('/sounds/'), _lastAudio.src);
    assert.ok(_lastAudio.src.includes(encodeURIComponent('Tiny_crystalline_gla_#2-1780921518367.wav')));
});

test('custom sound resolves from the server user-files URL', async () => {
    state.settings.soundFiles = { custom_1: { name: 'mine', file: 'dsc_sound_custom_1.mp3' } };
    state.settings.soundId = 'custom_1';
    await playNotificationSound();
    assert.equal(_lastAudio.src, '/user/files/dsc_sound_custom_1.mp3');
});

test('custom sound without a server file falls back to the default bundled sound', async () => {
    state.settings.soundFiles = { custom_1: { name: 'legacy, not migrated yet' } };
    state.settings.soundId = 'custom_1';
    await playNotificationSound();
    assert.ok(_lastAudio.src.includes('/sounds/'), _lastAudio.src);
});

test('Audio.play() rejection is swallowed', async () => {
    globalThis.Audio = class Audio {
        constructor() { _lastAudio = this; }
        set volume(v) { this._volume = v; }
        get volume() { return this._volume; }
        async play() { throw new Error('autoplay blocked'); }
    };
    await assert.doesNotReject(() => playNotificationSound());
});

// ── atomic custom sound persistence (server file store) ──

test('addCustomSound rejects invalid payload and writes nothing', async () => {
    assert.equal(await addCustomSound('', 'data:audio/wav;base64,x'), null);
    assert.equal(await addCustomSound('name', ''), null);
    assert.equal(await addCustomSound(null, 'data'), null);
    assert.deepEqual(state.settings.soundFiles, {});
    assert.equal(state.settings.soundId, 'default');
    assert.equal(Object.keys(globalThis._stFiles).length, 0);
});

test('addCustomSound uploads before settings mutation and persistence', async () => {
    const order = [];
    const origFetch = globalThis.fetch;
    globalThis.fetch = (url, init = {}) => {
        if (String(url) === '/api/files/upload') order.push(['upload', JSON.parse(init.body).name]);
        return origFetch(url, init);
    };
    const persist = async (key) => { order.push(['persist', key]); return true; };
    try {
        const key = await addCustomSound('my sound', 'data:audio/mpeg;base64,QUJD', { persistSettings: persist, notify: () => {} });
        assert.ok(key?.startsWith('custom_'));
        assert.equal(order[0][0], 'upload');
        assert.equal(order[order.length - 1][0], 'persist');
        // QUJD (base64) decodes to ABC through the stub's in-memory FS.
        assert.equal(globalThis._stFiles[`dsc_sound_${key}.mp3`], 'ABC');
        assert.equal(state.settings.soundFiles[key].name, 'my sound');
        assert.equal(state.settings.soundFiles[key].file, `dsc_sound_${key}.mp3`);
        assert.equal(state.settings.soundId, key);
    } finally {
        globalThis.fetch = origFetch;
    }
});

test('addCustomSound restores previous settings and removes the orphan file on persistence failure', async () => {
    state.settings.soundFiles = { custom_1: { name: 'old', file: 'dsc_sound_custom_1.mp3' } };
    state.settings.soundId = 'custom_1';
    const result = await addCustomSound('new sound', 'data:audio/mpeg;base64,QUJD', {
        persistSettings: async () => { throw new Error('settings flush failed'); },
        notify: () => {},
    });
    assert.equal(result, null);
    assert.deepEqual(state.settings.soundFiles, { custom_1: { name: 'old', file: 'dsc_sound_custom_1.mp3' } });
    assert.equal(state.settings.soundId, 'custom_1');
    // The just-uploaded custom_2 file must be deleted again (orphan rollback).
    assert.ok(!('dsc_sound_custom_2.mp3' in globalThis._stFiles));
});

test('addCustomSound notifies and keeps settings when the upload itself fails', async () => {
    const origFetch = globalThis.fetch;
    globalThis.fetch = async (url, init = {}) => {
        if (String(url) === '/api/files/upload') return { ok: false, status: 500, text: async () => 'boom' };
        return origFetch(url, init);
    };
    const notifyCalls = [];
    try {
        const result = await addCustomSound('x', 'data:audio/mpeg;base64,QUJD', {
            persistSettings: async () => true,
            notify: (lvl, msg) => notifyCalls.push([lvl, msg]),
        });
        assert.equal(result, null);
        assert.deepEqual(state.settings.soundFiles, {});
        assert.equal(state.settings.soundId, 'default');
        assert.equal(notifyCalls.length, 1);
        assert.equal(notifyCalls[0][1], 'Could not save the custom sound.');
    } finally {
        globalThis.fetch = origFetch;
    }
});

test('addCustomSound still reports the primary error when rollback also fails', async () => {
    const origFetch = globalThis.fetch;
    globalThis.fetch = async (url) => {
        if (String(url) === '/api/files/upload' || String(url) === '/api/files/delete') {
            return { ok: false, status: 500, text: async () => 'boom' };
        }
        return origFetch(url);
    };
    const notifyCalls = [];
    try {
        await addCustomSound('x', 'data:audio/mpeg;base64,QUJD', {
            persistSettings: async () => true,
            notify: (lvl, msg) => notifyCalls.push([lvl, msg]),
        });
        assert.equal(notifyCalls.length, 1);
    } finally {
        globalThis.fetch = origFetch;
    }
});

test('addCustomSound returns key and updates state on success', async () => {
    const persistCalls = [];
    const key = await addCustomSound('success sound', 'data:audio/mpeg;base64,QUJD', {
        persistSettings: async (k) => { persistCalls.push(k); return true; },
        notify: () => {},
    });
    assert.ok(key);
    assert.equal(state.settings.soundFiles[key].name, 'success sound');
    assert.equal(state.settings.soundId, key);
    assert.deepEqual(persistCalls, ['custom-sound-save']);
});

test('stored-file extension prefers the data-URL mime, then the original file extension', async () => {
    const byWav = await addCustomSound('wav', 'data:audio/wav;base64,QUJD', { persistSettings: async () => true, notify: () => {} });
    assert.equal(state.settings.soundFiles[byWav].file, `dsc_sound_${byWav}.wav`);

    const byExt = await addCustomSound('odd', 'raw-not-a-data-url', { ext: 'ogg', persistSettings: async () => true, notify: () => {} });
    assert.equal(state.settings.soundFiles[byExt].file, `dsc_sound_${byExt}.ogg`);

    const byDefault = await addCustomSound('none', 'raw-not-a-data-url', { persistSettings: async () => true, notify: () => {} });
    assert.equal(state.settings.soundFiles[byDefault].file, `dsc_sound_${byDefault}.wav`);

    const upper = await addCustomSound('upper', 'data:application/octet-stream;base64,QUJD', { ext: '.MP3', persistSettings: async () => true, notify: () => {} });
    assert.equal(state.settings.soundFiles[upper].file, `dsc_sound_${upper}.mp3`);
});

test('initSoundKeyCounter seeds the next key from the highest existing one', async () => {
    state.settings.soundFiles = {
        custom_1: { name: 'a', file: 'dsc_sound_custom_1.mp3' },
        custom_2: { name: 'b', file: 'dsc_sound_custom_2.mp3' },
    };
    initSoundKeyCounter();
    const key = await addCustomSound('third', 'data:audio/mpeg;base64,QUJD', { persistSettings: async () => true, notify: () => {} });
    assert.equal(key, 'custom_3');
});

// ── localforage → server migration ──

test('migrateCustomSoundsToServer lifts a legacy blob, persists, and cleans localforage', async () => {
    state.settings.soundFiles = { custom_1: { name: 'legacy' } };
    const removed = [];
    globalThis.SillyTavern.libs.localforage.getItem = async (k) =>
        k === 'DSComments_sound_custom_1' ? 'data:audio/wav;base64,QUJD' : null;
    globalThis.SillyTavern.libs.localforage.removeItem = async (k) => removed.push(k);
    const persistCalls = [];
    const migrated = await migrateCustomSoundsToServer({
        persistSettings: async (k) => { persistCalls.push(k); return true; },
    });
    assert.equal(migrated, 1);
    assert.equal(globalThis._stFiles['dsc_sound_custom_1.wav'], 'ABC');
    assert.deepEqual(state.settings.soundFiles, { custom_1: { name: 'legacy', file: 'dsc_sound_custom_1.wav' } });
    assert.deepEqual(persistCalls, ['custom-sound-migrate']);
    assert.deepEqual(removed, ['DSComments_sound_custom_1']);
});

test('migrateCustomSoundsToServer is a no-op when nothing is pending', async () => {
    state.settings.soundFiles = { custom_1: { name: 'done', file: 'dsc_sound_custom_1.mp3' } };
    const persistCalls = [];
    const migrated = await migrateCustomSoundsToServer({
        persistSettings: async (k) => { persistCalls.push(k); return true; },
    });
    assert.equal(migrated, 0);
    assert.deepEqual(persistCalls, []);
});

test('migrateCustomSoundsToServer skips entries whose blob is already lost', async () => {
    state.settings.soundFiles = { custom_1: { name: 'lost' } };
    const migrated = await migrateCustomSoundsToServer({ persistSettings: async () => true });
    assert.equal(migrated, 0);
    assert.deepEqual(state.settings.soundFiles, { custom_1: { name: 'lost' } });
});

test('migrateCustomSoundsToServer leaves the entry untouched when the upload fails', async () => {
    state.settings.soundFiles = { custom_1: { name: 'legacy' } };
    globalThis.SillyTavern.libs.localforage.getItem = async () => 'data:audio/wav;base64,QUJD';
    const origFetch = globalThis.fetch;
    globalThis.fetch = async (url, init = {}) => {
        if (String(url) === '/api/files/upload') return { ok: false, status: 500, text: async () => 'boom' };
        return origFetch(url, init);
    };
    try {
        const migrated = await migrateCustomSoundsToServer({ persistSettings: async () => true });
        assert.equal(migrated, 0);
        assert.deepEqual(state.settings.soundFiles, { custom_1: { name: 'legacy' } });
    } finally {
        globalThis.fetch = origFetch;
    }
});

// ── missing-file diagnostics ──

test('missingCustomSoundKeys reports absent server files only', async () => {
    state.settings.soundFiles = {
        custom_1: { name: 'present', file: 'dsc_sound_custom_1.mp3' },
        custom_2: { name: 'absent', file: 'dsc_sound_custom_2.mp3' },
    };
    globalThis._stFiles['dsc_sound_custom_1.mp3'] = 'x';
    const missing = await missingCustomSoundKeys();
    assert.deepEqual([...missing], ['custom_2']);
});

test('missingCustomSoundKeys marks legacy entries only when no local blob survives', async () => {
    state.settings.soundFiles = {
        custom_1: { name: 'retryable' },   // no file, blob still in localforage
        custom_2: { name: 'dead' },        // no file, blob gone
    };
    globalThis.SillyTavern.libs.localforage.getItem = async (k) =>
        k === 'DSComments_sound_custom_1' ? 'data:audio/wav;base64,QUJD' : null;
    const missing = await missingCustomSoundKeys();
    assert.deepEqual([...missing], ['custom_2']);
});

test('missingCustomSoundKeys never reports missing when verification is unavailable', async () => {
    state.settings.soundFiles = { custom_1: { name: 'absent', file: 'dsc_sound_custom_1.mp3' } };
    const origFetch = globalThis.fetch;
    globalThis.fetch = async (url, init = {}) => {
        if (String(url) === '/api/files/verify') return { ok: false, status: 500, text: async () => 'boom' };
        return origFetch(url, init);
    };
    try {
        const missing = await missingCustomSoundKeys();
        assert.equal(missing.size, 0);
    } finally {
        globalThis.fetch = origFetch;
    }
});

// ── packaging contracts ──

test('settings.html upload accept attribute stays in sync with SOUND_EXTENSIONS', () => {
    const html = readFileSync(path.join(root, 'settings.html'), 'utf8');
    const m = html.match(/id="dsc_sound_file"[^>]*accept="([^"]+)"/);
    assert.ok(m, 'accept attribute not found on #dsc_sound_file');
    const accepted = m[1].split(',').map(s => s.trim().replace(/^\./, '').toLowerCase());
    assert.deepEqual([...accepted].sort(), [...SOUND_EXTENSIONS].sort());
});
