// @ts-check
/**
 * Minimal SillyTavern / DOM runtime stub for Node-side unit tests.
 *
 * Loaded as the FIRST import in every test file, BEFORE importing src/*.js,
 * because core.js reads SillyTavern.libs.lodash and creates
 * document.createElement('div') at top-level eval. Without these globals the
 * module fails at import time, before any test.
 *
 * Deliberately no jsdom: the only DOM consumer in pure modules is core.js
 * extractText, which a hand shim (strip tags) covers. DOMPurify is stubbed
 * as identity — we test the renderer's escapeHtml (the XSS contract), not a
 * third-party library's behavior.
 */

// ── document shim (only what the pure modules touch) ──
function makeEl() {
    return {
        _html: '',
        _attrs: {},
        set innerHTML(v) { this._html = String(v ?? ''); },
        get innerHTML() { return this._html; },
        // innerText/textContent of a live DOM strip tags; repeat without layout.
        get innerText() { return this._html.replace(/<[^>]+>/g, ''); },
        get textContent() { return this._html.replace(/<[^>]+>/g, ''); },
        set textContent(v) { this._html = String(v ?? ''); },
        setAttribute(k, v) { this._attrs[k] = String(v); },
        getAttribute(k) { return k in this._attrs ? this._attrs[k] : null; },
        appendChild(child) { (this.children ??= []).push(child); },
        classList: { add() {}, remove() {}, },
        className: '',
        alt: '',
        src: '',
        remove() {},
        // isConnected mirrors a live-DOM img inside the feed: the media
        // watchdog gates on it. Tests that exercise detachment flip this.
        isConnected: true,
        // dialog/<el> semantics the lightbox test drives; last listener wins,
        // which is all the single-handler wiring under test needs.
        open: false,
        addEventListener(type, fn) { (this._listeners ??= {})[type] = fn; },
        showModal() { this.open = true; },
        close() { this.open = false; },
    };
}
// setInterval/clearInterval registry: the renderer media watchdog registers
// timers during upgrades. Tests stay synchronous — _dscTickIntervals() fires
// every live handler once (one tick = one watchdog period).
globalThis._dscIntervals = [];
globalThis.setInterval = (fn) => { globalThis._dscIntervals.push(fn); return globalThis._dscIntervals.length; };
globalThis.clearInterval = (id) => { globalThis._dscIntervals[id - 1] = null; };
globalThis._dscTickIntervals = () => { for (const fn of globalThis._dscIntervals) fn?.(); };

globalThis.document = {
    createElement: () => makeEl(),
    getElementById: () => null,
    body: makeEl(),
};

// ── window shim ──
globalThis.window = {
    confirm: () => true,
    prompt: () => null,
};

// core.js extractText parses through DOMParser (inert document — no resource
// loads, no inline handler execution). Reuses makeEl's tag-stripping
// textContent; nothing here can execute, which is the point being modeled.
globalThis.DOMParser = class {
    parseFromString(html) {
        const body = makeEl();
        body.innerHTML = String(html ?? '');
        return { body };
    }
};

// ── fetch mock: routes /api/files/* + /user/files/* to an in-memory FS ──
// The server-file store (src/feed-file-store.js) talks to these three
// endpoints. Tests (and any module importing it transitively) get a tiny
// routing mock instead of real HTTP; per-test state lives in _stFiles.
function _fileBody(init) {
    const text = typeof init?.body === 'string' ? init.body : String(init?.body ?? '');
    return { text: async () => text, ok: true, status: 200, json: async () => JSON.parse(text || 'null') };
}
globalThis._stFiles = Object.create(null);
globalThis._stFilesReset = () => { for (const k of Object.keys(globalThis._stFiles)) delete globalThis._stFiles[k]; };
globalThis.fetch = async (url, init = {}) => {
    const u = String(url);
    if (u === '/api/files/upload') {
        const req = JSON.parse(init.body);
        if (!req?.name || !req?.data) return { ok: false, status: 400, text: async () => 'No upload name/data specified' };
        if (!/^[a-zA-Z0-9_\-.]+$/.test(req.name)) return { ok: false, status: 400, text: async () => 'Illegal character in filename' };
        globalThis._stFiles[req.name] = Buffer.from(req.data, 'base64').toString('utf8');
        return _fileBody({ body: JSON.stringify({ path: `user/files/${req.name}` }) });
    }
    if (u === '/api/files/delete') {
        const req = JSON.parse(init.body);
        const name = String(req?.path || '').split('/').pop();
        if (!(name in globalThis._stFiles)) return { ok: false, status: 404, text: async () => 'File not found' };
        delete globalThis._stFiles[name];
        return { ok: true, status: 200, text: async () => '' };
    }
    if (u === '/api/files/verify') {
        const req = JSON.parse(init.body);
        if (!Array.isArray(req?.urls)) return { ok: false, status: 400, text: async () => 'No URLs specified' };
        const out = {};
        for (const url of req.urls) {
            if (!String(url).startsWith('user/files/')) continue;
            const name = decodeURIComponent(String(url).slice('user/files/'.length));
            out[url] = name in globalThis._stFiles;
        }
        return _fileBody({ body: JSON.stringify(out) });
    }
    if (u.startsWith('/user/files/')) {
        const name = decodeURIComponent(u.slice('/user/files/'.length));
        if (!(name in globalThis._stFiles)) return { ok: false, status: 404, text: async () => 'Not found' };
        return _fileBody({ body: globalThis._stFiles[name] });
    }
    // Untouched by the store: rethrow so an accidental call is loud in tests.
    throw new Error(`stub-runtime fetch: unmocked URL ${u}`);
};

