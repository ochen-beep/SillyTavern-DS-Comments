// @ts-check
/**
 * DS Comments — Cache module
 * Save-mode feed access over the server-file store (src/feed-file-store.js):
 * all reads/writes go to the in-memory mirror loaded per chat; persistence is
 * the store's own concern (serialized file uploads).
 * DOM ids here MUST match ui/window.js (#dscFeed) and ui/chrome.js (#dscIndicator).
 */

import { state, getCtx, warn, trace, tr, START_SCREEN_KEY, isCommentaryDisplayEligible, resolveLastAIPost, getMessageSwipeIdx, pushRestoreLog, getLastFpDiag, feedShowsRealCommentary, recordWipe } from './core.js';
import { getFeedSlot, setFeedSlot, clearFeedFile, loadFeedStore } from './feed-file-store.js';
import { schedulePinnedPersist, clearPinnedPersist } from './pinned-store.js';
import { recordEvent } from './event-log.js';

function logRestoreOutcome(target, source, status, details = '') {
    recordEvent('log', `event=restore target=#${target.msgId}[${target.swipeIdx}] source=${source} status=${status}${details ? ` ${details}` : ''}`);
}
import { showFeedHtml } from './ui/feed-controller.js';

let _getGenerationFingerprint = null;
let _restoreSequence = 0;
let _showSequence = 0;

/** Register the async generation-context fingerprint used by visible restores. */
export function initCacheRestore({ getGenerationFingerprint } = {}) {
    _getGenerationFingerprint = typeof getGenerationFingerprint === 'function'
        ? getGenerationFingerprint
        : null;
    _restoreSequence++;
}

/** Load the per-chat server file into the mirror (CHAT_CHANGED). */
export { loadFeedStore };

// ── Message fingerprint (soft signal only) ──
// entry.fp is a cheap hash of post/swipe text, saved at write time. It only
// logs a console heads-up when the current message text no longer matches (post
// edited / swipe regen'd). It NEVER hides a cached feed — the user regenerates
// explicitly. Legacy entries without `fp` are fine.

export function getCachedPost(msgId, swipeIdx, generationFp) {
    if (msgId === null || msgId === undefined) return null;
    const entry = getFeedSlot(msgId, swipeIdx);
    if (!entry?.html) return null;

    if (generationFp !== undefined && entry.generationFp !== generationFp) {
        trace(`getCachedPost: context mismatch #${msgId}[${swipeIdx}]`);
        return null;
    }
    return entry.html;
}

/**
 * Read a save-mode entry only after resolving the current generation context.
 * A missing provider is a hard miss so callers cannot fall back to legacy reads.
 */
export async function getCachedPostForCurrentGeneration(msgId, swipeIdx) {
    if (!_getGenerationFingerprint) return null;
    try {
        const generationFp = await _getGenerationFingerprint(getCtx());
        return getCachedPost(msgId, swipeIdx, generationFp);
    } catch (e) {
        warn('getCachedPostForCurrentGeneration error:', e);
        return null;
    }
}

export function saveGeneratedCommentary(html, msgId, swipeIdx, generationFp) {
    try {
        const ctx = getCtx();
        if (!ctx.chatMetadata || !ctx.chatId) {
            warn('saveGeneratedCommentary: chatMetadata or chatId unavailable — save skipped');
            return;
        }
        const mid  = String(msgId       !== undefined ? msgId       : state.currentPostId  ?? 'legacy');
        const sidx = parseInt(swipeIdx !== undefined ? swipeIdx : state.currentSwipeIdx ?? 0);

        if (!setFeedSlot(mid, sidx, html, generationFp ?? null)) {
            warn(`saveGeneratedCommentary: slot #${mid}[${sidx}] unusable — save skipped`);
            return;
        }
        trace(`saveGeneratedCommentary: saved #${mid}[${sidx}] (${html.length} chars)`);
        recordEvent('log', `saveGeneratedCommentary: saved #${mid}[${sidx}] (${html.length} chars)`);
    } catch (e) {
        warn('saveGeneratedCommentary error:', e);
    }
}

