// @ts-check
/**
 * DS Comments — per-chat lorebook configuration.
 */

import { getCtx, state, tr, observePersistence } from './core.js';

export const LORE_META_KEY = 'dscomments_lorebook';

export const LORE_MODE = Object.freeze({
    AUTOMATIC: 'automatic',
    MANUAL: 'manual',
});

/**
 * Auto-mode lore scope. ATTACHED restricts automatic lore to the books bound
 * to this chat: the character card book, the chat book and the persona book.
 * Books merely ticked in ST's global World Info panel are excluded there.
 */
export const LORE_SCOPE = Object.freeze({
    ALL: 'all',
    ATTACHED: 'attached',
});

/** @param {unknown} value */
function parseUid(value) {
    if (typeof value !== 'number'
        && (typeof value !== 'string' || value.trim() === '')) {
        return undefined;
    }

    try {
        const uid = Number(value);
        return Number.isFinite(uid) ? uid : undefined;
    } catch {
        return undefined;
    }
}

/** @param {{ book: string, uid: number|string }} ref */
export function loreRefKey({ book, uid }) {
    let safeUid = '';
    try {
        safeUid = String(uid);
    } catch {
        // Malformed refs are discarded by normalizeLoreConfig.
    }
    return `${String(book).trim()}\u0000${safeUid}`;
}

/** @param {unknown} value */
export function normalizeLoreConfig(value) {
    const source = value && typeof value === 'object' ? value : {};
    const mode = source.mode === LORE_MODE.MANUAL
        ? LORE_MODE.MANUAL
        : LORE_MODE.AUTOMATIC;
    const refs = Array.isArray(source.selectedEntries) ? source.selectedEntries : [];
    const selectedEntries = [];
    const seen = new Set();

    for (const ref of refs) {
        if (!ref || typeof ref !== 'object' || typeof ref.book !== 'string') continue;
        const book = ref.book.trim();
        const uid = parseUid(ref.uid);
        if (!book || uid === undefined) continue;

        const normalized = { book, uid };
        const key = loreRefKey(normalized);
        if (seen.has(key)) continue;
        seen.add(key);
        selectedEntries.push(normalized);
    }

    selectedEntries.sort((left, right) => {
        const localeOrder = left.book.localeCompare(right.book);
        if (localeOrder !== 0) return localeOrder;
        if (left.book !== right.book) return left.book < right.book ? -1 : 1;
        return left.uid - right.uid;
    });

    // manualBooks: the books added to the settings panel. Legacy configs have no
    // such list — derive it from their references so nothing is lost.
    const rawBooks = Array.isArray(source.manualBooks) ? source.manualBooks : null;
    const manualBooks = [];
    const seenBooks = new Set();
    for (const name of rawBooks ?? selectedEntries.map(ref => ref.book)) {
        if (typeof name !== 'string') continue;
        const book = name.trim();
        if (!book || seenBooks.has(book)) continue;
        seenBooks.add(book);
        manualBooks.push(book);
    }
    const bookSet = new Set(manualBooks);
    const filteredEntries = selectedEntries.filter(ref => bookSet.has(ref.book));

    // enabled: an explicit flag wins. Any persisted metadata object without the
    // flag is a legacy config that always sent lore → true. No object → fresh
    // chat → false (matches the old includeWorldInfo default).
    const enabled = typeof source.enabled === 'boolean'
        ? source.enabled
        : value !== null && typeof value === 'object';

    // FINGERPRINT CONTRACT: undefined (not 'all') for the default. Both are
    // coerced away by JSON.stringify in buildGenerationFingerprint, so legacy
    // configs and an explicit 'all' hash identically and switching the toggle
    // off must not invalidate every saved feed's cache key. Readers use
    // `config.autoScope ?? LORE_SCOPE.ALL`. Change only together with the
    // fingerprint-stability test in test/lorebooks.test.mjs.
    const autoScope = source.autoScope === LORE_SCOPE.ATTACHED
        ? LORE_SCOPE.ATTACHED
        : undefined;

    return { enabled, mode, manualBooks, selectedEntries: filteredEntries, autoScope };
}

