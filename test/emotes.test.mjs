// @ts-check
/**
 * DS Comments — reaction emotes tests (src/emotes.js): whitelist resolution,
 * feature gating, code list for the contract, 7TV set fetch and merging.
 */
import '../test-helpers/stub-runtime.mjs';
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { state } from '../src/core.js';
import { _setEmoteManifest, refreshEmoteManifest, getEmoteUrl, getEmoteCodes, SET_TEACH_DICT } from '../src/emotes.js';

beforeEach(() => {
    state.settings = { reactionEmotes: true, emoteSetId: '' };
    _setEmoteManifest({
        builtin: {
            FeelsGoodMan: 'https://cdn.betterttv.net/emote/a/2x.webp',
            monkaS: 'https://cdn.betterttv.net/emote/b/2x.webp',
        },
        sevenTv: { KEKW: 'https://cdn.7tv.app/emote/c/2x.webp' },
        sevenTvSetId: 'set1',
    });
});

test('getEmoteUrl resolves whitelist codes, refuses unknown, gated by the feature', () => {
    assert.equal(getEmoteUrl('FeelsGoodMan'), 'https://cdn.betterttv.net/emote/a/2x.webp');
    assert.equal(getEmoteUrl('KEKW'), 'https://cdn.7tv.app/emote/c/2x.webp');
    assert.equal(getEmoteUrl('NotAnEmote'), null);
    state.settings.reactionEmotes = false;
    assert.equal(getEmoteUrl('FeelsGoodMan'), null, 'feature off → plain text reactions');
});

test('user 7TV set overrides builtin codes with the same name', () => {
    _setEmoteManifest({
        builtin: { KEKW: 'https://cdn.betterttv.net/emote/builtin/2x.webp' },
        sevenTv: { KEKW: 'https://cdn.7tv.app/emote/user/2x.webp' },
        sevenTvSetId: 'set1',
    });
    assert.equal(getEmoteUrl('KEKW'), 'https://cdn.7tv.app/emote/user/2x.webp');
});

test('getEmoteCodes: builtin whole, famous floor, rotating slice over the rest', () => {
    const restNames = Array.from({ length: 300 }, (_, i) => `Junk${String(i).padStart(3, '0')}`);
    const famousNames = ['GIGACHAD', 'KEKW', 'BLYAT'];
    _setEmoteManifest({
        builtin: { monkaS: 'u1', Kappa: 'u2' },
        sevenTv: Object.fromEntries([...restNames, ...famousNames].map((n, i) => [n, `u${i}`])),
        sevenTvSetId: 'set1',
    });
    const codes = getEmoteCodes(12345);
    assert.ok(famousNames.every(n => codes.includes(n)), 'famous floor is stable across generations');
    assert.ok(codes.includes('monkaS') && codes.includes('Kappa'), 'builtin rides whole');
    assert.equal(codes.filter(c => restNames.includes(c)).length, 12,
        'the rotating slice is capped — a big set cannot bloat the prompt');
    const firstRotated = codes.findIndex(c => restNames.includes(c));
    assert.equal(firstRotated, 0, 'the rotating slice leads the palette');
    assert.ok(codes.slice(0, 12).every(c => restNames.includes(c)),
        'all twelve slots before the floor are the rotating slice');
    assert.deepEqual(getEmoteCodes(12345), codes, 'a pinned seed reproduces the roll');
    const union = new Set();
    for (let s = 0; s < 30; s++) {
        for (const c of getEmoteCodes(s)) if (restNames.includes(c)) union.add(c);
    }
    assert.ok(union.size > 12, 'consecutive generations must see different corners of the set');
    _setEmoteManifest({ builtin: {} });
    assert.deepEqual(getEmoteCodes(1), []);
});