// ── SillyTavern mock ──
// Context object that tests mutate per case (chat, extensionSettings…).
globalThis._stCtx = {
    chat: [],
    chatMetadata: {},
    extensionSettings: {},
    maxContext: 16384,
    getRequestHeaders: () => ({ 'Content-Type': 'application/json' }),
    saveSettingsDebounced: () => {},
    substituteParams: (t) => t,
};

globalThis.SillyTavern = {
    libs: {
        lodash: {
        // identity-debounce: tests value synchronicity over timing.
        // Attach a flush() that invokes the wrapped function so callers/tests
        // can await completion the same way lodash debounce allows.
        debounce: (fn) => {
            const wrapped = (...args) => fn(...args);
            wrapped.flush = () => fn();
            return wrapped;
        },
            cloneDeep: (o) => JSON.parse(JSON.stringify(o)),
            merge: (a, b) => ({ ...a, ...b }),
        },
        // DOMPurify approximation: repeats only the FORBID_TAGS branch that core.js

        // uses. Real DOMPurify parses the DOM; here regex-stripping of forbidden

        // tags (including closing ones) suffices for the contract tests: FORBID_TAGS

        // reaches the stub, fail-closed is caught, LRU cache is verified.

        // NOT for checking a real XSS filter (onerror etc.) — that is built into

        // DOMPurify by default and is not modeled here.
        DOMPurify: {
            // Apply the BEFORE_SANITIZE_ATTRIBUTES hook the way real DOMPurify
            // would (per node, before attribute sanitization): the tests build
            // no real DOM, so approximate by running the hook's style-attr
            // regex over the HTML string. Keeps the --dsc-nick-* allow-list
            // contract visible to tests.
            sanitize: (html, cfg) => {
                let out = String(html ?? '');
                const hook = cfg?.BEFORE_SANITIZE_ATTRIBUTES;
                if (typeof hook === 'function') {
                    // emulate the hook: strip style attrs down to --dsc-nick-*
                    out = out.replace(/(<[a-z]+)\s+style="([^"]*)"/gi, (_m, tag, style) => {
                        const fakeNode = {
                            getAttribute: (n) => n === 'style' ? style : null,
                            setAttribute: (n, v) => { if (n === 'style') style = v; },
                            removeAttribute: (n) => { if (n === 'style') style = ''; },
                        };
                        try { hook(fakeNode); } catch { /* as real DOMPurify: never abort */ }
                        const next = typeof style === 'string' ? style : '';
                        return next ? `${tag} style="${next}"` : tag;
                    });
                }
                const tags = cfg?.FORBID_TAGS;
                if (Array.isArray(tags) && tags.length > 0) {
                    out = out.replace(
                        new RegExp(`<(/?)(${tags.join('|')})(\\s[^>]*)?>`, 'gi'),
                        '',
                    );
                }
                return out;
            },
        },
        localforage: {
            // Functional in-memory store: SWR tests (emotes) seed a persisted
            // value and expect getItem to return it. Tests needing call
            // semantics (blocked removeItem etc.) install their own mock.
            _store: new Map(),
            async getItem(k) { return this._store.has(k) ? this._store.get(k) : null; },
            async setItem(k, v) { this._store.set(k, v); return v; },
            async removeItem(k) { this._store.delete(k); },
            async keys() { return [...this._store.keys()]; },
        },
    },
    getContext: () => globalThis._stCtx,
};

/** Reset the context between test cases (call in beforeEach for core tests). */
export function resetCtx() {
    globalThis._stCtx = {
        chat: [],
        chatMetadata: {},
        extensionSettings: {},
        maxContext: 16384,
        getRequestHeaders: () => ({ 'Content-Type': 'application/json' }),
        saveSettingsDebounced: () => {},
        substituteParams: (t) => t,
    };
}