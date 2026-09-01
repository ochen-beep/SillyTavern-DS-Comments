// @ts-check
/**
 * DS Comments — Feed file store (server-side JSON per chat)
 *
 * Save-mode commentary lives in ONE JSON file per chat on the SillyTavern
 * server, not in chatMetadata: `data/<user>/user/files/dsc_<key>.json`.
 * Writes go through the official user-files endpoint (`POST /api/files/upload`,
 * base64, atomic on the server — same route ST itself uses for chat
 * attachments), reads are a plain `GET /user/files/<name>` from the static
 * user router. The chat file stays lean: every save no longer re-uploads the
 * whole chat with our kilobytes inside it, and any browser logged into the
 * same ST user profile sees the same comments.
 *
 * Entry key = the swipe slot's `send_date` (ISO with milliseconds), which ST
 * itself maintains as per-swipe identity: it is set per generation, stored in
 * every swipe_info slot, restored by syncSwipeToMes, refreshed on message
 * duplication, and never shifts when messages/swipes are spliced. Structural
 * edits (delete message, delete swipe) kill their keys naturally — no index
 * remapping, no anchors, no reconciliation.
 *
 * chatMetadata keeps a small identity object: `guid` is stable across chat file
 * renames, while fork markers record one-time branch isolation. ST's swipe
 * cloning touches msg.extra/swipe_info but does not interpret these fields.
 *
 * In-memory mirror: loaded once per CHAT_CHANGED, all later reads are
 * synchronous (the restore paths in cache.js must stay sync after their
 * pre-await fast path). Mirror is the single source of truth for the session;
 * every mutation schedules an immediate full-file upload through a promise
 * chain (pinned-store pattern: one mutation → one durable write, in order).
 */

import { state, getCtx, trace, warn, error, tr, META_KEY, observePersistence, registerFeedStoreSnapshot, registerFeedStoreDiagnostics } from './core.js';
import { recordEvent } from './event-log.js';
import { uploadUserFile, deleteUserFile } from './user-files.js';

const FILE_PREFIX = 'dsc_';
const FILE_EXT = '.json';
const STORE_VERSION = 2;
const FORK_HANDLED = 'forkHandled';
const FORK_PARENT_GUID = 'forkParentGuid';
const FORK_CHAT_ID = 'forkChatId';

// Mirror state. `_mirror` is null until a chat is loaded (module import is
// side-effect free — the Node tests import cache.js without any network).
let _mirror = null;            // { entries: { [sendDate]: payload } }
let _loadedKey = null;         // file key the mirror was loaded for
let _loadedChatId = null;
let _loadSequence = 0;
let _writeChain = Promise.resolve();
const _storageDiag = {
    lastOperation: null,
    loaded: false,
    result: null,
    file: null,
    entryCount: 0,
    gcDropped: 0,
    at: null,
    error: null,
};

function setStorageDiag(operation, patch = {}) {
    Object.assign(_storageDiag, {
        lastOperation: operation,
        at: new Date().toISOString(),
        ...patch,
    });
}

export function feedStoreDiagnostics() {
    return { ..._storageDiag };
}


// ── Fingerprint (same formula as the v1 cache — lifted entries keep values) ──

export function hashFingerprint(text) {
    const str = String(text ?? '');
    let hash = 5381;
    for (let i = 0; i < str.length; i++) {
        hash = ((hash << 5) + hash) ^ str.charCodeAt(i);
    }
    return `v2:${(hash >>> 0).toString(16)}:${str.length}`;
}

// ── Chat identity → file key ──

function makeGuid() {
    return 'g' + Math.random().toString(16).slice(2, 12).padEnd(10, '0');
}

/**
 * Stable chat identity. Primary: the guid scalar in chatMetadata[META_KEY]
 * (survives chat renames — chatId is the file name and changes with it).
 * Fallback: a short hash of characterId/groupId + chatId, used BEFORE the guid
 * is persisted; on load with a fresh guid the fallback file is probed too
 * (two tabs can mint different guids — whichever file exists wins the merge).
 */
