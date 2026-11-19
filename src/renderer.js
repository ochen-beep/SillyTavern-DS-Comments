// @ts-check
/**
 * DS Comments — Renderer module
 * Converts parsed commentary messages into HTML: colorful hash-nick,
 * reactions, reply chains, mini-markdown, DOMPurify sanitization.
 */

import { escapeHtml, sanitize, hashHue, trace } from './core.js';
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
            img.src = rawUrl;
            let errored = false;
            img.addEventListener('error', () => { errored = true; trace(`media failed to load: ${rawUrl}`); });
            // Reading-window timings: the reader stays ~1 minute after a feed
            // renders, so all USEFUL retry work is front-loaded there
            // (error-driven backoff ~2/6/15/30s), the box degrades to its
            // caption at ~35s — while the reader is still looking and the
            // bracket reads as intentional — and everything stops at ~2 min
            // (nobody is watching; the stored feed HTML keeps the
            // placeholder, so the next render retries fresh).
            node.classList?.add?.('dsc_gif_loading');
            let lastAttemptTick = 0;
            let ticks = 0;
            let attempts = 0;
            let degraded = false;
            const restoreImage = () => {
                degraded = false;
                node.classList?.remove?.('dsc_gif_stalled');
                node.textContent = '';
                node.appendChild?.(img);
            };
            img.addEventListener('load', () => {
                node.classList?.remove?.('dsc_gif_loading');
                if (degraded) restoreImage();
            });
            const WATCHDOG_TICK_MS = 5000;
            // All windows in ticks (1 tick = 5s): reading-window timings, and
            // tick counters keep the schedule deterministic for the test stubs.
            const DEGRADE_TICKS = 7;    // ~35s: caption while the reader is still looking
            const STOP_TICKS = 24;      // ~2 min: nobody is watching past this
            // Backoff ladder after a hard error, in ticks (2s → 1, 6s → 2,
            // 15s → 3, 30s → 6 — errors fire fast, so retries front-load the
            // reading window).
            const RETRY_LADDER_TICKS = [1, 2, 3, 6];
            const watchdog = setInterval(() => {
                // The feed was replaced (innerHTML swap) or the panel torn
                // down: stop polling and let the nodes go — a detached img
                // keeps issuing real network requests otherwise.
                if (!img.isConnected) {
                    clearInterval(watchdog);
                    return;
                }
                if (img.complete && img.naturalWidth > 0) {
                    clearInterval(watchdog);
                    node.classList?.remove?.('dsc_gif_loading');
                    if (degraded) restoreImage();
                    return;
                }
                ticks++;
                if (ticks >= STOP_TICKS) {
                    clearInterval(watchdog);
                    return;
                }
                if (!degraded && ticks >= DEGRADE_TICKS) {
                    degraded = true;
                    node.classList?.remove?.('dsc_gif_loading');
                    node.classList?.add?.('dsc_gif_stalled');
                    const caption = document.createElement('span');
                    caption.className = 'dsc_media_fallback';
                    caption.textContent = img.alt || '';
                    node.textContent = '';
                    node.appendChild?.(caption);
                }
                // Retry when due: a hard error fires fast, so its ladder lands
                // inside the reading window; a stalled stream fires nothing,
                // so poll every tick while the reader is here and every 3rd
                // tick after the degrade.
                const sinceAttempt = ticks - lastAttemptTick;
                const dueTicks = errored
                    ? (attempts < RETRY_LADDER_TICKS.length ? RETRY_LADDER_TICKS[attempts] : Infinity)
                    : (degraded ? 3 : 1);
                if (sinceAttempt >= dueTicks) {
                    attempts++;
                    lastAttemptTick = ticks;
                    errored = false;
                    // Cache-bust the retry: re-assigning the same URL can
                    // reuse a stalled connection/partial cache entry
                    // (observed live with memegen on a throttled link — every
                    // identical retry died at the same byte offset).
                    img.src = `${rawUrl}${rawUrl.includes('?') ? '&' : '?'}dscr=${attempts}`;
                }
            }, WATCHDOG_TICK_MS);
            node.textContent = '';
            node.appendChild?.(img);
            node.classList?.add?.(`dsc_gif_${type}`);
            upgraded++;
        }
        return upgraded;
    } catch {
        // The upgrade is cosmetic on top of already-safe HTML — never let it
        // break the feed write.
        return 0;
    }
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
