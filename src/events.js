// @ts-check
/**
 * DS Comments — Events module
 *
 * CHARACTER_MESSAGE_RENDERED is the single generation trigger (fires AFTER DOM
 * render — swipe_id is accurate). MESSAGE_SWIPED restores cache (no generation).
 * The scroll observer only RESTORES cache. requestAnimationFrame batches scroll.
 */

import { state, getCtx, trace, warn, isCommentaryDisplayEligible, resolveLastAIPost, getMessageSwipeIdx, bumpGenerationEpoch, pushRestoreLog } from './core.js';
import { recordEvent } from './event-log.js';
import { isPanelVisible } from './ui/window.js';
import { loadFeedStore, pruneOrphanedEntries, noteChatRenamed } from './feed-file-store.js';
import { getCachedPost, resolvePreferredCommentaryTarget, selectCommentaryTarget, setCurrentPost, updatePostIndicator, showCurrentFeed } from './cache.js';
import { showFeedHtml as setFeedText } from './ui/feed-controller.js';

let _postScrollObserver = null;
let _postMutObserver = null;
let _eventsBound = false;
let _boundEventSource = null;
let _eventHandlers = [];

// Event-owned observer restart timers (cancelled on unbind).
let _chatChangedRestartTimer = null;
let _msgEditedRestartTimer = null;

// ── Scroll observer state ──
let _scrollContainer = null;
let _scrollHandler = null;
let _candidates = new Map();
let _scrollRaf = 0;
let _pickRaf = 0;
let _suppressedRepickTimer = 0;
let _suppressedRepickDueAt = 0;

function noteGenerationNavigation(msgId, swipeIdx, source) {
    if (!state.generationInProgress || !state.generationTarget) return;
    const next = { msgId: String(msgId), swipeIdx: Number(swipeIdx) || 0, source };
    const prior = state.generationObservedTarget;
    if (prior?.msgId === next.msgId && prior?.swipeIdx === next.swipeIdx) return;
    state.generationObservedTarget = next;
    recordEvent(
        'log',
        `event=generation_navigation generationTarget=#${state.generationTarget.msgId}[${state.generationTarget.swipeIdx}] observed=#${next.msgId}[${next.swipeIdx}] source=${source}`
    );
}

// Throttle for the querySelectorAll('[mesid]') catch-up scan in
// refreshVisibleCandidates — IO already reports visibility for observed nodes,
// the catch-up is just a lag buffer for fast scrolls where IO hasn't fired yet.
// Running it on every pick frame forced getBoundingClientRect across the entire
// chat on long chats, throttling scroll. 200ms keeps the lag buffer responsive
// while bounding the per-frame rect-scan cost.
let _lastCatchUpAt = 0;
const _CATCH_UP_MIN_INTERVAL_MS = 200;
// Deferred-init retry state: while #chat is zero-height (not yet rendered),
// initPostScrollObserver reschedules itself on the next frame instead of
// attaching observers to a collapsed node.
let _initRetryRaf = 0;
let _initRetries = 0;
const _INIT_MAX_RETRIES = 30;   // ~0.5s at 60fps — enough for a reveal animation

/**
 * Initialize IntersectionObserver for scroll-based post tracking.
 * Scroll only restores cache — it NEVER triggers generation.
 */