export function hashKeyOf(ctx = getCtx()) {
    const src = `${ctx?.characterId ?? ''}|${ctx?.groupId ?? ''}|${ctx?.chatId ?? ''}`;
    let hash = 5381;
    const s = String(src);
    for (let i = 0; i < s.length; i++) hash = ((hash << 5) + hash) ^ s.charCodeAt(i);
    return FILE_PREFIX + (hash >>> 0).toString(36) + FILE_EXT;
}

export function chatFileKey(ctx = getCtx()) {
    const guid = ctx?.chatMetadata?.[META_KEY]?.guid;
    if (typeof guid === 'string' && guid) return FILE_PREFIX + guid + FILE_EXT;
    return hashKeyOf(ctx);
}

/**
 * Read or mint the guid scalar. Returns { guid, minted } — minting does NOT
 * persist. Fork handling deliberately uses a separate helper so an inherited
 * GUID is never mistaken for the branch's own identity.
 */
function resolveGuid(ctx) {
    const meta = ctx?.chatMetadata;
    if (!meta || typeof meta !== 'object') return { guid: null, minted: false };
    let store = meta[META_KEY];
    if (!store || typeof store !== 'object') { store = {}; meta[META_KEY] = store; }
    const existing = store.guid;
    if (typeof existing === 'string' && existing) return { guid: existing, minted: false };
    const guid = makeGuid();
    store.guid = guid;
    return { guid, minted: true };
}

function feedMeta(ctx) {
    const meta = ctx?.chatMetadata?.[META_KEY];
    return meta && typeof meta === 'object' ? meta : null;
}

function isForkCandidate(ctx) {
    const chatMeta = ctx?.chatMetadata;
    const meta = feedMeta(ctx);
    if (!ctx?.chatId || !chatMeta?.main_chat) return false;
    if (!meta?.[FORK_HANDLED]) return true;
    const markedChatId = String(meta[FORK_CHAT_ID] ?? '');
    if (markedChatId === String(ctx.chatId)) return false;
    // A branch copies the marker and points main_chat at the chat that was open
    // when it was created. A rename keeps main_chat pointing at the root parent,
    // so this comparison remains false for renames even after a page reload.
    return String(chatMeta.main_chat) === markedChatId;
}

function markForkHandled(ctx, guid, parentGuid = null) {
    const chatMeta = ctx?.chatMetadata;
    if (!chatMeta || typeof chatMeta !== 'object') return false;
    let meta = feedMeta(ctx);
    if (!meta) meta = chatMeta[META_KEY] = {};
    meta.guid = guid;
    meta[FORK_HANDLED] = true;
    meta[FORK_CHAT_ID] = String(ctx?.chatId ?? '');
    if (parentGuid) meta[FORK_PARENT_GUID] = parentGuid;
    else delete meta[FORK_PARENT_GUID];
    return true;
}

function persistChatMetadata(ctx) {
    return observePersistence(
        ctx?.saveMetadata?.(),
        'metadata-flush',
        tr('Failed to save the chat identifier for the comments cache.', 'dscomments.toast.guidfail'),
    );
}

function chatIdFromFileName(value) {
    return String(value ?? '').replace(/\.jsonl$/i, '');
}

export function noteChatRenamed({ oldFileName, newFileName } = {}) {
    const ctx = getCtx();
    const meta = feedMeta(ctx);
    if (!meta?.[FORK_HANDLED]) return false;
    const oldId = chatIdFromFileName(oldFileName);
    const newId = chatIdFromFileName(newFileName);
    if (!oldId || !newId || String(meta[FORK_CHAT_ID]) !== oldId) return false;
    meta[FORK_CHAT_ID] = newId;
    persistChatMetadata(ctx);
    recordEvent('log', `event=feed_fork result=rename old=${oldId} new=${newId} file=${chatFileKey(ctx)}`);
    return true;
}

