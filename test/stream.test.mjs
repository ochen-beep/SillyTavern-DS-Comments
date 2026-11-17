// @ts-check
/**
 * DS Comments — SSE streaming toggle tests.
 *
 * Contract (reference: Diegetic commit 67d8a14):
 *   - settings.stream (default ON) reaches BOTH transports (body.stream for the
 *     custom endpoint, sendRequest options for the CM profile);
 *   - the custom endpoint accumulates OpenAI SSE delta.content, tolerating the
 *     junk wild proxies emit (keep-alive comments, usage chunks with empty
 *     choices, empty delta, reasoning_content, non-JSON lines);
 *   - an empty stream is an explicit error, never a silent '';
 *   - CM stream:true returns an AsyncGenerator FACTORY (chunks carry ACCUMULATED
 *     text in .text); a plain object response (API without stream support) still
 *     works; a mid-stream cancel maps to AbortError;
 *   - "Extra params (JSON)" (settings.extraBody) merges into both transports —
 *     top-level + custom_include_body for CM (server whitelist bypass for
 *     CUSTOM sources) — and a "stream" key there is rejected BEFORE any request.
 */

import '../test-helpers/stub-runtime.mjs';
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { state, loadSettings, setApiKey, MODULE_NAME } from '../src/core.js';
import { generateWithProfile, generateWithCustomEndpoint } from '../src/connection.js';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

// ── helpers ──

// Raw SSE bytes. \n\n framing mirrors what real OpenAI-compatible proxies emit.
const sseBody = (chunks) => new ReadableStream({
    start(controller) {
        for (const c of chunks) controller.enqueue(new TextEncoder().encode(c));
        controller.close();
    },
});

function freshSettings(overrides = {}) {
    state.settings = {
        apiSource: 'custom',
        structuredOutput: 'off',
        debugMode: false,
        insecureHttpOrigins: [],
        stream: true,
        extraBody: '',
        ...overrides,
    };
}

/** Mount a CM profile world: one profile + a spy sendRequest. */
function mountCm(sendRequest) {
    globalThis._stCtx.extensionSettings = {
        connectionManager: { profiles: [{ id: 'p1', name: 'P1' }] },
    };
    globalThis._stCtx.ConnectionManagerRequestService = { sendRequest };
}

beforeEach(() => {
    freshSettings();
    setApiKey('sk-test');
});

// ── settings: stream flag normalization ──

test('loadSettings: stream defaults ON when absent (old saves enable streaming)', async () => {
    globalThis._stCtx.extensionSettings = { [MODULE_NAME]: {} };
    await loadSettings();
    assert.equal(state.settings.stream, true);
    assert.equal(state.settings.extraBody, '');
});

test('loadSettings: stream:false survives (toggle OFF persists)', async () => {
    globalThis._stCtx.extensionSettings = { [MODULE_NAME]: { stream: false } };
    await loadSettings();
    assert.equal(state.settings.stream, false);
});

test('loadSettings: stream:true stays ON and garbage coerces to ON', async () => {
    globalThis._stCtx.extensionSettings = { [MODULE_NAME]: { stream: true } };
    await loadSettings();
    assert.equal(state.settings.stream, true);

    globalThis._stCtx.extensionSettings = { [MODULE_NAME]: { stream: 'no' } };
    await loadSettings();
    // raw.stream === false ? false : true — anything but explicit false is ON.
    assert.equal(state.settings.stream, true);
});

// ── custom endpoint: SSE accumulation ──

test('custom stream:true: body asks for a stream, SSE accumulates, proxy junk is skipped', async () => {
    const realFetch = globalThis.fetch;
    let sentBody = null;
    globalThis.fetch = async (_url, opts) => {
        sentBody = JSON.parse(opts.body);
        // Wild-proxy mix: role chunk, keep-alive comment, empty delta, empty
        // content, usage chunk with empty choices, CRLF framing, reasoning,
        // spaceless [DONE], non-JSON data line.
        return {
            ok: true,
            status: 200,
            body: sseBody([
                'data: {"choices":[{"delta":{"role":"assistant"}}]}\n\n',
                'data: {"choices":[{"delta":{"content":"Пост"}}]}\n\n',
                ': keep-alive\n\n',
                'data: {"choices":[{"delta":{}}]}\n\n',
                'data: {"choices":[{"delta":{"content":""}}]}\n\n',
                'data: {"choices":[],"usage":{"total_tokens":10}}\n\n',
                'data: {"choices":[{"delta":{"content":" готов"}}]}\r\n\r\n',
                'data: {"choices":[{"delta":{"reasoning_content":"думал"}}]}\n\n',
                'data: oops-not-json\n\n',
                'data:[DONE]\n\n',
            ]),
        };
    };
    try {
        const text = await generateWithCustomEndpoint('S', ['U'], '', null, 'https://x.example/v1', 'm1');
        assert.equal(sentBody.stream, true, 'stream:true in the request body');
        assert.equal(sentBody.model, 'm1');
        assert.equal(text, 'Пост готов', 'delta.content accumulates; role/empty/usage/reasoning/junk stay out');
    } finally {
        globalThis.fetch = realFetch;
    }
});

