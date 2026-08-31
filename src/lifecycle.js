// @ts-check
/**
 * DS Comments — Lifecycle module
 * DI registry for cache↔index and quickmenu↔index cycle avoidance, plus
 * onNoSaveModeChanged. Feed DOM ownership: src/ui/feed-controller.js.
 */

import { state, saveSettings, getCtx, trace } from './core.js';
import { recordEvent } from './event-log.js';

/**
 * Dependencies lifecycle cannot import directly without closing an import cycle.
 * Registered once by index.js via initLifecycle(). All references are runtime
 * calls inside function bodies, so filling _deps before the first user
 * interaction is enough.
 * @type {{ generateFeed: Function, getCachedPostForCurrentGeneration: Function, storeFeed: Function, showCurrentFeed: Function, syncRegenVisual: Function } | null}
 */
let _deps = null;

/**
 * Serialize lifecycle initialization and invalidate suspended work on stop.
 * A start after stop queues one fresh run behind any promise still settling.
 * @param {(isCancelled: () => boolean) => Promise<void>} run
 */
export function createInitializationController(run) {
    let generation = 0;
    let active = false;
    let currentPromise = null;
    let queued = false;

    function start() {
        const wasActive = active;
        active = true;
        if (currentPromise) {
            if (!wasActive) queued = true;
            return currentPromise;
        }

        const runGeneration = ++generation;
        currentPromise = Promise.resolve().then(
            () => run(() => !active || runGeneration !== generation),
        ).finally(() => {
            currentPromise = null;
            if (queued && active) {
                queued = false;
                start();
            }
        });
        return currentPromise;
    }

    function stop() {
        active = false;
        queued = false;
        generation++;
    }

    async function whenIdle() {
        while (currentPromise) await currentPromise;
    }

    return { start, stop, whenIdle };
}

/**
 * Register dependencies. Called once from index.js.init().
 * @param {{ generateFeed: Function, getCachedPostForCurrentGeneration: Function, storeFeed: Function, showCurrentFeed: Function, syncRegenVisual: Function }} deps
 */
export function initLifecycle(deps) {
    _deps = deps;
}

/**
 * React to toggling noSaveMode (from QS menu or settings panel).
 * Seamlessly transfers a saveMode feed into the pinned Map, then shows the
 * feed mode-agnostically.
 */
export async function onNoSaveModeChanged() {
    const turningOnNoSave = state.settings.noSaveMode;   // already updated by caller
    saveSettings();
    recordEvent('log', `noSaveMode turned ${turningOnNoSave ? 'ON' : 'OFF'}`);

    if (turningOnNoSave) {
        // Transfer the current saveMode feed into the pinned Map.
        const ctx = getCtx();
        if (ctx.chatId && !state.pinnedFeeds.has(ctx.chatId)) {
            const html = await _deps?.getCachedPostForCurrentGeneration?.(state.currentPostId, state.currentSwipeIdx);
            if (html) {
                _deps?.storeFeed?.(html, state.currentPostId, state.currentSwipeIdx);
                trace(`onNoSaveModeChanged: transferred saveMode feed #${state.currentPostId}[${state.currentSwipeIdx}] → pinned`);
            }
        }
    }

    // Mode-agnostic show via the feed controller.
    _deps?.showCurrentFeed?.();

    // Refresh the regenerate button (in case generation is in progress)
    _deps?.syncRegenVisual?.();
}
