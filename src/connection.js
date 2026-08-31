// @ts-check
/**
 * DS Comments — Connection Profile integration + custom endpoint
 * Provides access to ST Connection Profiles (connectionManager extension)
 * and an OpenAI-compatible custom endpoint.
 *
 * API key read via getApiKey() from core.js (stored in localforage, NOT in settings JSON).
 */

import { warn, trace, error, tr, getApiKey, state, showConfirmModal, notifyUser, persistSettingsNow, MODULE_NAME } from './core.js';

let _cmReady = false;
let _cmReadyChecked = false;

/**
 * Get connection manager profiles — tries ctx.extensionSettings first,
 * falls back to global extension_settings (used by ST internals).
 */
function _getCMProfiles() {
    try {
        const ctx = SillyTavern.getContext();
        if (ctx?.extensionSettings?.connectionManager?.profiles?.length > 0) {
            return ctx.extensionSettings.connectionManager.profiles;
        }
    } catch { /* skip */ }
    try {
        // Fallback: ST's own connection-manager uses the global variable
        const globalES = window?.extension_settings || globalThis?.extension_settings;
        if (globalES?.connectionManager?.profiles?.length > 0) {
            return globalES.connectionManager.profiles;
        }
    } catch { /* skip */ }
    return [];
}

async function waitForConnectionManager(maxAttempts = 15, delayMs = 300) {
    if (_cmReady) return true;
    // Fast path: check once synchronously before spinning
    if (!_cmReadyChecked) {
        try {
            if (_getCMProfiles().length > 0) {
                _cmReady = true;
                _cmReadyChecked = true;
                return true;
            }
        } catch { /* skip */ }
        _cmReadyChecked = true;
    }
    for (let i = 0; i < maxAttempts; i++) {
        try {
            if (_getCMProfiles().length > 0) {
                _cmReady = true;
                return true;
            }
        } catch { /* skip */ }
        await new Promise(r => setTimeout(r, delayMs));
    }
    warn(`connectionManager not available after ${maxAttempts} attempts`);
    return false;
}

export async function getProfiles() {
    const available = await waitForConnectionManager();
    if (!available) return [];
    try {
        const profiles = _getCMProfiles();
        // A profile with neither id nor name has no stable handle to select it
        // by (and Connection Manager would refuse to route a request to it).
        // Skip those instead of fabricating a Math.random() id that changes on
        // every call — a random id would make the profile unselectable across
        // settings saves and silently route generation to the main API.
        return profiles
            .filter(p => p.id || p.name)
            .map(p => ({
                id:   p.id || p.name,
                name: p.name || p.id || 'Unknown Profile',
            }));
    } catch (e) { warn('getProfiles error:', e); return []; }
}

export async function getProfileDetails(profileId) {
    const available = await waitForConnectionManager();
    if (!available) return null;
    try {
        const profiles = _getCMProfiles();
        return profiles.find(p => p.id === profileId || p.name === profileId) || null;
    } catch (e) { warn('getProfileDetails error:', e); return null; }
}