/** @param {ReturnType<typeof getCtx>} [ctx] */
export function getChatLoreConfig(ctx = getCtx()) {
    return normalizeLoreConfig(ctx?.chatMetadata?.[LORE_META_KEY]);
}

/**
 * @param {unknown} config
 * @param {ReturnType<typeof getCtx>} [ctx]
 */
export function saveChatLoreConfig(config, ctx = getCtx()) {
    const normalized = normalizeLoreConfig(config);
    if (!ctx.chatMetadata || typeof ctx.chatMetadata !== 'object') {
        ctx.chatMetadata = {};
    }
    ctx.chatMetadata[LORE_META_KEY] = normalized;

    let persistenceResult;
    try {
        persistenceResult = ctx.saveMetadata?.();
    } catch (cause) {
        persistenceResult = Promise.reject(cause);
    }
    observePersistence(
        persistenceResult,
        'save lorebook configuration',
        tr('Could not save lorebook settings.', 'dscomments.lore.saveError'),
    );
    return normalized;
}

/**
 * Books bound to the current chat with their binding role, as visible through
 * getContext(). Mirrors the non-global sources of ST's getSortedEntries
 * (world-info.js): the character card book (data.extensions.world), the chat
 * book (chat_metadata.world_info) and the persona book
 * (power_user.persona_description_lorebook). ST deduplicates each source
 * against the others; here the same book may legitimately appear twice when
 * two bindings coincide — consumers deduplicate.
 *
 * Known limitation: character extra books (world_info.charLore) are module
 * state not exposed on the context, so they cannot be listed here.
 *
 * @param {ReturnType<typeof getCtx>} [ctx]
 * @returns {Array<{ role: 'char'|'chat'|'persona', book: string }>}
 */
export function resolveAttachedLorebookSources(ctx = getCtx()) {
    const candidates = [
        { role: 'char', book: ctx?.characters?.[ctx?.characterId]?.data?.extensions?.world },
        { role: 'chat', book: ctx?.chatMetadata?.world_info },
        { role: 'persona', book: ctx?.powerUserSettings?.persona_description_lorebook },
    ];
    const sources = [];
    for (const { role, book } of candidates) {
        if (typeof book !== 'string') continue;
        const trimmed = book.trim();
        if (trimmed) sources.push({ role, book: trimmed });
    }
    return sources;
}

/**
 * Distinct names of the books bound to the current chat.
 *
 * @param {ReturnType<typeof getCtx>} [ctx]
 * @returns {Set<string>} trimmed, deduplicated book names; possibly empty
 */
export function resolveAttachedLorebooks(ctx = getCtx()) {
    return new Set(resolveAttachedLorebookSources(ctx).map(source => source.book));
}

/**
 * @param {ReturnType<typeof getCtx>} ctx
 * @param {string} book
 */
export async function loadLorebookEntries(ctx, book) {
    const payload = await ctx.loadWorldInfo(book);
    const container = payload?.entries;
    const rows = Array.isArray(container)
        ? container.map(entry => [undefined, entry])
        : container && typeof container === 'object'
            ? Object.entries(container)
            : [];
    const entries = [];

    for (const [key, entry] of rows) {
        if (!entry || typeof entry !== 'object') continue;

        const sourceUid = parseUid(entry.uid);
        const uid = sourceUid ?? (key === undefined ? undefined : parseUid(key));
        if (uid === undefined) continue;

        const keyLabel = Array.isArray(entry.key) ? entry.key[0] : undefined;
        const label = entry.comment || entry.name || keyLabel || `Entry ${uid}`;
        entries.push({
            book,
            uid,
            label,
            content: typeof entry.content === 'string' ? entry.content : '',
            vectorized: Boolean(entry.vectorized),
        });
    }

    entries.sort((left, right) => left.uid - right.uid);
    return entries;
}

