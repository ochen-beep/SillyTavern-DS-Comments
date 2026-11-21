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
    _sevenTvRefreshedFor = '';
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

// 7TV set persistence + stale-while-revalidate, one refresh per session. The
// reader's attention span after a generation is ~1 minute, so chips must be
// ready BEFORE the network is: the manifest (stable data) persists in
// localforage and serves the feed at ANY age, while the first touch of each
// set id per page load fires ONE background freshness check — edits made on
// 7tv.io land on the next page load, and a flaky CDN can never blank a
// reading session that a previous one already warmed.
const LF_7TV_PREFIX = 'DSComments_7tvSet_';
const SEVEN_TV_FETCH_TIMEOUT_MS = 20000;                // big JSON on a slow link (8s default timed out live)
// Cold-fetch guard: with no persisted copy a hung CDN would add its full
// timeout to every generation — one attempt per minute caps that.
const SEVEN_TV_COLD_RETRY_MS = 60 * 1000;

let _sevenTvSetId = '';
let _sevenTv = null;
let _sevenTvRefreshedFor = '';     // setId whose persisted copy had its one background refresh
let _sevenTvLastAttemptAt = 0;     // cold-fetch guard

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

/** Shared fetch for the cold path and background revalidation. The top-level
 *  `name` is the per-set alias (data.name is the canonical emote name) — the
 *  alias is the code that renders in THIS set, so it is the one to map. */
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
    _sevenTvRefreshedFor = setId;   // fresh from the network — no background check owed
    _lfPutSevenTv(setId, { ts: Date.now(), map });
    _remerge();
}

/** The one background freshness check per session for an already-serving
 *  cached set. Fire-and-forget: the reader is covered, so the generation that
 *  triggered this must not wait on the network; a failure just waits for the
 *  next page load. */
function _maybeRefreshSevenTv(setId) {
    if (_sevenTvRefreshedFor === setId) return;
    _sevenTvRefreshedFor = setId;
    fetchSevenTvSet(setId)
        .then((map) => {
            _adoptSevenTv(setId, map);
            trace(`emotes: 7TV set ${setId} refreshed (${Object.keys(map).length})`);
        })
        .catch((e) => {
            if (e?.name === 'AbortError') return;   // page teardown — nothing to log
            warn(`emotes: 7TV set ${setId} refresh failed — cached set keeps serving`, e);
            recordEvent('log', `event=emotes_manifest pack=7tv status=stale error=${e?.message || e}`);
        });
}

async function loadSevenTvSet(setId, signal) {
    if (_sevenTv && _sevenTvSetId === setId) {
        _maybeRefreshSevenTv(setId);
        return _sevenTv;
    }
    // Serve the persisted manifest at any age — chips render while the
    // background check runs.
    const cached = _parseSevenTvPayload(await _lfGetSevenTv(setId));
    if (cached && Object.keys(cached.map).length) {
        _sevenTv = cached.map;
        _sevenTvSetId = setId;
        _remerge();
        _maybeRefreshSevenTv(setId);
        return _sevenTv;
    }
    // Cold (no persisted copy): the generation path waits for one fetch.
    const now = Date.now();
    if (_sevenTvLastAttemptAt && now - _sevenTvLastAttemptAt < SEVEN_TV_COLD_RETRY_MS) {
        _sevenTvSetId = setId;
        return null;
    }
    try {
        const map = await fetchSevenTvSet(setId, signal);
        _adoptSevenTv(setId, map);
        trace(`emotes: 7TV set ${setId} loaded (${Object.keys(map).length})`);
    } catch (e) {
        if (e?.name === 'AbortError') throw e;   // a cancelled generation must surface as cancelled
        _sevenTvSetId = setId;
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

// The user's set can hold up to 1000 uploads. A famous-name floor is stable
// across generations; the REST of the set contributes a rotating stride-slice
// (re-rolled per generation) so consecutive feeds see different corners of a
// big set — a fixed famous-only palette once made every feed converge on the
// same handful of names.
const SET_FAMOUS_MAX = 8;
const SET_ROTATE_MAX = 12;
export const SET_TEACH_DICT = new Set([
    'KEKW', 'GIGACHAD', 'catJAM', 'catJam', 'SUSSY', 'ICANT', 'popCat', 'NOWAYING',
    'TheVoices', 'MONKE', 'RAGEY', 'HUH', 'WHAT', 'catKISS', 'o7',
    'BLYAT', 'BASED',
    'Clueless', 'Sadge', 'PepeLaugh', 'peepoGiggle', 'peepoLove', 'Pepega',
    'monkaW', 'Kreygasm', 'PauseChamp', 'PagMan', 'Awareness', 'HYPERS',
    'Bedge', 'notice', 'WideHardo', 'Pog', 'PogChamp', 'EZClap',
]);

/** Codes the contract may teach: the whole built-in pack (curated here —
 *  quality by construction), the set's famous names as a stable floor, and a
 *  rotating stride-slice over the rest of the set. The rotating slice LEADS
 *  the array — the contract's example copies its first codes, and leading
 *  with the per-generation slice is what makes the model actually use it
 *  instead of the famous anchors. `seed` pins the roll for tests; every
 *  returned code is present in the merged pack — dead codes are never
 *  taught. */
export function getEmoteCodes(seed = Date.now()) {
    const builtin = _builtin ? Object.keys(_builtin) : [];
    const setCodes = _sevenTv ? Object.keys(_sevenTv) : [];
    const famous = setCodes.filter((c) => SET_TEACH_DICT.has(c)).sort().slice(0, SET_FAMOUS_MAX);
    const rest = setCodes.filter((c) => !SET_TEACH_DICT.has(c));
    const rotated = [];
    if (rest.length) {
        const take = Math.min(SET_ROTATE_MAX, rest.length);
        const stride = rest.length / take;
        let idx = seed % rest.length;
        for (let i = 0; i < take; i++) {
            rotated.push(rest[Math.floor(idx) % rest.length]);
            idx += stride;
        }
    }
    return [...new Set([...rotated, ...famous, ...builtin])];
}