export async function selectCommentaryTarget(msgId, swipeIdx, options = {}) {
    const transitionId = ++_restoreSequence;
    const ctxSnapshot = getCtx();
    const chatIdSnapshot = ctxSnapshot?.chatId;
    const epochSnapshot = state.generationEpoch;
    const mid = String(msgId);
    const parsedSwipeIdx = Number(swipeIdx ?? 0);
    const sidx = Number.isInteger(parsedSwipeIdx) && parsedSwipeIdx >= 0 ? parsedSwipeIdx : 0;
    const result = (status) => ({ status, msgId: mid, swipeIdx: sidx });
    const source = options.source || 'unknown';
    const isCurrent = () => {
        const currentCtx = getCtx();
        return transitionId === _restoreSequence
            && currentCtx?.chatId === chatIdSnapshot
            && state.generationEpoch === epochSnapshot;
    };

    // Direct callers may race with chat/swipe changes. Invalid identities are
    // hard misses, but must not replace the currently visible valid target.
    const messageIdx = Number(mid);
    const message = Number.isInteger(messageIdx) ? ctxSnapshot?.chat?.[messageIdx] : null;
    const eligible = isCommentaryDisplayEligible(message)
        && (Array.isArray(message.swipes) ? message.swipes[sidx] !== undefined : sidx === 0);
    if (!eligible) {
        const reason = explainReject({ msgId: mid, swipeIdx: sidx }, ctxSnapshot);
        pushRestoreLog('select', `#${mid}[${sidx}] НЕ eligible->missing (source=${source}) ${reason}`);
        logRestoreOutcome({ msgId: mid, swipeIdx: sidx }, source, 'invalid-target', `reason=${reason}`);
        return result('missing');
    }

    // Resolve and render the cache entry before the asynchronous fingerprint
    // lookup. Rendering only after the await leaves the previous post visible
    // for a frame when the panel reopens after a chat scroll or swipe.
    const initialEntry = getFeedSlot(mid, sidx);
    const wipedReal = !initialEntry?.html && feedShowsRealCommentary();
    setCurrentPost(mid, sidx);
    if (initialEntry?.html) {
        showFeedHtml(initialEntry.html);
    } else {
        showFeedHtml('');
    }

    try {
        let generationFp;
        let fingerprintResolved = false;
        try {
            if (_getGenerationFingerprint) {
                generationFp = await _getGenerationFingerprint(ctxSnapshot);
                fingerprintResolved = true;
            }
        } catch (e) {
            warn('selectCommentaryTarget fingerprint error:', e);
        }

        if (!isCurrent()) {
            pushRestoreLog('select', `#${mid}[${sidx}] superseded (source=${source})`);
            logRestoreOutcome({ msgId: mid, swipeIdx: sidx }, source, 'superseded');
            return result('superseded');
        }

        // Read the entry again after the asynchronous boundary so a newly
        // generated feed is not overwritten by the pre-await snapshot.
        const entry = getFeedSlot(mid, sidx);
        const fpShort = (s) => s ? String(s).slice(0, 16) : '(none)';

        // No cached feed for this post → empty window with the "Generate" CTA.
        if (!entry?.html) {
            pushRestoreLog('select', `#${mid}[${sidx}] MISSING->пусто (source=${source}) priorContent=${wipedReal} записи в кэше нет`);
            logRestoreOutcome({ msgId: mid, swipeIdx: sidx }, source, 'missing', `priorContent=${wipedReal}`);
            if (wipedReal) recordWipe(`MISSING #${mid}[${sidx}] source=${source} записи нет, но до этого показывались комментарии`);
            return result('missing');
        }

        // A cache entry can appear while awaiting the fingerprint. Show the
        // current entry, but avoid rebuilding the feed when it is unchanged.
        showFeedHtml(entry.html);

        const fpMatches = fingerprintResolved && entry.generationFp === generationFp;
        // == null (not ===) so legacy entries saved before generationFp existed
        // (field absent → undefined) are treated as a clean hit, not soft-stale.
        const status = (entry.generationFp == null || fpMatches) ? 'hit' : 'soft-stale';
        if (status === 'hit') {
            pushRestoreLog('select', `#${mid}[${sidx}] HIT (source=${source}) fp=${fpShort(generationFp)}`);
            logRestoreOutcome({ msgId: mid, swipeIdx: sidx }, source, 'hit', `fpResolved=${fingerprintResolved}`);
        } else {
            // Soft mismatch: show the cache but surface why it drifted, so the
            // user can regenerate explicitly if they want a context-matched feed.
            pushRestoreLog('select', `#${mid}[${sidx}] SOFT-STALE показан кэш (source=${source}) entryFp=${fpShort(entry.generationFp)} nowFp=${fpShort(generationFp)} fpResolved=${fingerprintResolved} | ${getLastFpDiag()}`);
            logRestoreOutcome({ msgId: mid, swipeIdx: sidx }, source, 'soft-stale', `fpResolved=${fingerprintResolved}`);
        }
        return result(status);
    } catch (e) {
        warn('selectCommentaryTarget error:', e);
        if (!isCurrent()) return result('superseded');
        setCurrentPost(mid, sidx);
        showFeedHtml('');
        pushRestoreLog('select', `#${mid}[${sidx}] ERROR->missing (source=${source}) ${e?.message || e}`);
        recordEvent('error', `event=restore target=#${mid}[${sidx}] source=${source} status=error error=${e?.message || e}`);
        return result('missing');
    }
}

