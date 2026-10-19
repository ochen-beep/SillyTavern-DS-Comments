// @ts-check
/**
 * DS Comments — Comment media attachments (GIFs/stickers via Giphy,
 * memes via memegen.link).
 *
 * The model never outputs URLs. It outputs a search query ("gif"/"sticker")
 * or a meme recipe ({template, top, bottom}); this module resolves those to
 * allow-listed CDN URLs. Every failure path degrades to a text-only comment:
 * media resolution must never break a generation (only an abort propagates).
 *
 * Giphy: https://api.giphy.com/v1/gifs/search and /v1/stickers/search.
 * Memes: https://api.memegen.link/templates/ (fetched once per session) and
 * stateless image URLs built from the resolved template id.
 */

import { warn, trace } from './core.js';

const GIPHY_SEARCH_URL = 'https://api.giphy.com/v1/gifs/search';
const GIPHY_STICKER_SEARCH_URL = 'https://api.giphy.com/v1/stickers/search';
const MEMEGEN_TEMPLATES_URL = 'https://api.memegen.link/templates/';
const MEMEGEN_IMAGE_URL = 'https://api.memegen.link/images/';

// Only these CDN prefixes may ever reach the feed DOM. The resolver validates
// every URL against them BEFORE attaching it to a message, and the renderer's
// upgrade pass re-checks (defence in depth against future call sites).
const ALLOWED_URL_RES = [
    /^https:\/\/media\d*\.giphy\.com\//,
    /^https:\/\/i\.giphy\.com\//,
    /^https:\/\/api\.memegen\.link\/images\//,
];

// Results to request per search — the resolver picks one at random so
// regenerating the same post doesn't attach the identical GIF.
const SEARCH_LIMIT = 5;

// Map the extension's coarse rating to Giphy-native values. 'off' (unfiltered)
// maps to Giphy's most permissive rating 'r'.
const GIPHY_RATING = { low: 'g', medium: 'pg', high: 'pg-13', off: 'r' };

/**
 * Is this URL one the feed is allowed to render as media?
 * @param {string} url
 * @returns {boolean}
 */
export function isAllowedMediaUrl(url) {
    const s = String(url ?? '');
    if (!s.startsWith('https://') || s.length > 2048) return false;
    return ALLOWED_URL_RES.some(re => re.test(s));
}

// ── Meme text encoding (memegen.link URL grammar) ──
// Escapes: ~q=?  ~a=&  ~h=#  ~p=%  ~s=/  ~n=newline  ''=double quote.
// Underscores/dashes mean space; doubled they mean the literal character.

