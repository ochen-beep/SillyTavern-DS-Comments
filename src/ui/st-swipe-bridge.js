// @ts-check
/**
 * DS Comments — ST swipe bridge (DEFERRED)
 *
 * Simplified sync model: bidirectional ST swipe mutation from the
 * panel is intentionally DEFERRED. The panel horizontal swipe restores cached
 * commentary LOCALLY via selectCommentaryTarget (see feed-gestures.js) and no
 * longer calls this bridge. Core sync correctness therefore never depends on
 * `/script.js` being loaded — the previous hot-path coupling broke sync on
 * mobile (ST via Termux) when the bridge was unavailable.
 *
 * The dynamic-import scaffold (`_load`, `_testInject`) is preserved so a future
 * opt-in feature flag can re-enable ST mutation without rebuilding the seam.
 * Until then, triggerStSwipeChange() is a no-op stub that logs a warning and
 * returns false; failure cannot break core sync.
 *
 * Re-enabling bidirectional ST mutation is tracked as future work and must be
 * designed behind an explicit feature flag (edge cases: picker positioning,
 * swipe generation vs navigation, race with MESSAGE_SWIPED). See the
 * simplified-sync contract in feed-gestures.js and events.js (MESSAGE_SWIPED).
 */

import { trace, warn } from '../core.js';

// Cached ST exports — kept for the deferred re-enable path and the test seam.
// Unused on the hot path while the bridge is deferred.
let _swipe = null;          // () => Promise<void>
let _direction = null;      // { LEFT, RIGHT }
let _source = null;         // { SWIPE_PICKER, … }
let _loadPromise = null;    // shared pending load

async function _load() {
    if (_swipe) return true;
    if (_loadPromise) return _loadPromise;

    _loadPromise = (async () => {
        try {
            const mod = await import('/script.js');
            _swipe    = mod.swipe;
            _direction = mod.SWIPE_DIRECTION;
            _source   = mod.SWIPE_SOURCE;
            if (typeof _swipe !== 'function') {
                warn('ST swipe() is not a function — swipe bridge disabled.');
                _swipe = null;
            }
            return !!_swipe;
        } catch (e) {
            warn('ST swipe() unavailable, feed→tavern swipe sync disabled:', e);
            return false;
        } finally {
            _loadPromise = null;
        }
    })();

    return _loadPromise;
}

/**
 * Ask SillyTavern to switch the active swipe of an existing variant.
 *
 * DEFERRED: this is a no-op stub. Re-enabling bidirectional ST mutation from
 * the panel is future work behind an explicit feature flag. The simplified
 * sync model keeps the chat as the source of truth for the current swipe and
 * restores cached commentary locally from the panel gesture path.
 *
 * @param {string|number} msgId
 * @param {number} targetSwipeIdx
 * @returns {Promise<boolean>} true if the call reached ST successfully. Always
 *   false while the bridge is deferred.
 */
export async function triggerStSwipeChange(msgId, targetSwipeIdx) {
    // The bridge is deferred in the simplified sync model. Returning false
    // here lets any hypothetical caller fall back to local restore without
    // depending on /script.js being loaded.
    void msgId; void targetSwipeIdx;
    trace('triggerStSwipeChange: deferred in simplified sync mode');
    return false;
}

// ── Test-only hook ──
// Lets unit tests inject a mock swipe() without touching /script.js. Kept so
// the deferred re-enable path can be developed against tests without
// rebuilding the seam.
export const _testInject = (typeof process !== 'undefined' && process?.env?.NODE_TEST === '1')
    ? (mock) => {
        _swipe     = mock?.swipe    ?? null;
        _direction = mock?.SWIPE_DIRECTION ?? null;
        _source    = mock?.SWIPE_SOURCE    ?? null;
    }
    : undefined;