function liveSlotKeys(ctx) {
    const live = new Set();
    for (const msg of Array.isArray(ctx?.chat) ? ctx.chat : []) {
        if (!msg || typeof msg !== 'object') continue;
        const nSwipes = Array.isArray(msg.swipe_info) ? msg.swipe_info.length
            : Array.isArray(msg.swipes) ? msg.swipes.length : 1;
        for (let i = 0; i < nSwipes; i++) {
            const key = slotKeyOf(msg, i);
            if (key) live.add(key);
        }
    }
    return live;
}

// ── HTTP (official user-files surface; write/delete via src/user-files.js) ──

async function readFile(ctx, name) {
    const res = await fetch(`/user/files/${encodeURIComponent(name)}`, {
        method: 'GET',
        cache: 'no-store',
    });
    if (res.status === 404) return null;         // no file yet = empty store
    if (!res.ok) throw new Error(`read failed: ${res.status}`);
    const text = await res.text();
    if (!text) return null;
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === 'object' && parsed.entries && typeof parsed.entries === 'object'
        ? parsed
        : null;
}

function btoaNodeSafe(str) {
    if (typeof btoa === 'function') return btoa(str);
    return Buffer.from(str, 'binary').toString('base64');
}

// btoa chokes on non-Latin1 (Russian HTML); encode UTF-8 bytes first.
const textToBase64 = (text) => btoaNodeSafe(unescape(encodeURIComponent(String(text))));

// ── Mirror ──

function emptyMirror() {
    return { entries: {} };
}

/**
 * Load the per-chat file into the mirror (CHAT_CHANGED). One GET (plus a
 * fallback-key probe while the guid is fresh), then GC + v1 migration. Safe to
 * call repeatedly; a failed load leaves an empty mirror — the session works
 * in-memory and the next write re-creates the file.
 */