export function initPostScrollObserver() {
    if (_postScrollObserver) { _postScrollObserver.disconnect(); _postScrollObserver = null; }
    if (_postMutObserver) { _postMutObserver.disconnect(); _postMutObserver = null; }
    _removeScrollHandler();
    if (_scrollRaf) cancelAnimationFrame(_scrollRaf);
    if (_pickRaf) cancelAnimationFrame(_pickRaf);
    if (_suppressedRepickTimer) clearTimeout(_suppressedRepickTimer);
    _scrollRaf = 0; _pickRaf = 0; _suppressedRepickTimer = 0; _suppressedRepickDueAt = 0;
    _candidates.clear();
    _lastCatchUpAt = 0;   // allow immediate first-pick catch-up after rebuild

    if (!state.settings.enabled) {
        pushRestoreLog('observer', 'skip init: disabled');
        return;
    }

    const chatEl = document.getElementById('chat');
    if (!chatEl) {
        pushRestoreLog('observer', 'skip init: #chat missing');
        return;
    }

    pushRestoreLog('observer', `init start chatH=${chatEl.clientHeight} scrollTop=${chatEl.scrollTop} collapsed=${!!state.settings.collapsed} navLock=${Math.max(0, state.navLockUntil - Date.now())}`);

    // #chat must be laid out before we observe it: a zero clientHeight means the
    // chat is not yet rendered (e.g. mid-reveal animation on mobile), in which
    // case the IntersectionObserver root and scroll listener would attach to a
    // collapsed node and never fire. Retry on the next animation frame, capped
    // so a permanently-hidden chat can't spin forever.
    if (chatEl.clientHeight === 0) {
        if (_initRetries < _INIT_MAX_RETRIES) {
            _initRetries++;
            pushRestoreLog('observer', `retry zero-height #${_initRetries}`);
            _initRetryRaf = requestAnimationFrame(() => {
                _initRetryRaf = 0;
                initPostScrollObserver();
            });
        } else {
            _initRetries = 0;
            warn('initPostScrollObserver: #chat stayed zero-height, giving up');
            pushRestoreLog('observer', 'give up: #chat stayed zero-height');
        }
        return;
    }
    _initRetries = 0;

    function resolveEligibleMessage(el, ctx = getCtx()) {
        const msgId = el.getAttribute('mesid');
        if (typeof msgId !== 'string' || !/^\d+$/.test(msgId)) return null;
        const msgIdx = Number(msgId);
        if (!Number.isSafeInteger(msgIdx) || msgIdx < 0) return null;
        const msg = ctx.chat?.[msgIdx];
        return isCommentaryDisplayEligible(msg) ? { msgId, msg } : null;
    }

    async function handleBestVisible(bestEl) {
        const ctx = getCtx();
        const resolved = resolveEligibleMessage(bestEl, ctx);
        if (!resolved) return;
        const { msgId, msg } = resolved;
        if (!ctx.chatId) return;
        // navLockUntil suppression lives in schedulePick() (the single chokepoint
        // for the reopen anti-loop window). handleBestVisible must not re-test
        // it: a pick that already escaped schedulePick is a real scroll event
        // and should restore — otherwise scroll-follow starves under long locks
        // (the 15s generator lock starved every pick on mobile).
        const observedSwipeIdx = typeof msg.swipe_id === 'number' ? msg.swipe_id : 0;
        if (state.generationInProgress) {
            noteGenerationNavigation(msgId, observedSwipeIdx, 'scroll');
            return;
        }
        const msgText = (msg.mes || '').trim();
        if (!msgText || msgText === '...' || msgText.length < 5) return;
        const swipeIdx = observedSwipeIdx;
        if (String(msgId) === String(state.currentPostId) && swipeIdx === state.currentSwipeIdx) return;

        // noSaveMode: position only; saveMode: restore cache for the visible post.
        if (state.settings.noSaveMode) {
            setCurrentPost(String(msgId), swipeIdx);
            return;
        }
        const result = await selectCommentaryTarget(String(msgId), swipeIdx, { source: 'scroll' });
        // Restore settled: refresh the post indicator so the chrome matches the
        // feed, unless a newer transition superseded this one.
        if (result.status !== 'superseded') updatePostIndicator();
    }

    _postScrollObserver = new IntersectionObserver((entries) => {
        for (const entry of entries) {
            const id = entry.target.getAttribute('mesid');
            if (!id) continue;
            if (entry.isIntersecting && entry.intersectionRatio > 0) {
                _candidates.set(entry.target, entry.intersectionRatio);
            } else {
                _candidates.delete(entry.target);
            }
        }
        schedulePick();
    }, { root: chatEl, rootMargin: '0px', threshold: [0, 0.25, 0.5] });

    function refreshVisibleCandidates() {
        for (const el of Array.from(_candidates.keys())) {
            if (!chatEl.contains(el)) {
                _candidates.delete(el);
                continue;
            }
            const rect = el.getBoundingClientRect();
            const visible = Math.max(0, Math.min(rect.bottom, window.innerHeight) - Math.max(rect.top, 0));
            if (rect.height <= 0 || visible <= 0) _candidates.delete(el);
        }
        // Catch-up scan: find messages that became visible without an IO callback
        // having reported them yet (e.g. mid-burst IO lag). Throttle to once per
        // _CATCH_UP_MIN_INTERVAL_MS — IO drives _candidates between catches, and
        // scanning the whole chat every pick frame was the main scroll-jank source
        // on long chats. First call after observer (re)build always passes the
        // gate (_lastCatchUpAt starts at 0).
        if (Date.now() - _lastCatchUpAt < _CATCH_UP_MIN_INTERVAL_MS) return;
        _lastCatchUpAt = Date.now();
        const ctx = getCtx();
        for (const el of chatEl.querySelectorAll('[mesid]')) {
            if (_candidates.has(el)) continue;
            if (!resolveEligibleMessage(el, ctx)) continue;
            const rect = el.getBoundingClientRect();
            if (rect.height <= 0) continue;
            const visible = Math.max(0, Math.min(rect.bottom, window.innerHeight) - Math.max(rect.top, 0));
            if (visible > 0) _candidates.set(el, visible / rect.height);
        }
    }

    function isObserverSuppressed() {
        // Reopen suppression: when the panel is freshly revealed, the restore
        // target is set by restoreForCurrentChatPost() and the very first
        // IntersectionObserver pick would otherwise clobber it (the oldest
        // post wins ratio ties, and on mobile the full-screen panel occludes
        // the chat so "best visible" is meaningless right after reveal).
        // The reopen path raises navLockUntil for a short window so scroll-
        // driven auto-follow stays quiet exactly then, and resumes normally
        // afterwards — on BOTH mobile and desktop. This is the SINGLE
        // suppression chokepoint for the scroll observer; handleBestVisible
        // re-tests only generationInProgress so chat-follow never starves
        // under long locks.
        return Date.now() < state.navLockUntil;
    }

    function scheduleSuppressedRepick() {
        const delay = Math.max(0, state.navLockUntil - Date.now());
        const dueAt = Date.now() + delay;
        if (_suppressedRepickTimer) {
            if (_suppressedRepickDueAt <= dueAt) return;
            clearTimeout(_suppressedRepickTimer);
            _suppressedRepickTimer = 0;
            _suppressedRepickDueAt = 0;
        }
        _suppressedRepickDueAt = dueAt;
        _suppressedRepickTimer = setTimeout(() => {
            _suppressedRepickTimer = 0;
            _suppressedRepickDueAt = 0;
            if (!_postScrollObserver) return;
            if (!state.settings.enabled) return;
            schedulePick();
        }, delay);
    }

    function schedulePick() {
        if (_pickRaf) return;
        _pickRaf = requestAnimationFrame(() => {
            _pickRaf = 0;
            if (!state.settings.enabled) return;
            if (isObserverSuppressed()) {
                pushRestoreLog('observer', `pick suppressed navLock=${Math.max(0, state.navLockUntil - Date.now())} candidates=${_candidates.size}`);
                // Mobile/Termux: overscroll and reopen both
                // generate a burst of scroll/IO events while navLockUntil is
                // active. In the real browser, inertia may stop before the lock
                // ends, so no fresh event arrives afterwards and the observer
                // never gets a chance to pick the now-visible post. Schedule one
                // delayed re-pick exactly at lock expiry using the current
                // candidate set.
                scheduleSuppressedRepick();
                return;
            }
            if (_suppressedRepickTimer) {
                clearTimeout(_suppressedRepickTimer);
                _suppressedRepickTimer = 0;
                _suppressedRepickDueAt = 0;
            }
            refreshVisibleCandidates();
            let bestEl = null, bestRatio = 0;
            const vH = window.innerHeight;
            const ctx = getCtx();
            // Re-read rects instead of reusing refreshVisibleCandidates ratios:
            // always-fresh reads can't go stale if an IO callback shifted layout
            // between the two passes. _candidates is a handful of near-viewport
            // nodes, not the whole chat, so the double read is cheap.
            for (const [el] of _candidates) {
                if (!resolveEligibleMessage(el, ctx)) continue;
                const rect = el.getBoundingClientRect();
                if (rect.height <= 0) continue;
                const visible = Math.max(0, Math.min(rect.bottom, vH) - Math.max(rect.top, 0));
                if (visible <= 0) continue;
                const ratio = visible / rect.height;
                if (ratio > bestRatio) { bestRatio = ratio; bestEl = el; }
            }
            if (bestEl) {
                const mesid = bestEl.getAttribute('mesid') || '?';
                pushRestoreLog('observer', `pick best=#${mesid} ratio=${bestRatio.toFixed(3)} candidates=${_candidates.size}`);
                observeAsyncCallback(handleBestVisible(bestEl), 'scroll restore');
            } else if (_candidates.size) {
                pushRestoreLog('observer', `pick none candidates=${_candidates.size}`);
            }
        });
    }

    _scrollHandler = () => {
        if (_scrollRaf) return;
        _scrollRaf = requestAnimationFrame(() => {
            _scrollRaf = 0;
            pushRestoreLog('observer', `scroll event top=${chatEl.scrollTop} candidates=${_candidates.size}`);
            schedulePick();
        });
    };

    _scrollContainer = chatEl;   // SillyTavern scrolls the chat inside #chat itself
                                 // (public/style.css: #chat { overflow-y: scroll }).
                                 // Using #chat directly as both the IO root and the
                                 // scroll-event target fixes mobile browsers, where the
                                 // old findScrollContainer() heuristic could fall back to
                                 // `window` (which never scrolls the chat) when #chat was
                                 // briefly zero-height during the panel reveal animation.
    _scrollContainer.addEventListener('scroll', _scrollHandler, { passive: true });
    pushRestoreLog('observer', `bound scroll root=#chat top=${chatEl.scrollTop} h=${chatEl.clientHeight}`);

    function observeAIEl(el, ctx = getCtx()) {
        const msgid = el.getAttribute('mesid');
        if (!msgid) return;
        const msg = ctx.chat?.[parseInt(msgid)];
        if (!isCommentaryDisplayEligible(msg)) return;
        _postScrollObserver.observe(el);
    }
    // Capture ctx once: getContext() allocates a fresh object per call.
    const observeCtx = getCtx();
    chatEl.querySelectorAll('[mesid]').forEach(el => observeAIEl(el, observeCtx));

    _postMutObserver = new MutationObserver((mutations) => {
        if (!_postScrollObserver) return;
        let hasNewNodes = false;
        for (const m of mutations) {
            if (m.addedNodes.length > 0) { hasNewNodes = true; break; }
        }
        if (!hasNewNodes) return;
        for (const node of chatEl.querySelectorAll('[mesid]')) {
            if (!node.dataset.dscObserved) { node.dataset.dscObserved = '1'; observeAIEl(node); }
        }
        for (const el of _candidates.keys()) {
            if (!chatEl.contains(el)) _candidates.delete(el);
        }
        schedulePick();
    });
    // childList only (no subtree): .mes nodes are direct children of #chat (ST
    // core appends them directly). subtree:true fired on every streaming token
    // via deep .mes_text mutations, running a full querySelectorAll per batch
    // with no useful work — all nodes are already marked observed.
    _postMutObserver.observe(chatEl, { childList: true });
}