test('refreshEmoteManifest: reacts to settings and fetches the 7TV set', async () => {
    const realFetch = globalThis.fetch;
    globalThis.fetch = async (url) => {
        const u = String(url);
        if (u === 'https://7tv.io/v3/emote-sets/abc123') {
            return {
                ok: true,
                json: async () => ({ emotes: [{ id: 'e1', name: 'NewEmote' }] }),
            };
        }
        if (u.endsWith('/emotes/manifest.json')) {
            return { ok: true, json: async () => ({ emotes: { FeelsGoodMan: 'https://cdn.betterttv.net/emote/a/2x.webp' } }) };
        }
        throw new Error(`unexpected fetch ${u}`);
    };
    try {
        _setEmoteManifest({});                       // drop the injected cache — refresh must rebuild it
        state.settings.emoteSetId = 'abc123';
        await refreshEmoteManifest();
        assert.equal(getEmoteUrl('FeelsGoodMan'), 'https://cdn.betterttv.net/emote/a/2x.webp', 'builtin pack');
        assert.equal(getEmoteUrl('NewEmote'), 'https://cdn.7tv.app/emote/e1/2x.webp', '7TV set codes join the manifest');
        assert.equal(getEmoteUrl('monkaS'), null, 'injected test manifest replaced by the refreshed one');
    } finally {
        globalThis.fetch = realFetch;
    }
});

test('refreshEmoteManifest: a dead 7TV set degrades to the builtin pack', async () => {
    const realFetch = globalThis.fetch;
    globalThis.fetch = async (url) => {
        const u = String(url);
        if (u.includes('7tv.io')) throw new Error('network dead');
        if (u.endsWith('/emotes/manifest.json')) {
            return { ok: true, json: async () => ({ emotes: { monkaS: 'https://cdn.betterttv.net/emote/b/2x.webp' } }) };
        }
        throw new Error(`unexpected fetch ${u}`);
    };
    try {
        _setEmoteManifest({});
        state.settings.emoteSetId = 'dead';
        await refreshEmoteManifest();
        assert.equal(getEmoteUrl('monkaS'), 'https://cdn.betterttv.net/emote/b/2x.webp', 'builtin pack survives');
        assert.equal(getEmoteUrl('Whatever'), null);
    } finally {
        globalThis.fetch = realFetch;
    }
});

test('refreshEmoteManifest: external abort propagates as AbortError', async () => {
    const controller = new AbortController();
    controller.abort();
    const realFetch = globalThis.fetch;
    globalThis.fetch = async () => { throw new Error('fetch must not be reached after abort'); };
    try {
        _setEmoteManifest({});
        await assert.rejects(
            refreshEmoteManifest(controller.signal),
            (e) => e?.name === 'AbortError',
        );
    } finally {
        globalThis.fetch = realFetch;
    }
});

// ── stale-while-revalidate: persisted set serves instantly, network is background ──

const LF_7TV_KEY = 'DSComments_7tvSet_setcached';

test('SWR: a persisted 7TV set serves chips first, network only revalidates in background', async () => {
    await SillyTavern.libs.localforage.setItem(LF_7TV_KEY, {
        ts: Date.now() - 3 * 24 * 60 * 60 * 1000,   // any age serves — the numeric ts only shapes the payload
        map: { CachedEmote: 'https://cdn.7tv.app/emote/cached/2x.webp' },
    });
    const realFetch = globalThis.fetch;
    globalThis.fetch = async (url) => {
        const u = String(url);
        if (u === 'https://7tv.io/v3/emote-sets/setcached') {
            // slow revalidation: with SWR the reader must NOT wait for it
            await new Promise(r => setTimeout(r, 50));
            return { ok: true, json: async () => ({ emotes: [{ id: 'bg', name: 'BgEmote' }] }) };
        }
        if (u.endsWith('/emotes/manifest.json')) {
            return { ok: true, json: async () => ({ emotes: { monkaS: 'https://cdn.betterttv.net/emote/b/2x.webp' } }) };
        }
        throw new Error(`unexpected fetch ${u}`);
    };
    try {
        _setEmoteManifest({});
        state.settings.emoteSetId = 'setcached';
        await refreshEmoteManifest();
        assert.equal(getEmoteUrl('CachedEmote'), 'https://cdn.7tv.app/emote/cached/2x.webp',
            'persisted set adopted at any age — before the slow revalidate resolves');
        assert.equal(getEmoteUrl('BgEmote'), null, 'the background fetch has not been awaited');
        assert.equal(getEmoteUrl('monkaS'), 'https://cdn.betterttv.net/emote/b/2x.webp', 'builtin still merged');
        await new Promise(r => setTimeout(r, 80));   // let the background revalidate land
        assert.equal(getEmoteUrl('BgEmote'), 'https://cdn.7tv.app/emote/bg/2x.webp', 'background swap-in');
        const stored = await SillyTavern.libs.localforage.getItem(LF_7TV_KEY);
        assert.equal(stored.map.BgEmote, 'https://cdn.7tv.app/emote/bg/2x.webp', 'fresh manifest persisted');
    } finally {
        globalThis.fetch = realFetch;
        await SillyTavern.libs.localforage.removeItem(LF_7TV_KEY);
        _setEmoteManifest({});
    }
});

