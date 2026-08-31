// @ts-check
/**
 * DS Comments — Generator module
 * API calls, prompt building, context assembly.
 *
 * {{count}} is substituted before ST macros; the scene reaches the model as
 * [Previously — ...] (background) and [Current chapter: ...] (anchor), each
 * source block as its own user message (see assemblePrompt).
 */

import { state, getCtx, BASE_URL, resolveSTMacro, buildPrompt, extractText, trace, warn, error, tr, escapeHtml, isCommentaryGenerationEligible, resolveLastAIPost, beginGenerationEpoch, isEpochCurrent, LF_PROMPTS, pushRestoreLog, setLastFpDiag, getLastFpDiag, saveSettings } from './core.js';
import { PROMPT_CONTRACT } from './prompt-contract.js';
import { renderMessages } from './renderer.js';
import { recordEvent } from './event-log.js';
import { parseCommentary } from './parser.js';
import { getCachedPost, setCurrentPost, storeFeed, showCurrentFeed, getCurrentFeedSource } from './cache.js';
import { getChatLoreConfig, LORE_MODE, LORE_SCOPE, collectAutomaticLore, resolveManualLore, buildGenerationFingerprintInput, buildGenerationFingerprint } from './lorebooks.js';
import { showFeedHtml as setFeedText } from './ui/feed-controller.js';
import { setStatus, syncRegenVisual } from './ui/chrome.js';
import { playNotificationSound } from './sound.js';

// ── Prompt Cache (builtin .md templates, keyed by name) ──
const _builtinPromptCache = {};

/**
 * Load the active prompt template text (raw, macros NOT yet substituted).
 *
 * Resolution order (edit-on-place):
 *   1. User template in localforage DSComments_prompts[templateName] (working copies)
 *   2. Builtin .md file from chat-styles/<name>.md (cached)
 *   3. Fallback: builtin 'main'
 *
 * @returns {Promise<string>} raw template text
 */
export async function loadStylePrompt() {
    const settings = state.settings;
    const name = settings.promptTemplate || 'main';

    // 1. User template (localforage working copy)
    try {
        const userPrompts = await SillyTavern.libs.localforage.getItem(LF_PROMPTS) || {};
        // hasOwn, not truthiness: an empty string is a legitimately saved (if
        // unusual) template and must not silently fall through to the builtin.
        if (Object.hasOwn(userPrompts, name)) return userPrompts[name];
    } catch { /* fall through */ }

    // 2. Builtin .md (cached) — vibe only, contract lives in code
    if (_builtinPromptCache[name]) return _builtinPromptCache[name];
    try {
        const resp = await fetch(`${BASE_URL}/chat-styles/${name}.md`);
        if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
        const text = await resp.text();
        _builtinPromptCache[name] = text;
        return text;
    } catch (e) {
        warn(`Failed to load prompt template ${name}.md:`, e);
        // 3. Fallback to main builtin (persisted so the missing template name
        // does not keep 404ing on every generation).
        if (name !== 'main') {
            settings.promptTemplate = 'main';
            saveSettings();
            return loadStylePrompt();
        }
        return '';
    }
}

/**
 * Build the input consumed by SillyTavern's automatic lore activation.
 */
function buildLoreScanInput(ctx) {
    const chatMessages = (ctx.chat || [])
        .filter(m => m && !m.is_system && !m.is_hidden)
        .map(m => {
            const name = m.is_user ? (ctx.name1 || 'User') : (m.name || ctx.name2 || 'Character');
            return `${name}: ${String(m.mes || '')}`;
        })
        .reverse();

    const globalScanData = { trigger: 'quiet' };
    try {
        if (ctx.characterId !== undefined && ctx.characters?.[ctx.characterId]) {
            const ch = ctx.characters[ctx.characterId];
            if (ch.description) globalScanData.characterDescription = ch.description;
            if (ch.personality) globalScanData.characterPersonality = ch.personality;
            if (ch.scenario) globalScanData.scenario = ch.scenario;
        }
        const pd = ctx.powerUserSettings?.persona_description;
        if (pd) globalScanData.personaDescription = pd;
    } catch { /* skip */ }

    return { chatMessages, globalScanData };
}

// Test-only export (NODE_TEST guard — invisible in the ST browser host).
export const _testBuildLoreScanInput = typeof process !== 'undefined' && process?.env?.NODE_TEST === '1'
    ? (ctx) => buildLoreScanInput(ctx)
    : undefined;