function _removeScrollHandler() {
    if (_scrollContainer && _scrollHandler) {
        _scrollContainer.removeEventListener('scroll', _scrollHandler);
    }
    _scrollContainer = null;
    _scrollHandler = null;
}

export function disconnectObservers() {
    if (_initRetryRaf) { cancelAnimationFrame(_initRetryRaf); _initRetryRaf = 0; }
    _initRetries = 0;
    if (_postScrollObserver) { _postScrollObserver.disconnect(); _postScrollObserver = null; }
    if (_postMutObserver) { _postMutObserver.disconnect(); _postMutObserver = null; }
    _removeScrollHandler();
    if (_scrollRaf) cancelAnimationFrame(_scrollRaf);
    if (_pickRaf) cancelAnimationFrame(_pickRaf);
    if (_suppressedRepickTimer) clearTimeout(_suppressedRepickTimer);
    _scrollRaf = 0; _pickRaf = 0; _suppressedRepickTimer = 0; _suppressedRepickDueAt = 0;
    _candidates.clear();
    _lastCatchUpAt = 0;   // allow immediate first-pick catch-up after rebuild
}

// #chat is unconditionally the scroller in ST (public/style.css), so it is used
// directly in initPostScrollObserver(). Do NOT reintroduce an ancestor-walk
// heuristic (looking for overflow:auto|scroll, falling back to `window`): on
// mobile (ST via Termux) it can return `window` when #chat is briefly
// zero-height during the panel reveal — the scroll listener then attaches to a
// node that never scrolls the chat.

