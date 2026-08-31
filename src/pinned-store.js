// @ts-check
/**
 * DS Comments — Pinned-feeds persistence (noSave mode)
 *
 * Persists state.pinnedFeeds (Map chatId -> {html,msgId,swipeIdx,ts}) to
 * localforage so a noSave feed survives F5 / ST restart. Stays OUT of
 * chatMetadata — that is the whole point of noSave mode ("don't write to the
 * chat"): the persisted record lives only on this device's IndexedDB and never
 * travels with the chat (export/import, sync, etc.).
 *
 * Writes are immediate and serialized through a promise chain (see persistNow):
 * one mutation → one durable IndexedDB write, in order. There is no debounce —
 * the write rate is tiny (once per message), and debouncing made page-hide
 * flushes un-awaitable, which lost feeds on mobile tab-close. flushPinnedPersist
 * awaits the chain; clearPinnedPersist suppresses queued writes and removes the
 * key only after every in-flight write has settled.
 *
 * LRU bound (MAX_CHATS) keeps the store from growing unbounded across many
 * chats; oldest by ts are evicted on persist.
 */

import { trace, warn, error, LF_PINNED, START_SCREEN_KEY } from './core.js';
import { recordEvent } from './event-log.js';

const MAX_CHATS = 32;

/**
 * Snapshot the Map into the persisted shape, pruning to MAX_CHATS (oldest by ts
 * dropped). Returns a plain object safe for JSON / IndexedDB.
 */
function serialize(map) {
    const entries = Array.from(map.entries())
        .map(([chatId, v]) => [String(chatId), {
            html: String(v?.html ?? ''),
            msgId: String(v?.msgId ?? ''),
            swipeIdx: Number(v?.swipeIdx) || 0,
            ts: Number(v?.ts) || Date.now(),
        }])
        .sort((a, b) => b[1].ts - a[1].ts)   // newest first
        .slice(0, MAX_CHATS);                // cap
    return Object.fromEntries(entries);
}

function isPlainPinnedEntry(v) {
    return !!v && typeof v === 'object' && typeof v.html === 'string';
}

/**
 * Load persisted pinned feeds from localforage into the given Map.
 * Clears the Map first. Best-effort: a corrupt record is dropped with a warn.
  state.pinnedFeeds
 * @param {{ currentChatId?: string|null }} [opts] — to flag the active chat in the log
 */
export async function loadPinnedFeeds(map, { currentChatId = null } = {}) {
    let raw = null;
    try {
        raw = await SillyTavern.libs.localforage.getItem(LF_PINNED);
    } catch (e) {
        warn('loadPinnedFeeds: localforage read failed:', e);
        return;
    }
    if (!raw || typeof raw !== 'object') {
        trace('loadPinnedFeeds: nothing persisted (cold start or first run)');
        return;
    }

    map.clear();
    const dropped = [];
    for (const [chatId, v] of Object.entries(raw)) {
        if (!isPlainPinnedEntry(v)) { dropped.push(chatId); continue; }
        if (!chatId || chatId === 'null') {
            dropped.push(`${chatId} (invalid chatId)`);
            continue;
        }
        // Older builds accidentally stringified the missing start-screen chatId.
        // Preserve that intentional feed by migrating it to the stable key. If a
        // proper key already exists, keep whichever entry is newer.
        const targetKey = chatId === 'undefined' ? START_SCREEN_KEY : String(chatId);
        const entry = {
            html: String(v.html),
            msgId: String(v.msgId ?? ''),
            swipeIdx: Number(v.swipeIdx) || 0,
            ts: Number(v.ts) || Date.now(),
        };
        const existing = map.get(targetKey);
        if (!existing || entry.ts > existing.ts) map.set(targetKey, entry);
    }
    if (dropped.length) warn(`loadPinnedFeeds: dropped ${dropped.length} corrupt/legacy entry(s): ${dropped.join(', ')}`);

    // Re-prune in case the persisted record exceeds the cap (cap lowered, an
    // older build wrote more, etc.). Cheap: only runs when over the limit.
    let prunedOnLoad = [];
    if (map.size > MAX_CHATS) {
        const sorted = Array.from(map.entries()).sort((a, b) => b[1].ts - a[1].ts);
        prunedOnLoad = sorted.slice(MAX_CHATS).map(([k]) => k);
        map.clear();
        for (const [k, v] of sorted.slice(0, MAX_CHATS)) map.set(k, v);
        warn(`loadPinnedFeeds: persisted record exceeded cap, pruned ${prunedOnLoad.length}: ${prunedOnLoad.join(', ')}`);
    }

    // Per-chat trace so a F5-survival issue (wrong chat, stale ts) is visible
    // without DevTools. The active chat is flagged so the tester can confirm
    // the restored feed matches the chat SillyTavern actually opened.
    const cur = String(currentChatId || START_SCREEN_KEY);
    for (const [chatId, v] of map.entries()) {
        const ageS = Math.max(0, Math.round((Date.now() - (Number(v.ts) || Date.now())) / 1000));
        const active = chatId === cur ? ' *active*' : '';
        trace(`loadPinnedFeeds: chat ${chatId} <- #${v.msgId}[${v.swipeIdx}] age=${ageS}s ${v.html.length}chars${active}`);
    }
    trace(`loadPinnedFeeds: restored ${map.size} pinned feed(s)${cur ? ` (current=${cur}, hit=${map.has(cur) ? 'yes' : 'no'})` : ''}`);
    recordEvent('log', `loadPinnedFeeds: restored ${map.size}${cur ? ` (current=${cur}, hit=${map.has(cur) ? 'yes' : 'no'})` : ''}${dropped.length ? ` dropped=${dropped.length}` : ''}`);
}

