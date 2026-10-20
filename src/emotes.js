// @ts-check
/**
 * DS Comments — reaction emotes: Discord/Twitch-style picture reactions.
 *
 * The model emits a CODE in the "emoji" field of a reaction; this module maps
 * codes to image URLs through a whitelist (the model never supplies URLs — an
 * unknown code degrades to plain text in the renderer). Sources, merged in
 * order (later wins):
 *   1. Built-in pack: emotes/manifest.json — curated BetterTTV global emotes,
 *      hotlinked from their CDN; shipped with the extension, no network setup.
 *   2. User pack: a 7TV emote-set id in settings — fetched once per session
 *      (and whenever the id changes), mapped to cdn.7tv.app file URLs.
 *
 * The renderer is synchronous, so the merged manifest lives in a module-level
 * cache: refreshEmoteManifest() is awaited before a generation renders,
 * getEmoteUrl()/getEmoteCodes() read the cache without I/O.
 */

import { state, BASE_URL, trace, warn } from './core.js';

const BUILTIN_MANIFEST_URL = `${BASE_URL}/emotes/manifest.json`;
const SEVEN_TV_SET_URL = (setId) => `https://7tv.io/v3/emote-sets/${encodeURIComponent(setId)}`;
const SEVEN_TV_CDN = (emoteId) => `https://cdn.7tv.app/emote/${encodeURIComponent(emoteId)}/2x.webp`;
const FETCH_TIMEOUT_MS = 8000;

/** fetch + hard timeout + optional external abort. The timeout degrades with
 *  a plain Error (callers treat it as "pack unavailable"), while an external
 *  abort propagates its own reason (AbortError → cancelled generation). */
async function _fetchLimited(url, signal) {
    const ctrl = new AbortController();
    const onExternalAbort = () => ctrl.abort(signal.reason);
    if (signal?.aborted) throw signal.reason ?? new DOMException('Aborted', 'AbortError');
    signal?.addEventListener('abort', onExternalAbort, { once: true });
    const timer = setTimeout(() => ctrl.abort(new Error(`emotes: fetch timed out after ${FETCH_TIMEOUT_MS}ms`)), FETCH_TIMEOUT_MS);
    try {
        return await fetch(url, { signal: ctrl.signal });
    } finally {
        clearTimeout(timer);
        signal?.removeEventListener('abort', onExternalAbort);
    }
}

let _builtin = null;                       // { code: url } | null (immutable once fetched)
let _sevenTvSetId = '';                    // id the current _sevenTv cache belongs to
let _sevenTv = null;                       // { code: url } | null
let _merged = {};                          // builtin + 7TV, what the renderer reads

/** Test hook: inject manifest state without network. */
export function _setEmoteManifest({ builtin = null, sevenTv = null, sevenTvSetId = '' } = {}) {
    _builtin = builtin;
    _sevenTv = sevenTv;
    _sevenTvSetId = sevenTvSetId;
    _remerge();
}

function _remerge() {
    const map = {};
    if (_builtin) Object.assign(map, _builtin);
    if (_sevenTv) Object.assign(map, _sevenTv);
    _merged = map;
}

async function loadBuiltin(signal) {
    if (_builtin) return _builtin;
    try {
        const resp = await _fetchLimited(BUILTIN_MANIFEST_URL, signal);
        if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
        const json = await resp.json();
        const emotes = json?.emotes;
        if (!emotes || typeof emotes !== 'object') throw new Error('unexpected manifest shape');
        _builtin = Object.fromEntries(Object.entries(emotes).filter(([code, url]) =>
            typeof code === 'string' && code && typeof url === 'string' && url.startsWith('https://')));
        trace(`emotes: builtin pack loaded (${Object.keys(_builtin).length})`);
    } catch (e) {
        if (e?.name === 'AbortError') throw e;   // a cancelled generation must surface as cancelled
        warn('emotes: builtin manifest unavailable — emote reactions stay text', e);
        _builtin = {};   // same-origin file: a failure means a broken install — don't hammer
    }
    return _builtin;
}

const SEVEN_TV_RETRY_MS = 5 * 60 * 1000;   // a dead set is retried, but not per generation
let _sevenTvFailedAt = 0;

async function loadSevenTvSet(setId, signal) {
    if (_sevenTv && _sevenTvSetId === setId) return _sevenTv;
    if (_sevenTvFailedAt && Date.now() - _sevenTvFailedAt < SEVEN_TV_RETRY_MS && _sevenTvSetId === setId) return {};
    try {
        const resp = await _fetchLimited(SEVEN_TV_SET_URL(setId), signal);
        if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
        const json = await resp.json();
        const map = {};
        for (const emote of Array.isArray(json?.emotes) ? json.emotes : []) {
            if (emote?.id && emote?.name) map[emote.name] = SEVEN_TV_CDN(emote.id);
        }
        _sevenTv = map;
        _sevenTvSetId = setId;
        _sevenTvFailedAt = 0;
        trace(`emotes: 7TV set ${setId} loaded (${Object.keys(map).length})`);
    } catch (e) {
        if (e?.name === 'AbortError') throw e;   // a cancelled generation must surface as cancelled
        warn(`emotes: 7TV set ${setId} unavailable — built-in pack only (retry in 5 min)`, e);
        _sevenTv = null;
        _sevenTvSetId = setId;
        _sevenTvFailedAt = Date.now();
    }
    return _sevenTv;
}

/** Re-resolve the manifest cache from settings. Await before rendering.
 *  `signal` ties the lookups to the generation's cancel; a hard timeout keeps
 *  a hanging CDN from stalling it (network errors degrade to text reactions). */
export async function refreshEmoteManifest(signal) {
    if (state.settings.reactionEmotes !== true) return;
    await loadBuiltin(signal);
    const setId = String(state.settings.emoteSetId || '').trim();
    if (setId) await loadSevenTvSet(setId, signal);
    _remerge();
}

/** Sync lookup for the renderer — unknown codes must degrade to text. */
export function getEmoteUrl(code) {
    if (state.settings.reactionEmotes !== true) return null;
    return Object.prototype.hasOwnProperty.call(_merged, code) ? _merged[code] : null;
}

/** Codes the contract may teach the model, sorted, capped for prompt size. */
export function getEmoteCodes(cap = 48) {
    const codes = Object.keys(_merged);
    if (codes.length <= cap) return codes.sort();
    // Deterministic spread covering both ends (round keeps it monotonic and
    // duplicate-free because the stride is ≥ 1).
    const stride = codes.length / cap;
    const out = [];
    for (let i = 0; i < cap; i++) out.push(codes[Math.round(i * stride)]);
    return out.sort();
}