// ── Event binding ──

function observeAsyncCallback(result, label) {
    if (!result || typeof result.then !== 'function') return;
    Promise.resolve(result).catch(cause => {
        warn(`${label} callback error:`, cause);
        let chat = 'none';
        try { chat = getCtx()?.chatId || 'start'; } catch { /* diagnostic only */ }
        recordEvent('error', `event=callback_error callback=${label} chat=${chat} error=${cause?.message || cause}`);
    });
}

function panelCanObserve() {
    const canObserve = !!state.settings.enabled && !state.settings.collapsed && isPanelVisible();
    if (!canObserve) {
        pushRestoreLog('observer', `panelCanObserve=false enabled=${!!state.settings.enabled} collapsed=${!!state.settings.collapsed} visible=${!!isPanelVisible()}`);
    }
    return canObserve;
}

function scheduleObserverRestart(timerKey, delay) {
    const timer = timerKey === 'chat' ? '_chatChangedRestartTimer' : '_msgEditedRestartTimer';
    if (timerKey === 'chat') {
        if (_chatChangedRestartTimer) { clearTimeout(_chatChangedRestartTimer); _chatChangedRestartTimer = null; }
    } else if (_msgEditedRestartTimer) {
        clearTimeout(_msgEditedRestartTimer); _msgEditedRestartTimer = null;
    }
    if (!panelCanObserve()) return;
    if (timerKey === 'chat') {
        _chatChangedRestartTimer = setTimeout(() => {
            _chatChangedRestartTimer = null;
            if (panelCanObserve()) initPostScrollObserver();
        }, delay);
    } else {
        _msgEditedRestartTimer = setTimeout(() => {
            _msgEditedRestartTimer = null;
            if (panelCanObserve()) initPostScrollObserver();
        }, delay);
    }
}


