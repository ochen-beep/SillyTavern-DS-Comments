// @ts-check
/**
 * DS Comments — Post image attachment (multimodality)
 *
 * Collects the images attached to a chat post (swipe-aware, gallery-mode aware),
 * decides whether the current generation source is likely to accept them, and
 * converts them into OpenAI `image_url` content parts (data URLs, downscaled).
 *
 * Scope: the anchor post only — history stays text-only, so the image cost of
 * a generation is bounded no matter the context depth. Everything here is a
 * no-op unless settings.includeImages is 'auto'/'always' AND the post actually
 * carries images; with no images the prompt stays byte-identical (content
 * remains a plain string, the fingerprint gains no new fields).
 */
import { getCtx, trace, warn, fetchWithTimeout } from './core.js';
import { hashFingerprint } from './lorebooks.js';   // FNV — same hash the generation fingerprint uses

export const MAX_IMAGES_PER_POST = 4;
// Fits every provider's resize threshold (Anthropic 1568px, OpenAI tiles,
// Gemini 768px tiles) without triggering their own downscale.
export const MAX_IMAGE_SIDE = 1568;
const JPEG_QUALITY = 0.85;

/**
 * Substring heuristic over the model id/name, mirroring the spirit of ST's
 * isImageInliningSupported list (openai.js) without depending on its
 * main-API settings. Used only in 'auto' mode; 'always' bypasses it.
 */
const VISION_MODEL_RE = /gpt-4o|gpt-4\.1|gpt-4-turbo|gpt-4-vision|gpt-5|gpt-6|chatgpt-4o|o1|o3|o4-mini|claude-3|claude-4|claude-opus|claude-sonnet|claude-haiku|claude-fable|gemini|pixtral|qwen[\w.-]*vl|llama[\w.-]*4|glm-[\w.]*v|internvl|minicpm-v|llava|vision/i;

export function isProbablyVisionModel(model) {
    return VISION_MODEL_RE.test(String(model ?? ''));
}

/**
 * Collect image attachments of a post for a given swipe.
 * Swipe-level extra (ST clones msg.extra into swipe_info[i].extra on swipe)
 * wins over the message-level one; gallery display mode yields only the
 * currently shown image. Non-image media and missing urls are skipped.
 * @returns {{ url: string, title: string }[]} at most MAX_IMAGES_PER_POST
 */
export function collectPostImages(msg, swipeIdx) {
    if (!msg || typeof msg !== 'object') return [];
    const idx = Number.isInteger(Number(swipeIdx)) ? Number(swipeIdx) : 0;
    const swipeExtra = Array.isArray(msg.swipe_info) ? msg.swipe_info[idx]?.extra : null;
    const extra = swipeExtra && typeof swipeExtra === 'object' && Array.isArray(swipeExtra.media)
        ? swipeExtra
        : msg.extra;
    const media = Array.isArray(extra?.media) ? extra.media : [];
    if (!media.length) return [];
    const isImage = m => m && typeof m.url === 'string' && !!m.url && (!m.type || m.type === 'image');

    if (extra?.media_display === 'gallery') {
        const rawIdx = Number.isInteger(extra?.media_index) ? extra.media_index : 0;
        const clamped = Math.min(Math.max(rawIdx, 0), media.length - 1);
        const picked = media[clamped];
        return isImage(picked) ? [{ url: picked.url, title: picked.title || '' }] : [];
    }
    return media.filter(isImage).slice(0, MAX_IMAGES_PER_POST)
        .map(m => ({ url: m.url, title: m.title || '' }));
}

/**
 * Stable identity of an attachment for the generation fingerprint. External
 * URLs hash as-is; data URLs (potentially megabytes) hash as mime + length +
 * head/tail slice — enough to detect a replaced image without hashing MBs.
 */
export function mediaIdentity(media) {
    const url = String(media?.url ?? '');
    if (url.startsWith('data:')) {
        const mime = url.slice(5, url.indexOf(';'));
        return `data:${mime};len=${url.length};${url.slice(0, 96)}~${url.slice(-64)}`;
    }
    return url;
}

/**
 * Content hash of the images that WOULD be attached for this anchor. '' when
 * nothing would be attached — keeps the fingerprint byte-identical to the
 * pre-feature one for image-less posts and for includeImages='off'.
 */