/**
 * Build context block for the prompt (persona, character description, world info).
 */
function buildContextParts(ctx, lore) {
    const settings = state.settings;
    const parts = { persona: '', character: '', lore: '' };
    if (!ctx?.chatId) return parts;

    if (settings.includePersona) {
        try {
            const pd = ctx.powerUserSettings?.persona_description;
            if (pd) parts.persona = `[Persona: ${pd}]`;
        } catch { /* skip */ }
    }
    if (settings.includeCharacterDescription) {
        try {
            if (ctx.characterId !== undefined && ctx.characters?.[ctx.characterId]) {
                const ch = ctx.characters[ctx.characterId];
                if (ch.description) parts.character = `[Character: ${ch.name}\n${ch.description}]`;
            }
        } catch { /* skip */ }
    }
    if (lore?.text) parts.lore = `[Details of the fictional world the RP is set in:\n${lore.text}]`;
    return parts;
}

function buildContextBlock(ctx, lore) {
    return Object.values(buildContextParts(ctx, lore)).filter(Boolean).join('\n\n');
}

/**
 * Read the text of a specific swipe for a message. ST keeps msg.mes in sync
 * with msg.swipes[msg.swipe_id]; the standard prompt builder reads mes. But our
 * local swipe index (state.currentSwipeIdx) can differ from msg.swipe_id after
 * a horizontal commentary navigation that intentionally does NOT touch the chat.
 * For the anchor — the exact swipe the user is commenting on — we must read the
 * requested index, not the active one, so the prompt text and the cache key agree.
 */
function readSwipeText(msg, swipeIdx) {
    const idx = parseInt(swipeIdx) || 0;
    if (Array.isArray(msg?.swipes) && msg.swipes[idx] !== undefined) {
        return String(msg.swipes[idx] ?? '');
    }
    return String(msg?.mes ?? '');
}

/**
 * Build chat history block for context (optional — gated by includeChatHistory).
 *
 * anchorSwipeIdx: the swipe index whose text the anchor message should use.
 *   Defaults to msg.swipe_id when omitted (pre-existing behaviour for callers
 *   that don't track a separate local index). Only the anchor is affected —
 *   earlier messages always use their active mes (we never navigate those).
 */
function buildChatHistoryParts(anchorMsgId, anchorSwipeIdx, ctx = getCtx()) {
    try {
        const settings = state.settings;
        const chat = ctx.chat;
        if (!chat || !settings.includeChatHistory) return { earlier: [], anchor: '' };
        const depth = Math.max(2, parseInt(settings.contextDepth) || 4);
        const endIdx = anchorMsgId !== undefined && anchorMsgId !== null ? parseInt(anchorMsgId) + 1 : chat.length;
        const recent = chat.slice(0, endIdx).filter(m => !m.is_system && !m.is_hidden).slice(-depth);
        if (!recent.length) return { earlier: [], anchor: '' };
        const fmtLine = m => {
            const name = m.is_user ? (ctx.name1 || 'User') : (m.name || 'AI');
            return `${name}: ${extractText(m.mes || '')}`;
        };
        const anchor = recent[recent.length - 1];
        const anchorName = anchor.is_user ? (ctx.name1 || 'User') : (anchor.name || 'AI');
        const anchorText = extractText(readSwipeText(anchor, anchorSwipeIdx));
        return {
            earlier: recent.slice(0, -1).map(fmtLine),
            anchor: `[Current chapter:\n${anchorName}: ${anchorText}]`,
        };
    } catch { return { earlier: [], anchor: '' }; }
}

function buildChatHistory(anchorMsgId, anchorSwipeIdx) {
    const { earlier, anchor } = buildChatHistoryParts(anchorMsgId, anchorSwipeIdx);
    const previous = earlier.length
        ? `[Previously — earlier chapters; you've read and remember them, do NOT react to these as current:\n${earlier.join('\n')}]`
        : '';
    return [previous, anchor].filter(Boolean).join('\n\n');
}

// Test-only export (NODE_TEST guard — invisible in the ST browser host).
export const _testBuildChatHistory = typeof process !== 'undefined' && process?.env?.NODE_TEST === '1'
    ? (anchorMsgId, swipeIdx) => buildChatHistory(anchorMsgId, swipeIdx)
    : undefined;

