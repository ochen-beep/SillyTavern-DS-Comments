// @ts-check
/**
 * DS Comments — Renderer module
 * Converts parsed commentary messages into HTML: colorful hash-nick,
 * reactions, reply chains, mini-markdown, DOMPurify sanitization.
 */

import { escapeHtml, sanitize, hashHue, trace } from './core.js';
import { recordEvent } from './event-log.js';
import { isAllowedMediaUrl } from './media.js';
import { getEmoteUrl } from './emotes.js';

/**
 * Mini-markdown → HTML, applied AFTER DOMPurify sanitization.
 * Supports: **bold**, *italic*, `code`, \n → <br>. Single pass.
 * Callers pass already-sanitized content; here we only transform inline markers.
 */
function formatMessageContent(text) {
    // Sanitize the raw text first (defence in depth — kills stray tags).
    let out = sanitize(text);
    out = out.replace(/\*\*([^*]+?)\*\*/g, '<strong>$1</strong>');
    // Fenced code blocks: strip ``` (and optional language tag) so the inline-code
    // regex below doesn't wrap the whole block in one giant <code>. Mini-markdown
    // has no <pre> support, so fenced content renders as plain text. Must run
    // before the inline-code pass.
    out = out.replace(/```[a-zA-Z0-9]*\n?/g, '');
    // Inline code: `text`  (do before italic so backticks survive)
    out = out.replace(/`([^`]+?)`/g, '<code>$1</code>');
    // Italic: *text*  (single asterisks not part of bold)
    out = out.replace(/(^|[^*])\*([^*\n]+?)\*(?!\*)/g, '$1<em>$2</em>');
    out = out.replace(/~~([^~]+?)~~/g, '<del>$1</del>');
    out = out.replace(/\n/g, '<br>');
    return out;
}

/**
 * Media attachment placeholder. A real <img> cannot go through the feed's
 * sanitize() (img is FORBID_TAGGED to keep model text free of tracking
 * pixels), so the URL travels in data-* attributes — DOMPurify keeps those —
 * and upgradeMediaPlaceholders() swaps the placeholder for an actual <img>
 * element after the sanitized HTML has been inserted (see feed-controller).
 */
function renderMediaPlaceholder(media) {
    if (!media?.url || !isAllowedMediaUrl(media.url)) return '';
    const type = ['gif', 'sticker', 'meme'].includes(media.type) ? media.type : 'gif';
    return `<div class="dsc_gif" data-dsc-media-src="${escapeHtml(media.url)}"`
        + ` data-dsc-media-type="${type}"`
        + ` data-dsc-media-alt="${escapeHtml(media.alt || '')}"></div>`;
}

/**
 * Bracketed fallback for a media request that never resolved to a URL
 * (provider off, no key, empty search results). Only media-only comments
 * need it — with text present the message already reads fine, and a bracket
 * would duplicate it. Mirrors the RU-NET "[sticker]" bracket idiom so the
 * feed degrades into the same aesthetic instead of an empty bubble.
 */
function renderMediaFallback(msg) {
    if (msg.media || msg.content) return '';
    const query = msg.gif || msg.sticker || msg.meme?.template || '';
    if (!query) return '';
    const kind = msg.gif ? 'gif' : msg.sticker ? 'sticker' : 'meme';
    return `<span class="dsc_media_fallback">[${kind}: ${escapeHtml(String(query))}]</span>`;
}

/**
 * Replace every media placeholder under `root` with a real <img> element,
 * built via createElement (no HTML parsing of the URL). Called from the feed
 * controller after innerHTML assignment — this covers fresh renders, cache
 * restores and pinned feeds, which all funnel through the same replace().
 * @param {Element|{ querySelectorAll?: Function }} root
 * @returns {number} how many placeholders were upgraded
 */
export function upgradeMediaPlaceholders(root) {
    try {
        if (!root || typeof root.querySelectorAll !== 'function') return 0;
        const nodes = root.querySelectorAll('[data-dsc-media-src], [data-dsc-emote-code]');
        const jobs = [];   // media placeholders, loaded through the queue below
        let upgraded = 0;
        for (const node of nodes) {
            // Emote chips: resolve code → URL from the LIVE manifest. The code
            // is the only trusted token — a forged cached HTML can at worst
            // name an unknown code (chip degrades to text), never smuggle a URL.
            const emoteCode = node.getAttribute?.('data-dsc-emote-code');
            if (emoteCode !== null && emoteCode !== undefined) {
                const url = getEmoteUrl(emoteCode);
                if (!url) {
                    // Feature off / pack changed / unknown code — the chip must
                    // not go blank: degrade to the textual code.
                    node.textContent = `:${emoteCode}:`;
                    upgraded++;
                    continue;
                }
                const img = document.createElement('img');
                img.className = 'dsc_reaction_emote_img';
                img.setAttribute('loading', 'lazy');
                img.setAttribute('decoding', 'async');
                img.alt = `:${emoteCode}:`;
                img.src = url;
                img.addEventListener('error', () => trace(`emote failed to load: :${emoteCode}: ${url}`));
                node.textContent = '';
                node.appendChild?.(img);
                upgraded++;
                continue;
            }
            const rawUrl = node.getAttribute?.('data-dsc-media-src');
            const type = node.getAttribute?.('data-dsc-media-type') || 'gif';
            // Re-verify the allowlist at DOM time: even if a forged URL got
            // persisted into cached HTML, it never becomes an <img> here.
            if (!rawUrl || !isAllowedMediaUrl(rawUrl)) {
                node.setAttribute?.('data-dsc-media-dropped', '1');
                continue;
            }
            const img = document.createElement('img');
            img.className = `dsc_gif_img dsc_gif_${type}`;
            img.setAttribute('loading', 'lazy');
            img.setAttribute('decoding', 'async');
            img.setAttribute('referrerpolicy', 'no-referrer');
            img.alt = node.getAttribute?.('data-dsc-media-alt') || '';
            // src is NOT assigned here — the queue decides: memes/stickers
            // start at once, heavy gifs wait for a slot (see runMediaLoadQueue).
            node.classList?.add?.('dsc_gif_loading');
            jobs.push({ node, img, url: rawUrl, type, index: jobs.length, attempts: 0, kicks: 0, errored: false, lastAttemptTick: 0, done: false });
            node.textContent = '';
            node.appendChild?.(img);
            node.classList?.add?.(`dsc_gif_${type}`);
            upgraded++;
        }
        if (jobs.length) runMediaLoadQueue(jobs);
        return upgraded;
    } catch {
        // The upgrade is cosmetic on top of already-safe HTML — never let it
        // break the feed write.
        return 0;
    }
}

// ── Media load queue ──
// All pictures of one feed compete for the same link, but they are NOT alike:
// memes/stickers are 20–60KB files whose cost is the SERVER-SIDE memegen
// render (cold combos render for minutes). Every such request must launch
// immediately so the renders run in parallel — queuing them delays the
// renders themselves. Gifs are multi-megabyte downloads: on a slow channel N
// parallel ones starve each other (measured live: ~2KB/s per stream → every
// box missed its window), so gifs alone pass through a small queue.
// The queue NEVER swaps a loading box for text: on a throttled link the only
// strategy that produces pictures is patience, so a slow box keeps its
// loading pulse until the transfer lands or the feed is torn down (the
// fork-era behavior that outlived every later rewrite). Recovery is a kick:
// re-assigning src cache-busted aborts the current request and starts a
// fresh one. Triggers, each on its own clock: a hard error walks the retry
// ladder; a transfer with ZERO bytes received (dead socket or still-hanging
// TTFB) is kicked every ~45s — a kick cannot lose buffered data; a transfer
// whose HEADER landed but whose body never completes gets its own, wider
// window (the measured throttled-link failure: headers arrive at line speed
// while bodies crawl at ~400 B/s or freeze — without this the box hangs
// forever past its first frame). A quiet transfer is otherwise never
// restarted: <img> has no progress events, so silence may just as well mean
// a slow drain.
const MAX_MEDIA_PARALLEL = 2;
const WATCHDOG_TICK_MS = 5000;
// All windows in ticks (1 tick = 5s), per job, counted from its OWN start.
const STOP_TICKS = 24;      // ~2 min: fine bookkeeping ends; the box moves to the slow tail
const ZERO_BYTE_KICK_AFTER_TICKS = 9;   // ~45s of zero bytes per request → kick
// Stalled-body window from the first decoded frame, per type: memes/stickers
// are ~25KB files that drain in well under a minute even starved; a megabyte
// gif needs minutes, so its window is wider and only fires on a truly dead
// body.
const STALL_KICK_AFTER_TICKS = { meme: 18, sticker: 18, gif: 36 };   // ~90s / ~3min
// Kick budget: ~27 min of per-45s retries — sized to the reader's patience,
// not to a good link's; whichever kick finally lands makes every later
// render instant via the browser cache.
const MAX_KICKS = 36;
const KICK_TAIL_TICKS = 12;             // ~1m after the last kick → close bookkeeping
// Backoff ladder after a hard error, in ticks.
const RETRY_LADDER_TICKS = [2, 4, 5, 6];

function runMediaLoadQueue(jobs) {
    const total = jobs.length;
    let ticks = 0;
    let queue = jobs.filter(j => j.type === 'gif');
    let active = [];
    let longTail = [];   // past STOP: degraded, kept on life support (see STOP branch)
    let stopped = false;

    const finishJob = (job, landed) => {
        const wasClosed = job.done;
        if (!wasClosed) {
            job.done = true;
            active = active.filter(j => j !== job);
            longTail = longTail.filter(j => j !== job);
        }
        if (!landed) return;
        job.node.classList?.remove?.('dsc_gif_loading');
        // A landing after a stall (or after bookkeeping closed) is the answer
        // to that stall — it must be visible in the dump: how long the
        // picture took and via which recovery path (kicks vs plain drain).
        if (job.stallLogged || wasClosed) {
            recordEvent('log', `event=media_revive type=${job.type} ticks=${ticks} kicks=${job.kicks} pos=${job.index + 1}/${total}`);
        }
    };

    const markStalled = (job) => {
        // Crossing the stop line is the moment a "no GIF in the feed" report
        // would be born — it must be visible in the diagnostic dump; queue
        // position shows whether the load was starved (deep in the queue) or
        // genuinely slow. The box itself keeps its loading pulse: no text
        // tombstones.
        if (job.stallLogged) return;
        job.stallLogged = true;
        recordEvent('log', `event=media_stall type=${job.type} ticks=${ticks} pos=${job.index + 1}/${total}`);
    };

    const startJob = (job) => {
        job.startedTick = ticks;
        active.push(job);
        const onWin = () => { finishJob(job, true); pump(); };
        const onFail = () => { job.errored = true; trace(`media failed to load: ${job.url}`); };
        job.img.addEventListener('load', onWin);
        job.img.addEventListener('error', onFail);
        job.img.src = job.url;
    };

    const pump = () => {
        // Slot accounting covers heavy gifs only; memes/stickers launched at
        // queue construction are not gated.
        while (!stopped
            && active.filter(j => j.type === 'gif').length < MAX_MEDIA_PARALLEL
            && queue.length) {
            startJob(queue.shift());
        }
    };

    // A body that got its header but never completes: the throttled-link
    // signature (headers at line speed, bodies strangled). Kicked per type
    // once its window from the first decoded frame expires.
    const stalledBody = (job) => job.img.naturalWidth > 0 && !job.img.complete
        && job.firstByteTick !== undefined
        && ticks - job.firstByteTick >= (STALL_KICK_AFTER_TICKS[job.type] ?? STALL_KICK_AFTER_TICKS.gif);
    const dueForKick = (job) => job.kicks < MAX_KICKS && !job.done
        && (job.errored || (job.img.naturalWidth === 0 && !job.img.complete) || stalledBody(job))
        && ticks - job.lastAttemptTick >= ZERO_BYTE_KICK_AFTER_TICKS;
    const doKick = (job) => {
        // Cache-busted restart of the current request. For a zero-byte
        // transfer nothing is buffered; for a stalled body the kick trades
        // frozen bytes for a fresh connection. Counted from the last attempt
        // so kicks never cut into the hard-error retry ladder.
        job.kicks++;
        job.lastAttemptTick = ticks;
        job.errored = false;
        job.firstByteTick = undefined;
        job.img.src = `${job.url}${job.url.includes('?') ? '&' : '?'}dscr=kick${job.kicks}`;
    };

    const watchdog = setInterval(() => {
        ticks++;
        // Feed replaced / panel torn down: stop everything — detached nodes
        // would keep issuing network requests. The in-flight transfers die
        // with the page or land in the browser cache for the next render.
        const detached = [...active, ...queue, ...longTail].filter(j => j.node.isConnected === false);
        for (const job of detached) finishJob(job, false);
        if (!active.length && !queue.length && !longTail.length) { clearInterval(watchdog); return; }
        for (const job of active) {
            if (imgSettled(job.img)) { finishJob(job, true); continue; }
            if (job.img.naturalWidth > 0 && job.firstByteTick === undefined) job.firstByteTick = ticks;
            const age = ticks - job.startedTick;
            if (age >= STOP_TICKS) {
                // Fine-grained bookkeeping ends here, but the box is NOT
                // abandoned: it moves to the slow-service tail, where its
                // request keeps getting kicked on the windows above and its
                // late load still lifts the pulse. This is what keeps the
                // stored browser cache filling and makes every later render
                // instant.
                active = active.filter(j => j !== job);
                markStalled(job);
                longTail.push(job);
                continue;
            }
            // Retry ladder on a hard error (cache-busted: the same URL can
            // reuse the poisoned connection). A silent transfer is NEVER
            // restarted before its kick window: <img> has no progress
            // events, so silence may just as well mean a slow drain —
            // re-assigning src aborts the in-flight download and resets it
            // to zero.
            if (job.errored && !job.done) {
                const dueTicks = job.attempts < RETRY_LADDER_TICKS.length ? RETRY_LADDER_TICKS[job.attempts] : Infinity;
                if (ticks - job.lastAttemptTick >= dueTicks) {
                    job.attempts++;
                    job.lastAttemptTick = ticks;
                    job.errored = false;
                    job.firstByteTick = undefined;
                    job.img.src = `${job.url}${job.url.includes('?') ? '&' : '?'}dscr=${job.attempts}`;
                }
            } else if (dueForKick(job)) {
                doKick(job);
            }
        }
        // Slow-service tail: the STOP branch moved jobs here. Each
        // still-mounted request keeps its kick windows (up to MAX_KICKS);
        // ~1m after the last one bookkeeping closes — but the img keeps
        // draining and a landing load still lifts the pulse even past that.
        for (const job of longTail) {
            if (imgSettled(job.img)) { finishJob(job, true); continue; }
            if (job.img.naturalWidth > 0 && job.firstByteTick === undefined) job.firstByteTick = ticks;
            if (job.kicks >= MAX_KICKS
                && ticks - job.lastAttemptTick >= KICK_TAIL_TICKS) {
                finishJob(job, false);
                continue;
            }
            if (dueForKick(job)) doKick(job);
        }
        pump();
        if (!active.length && !queue.length && !longTail.length) clearInterval(watchdog);
    }, WATCHDOG_TICK_MS);
    // Small TTFB-bound files (memegen cold renders, stickers) start at once —
    // the sooner the request lands, the sooner the server render begins; only
    // heavy gifs wait for a queue slot.
    for (const job of jobs) {
        if (job.type !== 'gif') startJob(job);
    }
    pump();
}

function imgSettled(img) {
    return img.complete && img.naturalWidth > 0;
}

/**
 * Render an array of parsed commentary messages into an HTML string.
 * @param {Array<{username: string, content: string, replyTo: string|null, replyQuote: string|null, reactions: Array<{emoji: string, count: string}>, media?: {type: string, url: string, alt?: string}|null}>} messages
 * @returns {string} HTML string
 */
export function renderMessages(messages) {
    if (!Array.isArray(messages) || messages.length === 0) return '';

    return messages.map(msg => {
        const hue = hashHue(msg.username);
        // Two-stop gradient for the nickname, derived from a deterministic hue.
        // CSS provides a flat-color @supports fallback for no background-clip:text.
        const nickColorA = `hsl(${hue}, 80%, 65%)`;
        const nickColorB = `hsl(${(hue + 35) % 360}, 78%, 55%)`;
        const replyColor = msg.replyTo ? `hsl(${hashHue(msg.replyTo)}, 75%, 62%)` : '';
        // Unresolved media request in a media-only comment degrades to a
        // bracketed tag; otherwise the bubble renders empty (see mikey_j_glue).
        const content = formatMessageContent(msg.content) || renderMediaFallback(msg);

        // ── Reply bar (optional) ──
        let replyBar = '';
        if (msg.replyTo) {
            const quoteSafe = escapeHtml(msg.replyQuote || '');
            const avatarChar = escapeHtml(msg.replyTo.charAt(0).toUpperCase());
            replyBar = `<div class="dsc_reply_bar">
                <span class="dsc_reply_line"></span>
                <span class="dsc_reply_avatar" style="background:${replyColor}">${avatarChar}</span>
                <span class="dsc_reply_name" style="color:${replyColor}">@${escapeHtml(msg.replyTo)}</span>
                <span class="dsc_reply_quote">${quoteSafe}</span>
            </div>`;
        }

        // ── Reactions (optional; every chip the model gave) ──
        // An emoji value that names an emote in the loaded pack renders as a
        // CODE placeholder — upgradeMediaPlaceholders resolves code → URL from
        // the live manifest (the persisted URL is never trusted, only the
        // code), unknown codes fall through to plain text.
        let reactionsHtml = '';
        if (msg.reactions && msg.reactions.length > 0) {
            const chips = msg.reactions.map(r => {
                const code = String(r.emoji || '').replace(/^:|:$/g, '');
                const emoteUrl = getEmoteUrl(code);
                const emojiHtml = emoteUrl
                    ? `<span class="dsc_reaction_emoji" data-dsc-emote-code="${escapeHtml(code)}" data-dsc-emote-alt="${escapeHtml(code)}"></span>`
                    : `<span class="dsc_reaction_emoji">${escapeHtml(r.emoji)}</span>`;
                return `<span class="dsc_reaction">${emojiHtml}${r.count ? `<span class="dsc_reaction_count">${escapeHtml(r.count)}</span>` : ''}</span>`;
            }).join('');
            reactionsHtml = `<div class="dsc_reactions">${chips}</div>`;
        }

        // ── Media attachment (optional; placeholder → <img> upgrade) ──
        const mediaHtml = renderMediaPlaceholder(msg.media);

        return `<div class="dsc_message">
            ${replyBar}
            <div class="dsc_main_row">
                <div class="dsc_body">
                    <div class="dsc_header">
                        <span class="dsc_username"
                              style="--dsc-nick-hue:${hue};--dsc-nick-a:${nickColorA};--dsc-nick-b:${nickColorB}"
                              data-username="${escapeHtml(msg.username)}">${escapeHtml(msg.username)}</span>
                    </div>
                    <div class="dsc_content">${content}</div>
                    ${mediaHtml}
                    ${reactionsHtml}
                </div>
            </div>
        </div>`;
    }).join('');
}