export async function loadFeedStore() {
    const ctx = getCtx();
    const sequence = ++_loadSequence;
    if (!ctx?.chatId) {
        _mirror = null;
        _loadedKey = null;
        _loadedChatId = null;
        setStorageDiag('load', { loaded: false, result: 'no-chat', file: null, entryCount: 0, gcDropped: 0, error: null });
        return;
    }

    const candidateMeta = feedMeta(ctx);
    const inheritedGuid = typeof candidateMeta?.guid === 'string' && candidateMeta.guid ? candidateMeta.guid : null;
    const forkCandidate = isForkCandidate(ctx);
    if (forkCandidate) {
        await flushFeedStoreWrites();
        if (sequence !== _loadSequence) return;
        const newGuid = makeGuid();
        const newKey = FILE_PREFIX + newGuid + FILE_EXT;
        const parentKey = inheritedGuid ? FILE_PREFIX + inheritedGuid + FILE_EXT : null;
        let parentDoc = null;
        let parentReadOk = true;
        try {
            if (parentKey) parentDoc = await readFile(ctx, parentKey);
        } catch (e) {
            parentReadOk = false;
            warn('loadFeedStore: fork parent read failed:', e?.message || e);
            recordEvent('error', `event=feed_fork result=error chat=${ctx.chatId} source=${parentKey || 'none'} error=${e?.message || e}`);
        }
        if (sequence !== _loadSequence) return;
        if (!parentReadOk) {
            _mirror = { entries: {} };
            _loadedKey = null;
            _loadedChatId = ctx.chatId;
            setStorageDiag('load', { loaded: false, result: 'error', file: parentKey, entryCount: 0, gcDropped: 0, error: 'fork-parent-read' });
            return;
        }
        const live = liveSlotKeys(ctx);
        const entries = {};
        for (const [key, entry] of Object.entries(parentDoc?.entries ?? {})) {
            if (live.has(key) && validPayload(entry)) entries[key] = { ...entry };
        }
        _mirror = { entries };
        _loadedKey = newKey;
        _loadedChatId = ctx.chatId;
        if (Object.keys(entries).length) {
            const persisted = await schedulePersist({ ctx, key: newKey, mirror: _mirror });
            if (!persisted) {
                recordEvent('error', `event=feed_fork result=error chat=${ctx.chatId} source=${parentKey || 'none'} target=${newKey} error=target-write`);
                _mirror = emptyMirror();
                _loadedKey = null;
                return;
            }
        }
        markForkHandled(ctx, newGuid, inheritedGuid);
        await persistChatMetadata(ctx);
        if (sequence !== _loadSequence) return;
        recordEvent('log', `event=feed_fork result=detected chat=${ctx.chatId} source=${parentKey || 'none'} target=${newKey} inheritedEntries=${Object.keys(entries).length}`);
        if (!Object.keys(entries).length) recordEvent('log', `event=feed_fork result=empty chat=${ctx.chatId} target=${newKey}`);
        if (sequence !== _loadSequence) return;
        const pruned = pruneOrphanedEntries(ctx);
        const entryCount = Object.keys(_mirror.entries).length;
        setStorageDiag('load', { loaded: true, result: parentDoc ? 'forked' : 'missing', file: newKey, entryCount, gcDropped: pruned, error: null });
        recordEvent('log', `event=feed_load chat=${ctx.chatId} file=${newKey} result=${_storageDiag.result} entries=${entryCount} gc=${pruned}`);
        if (pruned > 0) await schedulePersist({ ctx, key: newKey, mirror: _mirror });
        return;
    }

    const { minted } = resolveGuid(ctx);
    const mainKey = chatFileKey(ctx);
    // Fallback-keyed file probed while the guid is fresh (two tabs may mint
    // different guids — whichever file exists wins the merge).
    const fallbackKey = hashKeyOf(ctx);
    setStorageDiag('load', { loaded: false, result: 'started', file: mainKey, entryCount: 0, gcDropped: 0, error: null });
    let doc = null;
    let fallbackDoc = null;
    try {
        doc = await readFile(ctx, mainKey);
        if (!doc && minted) {
            fallbackDoc = await readFile(ctx, fallbackKey);
            doc = fallbackDoc;
        }
    } catch (e) {
        warn('loadFeedStore: read failed — starting with empty mirror:', e?.message || e);
        recordEvent('warn', `event=feed_load chat=${ctx.chatId} file=${mainKey} result=error error=${e?.message || e}`);
        setStorageDiag('load', { loaded: true, result: 'error', file: mainKey, entryCount: 0, gcDropped: 0, error: String(e?.message || e) });
    }
    if (sequence !== _loadSequence) return;
    _mirror = doc ? { entries: doc.entries } : emptyMirror();
    _loadedKey = mainKey;
    _loadedChatId = ctx.chatId;
    // Retire the fallback file after its content is safely under the guid key.
    // Copy first, delete only on copy success (chained, so the delete can never
    // overtake the copy); on copy failure the fallback stays as the surviving
    // store instead of leaving the new guid file empty.
    if (minted && fallbackDoc) {
        recordEvent('log', `event=feed_fallback_migrated chat=${ctx.chatId} from=${fallbackKey} to=${mainKey} entries=${Object.keys(_mirror.entries).length}`);
        _writeChain = schedulePersist({ ctx, key: mainKey, mirror: _mirror })
            .then(ok => {
                if (!ok) return;
                return deleteUserFile(fallbackKey).catch(cause => {
                    warn('loadFeedStore: fallback feed file cleanup failed (kept):', cause?.message || cause);
                });
            })
            .catch(() => {});
    }
    if (minted) persistChatMetadata(ctx);
    migrateV1Posts(ctx);
    const pruned = pruneOrphanedEntries(ctx);
    const entryCount = Object.keys(_mirror.entries).length;
    if (pruned > 0 || entryCount) trace(`loadFeedStore: ${mainKey} — ${entryCount} entr(ies), GC dropped ${pruned}`);
    const loadResult = doc ? 'found' : 'missing';
    if (_storageDiag.result !== 'error') setStorageDiag('load', { loaded: true, result: loadResult, file: mainKey, entryCount, gcDropped: pruned, error: null });
    else setStorageDiag('load', { loaded: true, file: mainKey, entryCount, gcDropped: pruned });
    recordEvent('log', `event=feed_load chat=${ctx.chatId} file=${mainKey} result=${_storageDiag.result} entries=${entryCount} gc=${pruned}`);
    if (pruned > 0) schedulePersist({ ctx, key: mainKey, mirror: _mirror });
}