/**
 * Each source block becomes its own {role:'user'} message instead of one
 * joined blob: the request log then shows where the persona / character card /
 * lorebook / chapters are, and backends get clean message boundaries. The
 * split changes transport only — block text stays byte-identical to a single
 * '\n\n'-joined string, so cache fingerprints and prompt content do not
 * change.
 *
 * jailbreakRole 'assistant' is a prefill: the jailbreak leaves system/user
 * messages untouched and returns as `assistantPrefill`, which the connection
 * layer appends as a trailing {role:'assistant'} message — the model continues
 * its "own" answer. ST's request pipeline natively recognises a trailing
 * assistant message as prefill (shared.js passes message arrays through as-is;
 * TextCompletionService.constructPrompt formats the trailing assistant as
 * prefill for text-completion backends).
 */
function assemblePrompt(parts) {
    const userMessages = [
        parts.persona,
        parts.character,
        parts.lore,
        parts.earlier.length
            ? `[Previously — earlier chapters; you've read and remember them, do NOT react to these as current:\n${parts.earlier.join('\n')}]`
            : '',
        parts.anchor,
    ].filter(Boolean);
    if (!userMessages.length) userMessages.push('Generate the commentary now.');
    let systemPrompt = parts.systemPrompt;
    let assistantPrefill = '';
    if (parts.jailbreak) {
        if (parts.jailbreakRole === 'user') userMessages[0] = `${parts.jailbreak}\n\n${userMessages[0]}`;
        else if (parts.jailbreakRole === 'assistant') assistantPrefill = parts.jailbreak;
        else systemPrompt = `${systemPrompt}\n\n${parts.jailbreak}`;
    }
    return { systemPrompt, userMessages, assistantPrefill };
}

function assembleCompletePrompt({ ctx, stylePrompt, lore, anchorMsgId, anchorSwipeIdx }) {
    const settings = state.settings;
    const context = buildContextParts(ctx, lore);
    const history = buildChatHistoryParts(anchorMsgId, anchorSwipeIdx, ctx);
    const parts = {
        ...context,
        ...history,
        systemPrompt: buildPrompt(stylePrompt, {
            count: parseInt(settings.userCount) || 5,
            contract: PROMPT_CONTRACT,
        }),
        jailbreak: settings.enableJailbreakBlock
            ? resolveSTMacro(String(settings.jailbreakText || '').trim())
            : '',
        jailbreakRole: settings.jailbreakRole,
    };
    return {
        ...assemblePrompt(parts),
        selectedHistoryMessages: history.earlier.length,
        loreIncluded: Boolean(context.lore),
        personaIncluded: Boolean(context.persona),
        characterIncluded: Boolean(context.character),
        jailbreakIncluded: Boolean(parts.jailbreak),
    };
}

/**
 * Call the generation API (connection profile or custom endpoint).
 */
let _testFakeApi = null;

async function callGenerationAPI(systemPrompt, userMessages, assistantPrefill, signal) {
    if (_testFakeApi) return _testFakeApi(systemPrompt, userMessages, assistantPrefill, signal);
    const settings = state.settings;

    if (settings.apiSource === 'profile') {
        return await callConnectionProfile(systemPrompt, userMessages, assistantPrefill, signal);
    }
    if (settings.apiSource === 'custom') {
        return await callCustomEndpoint(systemPrompt, userMessages, assistantPrefill, signal);
    }
    // Unreachable (core.js normalizes apiSource to 'profile' on load), but guard
    // against silent fallback to nothing.
    throw new Error(tr('No generation source selected. Choose Profile or Custom in DS Comments settings.', 'dscomments.error.noSource'));
}

/**
 * Generate via connection profile.
 */
async function callConnectionProfile(systemPrompt, userMessages, assistantPrefill, signal) {
    const { generateWithProfile } = await import('./connection.js');
    return await generateWithProfile(state.settings.profileId, systemPrompt, userMessages, assistantPrefill, signal);
}

/**
 * Generate via custom OpenAI-compatible endpoint.
 */
async function callCustomEndpoint(systemPrompt, userMessages, assistantPrefill, signal) {
    const { generateWithCustomEndpoint } = await import('./connection.js');
    const settings = state.settings;
    return await generateWithCustomEndpoint(
        systemPrompt, userMessages, assistantPrefill, signal,
        settings.customEndpoint, settings.customModel,
    );
}

