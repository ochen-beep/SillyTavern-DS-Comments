// @ts-check
/**
 * DS Comments — UI: Floating window
 * Mounts the panel DOM, handles drag/resize (desktop), full-screen (mobile),
 * viewport sync, position persistence.
 * DOM ids here are the single source of truth: #dscWindow, #dscHeader (drag),
 * #dscFeed (content), #dscResize (grip). chrome.js/quickmenu.js hang off these.
 */

import { state, flushSettings, debounce, tr } from '../core.js';
import { whenSendFormReady } from './dom-ready.js';
import { normalizeDesktopGeometry } from './window-geometry.js';
import { applyPendingFeedScrollReset } from './feed-controller.js';

// ── Module-owned runtime handles (teardown targets) ──
let _viewportResizeHandler = null;
let _chromeResizeObserver = null;
let _chromeRemeasure = null;

// ── Geometry helpers ──

function isMobileViewport() {
    // Deliberately the VIEWPORT WIDTH, not device-based
    // ctx.isMobile — the floating panel has no room in a narrow window even on
    // a desktop, so layout follows available space, not device class.
    return window.innerWidth < 768;
}

/** Read saved geometry from settings (with built-in defaults). */
function geom() {
    return state.settings.windowGeom || { width: 380, height: 360, left: null, top: null, bottom: 70 };
}

/** Build the persisted desktop geometry, falling back to the default placement. */
function savedDesktopGeometry() {
    const g = geom();
    const width = Math.max(240, g.width || 380);
    const height = Math.max(120, g.height || 360);
    const hasSavedPosition = g.left != null && g.top != null;
    return {
        width,
        height,
        left: hasSavedPosition ? g.left : Math.max(0, Math.round((window.innerWidth - width) / 2)),
        top: hasSavedPosition ? g.top : Math.max(0, window.innerHeight - height - (g.bottom || 70)),
    };
}

/** Return the current visual viewport, falling back to the layout viewport. */
function currentViewportRect() {
    const viewport = window.visualViewport;
    if (viewport && Number.isFinite(viewport.width) && Number.isFinite(viewport.height)) {
        return {
            left: viewport.offsetLeft || 0,
            top: viewport.offsetTop || 0,
            width: viewport.width,
            height: viewport.height,
        };
    }
    return { left: 0, top: 0, width: window.innerWidth, height: window.innerHeight };
}

/** Render desktop geometry for the current viewport without persisting it. */
function applyDesktopGeometry() {
    const bar = document.getElementById('dscWindow');
    if (!bar) return;
    const rendered = normalizeDesktopGeometry(savedDesktopGeometry(), currentViewportRect());
    bar.classList.remove('dsc_mobile');
    bar.style.width = `${rendered.width}px`;
    bar.style.height = `${rendered.height}px`;
    applyPosition(rendered.left, rendered.top);
}

