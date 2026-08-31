// @ts-check
/**
 * DS Comments — UI: Window geometry normalization
 * Clamps floating window position/size to the visual viewport.
 */

const MIN_WIDTH = 240;
const MIN_HEIGHT = 120;
const MIN_VISIBLE_HORIZONTAL = 60;
const HEADER_HEIGHT = 44;

const clamp = (value, min, max) => Math.min(Math.max(value, min), max);

export function normalizeDesktopGeometry(geometry, viewport) {
    const width = Math.min(Math.max(geometry.width, MIN_WIDTH), viewport.width);
    const height = Math.min(Math.max(geometry.height, MIN_HEIGHT), viewport.height);
    const minLeft = viewport.left + MIN_VISIBLE_HORIZONTAL - width;
    const maxLeft = viewport.left + viewport.width - MIN_VISIBLE_HORIZONTAL;
    const minTop = viewport.top;
    const maxTop = Math.max(viewport.top, viewport.top + viewport.height - HEADER_HEIGHT);
    const left = width === viewport.width
        ? viewport.left
        : clamp(geometry.left, minLeft, maxLeft);

    return {
        left,
        top: clamp(geometry.top, minTop, maxTop),
        width,
        height,
    };
}