async function buildCurrentFingerprintInput(settings, loreConfig, stylePrompt) {
    let profile = null;
    let profileResolved = false;
    if (settings.apiSource === 'profile' && settings.profileId) {
        const { getProfileDetails } = await import('./connection.js');
        profile = await getProfileDetails(settings.profileId);
        profileResolved = !!profile;
    }
    const input = buildGenerationFingerprintInput({ settings, loreConfig, stylePrompt, profile });
    setLastFpDiag(`apiSource=${settings.apiSource} profileResolved=${profileResolved} profileApi=${JSON.stringify(input.profileApi)} profileModel=${JSON.stringify(input.profileModel)} styleLen=${input.stylePrompt.length}`);
    return input;
}

// Fingerprint cache for the CHARACTER_MESSAGE_RENDERED pre-check.
// getCurrentGenerationFingerprint awaits loadStylePrompt() and (when
// apiSource === 'profile') getProfileDetails() on every call; the render
// handler fires on every AI message, and on rapid renders (streaming, swipe
// redraw) this duplicated async work — localforage + profile lookup — runs
// per message even when generation would not occur. The fingerprint is a
// pure function of (settings, loreConfig, stylePrompt, profile); those
// inputs only change across chat switches (CHAT_CHANGED bumps the epoch),
// lore-config changes (the lore picker's invalidate bumps it) and profile
// updates (CONNECTION_PROFILE_UPDATED). Settings edits that do NOT bump the
// epoch (apiSource / promptTemplate / style / profileId / count / depth) are
// covered by `_fpSettingsKey` — a compact serialization of the fields that
// flow into buildGenerationFingerprintInput (see below). Cache key =
// (epoch, chatId, settings key): a hit skips both awaits entirely. If a
// relevant input ever changes without any key component changing, the worst
// case is a stale cache-query returning a cache miss at the cached fp —
// generation still runs and builds the real fp.
let _fpCacheKey = null;   // `${epoch}:${chatId}:${settingsKey}`
let _fpCacheValue = null; // { fp: string, diag: string }

export async function getCurrentGenerationFingerprint(ctx = getCtx()) {
    const settings = state.settings;
    const chatId = ctx?.chatId;
    const cacheKey = `${state.generationEpoch}:${chatId}:${_fpSettingsKey(settings)}`;
    if (_fpCacheKey === cacheKey && _fpCacheValue) {
        pushRestoreLog('fingerprint', `cache hit diag=${_fpCacheValue.diag} fp=${_fpCacheValue.fp}`);
        return _fpCacheValue.fp;
    }
    const stylePrompt = await loadStylePrompt();
    const input = await buildCurrentFingerprintInput(settings, getChatLoreConfig(ctx), stylePrompt);
    const fp = buildGenerationFingerprint(input);
    const diag = getLastFpDiag();
    _fpCacheKey = cacheKey;
    _fpCacheValue = { fp, diag };
    pushRestoreLog('fingerprint', `${diag} fp=${fp} (computed, cached)`);
    return fp;
}

/**
 * Compact stringification of the fingerprint-relevant settings fields. Used
 * only as a cache-key suffix — must cover every settings.* field read by
 * buildGenerationFingerprintInput (lorebooks.js). When the user edits any of
 * these without bumping the epoch, the key changes and the cache misses.
 */
function _fpSettingsKey(s) {
    return [
        s.apiSource, s.profileId, s.customEndpoint, s.customModel,
        s.userCount, s.contextDepth, s.includeChatHistory, s.includePersona,
        s.includeCharacterDescription, s.promptTemplate, s.enableJailbreakBlock,
        s.jailbreakRole, s.jailbreakText,
    ].join('|');
}

/**
 * Resolve a stored feed source only when it still addresses a generatable chat
 * message and an existing swipe. A noSave pin can outlive message deletion,
 * hiding, or a start-screen session, so it must never become an unsafe explicit
 * generation target.
 */
function normalizeGenerationTarget(target, ctx) {
    if (!target || target.msgId === null || target.msgId === undefined) return null;
    const messageIdx = Number(target.msgId);
    const swipeIdx = Number(target.swipeIdx ?? 0);
    if (!Number.isInteger(messageIdx) || messageIdx < 0
        || !Number.isInteger(swipeIdx) || swipeIdx < 0) return null;
    const msg = ctx.chat?.[messageIdx];
    if (!isCommentaryGenerationEligible(msg)) return null;
    if (Array.isArray(msg.swipes) ? msg.swipes[swipeIdx] === undefined : swipeIdx !== 0) return null;
    return { msgId: String(messageIdx), swipeIdx };
}

/**
 * Resolve an implicit generation request. A forced noSave regeneration favors
 * the source of the visible pin; otherwise follow the current chat position,
 * then use the normal last-AI fallback.
 */
