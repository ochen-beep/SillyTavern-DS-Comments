// @ts-check
/**
 * DS Comments — comment media attachments tests.
 *
 * Covers src/media.js (Giphy search, memegen templates + URL building,
 * URL allowlist, per-feed cache, failure degradation) plus the parser/renderer
 * integration for the media request fields.
 */
import '../test-helpers/stub-runtime.mjs';
import test, { beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import {
    isAllowedMediaUrl,
    encodeMemeText,
    resolveMemeTemplate,
    buildMemeUrl,
    resolveCommentMedia,
    _resetMemeTemplateCache,
} from '../src/media.js';
import { parseCommentary } from '../src/parser.js';

// ── fetch mock plumbing ──
const realFetch = globalThis.fetch;
let fetchCalls = [];
let fetchHandler = null;

beforeEach(() => {
    fetchCalls = [];
    fetchHandler = null;
    globalThis.fetch = async (url, init = {}) => {
        fetchCalls.push({ url: String(url), init });
        if (fetchHandler) return fetchHandler(String(url), init);
        return { ok: false, status: 599, json: async () => ({}), text: async () => '' };
    };
    _resetMemeTemplateCache();
});

// ── isAllowedMediaUrl ──

test('allowlist: accepts Giphy/memegen CDN URLs', () => {
    assert.equal(isAllowedMediaUrl('https://media2.giphy.com/media/abc/giphy.gif'), true);
    assert.equal(isAllowedMediaUrl('https://media.giphy.com/media/abc/giphy-downsized.gif'), true);
    assert.equal(isAllowedMediaUrl('https://i.giphy.com/abc.gif'), true);
    assert.equal(isAllowedMediaUrl('https://api.memegen.link/images/drake/a/b.png'), true);
});

test('allowlist: rejects everything else', () => {
    assert.equal(isAllowedMediaUrl('http://media.giphy.com/abc.gif'), false);          // not https
    assert.equal(isAllowedMediaUrl('https://media.giphy.com.evil.com/a.gif'), false);  // suffix spoof
    // Tenor was dropped from the provider set (API closed 2026-06-30) — its CDN
    // must not be renderable either, in case an old cached feed carries one.
    assert.equal(isAllowedMediaUrl('https://media1.tenor.com/abc/xyz.gif'), false);
    assert.equal(isAllowedMediaUrl('https://example.com/a.gif'), false);
    assert.equal(isAllowedMediaUrl('javascript:alert(1)'), false);
    assert.equal(isAllowedMediaUrl(''), false);
    assert.equal(isAllowedMediaUrl(null), false);
    // memegen base itself must not pass — only /images/ paths
    assert.equal(isAllowedMediaUrl('https://api.memegen.link/templates/'), false);
});

// ── encodeMemeText ──

test('memegen text encoding: spaces→_, escapes, doubled literals', () => {
    assert.equal(encodeMemeText('hello world'), 'hello_world');
    assert.equal(encodeMemeText('what?'), 'what~q');
    assert.equal(encodeMemeText('a/b'), 'a~sb');
    assert.equal(encodeMemeText('a&b'), 'a~ab');
    assert.equal(encodeMemeText('line1\nline2'), 'line1~nline2');
    assert.equal(encodeMemeText('say "hi"'), "say_''hi''");
    assert.equal(encodeMemeText('snake_case'), 'snake__case');
    assert.equal(encodeMemeText('dash-dash'), 'dash--dash');
    assert.equal(encodeMemeText('  padded  '), 'padded');
    assert.equal(encodeMemeText(''), '');
    // Non-ASCII (Cyrillic) is percent-encoded, not dropped.
    assert.equal(encodeMemeText('кот'), encodeURIComponent('кот'));
});

// ── resolveMemeTemplate ──

const TEMPLATES = [
    { id: 'drake', name: 'Drakeposting', keywords: ['drake hotline bling'], lines: 2 },
    { id: 'ds', name: 'Daily Struggle', keywords: ['two buttons'], lines: 2 },
    { id: 'db', name: 'Distracted Boyfriend', keywords: [], lines: 3 },
    { id: 'cmm', name: 'Change My Mind', keywords: [], lines: 1 },
];

test('meme template resolution: alias → canonical id, then id/name/keyword fuzzy', () => {
    // Vernacular aliases map to canonical memegen ids
    assert.equal(resolveMemeTemplate('two buttons', TEMPLATES).id, 'ds');
    assert.equal(resolveMemeTemplate('Two Buttons', TEMPLATES).id, 'ds');
    assert.equal(resolveMemeTemplate('distracted boyfriend', TEMPLATES).id, 'db');
    // exact id / name / keyword
    assert.equal(resolveMemeTemplate('drake', TEMPLATES).id, 'drake');
    assert.equal(resolveMemeTemplate('Drakeposting', TEMPLATES).id, 'drake');
    assert.equal(resolveMemeTemplate('drake hotline bling', TEMPLATES).id, 'drake');
    // prefix: "distract" → "db" (Distracted Boyfriend)
    assert.equal(resolveMemeTemplate('distract', TEMPLATES).id, 'db');
    assert.equal(resolveMemeTemplate('nonexistent-template', TEMPLATES), null);
    assert.equal(resolveMemeTemplate('', TEMPLATES), null);
    assert.equal(resolveMemeTemplate('drake', []), null);
});

// ── buildMemeUrl ──

test('meme URL building: 1/2/3-line templates, single encoding', () => {
    const drake = TEMPLATES[0];
    const db = TEMPLATES[2];   // lines: 3
    const cmm = TEMPLATES[3];  // lines: 1
    assert.equal(
        buildMemeUrl(drake, { template: 'drake', top: 'no gifs', bottom: 'gifs!' }),
        'https://api.memegen.link/images/drake/no_gifs/gifs!.png',
    );
    // empty bottom still yields both segments (stable shape for 2-line)
    assert.equal(
        buildMemeUrl(drake, { template: 'drake', top: 'only top', bottom: '' }),
        'https://api.memegen.link/images/drake/only_top/.png',
    );
    // 3-line template: top → first, bottom → last, middles stay empty
    assert.equal(
        buildMemeUrl(db, { template: 'db', top: 'me', bottom: 'her' }),
        'https://api.memegen.link/images/db/me//her.png',
    );
    // 1-line templates take the caption alone
    assert.equal(
        buildMemeUrl(cmm, { template: 'cmm', top: 'me', bottom: 'ignored' }),
        'https://api.memegen.link/images/cmm/me.png',
    );
    // Cyrillic is percent-encoded exactly once and switches to the unicode font
    // (memegen's impact has no cyrillic glyphs and silently drops the caption)
    const url = buildMemeUrl(drake, { template: 'drake', top: 'кот', bottom: '' });
    assert.equal(url, 'https://api.memegen.link/images/drake/' + encodeURIComponent('кот') + '/.png?font=notosans');
    assert.equal(buildMemeUrl(null, { template: 'x' }), null);
});

// ── Giphy search ──

test('resolveCommentMedia: Giphy rating mapping and sticker endpoint', async () => {
    fetchHandler = (url) => {
        const u = new URL(url);
        const sticker = url.startsWith('https://api.giphy.com/v1/stickers/');
        return {
            ok: true,
            json: async () => ({
                data: [{ images: { downsized: { url: sticker ? 'https://media2.giphy.com/s.gif' : 'https://media2.giphy.com/g.gif' } } }],
            }),
        };
    };
    const messages = [{ username: 'a', content: 'hi', gif: 'no way' }];
    const n = await resolveCommentMedia(messages, { provider: 'giphy', giphyKey: 'G', rating: 'high' });
    assert.equal(n, 1);
    assert.ok(fetchCalls[0].url.startsWith('https://api.giphy.com/v1/gifs/search'));
    assert.ok(fetchCalls[0].url.includes('api_key=G'));
    assert.ok(fetchCalls[0].url.includes('rating=pg-13'));
    // stickers route to /v1/stickers/search
    const messages2 = [{ username: 'b', content: 'x', sticker: 'clap' }];
    await resolveCommentMedia(messages2, { provider: 'giphy', giphyKey: 'G', rating: 'low', stickersEnabled: true });
    assert.ok(fetchCalls[1].url.startsWith('https://api.giphy.com/v1/stickers/search'));
    assert.ok(fetchCalls[1].url.includes('rating=g'));
});

test('resolveCommentMedia: no key or disabled provider → text-only, no fetches', async () => {
    const messages = [{ username: 'a', content: 'x', gif: 'cat' }];
    const n = await resolveCommentMedia(messages, { provider: 'giphy', giphyKey: '', rating: 'medium' });
    assert.equal(n, 0);
    assert.equal(messages[0].media, undefined);
    assert.equal(fetchCalls.length, 0);
    const n2 = await resolveCommentMedia([{ username: 'a', content: 'x', gif: 'cat' }], { provider: 'off' });
    assert.equal(n2, 0);
    assert.equal(fetchCalls.length, 0);
});

test('resolveCommentMedia: provider failure / empty results degrade to text-only', async () => {
    fetchHandler = () => ({ ok: false, status: 500, json: async () => ({}) });
    const messages = [{ username: 'a', content: 'x', gif: 'cat' }];
    const n = await resolveCommentMedia(messages, { provider: 'giphy', giphyKey: 'G', rating: 'medium' });
    assert.equal(n, 0);
    assert.equal(messages[0].media, undefined);
    // HTTP 200 but zero usable results (Giphy payload shape)
    fetchHandler = () => ({ ok: true, json: async () => ({ data: [] }) });
    const n2 = await resolveCommentMedia([{ username: 'a', content: 'y', gif: 'dog' }], { provider: 'giphy', giphyKey: 'G', rating: 'medium' });
    assert.equal(n2, 0);
});

test('resolveCommentMedia: non-allowlisted provider URL is dropped', async () => {
    fetchHandler = () => ({
        ok: true,
        json: async () => ({ data: [{ images: { downsized: { url: 'https://evil.example.com/x.gif' } } }] }),
    });
    const messages = [{ username: 'a', content: 'x', gif: 'cat' }];
    const n = await resolveCommentMedia(messages, { provider: 'giphy', giphyKey: 'G', rating: 'medium' });
    assert.equal(n, 0);
    assert.equal(messages[0].media, undefined);
});

test('resolveCommentMedia: identical queries share one fetch (per-feed cache)', async () => {
    fetchHandler = () => ({
        ok: true,
        json: async () => ({ data: [{ images: { downsized: { url: 'https://media.giphy.com/g.gif' } } }] }),
    });
    const messages = [
        { username: 'a', content: 'x', gif: 'Cat SHOCKED' },
        { username: 'b', content: 'y', gif: 'cat shocked' },
    ];
    const n = await resolveCommentMedia(messages, { provider: 'giphy', giphyKey: 'G', rating: 'medium' });
    assert.equal(n, 2);
    assert.equal(fetchCalls.length, 1);
});

test('resolveCommentMedia: abort propagates', async () => {
    const controller = new AbortController();
    controller.abort();
    fetchHandler = (url, init) => {
        if (init?.signal?.aborted) {
            const e = new Error('aborted');
            e.name = 'AbortError';
            return Promise.reject(e);
        }
        return Promise.resolve({ ok: true, json: async () => ({ data: [] }) });
    };
    await assert.rejects(
        resolveCommentMedia([{ username: 'a', content: 'x', gif: 'cat' }], {
            provider: 'giphy', giphyKey: 'G', rating: 'medium', signal: controller.signal,
        }),
        (e) => e?.name === 'AbortError',
    );
});

// ── memes end-to-end ──

test('resolveCommentMedia: meme recipe → templates fetch → memegen URL', async () => {
    fetchHandler = (url) => {
        assert.equal(url, 'https://api.memegen.link/templates/');
        return { ok: true, json: async () => TEMPLATES };
    };
    const messages = [{ username: 'a', content: 'lol', meme: { template: 'Drake Posting', top: 'text only', bottom: 'gifs too' } }];
    const n = await resolveCommentMedia(messages, { provider: 'off', memeEnabled: true });
    assert.equal(n, 1);
    assert.equal(messages[0].media.type, 'meme');
    assert.equal(messages[0].media.url, 'https://api.memegen.link/images/drake/text_only/gifs_too.png');
    assert.ok(/drake/i.test(messages[0].media.alt));
});

test('resolveCommentMedia: unknown meme template → text-only', async () => {
    fetchHandler = () => ({ ok: true, json: async () => TEMPLATES });
    const messages = [{ username: 'a', content: 'lol', meme: { template: 'zzz-not-real', top: 'a', bottom: 'b' } }];
    const n = await resolveCommentMedia(messages, { provider: 'off', memeEnabled: true });
    assert.equal(n, 0);
    assert.equal(messages[0].media, undefined);
});

test('resolveCommentMedia: memes work without provider; disabled when off', async () => {
    const n0 = await resolveCommentMedia(
        [{ username: 'a', content: 'x', meme: { template: 'drake', top: 'a', bottom: 'b' } }],
        { provider: 'off', memeEnabled: false },
    );
    assert.equal(n0, 0);
    assert.equal(fetchCalls.length, 0);
});

// ── parser integration ──

test('parser: media fields survive the parse ladder', () => {
    const parsed = parseCommentary('[{"username":"a","content":"wow","gif":"cat shocked"},{"username":"b","content":"nice","sticker":"thumbs up"},{"username":"c","content":"","meme":{"template":"drake","top":"no","bottom":"yes"}}]');
    assert.equal(parsed.length, 3);
    assert.equal(parsed[0].gif, 'cat shocked');
    assert.equal(parsed[0].sticker, '');
    assert.equal(parsed[0].meme, null);
    assert.equal(parsed[1].sticker, 'thumbs up');
    assert.equal(parsed[1].gif, '');
    assert.equal(parsed[2].content, '');
    assert.deepEqual(parsed[2].meme, { template: 'drake', top: 'no', bottom: 'yes' });
});

test('parser: one media field per message (gif wins over sticker/meme)', () => {
    const parsed = parseCommentary('[{"username":"a","content":"x","gif":"cat","sticker":"dog","meme":{"template":"t"}}]');
    assert.equal(parsed[0].gif, 'cat');
    assert.equal(parsed[0].sticker, '');
    assert.equal(parsed[0].meme, null);
});

test('parser: media-only comment is kept; textless comment without media is dropped', () => {
    const parsed = parseCommentary('[{"username":"a","content":"","gif":"cat"},{"username":"b","content":""}]');
    assert.equal(parsed.length, 1);
    assert.equal(parsed[0].gif, 'cat');
});

test('parser: oversized/broken media fields are cleaned', () => {
    const parsed = parseCommentary('[{"username":"a","content":"x","gif":"  spaced   query  "},{"username":"b","content":"y","meme":{"template":"  ","top":"nope"}}]');
    assert.equal(parsed[0].gif, 'spaced query');
    // meme without a usable template hint → null, but content keeps the message alive
    assert.equal(parsed[1].meme, null);
});

// ── template-specific text placement ──

test('meme URL building: Daily Struggle puts both captions on the buttons', () => {
    // ds has 3 text zones [button1, button2, bottom guy]; the model writes two
    // captions, both belong on the buttons, the bottom strip stays unlabeled.
    const ds = { id: 'ds', name: 'Daily Struggle', keywords: ['two buttons'], lines: 3 };
    assert.equal(
        buildMemeUrl(ds, { template: 'ds', top: 'poechat za tabletkami', bottom: 'sidet doma' }),
        'https://api.memegen.link/images/ds/poechat_za_tabletkami/sidet_doma/.png',   // latin captions → default impact
    );
    // cyrillic variant keeps the unicode font
    const cyr = encodeURIComponent('поехать');
    const url = buildMemeUrl(ds, { template: 'ds', top: 'поехать', bottom: 'сидеть' });
    assert.ok(url.endsWith(`/${cyr}/${encodeURIComponent('сидеть')}/.png?font=notosans`));
});

test('meme URL building: default 3-line layout keeps middle empty (regression)', () => {
    const db = { id: 'db', name: 'Distracted Boyfriend', keywords: [], lines: 3 };
    assert.equal(
        buildMemeUrl(db, { template: 'db', top: 'me', bottom: 'her' }),
        'https://api.memegen.link/images/db/me//her.png',
    );
});
