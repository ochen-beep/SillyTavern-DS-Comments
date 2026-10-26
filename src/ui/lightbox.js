// @ts-check
/**
 * DS Comments — media lightbox: fullscreen view for feed images. Memes carry
 * caption text that is hard to read at feed-column width; tap opens the image
 * as large as the viewport allows. Any tap/click inside the overlay, a pinch-in
 * or Esc closes it — the second tap mobile viewers teach; no close button.
 * A single <dialog> is reused for the session; the top layer puts it above all
 * extension and ST chrome regardless of z-index wars.
 */

import { isAllowedMediaUrl } from '../media.js';

let _dialog = null;

function ensureDialog() {
    if (_dialog) return _dialog;
    const dlg = document.createElement('dialog');
    dlg.id = 'dsc_lightbox';
    dlg.className = 'dsc_lightbox';
    let pinchSpan = 0;
    // Any tap or click closes — backdrop and image alike.
    dlg.addEventListener('click', () => closeMediaLightbox());
    // Pinch-in closes: a two-finger span shrinking below 70% of its opening
    // distance. touch-action:none in CSS keeps the browser page-zoom out of it.
    dlg.addEventListener('touchstart', (e) => {
        pinchSpan = e.touches.length === 2
            ? Math.hypot(e.touches[0].clientX - e.touches[1].clientX, e.touches[0].clientY - e.touches[1].clientY)
            : 0;
    }, { passive: true });
    dlg.addEventListener('touchmove', (e) => {
        if (!pinchSpan || e.touches.length !== 2) return;
        const span = Math.hypot(e.touches[0].clientX - e.touches[1].clientX, e.touches[0].clientY - e.touches[1].clientY);
        if (span < pinchSpan * 0.7) {
            pinchSpan = 0;
            closeMediaLightbox();
        }
    }, { passive: true });
    const img = document.createElement('img');
    img.className = 'dsc_lightbox_img';
    img.alt = '';
    dlg.appendChild(img);
    dlg._dscImg = img;
    document.body?.appendChild(dlg);
    _dialog = dlg;
    return dlg;
}

/**
 * Show `src` fullscreen. Only allow-listed CDN URLs are accepted — callers
 * pass upgraded feed <img>s that were verified at upgrade time, the check here
 * keeps that invariant local to the lightbox.
 */
export function openMediaLightbox(src, alt = '') {
    if (!isAllowedMediaUrl(src)) return;
    const dlg = ensureDialog();
    dlg._dscImg.src = src;
    dlg._dscImg.alt = String(alt || '');
    if (!dlg.open) dlg.showModal?.();
}

function closeMediaLightbox() {
    _dialog?.close?.();
}
