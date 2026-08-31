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
        set innerHTML(v) { this._html = String(v ?? ''); },
        get innerHTML() { return this._html; },
        // innerText/textContent of a live DOM strip tags; repeat without layout.
        get innerText() { return this._html.replace(/<[^>]+>/g, ''); },
        get textContent() { return this._html.replace(/<[^>]+>/g, ''); },
    };
}
globalThis.document = {
    createElement: () => makeEl(),
    getElementById: () => null,
};

// ── window shim ──
globalThis.window = {
    confirm: () => true,
    prompt: () => null,
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
            sanitize: (html, cfg) => {
                const tags = cfg?.FORBID_TAGS;
                if (Array.isArray(tags) && tags.length > 0) {
                    return String(html ?? '').replace(
                        new RegExp(`<(/?)(${tags.join('|')})(\\s[^>]*)?>`, 'gi'),
                        '',
                    );
                }
                return String(html ?? '');
            },
        },
        localforage: {
            getItem: async () => null,
            setItem: async () => {},
            removeItem: async () => {},
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