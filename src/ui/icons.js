// @ts-check
/**
 * DS Comments — Icon set (Lucide/Feather-style inline SVG)
 * Unified visual language: 18px, stroke 1.75, currentColor.
 *
 * iconHtml(name) embeds the paths directly in the <svg>. Icons must NOT use
 * <use href="#..."> sprite references: feed content passes through DOMPurify
 * (core.js sanitize), which strips <use> — a sprite icon would silently render
 * as an empty box in the panel.
 */

const ICONS = {
    // regen / refresh-cw
    regen: '<path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8"/><path d="M21 3v5h-5"/><path d="M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16"/><path d="M3 21v-5h-5"/>',
    // qs / sliders-horizontal
    qs: '<line x1="21" x2="14" y1="4" y2="4"/><line x1="10" x2="3" y1="4" y2="4"/><line x1="21" x2="12" y1="12" y2="12"/><line x1="8" x2="3" y1="12" y2="12"/><line x1="21" x2="16" y1="20" y2="20"/><line x1="12" x2="3" y1="20" y2="20"/><line x1="14" x2="14" y1="2" y2="6"/><line x1="8" x2="8" y1="10" y2="14"/><line x1="16" x2="16" y1="18" y2="22"/>',
    // typography / type
    type: '<polyline points="4 7 4 4 20 4 20 7"/><line x1="9" x2="15" y1="20" y2="20"/><line x1="12" x2="12" y1="4" y2="20"/>',
    // spinner (for generation)
    spinner: '<path d="M21 12a9 9 0 1 1-6.219-8.56"/>',
    // message-square (empty state)
    message: '<path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>',
    // sparkles (CTA generate)
    sparkles: '<path d="M9.937 15.5A2 2 0 0 0 8.5 14.063l-6.135-1.582a.5.5 0 0 1 0-.962L8.5 9.936A2 2 0 0 0 9.937 8.5l1.582-6.135a.5.5 0 0 1 .963 0L14.063 8.5A2 2 0 0 0 15.5 9.937l6.135 1.581a.5.5 0 0 1 0 .964L15.5 14.063a2 2 0 0 0-1.437 1.437l-1.582 6.135a.5.5 0 0 1-.963 0z"/><path d="M20 3v4"/><path d="M22 5h-4"/><path d="M4 17v2"/><path d="M5 18H3"/>',
};

const SVG_ATTRS = 'fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"';

/**
 * Return an inline SVG icon with the paths embedded (no <use> — DOMPurify strips it).
 * @param {string} name
 * @param {{spin?: boolean, size?: number}} [opts]
 */
export function iconHtml(name, opts = {}) {
    const cls = opts.spin ? 'dsc-icon dsc-icon-spin' : 'dsc-icon';
    const size = opts.size || 18;
    return `<svg class="${cls}" width="${size}" height="${size}" viewBox="0 0 24 24" ${SVG_ATTRS} aria-hidden="true">${ICONS[name] ?? ''}</svg>`;
}