export function encodeMemeText(text) {
    let s = String(text ?? '').replace(/\r/g, '').trim();
    if (!s) return '';
    s = s
        .replace(/\?/g, '~q')
        .replace(/&/g, '~a')
        .replace(/#/g, '~h')
        .replace(/%/g, '~p')
        .replace(/\//g, '~s')
        .replace(/\n/g, '~n')
        .replace(/"/g, "''");
    s = s.replace(/_/g, '__').replace(/-/g, '--').replace(/ /g, '_');
    // Anything left that is not plain ASCII path-safe (Cyrillic, emoji…) is
    // percent-encoded; memegen decodes percent escapes in path segments.
    s = s.replace(/[^A-Za-z0-9~_\-.,!()'`]/g, ch => encodeURIComponent(ch));
    return s;
}

// ── Meme templates (session cache) ──

let _memeTemplates = null;
let _memeTemplatesTs = 0;
const MEME_TEMPLATES_TTL_MS = 60 * 60 * 1000;

/** Test hook: drop the session template cache. */
export function _resetMemeTemplateCache() {
    _memeTemplates = null;
    _memeTemplatesTs = 0;
}

async function fetchMemeTemplates(signal) {
    if (_memeTemplates && Date.now() - _memeTemplatesTs < MEME_TEMPLATES_TTL_MS) {
        return _memeTemplates;
    }
    const response = await fetch(MEMEGEN_TEMPLATES_URL, { method: 'GET', signal });
    if (!response.ok) throw new Error(`memegen templates: HTTP ${response.status}`);
    const list = await response.json();
    if (!Array.isArray(list)) throw new Error('memegen templates: unexpected payload');
    _memeTemplates = list.filter(t => t && typeof t.id === 'string' && t.id);
    _memeTemplatesTs = Date.now();
    trace(`memegen templates cached: ${_memeTemplates.length}`);
    return _memeTemplates;
}

const _normMemeName = (s) => String(s ?? '').toLowerCase().replace(/[^a-z0-9]+/g, '');

// Folk meme names → memegen link ids. The API names templates after the
// original image ("ds" = Daily Struggle), while models naturally speak in
// vernacular ("two buttons", "distracted boyfriend") — map the common ones
// before fuzzy matching, so the model's phrasing resolves.
const MEME_ALIASES = {
    twobuttons: 'ds',
    dailystruggle: 'ds',
    sweatingguy: 'ds',
    distractedboyfriend: 'db',
    distractedgf: 'dg',
    distractedgirlfriend: 'dg',
    expandingbrain: 'gb',
    galaxybrain: 'gb',
    epichandshake: 'handshake',
    womanyellingatacat: 'woman-cat',
    womanyellingatcat: 'woman-cat',
    womanyellingcat: 'woman-cat',
    mockingspongebob: 'spongebob',
    spidermanpointing: 'spiderman',
    spidermanpointingatspiderman: 'spiderman',
    changemymind: 'cmm',
    isthisapigeon: 'pigeon',
    panikkalmpanik: 'panik-kalm-panik',
    americanchopper: 'chair',
    americanchopperargument: 'chair',
    xxeverywhere: 'buzz',
    buzzlightyear: 'buzz',
    feelsbadman: 'sadfrog',
    sadfrog: 'sadfrog',
    yunoguy: 'yuno',
};

/**
 * Resolve a model-provided template hint ("drake", "Drake Posting", "two
 * buttons") to a template entry. Vernacular aliases map to canonical ids
 * first; then exact id/name/keyword match, then prefix, then substring.
 * @returns {object|null}
 */
export function resolveMemeTemplate(hint, templates) {
    const needle = _normMemeName(hint);
    if (!needle || !Array.isArray(templates)) return null;
    const keys = (t) => [
        _normMemeName(t.id), _normMemeName(t.name),
        ...Array.isArray(t.keywords) ? t.keywords.map(_normMemeName) : [],
    ].filter(Boolean);
    const byCanonical = (canonical) => templates.find(t => _normMemeName(t.id) === _normMemeName(canonical));
    // 1. Vernacular alias → canonical id
    const aliased = MEME_ALIASES[needle] ?? MEME_ALIASES[needle.toLowerCase()];
    if (aliased) {
        const t = byCanonical(aliased);
        if (t) return t;
    }
    for (const pass of ['exact', 'prefix', 'substring']) {
        for (const t of templates) {
            const ks = keys(t);
            const hit = pass === 'exact' ? ks.some(k => k === needle)
                : pass === 'prefix' ? ks.some(k => k.startsWith(needle))
                : ks.some(k => k.includes(needle) || needle.includes(k));
            if (hit) return t;
        }
    }
    return null;
}

// Templates whose text zones deviate from "first line = top caption, last
// line = bottom caption" (default layout). Maps template id → [topIdx,
// bottomIdx] over the template's caption lines. Extended as layouts are
// discovered; everything not listed uses the default.
const MEME_TEXT_PLACEMENT = new Map([
    // Daily Struggle ("two buttons"): both captions label the buttons — the
    // joke IS the choice; the sweating-guy strip below stays unlabeled.
    ['ds', [0, 1]],
]);

/**
 * Build the stateless memegen image URL for a resolved template.
 * Templates with more than 2 caption lines (distracted boyfriend, epic
 * handshake…) get top → first line, bottom → last line, empty middles —
 * the contract teaches 2-line composition, so the middle labels stay blank.
 * @returns {string|null}
 */
export function buildMemeUrl(template, spec) {
    if (!template?.id) return null;
    const top = encodeMemeText(spec?.top);
    const bottom = encodeMemeText(spec?.bottom);
    const lines = Number.isInteger(template.lines) ? Math.max(1, Math.min(6, template.lines)) : 2;
    const segments = Array(lines).fill('');
    const placement = MEME_TEXT_PLACEMENT.get(template.id);
    if (lines === 1) {
        segments[0] = top;
    } else if (placement && placement[0] < lines && placement[1] < lines) {
        segments[placement[0]] = top;
        segments[placement[1]] = bottom;
    } else {
        segments[0] = top;
        segments[lines - 1] = bottom;
    }
    // Segments are already memegen-safe (encodeMemeText did the escaping and
    // percent-encoding of non-ASCII) — do NOT re-encode: a second layer would
    // turn %D0.. into %25D0.. and mangle the text.
    // memegen's default impact font has NO cyrillic glyphs and silently drops
    // every non-ASCII caption (verified live: distinct texts render byte-
    // identical). Any non-ASCII caption switches to Noto Sans, which covers
    // Cyrillic; pure-latin captions keep the canonical impact look.
    const needsUnicodeFont = /[^\x00-\x7F]/.test(`${spec?.top ?? ''}${spec?.bottom ?? ''}`);
    return `${MEMEGEN_IMAGE_URL}${[template.id, ...segments].join('/')}.png${needsUnicodeFont ? '?font=notosans' : ''}`;
}

// ── Provider searches ──

async function searchGiphy(query, { apiKey, rating, sticker, signal }) {
    const params = new URLSearchParams({
        api_key: apiKey,
        q: query,
        limit: String(SEARCH_LIMIT),
    });
    const mapped = GIPHY_RATING[rating];
    if (mapped) params.set('rating', mapped);
    const endpoint = sticker ? GIPHY_STICKER_SEARCH_URL : GIPHY_SEARCH_URL;
    const response = await fetch(`${endpoint}?${params}`, { method: 'GET', signal });
    if (!response.ok) throw new Error(`giphy: HTTP ${response.status}`);
    const payload = await response.json();
    const results = Array.isArray(payload?.data) ? payload.data : [];
    for (const item of results) {
        const images = item?.images;
        const url = images?.downsized?.url ?? images?.fixed_height?.url ?? images?.original?.url;
        if (typeof url === 'string' && url) return url;
    }
    return null;
}

// ── Resolution entry point ──

const _firstMediaRequest = (msg) => {
    const gif = typeof msg?.gif === 'string' ? msg.gif.trim() : '';
    if (gif) return { type: 'gif', query: gif };
    const sticker = typeof msg?.sticker === 'string' ? msg.sticker.trim() : '';
    if (sticker) return { type: 'sticker', query: sticker };
    if (msg?.meme && typeof msg.meme === 'object') return { type: 'meme', spec: msg.meme };
    return null;
};

const _mediaAlt = (type, request) => {
    if (type === 'meme') {
        const spec = request.spec ?? {};
        return [spec.template, spec.top, spec.bottom].filter(Boolean).join(': ');
    }
    return request.query;
};

/**
 * Resolve every media request in a parsed commentary batch to an allow-listed
 * URL, setting `msg.media = { type, url, alt }`. Per-feed request cache: two
 * commenters searching the same query share one lookup. Never throws except
 * AbortError (a cancelled generation must surface as cancelled).
 *
 * @param {Array<object>} messages parser output (mutated in place)
 * @param {{ provider?: string, giphyKey?: string,
 *           rating?: string, stickersEnabled?: boolean, memeEnabled?: boolean,
 *           signal?: AbortSignal }} opts
 * @returns {Promise<number>} how many messages got media attached
 */
export async function resolveCommentMedia(messages, opts = {}) {
    if (!Array.isArray(messages) || messages.length === 0) return 0;
    const signal = opts.signal ?? null;
    const rating = ['off', 'low', 'medium', 'high'].includes(opts.rating) ? opts.rating : 'medium';

    let provider = opts.provider === 'giphy' ? opts.provider : '';
    const apiKey = String(opts.giphyKey ?? '');
    let warned = false;
    const warnOnce = (msg, ...rest) => {
        if (warned) return;
        warned = true;
        warn(msg, ...rest);
    };
    if (provider && !apiKey) {
        warnOnce(`resolveCommentMedia: ${provider} selected but its API key is empty — GIFs/stickers skipped`);
        provider = '';
    }
    const stickersEnabled = !!provider && opts.stickersEnabled !== false;
    const memeEnabled = !!opts.memeEnabled;
    if (!provider && !memeEnabled) return 0;

    const cache = new Map();   // `${type}:${query}` → url|null (per feed)
    let templates = null;      // lazy memegen template list

    let resolved = 0;
    for (const msg of messages) {
        const request = _firstMediaRequest(msg);
        if (!request) continue;
        const usable = (request.type === 'gif' && provider)
            || (request.type === 'sticker' && stickersEnabled)
            || (request.type === 'meme' && memeEnabled);
        if (!usable) continue;

        const cacheKey = request.type === 'meme'
            ? `meme:${request.spec?.template ?? ''}|${request.spec?.top ?? ''}|${request.spec?.bottom ?? ''}`
            : `${request.type}:${request.query.toLowerCase()}`;
        if (!cache.has(cacheKey)) {
            cache.set(cacheKey, null);   // re-entrancy guard: same query twice in one batch
            try {
                if (request.type === 'meme') {
                    templates ??= await fetchMemeTemplates(signal);
                    const template = resolveMemeTemplate(request.spec?.template, templates);
                    if (!template) throw new Error(`meme template not found: ${request.spec?.template}`);
                    cache.set(cacheKey, buildMemeUrl(template, request.spec));
                } else {
                    const url = await searchGiphy(request.query, { apiKey, rating, sticker: request.type === 'sticker', signal });
                    cache.set(cacheKey, url);
                }
            } catch (e) {
                if (e?.name === 'AbortError') throw e;
                warnOnce(`resolveCommentMedia: ${request.type} "${request.type === 'meme' ? request.spec?.template : request.query}" failed — comment stays text-only`, e);
                cache.set(cacheKey, null);
            }
        }

        const url = cache.get(cacheKey);
        if (url && isAllowedMediaUrl(url)) {
            msg.media = { type: request.type, url, alt: _mediaAlt(request.type, request) };
            resolved++;
        } else if (!url) {
            trace(`resolveCommentMedia: no result for ${request.type} request`);
        }
    }
    return resolved;
}
