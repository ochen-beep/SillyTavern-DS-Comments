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

import { state, BASE_URL, trace, warn, fetchWithTimeout } from './core.js';
import { recordEvent } from './event-log.js';

const BUILTIN_MANIFEST_URL = `${BASE_URL}/emotes/manifest.json`;
const SEVEN_TV_SET_URL = (setId) => `https://7tv.io/v3/emote-sets/${encodeURIComponent(setId)}`;
const SEVEN_TV_CDN = (emoteId) => `https://cdn.7tv.app/emote/${encodeURIComponent(emoteId)}/2x.webp`;

let _builtin = null;                       // { code: url } | null (immutable once fetched)
let _merged = {};                          // builtin + 7TV, what the renderer reads

/** Test hook: inject manifest state without network; resets SWR bookkeeping. */
export function _setEmoteManifest({ builtin = null, sevenTv = null, sevenTvSetId = '' } = {}) {
    _builtin = builtin;
    _sevenTv = sevenTv;
    _sevenTvSetId = sevenTvSetId;
    _sevenTvTs = sevenTv ? Date.now() : 0;
    _sevenTvFailCount = 0;
    _sevenTvLastAttemptAt = 0;
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
        const resp = await fetchWithTimeout(BUILTIN_MANIFEST_URL, { signal });
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
        recordEvent('log', 'event=emotes_manifest pack=builtin status=unavailable');
        _builtin = {};   // same-origin file: a failure means a broken install — don't hammer
    }
    return _builtin;
}

// 7TV set persistence + stale-while-revalidate. The reader's attention span
// after a generation is ~1 minute, so chips must be ready BEFORE the network
// is: the manifest (stable data — emote ids live for days) persists in
// localforage and serves the feed at ANY age, while freshness is checked in
// the background. A flaky CDN can then never blank a reading session that a
// previous one already warmed.
const LF_7TV_PREFIX = 'DSComments_7tvSet_';
const SEVEN_TV_STALE_MS = 24 * 60 * 60 * 1000;          // revalidate daily
// Ladder for failed freshness checks — sparse on purpose: failures never
// block the reader (cached set keeps serving), so attempts piggyback on the
// natural call points (init warmup, generations) instead of timers.
const SEVEN_TV_BACKOFF_MS = [1, 5, 15].map(m => m * 60 * 1000);
const SEVEN_TV_FETCH_TIMEOUT_MS = 20000;                // big JSON on a slow link (8s default timed out live)
const SEVEN_TV_COLD_BACKOFF_MS = SEVEN_TV_BACKOFF_MS[0];

let _sevenTvSetId = '';
let _sevenTv = null;
let _sevenTvTs = 0;                // when the current _sevenTv data was fetched
let _sevenTvFailCount = 0;         // consecutive failed freshness checks
let _sevenTvLastAttemptAt = 0;

function _lf() {
    try { return SillyTavern?.libs?.localforage ?? null; } catch { return null; }
}

async function _lfGetSevenTv(setId) {
    try { return (await _lf()?.getItem(LF_7TV_PREFIX + setId)) ?? null; } catch { return null; }
}

function _lfPutSevenTv(setId, payload) {
    try { _lf()?.setItem(LF_7TV_PREFIX + setId, payload)?.catch(() => {}); } catch { /* probe must never break callers */ }
}

function _parseSevenTvPayload(v) {
    return v && typeof v === 'object' && typeof v.ts === 'number'
        && v.map && typeof v.map === 'object' ? v : null;
}

/** Shared fetch for the cold path and background revalidation. */
async function fetchSevenTvSet(setId, signal) {
    const resp = await fetchWithTimeout(SEVEN_TV_SET_URL(setId), { signal, timeoutMs: SEVEN_TV_FETCH_TIMEOUT_MS });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const json = await resp.json();
    const map = {};
    for (const emote of Array.isArray(json?.emotes) ? json.emotes : []) {
        if (emote?.id && emote?.name) map[emote.name] = SEVEN_TV_CDN(emote.id);
    }
    return map;
}

function _adoptSevenTv(setId, map) {
    _sevenTv = map;
    _sevenTvSetId = setId;
    _sevenTvTs = Date.now();
    _lfPutSevenTv(setId, { ts: _sevenTvTs, map });
    _remerge();
}

/** Background freshness check for an already-serving cached set. Fire-and-
 *  forget: the reader is covered, so the generation that triggered this must
 *  not wait on the network. */
function _maybeRevalidate(setId) {
    const now = Date.now();
    if (now - _sevenTvTs < SEVEN_TV_STALE_MS) return;
    const backoff = SEVEN_TV_BACKOFF_MS[Math.min(_sevenTvFailCount, SEVEN_TV_BACKOFF_MS.length - 1)];
    if (now - _sevenTvLastAttemptAt < backoff) return;
    _sevenTvLastAttemptAt = now;
    fetchSevenTvSet(setId)
        .then((map) => {
            _sevenTvFailCount = 0;
            _adoptSevenTv(setId, map);
            trace(`emotes: 7TV set ${setId} revalidated (${Object.keys(map).length})`);
        })
        .catch((e) => {
            if (e?.name === 'AbortError') return;   // page teardown — nothing to back off
            _sevenTvFailCount++;
            warn(`emotes: 7TV set ${setId} revalidate failed — cached set keeps serving`, e);
            recordEvent('log', `event=emotes_manifest pack=7tv status=stale error=${e?.message || e}`);
        });
}

async function loadSevenTvSet(setId, signal) {
    if (_sevenTv && _sevenTvSetId === setId) {
        _maybeRevalidate(setId);
        return _sevenTv;
    }
    // Serve the persisted manifest at any age — chips render while the
    // background check runs.
    const cached = _parseSevenTvPayload(await _lfGetSevenTv(setId));
    if (cached && Object.keys(cached.map).length) {
        _sevenTv = cached.map;
        _sevenTvSetId = setId;
        _sevenTvTs = cached.ts;
        _remerge();
        _maybeRevalidate(setId);
        return _sevenTv;
    }
    // Cold (no persisted copy): the generation path waits for one fetch.
    const now = Date.now();
    if (_sevenTvLastAttemptAt && now - _sevenTvLastAttemptAt < SEVEN_TV_COLD_BACKOFF_MS) {
        _sevenTvSetId = setId;
        return null;
    }
    try {
        const map = await fetchSevenTvSet(setId, signal);
        _sevenTvFailCount = 0;
        _adoptSevenTv(setId, map);
        trace(`emotes: 7TV set ${setId} loaded (${Object.keys(map).length})`);
    } catch (e) {
        if (e?.name === 'AbortError') throw e;   // a cancelled generation must surface as cancelled
        _sevenTvSetId = setId;
        _sevenTvFailCount++;
        _sevenTvLastAttemptAt = Date.now();
        warn(`emotes: 7TV set ${setId} unavailable — built-in pack only (cold retry in 1 min)`, e);
        recordEvent('log', `event=emotes_manifest pack=7tv status=unavailable error=${e?.message || e}`);
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

/** Codes the contract may teach the model, sorted. The full pack is taught —
 *  prompt size grows with the user's emote set. */
export function getEmoteCodes() {
    return Object.keys(_merged).sort();
}
