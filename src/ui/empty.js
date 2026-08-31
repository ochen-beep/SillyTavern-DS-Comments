// @ts-check
/**
 * DS Comments — Empty state renderer
 * 3 empty-feed states: extension disabled / empty-with-CTA / generating.
 * Replaces the old CSS `:empty::before`.
 */

import { tr } from '../core.js';
import { iconHtml } from './icons.js';

/**
 * Determine the reason for an empty feed from state.
 * @param {{enabled:boolean, generating:boolean}} s
 * @returns {'disabled'|'empty'|'generating'}
 */
export function detectEmptyReason(s) {
    if (!s.enabled) return 'disabled';
    if (s.generating) return 'generating';
    return 'empty';
}

/**
 * Generate empty-state HTML.
 * @param {'disabled'|'empty'|'generating'} reason
 * @returns {string} HTML string for #dscFeed.innerHTML (empty for 'generating')
 */
export function renderEmptyStateHTML(reason) {
    if (reason === 'generating') {
        // Marker, not '': '' == _dscLastHtml dedup key and wouldn't clear the DOM,
        // leaving the "Generate" CTA visible during generation. Generation status
        // itself shows in the overlay, not the feed.
        return '<!-- dsc:generating -->';
    }
    if (reason === 'disabled') {
        return `<div class="dsc_empty">
            ${iconHtml('message', { size: 32 })}
            <div class="dsc_empty_title">${tr('DS Comments is disabled', 'dscomments.empty.disabledTitle')}</div>
            <div class="dsc_empty_sub">${tr('Enable it in the extension settings.', 'dscomments.empty.disabledHint')}</div>
        </div>`;
    }
    // empty + enabled → "Generate" CTA
    return `<div class="dsc_empty">
        ${iconHtml('message', { size: 32 })}
        <div class="dsc_empty_title">${tr('Commentary for the scene will appear here', 'dscomments.empty.noFeedTitle')}</div>
        <div class="dsc_empty_sub">${tr('Click to generate manually.', 'dscomments.empty.noFeedHint')}</div>
        <button class="dsc_empty_cta" id="dscEmptyGenerate" type="button">
            ${iconHtml('sparkles', { size: 16 })} ${tr('Generate', 'dscomments.action.generate')}
        </button>
    </div>`;
}
