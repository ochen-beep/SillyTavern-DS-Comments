// @ts-check
/**
 * DS Comments — Renderer module
 * Converts parsed commentary messages into HTML: colorful hash-nick,
 * reactions, reply chains, mini-markdown, DOMPurify sanitization.
 */

import { escapeHtml, sanitize, hashHue } from './core.js';
import { isAllowedMediaUrl } from './media.js';

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
 * Heal meme URLs persisted before the unicode-font fix: memegen's default
 * impact font silently drops every non-ASCII caption (cyrillic renders as a
 * blank template). Old cached feeds store the bare URL — if the decoded path
 * carries non-ASCII text and no explicit font, append ?font=notosans at
 * display time. Same host/path as the allowlist entry, only a query param is
 * added, so the security contract is untouched.
 */
function repairMemeUrl(url) {
    if (!url.startsWith('https://api.memegen.link/images/') || /[?&]font=/.test(url)) return url;
    try {
        const queryIdx = url.indexOf('?');
        const path = decodeURIComponent(queryIdx === -1 ? url : url.slice(0, queryIdx));
        if (/[^\x00-\x7F]/.test(path)) {
            return `${url}${url.includes('?') ? '&' : '?'}font=notosans`;
        }
    } catch { /* malformed percent-encoding — keep the original URL */ }
    return url;
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
        const nodes = root.querySelectorAll('[data-dsc-media-src]');
        let upgraded = 0;
        for (const node of nodes) {
            const rawUrl = node.getAttribute?.('data-dsc-media-src');
            const type = node.getAttribute?.('data-dsc-media-type') || 'gif';
            // Re-verify the allowlist at DOM time: even if a forged URL got
            // persisted into cached HTML, it never becomes an <img> here.
            if (!rawUrl || !isAllowedMediaUrl(rawUrl)) {
                node.setAttribute?.('data-dsc-media-dropped', '1');
                continue;
            }
            const url = repairMemeUrl(rawUrl);
            const img = document.createElement('img');
            img.className = `dsc_gif_img dsc_gif_${type}`;
            img.setAttribute('loading', 'lazy');
            img.setAttribute('decoding', 'async');
            img.setAttribute('referrerpolicy', 'no-referrer');
            img.alt = node.getAttribute?.('data-dsc-media-alt') || '';
            img.src = url;
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

        // ── Reactions (optional, max 6 chips) ──
        let reactionsHtml = '';
        if (msg.reactions && msg.reactions.length > 0) {
            const chips = msg.reactions.slice(0, 6).map(r =>
                `<span class="dsc_reaction"><span class="dsc_reaction_emoji">${escapeHtml(r.emoji)}</span>${r.count ? `<span class="dsc_reaction_count">${escapeHtml(r.count)}</span>` : ''}</span>`
            ).join('');
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