// Serialized full-file write (pinned-store chain pattern).
function schedulePersist({ ctx = getCtx(), key = _loadedKey ?? chatFileKey(ctx), mirror = _mirror } = {}) {
    const entries = mirror?.entries ?? {};
    const doc = { v: STORE_VERSION, entries: { ...entries } };
    setStorageDiag('write', { loaded: !!mirror, result: 'queued', file: key, entryCount: Object.keys(doc.entries).length, error: null });
    recordEvent('log', `event=feed_write chat=${ctx?.chatId || 'none'} file=${key} result=queued entries=${Object.keys(doc.entries).length}`);
    const job = _writeChain
        .then(() => uploadUserFile(key, textToBase64(JSON.stringify(doc))))
        .then(() => {
            trace(`feed-file-store: wrote ${key} (${Object.keys(doc.entries).length} entries)`);
            setStorageDiag('write', { loaded: true, result: 'success', file: key, entryCount: Object.keys(doc.entries).length, error: null });
            recordEvent('log', `event=feed_write chat=${ctx?.chatId || 'none'} file=${key} result=success entries=${Object.keys(doc.entries).length}`);
            return true;
        })
        .catch(cause => {
            error('feed-file-store: upload failed:', cause);
            setStorageDiag('write', { loaded: !!mirror, result: 'error', file: key, entryCount: Object.keys(doc.entries).length, error: String(cause?.message || cause) });
            recordEvent('error', `event=feed_write chat=${ctx?.chatId || 'none'} file=${key} result=error entries=${Object.keys(doc.entries).length} error=${cause?.message || cause}`);
            notifyStoreFailure();
            return false;
        });
    _writeChain = job;
    return job;
}

export function flushFeedStoreWrites() {
    return _writeChain;
}

function notifyStoreFailure() {
    // Toast once per 5s per key (core.notifyUser dedupe) — a failed write must
    // not turn into a toastr storm on rapid swiping with a dead server.
    try {
        const toastr = globalThis.toastr;
        if (toastr?.error) toastr.error(tr('Failed to save comments to the server.', 'dscomments.toast.storefail'));
    } catch { /* no toastr in tests */ }
}

// ── Slot keys ──

/**
 * The send_date identity of a swipe slot. Prefers the slot snapshot (exact per
 * -swipe value even when several swipes share the message-level fallback),
 * falls back to the message's own send_date (swipe-less or legacy messages).
 */
export function slotKeyOf(msg, swipeIdx) {
    const idx = Number.parseInt(swipeIdx, 10);
    if (!msg || typeof msg !== 'object') return null;
    const fromSlot = Array.isArray(msg.swipe_info) && msg.swipe_info[idx]
        ? msg.swipe_info[idx]?.send_date
        : undefined;
    if (typeof fromSlot === 'string' && fromSlot) return fromSlot;
    if (typeof fromSlot === 'number' && Number.isFinite(fromSlot)) return String(fromSlot);
    if (typeof msg?.send_date === 'string' && msg.send_date) return msg.send_date;
    if (typeof msg?.send_date === 'number' && Number.isFinite(msg.send_date)) return String(msg.send_date);
    return null;
}

function swipeTextOf(msg, idx) {
    if (Array.isArray(msg?.swipes) && typeof msg.swipes[idx] === 'string') return msg.swipes[idx];
    return typeof msg?.mes === 'string' ? msg.mes : null;
}

// ── Public CRUD (all sync — mirror reads/writes; persistence is async) ──

/**
 * Read the stored feed for a swipe. Key = slot send_date; on fp mismatch a
 * linear fp scan rescues legacy collisions (ensureSwipesValid backfills slots
 * with one shared send_date — then the text fp disambiguates).
 * @returns {{html:string, generationFp?:string|null, ts?:number, fp?:string}|null}
 */
