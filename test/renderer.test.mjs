// @ts-check
/**
 * DS Comments — renderer unit tests.
 *
 * renderMessages: HTML generation from parsed messages. Checks
 * mini-markdown (bold/italic/code/strike/br), reply-bar, reactions (all
 * chips, count omitted when empty), and the XSS contract — username / reply-name /
 * quote / emoji / count go through escapeHtml. content passes through
 * «sanitize» (identity in the stub), so its XSS safety is delegated to
 * DOMPurify and a separate contract test, not here.
 */

import '../test-helpers/stub-runtime.mjs';
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { state } from '../src/core.js';
import { renderMessages, upgradeMediaPlaceholders } from '../src/renderer.js';
import { _setEmoteManifest } from '../src/emotes.js';

beforeEach(() => {
    state.settings = { reactionEmotes: true };
    _setEmoteManifest({ builtin: { monkaS: 'https://cdn.betterttv.net/emote/b/2x.webp' } });
});

const msg = (o) => ({ username: o.username ?? 'u', content: o.content ?? '', replyTo: o.replyTo ?? null, replyQuote: o.replyQuote ?? null, reactions: o.reactions ?? [], media: o.media, gif: o.gif, sticker: o.sticker, meme: o.meme });

// ── degenerate ──

test('renderMessages([]) → ""', () => {
    assert.equal(renderMessages([]), '');
});

test('renderMessages non-array → ""', () => {
    assert.equal(renderMessages(null), '');
    assert.equal(renderMessages(undefined), '');
    assert.equal(renderMessages('nope'), '');
});

// ── basic structure ──

test('single message: contains dsc_message, escaped username, data-username, hsl nick color', () => {
    const html = renderMessages([msg({ username: 'alice', content: 'hi' })]);
    assert.match(html, /class="dsc_message"/);
    assert.match(html, /class="dsc_username"/);
    assert.match(html, /data-username="alice">alice</);
    assert.match(html, /--dsc-nick-hue:\d+/);
    assert.match(html, /--dsc-nick-a:hsl\(\d+, 80%, 65%\)/);
    assert.match(html, /class="dsc_header"/);
    assert.ok(html.indexOf('<div class="dsc_content">') > -1);
});

// ── mini-markdown ──

test('markdown: **bold** → <strong>', () => {
    const html = renderMessages([msg({ content: 'a **bold** b' })]);
    assert.ok(html.includes('a <strong>bold</strong> b'));
});

test('markdown: *italic* → <em>', () => {
    const html = renderMessages([msg({ content: 'x *ital* y' })]);
    assert.ok(html.includes('x <em>ital</em> y'));
});

test('markdown: `code` → <code>', () => {
    const html = renderMessages([msg({ content: 'see `foo` here' })]);
    assert.ok(html.includes('see <code>foo</code> here'));
});

test('markdown: ```fenced``` block stripped to plain text (no <code>, no stray backticks)', () => {
    // Regression: the inline-code regex used to match from the 3rd backtick of

    // the opening fence to the 1st backtick of the closing one and wrapped the

    // whole block in one giant <code>. Fences are now stripped before the

    // inline pass.
    const html = renderMessages([msg({ content: '```json\n{"command": "force_update"}\n```' })]);
    assert.ok(!html.includes('<code>'), 'fenced block must not wrap in <code>');
    assert.ok(!html.includes('```'), 'no stray backtick fences remain');
    assert.ok(html.includes('"command": "force_update"'), 'inner text preserved');
});

test('markdown: ``` fence without language tag also stripped', () => {
    const html = renderMessages([msg({ content: '```\nplain code\n```' })]);
    assert.ok(!html.includes('<code>'));
    assert.ok(!html.includes('```'));
    assert.ok(html.includes('plain code'));
});

test('markdown: fenced block and inline `code` coexist', () => {
    const html = renderMessages([msg({ content: '```js\nx\n```\nand `y` here' })]);
    assert.ok(!html.includes('```'), 'fence stripped');
    assert.ok(html.includes('<code>y</code>'), 'inline code intact');
});

test('markdown: ~~strike~~ → <del>', () => {
    const html = renderMessages([msg({ content: 'gone ~~old~~ now' })]);
    assert.ok(html.includes('gone <del>old</del> now'));
});

test('markdown: \\n → <br>', () => {
    const html = renderMessages([msg({ content: 'line1\nline2' })]);
    assert.ok(html.includes('line1<br>line2'));
});