function normalizeEligibleCurrentTarget(target, ctx) {
    if (!target || target.msgId === null || target.msgId === undefined) return null;
    const mid = String(target.msgId);
    const messageIdx = Number(mid);
    const parsedSwipeIdx = Number(target.swipeIdx ?? 0);
    if (!Number.isInteger(messageIdx) || !Number.isInteger(parsedSwipeIdx) || parsedSwipeIdx < 0) return null;
    const message = ctx.chat?.[messageIdx];
    if (!isCommentaryDisplayEligible(message)
        || getMessageSwipeIdx(mid) !== parsedSwipeIdx
        || (Array.isArray(message.swipes) ? message.swipes[parsedSwipeIdx] === undefined : parsedSwipeIdx !== 0)) return null;
    return { msgId: mid, swipeIdx: parsedSwipeIdx };
}

/** Explain (diagnostic log only) WHY normalizeEligibleCurrentTarget would reject a target. */
function explainReject(target, ctx) {
    if (!target || target.msgId === null || target.msgId === undefined) return 'msgId=null';
    const mid = String(target.msgId);
    const messageIdx = Number(mid);
    const parsedSwipeIdx = Number(target.swipeIdx ?? 0);
    if (!Number.isInteger(messageIdx) || !Number.isInteger(parsedSwipeIdx) || parsedSwipeIdx < 0)
        return `bad idx #${mid}[${parsedSwipeIdx}]`;
    const message = ctx.chat?.[messageIdx];
    if (!message) return `нет сообщения #${mid}`;
    if (!isCommentaryDisplayEligible(message)) return `не eligible #${mid}`;
    const actualSwipe = getMessageSwipeIdx(mid);
    if (actualSwipe !== parsedSwipeIdx) return `swipe рассинхрон: target=${parsedSwipeIdx} ≠ swipe_id=${actualSwipe}`;
    if (Array.isArray(message.swipes) ? message.swipes[parsedSwipeIdx] === undefined : parsedSwipeIdx !== 0)
        return `нет свайпа ${parsedSwipeIdx} у #${mid}`;
    return 'неизвестно';
}

function resolveBestVisibleChatTarget(ctx = getCtx()) {
    // Self-contained full-chat scan, not reused from events.js IO candidates: runs
    // once on restore/reopen, needs the globally-best visible post, and IO tracks
    // only near-viewport nodes. Coupling the modules would trade a one-time cost
    // for fragile cross-module state.
    try {
        const chatEl = document.getElementById('chat');
        if (!chatEl) return null;
        const nodes = Array.from(chatEl.querySelectorAll('[mesid]'));
        if (!nodes.length) return null;

        let best = null;
        let bestRatio = 0;
        const viewportHeight = window.innerHeight || chatEl.clientHeight || 0;
        for (const el of nodes) {
            const msgId = el.getAttribute('mesid');
            if (typeof msgId !== 'string' || !/^\d+$/.test(msgId)) continue;
            const messageIdx = Number(msgId);
            const message = ctx.chat?.[messageIdx];
            if (!isCommentaryDisplayEligible(message)) continue;
            const rect = el.getBoundingClientRect();
            if (rect.height <= 0) continue;
            const visible = Math.max(0, Math.min(rect.bottom, viewportHeight) - Math.max(rect.top, 0));
            if (visible <= 0) continue;
            const ratio = visible / rect.height;
            if (ratio > bestRatio) {
                bestRatio = ratio;
                best = {
                    msgId: String(messageIdx),
                    swipeIdx: typeof message?.swipe_id === 'number' ? message.swipe_id : 0,
                };
            }
        }
        return best;
    } catch {
        return null;
    }
}

