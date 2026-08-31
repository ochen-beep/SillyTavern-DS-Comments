// @ts-check
/**
 * DS Comments — UI: Quick settings menu
 * Floating dropdown under the ⚙ button. Post stepper + quick toggles.
 * Post navigation is silent: restores cache or empty-state, never generates.
 */

import { state, getCtx, saveSettings, aiPostIndices, tr, warn } from '../core.js';
import { selectCommentaryTarget, setCurrentPost, updatePostIndicator } from '../cache.js';
// Static import from lifecycle.js avoids the quickmenu↔index import cycle.
import { onNoSaveModeChanged } from '../lifecycle.js';

export function isQsMenuOpen() { return !!state.qsMenuOpen; }

export function closeQsMenu() {
    const menu = document.getElementById('dscQsBody');
    if (menu) menu.remove();
    state.qsMenuOpen = false;
    // release the "pressed" look on the ⚙ button
    const btn = document.getElementById('dscQs');
    if (btn) btn.setAttribute('aria-expanded', 'false');
}

/**
 * Toggle the QS menu open/closed.
 * @param {HTMLElement} btn  the ⚙ button element
 */
export function toggleQsMenu(btn) {
    if (state.qsMenuOpen) { closeQsMenu(); return; }
    closeQsMenu();
    state.qsMenuOpen = true;
    if (btn) btn.setAttribute('aria-expanded', 'true');

    const menu = document.createElement('div');
    menu.id = 'dscQsBody';
    menu.className = 'dsc_qs_menu';
    menu.setAttribute('role', 'menu');
    menu.innerHTML = `
        <div class="dsc_qs_group">
            <div class="dsc_qs_label"><span>${tr('Posts', 'dscomments.quick.posts')}</span></div>
            <div class="dsc_stepper" style="justify-content:center">
                <button class="dsc_step_btn" data-qs-post="prev" type="button" aria-label="${tr('Previous', 'dscomments.action.previous')}">‹</button>
                <button class="dsc_step_val" data-qs-post-val id="dscQsPostVal" type="button">${postLabel()}</button>
                <button class="dsc_step_btn" data-qs-post="next" type="button" aria-label="${tr('Next', 'dscomments.action.next')}">›</button>
            </div>
        </div>

        <div class="dsc_qs_divider"></div>

        <div class="dsc_qs_group">
            <label class="dsc_toggle_row"><input type="checkbox" id="dscQsAutoupdate" class="checkbox"> ${tr('Auto-update', 'dscomments.quick.autoupdate')}</label>
            <label class="dsc_toggle_row"><input type="checkbox" id="dscQsNosave" class="checkbox"> ${tr('No-save', 'dscomments.quick.nosave')}</label>
            <label class="dsc_toggle_row"><input type="checkbox" id="dscQsSound" class="checkbox"> ${tr('Sound', 'dscomments.quick.sound')}</label>
        </div>
    `;

    document.body.appendChild(menu);
    syncQsToggles(menu);

    // Position under the button (flip up if no room below)
    menu.style.visibility = 'hidden';
    const rect = btn.getBoundingClientRect();
    const mH = menu.offsetHeight || 240;
    const mW = menu.offsetWidth || 240;
    const spaceBelow = window.innerHeight - rect.bottom - 8;
    const spaceAbove = rect.top - 8;
    menu.style.top = `${Math.max(4, spaceBelow >= mH || spaceBelow >= spaceAbove ? rect.bottom + 4 : rect.top - mH - 4)}px`;
    if (rect.left + mW > window.innerWidth - 4) {
        menu.style.right = `${Math.max(4, window.innerWidth - rect.right)}px`;
        menu.style.left = '';
    } else {
        menu.style.left = `${Math.max(4, rect.left)}px`;
        menu.style.right = '';
    }
    // Mobile: drop down inside the window's content region under the header.
    if (window.innerWidth < 768) {
        menu.style.left = '8px';
        menu.style.right = '8px';
        menu.style.top = 'calc(var(--dsc-st-top, 0px) + var(--dsc-header-h, 44px) + 4px)';
        menu.style.bottom = '';
        menu.style.maxWidth = 'none';
        menu.style.maxHeight = 'calc(100dvh - var(--dsc-st-top, 0px) - var(--dsc-header-h, 44px) - var(--dsc-st-bottom, 0px) - 16px)';
    }
    menu.style.visibility = '';

    wireQsEvents(menu);
    return menu;
}

// ── Helpers ──

/** Post label: "3/12" (current position / total AI posts). */
function postLabel() {
    const idxs = aiPostIndices();
    if (!idxs.length) return '0/0';
    const cur = parseInt(state.currentPostId);
    const pos = idxs.indexOf(cur);
    if (pos === -1) return `—/${idxs.length}`;
    return `${pos + 1}/${idxs.length}`;
}

