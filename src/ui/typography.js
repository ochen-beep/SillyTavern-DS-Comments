// @ts-check
/**
 * DS Comments — Typography popover
 * Compact popover: size stepper + family chips. Opens on tap of #dscType (Aa).
 * Anchored to the button on desktop; bottom-sheet on mobile.
 */

import { state, saveSettings, escapeHtml, tr, DSC_FONTS, NUMERIC_SETTINGS, normalizeFiniteNumber } from '../core.js';
import { applyFontSize, applyFontFamily } from './settings-sync.js';

let _popover = null;

export function closeTypographyPopover() {
    if (_popover) { _popover.remove(); _popover = null; }
    const btn = document.getElementById('dscType');
    if (btn) btn.setAttribute('aria-expanded', 'false');
}

export function toggleTypographyPopover(btn) {
    if (_popover) { closeTypographyPopover(); return; }
    _popover = document.createElement('div');
    _popover.id = 'dscTypeBody';
    _popover.className = 'dsc_popover';
    _popover.setAttribute('role', 'dialog');
    if (btn) btn.setAttribute('aria-expanded', 'true');

    const size = state.settings.fontSize;
    const famChips = Object.entries(DSC_FONTS).map(([k, f]) =>
        `<button class="dsc_chip${state.settings.fontFamily === k ? ' dsc_selected' : ''}" data-typ-fam="${k}" type="button">${escapeHtml(tr(f.label, `dscomments.font.${k}`))}</button>`
    ).join('');

    _popover.innerHTML = `
        <div class="dsc_pop_group">
            <div class="dsc_pop_label">${tr('Font size', 'dscomments.font.size')}</div>
            <div class="dsc_stepper">
                <button class="dsc_step_btn" data-typ-size-dir="minus" type="button" aria-label="${tr('Decrease', 'dscomments.action.decrease')}">−</button>
                <span class="dsc_step_val" data-typ-size-val>${size} px</span>
                <button class="dsc_step_btn" data-typ-size-dir="plus" type="button" aria-label="${tr('Increase', 'dscomments.action.increase')}">+</button>
            </div>
        </div>
        <div class="dsc_pop_divider"></div>
        <div class="dsc_pop_group">
            <div class="dsc_pop_label">${tr('Family', 'dscomments.font.family')}</div>
            <div class="dsc_chips">${famChips}</div>
        </div>
    `;
    document.body.appendChild(_popover);
    positionPopover(btn);
    wireEvents();
    return _popover;
}

function positionPopover(btn) {
    if (!_popover || !btn) return;
    _popover.style.visibility = 'hidden';
    const rect = btn.getBoundingClientRect();
    const mH = _popover.offsetHeight || 180;
    const mW = _popover.offsetWidth || 220;
    if (window.innerWidth < 768) {
        // Mobile: drop down inside the window's content region under the header.
        _popover.style.left = '8px';
        _popover.style.right = '8px';
        _popover.style.top = 'calc(var(--dsc-st-top, 0px) + var(--dsc-header-h, 44px) + 4px)';
        _popover.style.bottom = '';
        _popover.style.maxWidth = 'none';
        _popover.style.maxHeight = 'calc(100dvh - var(--dsc-st-top, 0px) - var(--dsc-header-h, 44px) - var(--dsc-st-bottom, 0px) - 16px)';
        _popover.style.visibility = '';
        return;
    }
    // Desktop: under the button, push right if it doesn't fit
    let top = rect.bottom + 4;
    if (top + mH > window.innerHeight - 4) top = Math.max(4, rect.top - mH - 4);
    _popover.style.top = `${top}px`;
    if (rect.left + mW > window.innerWidth - 4) {
        _popover.style.right = `${Math.max(4, window.innerWidth - rect.right)}px`;
        _popover.style.left = '';
    } else {
        _popover.style.left = `${Math.max(4, rect.left)}px`;
        _popover.style.right = '';
    }
    _popover.style.visibility = '';
}

function wireEvents() {
    if (!_popover) return;
    _popover.querySelectorAll('[data-typ-size-dir]').forEach(b => {
        b.addEventListener('click', function () {
            const valEl = _popover.querySelector('[data-typ-size-val]');
            const rule = NUMERIC_SETTINGS.fontSize;
            const delta = this.dataset.typSizeDir === 'plus' ? 1 : -1;
            const v = normalizeFiniteNumber(normalizeFiniteNumber(state.settings.fontSize, rule) + delta, rule);
            state.settings.fontSize = v;
            applyFontSize(v);
            if (valEl) valEl.textContent = `${v} px`;
            saveSettings();
        });
    });
    _popover.querySelectorAll('[data-typ-fam]').forEach(el => {
        el.addEventListener('click', function () {
            state.settings.fontFamily = this.dataset.typFam;
            applyFontFamily(state.settings.fontFamily);
            _popover.querySelectorAll('[data-typ-fam]').forEach(c =>
                c.classList.toggle('dsc_selected', c === this));
            saveSettings();
        });
    });
}

export function isTypographyOpen() { return !!_popover; }