function resolveImplicitGenerationTarget(forceRegenerate, ctx) {
    if (state.settings.noSaveMode && forceRegenerate) {
        const pinned = normalizeGenerationTarget(getCurrentFeedSource(), ctx);
        if (pinned) return { ...pinned, source: 'pinnedFeed' };
    }
    const current = normalizeGenerationTarget({
        msgId: state.currentPostId,
        swipeIdx: state.currentSwipeIdx,
    }, ctx);
    if (current) return { ...current, source: 'currentPost' };
    const last = resolveLastAIPost();
    return last ? { ...last, source: 'lastAI' } : null;
}

/**
 * Main generation function.
 *
 * Macro order: buildPrompt() substitutes {{count}} (non-standard) BEFORE
 * ctx.substituteParams, then ST resolves {{random::}}, {{user}}, {{char}}.
 * No external user wrapper — blocks from buildChatHistory() are self-contained.
 *
 * @param {string|null} targetMsgId chat[] index as string; null = auto-detect
 * @param {number|null} targetSwipeIdx swipe_id; null = auto-detect
 * @param {boolean} forceRegenerate if true, ignore cache
 */
export async function generateFeed(targetMsgId, targetSwipeIdx, forceRegenerate = false) {
    const settings = state.settings;
    if (state.generationInProgress) return;

    // Resolve which post/swipe to generate for. Explicit event targets always
    // win. An explicit manual regeneration in noSave preserves the provenance
    // of the one visible pinned feed instead of following a later scroll pick.
    let resolvedMsgId, resolvedSwipeIdx, msgSource;
    if (targetMsgId !== null && targetMsgId !== undefined) {
        resolvedMsgId = String(targetMsgId);
        resolvedSwipeIdx = targetSwipeIdx !== null && targetSwipeIdx !== undefined ? parseInt(targetSwipeIdx) : 0;
        msgSource = 'explicit';
    } else {
        const target = resolveImplicitGenerationTarget(forceRegenerate, getCtx());
        if (!target) { warn('generateFeed: no AI post found'); return; }
        resolvedMsgId = target.msgId;
        resolvedSwipeIdx = target.swipeIdx;
        msgSource = target.source;
    }
    trace('generateFeed', {
        target: `#${resolvedMsgId}[${resolvedSwipeIdx}]`,
        source: msgSource,
        force: !!forceRegenerate,
        noSaveMode: !!settings.noSaveMode,
    });
    const generationStartedAt = performance.now();
    const phaseMs = {};
    let outcome = 'running';
    const markPhase = (name, startedAt) => { phaseMs[name] = Math.round(performance.now() - startedAt); };
    const recordStale = (reason) => {
        outcome = `stale-${reason}`;
        const durationMs = Math.round(performance.now() - generationStartedAt);
        recordEvent('warn', `event=generation_stale target=#${resolvedMsgId}[${resolvedSwipeIdx}] reason=${reason} durationMs=${durationMs}`);
    };
    recordEvent('log', `event=generation_start target=#${resolvedMsgId}[${resolvedSwipeIdx}] source=${msgSource} force=${!!forceRegenerate} noSave=${!!settings.noSaveMode}`);

    // Snapshot chat-scoped generation inputs before any asynchronous resolution.
    const ctx = getCtx();
    const loreConfig = getChatLoreConfig(ctx);
    const loreScanInput = buildLoreScanInput(ctx);

    state.generationTarget = {
        chatId: ctx?.chatId ?? null,
        msgId: resolvedMsgId,
        swipeIdx: resolvedSwipeIdx,
    };
    state.generationObservedTarget = null;
    recordEvent('log', `event=generation_target chat=${ctx?.chatId || 'none'} target=#${resolvedMsgId}[${resolvedSwipeIdx}]`);

    state.generationInProgress = true;
    // No long navLockUntil here: the scroll observer reads only
    // generationInProgress in handleBestVisible, and the epoch guard already
    // discards stale results on a mid-flight chat change, while a long
    // generator lock starves scroll-follow on mobile (every pick is dropped
    // until the lock expires). The post-gen settle buffer is set in the
    // finally block below.
    const generationOwner = Symbol('generation');
    const controller = new AbortController();
    state.generationOwner = generationOwner;
    state.abortController = controller;
    const signal = controller.signal;
    // Snapshot the epoch before any await. If the chat changes mid-flight, the
    // epoch bump makes isEpochCurrent() return false and we discard the result.
    const epoch = beginGenerationEpoch();

    const launcherBtn = document.getElementById('dsc_launcher');
    if (launcherBtn) launcherBtn.classList.add('dsc_generating');
    setFeedText('');   // clear feed → empty-state renders blank (generating) instead of CTA
        setStatus(tr('Generation in progress', 'dscomments.status.generating'), { isAction: true, actionLabel: tr('Cancel', 'dscomments.action.cancel') });
    syncRegenVisual();   // ⟳ → spinner (Lucide)

    try {
        const phaseStartedAt = performance.now();
        const stylePrompt = await loadStylePrompt();
        markPhase('style', phaseStartedAt);
        if (!isEpochCurrent(epoch)) {
            trace('generateFeed: discarding stale result (epoch changed during style load)');
            recordStale('style-load');
            return;
        }
        if (!stylePrompt) throw new Error(tr('Prompt template could not be loaded', 'dscomments.error.noTemplate'));

        const fingerprintStartedAt = performance.now();
        const generationInput = await buildCurrentFingerprintInput(settings, loreConfig, stylePrompt);
        markPhase('fingerprint', fingerprintStartedAt);
        if (!isEpochCurrent(epoch)) {
            trace('generateFeed: discarding stale result (epoch changed during fingerprint input resolution)');
            recordStale('fingerprint');
            return;
        }
        const generationFp = buildGenerationFingerprint(generationInput);

        // noSaveMode / cache. Style must be loaded first because its text is part
        // of the generation fingerprint.
        if (!settings.noSaveMode && !forceRegenerate) {
            const cached = getCachedPost(resolvedMsgId, resolvedSwipeIdx, generationFp);
            if (cached) {
                if (!isEpochCurrent(epoch)) {
                    trace('generateFeed: discarding stale cache (epoch changed before render)');
                    recordStale('cache-render');
                    return;
                }
                setFeedText(cached);
                setCurrentPost(resolvedMsgId, resolvedSwipeIdx);
                outcome = 'cache-hit';
                return;
            }
        }

        // Per-chat master toggle: when lore is disabled, no resolution runs at
        // all (neither ST activation nor manual loading) and no block is added.
        let lore = { text: '', entries: [], missing: [] };
        const loreStartedAt = performance.now();
        const loreScope = loreConfig.autoScope ?? LORE_SCOPE.ALL;
        if (loreConfig.enabled) {
            try {
                lore = loreConfig.mode === LORE_MODE.MANUAL
                    ? await resolveManualLore(ctx, loreConfig.selectedEntries)
                    : await collectAutomaticLore(ctx, {
                          ...loreScanInput,
                          anchorMsgId: resolvedMsgId,
                          anchorSwipeIdx: resolvedSwipeIdx,
                          scope: loreScope,
                      });
            } catch (e) {
                warn('Lorebook resolution error:', e);
                recordEvent('warn', `event=lore_resolution result=error mode=${loreConfig.mode} scope=${loreScope} target=#${resolvedMsgId}[${resolvedSwipeIdx}] error=${e?.message || e}`);
            }
        }
        markPhase('lore', loreStartedAt);
        trace('Lorebook context attached', {
            enabled: loreConfig.enabled,
            mode: loreConfig.mode,
            scope: loreScope,
            attached: Boolean(lore.text),
            entries: lore.entries,
            missing: lore.missing,
        });
        if (loreConfig.enabled && loreConfig.mode === LORE_MODE.AUTOMATIC) {
            // Scope diagnostics: in attached mode a cache miss means the lore
            // block is legitimately empty (anchor mismatch), so the dump must
            // show why instead of looking like a resolution failure.
            const cacheMatched = Boolean(state.lastActivatedWorldInfo
                && state.lastActivatedWorldInfo.chatId === ctx?.chatId
                && state.lastActivatedWorldInfo.msgId !== null
                && String(state.lastActivatedWorldInfo.msgId) === String(resolvedMsgId)
                && state.lastActivatedWorldInfo.swipeIdx === resolvedSwipeIdx);
            recordEvent('log', `event=lore_resolution result=${lore.text ? 'attached' : 'empty'} mode=automatic scope=${loreScope} cache=${cacheMatched ? 'hit' : 'miss'} entries=${lore.entries.length} target=#${resolvedMsgId}[${resolvedSwipeIdx}]`);
        }

        const promptStartedAt = performance.now();
        const assembled = assembleCompletePrompt({
            ctx,
            stylePrompt,
            lore,
            anchorMsgId: resolvedMsgId,
            anchorSwipeIdx: resolvedSwipeIdx,
        });
        markPhase('prompt', promptStartedAt);
        if (!isEpochCurrent(epoch)) {
            trace('generateFeed: discarding stale result (epoch changed during context assembly)');
            recordStale('prompt');
            return;
        }
        const { systemPrompt, userMessages, assistantPrefill } = assembled;
        const jailbreakBlock = assembled.jailbreakIncluded;

        // Prompt assembly summary (block sizes only, no content).
        trace('generateFeed: prompt built', {
            anchor: `#${resolvedMsgId}[${resolvedSwipeIdx}]`,
            historyMessages: assembled.selectedHistoryMessages,
            loreIncluded: assembled.loreIncluded,
            personaIncluded: assembled.personaIncluded,
            characterIncluded: assembled.characterIncluded,
            systemChars: systemPrompt.length,
            userChars: userMessages.reduce((total, message) => total + message.length, 0),
            prefillChars: assistantPrefill.length,
            jailbreak: !!jailbreakBlock,
            apiSource: settings.apiSource,
        });

        const apiStartedAt = performance.now();
        let rawText;
        try {
            rawText = await callGenerationAPI(systemPrompt, userMessages, assistantPrefill, signal);
        } catch (cause) {
            const apiDurationMs = Math.round(performance.now() - apiStartedAt);
            phaseMs.api = apiDurationMs;
            recordEvent('error', `event=generation_api target=#${resolvedMsgId}[${resolvedSwipeIdx}] result=error durationMs=${apiDurationMs} name=${cause?.name || 'Error'} error=${cause?.message || cause}`);
            throw cause;
        }
        const apiDurationMs = Math.round(performance.now() - apiStartedAt);
        phaseMs.api = apiDurationMs;
        recordEvent('log', `event=generation_api target=#${resolvedMsgId}[${resolvedSwipeIdx}] result=success durationMs=${apiDurationMs} responseChars=${String(rawText || '').length}`);

        // Epoch check after the await: the chat may have changed while we generated.
        if (!isEpochCurrent(epoch)) {
            trace('generateFeed: discarding stale result (epoch changed mid-flight)');
            recordStale('api');
            return;
        }

        if (!rawText) throw new Error(tr('The model returned an empty response', 'dscomments.error.emptyResponse'));

        trace('parseCommentary: raw response length', rawText.length);

        const parseStartedAt = performance.now();
        const messages = parseCommentary(rawText);
        markPhase('parse', parseStartedAt);
        if (!messages) {
            recordEvent('warn', `event=generation_parse target=#${resolvedMsgId}[${resolvedSwipeIdx}] result=error responseChars=${rawText.length}`);
            throw new Error(tr('Could not parse the commentary.', 'dscomments.error.parse'));
        }
        recordEvent('log', `event=generation_parse target=#${resolvedMsgId}[${resolvedSwipeIdx}] result=success messages=${messages.length} responseChars=${rawText.length}`);

        const html = renderMessages(messages);

        // Re-check right before the irreversible writes — the chat could have changed
        // during parse/render too.
        if (!isEpochCurrent(epoch)) {
            trace('generateFeed: discarding stale result (epoch changed before store)');
            recordStale('store');
            return;
        }

        setFeedText(html);
        storeFeed(html, resolvedMsgId, resolvedSwipeIdx, generationFp);
        outcome = 'stored-and-rendered';
        recordEvent('log', `event=generation_store target=#${resolvedMsgId}[${resolvedSwipeIdx}] result=success htmlChars=${html.length}`);
        setCurrentPost(resolvedMsgId, resolvedSwipeIdx);
        playNotificationSound();
    } catch (e) {
        // Chat changed during generation: CHAT_CHANGED bumped the epoch and
        // already restored the new chat's feed. Discard this stale result
        // instead of overwriting the restore with a cancelled/error overlay.
        if (!isEpochCurrent(epoch)) {
            trace('generateFeed: discarding stale error (epoch changed)', e?.name);
            recordStale('error');
            return;
        }
        if (e.name === 'AbortError') {
            outcome = 'cancelled';
            recordEvent('warn', `generateFeed aborted #${resolvedMsgId}[${resolvedSwipeIdx}]`);
            // noSaveMode: restore pinned feed so the panel isn't empty; saveMode: overlay.
            if (settings.noSaveMode) {
                showCurrentFeed();
            } else {
                setFeedText(`<div class="dsc_status dsc_cancelled"><i class="fa-solid fa-circle-stop"></i> ${tr('Generation cancelled', 'dscomments.status.cancelled')}</div>`);
            }
            return;
        }
        outcome = 'error';
        error('generateFeed error:', e);
        recordEvent('error', `generateFeed error #${resolvedMsgId}[${resolvedSwipeIdx}]: ${e?.message || e}`);
        setFeedText(`<div class="dsc_status dsc_error"><i class="fa-solid fa-circle-exclamation"></i> ${escapeHtml(tr('Error: {msg}', 'dscomments.status.error').replace('{msg}', e.message))}</div>`);
    } finally {
        const ownsGeneration = state.generationOwner === generationOwner;
        const observed = ownsGeneration ? state.generationObservedTarget : null;
        const viewChanged = Boolean(observed)
            && (observed.msgId !== resolvedMsgId || observed.swipeIdx !== resolvedSwipeIdx);
        const durationMs = Math.round(performance.now() - generationStartedAt);
        const finish = {
            target: { chatId: ctx?.chatId ?? null, msgId: resolvedMsgId, swipeIdx: resolvedSwipeIdx },
            observedTarget: observed ? { ...observed } : null,
            outcome,
            ownerCurrent: ownsGeneration,
            viewChanged,
            durationMs,
            phaseMs: { ...phaseMs },
        };
        recordEvent(
            'log',
            `event=generation_finish target=#${resolvedMsgId}[${resolvedSwipeIdx}] outcome=${outcome} durationMs=${durationMs} ownerCurrent=${ownsGeneration} viewChanged=${viewChanged} observed=${observed ? `#${observed.msgId}[${observed.swipeIdx}]` : 'none'} phases=${JSON.stringify(phaseMs)}`
        );
        // State resets only when we still own the generation - a newer gen that
        // started after a chat change must not have its flags cleared.
        if (state.generationOwner === generationOwner) {
            state.lastGenerationDiagnostics = finish;
            state.generationInProgress = false;
            state.abortController = null;
            state.generationOwner = null;
            state.generationTarget = null;
            state.generationObservedTarget = null;
            // Short one-frame settle buffer so the post-gen observer pick does
            // not clobber the feed we just wrote. A long start-lock here is
            // the primary cause of observer starvation on mobile; this single
            // short settle lets scroll-follow resume immediately after
            // generation.
            // Math.max: don't lower a higher lock set by the restore path
            // (index.js) — same discipline, so a finally during a restore
            // window doesn't shorten it.
            state.navLockUntil = Math.max(state.navLockUntil, Date.now() + 250);
        }
        // UI cleanup (launcher spinner, status overlay, regen visual) must run
        // both on normal completion (owner matched -> nulled above) and on a
        // chat-change abort (owner already null - no newer gen owns the UI).
        // Skip only when a different generation has taken ownership.
        if (state.generationOwner === null) {
            if (launcherBtn) launcherBtn.classList.remove('dsc_generating');
            setStatus('');
            syncRegenVisual();
        }
    }
}