test('custom stream OFF (toggle disabled): body stream:false, whole-JSON path unchanged', async () => {
    const realFetch = globalThis.fetch;
    let sentBody = null;
    globalThis.fetch = async (_url, opts) => {
        sentBody = JSON.parse(opts.body);
        return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content: 'JSON path' } }] }) };
    };
    try {
        freshSettings({ stream: false });
        const text = await generateWithCustomEndpoint('S', ['U'], '', null, 'https://x.example/v1', 'm1');
        assert.equal(sentBody.stream, false, 'stream:false in the request body');
        assert.equal(text, 'JSON path');
    } finally {
        globalThis.fetch = realFetch;
    }
});

test('custom stream:true: stream that ends without [DONE] still accumulates to its end', async () => {
    const realFetch = globalThis.fetch;
    globalThis.fetch = async () => ({
        ok: true,
        status: 200,
        body: sseBody(['data: {"choices":[{"delta":{"content":"хвост"}}]}\n\n']),
    });
    try {
        const text = await generateWithCustomEndpoint('S', ['U'], '', null, 'https://x.example/v1', 'm1');
        assert.equal(text, 'хвост');
    } finally {
        globalThis.fetch = realFetch;
    }
});

test('custom stream:true: empty stream (only junk + [DONE]) is an explicit error, not a silent empty string', async () => {
    const realFetch = globalThis.fetch;
    globalThis.fetch = async () => ({
        ok: true,
        status: 200,
        body: sseBody([': ping\n\n', 'data: {"choices":[],"usage":{}}\n\n', 'data: [DONE]\n\n']),
    });
    try {
        await assert.rejects(
            generateWithCustomEndpoint('S', ['U'], '', null, 'https://x.example/v1', 'm1'),
            /no text could be extracted/,
        );
    } finally {
        globalThis.fetch = realFetch;
    }
});

test('custom stream:true: user abort mid-stream surfaces as AbortError', async () => {
    const realFetch = globalThis.fetch;
    const user = new AbortController();
    globalThis.fetch = async (_url, opts) => {
        // Hang the stream; the abort funnel (user signal → fetch signal) must
        // tear the reader down with an AbortError.
        return {
            ok: true,
            status: 200,
            body: new ReadableStream({
                start(controller) {
                    opts.signal.addEventListener('abort', () => {
                        controller.error(new DOMException('Aborted', 'AbortError'));
                    });
                    controller.enqueue(new TextEncoder().encode('data: {"choices":[{"delta":{"content":"начало"}}]}\n\n'));
                },
            }),
        };
    };
    try {
        const p = generateWithCustomEndpoint('S', ['U'], '', user.signal, 'https://x.example/v1', 'm1');
        await new Promise(r => setTimeout(r, 5));
        user.abort();
        await assert.rejects(p, (e) => e?.name === 'AbortError');
    } finally {
        globalThis.fetch = realFetch;
    }
});

// ── custom endpoint: extra params ──

test('custom: extra params merge into the request body top-level', async () => {
    const realFetch = globalThis.fetch;
    let sentBody = null;
    globalThis.fetch = async (_url, opts) => {
        sentBody = JSON.parse(opts.body);
        return { ok: true, status: 200, body: sseBody(['data: {"choices":[{"delta":{"content":"ok"}}]}\n\n', 'data: [DONE]\n\n']) };
    };
    try {
        freshSettings({ extraBody: '{"reasoning_effort":"none"}' });
        const text = await generateWithCustomEndpoint('S', ['U'], '', null, 'https://x.example/v1', 'm1');
        assert.equal(sentBody.reasoning_effort, 'none', 'extra param reaches the provider payload');
        assert.equal(sentBody.stream, true, 'toggle still owns stream');
        assert.equal(text, 'ok', 'streaming works alongside the extra params');
    } finally {
        globalThis.fetch = realFetch;
    }
});

test('custom: a "stream" key in extra params is rejected BEFORE fetch (the toggle owns it)', async () => {
    const realFetch = globalThis.fetch;
    let fetched = false;
    globalThis.fetch = async () => { fetched = true; return { ok: true, json: async () => ({}) }; };
    try {
        freshSettings({ extraBody: '{"stream":true}' });
        await assert.rejects(
            generateWithCustomEndpoint('S', ['U'], '', null, 'https://x.example/v1', 'm1'),
            /"stream"/,
        );
        assert.equal(fetched, false, 'no network call');
    } finally {
        globalThis.fetch = realFetch;
    }
});

test('custom: malformed extra params fail fast, before fetch', async () => {
    const realFetch = globalThis.fetch;
    let fetched = false;
    globalThis.fetch = async () => { fetched = true; return { ok: true, json: async () => ({}) }; };
    try {
        freshSettings({ extraBody: 'not json at all' });
        await assert.rejects(
            generateWithCustomEndpoint('S', ['U'], '', null, 'https://x.example/v1', 'm1'),
            /not valid JSON/,
        );
        assert.equal(fetched, false, 'no network call');

        freshSettings({ extraBody: '[1,2,3]' });
        await assert.rejects(
            generateWithCustomEndpoint('S', ['U'], '', null, 'https://x.example/v1', 'm1'),
            /must be a JSON object/,
        );
        assert.equal(fetched, false, 'no network call for a non-object either');
    } finally {
        globalThis.fetch = realFetch;
    }
});