test('SWR: a failed background revalidate keeps the cached set serving', async () => {
    await SillyTavern.libs.localforage.setItem(LF_7TV_KEY, {
        ts: Date.now() - 3 * 24 * 60 * 60 * 1000,
        map: { KeptEmote: 'https://cdn.7tv.app/emote/kept/2x.webp' },
    });
    const realFetch = globalThis.fetch;
    globalThis.fetch = async (url) => {
        const u = String(url);
        if (u.includes('7tv.io')) throw new Error('network dead');
        if (u.endsWith('/emotes/manifest.json')) return { ok: true, json: async () => ({ emotes: {} }) };
        throw new Error(`unexpected fetch ${u}`);
    };
    try {
        _setEmoteManifest({});
        state.settings.emoteSetId = 'setcached';
        await refreshEmoteManifest();
        await new Promise(r => setTimeout(r, 30));   // revalidate fails
        assert.equal(getEmoteUrl('KeptEmote'), 'https://cdn.7tv.app/emote/kept/2x.webp',
            'failure must NOT null the cached set');
    } finally {
        globalThis.fetch = realFetch;
        await SillyTavern.libs.localforage.removeItem(LF_7TV_KEY);
        _setEmoteManifest({});
    }
});

test('SWR: exactly one background refresh per session per set id', async () => {
    await SillyTavern.libs.localforage.setItem(LF_7TV_KEY, {
        ts: Date.now() - 3 * 24 * 60 * 60 * 1000,
        map: { CachedEmote: 'https://cdn.7tv.app/emote/cached/2x.webp' },
    });
    let sevenTvHits = 0;
    const realFetch = globalThis.fetch;
    globalThis.fetch = async (url) => {
        const u = String(url);
        if (u === 'https://7tv.io/v3/emote-sets/setcached') {
            sevenTvHits++;
            return { ok: true, json: async () => ({ emotes: [{ id: 'bg', name: 'BgEmote' }] }) };
        }
        if (u.endsWith('/emotes/manifest.json')) return { ok: true, json: async () => ({ emotes: {} }) };
        throw new Error(`unexpected fetch ${u}`);
    };
    try {
        _setEmoteManifest({});
        state.settings.emoteSetId = 'setcached';
        await refreshEmoteManifest();
        await refreshEmoteManifest();   // same session, same set id — cache is warm
        await new Promise(r => setTimeout(r, 30));   // let the single background refresh land
        assert.equal(sevenTvHits, 1, 'repeated touches must not re-hit the network');
        assert.equal(getEmoteUrl('BgEmote'), 'https://cdn.7tv.app/emote/bg/2x.webp',
            'the one refresh swapped in the fresh set');
    } finally {
        globalThis.fetch = realFetch;
        await SillyTavern.libs.localforage.removeItem(LF_7TV_KEY);
        _setEmoteManifest({});
    }
});