export async function generateWithProfile(profileIdOrName, systemPrompt, userMessages, assistantPrefill = '', signal = null) {
    const ctx = SillyTavern.getContext();

    // No profile picked: bail with a visible error instead of silently routing
    // to a different source (which would leak the full chat context/preset).
    if (!profileIdOrName) {
        throw new Error(tr('No connection profile selected. Choose a profile in DS Comments settings.', 'dscomments.connection.noProfile'));
    }

    if (!ctx.ConnectionManagerRequestService?.sendRequest) {
        throw new Error(tr('Connection Manager is unavailable. Enable the connection-manager extension or choose another source.', 'dscomments.connection.unavailable'));
    }

    // CM may not have populated profiles yet on first generation — wait for it
    // (same as the settings-panel UI does).
    const cmReady = await waitForConnectionManager();
    if (!cmReady) {
        throw new Error(tr('Connection Manager did not respond in time. Check that a profile is selected.', 'dscomments.connection.timeout'));
    }

    let profile = null;
    try {
        const all = _getCMProfiles();
        profile = all.find(p => p.id === profileIdOrName || p.name === profileIdOrName) || null;
    } catch (e) {
        throw new Error(tr('Could not read Connection Manager profiles: {msg}', 'dscomments.connection.profileRead').replace('{msg}', e?.message || e));
    }
    if (!profile) {
        throw new Error(tr('Connection profile not found: {name}. It may have been deleted; select a profile again in DS Comments settings.', 'dscomments.connection.profileMissing').replace('{name}', profileIdOrName));
    }

    trace(`Generating with profile "${profile.name}"`);
    // persona / character card / lorebook / chapters arrive as separate user
    // messages — CM's sendRequest passes message arrays to chat-completion
    // backends as-is (shared.js: Array.isArray(prompt) ? prompt : wrap).
    // A trailing assistant message (jailbreakRole 'assistant') is the prefill
    // position: chat-completion backends continue it, and ST's
    // TextCompletionService.constructPrompt recognises a trailing assistant
    // message as prefill for text-completion backends.
    const messages = [
        { role: 'system', content: systemPrompt },
        ...userMessages.map(content => ({ role: 'user', content })),
    ];
    if (assistantPrefill) messages.push({ role: 'assistant', content: assistantPrefill });

    let response;
    try {
        response = await ctx.ConnectionManagerRequestService.sendRequest(
            profile.id, messages, undefined,
            { stream: false, signal: signal || null, extractData: true, includePreset: false, includeInstruct: false }
        );
    } catch (e) {
        // ConnectionManagerRequestService wraps every failure as
        // `new Error('API request failed', { cause })`, so a real AbortError
        // surfaces as e.cause. Normalise abort back to a DOMException so the
        // generator.js catch renders the "cancelled" state instead of an error.
        if (signal?.aborted || e?.name === 'AbortError' || e?.cause?.name === 'AbortError') {
            throw new DOMException('Aborted', 'AbortError');
        }
        const cause = e?.cause;
        const detail = cause?.message ? cause.message : (e?.message || String(e));
        throw new Error(tr('Profile {name}: {msg}', 'dscomments.connection.profileResponse').replace('{name}', profile.name).replace('{msg}', detail));
    }

    const text = extractTextFromResponse(response);
    if (text === null) {
        warn('Could not extract text from profile response', {
            responseType: Array.isArray(response) ? 'array' : typeof response,
            hasContent: response?.content !== undefined,
            hasChoices: Array.isArray(response?.choices),
            hasCandidates: Array.isArray(response?.candidates),
        });
        throw new Error(tr('Profile {name} returned a response, but its text could not be extracted.', 'dscomments.connection.extractResponse').replace('{name}', profile.name));
    }
    return text;
}

function extractTextFromResponse(resp) {
    if (!resp) return null;
    if (typeof resp === 'string') return resp;
    if (Array.isArray(resp)) {
        const texts = resp.filter(b => b?.type === 'text' && typeof b.text === 'string').map(b => b.text);
        if (texts.length > 0) return texts.join('\n');
    }
    if (resp.content !== undefined && resp.content !== null) {
        if (typeof resp.content === 'string') return resp.content;
        if (Array.isArray(resp.content)) {
            const texts = resp.content.filter(b => b?.type === 'text' && typeof b.text === 'string').map(b => b.text);
            if (texts.length > 0) return texts.join('\n');
        }
    }
    if (resp.choices?.[0]?.message?.content) {
        const c = resp.choices[0].message.content;
        if (typeof c === 'string') return c;
    }
    if (Array.isArray(resp.candidates)) {
        const parts = resp.candidates[0]?.content?.parts;
        if (Array.isArray(parts)) {
            const texts = parts.filter(p => typeof p?.text === 'string' && !p.thought).map(p => p.text);
            if (texts.length > 0) return texts.join('');
        }
    }
    if (typeof resp.text    === 'string') return resp.text;
    if (typeof resp.message === 'string') return resp.message;
    if (typeof resp.message?.content === 'string') return resp.message.content;
    return null;
}

// ── Custom Endpoint Debug State ──
// Stores last request/response for debug inspection via Debug Menu.
// With settings.debugMode off, only metadata is captured (messageChars /
// textChars); full prompt bodies live here exclusively in debug mode.
export const lastCustomEndpointDebug = {
    request: null,   // debug: { url, model, messages, stream, timestamp } | meta: { url, model, messageChars, stream, timestamp }
    response: null,  // debug: { status, data, text, timestamp, durationMs } | meta: { status, textChars, timestamp, durationMs }
    error: null,     // { message, status?, timestamp }
};

