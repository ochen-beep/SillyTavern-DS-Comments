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
// Each transfer: cache-busted retries on a hard error; a transfer with ZERO
// bytes received (dead socket or still-hanging TTFB) is kicked cache-busted
// twice (~45s, ~90s) — a kick cannot lose buffered data and unsticks dead
// VPN connections; a transfer that already carries image data
// (naturalWidth > 0) is never restarted. A degraded box keeps its img
// mounted (CSS hides it) and its late load swaps the picture over the
// caption, even after the watchdog stops.
const MAX_MEDIA_PARALLEL = 2;
const WATCHDOG_TICK_MS = 5000;
// All windows in ticks (1 tick = 5s), per job, counted from its OWN start.
const DEGRADE_TICKS = 7;    // ~35s: caption while the reader is still looking
const STOP_TICKS = 24;      // ~2 min: bookkeeping stops; a late load still revives the caption
// Zero-byte kicks: <img> has no progress events, but naturalWidth > 0 as soon
// as the first bytes arrive — a transfer with naturalWidth === 0 has received
// literally nothing and is safe to restart. Kick interval counts from the
// last attempt (initial request or previous kick), at most two kicks.
const ZERO_BYTE_KICK_AFTER_TICKS = 9;   // ~45s with zero bytes → kick
const MAX_ZERO_BYTE_KICKS = 2;
// Backoff ladder after a hard error, in ticks.
const RETRY_LADDER_TICKS = [2, 4, 5, 6];

function runMediaLoadQueue(jobs) {
    const total = jobs.length;
    let ticks = 0;
    let queue = jobs.filter(j => j.type === 'gif');
    let active = [];
    let stopped = false;

    // Swap the finished picture back in place of the caption. The img stays
    // mounted through the stall, so only the caption is removed and the CSS
    // class (which hides the img) is lifted.
    const reviveOverCaption = (job) => {
        job.node.classList?.remove?.('dsc_gif_stalled');
        job.node.querySelector?.('.dsc_media_fallback')?.remove?.();
    };

    const finishJob = (job, landed) => {
        if (job.done) {
            // The transfer outlived the watchdog (a lazy image scrolled into
            // view, a slow body still draining): the reader may be looking at
            // this exact box, so its load event still revives the caption.
            // Only the tick bookkeeping stays closed.
            if (landed && job.degraded) reviveOverCaption(job);
            return;
        }
        job.done = true;
        active = active.filter(j => j !== job);
        if (landed) {
            job.node.classList?.remove?.('dsc_gif_loading');
            if (job.degraded) reviveOverCaption(job);
        }
    };

    const degradeJob = (job) => {
        if (job.degraded || job.done) return;
        job.degraded = true;
        job.node.classList?.remove?.('dsc_gif_loading');
        job.node.classList?.add?.('dsc_gif_stalled');
        const caption = document.createElement('span');
        caption.className = 'dsc_media_fallback';
        caption.textContent = job.img.alt || '';
        // The img STAYS MOUNTED (CSS hides it while .dsc_gif_stalled is set).
        // Removing it here would cancel a native lazy load that has not
        // started yet (the box can sit below the fold) and strand the box on
        // its caption until a full re-render — the live failure behind the
        // "memes only appear after F5" reports.
        job.node.appendChild?.(caption);
        // Degradation is the moment a "no GIF in the feed" report is born —
        // it must be visible in the diagnostic dump; queue position shows
        // whether the load was starved (deep in the queue) or genuinely slow.
        recordEvent('log', `event=media_stall type=${job.type} degraded=true ticks=${ticks} pos=${job.index + 1}/${total}`);
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

    const watchdog = setInterval(() => {
        ticks++;
        // Feed replaced / panel torn down: stop everything — detached nodes
        // would keep issuing network requests. The in-flight transfers die
        // with the page or land in the browser cache for the next render.
        const detached = [...active, ...queue].filter(j => j.node.isConnected === false);
        for (const job of detached) finishJob(job, false);
        if (!active.length && !queue.length) { clearInterval(watchdog); return; }
        for (const job of active) {
            if (imgSettled(job.img)) { finishJob(job, true); continue; }
            const age = ticks - job.startedTick;
            if (age >= STOP_TICKS) { finishJob(job, false); degradeJob(job); continue; }
            if (age >= DEGRADE_TICKS) degradeJob(job);
            // Retry ladder on a hard error (cache-busted: the same URL can
            // reuse the poisoned connection). A silent transfer is NEVER
            // restarted: <img> has no progress events, so "silent" may just
            // as well mean a slow drain — re-assigning src would abort the
            // in-flight download and reset it to zero (the live failure:
            // 1.5MB gifs at 20KB/s never finished while the reader watched,
            // then drained into the cache AFTER the watchdog gave up —
            // instantly served only on the next reload).
            if (job.errored && !job.done) {
                const dueTicks = job.attempts < RETRY_LADDER_TICKS.length ? RETRY_LADDER_TICKS[job.attempts] : Infinity;
                if (ticks - job.lastAttemptTick >= dueTicks) {
                    job.attempts++;
                    job.lastAttemptTick = ticks;
                    job.errored = false;
                    job.img.src = `${job.url}${job.url.includes('?') ? '&' : '?'}dscr=${job.attempts}`;
                }
            } else if (job.kicks < MAX_ZERO_BYTE_KICKS && !job.done
                && job.img.naturalWidth === 0 && !job.img.complete
                && ticks - job.lastAttemptTick >= ZERO_BYTE_KICK_AFTER_TICKS) {
                // Nothing received yet: the socket is dead or the request is
                // still hanging on a memegen render. A cache-busted kick costs
                // nothing (zero bytes buffered) and revives dead connections.
                // Counted from the last attempt so kicks never cut into the
                // hard-error retry ladder.
                job.kicks++;
                job.lastAttemptTick = ticks;
                job.img.src = `${job.url}${job.url.includes('?') ? '&' : '?'}dscr=kick${job.kicks}`;
            }
        }
        pump();
        if (!active.length && !queue.length) clearInterval(watchdog);
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