function buildEventHandlers(generateFeed, ctx, dependencies = {}) {
    const handlers = [];
    const { getGenerationFingerprint, onChatChanged } = dependencies;

    // ── CHAT_CHANGED: abort in-flight gen, invalidate epoch, restore cache ──
    handlers.push([ctx.eventTypes.CHAT_CHANGED, async () => {
        const ctx2 = getCtx();
        const chatId = ctx2.chatId;
        recordEvent('log', `event=chat_change chat=${chatId || 'start'} from=${state.currentChatId || 'none'} epoch=${state.generationEpoch + 1} noSave=${!!state.settings.noSaveMode}`);
        // Bump the epoch so any in-flight generation discards its result instead
        // of writing it into the new chat. Abort is best-effort (frees the CM
        // slot); the epoch guard is the source of truth.
        bumpGenerationEpoch();
        if (state.abortController) {
            try { state.abortController.abort(); } catch { /* already aborted */ }
            state.abortController = null;
        }
        state.generationInProgress = false;
        state.generationOwner = null;
        state.generationTarget = null;
        state.generationObservedTarget = null;
        // A pending WI stash from the previous chat must never be claimed by
        // a message in the new chat (chatId check would reject it anyway — this
        // drop makes the lifecycle explicit and frees the memory).
        state.pendingActivatedWorldInfo = null;
        if (chatId !== state.currentChatId) {
            state.currentChatId = chatId;
            state.currentPostId = null;
            state.currentSwipeIdx = 0;
            if (!chatId) {
                setFeedText('');
                updatePostIndicator();
            } else if (state.settings.noSaveMode) {
                showCurrentFeed();
            } else {
                // Lore refresh does not depend on the feed mirror — fire it
                // before the store load so external observers keep old timing.
                observeAsyncCallback(onChatChanged?.(ctx2), 'onChatChanged');
                // Load this chat's server file (GET once per chat switch) before
                // any restore reads: GC of dead slots + lazy v1 migration run here.
                await loadFeedStore();
                const target = resolvePreferredCommentaryTarget();
                if (target) {
                    const restored = await selectCommentaryTarget(target.msgId, target.swipeIdx, { source: 'chat restore' });
                    recordEvent('log', `event=restore chat=${chatId} target=#${target.msgId}[${target.swipeIdx}] source=chat-restore status=${restored.status}`);
                } else {
                    setFeedText('');
                    updatePostIndicator();
                    recordEvent('log', `event=restore chat=${chatId} source=chat-restore status=no-target`);
                }
                return;
            }
            observeAsyncCallback(onChatChanged?.(ctx2), 'onChatChanged');
        }
        scheduleObserverRestart('chat', 600);
    }]);

    // ── CHARACTER_MESSAGE_RENDERED: THE single trigger for generation ──
    handlers.push([ctx.eventTypes.CHARACTER_MESSAGE_RENDERED, async (messageId) => {
        if (!state.settings.enabled || !state.settings.autoUpdate) return;
        const ctx2 = getCtx();
        const msg = ctx2.chat?.[parseInt(messageId)];
        if (!msg || msg.is_user || msg.is_system || msg.is_hidden) return;
        const msgIdStr = String(messageId);
        const swipeIdx = typeof msg.swipe_id === 'number' ? msg.swipe_id : 0;
        const msgText = (msg.mes || '').trim();
        if (!msgText || msgText === '...' || msgText.length < 5) return;

        // Claim the pending WORLD_INFO_ACTIVATED payload and bind it to the
        // message that actually rendered. Runs BEFORE the cache-hit return (and
        // before any await) so the binding lands even when generation is skipped
        // by a cache hit — the pending describes THIS message's prompt, not the
        // next one's. TTL 120 s guards against "generation aborted → a much
        // later message hijacks the stash"; a foreign chatId (race during chat
        // switch) also forfeits it. The pending is always consumed regardless:
        // one ST generation → exactly one claim.
        if (state.pendingActivatedWorldInfo
            && state.pendingActivatedWorldInfo.chatId === ctx2.chatId
            && Date.now() - state.pendingActivatedWorldInfo.ts <= 120_000) {
            state.lastActivatedWorldInfo = {
                ...state.pendingActivatedWorldInfo,
                msgId: msgIdStr,
                swipeIdx,
            };
        }
        state.pendingActivatedWorldInfo = null;

        const chatIdSnapshot = ctx2.chatId;
        const epochSnapshot = state.generationEpoch;
        let generationFp;
        let fingerprintResolved = Boolean(getGenerationFingerprint);
        if (!state.settings.noSaveMode && getGenerationFingerprint) {
            try {
                generationFp = await getGenerationFingerprint(ctx2);
            } catch (cause) {
                fingerprintResolved = false;
                warn('getGenerationFingerprint callback error:', cause);
                recordEvent('error', `event=fingerprint callback=getGenerationFingerprint chat=${ctx2.chatId || 'none'} error=${cause?.message || cause}`);
            }

            const currentCtx = getCtx();
            if (currentCtx.chatId !== chatIdSnapshot || state.generationEpoch !== epochSnapshot) return;
        }

        // A failed fingerprint lookup is a hard miss. Never pass undefined from a
        // rejection into the legacy cache path, where it would accept stale HTML.
        if (!state.settings.noSaveMode
            && fingerprintResolved
            && getCachedPost(msgIdStr, swipeIdx, generationFp)) return;

        trace(`CHARACTER_MESSAGE_RENDERED #${msgIdStr}[${swipeIdx}]: generating (noSaveMode=${!!state.settings.noSaveMode})`);
        observeAsyncCallback(generateFeed(msgIdStr, swipeIdx, false), 'generateFeed');
    }]);

    // ── MESSAGE_SWIPED: restore cache for existing swipes ──
    handlers.push([ctx.eventTypes.MESSAGE_SWIPED, async (msgId) => {
        if (!state.settings.enabled) return;
        try {
            const chat = getCtx().chat;
            const msg = chat?.[msgId];
            if (!msg || msg.is_user || msg.is_system || msg.is_hidden) return;
            state.navLockUntil = Date.now() + 500;
            const swipeIdx = typeof msg.swipe_id === 'number' ? msg.swipe_id : 0;
            noteGenerationNavigation(String(msgId), swipeIdx, 'swipe');

            // noSaveMode: position only (pinned feed untouched); saveMode: restore.
            if (state.settings.noSaveMode) {
                setCurrentPost(String(msgId), swipeIdx);
                return;
            }
            const result = await selectCommentaryTarget(String(msgId), swipeIdx, { source: 'swipe' });
            if (result.status === 'superseded') return;
            updatePostIndicator();
            } catch (e) {
                warn('MESSAGE_SWIPED handler error:', e);
                recordEvent('error', `event=handler callback=MESSAGE_SWIPED chat=${getCtx()?.chatId || 'none'} error=${e?.message || e}`);
            }
    }]);

    // ── MESSAGE_DELETED: GC + pointer fallback ──
    if (ctx.eventTypes.MESSAGE_DELETED) {
        handlers.push([ctx.eventTypes.MESSAGE_DELETED, async () => {
            // noSaveMode: pinned feed is not keyed by post — nothing to GC.
            if (state.settings.noSaveMode) {
                updatePostIndicator();
                return;
            }
            try {
                // Entries are keyed by send_date: survivors keep their keys, the
                // deleted message's entries simply stop matching any live slot.
                if (pruneOrphanedEntries() > 0) {
                    trace('MESSAGE_DELETED: pruned orphaned feed entries');
                }
                // If the currently shown post died, fall back to the latest AI
                // post so the panel doesn't keep commentary for a deleted post.
                const ctx2 = getCtx();
                const chat = ctx2.chat || [];
                const cur = state.currentPostId;
                const curIdx = parseInt(cur);
                const curGone = cur === null
                    || !Number.isInteger(curIdx)
                    || curIdx >= chat.length
                    || !chat[curIdx]
                    || chat[curIdx].is_user
                    || chat[curIdx].is_system;
                if (curGone) {
                    const last = resolveLastAIPost();
                    state.currentPostId = last?.msgId ?? null;
                    state.currentSwipeIdx = last?.swipeIdx ?? 0;
                    if (last) {
                        await selectCommentaryTarget(last.msgId, last.swipeIdx, { source: 'delete fallback' });
                    } else {
                        setFeedText('');
                    }
                } else {
                    // The pointer survived, but an earlier deletion may have
                    // shifted it onto a DIFFERENT message — re-select so the
                    // panel shows that message's own state instead of the dead
                    // post's feed until the next scroll/swipe.
                    await selectCommentaryTarget(cur, state.currentSwipeIdx, { source: 'delete refresh' });
                }
                updatePostIndicator();
            } catch (e) {
                warn('MESSAGE_DELETED handler error:', e);
                recordEvent('error', `event=handler callback=MESSAGE_DELETED chat=${getCtx()?.chatId || 'none'} error=${e?.message || e}`);
            }
        }]);
    }

    // ── MESSAGE_SWIPE_DELETED: GC the dead swipe's entry ──
    // ST emits {messageId, swipeId, newSwipeId} AFTER splicing swipes/swipe_info
    // (deleteSwipe tail), so the dead slot is already unaddressable — but its
    // send_date key is now orphaned by construction. One cheap GC pass drops it;
    // survivors keep their keys (they never depended on indexes).
    if (ctx.eventTypes.MESSAGE_SWIPE_DELETED) {
        handlers.push([ctx.eventTypes.MESSAGE_SWIPE_DELETED, async ({ messageId } = {}) => {
            if (!state.settings.enabled || state.settings.noSaveMode) return;
            try {
                if (pruneOrphanedEntries() > 0) {
                    trace(`MESSAGE_SWIPE_DELETED: pruned dead swipe entries for #${messageId}`);
                    recordEvent('log', `MESSAGE_SWIPE_DELETED: pruned entries for #${messageId}`);
                }
                // deleteSwipe animates to the surviving swipe right after when the
                // current one died — MESSAGE_SWIPED restores its feed; done here.
            } catch (e) {
                warn('MESSAGE_SWIPE_DELETED handler error:', e);
                recordEvent('error', `event=handler callback=MESSAGE_SWIPE_DELETED chat=${getCtx()?.chatId || 'none'} error=${e?.message || e}`);
            }
        }]);
    }

    // ── MESSAGE_EDITED: refresh if it's the current one ──
    const msgEditedEvent = ctx.eventTypes.MESSAGE_EDITED || ctx.eventTypes.MESSAGE_UPDATED;
    if (msgEditedEvent) {
        handlers.push([msgEditedEvent, async (msgId) => {
            // noSaveMode: pinned feed is not tied to post text — skip restore.
            if (state.settings.noSaveMode) return;
            try {
                const ctx2 = getCtx();
                const msg = ctx2.chat?.[parseInt(msgId)];
                if (!msg || msg.is_user || msg.is_system) return;
                const msgIdStr = String(msgId);
                const swipeIdx = getMessageSwipeIdx(msgIdStr);
                if (msgIdStr === String(state.currentPostId)) {
                    await selectCommentaryTarget(msgIdStr, swipeIdx, { source: 'edit' });
                }
                scheduleObserverRestart('message', 300);
            } catch (e) {
                warn('MESSAGE_EDITED handler error:', e);
                recordEvent('error', `event=handler callback=MESSAGE_EDITED chat=${getCtx()?.chatId || 'none'} error=${e?.message || e}`);
            }
        }]);
    }

    // ── CHAT_RENAMED: keep fork identity aligned with the new chat filename ──
    if (ctx.eventTypes.CHAT_RENAMED) {
        handlers.push([ctx.eventTypes.CHAT_RENAMED, (detail) => {
            try {
                noteChatRenamed(detail || {});
            } catch (e) {
                warn('CHAT_RENAMED handler error:', e);
                recordEvent('error', `event=handler callback=CHAT_RENAMED chat=${getCtx()?.chatId || 'none'} error=${e?.message || e}`);
            }
        }]);
    }

    // ── WORLD_INFO_ACTIVATED: stash activated ST entries for Auto-lore mode ──
    // ST emits this at the end of getWorldInfoPrompt
    // with the final array of all activated entries — including vectorized
    // entries placed by Vector Storage into WorldInfoBuffer.externalActivations
    // before the scan.
    //
    // The event fires during ST's prompt build, BEFORE the new message is
    // pushed to chat (for swipes the scanned message is popped entirely), so
    // binding to "the last AI post at event time" would point at the PREVIOUS
    // post. The handler therefore only stashes a PENDING payload;
    // CHARACTER_MESSAGE_RENDERED claims it and binds it to the message that
    // actually rendered (see the isDryRun contract in lorebooks.js).
    if (ctx.eventTypes.WORLD_INFO_ACTIVATED) {
        handlers.push([ctx.eventTypes.WORLD_INFO_ACTIVATED, async (entries) => {
            if (!Array.isArray(entries)) return;
            const ctx2 = getCtx();
            state.pendingActivatedWorldInfo = {
                chatId: ctx2.chatId,
                entries: entries.map(e => ({
                    uid: e.uid,
                    content: typeof e.content === 'string' ? e.content : '',
                    world: e.world,
                    comment: e.comment ?? e.name ?? '',
                    // Preserved for diagnostics: lets the debug dump report how many
                    // activated entries were vectorized (Vector Storage) vs keyword.
                    vectorized: Boolean(e.vectorized),
                })),
                ts: Date.now(),
            };
            recordEvent('log', `event=world_info_activated chat=${ctx2.chatId || 'none'} entries=${entries.length}`);
        }]);
    }

    // ── CONNECTION_PROFILE_UPDATED: invalidate the fingerprint cache ──
    // Changing the model/API INSIDE the selected Connection Manager profile
    // keeps settings.profileId unchanged, so the fingerprint cache key
    // (generator.js _fpSettingsKey) misses the change and serves a stale fp —
    // a valid saved feed then looks hard-missed (empty CTA). Any update to the
    // selected profile (old or new side) bumps the epoch, which invalidates
    // the fp cache; profileApi/profileModel already flow into the fingerprint
    // input (lorebooks.js). _fpSettingsKey is deliberately NOT extended with
    // profile details: those are async to fetch, the key must stay synchronous.
    if (ctx.eventTypes.CONNECTION_PROFILE_UPDATED) {
        handlers.push([ctx.eventTypes.CONNECTION_PROFILE_UPDATED, (oldProfile, newProfile) => {
            // settings store `id || name` (settings-sync.js), so match both.
            const ids = new Set([
                oldProfile?.id, oldProfile?.name,
                newProfile?.id, newProfile?.name,
            ].filter(Boolean));
            if (ids.has(state.settings.profileId)) {
                bumpGenerationEpoch();
                trace('CONNECTION_PROFILE_UPDATED: selected profile changed — generation epoch bumped (fingerprint cache invalidated)');
                recordEvent('log', `event=profile_update profile=${state.settings.profileId} result=epoch-bumped`);
            }
        }]);
    }

    return handlers;
}

