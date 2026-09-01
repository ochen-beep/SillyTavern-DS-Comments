// @ts-check
/**
 * DS Comments — UI: Floating launcher button (FAB)
 * Draggable round button pinned to a viewport corner that toggles the comments
 * panel. Selected via settings.launcherMode ('floating' | 'both'). Unlike the
 * quick-reply bar launcher it works even when the QR bar is absent (Quick
 * Replies extension disabled).
 *
 * The FAB never hides while the panel is open — the panel has no close button,
 * so the FAB itself is the toggle (accent-highlighted via .dsc_fab_active).
 *
 * DOM id: #dsc_fab (single source of truth; generator.js pulses it with
 * .dsc_generating alongside #dsc_launcher).
 *
 * Position persists in localStorage (dsc_fab_position) as {left, top} px,
 * written only on drag release and restored (validated) on every mount — it
 * survives browser restarts until the user drags the button somewhere else.
 */

import { DISPLAY_NAME, tr } from '../core.js';
import { isPanelVisible } from './window.js';
import { iconHtml } from './icons.js';

const FAB_ID = 'dsc_fab';
const POSITION_KEY = 'dsc_fab_position';
const FAB_SIZE = 36;
// Pointer travel (px) that separates a click from a drag.
const DRAG_THRESHOLD_PX = 6;
// Default anchor offsets from the bottom-right corner; mobile clears #send_form.
const DEFAULT_RIGHT = 20;
const DEFAULT_BOTTOM = 80;
const DEFAULT_RIGHT_MOBILE = 16;
const DEFAULT_BOTTOM_MOBILE = 120;

// Toggle handler wired by index.js (toggleLauncherPanel). Stored at module level
// so re-mounts keep the same behaviour without re-passing it.
let _onToggle = null;
let _resizeBound = false;

function getFab() {
    return document.getElementById(FAB_ID);
}

function getViewport() {
    return { width: window.innerWidth, height: window.innerHeight };
}

// ── Position math (pure — unit-tested) ──

function defaultPosition(viewport, size, isMobile) {
    const right = isMobile ? DEFAULT_RIGHT_MOBILE : DEFAULT_RIGHT;
    const bottom = isMobile ? DEFAULT_BOTTOM_MOBILE : DEFAULT_BOTTOM;
    return {
        left: Math.max(0, viewport.width - size - right),
        top: Math.max(0, viewport.height - size - bottom),
    };
}

function clampPosition(pos, viewport, size) {
    return {
        left: Math.max(0, Math.min(pos.left, viewport.width - size)),
        top: Math.max(0, Math.min(pos.top, viewport.height - size)),
    };
}

/**
 * Pick the mount position: the saved one when it is still fully inside the
 * viewport, the corner default otherwise.
 * @param {{left: number, top: number}|null} saved parsed localStorage payload
 */
function computeRestoredPosition(saved, viewport, size, isMobile) {
    if (saved
        && Number.isFinite(saved.left) && Number.isFinite(saved.top)
        && saved.left >= 0 && saved.top >= 0
        && saved.left + size <= viewport.width
        && saved.top + size <= viewport.height) {
        return { left: saved.left, top: saved.top };
    }
    return defaultPosition(viewport, size, isMobile);
}

// ── Position persistence ──

function restorePosition(icon) {
    let saved = null;
    try {
        const raw = localStorage.getItem(POSITION_KEY);
        if (raw) saved = JSON.parse(raw);
    } catch {
        try { localStorage.removeItem(POSITION_KEY); } catch { /* quota/private mode */ }
    }
    const pos = computeRestoredPosition(saved, getViewport(), FAB_SIZE, isMobileViewport());
    icon.style.left = `${pos.left}px`;
    icon.style.top = `${pos.top}px`;
    icon.style.right = 'auto';
    icon.style.bottom = 'auto';
}

function persistPosition(icon) {
    try {
        localStorage.setItem(POSITION_KEY, JSON.stringify({
            left: parseFloat(icon.style.left),
            top: parseFloat(icon.style.top),
        }));
    } catch { /* quota/private mode — position just won't survive a restart */ }
}

// ── Drag (Pointer Events + capture) ──