// Default endpoint timeout. Overridable in tests only.
let _customEndpointTimeoutMs = 120_000;
export const _testSetCustomEndpointTimeout = (typeof process !== 'undefined' && process?.env?.NODE_TEST === '1')
    ? (ms) => { _customEndpointTimeoutMs = ms; }
    : undefined;

// ── Custom Endpoint (OpenAI-compatible) ──

function normalizeParsedEndpoint(url) {
    const path = url.pathname.replace(/\/+$/, '');
    if (/\/chat\/completions$/i.test(path)) return url.origin + path;
    if (/\/v1$/i.test(path)) return `${url.origin}${path}/chat/completions`;
    return `${url.origin}/v1/chat/completions`;
}

/**
 * Classify a raw custom endpoint URL before reading the API key or fetching.
 * @returns {{endpointUrl:string, origin:string, transport:'secure'|'loopback'|'insecure', isLoopback:boolean}}
 */
export function classifyCustomEndpoint(raw) {
    let url;
    try {
        url = new URL(String(raw ?? '').trim());
    } catch {
        throw new Error(tr('Invalid custom endpoint URL.', 'dscomments.connection.invalidUrl'));
    }
    if (url.username || url.password) throw new Error(tr('Credentials in the URL are not allowed.', 'dscomments.connection.credentials'));
    if (url.protocol !== 'https:' && url.protocol !== 'http:') {
        throw new Error(tr('URL scheme {scheme} is not supported.', 'dscomments.connection.scheme').replace('{scheme}', url.protocol));
    }
    const hostname = url.hostname.toLowerCase();
    const isLoopback = hostname === 'localhost'
        || hostname === '[::1]'
        || /^127(?:\.\d{1,3}){3}$/.test(hostname);
    return {
        endpointUrl: normalizeParsedEndpoint(url),
        origin: url.origin,
        transport: url.protocol === 'https:' ? 'secure' : isLoopback ? 'loopback' : 'insecure',
        isLoopback,
    };
}

/**
 * Authorize a custom endpoint origin before any secret read or network call.
 * HTTPS is allowed silently; loopback HTTP warns; other HTTP requires a
 * one-time per-origin user confirmation and is persisted in settings.
 */
export async function authorizeCustomEndpoint(raw, {
    confirm = showConfirmModal,
    warnUser = notifyUser,
    persist = persistSettingsNow,
} = {}) {
    const policy = classifyCustomEndpoint(raw);
    if (policy.transport === 'secure') return policy;
    if (policy.transport === 'loopback') {
        warnUser('warning',
            tr('Local endpoint {origin} uses HTTP.', 'dscomments.connection.httpWarning')
                .replace('{origin}', policy.origin),
            `http:${policy.origin}`);
        return policy;
    }
    if (state.settings.insecureHttpOrigins.includes(policy.origin)) return policy;

    const accepted = await confirm(
        tr('Your API key and prompt contents will be sent to {origin} over unencrypted HTTP. Continue and allow this origin?', 'dscomments.connection.insecureConfirm').replace('{origin}', policy.origin),
    );
    if (!accepted) throw new Error(tr('Unencrypted endpoint was not allowed.', 'dscomments.connection.insecureDenied'));

    const previous = state.settings.insecureHttpOrigins;
    state.settings.insecureHttpOrigins = [...previous, policy.origin];
    try {
        await persist('insecure-http-origin');
    } catch (cause) {
        state.settings.insecureHttpOrigins = previous;
        throw cause;
    }
    return policy;
}

/**
 * Generate text via a custom OpenAI-compatible endpoint.
 * Sends ONLY the provided system + user prompts — no preset, no ST formatting.
 *
 * API key read from localforage — NEVER from settings JSON.
 *
 * NOTE (CORS): browser fetch() (not the ST server proxy), so the endpoint MUST
 * send permissive CORS headers, otherwise the browser blocks it. If a provider
 * refuses CORS, run a tiny CORS proxy or use the "Profile" source instead.
 *
 * @param {string} systemPrompt
 * @param {string[]} userMessages — one message per source block (persona,
 *   character card, lorebook, previously, current chapter)
 * @param {string} [assistantPrefill] — jailbreak prefill (jailbreakRole
 *   'assistant'): appended as a trailing {role:'assistant'} message. OpenAI-
 *   compatible backends generally continue it; backends that reject trailing
 *   assistant messages (e.g. newest Claude models) will surface an API error.
 * @param {AbortSignal|null} signal
 * @param {string} endpointUrl — raw endpoint URL from settings
 * @param {string} [model] — model ID (optional, API may have a default)
 * @returns {Promise<string>}
 */
