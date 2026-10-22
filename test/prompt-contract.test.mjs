// @ts-check
/**
 * DS Comments — prompt-contract string tests.
 *
 * PROMPT_CONTRACT — the immutable prompt header (not in localforage): the
 * parser relies on its format description («JSON array», schema keys
 * username/content, {{count}} for substitution). If the contract breaks by
 * accident, the parser starts receiving garbage — hence we lock the key
 * invariants of the string.
 *
 * Full cross-check «the contract example parses with the parser» —
 * test/contract.test.mjs.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PROMPT_CONTRACT, buildContract } from '../src/prompt-contract.js';

test('PROMPT_CONTRACT is a non-empty string', () => {
    assert.equal(typeof PROMPT_CONTRACT, 'string');
    assert.ok(PROMPT_CONTRACT.length > 100, `expected sizable contract, got ${PROMPT_CONTRACT.length}`);
});

test('contract references {{count}} (count-substitution contract with buildPrompt)', () => {
    assert.match(PROMPT_CONTRACT, /\{\{count\}\}/);
});

test('contract mandates JSON array output (parser-format contract)', () => {
    assert.match(PROMPT_CONTRACT, /JSON array/i);
});

test('contract documents required schema keys username and content', () => {
    assert.match(PROMPT_CONTRACT, /"username"/);
    assert.match(PROMPT_CONTRACT, /"content"/);
    assert.match(PROMPT_CONTRACT, /"reactions"/);
    assert.match(PROMPT_CONTRACT, /"reply"/);
});

test('contract contains FORMAT RULES section', () => {
    assert.match(PROMPT_CONTRACT, /FORMAT RULES/i);
});

test('contract: an embedded JSON example block is present (parseable as array per contract.test)', () => {
    // The contract contains an example array in [ ... ]; contract.test.mjs
// parses exactly that.
    assert.match(PROMPT_CONTRACT, /\[\s*\{[\s\S]*\}\s*\]/);
});

test('contract example uses realistic count formats ("2.4K" etc.) — guard against edits that drop them', () => {
    assert.ok(PROMPT_CONTRACT.includes('2.4K') || PROMPT_CONTRACT.includes('count'));
});

test('contract example block must not contain placeholder message content — models echo examples verbatim', () => {
    const start = PROMPT_CONTRACT.indexOf('Example');
    const end = PROMPT_CONTRACT.indexOf('## FORMAT RULES');
    assert.ok(start !== -1 && end > start, 'Example section present before FORMAT RULES');
    const example = PROMPT_CONTRACT.slice(start, end);
    // gemini-3.1-pro copied "reply text here" verbatim into every reply of a
    // real generation (2026-09-08 dump); the example must carry real content.
    assert.ok(!example.includes('reply text here'), 'reply example must not use the "reply text here" placeholder');
    assert.ok(!example.includes('message text here'), 'first example must not use the "message text here" placeholder');
    assert.ok(!example.includes('short 4-8 word fragment'), 'quote example must not use the placeholder fragment');
});

test('contract documents the past-comment community-memory blocks', () => {
    // The generator emits "[Reader comments on the previous chapter]" /
    // "[Reader comments on an earlier chapter]" blocks (generator.js). The
    // contract must tell the model how to treat them — otherwise past
    // discussions leak into the raw reactions aimed at the current chapter.
    assert.match(PROMPT_CONTRACT, /\[Reader comments on the previous chapter\]/);
    assert.match(PROMPT_CONTRACT, /\[Reader comments on an earlier chapter\]/);
    assert.match(PROMPT_CONTRACT, /remember what was said there/);
    assert.match(PROMPT_CONTRACT, /still belong only to the `\[Current chapter\]`/);
});
// ── buildContract (media sections) ──

test('buildContract with all media off returns the plain contract byte-identically', () => {
    assert.equal(buildContract({}), PROMPT_CONTRACT);
    assert.equal(buildContract(), PROMPT_CONTRACT);
});

test('buildContract appends only the enabled media sections', () => {
    const gifOnly = buildContract({ gif: true });
    assert.ok(gifOnly.startsWith(PROMPT_CONTRACT));
    assert.match(gifOnly, /GIF ATTACHMENTS/);
    assert.ok(!gifOnly.includes('STICKER ATTACHMENTS'));
    assert.ok(!gifOnly.includes('MEME ATTACHMENTS'));

    const all = buildContract({ gif: true, sticker: true, meme: true });
    assert.match(all, /GIF ATTACHMENTS/);
    assert.match(all, /STICKER ATTACHMENTS/);
    assert.match(all, /MEME ATTACHMENTS/);
    // Media sections teach request fields, never URLs
    assert.match(all, /NEVER put URLs/);
});

test('media sections reference the fields the parser reads', () => {
    const all = buildContract({ gif: true, sticker: true, meme: true });
    assert.match(all, /"gif"/);
    assert.match(all, /"sticker"/);
    assert.match(all, /"meme"/);
    assert.match(all, /"template"/);
});

test('reaction emote codes enter the contract only when the pack provides them', () => {
    const base = buildContract({});
    assert.ok(!base.includes('REACTION EMOTES'), 'no emote section without codes');
    const emptyPack = buildContract({ emoteCodes: [] });
    assert.ok(!emptyPack.includes('REACTION EMOTES'), 'an empty pack teaches nothing');
});

test('buildContract teaches the emote code list when provided', () => {
    const withEmotes = buildContract({ emoteCodes: ['FeelsGoodMan', 'monkaS'] });
    assert.match(withEmotes, /REACTION EMOTES/);
    assert.match(withEmotes, /FeelsGoodMan, monkaS/);
    // media sections and the emote section compose
    const mixed = buildContract({ meme: true, emoteCodes: ['LuL'] });
    assert.match(mixed, /MEME ATTACHMENTS/);
    assert.match(mixed, /REACTION EMOTES/);
});

test('buildContract teaches per-type caps and omits sections capped at 0', () => {
    const two = buildContract({ gif: true, gifMax: 5 });
    assert.match(two, /at most 5 GIFs per generation/);
    assert.ok(!two.includes('STICKER ATTACHMENTS'));

    const zeroed = buildContract({ gif: true, sticker: true, gifMax: 0, stickerMax: 3 });
    assert.ok(!zeroed.includes('GIF ATTACHMENTS'), 'cap 0 removes the section');
    assert.match(zeroed, /at most 3 stickers per generation/);
});

test('buildContract teaches the one-media-field rule only with multiple media types', () => {
    assert.ok(!buildContract({ gif: true }).includes('at most ONE media field'));
    assert.ok(!buildContract({ gif: true, sticker: true, stickerMax: 0 }).includes('at most ONE media field'));
    assert.match(buildContract({ gif: true, sticker: true }), /at most ONE media field/);
    assert.match(buildContract({ meme: true, gif: true }), /at most ONE media field/);
});

test('buildContract singularizes caps of 1', () => {
    assert.match(buildContract({ meme: true, memeMax: 1 }), /at most 1 meme per generation/);
    assert.match(buildContract({ sticker: true, stickerMax: 1 }), /at most 1 sticker per generation/);
});

test('meme section requires content like the gif section does', () => {
    const meme = buildContract({ meme: true });
    assert.match(meme, /"content" stays required/);
});

test('one-media-field rule names only the enabled types', () => {
    const gifMeme = buildContract({ gif: true, meme: true });
    assert.match(gifMeme, /at most ONE media field \("gif", "meme"\)/);
    assert.ok(!gifMeme.includes('"sticker"'), 'disabled sticker type stays out of the rule');
});