// ── shipped pack breadth + real 7TV set fixtures ──

test('shipped manifest covers the codes the model hallucinates in the wild', () => {
    const manifest = JSON.parse(readFileSync(
        fileURLToPath(new URL('../emotes/manifest.json', import.meta.url)), 'utf8'));
    const emotes = manifest.emotes;
    const codes = Object.keys(emotes);
    assert.ok(codes.length >= 45, `pack must stay broad, got ${codes.length}`);
    for (const code of ['KEKW', 'WutFace', 'Kappa', 'FeelsOkayMan', 'peepoHappy', 'ApuApustaja', 'BibleThump']) {
        assert.ok(emotes[code], `commonly hallucinated code missing: ${code}`);
    }
    for (const [code, url] of Object.entries(emotes)) {
        assert.match(url, /^https:\/\//, `code ${code} must hotlink over https`);
    }
    for (const code of Object.keys(emotes)) {
        assert.ok(!code.startsWith(':') && !code.endsWith(':'),
            `colon-edge codes can never render through the chip's colon strip: ${code}`);
    }
});

test('real 7TV sets merge over the builtin pack; an id switch swaps the set', async () => {
    // Fixtures mirror the live 7tv.io responses of these two public sets.
    const SET_A = '01M6K7VCV83P707K2521TM39KY';
    const SET_B = '01J7K1Y0ZG0003R88FPG3R1PST';
    const realFetch = globalThis.fetch;
    globalThis.fetch = async (url) => {
        const u = String(url);
        if (u.endsWith(`/emote-sets/${SET_A}`)) {
            return { ok: true, json: async () => ({ emotes: [
                { id: '01F6MZGCNG000255K4X1K7NTHR', name: 'GIGACHAD' },
                { id: '01F61B1440000991F7SWQNMVX7', name: 'KEKW' },
            ] }) };
        }
        if (u.endsWith(`/emote-sets/${SET_B}`)) {
            return { ok: true, json: async () => ({ emotes: [
                { id: '01HD92YYE8000DW97PFPF49BZG', name: 'BLYAT' },
            ] }) };
        }
        if (u.endsWith('/emotes/manifest.json')) {
            return { ok: true, json: async () => ({ emotes: { monkaS: 'https://cdn.betterttv.net/emote/b/2x.webp' } }) };
        }
        throw new Error(`unexpected fetch ${u}`);
    };
    try {
        _setEmoteManifest({});
        state.settings.emoteSetId = SET_A;
        await refreshEmoteManifest();
        assert.equal(getEmoteUrl('GIGACHAD'), `https://cdn.7tv.app/emote/01F6MZGCNG000255K4X1K7NTHR/2x.webp`,
            'set A codes join the manifest in CDN form');
        assert.equal(getEmoteUrl('KEKW'), 'https://cdn.7tv.app/emote/01F61B1440000991F7SWQNMVX7/2x.webp');
        assert.equal(getEmoteUrl('monkaS'), 'https://cdn.betterttv.net/emote/b/2x.webp', 'builtin still merged');

        state.settings.emoteSetId = SET_B;
        await refreshEmoteManifest();
        assert.equal(getEmoteUrl('BLYAT'), 'https://cdn.7tv.app/emote/01HD92YYE8000DW97PFPF49BZG/2x.webp',
            'set B loads after the id switch');
        assert.equal(getEmoteUrl('GIGACHAD'), null, 'the previous set is fully dropped, not stacked');
        assert.equal(getEmoteUrl('monkaS'), 'https://cdn.betterttv.net/emote/b/2x.webp', 'builtin survives the switch');
    } finally {
        globalThis.fetch = realFetch;
        await SillyTavern.libs.localforage.removeItem(`DSComments_7tvSet_${SET_A}`);
        await SillyTavern.libs.localforage.removeItem(`DSComments_7tvSet_${SET_B}`);
        _setEmoteManifest({});
    }
});

