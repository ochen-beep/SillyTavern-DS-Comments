// @ts-check
/**
 * DS Comments — reaction emotes tests (src/emotes.js): whitelist resolution,
 * feature gating, code list for the contract, 7TV set fetch and merging.
 */
import '../test-helpers/stub-runtime.mjs';
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { state } from '../src/core.js';
import { _setEmoteManifest, refreshEmoteManifest, getEmoteUrl, getEmoteCodes } from '../src/emotes.js';

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

test('getEmoteCodes: sorted, deterministic spread under the cap', () => {
    const big = {};
    for (let i = 0; i < 60; i++) big[`Emote${String(i).padStart(2, '0')}`] = `https://cdn/u/${i}.webp`;
    _setEmoteManifest({ builtin: big });
    const codes = getEmoteCodes(48);
    assert.equal(codes.length, 48);
    assert.deepEqual(codes, [...codes].sort());
    assert.ok(codes.includes('Emote00') && codes.includes('Emote59'), 'spread covers both ends');
    // small packs pass through whole
    _setEmoteManifest({ builtin: { monkaS: 'x' } });
    assert.deepEqual(getEmoteCodes(48), ['monkaS']);
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
