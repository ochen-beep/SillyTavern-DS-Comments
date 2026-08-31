// @ts-check
/**
 * DS Comments — Feed gestures
 * Two silent post-switching gestures (restore cache, never generate):
 *   1. Vertical overscroll-pull at feed edges (touch + wheel).
 *   2. Horizontal swipe (touch only) flips swipes of the CURRENT post.
 * The dominant axis is decided by the first ~8px of motion.
 *
 * Simplified sync model: the horizontal swipe restores the
 * adjacent swipe's cached commentary LOCALLY via selectCommentaryTarget. It
 * does not call the ST swipe bridge — bidirectional ST swipe mutation from
 * the panel is deferred behind an explicit feature flag (see
 * st-swipe-bridge.js) so core sync correctness never depends on /script.js
 * being loaded. The chat is the source of truth for the current swipe; the
 * MESSAGE_SWIPED handler in events.js remains the canonical chat → feed path.
 */

import { state, getCtx, aiPostIndices, trace, tr } from '../core.js';
import {
    selectCommentaryTarget, updatePostIndicator,
} from '../cache.js';
// The ST swipe bridge is intentionally deferred (see st-swipe-bridge.js); it is
// not imported here. Re-enabling bidirectional ST mutation is future work.

const PULL_THRESHOLD = 48;     // px of vertical pull before triggering
const SWIPE_THRESHOLD = 52;    // px of horizontal swipe before triggering
const AXIS_LOCK = 8;          // px: threshold for deciding the dominant touch axis
// Mouse wheel (desktop) — overscroll when scrolling past the feed edge.
const WHEEL_THRESHOLD = 150;
// Dwell-gate: switching requires both accumulation >= WHEEL_THRESHOLD and
// gesture duration >= WHEEL_DWELL_MS. A single high-resolution wheel tick is a
// short burst, so it does not accidentally switch posts.
const WHEEL_DWELL_MS = 220;
// Idle reset — higher than touch: a sustained gesture shouldn't break on small
// pauses between ticks (250ms broke on a regular mouse).
const WHEEL_RESET_MS = 500;

function observeAsyncCallback(result, label) {
    if (!result || typeof result.then !== 'function') return;
    Promise.resolve(result).catch(error => console.warn(`[DS Comments] ${label} error:`, error));
}

// Per-session tr() cache. Locale strings are static within a session, but tr()
// resolves through getCtx().translate on every call — a per-touchmove cost on
// the high-frequency indicator-update path. Memoized by translation key; the
// fallback string at each call site is constant, so key alone is a safe cache
// key. Cleared implicitly on page reload (module scope, not session-scoped).
const _trCache = new Map();
function trc(fallback, key) {
    let v = _trCache.get(key);
    if (v === undefined) {
        v = tr(fallback, key);
        _trCache.set(key, v);
    }
    return v;
}

function scrollChatToPost(msgId) {
    try {
        const el = document.querySelector(`[mesid="${msgId}"]`);
        if (el) el.scrollIntoView({ behavior: 'smooth', block: 'center' });
    } catch { /* skip */ }
}

/**
 * Move to the adjacent AI post. dir = +1 (next) | -1 (previous).
 * Restores cache or shows empty-state; never generates.
 */
async function goToAdjacentPost(dir) {
    if (state.settings.noSaveMode) {
        trace(`gesture post ignored: noSaveMode dir=${dir}`);
        return;
    }
    if (Date.now() < state.navLockUntil) {
        trace(`gesture post ignored: navLock active dir=${dir}`);
        return;
    }
    const idxs = aiPostIndices();
    if (!idxs.length) {
        trace(`gesture post ignored: no AI posts dir=${dir}`);
        return;
    }
    const cur = parseInt(state.currentPostId);
    let pos = idxs.indexOf(cur);
    if (pos === -1) pos = idxs.length - 1;     // no current → last
    const newPos = Math.max(0, Math.min(idxs.length - 1, pos + dir));
    if (newPos === pos) {
        trace(`gesture post ignored: at edge cur=${cur} dir=${dir} pos=${pos}`);
        return;
    }
    const msgId = idxs[newPos];
    const msg = getCtx().chat?.[msgId];
    const swipe = typeof msg?.swipe_id === 'number' ? msg.swipe_id : 0;
    trace(`gesture post -> #${msgId}[${swipe}] from=${state.currentPostId}[${state.currentSwipeIdx}] dir=${dir}`);
    state.navLockUntil = Date.now() + 800;
    scrollChatToPost(msgId);

    const result = await selectCommentaryTarget(String(msgId), swipe, { source: 'overscroll' });
    if (result.status === 'superseded') {
        trace(`gesture post superseded -> #${msgId}[${swipe}] dir=${dir}`);
        return;
    }
    updatePostIndicator();
}