export function getFeedSlot(msgId, swipeIdx) {
    if (!_mirror) return null;
    const msg = getCtx()?.chat?.[parseInt(msgId, 10)];
    if (!msg) return null;
    const idx = parseInt(swipeIdx, 10);
    if (!Number.isInteger(idx) || idx < 0) return null;
    const key = slotKeyOf(msg, idx);
    if (!key) return null;

    const direct = validPayload(_mirror.entries[key]);
    const text = swipeTextOf(msg, idx);
    const currentFp = text !== null ? hashFingerprint(text) : null;
    if (direct) {
        if (!direct.fp || !currentFp || direct.fp === currentFp) return direct;
        // fp drift on the direct key: fall through to the scan — a legacy
        // collision may have parked the RIGHT payload under another key.
    }
    if (!currentFp) return direct ?? null;
    for (const [k, p] of Object.entries(_mirror.entries)) {
        if (k === key) continue;
        if (validPayload(p) && p.fp === currentFp) return p;
    }
    return direct ?? null;
}

/**
 * Write the feed for one swipe into the mirror and schedule the file upload.
 * Mints + persists the chat guid on first write.
 * @returns {boolean} whether the write landed in the mirror.
 */
export function setFeedSlot(msgId, swipeIdx, html, generationFp = null) {
    const ctx = getCtx();
    // A render from a newly opened chat must never write through the previous
    // chat's mirror while its CHAT_CHANGED load is still in flight.
    if (_loadedChatId && String(_loadedChatId) !== String(ctx?.chatId ?? '')) {
        _mirror = null;
        _loadedKey = null;
        _loadedChatId = null;
    }
    // A save may legitimately arrive before loadFeedStore ran (early render);
    // dropping the feed would be worse than a locally-created mirror.
    if (!_mirror) _mirror = emptyMirror();
    const msg = ctx?.chat?.[parseInt(msgId, 10)];
    if (!msg) return false;
    const idx = parseInt(swipeIdx, 10);
    if (!Number.isInteger(idx) || idx < 0) return false;
    let key = slotKeyOf(msg, idx);
    if (!key) {
        // Belt & braces: real ST messages always carry send_date (saveReply),
        // but a hand-crafted/im message without one gets an identity stamped
        // here so the write is addressable instead of silently skipped.
        const n = Array.isArray(msg.swipes) ? msg.swipes.length : 1;
        if (!Array.isArray(msg.swipe_info)) msg.swipe_info = Array.from({ length: n }, () => ({}));
        if (!msg.swipe_info[idx]) msg.swipe_info[idx] = {};
        msg.swipe_info[idx].send_date = new Date().toISOString();
        if (!msg.send_date) msg.send_date = msg.swipe_info[idx].send_date;
        key = msg.swipe_info[idx].send_date;
    }
    const { minted } = resolveGuid(ctx);
    const text = swipeTextOf(msg, idx);
    _mirror.entries[key] = {
        v: STORE_VERSION,
        html: String(html ?? ''),
        ts: Date.now(),
        fp: hashFingerprint(text ?? ''),
        generationFp: generationFp ?? null,
    };
    if (minted) persistChatMetadata(ctx);
    schedulePersist({ ctx, key: _loadedKey ?? chatFileKey(ctx), mirror: _mirror });
    return true;
}

/**
 * Drop entries whose key no longer belongs to any live swipe slot (message or
 * swipe deletions). One pass over the chat; returns the dropped count.
 */
export function pruneOrphanedEntries(ctx = getCtx()) {
    if (!_mirror) return 0;
    const chat = ctx?.chat;
    if (!Array.isArray(chat)) return 0;
    const live = new Set();
    for (const msg of chat) {
        if (!msg || typeof msg !== 'object') continue;
        const nSwipes = Array.isArray(msg.swipe_info) ? msg.swipe_info.length
            : Array.isArray(msg.swipes) ? msg.swipes.length : 1;
        for (let i = 0; i < nSwipes; i++) {
            const k = slotKeyOf(msg, i);
            if (k) live.add(k);
        }
    }
    let dropped = 0;
    for (const k of Object.keys(_mirror.entries)) {
        if (!live.has(k)) { delete _mirror.entries[k]; dropped++; }
    }
    return dropped;
}