export function computeImagesHash(images) {
    if (!Array.isArray(images) || !images.length) return '';
    return hashFingerprint(JSON.stringify(images.map(mediaIdentity)));
}

/**
 * Does the CM profile's api route to chat completions? CM profile.api values
 * are CONNECT_API_MAP keys ('openai', 'custom', 'textgenerationwebui', ...) —
 * 'custom' (OpenAI-compatible) maps to selected 'openai' too, so a plain
 * `api === 'openai'` check would wrongly block it. Resolution goes through
 * the live map; the fallback allowlist covers the known chat-completion keys.
 */
function isChatCompletionProfileApi(api) {
    if (!api) return true;   // unknown → don't block
    try {
        const map = getCtx()?.CONNECT_API_MAP;
        if (map && map[api]) return map[api].selected === 'openai';
    } catch { /* fall through to the static list */ }
    return api === 'openai' || api === 'custom';
}

/**
 * Whether images should be attached for the current source.
 * 'always' → yes; 'off' → no; 'auto' → vision-model heuristic over the
 * profile/custom model name. Text-completion CM profiles cannot carry
 * chat-completion content arrays at all, so the profile-api guard blocks
 * every mode, including 'always'.
 * @param {object} settings state.settings
 * @param {{api?: string, model?: string}|null} profile CM profile or a plain {api, model} shape
 */
export function shouldAttachImages(settings, profile) {
    const mode = String(settings?.includeImages ?? 'off');
    if (mode === 'off') return false;
    if (settings?.apiSource === 'profile') {
        if (!isChatCompletionProfileApi(profile?.api)) return false;
        if (mode === 'always') return true;
        return isProbablyVisionModel(profile?.model ?? '');
    }
    // custom endpoint: OpenAI-compatible by contract. 'always' → yes; 'auto'
    // trusts the model id when one is configured, stays conservative without.
    if (mode === 'always') return true;
    return isProbablyVisionModel(settings?.customModel ?? '');
}

/**
 * Image-generation extensions (sillyimages etc.) embed pictures as inline
 * `<img src="...">` tags in the message TEXT — they never reach extra.media.
 * Scan the raw text for them. Bounded by MAX_IMAGES_PER_POST.
 */
export function collectInlineImageUrls(rawText) {
    if (typeof rawText !== 'string' || !rawText) return [];
    const urls = [];
    for (const m of rawText.matchAll(/<img\b[^>]*?\bsrc\s*=\s*["']([^"']+)["'][^>]*>/gi)) {
        const url = m[1].trim();
        if (url) urls.push(url);
        if (urls.length >= MAX_IMAGES_PER_POST) break;
    }
    return urls;
}

/**
 * Why shouldAttachImages said no — for the diagnostic event log only.
 */
function attachSkipReason(settings, profile) {
    const mode = String(settings?.includeImages ?? 'off');
    if (mode === 'off') return 'off';
    if (settings?.apiSource === 'profile' && !isChatCompletionProfileApi(profile?.api)) {
        return 'api_not_chat_completions';
    }
    return 'auto_not_vision_model';
}

/**
 * Resolve the image plan for a generation: which images the anchor post
 * carries and whether to attach them. Synchronous and cheap — safe to call
 * for fingerprint computation on every render pre-check.
 * Sources: extra.media (native attachments) + inline <img> tags in the raw
 * swipe text (sillyimages-style embeds), deduped by URL, capped at the max.
 * @returns {{ images: {url:string,title:string}[], attach: boolean, hash: string, reason: string }}
 */
export function planPostImages(msg, swipeIdx, settings, profile) {
    const images = collectPostImages(msg, swipeIdx);
    const idx = Number.isInteger(Number(swipeIdx)) ? Number(swipeIdx) : 0;
    const rawText = Array.isArray(msg?.swipes) && msg.swipes[idx] !== undefined
        ? String(msg.swipes[idx])
        : String(msg?.mes ?? '');
    const seen = new Set(images.map(i => i.url));
    for (const url of collectInlineImageUrls(rawText)) {
        if (seen.has(url) || images.length >= MAX_IMAGES_PER_POST) continue;
        seen.add(url);
        images.push({ url, title: '' });
    }
    if (!images.length) return { images: [], attach: false, hash: '', reason: '' };
    const attach = shouldAttachImages(settings, profile);
    if (!attach) return { images, attach: false, hash: '', reason: attachSkipReason(settings, profile) };
    return {
        images,
        attach,
        hash: computeImagesHash(images),
        reason: '',
    };
}