export function isEventsBound() {
    return _eventsBound;
}

/**
 * Bind all ST event listeners.
 * @param {(msgId, swipe, force) => Promise<void>} generateFeed
 * @param {object} [ctxOverride] - deterministic context for tests.
 * @param {{ getGenerationFingerprint?: (ctx: object) => string|Promise<string>, onChatChanged?: (ctx: object) => unknown }} [dependencies]
 */
export function bindEvents(generateFeed, ctxOverride, dependencies = {}) {
    if (_eventsBound) return true;
    const ctx = ctxOverride || getCtx();
    if (!ctx?.eventSource) return false;

    const pending = buildEventHandlers(generateFeed, ctx, dependencies);
    const attached = [];
    try {
        for (const [eventName, handler] of pending) {
            ctx.eventSource.on(eventName, handler);
            attached.push([eventName, handler]);
        }
        _eventHandlers = pending;
        _boundEventSource = ctx.eventSource;
        _eventsBound = true;
        trace('Events bound.');
        return true;
    } catch (cause) {
        for (const [eventName, handler] of attached) {
            ctx.eventSource.removeListener(eventName, handler);
        }
        _eventHandlers = [];
        _boundEventSource = null;
        _eventsBound = false;
        throw cause;
    }
}

export function unbindEvents() {
    if (!_eventsBound || !_boundEventSource) return false;
    for (const [eventName, handler] of _eventHandlers) {
        _boundEventSource.removeListener(eventName, handler);
    }
    _eventHandlers = [];
    _boundEventSource = null;
    _eventsBound = false;
    if (_chatChangedRestartTimer) { clearTimeout(_chatChangedRestartTimer); _chatChangedRestartTimer = null; }
    if (_msgEditedRestartTimer) { clearTimeout(_msgEditedRestartTimer); _msgEditedRestartTimer = null; }
    return true;
}