function readTransformPosition(bar) {
    const m = bar.style.transform?.match(/translate3d\(\s*([-\d.]+)px\s*,\s*([-\d.]+)px/);
    if (!m) return null;
    return { left: parseFloat(m[1]), top: parseFloat(m[2]) };
}

function applyPosition(left, top) {
    const bar = document.getElementById('dscWindow');
    if (!bar) return;
    bar.style.right = 'auto';
    bar.style.bottom = 'auto';
    bar.style.left = '0';
    bar.style.top = '0';
    bar.style.transform = `translate3d(${left}px, ${top}px, 0)`;
}

function savePosition() {
    const bar = document.getElementById('dscWindow');
    if (!bar) return;
    const g = geom();
    const pos = readTransformPosition(bar);
    if (pos) { g.left = pos.left; g.top = pos.top; }
    if (bar.style.width)  g.width  = Math.max(240, parseFloat(bar.style.width));
    if (bar.style.height) g.height = Math.max(120, parseFloat(bar.style.height));
    state.settings.windowGeom = g;
    flushSettings();
}

// ── SillyTavern chrome measurement (mobile insets) ──

// Measure ST chrome so mobile full-screen panel clears #top-bar / #send_form.
const ST_TOPBAR_SEL = '#top-bar';
const ST_SENDFORM_SEL = '#send_form';
const ST_TOPBAR_FALLBACK = 40;
const ST_SENDFORM_FALLBACK = 120;

function measureStChrome() {
    const root = document.documentElement;
    if (!root) return;

    // #top-bar: only the portion at the very top of the viewport counts.
    // A bar scrolled out of view (rect.bottom <= 0) contributes nothing.
    const topBar = document.querySelector(ST_TOPBAR_SEL);
    let topH = 0;
    if (topBar) {
        const r = topBar.getBoundingClientRect();
        topH = r.bottom > 0 ? Math.min(r.bottom, window.innerHeight) : 0;
        if (!Number.isFinite(topH) || topH <= 0) {
            const tok = topBarBlockSizePx();
            topH = tok != null ? tok : ST_TOPBAR_FALLBACK;
        }
    }

    // #send_form: height of the bottom input bar as currently laid out.
    const sendForm = document.querySelector(ST_SENDFORM_SEL);
    let bottomH = 0;
    if (sendForm) {
        const r = sendForm.getBoundingClientRect();
        bottomH = Math.max(0, Math.min(r.height, window.innerHeight));
        if (!Number.isFinite(bottomH) || bottomH <= 0) bottomH = ST_SENDFORM_FALLBACK;
    }

    root.style.setProperty('--dsc-st-top', `${Math.round(topH)}px`);
    root.style.setProperty('--dsc-st-bottom', `${Math.round(bottomH)}px`);
}

/** Parse a CSS length token like '45px' into a number, or null. */
function readCssPx(el, prop) {
    const raw = getComputedStyle(el).getPropertyValue(prop).trim();
    const n = parseFloat(raw);
    return raw && Number.isFinite(n) ? n : null;
}

// Cache --topBarBlockSize: the ST variable changes rarely, while getComputedStyle
// forces a style recalc. Read once and reuse; null means the token is absent.
let _topBarBlockPx = undefined;   // undefined = not measured, null = token absent, number = pixels
function topBarBlockSizePx() {
    if (_topBarBlockPx !== undefined) return _topBarBlockPx;
    const root = document.documentElement;
    _topBarBlockPx = root ? readCssPx(root, '--topBarBlockSize') : null;
    return _topBarBlockPx;
}

// #send_form's height changes at runtime (quick-reply panel expand/collapse,
// extension toolbar appearing, keyboard interactions). Watch it so the mobile
// bottom inset tracks those changes.
let _chromeObserverBound = false;
let _chromeReadyDispose = null;
function observeStChrome() {
    if (_chromeObserverBound || typeof ResizeObserver === 'undefined') return;
    _chromeObserverBound = true;
    _chromeRemeasure = debounce(() => {
        if (isMobileViewport()) measureStChrome();
    }, 200);
    // #send_form is core UI guaranteed present by APP_READY; if already present
    // (post-ready enable), attach synchronously, otherwise wait for APP_READY
    // (event-driven, no polling). Keep the disposer so teardown before APP_READY
    // removes the pending listener instead of attaching an orphan observer.
    _chromeReadyDispose = whenSendFormReady((sendForm) => {
        _chromeResizeObserver?.disconnect();
        _chromeResizeObserver = new ResizeObserver(_chromeRemeasure);
        _chromeResizeObserver.observe(sendForm);
    });
}

// ── Mount / visibility ──

/**
 * Panel is visible only when the extension is enabled AND not collapsed.
 */
export function isPanelVisible() {
    return !!state.settings.enabled && !state.settings.collapsed;
}

function setVisibilityFromState(bar) {
    if (!bar) return;
    const shouldShow = isPanelVisible();

    // Cancel in-flight transitions so rapid toggle can't leave stale work.
    if (bar._dscHideTimer) { clearTimeout(bar._dscHideTimer); bar._dscHideTimer = 0; }
    if (bar._dscRevealRafOuter) { cancelAnimationFrame(bar._dscRevealRafOuter); bar._dscRevealRafOuter = 0; }
    if (bar._dscRevealRafInner) { cancelAnimationFrame(bar._dscRevealRafInner); bar._dscRevealRafInner = 0; }

    // First-show: apply instantly, no fade.
    if (!bar.dataset.dscVisInit) {
        bar.dataset.dscVisInit = '1';
        bar.hidden = !shouldShow;
        bar.style.display = shouldShow ? '' : 'none';
        bar.style.opacity = shouldShow ? '' : '0';
        if (shouldShow) applyPendingFeedScrollReset();
        return;
    }

    if (shouldShow) {
        // Refresh geometry before first visible frame.
        if (isMobileViewport()) applyMobileMode();
        else applyDesktopGeometry();
        // Reveal: opacity 0 → unhide → two-rAF guarantee → opacity 1.
        bar.style.opacity = '0';
        bar.hidden = false;
        bar.style.display = '';
        bar._dscRevealRafOuter = requestAnimationFrame(() => {
            bar._dscRevealRafOuter = 0;
            bar._dscRevealRafInner = requestAnimationFrame(() => {
                bar._dscRevealRafInner = 0;
                // Deferred feed scroll reset must land AFTER the browser has
                // restored the hide-time scroll offset (it does so while
                // re-laying-out the revealed panel) — hence this two-rAF tail.
                applyPendingFeedScrollReset();
                bar.style.opacity = '';
            });
        });
    } else {
        // Collapse: fade out, then hide after transition (use timer, not
        // transitionend — prefers-reduced-motion may suppress transitions).
        bar.style.opacity = '0';
        bar._dscHideTimer = setTimeout(() => {
            bar._dscHideTimer = 0;
            bar.hidden = true;
            bar.style.display = 'none';
            bar.style.opacity = '';
        }, 200);
    }
}

/**
 * Sync floating-panel visibility to the current enabled/collapsed state.
 * Finds #dscWindow in the DOM and applies hidden/display.
 * Safe no-op if the panel is not yet mounted.
 * @returns {boolean} whether the panel is currently visible after sync
 */
export function syncPanelVisibility() {
    setVisibilityFromState(document.getElementById('dscWindow'));
    return isPanelVisible();
}



/**
 * Mount the panel (idempotent — safe to call repeatedly).
 * Returns the #dscWindow element.
 */
export function mountPanel() {
    let bar = document.getElementById('dscWindow');
    if (bar) {
        setVisibilityFromState(bar);
        return bar;
    }

    bar = document.createElement('div');
    bar.id = 'dscWindow';
    bar.className = 'dsc_window';
    bar.innerHTML = `
        <div class="dsc_header" id="dscHeader">
            <button class="dsc_btn" id="dscType" type="button" aria-label="${tr('Font', 'dscomments.font.label')}" title="${tr('Font size and family', 'dscomments.font.title')}">Aa</button>
            <div class="dsc_indicator" id="dscIndicator" aria-live="polite" hidden></div>
            <div class="dsc_header_right">
                <button class="dsc_btn" id="dscRegen" type="button" aria-label="${tr('Regenerate', 'dscomments.action.regenerate')}" title="${tr('Regenerate', 'dscomments.action.regenerate')}">⟳</button>
                <button class="dsc_btn" id="dscQs" type="button" aria-label="${tr('Quick settings', 'dscomments.quickSettings')}" title="${tr('Quick settings', 'dscomments.quickSettings')}">⚙</button>
            </div>
        </div>
        <div class="dsc_status_overlay" id="dscStatusOverlay"></div>
        <div class="dsc_feed" id="dscFeed" role="log" aria-live="polite"></div>
        <div class="dsc_resize" id="dscResize" aria-hidden="true"></div>
    `;
    document.body.appendChild(bar);

    // Apply saved font/size vars
    const fs = state.settings.fontSize;
    if (fs) bar.style.setProperty('--dsc-font-size', `${fs}px`);

    setVisibilityFromState(bar);
    initResize();
    initDrag();
    restorePosition();
    return bar;
}

export function removePanel() {
    const bar = document.getElementById('dscWindow');
    if (!bar) return;
    // Cancel any in-flight visibility transitions so removed DOM is never touched.
    if (bar._dscHideTimer) { clearTimeout(bar._dscHideTimer); bar._dscHideTimer = 0; }
    if (bar._dscRevealRafOuter) { cancelAnimationFrame(bar._dscRevealRafOuter); bar._dscRevealRafOuter = 0; }
    if (bar._dscRevealRafInner) { cancelAnimationFrame(bar._dscRevealRafInner); bar._dscRevealRafInner = 0; }
    // Tear down active drag/resize gestures so document listeners do not leak.
    bar._dscDragCleanup?.();
    bar._dscResizeCleanup?.();
    bar.remove();
}

// ── Drag ──

function initDrag() {
    const bar = document.getElementById('dscWindow');
    const header = document.getElementById('dscHeader');
    if (!bar || !header || header._dragBound) return;
    header._dragBound = true;

    let startX = 0, startY = 0, startLeft = 0, startTop = 0;
    let cachedW = 0, cachedH = 0, cachedVW = 0, cachedVH = 0;
    // Coalesce pointer moves to one transform write per animation frame.
    // preventDefault still runs synchronously so the page never scrolls during drag.
    let rafId = 0, lastPt = null;
    function applyMove() {
        rafId = 0;
        if (!lastPt) return;
        let nl = startLeft + (lastPt.clientX - startX);
        let nt = startTop + (lastPt.clientY - startY);
        nl = Math.max(40 - cachedW, Math.min(cachedVW - 40, nl));
        nt = Math.max(0, Math.min(cachedVH - 40, nt));
        bar.style.transform = `translate3d(${nl}px, ${nt}px, 0)`;
    }
    function onMove(e) {
        lastPt = e.touches ? e.touches[0] : e;
        if (!rafId) rafId = requestAnimationFrame(applyMove);
        e.preventDefault();
    }
    function onEnd() {
        document.removeEventListener('mousemove', onMove);
        document.removeEventListener('touchmove', onMove);
        // Flush any pending frame so the window lands exactly where the pointer
        // released, then tear down the drag hint and persist geometry.
        if (rafId) { cancelAnimationFrame(rafId); rafId = 0; }
        if (lastPt) { applyMove(); lastPt = null; }
        bar.style.willChange = '';
        bar.classList.remove('dsc_dragging');   // restore backdrop-filter blur + full shadow
        savePosition();
    }
    function onStart(e) {
        if (isMobileViewport()) return;
        // Don't drag when clicking buttons inside the header
        if (e.target.closest('button')) return;
        const pt = e.touches ? e.touches[0] : e;
        const rect = bar.getBoundingClientRect();
        startX = pt.clientX; startY = pt.clientY;
        startLeft = rect.left; startTop = rect.top;
        cachedW = bar.offsetWidth; cachedH = bar.offsetHeight;
        cachedVW = window.innerWidth; cachedVH = window.innerHeight;
        applyPosition(startLeft, startTop);
        bar.classList.add('dsc_dragging');       // drop backdrop-filter for smooth drag
        // Promote the window to its own compositor layer during the drag so
        // transform changes don't trigger layout/paint on the rest of the document.
        bar.style.willChange = 'transform';
        const move = e.touches ? 'touchmove' : 'mousemove';
        const end = e.touches ? 'touchend' : 'mouseup';
        document.addEventListener(move, onMove, { passive: false });
        document.addEventListener(end, onEnd, { once: true });
        e.preventDefault();
    }
    header.addEventListener('mousedown', onStart);
    header.addEventListener('touchstart', onStart, { passive: false });

    bar._dscDragCleanup = () => {
        document.removeEventListener('mousemove', onMove);
        document.removeEventListener('touchmove', onMove);
        document.removeEventListener('mouseup', onEnd);
        document.removeEventListener('touchend', onEnd);
        if (rafId) { cancelAnimationFrame(rafId); rafId = 0; }
        lastPt = null;
        bar.classList.remove('dsc_dragging');
        bar.style.willChange = '';
    };
}

// ── Resize ──

function initResize() {
    const bar = document.getElementById('dscWindow');
    const grip = document.getElementById('dscResize');
    if (!bar || !grip || grip._resizeBound) return;
    grip._resizeBound = true;

    let sx = 0, sy = 0, sw = 0, sh = 0;
    // rAF coalesce — width/height writes trigger layout (heavier than a transform),
    // so collapsing a burst of pointer events into one write per frame matters more here.
    let rafId = 0, lastPt = null;
    function applyMove() {
        rafId = 0;
        if (!lastPt) return;
        bar.style.width = `${Math.max(240, sw + (lastPt.clientX - sx))}px`;
        bar.style.height = `${Math.max(120, sh + (lastPt.clientY - sy))}px`;
    }
    function onMove(e) {
        lastPt = e.touches ? e.touches[0] : e;
        if (!rafId) rafId = requestAnimationFrame(applyMove);
        e.preventDefault();
    }
    function onEnd() {
        document.removeEventListener('mousemove', onMove);
        document.removeEventListener('touchmove', onMove);
        if (rafId) { cancelAnimationFrame(rafId); rafId = 0; }
        if (lastPt) { applyMove(); lastPt = null; }
        savePosition();
    }
    function onStart(e) {
        if (isMobileViewport()) return;
        const pt = e.touches ? e.touches[0] : e;
        sx = pt.clientX; sy = pt.clientY;
        sw = bar.offsetWidth; sh = bar.offsetHeight;
        grip.classList.add('resizing');
        const move = e.touches ? 'touchmove' : 'mousemove';
        const end = e.touches ? 'touchend' : 'mouseup';
        document.addEventListener(move, onMove, { passive: false });
        document.addEventListener(end, onEnd, { once: true });
        e.preventDefault();
    }
    grip.addEventListener('mousedown', onStart);
    grip.addEventListener('touchstart', onStart, { passive: false });

    bar._dscResizeCleanup = () => {
        document.removeEventListener('mousemove', onMove);
        document.removeEventListener('touchmove', onMove);
        document.removeEventListener('mouseup', onEnd);
        document.removeEventListener('touchend', onEnd);
        if (rafId) { cancelAnimationFrame(rafId); rafId = 0; }
        lastPt = null;
        grip.classList.remove('resizing');
    };
}

// ── Mobile mode: full-screen panel ──

/**
 * Apply full-screen mobile mode to the window. Mobile viewport only.
 * Exported — called from viewport-sync after resize/orientation changes.
 */
export function applyMobileMode() {
    const bar = document.getElementById('dscWindow');
    if (!bar || !isMobileViewport()) return;
    bar.style.transform = '';
    bar.classList.add('dsc_mobile');
    bar.style.left = ''; bar.style.top = '';
    bar.style.right = ''; bar.style.bottom = '';
    bar.style.width = ''; bar.style.height = '';
    measureStChrome();
}

// ── Restore position (desktop) / clear overrides (mobile) ──

export function restorePosition() {
    const bar = document.getElementById('dscWindow');
    if (!bar) return;

    if (isMobileViewport()) {
        measureStChrome();        // refresh insets before the window fills the viewport
        bar.style.transform = '';
        bar.classList.add('dsc_mobile');
        bar.style.left = ''; bar.style.top = '';
        bar.style.right = ''; bar.style.bottom = '';
        bar.style.width = ''; bar.style.height = '';
        return;
    }
    applyDesktopGeometry();
}

// ── Viewport sync (resize/orientation) ──

let _viewportBound = false;
let _viewportResizeTarget = null;
export function initViewportSync() {
    if (_viewportBound) return;
    _viewportBound = true;
    observeStChrome();            // keep mobile bottom inset synced with #send_form
    _viewportResizeHandler = debounce(() => {
        const bar = document.getElementById('dscWindow');
        if (!bar) return;
        if (isMobileViewport()) {
            measureStChrome();        // re-measure after resize/orientation change
            applyMobileMode();
        } else {
            applyDesktopGeometry();
        }
    }, 200);
    window.addEventListener('resize', _viewportResizeHandler);
    _viewportResizeTarget = window.visualViewport || null;
    _viewportResizeTarget?.addEventListener('resize', _viewportResizeHandler);
}

export function teardownWindowRuntime() {
    const bar = document.getElementById('dscWindow');
    bar?._dscDragCleanup?.();
    bar?._dscResizeCleanup?.();

    if (_viewportResizeHandler) {
        window.removeEventListener('resize', _viewportResizeHandler);
        _viewportResizeTarget?.removeEventListener('resize', _viewportResizeHandler);
        _viewportResizeTarget = null;
        _viewportResizeHandler.cancel?.();
        _viewportResizeHandler = null;
    }
    _chromeResizeObserver?.disconnect();
    _chromeResizeObserver = null;
    _chromeReadyDispose?.();
    _chromeReadyDispose = null;
    _chromeRemeasure?.cancel?.();
    _chromeRemeasure = null;
    _viewportBound = false;
    _chromeObserverBound = false;
}

export { isMobileViewport };