/**
 * Resolve the save-mode target: prefer the post SillyTavern actually has on
 * screen right now, falling back to the in-memory pointer only if ST's chat
 * context isn't usable yet.
 *
 * Reopen no-flash rule: on panel open we must prefer the BEST
 * VISIBLE mesid from the DOM if available. Using resolveLastAIPost() first
 * causes a visible flash where the latest AI post renders briefly before the
 * observer corrects to the actually visible chat post.
 *
 * Priority: best visible DOM post, then module state (current chat only),
 * then resolveLastAIPost() as the final fallback when no visibility evidence
 * is available yet.
 */
export function resolvePreferredCommentaryTarget() {
    const ctx = getCtx();
    const rejects = [];

    const visible = resolveBestVisibleChatTarget(ctx);
    const visibleN = normalizeEligibleCurrentTarget(visible, ctx);
    if (visibleN) {
        pushRestoreLog('resolve', `visible принят: #${visibleN.msgId}[${visibleN.swipeIdx}]`);
        return visibleN;
    }
    rejects.push(visible
        ? `visible(#${visible.msgId}[${visible.swipeIdx}])=${explainReject(visible, ctx)}`
        : 'visible отсутствует');

    if (state.currentChatId === ctx.chatId) {
        const stateTarget = { msgId: state.currentPostId, swipeIdx: state.currentSwipeIdx };
        const selected = normalizeEligibleCurrentTarget(stateTarget, ctx);
        if (selected) {
            pushRestoreLog('resolve', `state принят (fallback): #${selected.msgId}[${selected.swipeIdx}] | ${rejects.join('; ')}`);
            return selected;
        }
        rejects.push(`state(#${state.currentPostId}[${state.currentSwipeIdx}])=${explainReject(stateTarget, ctx)}`);
    } else {
        rejects.push(`state: currentChatId=${state.currentChatId}≠ctx=${ctx.chatId}`);
    }

    const last = resolveLastAIPost();
    const lastN = normalizeEligibleCurrentTarget(last, ctx);
    if (lastN) {
        pushRestoreLog('resolve', `lastAIPost fallback принят: #${lastN.msgId}[${lastN.swipeIdx}] | ${rejects.join('; ')}`);
        return lastN;
    }
    rejects.push(last
        ? `lastAIPost(#${last.msgId}[${last.swipeIdx}])=${explainReject(last, ctx)}`
        : 'lastAIPost отсутствует');

    pushRestoreLog('resolve', `ТАРГЕТ НЕ НАЙДЕН | ${rejects.join('; ')}`);
    return null;
}

export async function restoreCachedCommentary(msgId, swipeIdx) {
    // Simplified sync model: keep selectCommentaryTarget() as the
    // single cache/fingerprint gate and treat both an exact cache hit and a
    // soft-stale cached restore as successful outcomes. Fingerprint drift is a
    // regeneration hint, not a reason to hide the cached feed — otherwise chat-
    // driven scroll/swipe follow becomes fragile during async context changes.
    const result = await selectCommentaryTarget(msgId, swipeIdx);
    return result.status === 'hit' || result.status === 'soft-stale';
}

/**
 * Restore the preferred save-mode target: keep a valid selection for this chat,
 * otherwise use metadata current, then fall back to the latest AI post.
 * @returns {boolean} whether a cached commentary was restored
 */
export async function restoreForCurrentChatPost() {
    try {
        const target = resolvePreferredCommentaryTarget();
        if (!target) {
            // Invalidate any pending restore before clearing the visible feed.
            _restoreSequence++;
            const ctx = getCtx();
            if (state.currentChatId === ctx.chatId) {
                state.currentPostId = null;
                state.currentSwipeIdx = 0;
                const wipedReal = feedShowsRealCommentary();
                showFeedHtml('');
                pushRestoreLog('resolve', `NO-TARGET (reopen) -> пусто; currentChatId=${state.currentChatId}`);
                recordEvent('log', `event=restore source=reopen status=no-target chat=${ctx.chatId || 'none'} priorContent=${wipedReal}`);
                if (wipedReal) {
                    recordWipe(`NO-TARGET (reopen) currentChatId=${state.currentChatId} - таргет не найден, стёрто то, что было`);
                    recordEvent('log', `event=restore_wipe source=reopen chat=${ctx.chatId || 'none'} reason=no-target`);
                }
            }
            return false;
        }
        const result = await selectCommentaryTarget(target.msgId, target.swipeIdx, { source: 'reopen' });
        return result.status === 'hit' || result.status === 'soft-stale';
    } catch (e) {
        warn('restoreForCurrentChatPost error:', e);
        recordEvent('error', `event=restore source=reopen status=error chat=${getCtx()?.chatId || 'none'} error=${e?.message || e}`);
        showFeedHtml('');
        return false;
    }
}