/**
 * Move to the AI post offset from the current one.
 * Restores cache or shows empty-state; never generates (only ⟳ and CTA do).
 */
async function navigatePost(dir) {
    const idxs = aiPostIndices();
    if (!idxs.length) { closeQsMenu(); return; }
    if (Date.now() < state.navLockUntil) { closeQsMenu(); return; }
    const cur = parseInt(state.currentPostId);
    let pos = idxs.indexOf(cur);
    if (pos === -1) pos = idxs.length - 1; // no current → last
    pos = Math.max(0, Math.min(idxs.length - 1, pos + dir));
    if (pos === idxs.indexOf(cur)) { closeQsMenu(); return; }
    const msgId = idxs[pos];
    const msg = getCtx().chat?.[msgId];
    const swipe = typeof msg?.swipe_id === 'number' ? msg.swipe_id : 0;
    state.navLockUntil = Date.now() + 1500;
    // Feed → chat sync (via the standard DOM attribute mesid)
    const chatEl = document.querySelector(`[mesid="${msgId}"]`);
    if (chatEl) chatEl.scrollIntoView({ behavior: 'smooth', block: 'center' });

    // noSaveMode: position only; saveMode: restore cache for the post.
    if (state.settings.noSaveMode) {
        setCurrentPost(String(msgId), swipe);
        closeQsMenu();
        return;
    }
    const result = await selectCommentaryTarget(String(msgId), swipe, { source: 'quick navigation' });
    if (result.status === 'superseded') return;
    updatePostIndicator();
    closeQsMenu();
}

/** Compact post selector — opens on tap of the label. Restores cache or empty-state. */
function openPostSelector(menu) {
    const existing = menu.querySelector('#dscQsNavSel');
    if (existing) { existing.focus(); return; }
    const sel = document.createElement('select');
    sel.id = 'dscQsNavSel';
    sel.className = 'dsc_nav_select';
    sel.style.marginTop = '6px';
    const idxs = aiPostIndices();
    const chat = getCtx().chat || [];
    idxs.forEach(i => {
        const msg = chat[i];
        const swipeIdx = typeof msg.swipe_id === 'number' ? msg.swipe_id : 0;
        const total = msg.swipes?.length || 1;
        const preview = (msg.mes || '').replace(/<[^>]*>/g, '').slice(0, 32).replace(/\n/g, ' ');
        const o = document.createElement('option');
        o.value = i;
        o.textContent = `#${i + 1} [${swipeIdx + 1}/${total}] ${preview}…`;
        if (String(i) === String(state.currentPostId)) o.selected = true;
        sel.appendChild(o);
    });
    sel.addEventListener('change', async function () {
        const msgId = this.value;
        const msg = chat?.[msgId];
        const swipe = typeof msg?.swipe_id === 'number' ? msg.swipe_id : 0;
        state.navLockUntil = Date.now() + 1500;
        // Feed → chat sync
        const chatEl = document.querySelector(`[mesid="${msgId}"]`);
        if (chatEl) chatEl.scrollIntoView({ behavior: 'smooth', block: 'center' });

        // noSaveMode: position only; saveMode: restore.
        if (state.settings.noSaveMode) {
            setCurrentPost(String(msgId), swipe);
            closeQsMenu();
            return;
        }
        const result = await selectCommentaryTarget(String(msgId), swipe, { source: 'quick navigation' });
        if (result.status === 'superseded') return;
        updatePostIndicator();
        closeQsMenu();
    });
    const group = menu.querySelector('[data-qs-post-val]')?.closest('.dsc_qs_group');
    group?.appendChild(sel);
    sel.focus();
}

function syncQsToggles(menu) {
    const set = (id, val) => { const el = menu.querySelector(id); if (el) el.checked = !!val; };
    set('#dscQsAutoupdate', state.settings.autoUpdate);
    set('#dscQsNosave', state.settings.noSaveMode);
    set('#dscQsSound', state.settings.soundEnabled);
}

function wireQsEvents(menu) {
    menu.querySelector('[data-qs-post="prev"]')?.addEventListener('click', () => navigatePost(-1));
    menu.querySelector('[data-qs-post="next"]')?.addEventListener('click', () => navigatePost(1));
    menu.querySelector('[data-qs-post-val]')?.addEventListener('click', () => openPostSelector(menu));

    // Toggles
    menu.querySelector('#dscQsAutoupdate')?.addEventListener('change', function () {
        state.settings.autoUpdate = this.checked; saveSettings();
    });
    menu.querySelector('#dscQsNosave')?.addEventListener('change', function () {
        state.settings.noSaveMode = this.checked;
        // Mode toggle = immediate feed recalculation.
        onNoSaveModeChanged().catch((e) => warn('onNoSaveModeChanged error:', e));
    });
    menu.querySelector('#dscQsSound')?.addEventListener('change', function () {
        state.settings.soundEnabled = this.checked; saveSettings();
    });
}