// Test-only entry: injects a fake API so epoch-guard tests control completion.
// NODE_TEST guard keeps this invisible in the ST browser host.
export const _testGenerateFeed = typeof process !== 'undefined' && process?.env?.NODE_TEST === '1'
    ? async (targetMsgId, targetSwipeIdx, forceRegenerate, fakeApi) => {
        // Monkey-patch callGenerationAPI for this one call via a closure flag.
        _testFakeApi = fakeApi;
        try {
            return await generateFeed(targetMsgId, targetSwipeIdx, forceRegenerate);
        } finally {
            _testFakeApi = null;
        }
    }
    : undefined;

// Test-only: simulate the generation `finally` cleanup tail without running an
// actual LLM call. Lets lock-duration tests assert that generation completion
// trims navLockUntil to a short settle window (<1s) instead of leaving a long
// suppression that starves the scroll observer. NODE_TEST guard keeps this
// invisible in the ST browser host.
export const _testReleaseGenerationCleanup = typeof process !== 'undefined' && process?.env?.NODE_TEST === '1'
    ? (opts = {}) => {
        state.generationInProgress = false;
        state.abortController = null;
        state.generationOwner = null;
        state.generationTarget = null;
        state.generationObservedTarget = null;
        // Matches the 250ms settle buffer set in generateFeed's `finally` block.
        state.navLockUntil = Date.now() + (opts.settleMs ?? 250);
    }
    : undefined;