function makeDraggable(icon) {
    let dragging = false;
    let offsetX = 0, offsetY = 0;
    let startX = 0, startY = 0;

    icon.addEventListener('pointerdown', (e) => {
        if (e.pointerType === 'mouse' && e.button !== 0) return;
        dragging = false;
        const r = icon.getBoundingClientRect();
        offsetX = e.clientX - r.left;
        offsetY = e.clientY - r.top;
        startX = r.left;
        startY = r.top;
        icon.setPointerCapture(e.pointerId);
        e.preventDefault();
    });

    icon.addEventListener('pointermove', (e) => {
        if (!icon.hasPointerCapture(e.pointerId)) return;
        const rawX = e.clientX - offsetX;
        const rawY = e.clientY - offsetY;
        if (!dragging && Math.hypot(rawX - startX, rawY - startY) > DRAG_THRESHOLD_PX) {
            dragging = true;
            icon.classList.add('dsc_fab_dragging');
        }
        const pos = clampPosition({ left: rawX, top: rawY }, getViewport(), FAB_SIZE);
        icon.style.left = `${pos.left}px`;
        icon.style.top = `${pos.top}px`;
    });

    icon.addEventListener('pointerup', (e) => {
        if (icon.hasPointerCapture(e.pointerId)) icon.releasePointerCapture(e.pointerId);
        const wasDragging = dragging;
        dragging = false;
        icon.classList.remove('dsc_fab_dragging');
        if (wasDragging) persistPosition(icon);
        else if (_onToggle) _onToggle();
    });

    icon.addEventListener('pointercancel', (e) => {
        if (icon.hasPointerCapture(e.pointerId)) icon.releasePointerCapture(e.pointerId);
        dragging = false;
        icon.classList.remove('dsc_fab_dragging');
    });

    icon.style.touchAction = 'none';
}

// Keep the FAB inside the viewport when the window shrinks under it.
function onWindowResize() {
    const icon = getFab();
    if (!icon) return;
    const left = parseFloat(icon.style.left);
    const top = parseFloat(icon.style.top);
    if (!Number.isFinite(left) || !Number.isFinite(top)) return;
    const pos = clampPosition({ left, top }, getViewport(), FAB_SIZE);
    icon.style.left = `${pos.left}px`;
    icon.style.top = `${pos.top}px`;
}

// window.js keeps its own mobile check private; mirror the viewport-width rule.
function isMobileViewport() {
    return window.innerWidth < 768;
}

// ── Public API ──

/**
 * Mount (or re-sync) the floating launcher. No-op regarding mode: index.js's
 * ensureLauncher() decides from settings.launcherMode whether to call this.
 * @param {{onToggle?: Function}} [opts]
 */
export function ensureFloatingLauncher({ onToggle } = {}) {
    if (onToggle) _onToggle = onToggle;
    let icon = getFab();
    if (!icon) {
        icon = document.createElement('div');
        icon.id = FAB_ID;
        icon.className = 'dsc_fab';
        icon.tabIndex = 0;
        icon.setAttribute('role', 'button');
        icon.setAttribute('aria-label', DISPLAY_NAME);
        icon.title = tr('DS Comments — click to toggle, drag to move', 'dscomments.fab.hint');
        icon.innerHTML = iconHtml('message');

        icon.addEventListener('keydown', (e) => {
            if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                if (_onToggle) _onToggle();
            }
        });

        document.body.appendChild(icon);
        restorePosition(icon);
        makeDraggable(icon);
        if (!_resizeBound) {
            _resizeBound = true;
            window.addEventListener('resize', onWindowResize);
        }
    }
    syncFloatingLauncher();
    return icon;
}

/**
 * Refresh the active (panel-open) highlight. Called from ensureLauncher()
 * whenever launcher state changes.
 */
export function syncFloatingLauncher() {
    const icon = getFab();
    if (icon) icon.classList.toggle('dsc_fab_active', isPanelVisible());
}

export function removeFloatingLauncher() {
    const icon = getFab();
    if (icon) icon.remove();
    if (_resizeBound) {
        _resizeBound = false;
        window.removeEventListener('resize', onWindowResize);
    }
}

// Test-only exports (NODE_TEST guard — invisible in the ST browser host).
const _test = typeof process !== 'undefined' && process?.env?.NODE_TEST === '1'
    ? { defaultPosition, clampPosition, computeRestoredPosition, FAB_SIZE, DRAG_THRESHOLD_PX }
    : undefined;
export { _test as _testFloatingLauncher };