/**
 * Swipe bounds of the CURRENT post: { total, current }.
 * total — how many swipes the message has (≥1), current — active index.
 */
function swipeBounds() {
    try {
        if (state.currentPostId === null) return { total: 1, current: 0 };
        const msg = getCtx().chat?.[parseInt(state.currentPostId)];
        const total = Array.isArray(msg?.swipes) ? msg.swipes.length : 1;
        return { total, current: state.currentSwipeIdx };
    } catch { return { total: 1, current: 0 }; }
}

/**
 * Move to the adjacent swipe of the CURRENT post. dir = +1 (next) | -1 (previous).
 * Restores cached commentary locally (simplified sync model - see file header);
 * never generates. Stops at first/last. noSaveMode is a no-op.
 */
async function goToAdjacentSwipe(dir) {
    if (Date.now() < state.navLockUntil) {
        trace(`gesture swipe ignored: navLock active dir=${dir}`);
        return;
    }
    if (state.settings.noSaveMode) {
        trace(`gesture swipe ignored: noSaveMode dir=${dir}`);
        return;            // one feed per chat, no swipes
    }
    if (state.currentPostId === null) {
        trace(`gesture swipe ignored: no current post dir=${dir}`);
        return;
    }
    const { total, current } = swipeBounds();
    const newSwipe = Math.max(0, Math.min(total - 1, current + dir));
    if (newSwipe === current) {
        trace(`gesture swipe ignored: at edge post=${state.currentPostId} current=${current} total=${total} dir=${dir}`);
        return;
    }
    const msgId = String(state.currentPostId);
    trace(`gesture swipe -> #${msgId}[${newSwipe}] from=${current} dir=${dir} total=${total} (local-only)`);
    const result = await selectCommentaryTarget(msgId, newSwipe, { source: 'panel swipe local' });
    if (result.status === 'superseded') {
        trace(`gesture swipe superseded -> #${msgId}[${newSwipe}]`);
        return;
    }
    updatePostIndicator();
}

// Test-only exports (NODE_TEST guard — invisible in the ST browser host).
// Lets unit tests drive navigation tails without DOM touch gestures or
// IntersectionObserver.
export const _testGoToAdjacentPost = typeof process !== 'undefined' && process?.env?.NODE_TEST === '1'
    ? (dir) => goToAdjacentPost(dir)
    : undefined;

export const _testGoToAdjacentSwipe = typeof process !== 'undefined' && process?.env?.NODE_TEST === '1'
    ? (dir) => goToAdjacentSwipe(dir)
    : undefined;

/**
 * Attach overscroll gestures to the feed. Idempotent (flag on the feed element
 * so it survives panel recreation). All listeners are registered with a
 * per-feed AbortController signal — destroyFeedGestures() revokes them in one
 * call, removing the listener-leak surface across panel re-mounts.
 */
