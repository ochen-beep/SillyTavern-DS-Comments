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
import { dumpEventLog, _resetEventLog } from '../src/event-log.js';

beforeEach(() => {
    state.settings = { reactionEmotes: true };
    _setEmoteManifest({ builtin: { monkaS: 'https://cdn.betterttv.net/emote/b/2x.webp' } });
    _resetEventLog();
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
    const children = [];
    return {
        _attrs: { ...attrs },
        _classes: classes,
        _children: children,
        get children() { return children; },
        isConnected: true,
        getAttribute(k) { return this._attrs[k] ?? null; },
        setAttribute(k, v) { this._attrs[k] = v; },
        appendChild(c) { this.child = c; children.push(c); c.isConnected = this.isConnected; c.parentElement = this; },
        querySelector(sel) { return children.find(c => String(c.className ?? '').includes(sel.replace('.', ''))) ?? null; },
        classList: {
            add(c) { classes.add(c); },
            remove(c) { classes.delete(c); },
        },
        set textContent(v) {
            this._textContent = v;
            if (v === '') for (const c of children) c.isConnected = false;
            children.length = 0;
        },
        get textContent() { return this._textContent ?? ''; },
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
    const queueTimer = globalThis._dscIntervals.at(-1);
    // a silently draining body fires NO events: re-assigning src would abort
    // the in-flight download (the live failure: 1.5MB gifs killed mid-stream
    // at every retry tick, then finishing into the browser cache AFTER the
    // watchdog stopped — instantly served on the next reload)
    for (let i = 1; i <= 6; i++) globalThis._dscTickIntervals();
    assert.equal(img.src, 'https://api.memegen.link/images/cmm/_.png', 'no restarts on silent ticks');
    // t=35s: the box degrades to the caption while the img STAYS MOUNTED —
    // removing it would cancel a native lazy load that has not started yet.
    globalThis._dscTickIntervals();
    assert.ok(placeholder._classes.has('dsc_gif_stalled'));
    assert.equal(placeholder.child.textContent, 'cmm: sign text');
    assert.equal(img.isConnected, true, 'degradation must not unmount the still-loading image');
    assert.equal(placeholder._children.length, 2, 'caption rides next to the hidden img');
    // t=40s: the queue keeps managing the mounted image.
    queueTimer();
    assert.equal(img.isConnected, true);
    assert.equal(placeholder.child.textContent, 'cmm: sign text');
    img.complete = true;
    img.naturalWidth = 600;
    img._listeners.load?.();
    assert.ok(!placeholder._classes.has('dsc_gif_stalled'));
    assert.ok(!placeholder._children.some(c => String(c.className).includes('dsc_media_fallback')), 'caption is removed on the late load');
    assert.equal(img.isConnected, true, 'the revived image stays attached');
});

test('upgradeMediaPlaceholders: memes start at once; the queue serializes only heavy gifs', () => {
    const meme = (alt) => makePlaceholder({
        'data-dsc-media-src': `https://api.memegen.link/images/ds/${alt}.png?width=480`,
        'data-dsc-media-type': 'meme',
        'data-dsc-media-alt': alt,
    });
    const gif = (alt) => makePlaceholder({
        'data-dsc-media-src': `https://media.giphy.com/media/${alt}/giphy.gif`,
        'data-dsc-media-type': 'gif',
        'data-dsc-media-alt': alt,
    });
    const boxes = [meme('m1'), gif('g1'), meme('m2'), gif('g2'), meme('m3'), gif('g3')];
    const feed = { querySelectorAll: (sel) => sel.startsWith('[data-dsc-media-src]') ? boxes : [] };
    upgradeMediaPlaceholders(feed);
    // Memes are TTFB-bound (server-side cold render): every request must be
    // launched at once so the renders run in parallel. Only the heavy gifs
    // pass through the 2-slot queue.
    assert.equal(boxes[0].child.src.includes('m1'), true, 'meme 1 starts');
    assert.equal(boxes[2].child.src.includes('m2'), true, 'meme 2 starts');
    assert.equal(boxes[4].child.src.includes('m3'), true, 'meme 3 starts');
    assert.equal(boxes[1].child.src.includes('g1'), true, 'gif slot 1 starts');
    assert.equal(boxes[3].child.src.includes('g2'), true, 'gif slot 2 starts');
    assert.equal(boxes[5].child.src, '', 'gif 3 waits for a slot');
});

test('upgradeMediaPlaceholders: a zero-byte silent stall gets two kicks, then left alone', () => {
    const placeholder = makePlaceholder({
        'data-dsc-media-src': 'https://api.memegen.link/images/cmm/_.png',
        'data-dsc-media-type': 'meme',
        'data-dsc-media-alt': 'cmm: sign text',
    });
    const feed = { querySelectorAll: (sel) => sel.startsWith('[data-dsc-media-src]') ? [placeholder] : [] };
    upgradeMediaPlaceholders(feed);
    const img = placeholder.child;
    const boot = () => {
        globalThis._dscTickIntervals();
        return String(img.src);
    };
    for (let tick = 1; tick <= 8; tick++) {
        const src = boot();
        assert.ok(!src.includes('dscr=kick'), `no kick before the 45s mark (tick ${tick})`);
    }
    // t=45s: zero bytes received (naturalWidth stays 0) — the socket is either
    // dead or still waiting on the memegen render; kicking it cache-busted is
    // free (nothing buffered yet) and unsticks dead VPN connections.
    boot();
    assert.ok(img.src.includes('dscr=kick1'), 'first zero-byte kick at ~45s');
    for (let tick = 10; tick <= 17; tick++) boot();
    assert.ok(!img.src.includes('kick2'), 'second kick waits for ~90s');
    boot();
    assert.ok(img.src.includes('dscr=kick2'), 'second zero-byte kick at ~90s');
    for (let tick = 19; tick <= 24; tick++) boot();
    assert.equal(String(img.src.match(/kick(\d)/)?.[1]), '2', 'kicks are bounded at two');
    img.complete = true;
    img.naturalWidth = 480;
    img._listeners.load?.();
    assert.match(dumpEventLog(), /event=media_revive type=meme ticks=\d+ kicks=2 pos=1\/1/, 'the revival lands in the diagnostic dump');
});

test('upgradeMediaPlaceholders: a draining transfer is never restarted through the whole window', () => {
    const placeholder = makePlaceholder({
        'data-dsc-media-src': 'https://media.giphy.com/slow-drain.gif',
        'data-dsc-media-type': 'gif',
        'data-dsc-media-alt': 'slow drain',
    });
    const feed = { querySelectorAll: (sel) => sel.startsWith('[data-dsc-media-src]') ? [placeholder] : [] };
    upgradeMediaPlaceholders(feed);
    const img = placeholder.child;
    const slot = globalThis._dscIntervals.length - 1;
    // naturalWidth > 0 means image bytes are already arriving: re-assigning
    // src would abort the in-flight download and reset it to zero — the exact
    // bug the queue was built to fix — so the src must stay untouched until
    // the window ends.
    img.naturalWidth = 1;   // data is flowing; complete is still false
    for (let tick = 1; tick <= 24; tick++) {
        globalThis._dscTickIntervals();
        assert.equal(img.src, 'https://media.giphy.com/slow-drain.gif', `no restart at tick ${tick}`);
    }
    assert.ok(placeholder._classes.has('dsc_gif_stalled'), 'the box degrades while the transfer keeps draining');
    assert.equal(globalThis._dscIntervals[slot], null, 'bookkeeping stops at ~2 min');
});

test('upgradeMediaPlaceholders: a late load after the watchdog stopped still swaps over the caption', () => {
    const placeholder = makePlaceholder({
        'data-dsc-media-src': 'https://api.memegen.link/images/cmm/_.png',
        'data-dsc-media-type': 'meme',
        'data-dsc-media-alt': 'cmm: sign text',
    });
    const feed = { querySelectorAll: (sel) => sel.startsWith('[data-dsc-media-src]') ? [placeholder] : [] };
    upgradeMediaPlaceholders(feed);
    const img = placeholder.child;
    for (let tick = 0; tick < 24; tick++) globalThis._dscTickIntervals();   // degrade at t=35s, stop at t=120s
    assert.ok(placeholder._classes.has('dsc_gif_stalled'));
    assert.equal(placeholder.child.textContent, 'cmm: sign text');
    assert.equal(img.isConnected, true, 'the img stays mounted through the stall');
    // The transfer drains after the watchdog stopped (a lazy image scrolled
    // into view, a slow body): the reader is looking at THIS box, so its load
    // event must still replace the caption with the picture.
    img.complete = true;
    img.naturalWidth = 600;
    img._listeners.load?.();
    assert.ok(!placeholder._classes.has('dsc_gif_stalled'), 'caption clears on the late load');
    assert.ok(!placeholder._children.some(c => String(c.className).includes('dsc_media_fallback')), 'caption node removed');
    assert.equal(img.isConnected, true);
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

test('upgradeMediaPlaceholders: the load queue starts waiting boxes as slots free up', () => {
    const a = makePlaceholder({
        'data-dsc-media-src': 'https://media.giphy.com/a.gif',
        'data-dsc-media-type': 'gif',
        'data-dsc-media-alt': 'a',
    });
    const b = makePlaceholder({
        'data-dsc-media-src': 'https://media.giphy.com/b.gif',
        'data-dsc-media-type': 'gif',
        'data-dsc-media-alt': 'b',
    });
    const feed = { querySelectorAll: (sel) => sel.startsWith('[data-dsc-media-src]') ? [a, b] : [] };
    upgradeMediaPlaceholders(feed);
    // MAX_MEDIA_PARALLEL=2 → both start immediately; a third box would wait.
    // Verify slot freeing: load of A keeps B intact; B's error ladder runs on its own.
    const imgA = a.child;
    const imgB = b.child;
    assert.equal(imgA.src, 'https://media.giphy.com/a.gif');
    assert.equal(imgB.src, 'https://media.giphy.com/b.gif');
    imgA.complete = true;
    imgA.naturalWidth = 100;
    imgA._listeners.load?.();
    assert.ok(!a._classes.has('dsc_gif_loading'), 'loaded box clears its spinner');
    // B still owns its own lifecycle
    imgB._listeners.error?.();
    globalThis._dscTickIntervals();
    globalThis._dscTickIntervals();
    assert.ok(String(imgB.src).endsWith('dscr=1'), 'B retries its own error independently');
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