/** @param {ReturnType<typeof getCtx>} [ctx] */
export async function listLorebookNames(ctx = getCtx()) {
    const names = await ctx.getWorldInfoNames();
    return Array.isArray(names)
        ? names.filter(name => typeof name === 'string').sort((left, right) => left.localeCompare(right))
        : [];
}

/**
 * @param {ReturnType<typeof getCtx>} ctx
 * @param {unknown} selectedEntries
 */
export async function resolveManualLore(ctx, selectedEntries) {
    const refs = normalizeLoreConfig({
        mode: LORE_MODE.MANUAL,
        selectedEntries,
    }).selectedEntries;
    const books = new Map();

    await Promise.all([...new Set(refs.map(ref => ref.book))].map(async book => {
        try {
            const entries = await loadLorebookEntries(ctx, book);
            books.set(book, new Map(entries.map(entry => [entry.uid, entry])));
        } catch {
            books.set(book, new Map());
        }
    }));

    const contents = [];
    const entries = [];
    const missing = [];

    for (const ref of refs) {
        const entry = books.get(ref.book)?.get(ref.uid);
        if (!entry) {
            missing.push(ref);
            continue;
        }

        entries.push({ book: entry.book, uid: entry.uid, label: entry.label });
        const content = typeof ctx.substituteParams === 'function'
            ? ctx.substituteParams(entry.content)
            : entry.content;
        if (typeof content === 'string' && content.length > 0) contents.push(content);
    }

    return { text: contents.join('\n\n'), entries, missing };
}

/**
 * Consumed WORLD_INFO_ACTIVATED cache entries bound to the anchor post, or
 * null when the cache is absent / belongs to another chat or post.
 *
 * @param {ReturnType<typeof getCtx>} ctx
 * @param {{ anchorMsgId?: string, anchorSwipeIdx?: number }} input
 */
function getAnchorMatchedActivatedEntries(ctx, { anchorMsgId, anchorSwipeIdx }) {
    const cached = state.lastActivatedWorldInfo;
    if (!cached
        || cached.chatId !== ctx.chatId
        || cached.msgId === null
        || String(cached.msgId) !== String(anchorMsgId)
        || cached.swipeIdx !== anchorSwipeIdx) {
        return null;
    }
    return cached.entries;
}

/**
 * ATTACHED scope: lore strictly from the WORLD_INFO_ACTIVATED cache, filtered
 * to books bound to this chat. The dry-run getWorldInfoPrompt scan is NOT used
 * here — its worldInfoString is an origin-free blob, so global-panel entries
 * could not be separated out. Consequence: when the cache does not match the
 * anchor (manual regen of an older post, swipes), lore degrades to empty —
 * documented behaviour, not an error.
 *
 * @param {ReturnType<typeof getCtx>} ctx
 * @param {{ anchorMsgId?: string, anchorSwipeIdx?: number }} input
 */
async function collectAttachedLore(ctx, { anchorMsgId, anchorSwipeIdx }) {
    const empty = { text: '', entries: [], missing: [] };
    const attached = resolveAttachedLorebooks(ctx);
    if (!attached.size) return empty;

    const entries = getAnchorMatchedActivatedEntries(ctx, { anchorMsgId, anchorSwipeIdx });
    if (!entries) return empty;

    // Every activated entry of the matched books is taken — including
    // vectorized ones (no scan runs in this scope, so nothing can double).
    // Entries without a usable `world` are dropped: an activation we cannot
    // attribute to a bound book must not leak into a restricted prompt.
    const contents = [];
    const provenance = [];
    for (const entry of entries) {
        if (typeof entry?.world !== 'string' || !attached.has(entry.world)) continue;
        const uid = parseUid(entry.uid);
        const content = typeof entry.content === 'string' && entry.content.length > 0
            ? (typeof ctx.substituteParams === 'function'
                ? ctx.substituteParams(entry.content)
                : entry.content)
            : '';
        if (content) contents.push(content);
        if (uid !== undefined) {
            provenance.push({
                book: entry.world,
                uid,
                label: entry.comment || `Entry ${uid}`,
            });
        }
    }

    return { text: contents.join('\n\n'), entries: provenance, missing: [] };
}