// Latest Map reference is kept in the module closure so the persistence chain
// is independent of how callers schedule writes. state.pinnedFeeds is a stable
// reference mutated in place, so this is always current at fire time.
let _mapRef = null;

async function _doPersist() {
    if (!_mapRef) return;
    const before = _mapRef.size;
    let payload;
    try {
        payload = serialize(_mapRef);
    } catch (e) {
        error('pinnedFeeds serialize failed:', e);
        return;
    }
    const after = Object.keys(payload).length;
    const pruned = before - after;
    const totalChars = Object.values(payload).reduce((a, v) => a + (v?.html?.length || 0), 0);
    try {
        await SillyTavern.libs.localforage.setItem(LF_PINNED, payload);
        // Trace both the scheduled-fire and the page-hide flush path: whoever
        // triggers _doPersist, this line confirms the write actually landed.
        const line = `persistPinnedFeeds: wrote ${after} feed(s)${pruned > 0 ? ` (pruned ${pruned} oldest by LRU)` : ''}, ${totalChars} chars total`;
        trace(line);
        recordEvent('log', line);
    } catch (e) {
        error('pinnedFeeds persistence failed:', e);
        recordEvent('error', `persistPinnedFeeds failed: ${e?.message || e}`);
    }
}

// Writes are IMMEDIATE and serialized (one mutation → one write; the load
// is tiny — a handful of chats once per message). Debouncing is deliberately
// absent: a debounce made page-hide flushes un-awaitable — on mobile an
// IndexedDB transaction abandoned mid-flight on tab close loses the feed. The
// chain also gives clearPinnedPersist a hard guarantee: after it resolves, no
// queued/in-flight write can recreate the removed key.
let _writeChain = Promise.resolve();
function persistNow() {
    const job = _writeChain.then(_doPersist).catch(() => {});
    _writeChain = job;
    return job;
}

/**
 * Persist the current Map to localforage now (serialized with any pending
 * write). Call after every storeFeed/clearFeed mutation in noSave mode.
 * @returns {Promise<void>} resolves when this write has landed (or failed silently).
 */
export function schedulePinnedPersist(map) {
    _mapRef = map;
    return persistNow();
}

/** Wait for all accumulated writes (page-hide / onClean). */
export function flushPinnedPersist() {
    return _writeChain;
}

/** Remove the persisted pinned-feeds record entirely. */
export async function clearPinnedPersist() {
    // Null the ref FIRST: writes still queued in the chain see no Map and
    // no-op, so nothing scheduled before the clear can resurrect the key.
    _mapRef = null;
    await _writeChain;
    try {
        await SillyTavern.libs.localforage.removeItem(LF_PINNED);
        trace('clearPinnedPersist: removed pinned-feeds record');
        recordEvent('log', 'clearPinnedPersist: removed');
    } catch (e) {
        warn('clearPinnedPersist failed:', e);
    }
}

// Test-only exports (not part of the public surface).
export const _MAX_CHATS = MAX_CHATS;

/**
 * Reset the module-level Map reference. Test-only: in production the Map is a
 * stable singleton for the extension's whole lifetime, but unit tests share one
 * module instance across cases and need to drop the leaked reference between
 * them so a flush in test N can't observe a schedule from test N-1.
 */
export function _resetPinnedState() {
    _mapRef = null;
}