test('markdown order: bold and italic coexist without clobbering', () => {
    // bold converts first (removes **), then italic works on single *.
    const html = renderMessages([msg({ content: '**bold** and *ital*' })]);
    assert.ok(html.includes('<strong>bold</strong>'), html);
    assert.ok(html.includes('<em>ital</em>'), html);
});

// ── reply bar ──

test('reply: replyTo present → dsc_reply_bar with avatar, @name, quote', () => {
    const html = renderMessages([msg({ username: 'a', content: 'x', replyTo: 'bob', replyQuote: 'said hello' })]);
    assert.match(html, /class="dsc_reply_bar"/);
    assert.match(html, /class="dsc_reply_avatar" style="background:hsl\(\d+, 75%, 62%\)/);
    assert.ok(html.includes('class="dsc_reply_name"'));
    assert.ok(html.includes('>@bob</span>'), 'reply name rendered as @bob');
    assert.ok(html.includes('class="dsc_reply_quote">said hello</span>'));
    // avatar char — the first letter of replyTo uppercased
    assert.ok(html.includes('>B</span>'), 'avatar char should be uppercase "B"');
});

test('reply: absent replyTo → no dsc_reply_bar', () => {
    const html = renderMessages([msg({ content: 'x' })]);
    assert.ok(!html.includes('dsc_reply_bar'));
});

// ── reactions ──

test('reactions: rendered, count chip omitted when empty', () => {
    const html = renderMessages([msg({ reactions: [{ emoji: '😭', count: '12' }, { emoji: '✨', count: '' }] })]);
    assert.match(html, /class="dsc_reactions"/);
    assert.ok(html.includes('class="dsc_reaction_emoji">😭</span>'), 'first emoji present');
    assert.ok(html.includes('class="dsc_reaction_count">12</span>'), 'first count present');
    // second reaction: emoji present, count empty → dsc_reaction_count must not
// render
    const second = html.split('class="dsc_reaction_emoji">✨</span>')[1];
    assert.ok(second.indexOf('dsc_reaction_count') === -1 || second.indexOf('dsc_reaction_count') > 50, 'empty count should omit count chip');
});

test('reactions: every chip rendered, no cap', () => {
    const reactions = Array.from({ length: 10 }, (_, i) => ({ emoji: String(i), count: '1' }));
    const html = renderMessages([msg({ reactions })]);
    const chipCount = (html.match(/class="dsc_reaction"/g) || []).length;
    assert.equal(chipCount, 10);
});

// ── XSS contract (renderer escape per field) ──

test('XSS: username escaped (no injected tag/attr)', () => {
    const html = renderMessages([msg({ username: '<b>x</b>', content: 'c' })]);
    assert.ok(!html.includes('data-username="<b>'), 'username must not inject attr');
    assert.ok(html.includes('&lt;b&gt;x&lt;/b&gt;'));
});

test('XSS: reply name and quote escaped', () => {
    const evil = '<img src=x onerror=alert(1)>';
    const html = renderMessages([msg({ username: 'a', content: 'c', replyTo: evil, replyQuote: '<script>' })]);
    assert.ok(!html.includes('<img'), 'reply name must be escaped');
    assert.ok(!html.includes('<script>'), 'quote must be escaped');
    assert.ok(html.includes('&lt;img'));
});

test('XSS: emoji and count escaped', () => {
    const html = renderMessages([msg({ reactions: [{ emoji: '<b>', count: '<x>' }] })]);
    assert.ok(!html.includes('class="dsc_reaction_emoji"><b>'));
    assert.ok(html.includes('&lt;b&gt;'));
    assert.ok(!html.includes('class="dsc_reaction_count"><x>'), 'count escaped');
});

// ── consistency ──

test('hashHue consistency: same username → same inline --dsc-nick-hue value', () => {
    const h1 = renderMessages([msg({ username: 'dupe' })]);
    const h2 = renderMessages([msg({ username: 'dupe' })]);
    const m1 = h1.match(/--dsc-nick-hue:(\d+)/);
    const m2 = h2.match(/--dsc-nick-hue:(\d+)/);
    assert.equal(m1[1], m2[1]);
});
// ── media placeholders ──

test('message with media renders a placeholder div with data attributes', () => {
    const html = renderMessages([msg({ media: { type: 'gif', url: 'https://media.giphy.com/a.gif', alt: 'cat' } })]);
    assert.match(html, /class="dsc_gif"/);
    assert.match(html, /data-dsc-media-src="https:\/\/media\.giphy\.com\/a\.gif"/);
    assert.match(html, /data-dsc-media-type="gif"/);
    assert.match(html, /data-dsc-media-alt="cat"/);
    assert.ok(!html.includes('<img'));
});

test('message with disallowed media URL renders no placeholder', () => {
    for (const url of ['https://evil.example.com/a.gif', 'javascript:alert(1)', '']) {
        const html = renderMessages([msg({ media: { type: 'gif', url } })]);
        assert.ok(!html.includes('dsc_gif'), url);
    }
});

test('message without media renders no placeholder (legacy shape intact)', () => {
    const html = renderMessages([msg({ content: 'plain' })]);
    assert.ok(!html.includes('dsc_gif'));
});

function makePlaceholder(attrs) {
    const classes = new Set();
    return {
        _attrs: { ...attrs },
        _classes: classes,
        getAttribute(k) { return this._attrs[k] ?? null; },
        setAttribute(k, v) { this._attrs[k] = v; },
        appendChild(c) { this.child = c; },
        classList: {
            add(c) { classes.add(c); },
            remove(c) { classes.delete(c); },
        },
        textContent: 'stale',
    };
}

test('upgradeMediaPlaceholders: upgrades placeholder to img with allowlisted URL', () => {
    const placeholder = makePlaceholder({
        'data-dsc-media-src': 'https://media.giphy.com/a.gif',
        'data-dsc-media-type': 'gif',
        'data-dsc-media-alt': 'cat',
    });
    const feed = { querySelectorAll: (sel) => sel.startsWith('[data-dsc-media-src]') ? [placeholder] : [] };
    assert.equal(upgradeMediaPlaceholders(feed), 1);
    assert.ok(placeholder.child);
    assert.equal(placeholder.child.src, 'https://media.giphy.com/a.gif');
    assert.equal(placeholder.child.alt, 'cat');
    // memegen cold renders can stall for minutes — the box starts marked
    // as loading and carries a watchdog
    assert.ok(placeholder._classes.has('dsc_gif_loading'));
});

test('upgradeMediaPlaceholders: load clears the loading marker', () => {
    const placeholder = makePlaceholder({
        'data-dsc-media-src': 'https://media.giphy.com/a.gif',
        'data-dsc-media-type': 'gif',
        'data-dsc-media-alt': 'cat',
    });
    const feed = { querySelectorAll: (sel) => sel.startsWith('[data-dsc-media-src]') ? [placeholder] : [] };
    upgradeMediaPlaceholders(feed);
    placeholder.child._listeners.load?.();
    assert.ok(!placeholder._classes.has('dsc_gif_loading'));
});

test('upgradeMediaPlaceholders: a silent stall is never re-triggered — the transfer drains into the cache', () => {
    const placeholder = makePlaceholder({
        'data-dsc-media-src': 'https://api.memegen.link/images/cmm/_.png',
        'data-dsc-media-type': 'meme',
        'data-dsc-media-alt': 'cmm: sign text',
    });
    const feed = { querySelectorAll: (sel) => sel.startsWith('[data-dsc-media-src]') ? [placeholder] : [] };
    upgradeMediaPlaceholders(feed);
    const img = placeholder.child;
    // a silently draining body fires NO events: re-assigning src would abort
    // the in-flight download (the live failure: 1.5MB gifs killed mid-stream
    // at every retry tick, then finishing into the browser cache AFTER the
    // watchdog stopped — instantly served on the next reload)
    for (let i = 1; i <= 6; i++) globalThis._dscTickIntervals();
    assert.equal(img.src, 'https://api.memegen.link/images/cmm/_.png', 'no restarts on silent ticks');
    // t=35s: the box degrades to the caption — the img keeps downloading detached
    globalThis._dscTickIntervals();
    assert.ok(placeholder._classes.has('dsc_gif_stalled'));
    assert.equal(placeholder.child.textContent, 'cmm: sign text');
    assert.equal(img.src, 'https://api.memegen.link/images/cmm/_.png', 'degrade must not abort the transfer');
    // t=60s: exactly one cache-busted restart for a forever-silent socket
    for (let i = 0; i < 5; i++) globalThis._dscTickIntervals();   // t=60s
    assert.ok(String(img.src).endsWith('dscr=resurrect'), 'one mid-window restart');
    for (let i = 0; i < 10; i++) globalThis._dscTickIntervals();  // t=110s
    assert.equal(String(img.src.match(/dscr=(\w+)$/)?.[1]), 'resurrect', 'no second restart');
    // a late render swaps the picture back in place of the caption
    img.complete = true;
    img.naturalWidth = 600;
    img._listeners.load?.();
    assert.ok(!placeholder._classes.has('dsc_gif_stalled'));
    assert.equal(placeholder.child, img);
});

test('upgradeMediaPlaceholders: a hard error retries on the ladder, then stops', () => {
    const placeholder = makePlaceholder({
        'data-dsc-media-src': 'https://media.giphy.com/a.gif',
        'data-dsc-media-type': 'gif',
        'data-dsc-media-alt': 'cat',
    });
    const feed = { querySelectorAll: (sel) => sel.startsWith('[data-dsc-media-src]') ? [placeholder] : [] };
    upgradeMediaPlaceholders(feed);
    const img = placeholder.child;
    // ladder in ticks after each error: 2, 4, 5, 6 → retries at t=10/20/25/30s
    globalThis._dscTickIntervals();                 // t=5s: no error yet — nothing
    assert.equal(img.src, 'https://media.giphy.com/a.gif', 'a silent tick never restarts');
    img._listeners.error?.();                       // hard error at t=5s
    for (let i = 0; i < 2; i++) globalThis._dscTickIntervals();   // t=10s: due
    assert.ok(String(img.src).endsWith('dscr=1'), 'error retry 1');
    img._listeners.error?.();
    for (let i = 0; i < 4; i++) globalThis._dscTickIntervals();   // t=20s: due
    assert.ok(String(img.src).endsWith('dscr=2'), 'error retry 2');
    img._listeners.error?.();
    for (let i = 0; i < 5; i++) globalThis._dscTickIntervals();   // t=25s: due
    assert.ok(String(img.src).endsWith('dscr=3'), 'error retry 3');
    img._listeners.error?.();
    for (let i = 0; i < 6; i++) globalThis._dscTickIntervals();   // t=30s+degrade: due
    assert.ok(String(img.src).endsWith('dscr=4'), 'error retry 4');
    img._listeners.error?.();                       // ladder exhausted
    globalThis._dscTickIntervals();
    globalThis._dscTickIntervals();
    assert.ok(String(img.src).endsWith('dscr=4'), 'bounded ladder — no infinite error retry loop');
});

test('upgradeMediaPlaceholders: degraded box never revives if the render never lands', () => {
    const placeholder = makePlaceholder({
        'data-dsc-media-src': 'https://api.memegen.link/images/cmm/_.png',
        'data-dsc-media-type': 'meme',
        'data-dsc-media-alt': 'cmm: sign text',
    });
    const feed = { querySelectorAll: (sel) => sel.startsWith('[data-dsc-media-src]') ? [placeholder] : [] };
    upgradeMediaPlaceholders(feed);
    // seven 5s ticks → t=35s → caption
    for (let i = 0; i < 7; i++) globalThis._dscTickIntervals();
    assert.ok(placeholder._classes.has('dsc_gif_stalled'));
    assert.equal(placeholder.child.textContent, 'cmm: sign text');
    // the caption survives the whole window while the transfer drains
    for (let i = 0; i < 16; i++) globalThis._dscTickIntervals();   // t=115s
    assert.ok(placeholder._classes.has('dsc_gif_stalled'), 'caption survives a never-ending stall');
    assert.equal(placeholder.child.textContent, 'cmm: sign text');
    // watchdog expired at ~2 min: further ticks are inert
    for (let i = 0; i < 5; i++) globalThis._dscTickIntervals();
    assert.equal(placeholder.child.textContent, 'cmm: sign text');
});


test('upgradeMediaPlaceholders: watchdog releases a loaded image without touching it', () => {
    const placeholder = makePlaceholder({
        'data-dsc-media-src': 'https://media.giphy.com/a.gif',
        'data-dsc-media-type': 'gif',
        'data-dsc-media-alt': 'cat',
    });
    const feed = { querySelectorAll: (sel) => sel.startsWith('[data-dsc-media-src]') ? [placeholder] : [] };
    upgradeMediaPlaceholders(feed);
    const img = placeholder.child;
    img.complete = true;
    img.naturalWidth = 800;
    globalThis._dscTickIntervals();
    assert.ok(!placeholder._classes.has('dsc_gif_loading'));
    assert.ok(!placeholder._classes.has('dsc_gif_stalled'));
    assert.equal(placeholder.child, img);
});

test('upgradeMediaPlaceholders: disallowed URL is dropped, not upgraded', () => {
    const placeholder = makePlaceholder({ 'data-dsc-media-src': 'https://evil.example.com/a.gif' });
    const feed = { querySelectorAll: () => [placeholder] };
    assert.equal(upgradeMediaPlaceholders(feed), 0);
    assert.equal(placeholder._attrs['data-dsc-media-dropped'], '1');
    assert.ok(!placeholder.child);
});

test('upgradeMediaPlaceholders: non-DOM root is a safe no-op', () => {
    assert.equal(upgradeMediaPlaceholders(null), 0);
    assert.equal(upgradeMediaPlaceholders({}), 0);
});

// ── unresolved media fallback (bracketed degradation) ──

test('media-only comment without resolved media renders a bracketed tag, not an empty bubble', () => {
    const html = renderMessages([msg({ content: '', gif: 'man rubbing temples stressed' })]);
    assert.match(html, /<span class="dsc_media_fallback">\[gif: man rubbing temples stressed\]<\/span>/);
    assert.ok(!html.includes('dsc_gif"'));
});

test('sticker and meme requests degrade with their own kind label', () => {
    const sticker = renderMessages([msg({ content: '', sticker: 'thumbs up cat' })]);
    assert.match(sticker, /\[sticker: thumbs up cat\]/);
    const meme = renderMessages([msg({ content: '', meme: { template: 'drake', top: 'a', bottom: 'b' } })]);
    assert.match(meme, /\[meme: drake\]/);
});

test('failed media with text present stays text-only (no duplicate bracket)', () => {
    const html = renderMessages([msg({ content: 'обычный текст', gif: 'cat' })]);
    assert.ok(html.includes('обычный текст'));
    assert.ok(!html.includes('dsc_media_fallback'));
});

test('resolved media renders placeholder, not fallback', () => {
    const html = renderMessages([msg({ content: '', media: { type: 'gif', url: 'https://media.giphy.com/a.gif' } })]);
    assert.match(html, /data-dsc-media-src/);
    assert.ok(!html.includes('dsc_media_fallback'));
});

// ── media <img> upgrade ──

test('upgradeMediaPlaceholders swaps the placeholder for an <img> with the same URL', () => {
    const placeholder = makePlaceholder({ 'data-dsc-media-src': 'https://media.giphy.com/media/x.gif?a=b' });
    const feed = { querySelectorAll: () => [placeholder] };
    assert.equal(upgradeMediaPlaceholders(feed), 1);
    assert.equal(placeholder.child.src, 'https://media.giphy.com/media/x.gif?a=b');
});

// ── reaction emote chips (code → manifest → img) ──

test('upgradeMediaPlaceholders upgrades emote codes through the live manifest', () => {
    state.settings.reactionEmotes = true;
    _setEmoteManifest({ builtin: { monkaS: 'https://cdn.betterttv.net/emote/b/2x.webp' } });
    const placeholder = makePlaceholder({ 'data-dsc-emote-code': 'monkaS' });
    const feed = { querySelectorAll: () => [placeholder] };
    assert.equal(upgradeMediaPlaceholders(feed), 1);
    assert.equal(placeholder.child.src, 'https://cdn.betterttv.net/emote/b/2x.webp', 'URL comes from the manifest, not the cached HTML');
    assert.equal(placeholder.child.className, 'dsc_reaction_emote_img');
});

test('upgradeMediaPlaceholders degrades unknown emote codes to textual codes', () => {
    state.settings.reactionEmotes = true;
    _setEmoteManifest({ builtin: { monkaS: 'https://cdn.betterttv.net/emote/b/2x.webp' } });
    const placeholder = makePlaceholder({ 'data-dsc-emote-code': 'TotallyUnknown' });
    const feed = { querySelectorAll: () => [placeholder] };
    assert.equal(upgradeMediaPlaceholders(feed), 1);
    assert.ok(!placeholder.child, 'no img for an unknown code');
    assert.equal(placeholder.textContent, ':TotallyUnknown:', 'chip degrades to the textual code');
    // feature off → same textual degradation (reactions stay readable)
    state.settings.reactionEmotes = false;
    const placeholder2 = makePlaceholder({ 'data-dsc-emote-code': 'monkaS' });
    const feed2 = { querySelectorAll: () => [placeholder2] };
    assert.equal(upgradeMediaPlaceholders(feed2), 1);
    assert.equal(placeholder2.textContent, ':monkaS:');
});