/**
 * Collect automatically activated lore through SillyTavern's prompt API
 * and cached WORLD_INFO_ACTIVATED event data.
 *
 * scope 'all' (default): keyword/constant entries come from getWorldInfoPrompt
 * (the existing scan). Vectorized (and all other activated) entries come from
 * ST's WORLD_INFO_ACTIVATED event, which fires at the end of getWorldInfoPrompt
 * after the scan. We bind the cached data to the current anchor post
 * (chatId, msgId, swipeIdx) to avoid using stale data from a different post.
 *
 * scope 'attached': no scan at all — lore only from the anchor-bound cache,
 * filtered to books attached to this chat (see collectAttachedLore).
 *
 * @param {ReturnType<typeof getCtx>} ctx
 * @param {{ chatMessages: unknown, globalScanData: unknown, anchorMsgId?: string, anchorSwipeIdx?: number, scope?: string }} input
 */
export async function collectAutomaticLore(ctx, { chatMessages, globalScanData, anchorMsgId, anchorSwipeIdx, scope }) {
    if (scope === LORE_SCOPE.ATTACHED) {
        return collectAttachedLore(ctx, { anchorMsgId, anchorSwipeIdx });
    }

    // 1. keyword/constant entries — through ST getWorldInfoPrompt (existing scan).
    let scanText = '';
    if (typeof ctx?.getWorldInfoPrompt === 'function') {
        try {
            // CONTRACT — isDryRun is ALWAYS true here. A non-dry-run scan
            // re-emits WORLD_INFO_ACTIVATED and writes sticky/cooldown
            // timed-effects into chat_metadata outside ST's generation cycle.
            // The event fires BEFORE the new message is pushed to chat, so
            // binding to «the last post at event time» is wrong — see the
            // pending slot in events.js, which binds to the actually rendered
            // message. isDryRun and the binding must NOT be changed
            // independently — only together. Dry-run still returns
            // worldInfoString as usual.
            const result = await ctx.getWorldInfoPrompt(
                chatMessages,
                ctx.maxContext || 4096,
                true,
                globalScanData,
            );
            scanText = typeof result?.worldInfoString === 'string' ? result.worldInfoString : '';
        } catch { /* skip */ }
    }

    // 2. vectorized entries — from the WORLD_INFO_ACTIVATED cache, bound to the
    //    anchor post. scanText (worldInfoString) already contains every
    //    keyword/constant entry, and the WI event carries ALL activated entries,
    //    so we filter to vectorized-only. Without this, keyword/constant entries
    //    are injected twice (scanText + cache), doubling the lore block in the
    //    prompt — confirmed from a real debug dump.
    let activatedText = '';
    const activatedEntries = getAnchorMatchedActivatedEntries(ctx, { anchorMsgId, anchorSwipeIdx });
    if (activatedEntries) {
        const contents = activatedEntries
            .filter(e => e.vectorized)
            .map(e => typeof ctx.substituteParams === 'function'
                ? ctx.substituteParams(e.content)
                : e.content)
            .filter(c => typeof c === 'string' && c.length > 0);
        activatedText = contents.join('\n\n');
    }
    // else: cache does not match anchor — skip. Normal for CTA/regen when the
    // commented post is not the latest AI post.

    const text = [scanText, activatedText].filter(Boolean).join('\n\n');
    return { text, entries: [], missing: [] };
}

/** @param {string} value */
function hashFingerprint(value) {
    let hash = 0x811c9dc5;
    for (let index = 0; index < value.length; index++) {
        hash ^= value.charCodeAt(index);
        hash = Math.imul(hash, 0x01000193);
    }
    return (hash >>> 0).toString(36);
}

