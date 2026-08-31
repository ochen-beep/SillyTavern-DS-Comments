// @ts-check
/**
 * DS Comments — UI: Header chrome
 * Regenerate button, quick-settings trigger, post indicator,
 * status overlay (generation/error/cancel). Exports setStatus() consumed by generator.js.
 */

import { state, tr, escapeHtml } from '../core.js';
import { updatePostIndicator } from '../cache.js';
import { showFeedHtml as setFeedText } from './feed-controller.js';
import { iconHtml } from './icons.js';

// ── Status overlay (exported — used by generator.js) ──

/**
 * Show/hide the status overlay pill.
 * Message and action label are escaped: the overlay is innerHTML-built, and
 * the contract must hold mechanically even if a future caller passes server
 * error text instead of a constant.
 * @param {string} message  Empty string = hide.
 * @param {{isAction?: boolean, actionLabel?: string, isCancel?: boolean}} [opts]
 */
export function setStatus(message, opts = {}) {
    const overlay = document.getElementById('dscStatusOverlay');
    if (!overlay) return;
    if (!message) {
        overlay.classList.remove('active');
        overlay.innerHTML = '';
        return;
    }
    const actionHtml = opts.isAction
        ? `<button class="dsc_status_action" id="dscCancelGen" type="button">${escapeHtml(opts.actionLabel || tr('Cancel', 'dscomments.action.cancel'))}</button>`
        : '';
    overlay.innerHTML = `<span class="dsc_status_msg">${escapeHtml(message)}</span>${actionHtml}`;
    overlay.classList.toggle('active', true);
    if (opts.isAction) {
        const btn = overlay.querySelector('#dscCancelGen');
        if (btn) btn.addEventListener('click', () => {
            if (state.abortController) {
                state.abortController.abort();
                state.abortController = null;
            }
            state.generationInProgress = false;
            setStatus('');
        }, { once: true });
    }
}

// ── Header button wiring ──

/**
 * Wire header button handlers. Always binds to the current panel DOM.
 * Safe to call repeatedly (e.g., after panel recreation).
 */
export function bindChromeHandlers(handlers) {
    const bar = document.getElementById('dscWindow');
    if (!bar) return;
    const { onToggleType, onRegen, onToggleQs } = handlers;

    // Remove old listeners to prevent duplicates — use a named wrapper
    if (bar._chromeHandler) bar.removeEventListener('click', bar._chromeHandler);
    bar._chromeHandler = (e) => {
        if (e.target.closest('#dscType'))  { e.preventDefault(); e.stopPropagation(); onToggleType?.(e.target.closest('#dscType')); return; }
        if (e.target.closest('#dscRegen')) { e.preventDefault(); onRegen?.(); return; }
        if (e.target.closest('#dscQs'))    { e.preventDefault(); e.stopPropagation(); onToggleQs?.(e.target.closest('#dscQs')); return; }
    };
    bar.addEventListener('click', bar._chromeHandler);

    // Insert Lucide icons into header buttons (idempotent via dataset flag)
    const typeBtn = document.getElementById('dscType');
    if (typeBtn && !typeBtn.dataset.iconSet) { typeBtn.innerHTML = iconHtml('type'); typeBtn.dataset.iconSet = '1'; }
    const qsBtn = document.getElementById('dscQs');
    if (qsBtn && !qsBtn.dataset.iconSet) { qsBtn.innerHTML = iconHtml('qs'); qsBtn.dataset.iconSet = '1'; }
    syncRegenVisual();
}

/** Update regenerate button icon: spinner during generation, regen idle. */
export function syncRegenVisual() {
    const btn = document.getElementById('dscRegen');
    if (!btn) return;
    btn.innerHTML = state.generationInProgress
        ? iconHtml('spinner', { spin: true })
        : iconHtml('regen');
    btn.dataset.iconSet = '1';
}

/**
 * Regenerate handler: abort if generating, else force regen current post.
 * @param {(msgId, swipe, force) => Promise<void>} generateFeed
 */
export function makeRegenHandler(generateFeed) {
    return function handleRegen() {
        if (state.generationInProgress) {
            if (state.abortController) { state.abortController.abort(); state.abortController = null; }
            state.generationInProgress = false;
            return;
        }
        // The generator owns target resolution. Passing a null target keeps the
        // header button, empty CTA, and slash command on one code path; in
        // noSave mode the generator can therefore honor the displayed pin.
        setFeedText('');
        generateFeed(null, null, true);
    };
}