// ── Loading / conversion (browser-only; guarded for the node test host) ──

function blobToDataUrl(blob) {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result));
        reader.onerror = () => reject(reader.error);
        reader.readAsDataURL(blob);
    });
}

/**
 * Downscale a data URL to fit MAX_IMAGE_SIDE and re-encode (JPEG, or PNG when
 * the source carries alpha). No-op in non-DOM hosts (tests) and on any canvas
 * failure — the original data URL is returned instead of failing the attach.
 */
export async function downscaleDataUrl(dataUrl) {
    try {
        if (typeof Image === 'undefined' || typeof document?.createElement !== 'function') return dataUrl;
        const img = await new Promise((resolve, reject) => {
            const el = new Image();
            el.onload = () => resolve(el);
            el.onerror = reject;
            el.src = dataUrl;
        });
        const w = img.naturalWidth || img.width;
        const h = img.naturalHeight || img.height;
        if (!w || !h) return dataUrl;
        const mime = dataUrl.slice(5, dataUrl.indexOf(';'));
        const keepPng = mime === 'image/png' || mime === 'image/gif';
        if (w <= MAX_IMAGE_SIDE && h <= MAX_IMAGE_SIDE && (keepPng || mime === 'image/jpeg')) {
            return dataUrl;   // already within limits and well-encoded
        }
        const canvas = document.createElement('canvas');
        if (typeof canvas.getContext !== 'function') return dataUrl;
        const scale = Math.min(1, MAX_IMAGE_SIDE / Math.max(w, h));
        canvas.width = Math.max(1, Math.round(w * scale));
        canvas.height = Math.max(1, Math.round(h * scale));
        const ctx2d = canvas.getContext('2d');
        if (!ctx2d) return dataUrl;
        ctx2d.drawImage(img, 0, 0, canvas.width, canvas.height);
        return keepPng ? canvas.toDataURL('image/png') : canvas.toDataURL('image/jpeg', JPEG_QUALITY);
    } catch (e) {
        warn('downscaleDataUrl: using original image', e);
        return dataUrl;
    }
}

/**
 * Load one attachment into an OpenAI image part. data URLs skip the network;
 * external URLs are fetched (same-origin /user/files/... is the common case;
 * CORS failures skip the image silently, mirroring ST's addImage behaviour).
 * The fetch carries the generation's abort signal AND a hard timeout — a
 * hanging image host must not stall the images phase. detail is always
 * 'low' — see core.js defaultSettings.
 * @returns {Promise<{type:'image_url', image_url:{url:string, detail:string}}|null>}
 */
export async function loadImagePart(image, signal = null) {
    try {
        let dataUrl = String(image?.url ?? '');
        if (!dataUrl) return null;
        if (!dataUrl.startsWith('data:')) {
            const response = await fetchWithTimeout(dataUrl, { method: 'GET', cache: 'force-cache', signal });
            if (!response.ok) throw new Error(`fetch failed: ${response.status}`);
            dataUrl = await blobToDataUrl(await response.blob());
        }
        dataUrl = await downscaleDataUrl(dataUrl);
        return { type: 'image_url', image_url: { url: dataUrl, detail: 'low' } };
    } catch (e) {
        warn(`loadImagePart: skipped (${image?.url?.slice?.(0, 80) ?? '?'})`, e);
        return null;
    }
}

/**
 * Load all planned images, skipping failures. Never throws — a post whose
 * images all failed still gets a text-only generation.
 */
export async function loadImageParts(images, signal = null) {
    const results = await Promise.allSettled(images.map(m => loadImagePart(m, signal)));
    const parts = results.map(r => (r.status === 'fulfilled' ? r.value : null)).filter(Boolean);
    trace(`loadImageParts: ${parts.length}/${images.length} attached`);
    return parts;
}