/**
 * Clear save-mode commentary. With msgId: the message's slots are pruned by
 * GC on the next structural pass (rare path — ST has no per-message delete
 * that keeps the chat open). Without: whole-chat wipe — empty mirror + the
 * server file is deleted; the guid scalar stays (chat identity is still valid).
 */
export function clearCachedCommentary(msgId) {
    try {
        if (msgId !== undefined && msgId !== null) {
            trace(`clearCachedCommentary: #${msgId} slots pruned via GC`);
        } else {
            clearFeedFile();
            state.currentPostId = null;
            state.currentSwipeIdx = 0;
        }
    } catch (e) { warn('clearCachedCommentary error:', e); }
}

export function setCurrentPost(msgId, swipeIdx) {
    state.currentPostId    = msgId !== null && msgId !== undefined ? String(msgId) : null;
    state.currentSwipeIdx = parseInt(swipeIdx) || 0;
    updatePostIndicator();
}

/**
 * Update the post indicator pill in the header (#dscIndicator).
 * Mode-agnostic: shows the source of the current feed (post/swipe for which the
 * feed was generated). In noSaveMode it only changes on new generation/clear,
 * not on navigation.
 */
export function updatePostIndicator() {
    const pill = document.getElementById('dscIndicator');
    if (!pill) return;

    // CSS `.dsc_indicator[hidden]` beats inline style.display, so toggle the
    // `hidden` ATTRIBUTE — setting style alone leaves it invisible forever.
    const show = (ok) => {
        pill.hidden = !ok;
        pill.style.display = '';   // leave layout to the [hidden] rule / flex
    };

    if (state.currentPostId === null && !state.settings.noSaveMode) {
        pill.textContent = '';
        show(false);
        return;
    }

    const source = getCurrentFeedSource();
    if (!source) {
        pill.textContent = '';
        show(false);
        return;
    }

    try {
        const ctx  = getCtx();
        const chat = ctx.chat;
        const idx  = parseInt(source.msgId);
        const msg  = chat?.[idx];
        const totalSwipes = msg?.swipes?.length || 1;
        const dispIdx = isNaN(idx) ? source.msgId : idx + 1;
        pill.textContent = `#${dispIdx} [${source.swipeIdx + 1}/${totalSwipes}]`;
        show(true);

        if (state.settings.noSaveMode) {
            // noSaveMode: feed source, not "pinned"
            pill.title = tr('Feed source (not tied to the current post)', 'dscomments.indicator.nosave');
            pill.classList.remove('dsc_pinned');
        } else {
            const hasCached = !!getFeedSlot(source.msgId, source.swipeIdx)?.html;
            pill.title = hasCached ? tr('Pinned', 'dscomments.indicator.pinned') : '';
            pill.classList.toggle('dsc_pinned', hasCached);
        }
    } catch {
        pill.textContent = `#${source.msgId}`;
        show(true);
    }
}

// ── MODE-AGNOSTIC FEED ADAPTER ──
// noSaveMode reads/writes state.pinnedFeeds; saveMode reads/writes chatMetadata.
// External code does NOT know where the feed physically lives.

/** Resolve the Map key for noSave storage. Falls back to START_SCREEN_KEY. */
function noSaveKey(ctx) {
    return (ctx && ctx.chatId) ? ctx.chatId : START_SCREEN_KEY;
}

/**
 * Current feed for the active chat (mode-agnostic).
 * Save-mode lookup validates the async generation context before reading cache.
 * @returns {Promise<{html:string, msgId:string, swipeIdx:number, ts?:number}|null>}
 */
export async function getCurrentFeed() {
    const ctx = getCtx();
    if (state.settings.noSaveMode) {
        return state.pinnedFeeds.get(noSaveKey(ctx)) ?? null;
    }
    if (!ctx.chatId) return null;   // save mode: chatMetadata is bound to a real chat
    if (!_getGenerationFingerprint) return null;
    const generationFp = await _getGenerationFingerprint(ctx);
    const html = getCachedPost(state.currentPostId, state.currentSwipeIdx, generationFp);
    return html
        ? { html, msgId: String(state.currentPostId), swipeIdx: state.currentSwipeIdx }
        : null;
}

