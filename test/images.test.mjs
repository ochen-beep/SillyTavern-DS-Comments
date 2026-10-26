// @ts-check
/**
 * DS Comments — post image attachment (multimodality) tests.
 *
 * Covers src/images.js (collection, hashing, attach decision) and the
 * generator integration: images ride the anchor's generation, join the
 * fingerprint, and never leak into image-less prompts.
 */
import '../test-helpers/stub-runtime.mjs';
import test, { beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { state, getCtx } from '../src/core.js';
import {
    collectPostImages, collectInlineImageUrls, computeImagesHash, mediaIdentity, shouldAttachImages,
    planPostImages, loadImageParts, MAX_IMAGES_PER_POST,
} from '../src/images.js';
import { buildGenerationFingerprint, buildGenerationFingerprintInput } from '../src/lorebooks.js';
import { _testGenerateFeed } from '../src/generator.js';
import { _resetFeedFileStore, getFeedSlot } from '../src/feed-file-store.js';

const TINY_PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
const OTHER_PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAEklEQVR42mNkYPhfzwAEgDAGCgoKBAF6scl5AAAAAElFTkSuQmCC';

const aiMsg = (mes, extra) => ({ mes, is_user: false, is_system: false, is_hidden: false, swipe_id: 0, swipes: [mes], extra });
const img = (url, type = 'image') => ({ url, type });

beforeEach(() => {
    Object.assign(state, {
        settings: {},
        generationInProgress: false, generationOwner: null, abortController: null,
        generationTarget: null, generationObservedTarget: null, queuedGeneration: null,
        pendingActivatedWorldInfo: null,
    });
    state.pinnedFeeds?.clear();
    const ctx = getCtx();
    Object.assign(ctx, { chatId: 'chatA', chat: [], chatMetadata: {}, saveMetadata: () => {}, name1: 'User', name2: 'Char', substituteParams: t => t });
    delete ctx.getWorldInfoPrompt;
    delete ctx.loadWorldInfo;
    globalThis._stFilesReset?.();
    _resetFeedFileStore();
});

// ── collectPostImages ──

test('collectPostImages: list mode collects image attachments, skips video/audio/empty', () => {
    const msg = aiMsg('post', { media: [img('a.png'), img('v.mp4', 'video'), img('b.png'), { url: '' }, img('c.png')] });
    assert.deepEqual(collectPostImages(msg, 0).map(m => m.url), ['a.png', 'b.png', 'c.png']);
});

test('collectPostImages: caps at MAX_IMAGES_PER_POST and treats missing type as image', () => {
    const media = Array.from({ length: 8 }, (_, i) => ({ url: `u${i}.png` }));
    const out = collectPostImages(aiMsg('post', { media }), 0);
    assert.equal(out.length, MAX_IMAGES_PER_POST);
    assert.equal(out[0].url, 'u0.png');
});

test('collectPostImages: gallery mode yields only the shown image (media_index over the FULL array)', () => {
    const msg = aiMsg('post', { media: [img('a.png'), img('b.png'), img('c.png')], media_display: 'gallery', media_index: 1 });
    assert.deepEqual(collectPostImages(msg, 0).map(m => m.url), ['b.png']);
    // index pointing at a non-image yields nothing
    const msg2 = aiMsg('post', { media: [img('v.mp4', 'video'), img('b.png')], media_display: 'gallery', media_index: 0 });
    assert.deepEqual(collectPostImages(msg2, 0), []);
});

test('collectPostImages: swipe-level extra wins over message-level', () => {
    const msg = aiMsg('post', { media: [img('msg-level.png')] });
    msg.swipe_info = [{ send_date: 'x', extra: { media: [img('swipe0.png')] } }, { send_date: 'y', extra: { media: [img('swipe1.png')] } }];
    assert.deepEqual(collectPostImages(msg, 1).map(m => m.url), ['swipe1.png']);
    // swipe slot without its own media falls back to message-level
    msg.swipe_info[1].extra = {};
    assert.deepEqual(collectPostImages(msg, 1).map(m => m.url), ['msg-level.png']);
});

// ── hashing ──

test('computeImagesHash: empty for no images; changes with the identity set', () => {
    assert.equal(computeImagesHash([]), '');
    const a = computeImagesHash([{ url: 'a.png' }]);
    const b = computeImagesHash([{ url: 'b.png' }]);
    assert.notEqual(a, b);
    assert.equal(a, computeImagesHash([{ url: 'a.png', title: 'ignored' }]));
});

test('mediaIdentity: data URLs hash by mime+length+edges, not full content', () => {
    const id = mediaIdentity({ url: TINY_PNG });
    assert.match(id, /^data:image\/png;len=\d+;/);
    assert.ok(id.length < 250);
    assert.notEqual(mediaIdentity({ url: TINY_PNG }), mediaIdentity({ url: OTHER_PNG }));
});

// ── shouldAttachImages ──

test('shouldAttachImages: matrix over mode × source × profile', () => {
    const base = { apiSource: 'profile', customModel: '' };
    // off never attaches
    assert.equal(shouldAttachImages({ ...base, includeImages: 'off' }, { api: 'openai', model: 'gemini-3-pro' }), false);
    // always attaches on chat-completion profiles, blocked on textcompletion
    assert.equal(shouldAttachImages({ ...base, includeImages: 'always' }, { api: 'openai', model: 'some-text-model' }), true);
    assert.equal(shouldAttachImages({ ...base, includeImages: 'always' }, { api: 'textgenerationwebui', model: 'x' }), false);
    // CM 'custom' profiles (OpenAI-compatible) route to chat completions — must NOT be blocked
    assert.equal(shouldAttachImages({ ...base, includeImages: 'auto' }, { api: 'custom', model: 'gemini-3.5-flash-lite' }), true);
    // auto: vision heuristic on the profile model
    assert.equal(shouldAttachImages({ ...base, includeImages: 'auto' }, { api: 'openai', model: 'gemini-3.1-pro-preview' }), true);
    assert.equal(shouldAttachImages({ ...base, includeImages: 'auto' }, { api: 'openai', model: 'claude-sonnet-4' }), true);
    assert.equal(shouldAttachImages({ ...base, includeImages: 'auto' }, { api: 'openai', model: 'mistral-small-text' }), false);
    assert.equal(shouldAttachImages({ ...base, includeImages: 'auto' }, null), false);
    // custom source: always=yes; auto follows customModel, conservative without one
    assert.equal(shouldAttachImages({ apiSource: 'custom', includeImages: 'always' }, null), true);
    assert.equal(shouldAttachImages({ apiSource: 'custom', includeImages: 'auto', customModel: 'gpt-4o' }, null), true);
    assert.equal(shouldAttachImages({ apiSource: 'custom', includeImages: 'auto', customModel: '' }, null), false);
    // default (absent setting) = off
    assert.equal(shouldAttachImages({ apiSource: 'profile' }, { api: 'openai', model: 'gpt-4o' }), false);
});

// ── fingerprint ──

test('fingerprint: imagesHash is conditional — image-less inputs keep the legacy value', () => {
    const settings = { userCount: 5, includeChatHistory: true, contextDepth: 4 };
    const legacy = buildGenerationFingerprint(buildGenerationFingerprintInput({ settings, loreConfig: null, stylePrompt: 's', profile: null }));
    const withEmpty = buildGenerationFingerprint(buildGenerationFingerprintInput({ settings, loreConfig: null, stylePrompt: 's', profile: null, imagesHash: '' }));
    assert.equal(withEmpty, legacy, 'empty imagesHash must not change the fp');
    const withImages = buildGenerationFingerprint(buildGenerationFingerprintInput({ settings, loreConfig: null, stylePrompt: 's', profile: null, imagesHash: 'abc123' }));
    assert.notEqual(withImages, legacy);
});

// ── generation integration ──

function setupImageGeneration({ extra } = {}) {
    state.settings = {
        enabled: true, autoUpdate: true, noSaveMode: false,
        apiSource: 'custom', customEndpoint: 'http://x', customModel: 'gpt-4o',
        promptTemplate: 'main', userCount: 3, includeChatHistory: false,
        contextDepth: 4, includePersona: false, includeCharacterDescription: false,
        enableJailbreakBlock: false, jailbreakRole: 'system',
        profileId: '', soundEnabled: false,
        promptTemplates: { main: 'Generate {{count}} comments.' },
        includeImages: 'always',
    };
    getCtx().chat = [aiMsg('a post with a picture', extra)];
    getCtx().chatMetadata = { dscomments_commentary: { posts: {}, current: { msgId: null, swipeIdx: 0 } } };
}

const validResponse = JSON.stringify([{ username: 'n', content: 'c', reactions: [] }]);

test('generateFeed: attaches images as a trailing user message with content array', async () => {
    setupImageGeneration({ extra: { media: [img(TINY_PNG)] } });
    let captured = null;
    await _testGenerateFeed('0', 0, true, async (_sys, userMsgs) => { captured = userMsgs; return validResponse; });

    const last = captured.at(-1);
    assert.ok(Array.isArray(last), 'last user message must be a content array when images attach');
    assert.equal(last[0].type, 'text');
    assert.match(last[0].text, /attached image/);
    const imageParts = last.filter(p => p.type === 'image_url');
    assert.equal(imageParts.length, 1);
    assert.ok(imageParts[0].image_url.url.startsWith('data:image/'));
    assert.equal(imageParts[0].image_url.detail, 'low');
    // text blocks before it stay plain strings
    assert.ok(captured.slice(0, -1).every(m => typeof m === 'string'));
});

test('generateFeed: image-less post keeps string-only user messages (no regression)', async () => {
    setupImageGeneration({ extra: undefined });
    let captured = null;
    await _testGenerateFeed('0', 0, true, async (_sys, userMsgs) => { captured = userMsgs; return validResponse; });
    assert.ok(captured.every(m => typeof m === 'string'));
});

test('generateFeed: includeImages=off ignores attached media entirely', async () => {
    setupImageGeneration({ extra: { media: [img(TINY_PNG)] } });
    state.settings.includeImages = 'off';
    let captured = null;
    await _testGenerateFeed('0', 0, true, async (_sys, userMsgs) => { captured = userMsgs; return validResponse; });
    assert.ok(captured.every(m => typeof m === 'string'));
});

test('generateFeed: stored generationFp changes when the post image changes', async () => {
    setupImageGeneration({ extra: { media: [img(TINY_PNG)] } });
    await _testGenerateFeed('0', 0, true, async () => validResponse);
    const fp1 = getFeedSlot('0', 0)?.generationFp;
    assert.match(fp1, /^v1-/);

    getCtx().chat[0].extra.media = [img(OTHER_PNG)];
    await _testGenerateFeed('0', 0, true, async () => validResponse);
    const fp2 = getFeedSlot('0', 0)?.generationFp;
    assert.notEqual(fp2, fp1, 'a changed image must change the generation fingerprint');
});

test('generateFeed: failed image loads fall back to text-only (never abort the run)', async () => {
    setupImageGeneration({ extra: { media: [img('/user/files/definitely-missing-image.png')] } });
    let captured = null;
    await _testGenerateFeed('0', 0, true, async (_sys, userMsgs) => { captured = userMsgs; return validResponse; });
    assert.ok(captured.every(m => typeof m === 'string'), 'all images failed → plain string messages');
});

test('loadImageParts: skips failures, keeps good images', async () => {
    const parts = await loadImageParts([{ url: TINY_PNG }, { url: '' }, { url: '/user/files/missing.png' }]);
    assert.equal(parts.length, 1);
    assert.equal(parts[0].type, 'image_url');
});

test('planPostImages: hash only when attaching; collect-independent of mode', () => {
    const msg = aiMsg('p', { media: [img('a.png')] });
    const on = planPostImages(msg, 0, { apiSource: 'custom', customModel: 'gpt-4o', includeImages: 'always' }, null);
    assert.equal(on.attach, true);
    assert.ok(on.hash);
    const off = planPostImages(msg, 0, { apiSource: 'custom', customModel: 'gpt-4o', includeImages: 'off' }, null);
    assert.equal(off.attach, false);
    assert.equal(off.hash, '');
    const none = planPostImages(aiMsg('p'), 0, { includeImages: 'always' }, null);
    assert.deepEqual(none, { images: [], attach: false, hash: '', reason: '' });
});

// ── inline <img> tags in the message text (sillyimages-style embeds) ──

test('collectInlineImageUrls: extracts src from img tags, caps at max, tolerates junk', () => {
    assert.deepEqual(collectInlineImageUrls('no images here'), []);
    assert.deepEqual(collectInlineImageUrls(null), []);
    const text = `text <img src="/user/files/a.png" data-iig-instruction='x'> more <img class="q" src = "b.png"/> <video poster="p.png"></video>`;
    assert.deepEqual(collectInlineImageUrls(text), ['/user/files/a.png', 'b.png'], 'img src only; video poster ignored');
    const many = Array.from({ length: 9 }, (_, i) => `<img src="u${i}.png">`).join(' ');
    assert.equal(collectInlineImageUrls(many).length, MAX_IMAGES_PER_POST);
});

test('planPostImages: inline images merge with extra.media, deduped by URL, capped', () => {
    const msg = aiMsg(`text <img src="a.png"> <img src="b.png">`, { media: [img('a.png'), img('c.png')] });
    const plan = planPostImages(msg, 0, { apiSource: 'custom', customModel: 'gpt-4o', includeImages: 'always' }, null);
    assert.deepEqual(plan.images.map(i => i.url), ['a.png', 'c.png', 'b.png'], 'extra.media first, inline after, no duplicates');
    assert.ok(plan.hash);
});

test('planPostImages: inline images are read from the REQUESTED swipe, not the active one', () => {
    const msg = aiMsg('swipe zero <img src="s0.png">');
    msg.swipes = ['swipe zero <img src="s0.png">', 'swipe one <img src="s1.png">'];
    const plan = planPostImages(msg, 1, { apiSource: 'custom', customModel: 'gpt-4o', includeImages: 'always' }, null);
    assert.deepEqual(plan.images.map(i => i.url), ['s1.png']);
});