/** Remove one slot's entry (MESSAGE_SWIPE_DELETED) and persist. */
export function dropSlotEntry(msgId, swipeIdx, deadKey) {
    if (!_mirror) return false;
    let key = deadKey ?? null;
    if (!key) {
        const msg = getCtx()?.chat?.[parseInt(msgId, 10)];
        key = msg ? slotKeyOf(msg, swipeIdx) : null;
    }
    if (!key || !(key in _mirror.entries)) return false;
    delete _mirror.entries[key];
    const ctx = getCtx();
    schedulePersist({ ctx, key: _loadedKey ?? chatFileKey(ctx), mirror: _mirror });
    return true;
}

/**
 * Clear the whole store for the current chat: empty mirror + DELETE the file.
 * The guid scalar stays (the chat identity is still valid).
 */
export function clearFeedFile() {
    if (!_mirror) return;
    _mirror.entries = {};
    const ctx = getCtx();
    const key = _loadedKey ?? chatFileKey(ctx);
    setStorageDiag('delete', { loaded: true, result: 'queued', file: key, entryCount: 0, error: null });
    recordEvent('log', `event=feed_delete chat=${ctx?.chatId || 'none'} file=${key} result=queued`);
    // Delete via the chain so a queued write cannot resurrect the file after.
    const job = _writeChain
        .then(() => deleteUserFile(key))
        .then(() => {
            trace(`feed-file-store: deleted ${key}`);
            setStorageDiag('delete', { loaded: true, result: 'success', file: key, entryCount: 0, error: null });
            recordEvent('log', `event=feed_delete chat=${ctx?.chatId || 'none'} file=${key} result=success`);
        })
        .catch(cause => {
            warn('feed-file-store: delete failed:', cause);
            setStorageDiag('delete', { loaded: true, result: 'error', file: key, entryCount: 0, error: String(cause?.message || cause) });
            recordEvent('error', `event=feed_delete chat=${ctx?.chatId || 'none'} file=${key} result=error error=${cause?.message || cause}`);
        });
    _writeChain = job;
}

/** Snapshot for diagnostics (debug panel / runtime dump). */
export function feedStoreSnapshot() {
    if (!_mirror) return { loaded: false, key: null, entries: {} };
    return {
        loaded: true,
        key: _loadedKey ?? chatFileKey(getCtx()),
        entries: _mirror.entries,
    };
}

// ── v1 migration (chatMetadata.posts → file entries) ──

/**
 * Lift v1 index-keyed posts into the file store, keying each entry by its
 * slot's send_date. Runs on load; the v1 table is stripped from chatMetadata
 * ONLY after the file write has been scheduled and awaited once — on failure
 * the posts stay in the chat and we retry on the next CHAT_CHANGED.
 */
function migrateV1Posts(ctx) {
    const store = ctx?.chatMetadata?.[META_KEY];
    const posts = store?.posts;
    if (!posts || typeof posts !== 'object' || !Object.keys(posts).length) return;
    const chat = ctx?.chat;
    if (!Array.isArray(chat)) return;

    let lifted = 0;
    for (const [msgId, swipes] of Object.entries(posts)) {
        if (!swipes || typeof swipes !== 'object') continue;
        const msg = chat[parseInt(msgId, 10)];
        for (const [swipeIdx, entry] of Object.entries(swipes)) {
            if (!entry || typeof entry.html !== 'string') continue;
            const key = msg ? slotKeyOf(msg, parseInt(swipeIdx, 10)) : null;
            if (!key) continue;
            const text = msg ? swipeTextOf(msg, parseInt(swipeIdx, 10)) : null;
            _mirror.entries[key] = {
                v: STORE_VERSION,
                html: entry.html,
                ts: typeof entry.timestamp === 'number' ? entry.timestamp : Date.now(),
                fp: entry.fp ?? (text !== null ? hashFingerprint(text) : undefined),
                generationFp: entry.generationFp ?? null,
            };
            lifted++;
        }
    }
    if (!lifted) {
        recordEvent('warn', `event=feed_migration result=empty chat=${ctx?.chatId || 'none'}`);
        delete store.posts;
        return;
    }

    trace(`feed-file-store: migrating v1 posts → file (${lifted} entries)`);
    recordEvent('log', `event=feed_migration result=started chat=${ctx?.chatId || 'none'} entries=${lifted}`);
    // Persist the file FIRST; strip the v1 table only after the upload landed.
    const migrationKey = _loadedKey ?? chatFileKey(ctx);
    schedulePersist({ ctx, key: migrationKey, mirror: _mirror }).then((uploaded) => {
        if (!uploaded) {
            recordEvent('error', `event=feed_migration result=upload-error chat=${ctx?.chatId || 'none'} entries=${lifted}`);
            return;
        }
        try {
            const liveStore = ctx?.chatMetadata?.[META_KEY];
            if (liveStore) {
                delete liveStore.posts;
                persistChatMetadata(ctx);
            }
            recordEvent('log', `event=feed_migration result=success chat=${ctx?.chatId || 'none'} entries=${lifted}`);
        } catch (e) {
            warn('feed-file-store: v1 strip failed (will retry next load):', e);
            recordEvent('error', `event=feed_migration result=strip-error chat=${ctx?.chatId || 'none'} entries=${lifted} error=${e?.message || e}`);
        }
    });
}