/**
 * Store a freshly generated feed (mode-agnostic).
 * In noSaveMode it replaces the old feed in the Map (invariant: one per chat).
 * In saveMode it calls saveGeneratedCommentary + saveMetadata.
 * @sideEffect updates the post indicator to reflect the new source.
 */
export function storeFeed(html, msgId, swipeIdx, generationFp) {
    if (state.settings.noSaveMode) {
        const ctx = getCtx();
        const chatId = noSaveKey(ctx);
        state.pinnedFeeds.set(chatId, {
            html,
            msgId: String(msgId),
            swipeIdx: parseInt(swipeIdx) || 0,
            ts: Date.now(),
        });
        const where = ctx?.chatId ? `for chat ${chatId}` : `for start screen (no active chat)`;
        trace(`storeFeed: pinned #${msgId}[${swipeIdx}] ${where} (${html.length} chars)`);
        recordEvent('log', `storeFeed: pinned #${msgId}[${swipeIdx}] ${where} (${html.length} chars)`);
        schedulePinnedPersist(state.pinnedFeeds);
    } else {
        saveGeneratedCommentary(html, msgId, swipeIdx, generationFp);
    }
    updatePostIndicator();
}

/**
 * Clear the feed for the current chat (mode-agnostic).
 * @sideEffect hides the post indicator (no source).
 */
export function clearFeed() {
    if (state.settings.noSaveMode) {
        const chatId = noSaveKey(getCtx());
        state.pinnedFeeds.delete(chatId);
        trace(`clearFeed: cleared pinned feed for ${chatId}`);
        recordEvent('log', `clearFeed: cleared ${chatId}`);
        schedulePinnedPersist(state.pinnedFeeds);
    } else {
        clearCachedCommentary();   // no msgId → entire chat cache
    }
    updatePostIndicator();
}

/**
 * Clear ALL feeds: both pinned Map and metadata (for onClean).
 * Async: awaits the pinned-record removal so the caller (onClean) knows
 * the IndexedDB key is really gone before proceeding to wipe the rest.
 */
export async function clearAllFeeds() {
    state.pinnedFeeds.clear();
    clearCachedCommentary();
    await clearPinnedPersist();
    trace('clearAllFeeds: cleared all pinned feeds + metadata cache');
}

/**
 * Source of the current feed: which post/swipe it was generated for (indicator).
 * @returns {{msgId:string, swipeIdx:number}|null}
 */
export function getCurrentFeedSource() {
    if (state.settings.noSaveMode) {
        const pinned = state.pinnedFeeds.get(noSaveKey(getCtx()));
        return pinned ? { msgId: pinned.msgId, swipeIdx: pinned.swipeIdx } : null;
    }
    return state.currentPostId !== null
        ? { msgId: String(state.currentPostId), swipeIdx: state.currentSwipeIdx }
        : null;
}

/**
 * Show the current feed or an empty-state with CTA.
 * Used by: CHAT_CHANGED (noSaveMode), generation abort (noSaveMode),
 * mode toggle (onNoSaveModeChanged).
 */
export async function showCurrentFeed() {
    const showId = ++_showSequence;
    const ctxSnapshot = getCtx();
    const chatIdSnapshot = ctxSnapshot?.chatId;
    const epochSnapshot = state.generationEpoch;
    let feed;
    if (state.settings.noSaveMode) {
        feed = await getCurrentFeed();
    } else {
        try {
            feed = await getCurrentFeed();
        } catch (e) {
            warn('showCurrentFeed fingerprint error:', e);
            feed = null;
        }
    }
    const currentCtx = getCtx();
    if (showId !== _showSequence
        || currentCtx?.chatId !== chatIdSnapshot
        || state.generationEpoch !== epochSnapshot) return false;
    if (feed) {
        showFeedHtml(feed.html);
        if (state.settings.noSaveMode) {
            const ageS = Math.max(0, Math.round((Date.now() - (Number(feed.ts) || Date.now())) / 1000));
            trace(`showCurrentFeed: noSave hit chat=${chatIdSnapshot} <- #${feed.msgId}[${feed.swipeIdx}] age=${ageS}s ${feed.html.length}chars`);
        }
    } else {
        showFeedHtml('');   // → renderEmptyStateHTML('empty') → CTA "Generate"
        if (state.settings.noSaveMode) {
            trace(`showCurrentFeed: noSave miss chat=${chatIdSnapshot} -> empty (no pinned feed for this chat)`);
        }
    }
    updatePostIndicator();
    return Boolean(feed);
}