export async function generateWithCustomEndpoint(systemPrompt, userMessages, assistantPrefill = '', signal, endpointUrl, model) {
    const { endpointUrl: url } = await authorizeCustomEndpoint(endpointUrl);

    const apiKey = await getApiKey();
    if (!apiKey) throw new Error(tr('Custom API key is not set', 'dscomments.connection.noApiKey'));

    const headers = {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
    };

    const messages = [];
    if (systemPrompt) messages.push({ role: 'system', content: systemPrompt });
    for (const content of userMessages) messages.push({ role: 'user', content });
    if (assistantPrefill) messages.push({ role: 'assistant', content: assistantPrefill });

    const body = { messages, stream: false };
    if (model) body.model = model;

    // ── Debug: log outgoing request ──
    // Outside debug mode only metadata is kept — full prompt bodies must
    // not sit in memory for the whole page lifetime.
    const debugFull = state.settings.debugMode === true;
    const requestPayload = debugFull
        ? { url, model: model || '(default)', messages, stream: false }
        : {
            url,
            model: model || '(default)',
            messageChars: messages.map(m => (m?.content || '').length),
            stream: false,
        };
    lastCustomEndpointDebug.request = { ...requestPayload, timestamp: Date.now() };
    lastCustomEndpointDebug.response = null;
    lastCustomEndpointDebug.error = null;

    const t0 = performance.now();

    // Hard timeout so a hanging endpoint can't spin the generation state
    // forever. Manual signal composition (NOT AbortSignal.any — ST itself only
    // uses AbortSignal.timeout, keep the same browser budget): the user's abort
    // and the timer both funnel into timeoutController, and `timedOut` lets the
    // catch distinguish a timeout from a user cancellation (generator.js routes
    // AbortError to "Генерация отменена").
    const timeoutController = new AbortController();
    let timedOut = false;
    const onUserAbort = () => timeoutController.abort();
    signal?.addEventListener('abort', onUserAbort, { once: true });
    const timer = setTimeout(() => { timedOut = true; timeoutController.abort(); }, _customEndpointTimeoutMs);

    let response;
    try {
        response = await fetch(url, {
            method: 'POST',
            headers,
            body: JSON.stringify(body),
            signal: timeoutController.signal,
        });
    } catch (e) {
        if (timedOut) {
            const msg = tr('Endpoint did not respond within 120 s', 'dscomments.connection.timeoutHttp');
            lastCustomEndpointDebug.error = { message: msg, timestamp: Date.now() };
            throw new Error(msg);
        }
        throw e;
    } finally {
        clearTimeout(timer);
        signal?.removeEventListener('abort', onUserAbort);
    }

    const durationMs = Math.round(performance.now() - t0);

    if (!response.ok) {
        const errText = await response.text().catch(() => 'Unknown error');
        const errMsg = `HTTP ${response.status}: ${errText.slice(0, 300)}`;
        lastCustomEndpointDebug.error = { message: errMsg, status: response.status, timestamp: Date.now() };
        throw new Error(tr('Custom endpoint {msg}', 'dscomments.connection.httpError').replace('{msg}', errMsg));
    }

    const data = await response.json();
    const text = extractTextFromResponse(data);

    // ── Debug: log response ──
    lastCustomEndpointDebug.response = debugFull
        ? {
            status: response.status,
            data,
            text: text || '(empty)',
            timestamp: Date.now(),
            durationMs,
        }
        : {
            status: response.status,
            textChars: (text || '').length,
            timestamp: Date.now(),
            durationMs,
        };

    if (text !== null) return text;

    warn('Custom endpoint: could not extract text from response', {
        responseType: Array.isArray(data) ? 'array' : typeof data,
        hasContent: data?.content !== undefined,
        hasChoices: Array.isArray(data?.choices),
        hasCandidates: Array.isArray(data?.candidates),
    });
    return '';
}
