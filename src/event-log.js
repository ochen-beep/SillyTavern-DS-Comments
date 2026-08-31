// @ts-check
/**
 * DS Comments — Persistent event log
 *
 * A small ring buffer of SIGNIFICANT extension events (generation start/abort,
 * storeFeed/clearFeed, pinned-store load/persist, mode toggle, session start)
 * persisted to localforage so it survives F5 / ST restart.
 *
 * Why this exists alongside _debugLog (core.js): _debugLog is in-memory only and
 * dominated by observer/scroll noise that rotates the 200-line ring in seconds.
 * For the F5-survival investigation the user needs to see, in a single exported
 * file, the chain "storeFeed → F5 → loadPinnedFeeds → showCurrentFeed". That
 * requires crossing the reload boundary, which only a persisted, signal-only
 * log can do. Scroll/pick noise is intentionally NOT recorded here.
 *
 * Callers pair recordEvent() with their existing log()/warn() call (the latter
 * still goes to console + the in-memory ring); recordEvent() only persists.
 */

import { debounce, warn, LF_EVENTLOG, registerDiagnosticSessionProvider, registerEventLogLoadedProvider } from './core.js';

const MAX_EVENTS = 150;
const MAX_EVENT_CHARS = 1200;

const _eventLog = [];
let _loaded = false;
let _sessionId = newSessionId();

function newSessionId() {
    try {
        if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID().slice(0, 12);
    } catch { /* fall through */ }
    return Math.random().toString(36).slice(2, 14);
}

function _ts() {
    return new Date().toISOString();
}

function safeEventText(msg) {
    const text = String(msg ?? '').replace(/[\r\n]+/g, ' ').trim();
    return text.length > MAX_EVENT_CHARS
        ? `${text.slice(0, MAX_EVENT_CHARS)} …(truncated)`
        : text;
}

export function getDiagnosticSessionId() {
    return _sessionId;
}

export function isEventLogLoaded() {
    return _loaded;
}

/**
 * Record a significant event into the persistent log.
 * @param {'log'|'warn'|'error'} level
  pre-formatted message (no objects; callers build the string).
 */
export function recordEvent(level, msg) {
    try {
        const normalizedLevel = level === 'error' || level === 'warn' ? level : 'log';
        _eventLog.push(`${_ts()} [${normalizedLevel}] session=${_sessionId} ${safeEventText(msg)}`);
        while (_eventLog.length > MAX_EVENTS) _eventLog.shift();
        // Before loadEventLog completes, preserve the in-memory marker but don't
        // write yet: otherwise a fast event (e.g. loadPinnedFeeds) can overwrite
        // the existing persisted history before it has been merged.
        if (_loaded) _schedulePersist();
    } catch { /* never break callers */ }
}

/**
 * Load the persisted event log from localforage into the in-memory ring.
 * Merges behind any events already recorded this session (session start marker).
 */
export async function loadEventLog() {
    let raw = null;
    try {
        raw = await SillyTavern.libs.localforage.getItem(LF_EVENTLOG);
    } catch (e) {
        warn('loadEventLog: localforage read failed:', e);
        _loaded = true;
        if (_eventLog.length) _schedulePersist();
        return;
    }
    if (Array.isArray(raw)) {
        // Prepend persisted history (trimmed) before this session's already-recorded
        // events so the timeline reads chronologically across the F5 boundary.
        const revived = [];
        for (const e of raw) {
            if (typeof e === 'string') revived.push(e);
        }
        while (revived.length > MAX_EVENTS - _eventLog.length) revived.shift();
        _eventLog.unshift(...revived);
        while (_eventLog.length > MAX_EVENTS) _eventLog.shift();
    }
    _loaded = true;
    // Persist the merged state: this includes any events recorded before the
    // async load finished (notably loadPinnedFeeds) without losing old history.
    if (_eventLog.length) _schedulePersist();
}

// Debounce stays (event bursts are frequent), but the CURRENT write is
// tracked in _inFlight and a clear suppresses new ones — see clearEventLog.
let _inFlight = null;
let _suppress = false;

const _persist = debounce(() => {
    if (_suppress) return;
    _inFlight = (async () => {
        try {
            await SillyTavern.libs.localforage.setItem(LF_EVENTLOG, _eventLog.slice());
        } catch (e) {
            warn('eventLog persistence failed:', e);
        }
    })();
    return _inFlight;
}, 500);

function _schedulePersist() {
    _persist();
}

/** Fire any pending debounced write now and await it (page-hide / onClean). */
export function flushEventLog() {
    _persist.flush?.();   // fire the pending timer immediately (lodash flush)
    return _inFlight ?? Promise.resolve();
}

/**
 * Remove the persisted event log entirely.
 * F5: awaits the in-flight setItem BEFORE removeItem (otherwise the abandoned
 * write can land after the removal and resurrect the key) and suppresses new
 * scheduled writes until the removal completes.
 */
export async function clearEventLog() {
    _suppress = true;
    _persist.cancel?.();
    try { await _inFlight; } catch { /* the write failed — key is already gone or absent */ }
    _eventLog.length = 0;
    _loaded = false;
    try {
        await SillyTavern.libs.localforage.removeItem(LF_EVENTLOG);
    } catch (e) {
        warn('clearEventLog failed:', e);
    } finally {
        _suppress = false;
    }
}

/** Newline-joined dump for the diagnostic export. */
export function dumpEventLog() {
    return _eventLog.length ? _eventLog.join('\n') : '(события не зафиксированы)';
}

// Test-only: drop in-memory state between cases.
export function _resetEventLog() {
    _persist.cancel?.();
    _inFlight = null;
    _suppress = false;
    _eventLog.length = 0;
    _loaded = false;
    _sessionId = newSessionId();
}

// Register through core at runtime to avoid a core -> event-log cycle.
registerDiagnosticSessionProvider(() => getDiagnosticSessionId());
registerEventLogLoadedProvider(() => isEventLogLoaded());