/** @param {unknown} value */
function normalizeString(value) {
    return typeof value === 'string' ? value : '';
}

// Both fingerprint builders must agree: 'assistant' (prefill) generates
// different commentary than the same text in 'system' position, so coercing
// it away here would let the feed cache serve stale posts after a role switch.
function normalizeJailbreakRole(value) {
    return ['system', 'user', 'assistant'].includes(value) ? value : 'system';
}

/**
 * Build the complete, normalized input contract for generation fingerprints.
 * Callers supply runtime settings plus the resolved style/profile data; this
 * function owns field selection so cache checks and generation cannot drift.
 * @param {{ settings?: object, loreConfig?: unknown, stylePrompt?: unknown, profile?: object|null }} [input]
 */
export function buildGenerationFingerprintInput(input = {}) {
    const settings = input.settings && typeof input.settings === 'object' ? input.settings : {};
    const profile = input.profile && typeof input.profile === 'object' ? input.profile : {};
    const parsedCount = parseInt(settings.userCount);
    const contextDepth = typeof settings.contextDepth === 'number' && Number.isFinite(settings.contextDepth)
        ? settings.contextDepth
        : null;
    const profileModel = profile.model ?? profile.modelName ?? profile.model_name ?? profile.settings?.model;

    return {
        loreConfig: normalizeLoreConfig(input.loreConfig),
        includeChatHistory: Boolean(settings.includeChatHistory),
        contextDepth,
        includePersona: Boolean(settings.includePersona),
        includeCharacterDescription: Boolean(settings.includeCharacterDescription),
        promptTemplate: normalizeString(settings.promptTemplate),
        stylePrompt: normalizeString(input.stylePrompt),
        userCount: Number.isFinite(parsedCount) && parsedCount !== 0 ? parsedCount : 5,
        enableJailbreakBlock: Boolean(settings.enableJailbreakBlock),
        jailbreakRole: normalizeJailbreakRole(settings.jailbreakRole),
        jailbreakText: normalizeString(settings.jailbreakText),
        apiSource: normalizeString(settings.apiSource),
        profileId: normalizeString(settings.profileId),
        customEndpoint: normalizeString(settings.customEndpoint),
        customModel: normalizeString(settings.customModel),
        profileApi: normalizeString(profile.api),
        profileModel: normalizeString(profileModel),
    };
}

/** @param {unknown} input */
export function buildGenerationFingerprint(input) {
    const source = input && typeof input === 'object' ? input : {};
    const contextDepth = typeof source.contextDepth === 'number' && Number.isFinite(source.contextDepth)
        ? source.contextDepth
        : null;
    const parsedCount = parseInt(source.userCount);
    const normalized = {
        loreConfig: normalizeLoreConfig(source.loreConfig),
        includeChatHistory: Boolean(source.includeChatHistory),
        contextDepth,
        includePersona: Boolean(source.includePersona),
        includeCharacterDescription: Boolean(source.includeCharacterDescription),
        promptTemplate: normalizeString(source.promptTemplate),
        stylePrompt: normalizeString(source.stylePrompt),
        userCount: Number.isFinite(parsedCount) && parsedCount !== 0 ? parsedCount : 5,
        enableJailbreakBlock: Boolean(source.enableJailbreakBlock),
        jailbreakRole: normalizeJailbreakRole(source.jailbreakRole),
        jailbreakText: normalizeString(source.jailbreakText),
        apiSource: normalizeString(source.apiSource),
        profileId: normalizeString(source.profileId),
        customEndpoint: normalizeString(source.customEndpoint),
        customModel: normalizeString(source.customModel),
        profileApi: normalizeString(source.profileApi),
        profileModel: normalizeString(source.profileModel),
    };

    return `v1-${hashFingerprint(JSON.stringify(normalized))}`;
}