export function initFeedGestures() {
    const feed = document.getElementById('dscFeed');
    if (!feed || feed._dscGesturesBound) return;
    feed._dscGesturesBound = true;

    // Single abort controller for all gesture listeners on this feed element —
    // abort() removes every addEventListener below that used `signal`. Cleaner
    // than five removeEventListener pairs with named handler refs.
    const ac = new AbortController();
    const signal = ac.signal;

    let startY = 0, atEdge = null;   // 'top' | 'bottom' | 'both' | null
    let pullDy = 0;
    // Horizontal swipe
    let startX = 0, swipeDx = 0;
    /** null | 'h' | 'v' — locked axis of the current touch */
    let axis = null;
    let indicator = null;
// Wheel overscroll accumulation. Trackpads emit streams of small deltas that
// sum past the threshold during an inertial flick into the edge, which fired a
// spurious post jump on the original single-event gate.
let wheelAccum = 0;
    let wheelEdge = null;   // 'top' | 'bottom' | null — which edge we're accumulating toward
    let wheelResetTimer = 0;
    let wheelGestureStart = 0;   // timestamp of the first edge event of the current gesture (dwell-gate)

    // ── Coalesced indicator writes ──
    // High-frequency touchmove/wheel events only mutate _pendingIndicator; a
    // single rAF tick applies the classList + textContent mutations at most
    // once per frame. Mirrors the drag/resize pattern in ui/window.js: the
    // pointer-move handler stores the latest transform, the rAF callback
    // writes it. Without this, a ~120Hz touchscreen/trackpad triggered 120
    // classList+textContent + 6 tr() calls per second on the indicator.
    let _moveRaf = 0;
    /** @type {{classes: Record<string, boolean>, text: string} | null} */
    let _pendingIndicator = null;

    function ensureIndicator() {
        if (!indicator || !indicator.isConnected) {
            indicator = document.createElement('div');
            indicator.className = 'dsc_pull_indicator';
            feed.parentElement?.insertBefore(indicator, feed);
        }
        return indicator;
    }
    function applyIndicator(payload) {
        const ind = ensureIndicator();
        const c = ind.classList;
        c.toggle('dsc_swipe_next',  !!payload.classes.dsc_swipe_next);
        c.toggle('dsc_swipe_prev',  !!payload.classes.dsc_swipe_prev);
        c.toggle('dsc_swipe_h',     !!payload.classes.dsc_swipe_h);
        c.toggle('dsc_swipe_ready', !!payload.classes.dsc_swipe_ready);
        c.toggle('dsc_pull_show',   !!payload.classes.dsc_pull_show);
        c.toggle('dsc_pull_ready',  !!payload.classes.dsc_pull_ready);
        if (ind.textContent !== payload.text) ind.textContent = payload.text;
    }
    function scheduleIndicator(payload) {
        _pendingIndicator = payload;
        if (_moveRaf) return;   // already scheduled — payload will be picked up
        _moveRaf = requestAnimationFrame(() => {
            _moveRaf = 0;
            const p = _pendingIndicator; _pendingIndicator = null;
            if (p) applyIndicator(p);
        });
    }
    function cancelPendingIndicator() {
        if (_moveRaf) { cancelAnimationFrame(_moveRaf); _moveRaf = 0; }
        _pendingIndicator = null;
    }
    function hideIndicator() {
        // Cancel any in-flight rAF first, otherwise a pending scheduled write
        // could re-apply classes/text AFTER this hide call (race on touchend).
        cancelPendingIndicator();
        if (!indicator) return;
        indicator.classList.remove(
            'dsc_pull_show', 'dsc_pull_ready',
            'dsc_swipe_h', 'dsc_swipe_prev', 'dsc_swipe_next',
        );
    }
    function atTop()    { return feed.scrollTop <= 0; }
    function atBottom() { return feed.scrollTop + feed.clientHeight >= feed.scrollHeight - 1; }

    feed.addEventListener('touchstart', (e) => {
        const t = e.touches[0];
        // Capture the real touch origin and reset gesture state BEFORE the
        // generation gate. touchmove does not re-check generationInProgress, and
        // touchend never resets startX/startY, so a touchstart fired mid-generation
        // would otherwise leave startX/startY holding the PREVIOUS gesture's origin;
        // if generation finished before touchend, navigation would fire on stale
        // deltas. Capturing the real origin here makes any late-firing navigation
        // use real deltas, and clearing atEdge suppresses pull navigation for a
        // touch that began during generation (safer than a stale edge read).
        startX = t.clientX; startY = t.clientY;
        pullDy = 0; swipeDx = 0; axis = null; atEdge = null;
        if (!state.settings.enabled || state.generationInProgress || state.settings.noSaveMode) return;
        // Content shorter than the viewport -> atTop && atBottom simultaneously.
        // Direction is unknown at touchstart, so lock 'both' and resolve the edge
        // by dy sign in touchmove. Otherwise "pull up -> next post" silently failed
        // on short posts (priority was 'top').
        {
            const top = atTop(), bottom = atBottom();
            atEdge = (top && bottom) ? 'both' : (top ? 'top' : (bottom ? 'bottom' : null));
        }
    }, { passive: true, signal });

    // passive:false is needed for preventDefault on the horizontal axis so the
    // browser doesn't try to "scroll" sideways; preventDefault is called only
    // when the axis is locked to horizontal.
    feed.addEventListener('touchmove', (e) => {
        if (!state.settings.enabled || state.settings.noSaveMode) return;
        const t = e.touches[0];
        const dx = t.clientX - startX;
        const dy = t.clientY - startY;
        const adx = Math.abs(dx), ady = Math.abs(dy);

        // Decide the dominant axis once, from the first noticeable pixels.
        if (!axis) {
            if (adx < AXIS_LOCK && ady < AXIS_LOCK) return;
            axis = adx > ady ? 'h' : 'v';
            if (axis === 'h') { pullDy = 0; atEdge = null; }   // kill vertical indicator
        }

        if (axis === 'h') {
            swipeDx = dx;
            e.preventDefault();   // block horizontal "scroll"/swipe-back of the page
            // Swipe flipping is unavailable during generation and in noSaveMode
            // (one feed per chat, not tied to a swipe). Gesture is consumed without effect.
            if (state.generationInProgress || state.settings.noSaveMode) return;
            const pull = Math.abs(swipeDx);
            if (pull > 6) {
                const next = swipeDx < 0;                 // swipe left → next swipe
                const { total, current } = swipeBounds();
                const atSwipeEdge = next ? current >= total - 1 : current <= 0;
                const ready = pull >= SWIPE_THRESHOLD && !atSwipeEdge;
                scheduleIndicator({
                    classes: {
                        dsc_swipe_next: next,
                        dsc_swipe_prev: !next,
                        dsc_swipe_h: true,
                        dsc_pull_show: true,
                        dsc_swipe_ready: ready,
                    },
                    text: atSwipeEdge
                        ? (next
                            ? trc('Last swipe ›', 'dscomments.gesture.swipe.last')
                            : trc('‹ First swipe', 'dscomments.gesture.swipe.first'))
                        : (ready
                            ? (next
                                ? trc('Next swipe ›', 'dscomments.gesture.swipe.next')
                                : trc('‹ Previous swipe', 'dscomments.gesture.swipe.previous'))
                            : (next
                                ? trc('Swipe further →', 'dscomments.gesture.swipe.continueNext')
                                : trc('← Swipe further', 'dscomments.gesture.swipe.continuePrevious'))),
                });
            }
            return;
        }

        // Vertical axis — normal scroll; overscroll-pull only at the edge.
        if (!atEdge || state.generationInProgress) return;
        // 'both' (short post) -> resolve edge by dy sign (see touchstart).
        const vEdge = atEdge === 'both' ? (dy > 0 ? 'top' : 'bottom') : atEdge;
        // top edge + pull DOWN (dy>0) → previous; bottom edge + pull UP (dy<0) → next
        if (vEdge === 'top' && dy > 0) pullDy = dy;
        else if (vEdge === 'bottom' && dy < 0) pullDy = dy;
        else { pullDy = 0; hideIndicator(); return; }

        const absPull = Math.abs(pullDy);
        if (absPull > 6) {
            const ready = absPull >= PULL_THRESHOLD;
            scheduleIndicator({
                classes: {
                    dsc_pull_show: true,
                    dsc_pull_ready: ready,
                },
                text: ready
                    ? (vEdge === 'top'
                        ? trc('▲ Previous post', 'dscomments.gesture.post.previous')
                        : trc('▼ Next post', 'dscomments.gesture.post.next'))
                    : (vEdge === 'top'
                        ? trc('↑ Pull for previous', 'dscomments.gesture.pull.previous')
                        : trc('↓ Pull for next', 'dscomments.gesture.pull.next')),
            });
        }
    }, { passive: false, signal });

    feed.addEventListener('touchend', () => {
        const lastAxis = axis;
        const adx = Math.abs(swipeDx), apull = Math.abs(pullDy);
        hideIndicator();
        // Suppress navigation during generation (consistent with touchstart): a
        // swipe/pull completing mid-gen would race the in-flight result. The
        // gesture state is still reset below so a stale swipeDx can't fire later.
        const gen = state.generationInProgress;
        if (state.settings.noSaveMode) {
            atEdge = null; pullDy = 0; swipeDx = 0; axis = null;
            return;
        }
        if (lastAxis === 'h') {
            if (!gen && adx >= SWIPE_THRESHOLD) {
                // swipe left (swipeDx<0) -> next swipe (+1), right -> previous (-1)
                observeAsyncCallback(goToAdjacentSwipe(swipeDx < 0 ? 1 : -1), 'gesture swipe restore');
            }
        } else if (atEdge) {
            if (!gen && apull >= PULL_THRESHOLD) {
                // 'both' (short post) -> edge by pullDy sign (see touchstart).
                const vEdge = atEdge === 'both' ? (pullDy > 0 ? 'top' : 'bottom') : atEdge;
                observeAsyncCallback(goToAdjacentPost(vEdge === 'top' ? -1 : 1), 'gesture post restore');
            }
        }
        atEdge = null; pullDy = 0; swipeDx = 0; axis = null;
    }, { passive: true, signal });

    feed.addEventListener('touchcancel', () => {
        hideIndicator();
        atEdge = null; pullDy = 0; swipeDx = 0; axis = null;
    }, { passive: true, signal });

    // Mouse wheel (desktop) - overscroll when scrolling past the feed edge.
    // Dwell-gate requires both amplitude and duration; wheelGestureStart && acts
    // as a fail-safe if the edge/start invariant ever breaks.
    feed.addEventListener('wheel', (e) => {
        if (!state.settings.enabled || state.generationInProgress || state.settings.noSaveMode) {
            // In steady-state noSave this is a bare runtime guard: no layout
            // reads, DOM work, rAF, or timer churn. Clear only a gesture that
            // began before a mode/generation transition.
            const hasWheelGesture = wheelAccum !== 0 || wheelEdge !== null || wheelGestureStart !== 0 || wheelResetTimer !== 0;
            wheelAccum = 0; wheelEdge = null; wheelGestureStart = 0;
            if (wheelResetTimer) { clearTimeout(wheelResetTimer); wheelResetTimer = 0; }
            if (hasWheelGesture || _moveRaf) hideIndicator();
            return;
        }
        const top = atTop(), bottom = atBottom();
        // Edge = position AND scroll direction INTO the edge. When post content is
        // shorter than the viewport (scrollHeight ≤ clientHeight), atTop and atBottom
        // are both true — here direction is the only discriminator: deltaY>0 → bottom
        // (next post), deltaY<0 → top (previous post). Previously 'top' had priority,
        // and "down" on a short post silently died (intoEdge=false → reset).
        const edge = (top && e.deltaY < 0) ? 'top'
                   : (bottom && e.deltaY > 0) ? 'bottom'
                   : null;
        if (!edge) {
            wheelAccum = 0; wheelEdge = null; wheelGestureStart = 0;
            hideIndicator();
            return;
        }

        // New gesture (edge changed) — reset accumulation and restart dwell.
        if (wheelEdge !== edge) {
            wheelAccum = 0; wheelEdge = edge; wheelGestureStart = Date.now();
            hideIndicator();
        }
        wheelAccum += Math.abs(e.deltaY);

        // Visible progress indicator (mirrors the touch gesture).
        if (wheelAccum > 6) {
            const ready = wheelAccum >= WHEEL_THRESHOLD;
            scheduleIndicator({
                classes: {
                    dsc_pull_show: true,
                    dsc_pull_ready: ready,
                },
                text: ready
                    ? (edge === 'top'
                        ? trc('▲ Previous post', 'dscomments.gesture.post.previous')
                        : trc('▼ Next post', 'dscomments.gesture.post.next'))
                    : (edge === 'top'
                        ? trc('↑ Scroll for previous', 'dscomments.gesture.wheel.previous')
                        : trc('↓ Scroll for next', 'dscomments.gesture.wheel.next')),
            });
        }

        clearTimeout(wheelResetTimer);
        wheelResetTimer = setTimeout(() => {
            wheelAccum = 0; wheelEdge = null; wheelGestureStart = 0; hideIndicator();
        }, WHEEL_RESET_MS);

        // Dwell-gate: both amplitude and duration must be met.
        if (wheelAccum >= WHEEL_THRESHOLD && wheelGestureStart && (Date.now() - wheelGestureStart) >= WHEEL_DWELL_MS) {
            wheelAccum = 0; wheelEdge = null; wheelGestureStart = 0; hideIndicator();
            observeAsyncCallback(goToAdjacentPost(edge === 'top' ? -1 : 1), 'wheel post restore');
        }
    }, { passive: true, signal });

    // Per-feed teardown: abort all 5 listeners + cancel rAF + clear wheel timer.
    // cleanup() in index.js invokes destroyFeedGestures(), keeping listener
    // lifetime bounded by the panel/DOM lifetime instead of leaking across re-mounts.
    feed._dscDestroyGestures = () => {
        if (wheelResetTimer) { clearTimeout(wheelResetTimer); wheelResetTimer = 0; }
        cancelPendingIndicator();
        ac.abort();
        if (feed._dscGesturesBound) delete feed._dscGesturesBound;
        delete feed._dscDestroyGestures;
    };
}

/**
 * Remove all gesture listeners + cancel pending indicator updates for the
 * current #dscFeed. Safe to call when gestures were never initialised (no-op).
 */
export function destroyFeedGestures() {
    const feed = document.getElementById('dscFeed');
    feed?._dscDestroyGestures?.();
}