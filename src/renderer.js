// @ts-check
/**
 * DS Comments — Renderer module
 * Converts parsed commentary messages into HTML: colorful hash-nick,
 * reactions, reply chains, mini-markdown, DOMPurify sanitization.
 */

import { escapeHtml, sanitize, hashHue } from './core.js';

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
 * Render an array of parsed commentary messages into an HTML string.
 * @param {Array<{username: string, content: string, replyTo: string|null, replyQuote: string|null, reactions: Array<{emoji: string, count: string}>}>} messages
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
        const content = formatMessageContent(msg.content);

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
                    ${reactionsHtml}
                </div>
            </div>
        </div>`;
    }).join('');
}
