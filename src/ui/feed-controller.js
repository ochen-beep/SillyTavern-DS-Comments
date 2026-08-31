// @ts-check
/**
 * DS Comments — Unified feed controller
 *
 * Single owner of the #dscFeed DOM state. All writes to the feed go through
 * this module: cache.js, generator.js, events.js and others only call
 * showFeedHtml / showEmpty / showGenerating / showDisabled.
 *
 * HTML deduplication prevents rebuilding the DOM and replaying the fade-in
 * when returning to the same post/swipe. The dedup key is the SANITIZED form
 * (see replace): two different raw strings that sanitize to the same output
 * are treated as equal, so a second show of already-safe HTML is a no-op —
 * the repeated sanitize() is cheap (LRU-cached in core.js) and never reaches
 * innerHTML without it. New HTML resets scrollTop; when the feed has no
 * layout box (panel hidden via display:none) the CSSOM View scrollTop setter
 * is a spec no-op and Chromium restores the hide-time offset at reveal, so
 * the reset is deferred to the panel reveal (applyPendingFeedScrollReset).
 */

import { state, sanitize } from '../core.js';
import { detectEmptyReason, renderEmptyStateHTML } from './empty.js';

let _onGenerate = null;

/**
 * Register the generator for the "Generate" button in empty-state.
 * Called once from index.js.init().
 */
export function initFeedController({ generateFeed }) {
    _onGenerate = generateFeed;
}

/**
 * Create a controller with its own feed element source.
 * Factory used in tests; production instance is at the bottom of the module.
 */
export function createFeedController({ getFeedElement, onGenerate, isFeedRendered } = {}) {
    const generate = onGenerate ?? ((...args) => _onGenerate?.(...args));
    // "Has a layout box" probe (CSSOM View). Injectable for tests; the default
    // treats stub elements without getClientRects as unrendered.
    const hasLayout = isFeedRendered
        ?? ((feed) => typeof feed.getClientRects === 'function' && feed.getClientRects().length > 0);

    /**
     * Sanitize and replace innerHTML, reset scroll.
     *
     * No raw HTML reaches innerHTML: cache (chatMetadata) and pinned feeds
     * travel with exported chats, so a forged META_KEY in an imported chat
     * must not execute in the browser. sanitize() (core.js) runs DOMPurify
     * with the media/link FORBID list; empty-state markup (div/button +
     * #dscEmptyGenerate) passes unchanged. Dedup compares the sanitized
     * string so a re-show of the same already-safe HTML is a no-op.
     */
    function replace(html) {
        const safe = sanitize(html);
        const feed = getFeedElement();
        if (!feed || (feed._dscLastHtml === safe && feed.innerHTML === safe)) return false;
        feed._dscLastHtml = safe;
        feed.innerHTML = safe;
        feed.scrollTop = 0;
        // While the feed has no layout box the scrollTop write above is a spec
        // no-op, and Chromium restores the hide-time offset at reveal — a feed
        // swapped under a hidden panel would reopen at a stale reading
        // position. Arm the reset; the panel reveal tail consumes it.
        if (!hasLayout(feed)) feed._dscPendingScrollReset = true;
        return true;
    }

    /** Render empty-state for the current state and attach the CTA. */
    function renderEmpty() {
        const reason = detectEmptyReason({
            enabled: state.settings.enabled,
            generating: state.generationInProgress,
        });
        const html = renderEmptyStateHTML(reason);
        if (!replace(html)) return false;
        const feed = getFeedElement();
        if (reason === 'empty') {
            const cta = feed.querySelector('#dscEmptyGenerate');
            if (cta) cta.addEventListener('click', () => generate(null, null, true));
        }
        return true;
    }

    return {
        /** Show arbitrary HTML or empty-state if the string is empty. */
        showHtml(html) {
            if (!html) return renderEmpty();
            return replace(String(html));
        },
        showEmpty() { return renderEmpty(); },
        showGenerating() { return replace(renderEmptyStateHTML('generating')); },
        showDisabled() { return replace(renderEmptyStateHTML('disabled')); },
    };
}

/**
 * Apply a scroll reset that replace() deferred because the feed had no layout
 * box (panel hidden). Called from the panel reveal tail in ui/window.js after
 * the browser has restored the hide-time scroll offset, so the write lands.
 */
export function applyPendingFeedScrollReset() {
    const feed = document.getElementById('dscFeed');
    if (feed?._dscPendingScrollReset) {
        feed._dscPendingScrollReset = false;
        feed.scrollTop = 0;
    }
}

// Production instance: element is looked up lazily on every call.
const _controller = createFeedController({
    getFeedElement: () => document.getElementById('dscFeed'),
});

export const showFeedHtml        = (html) => _controller.showHtml(html);
export const showFeedEmpty       = () => _controller.showEmpty();
export const showFeedGenerating  = () => _controller.showGenerating();
export const showFeedDisabled    = () => _controller.showDisabled();