function validPayload(p) {
    return p && typeof p === 'object' && typeof p.html === 'string' ? p : null;
}

// core.js reads the mirror shape for the debug dump through this registration
// (importing this module from core would create a TDZ-fatal import cycle).
registerFeedStoreSnapshot(() => feedStoreSnapshot());
registerFeedStoreDiagnostics(() => feedStoreDiagnostics());

// ── Test-only surface ──

export function _resetFeedFileStore() {
    _mirror = null;
    _loadedKey = null;
    _loadedChatId = null;
    _loadSequence = 0;
    _writeChain = Promise.resolve();
    Object.assign(_storageDiag, { lastOperation: null, loaded: false, result: null, file: null, entryCount: 0, gcDropped: 0, at: null, error: null });
}

export function _seedMirror(entries) {
    _mirror = { entries: entries ?? {} };
    _loadedKey = chatFileKey(getCtx());
}

/**
 * Seed the mirror from a v1-shaped posts map ({msgId: {swipeIdx: entry}}),
 * patching each fake message with a stable slot send_date on the way in.
 * Keeps save-mode tests seeding positionally like they always did.
 */
export function _seedSaveCache(postsByMsgId, chat = getCtx()?.chat) {
    if (!_mirror) _mirror = emptyMirror();
    if (!Array.isArray(chat)) return;
    for (const [msgId, swipes] of Object.entries(postsByMsgId ?? {})) {
        const idx = parseInt(msgId, 10);
        let msg = chat[idx];
        if (!msg) {
            // Synthesize a stub message so positional seeds stay readable.
            msg = { mes: `seed-${msgId}`, is_user: false, is_system: false, is_hidden: false, swipe_id: 0, swipes: [`seed-${msgId}`] };
            chat[idx] = msg;
        }
        const n = Array.isArray(msg.swipes) ? msg.swipes.length : 1;
        if (!Array.isArray(msg.swipe_info)) msg.swipe_info = [];
        while (msg.swipe_info.length < n) msg.swipe_info.push({});
        for (const [swipeIdx, entry] of Object.entries(swipes ?? {})) {
            const i = parseInt(swipeIdx, 10);
            if (i >= msg.swipe_info.length) msg.swipe_info.push({});
            const slot = msg.swipe_info[i] ?? (msg.swipe_info[i] = {});
            if (!slot.send_date) slot.send_date = `test-sd-${msgId}-${i}`;
            const key = slotKeyOf(msg, i);
            _mirror.entries[key] = {
                v: STORE_VERSION,
                html: entry?.html ?? '',
                ts: entry?.timestamp ?? Date.now(),
                fp: entry?.fp,
                generationFp: entry?.generationFp ?? null,
            };
        }
    }
}

export const _STORE_VERSION = STORE_VERSION;
export const _getLoadedKey = () => _loadedKey;
export const _flushWriteChain = () => _writeChain;