// ── CM profile: generator / object duality ──

test('CM stream:true: generator is drained, last accumulated .text wins, stream rides the options', async () => {
    let seenOpts = null;
    let seenOverride = null;
    mountCm(async (_id, _msgs, _max, opts, override) => {
        seenOpts = opts;
        seenOverride = override;
        return async function* () {
            yield { text: 'Часть' };
            yield { text: 'Часть два' };
        };
    });
    const text = await generateWithProfile('p1', 'S', ['U'], '', null);
    assert.equal(seenOpts.stream, true, 'stream:true in sendRequest options');
    assert.equal(text, 'Часть два', 'final accumulated text from the generator');
    assert.deepEqual(seenOverride, {}, 'no extra params → clean override, no custom_include_body noise');
});

test('CM stream:true: an object response (API without stream support) still extracts text', async () => {
    mountCm(async () => ({ choices: [{ message: { content: 'fallback' } }] }));
    const text = await generateWithProfile('p1', 'S', ['U'], '', null);
    assert.equal(text, 'fallback');
});

test('CM stream:false (toggle off): options carry stream:false and the object path is untouched', async () => {
    let seenOpts = null;
    mountCm(async (_id, _msgs, _max, opts) => {
        seenOpts = opts;
        return { content: 'plain' };
    });
    freshSettings({ stream: false });
    const text = await generateWithProfile('p1', 'S', ['U'], '', null);
    assert.equal(seenOpts.stream, false);
    assert.equal(text, 'plain');
});

test('CM stream:true: cancel mid-stream maps to AbortError, not "generation failed"', async () => {
    const ctrl = new AbortController();
    mountCm(async () => async function* () {
        yield { text: 'начало' };
        await new Promise((_, rej) => ctrl.signal.addEventListener('abort', () => rej(new DOMException('Aborted', 'AbortError'))));
    });
    const p = generateWithProfile('p1', 'S', ['U'], '', ctrl.signal);
    await new Promise(r => setTimeout(r, 5)); // let the stream start
    ctrl.abort();
    await assert.rejects(p, (e) => e?.name === 'AbortError');
});

test('CM stream:true: a mid-stream failure without abort keeps its original error', async () => {
    mountCm(async () => async function* () {
        yield { text: 'начало' };
        throw new Error('stream exploded');
    });
    await assert.rejects(
        generateWithProfile('p1', 'S', ['U'], '', null),
        /stream exploded/,
    );
});

// ── CM profile: extra params passthrough ──

test('CM: extra params ride the override top-level AND as custom_include_body (server whitelist bypass)', async () => {
    let seenOverride = null;
    mountCm(async (_id, _msgs, _max, _opts, override) => {
        seenOverride = override;
        return { content: 'ok' };
    });
    freshSettings({ extraBody: '{"reasoning_effort":"none"}' });
    await generateWithProfile('p1', 'S', ['U'], '', null);
    assert.equal(seenOverride.reasoning_effort, 'none', 'top level — read by native ST sources');
    assert.deepEqual(seenOverride.custom_include_body, { reasoning_effort: 'none' }, 'bypasses the ST server whitelist for CUSTOM sources');
});

test('CM: a "stream" key in extra params is rejected BEFORE sendRequest', async () => {
    let called = false;
    mountCm(async () => { called = true; return {}; });
    freshSettings({ extraBody: '{"stream":false}' });
    await assert.rejects(
        generateWithProfile('p1', 'S', ['U'], '', null),
        /"stream"/,
    );
    assert.equal(called, false, 'no request issued');
});

test('CM: malformed extra params fail fast, sendRequest not called', async () => {
    let called = false;
    mountCm(async () => { called = true; return {}; });
    freshSettings({ extraBody: '{"a":' });
    await assert.rejects(
        generateWithProfile('p1', 'S', ['U'], '', null),
        /not valid JSON/,
    );
    assert.equal(called, false, 'no request issued');
});

// ── UI surface ──

test('settings.html carries the stream toggle and the extra params field', () => {
    const html = readFileSync(path.join(root, 'settings.html'), 'utf8');
    assert.match(html, /id="dsc_stream"/, 'stream checkbox present');
    assert.match(html, /data-i18n="dscomments\.settings\.stream"/);
    assert.match(html, /data-i18n="dscomments\.settings\.streamHint"/, 'CF-524 hint present');
    assert.match(html, /id="dsc_extrabody"/, 'extra params field present');
    assert.match(html, /data-i18n="dscomments\.settings\.extraBody"/);
    assert.match(html, /data-i18n="dscomments\.settings\.extraBodyHint"/);
    // The toggle sits in the behavior section, after the source controls.
    const sourceIdx = html.indexOf('id="dsc_source"');
    const streamIdx = html.indexOf('id="dsc_stream"');
    assert.ok(sourceIdx !== -1 && streamIdx > sourceIdx, 'stream toggle lives after the source picker');
});
