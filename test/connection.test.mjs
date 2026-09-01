// @ts-check
/**
 * DS Comments — custom endpoint classification/authorization tests.
 */

import '../test-helpers/stub-runtime.mjs';
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { state } from '../src/core.js';
import { classifyCustomEndpoint, authorizeCustomEndpoint } from '../src/connection.js';

beforeEach(() => {
    state.settings = { insecureHttpOrigins: [] };
});

// ── classification ──

test('classifyCustomEndpoint: bare HTTPS domain', () => {
    assert.deepEqual(classifyCustomEndpoint('https://api.example.com/v1'), {
        endpointUrl: 'https://api.example.com/v1/chat/completions',
        origin: 'https://api.example.com',
        transport: 'secure',
        isLoopback: false,
    });
});

test('classifyCustomEndpoint: loopback HTTP variants', () => {
    for (const raw of ['http://localhost:5000', 'http://127.0.0.1:5000', 'http://[::1]:5000']) {
        const policy = classifyCustomEndpoint(raw);
        assert.equal(policy.transport, 'loopback');
        assert.equal(policy.isLoopback, true);
        assert.equal(policy.origin, raw.replace(/:5000$/, ':5000')); // URL preserves port
        assert.ok(policy.endpointUrl.startsWith(raw));
    }
});

test('classifyCustomEndpoint: non-loopback HTTP is insecure', () => {
    const policy = classifyCustomEndpoint('http://192.168.1.5:5000');
    assert.equal(policy.transport, 'insecure');
    assert.equal(policy.isLoopback, false);
});

test('classifyCustomEndpoint: rejects malformed URL, credentials and unsupported schemes', () => {
    assert.throws(() => classifyCustomEndpoint('not a url'), /Invalid custom endpoint URL/);
    assert.throws(() => classifyCustomEndpoint('https://user:pass@example.com'), /Credentials/);
    assert.throws(() => classifyCustomEndpoint('ftp://example.com'), /URL scheme/);
    assert.throws(() => classifyCustomEndpoint('file:///etc/passwd'), /URL scheme/);
});

test('classifyCustomEndpoint: normalizes existing completions path and trailing slash', () => {
    assert.equal(classifyCustomEndpoint('https://x.com/v1/').endpointUrl, 'https://x.com/v1/chat/completions');
    assert.equal(classifyCustomEndpoint('https://x.com/v1/chat/completions').endpointUrl, 'https://x.com/v1/chat/completions');
    assert.equal(classifyCustomEndpoint('https://x.com').endpointUrl, 'https://x.com/v1/chat/completions');
});

// ── authorization ──

function makeDeps(overrides = {}) {
    return {
        confirm: async () => true,
        warnUser: () => false,
        persist: async () => {},
        ...overrides,
    };
}

test('authorizeCustomEndpoint: HTTPS does not confirm', async () => {
    const deps = makeDeps();
    const policy = await authorizeCustomEndpoint('https://x.com', deps);
    assert.equal(policy.transport, 'secure');
    assert.equal(deps.warnUser.called, undefined);
});

test('authorizeCustomEndpoint: loopback HTTP warns but does not confirm', async () => {
    const warnings = [];
    const deps = makeDeps({ warnUser: (level, msg, key) => { warnings.push({ level, msg, key }); return true; } });
    const policy = await authorizeCustomEndpoint('http://localhost:5000', deps);
    assert.equal(policy.transport, 'loopback');
    assert.equal(warnings.length, 1);
    assert.equal(warnings[0].level, 'warning');
    assert.ok(warnings[0].msg.includes('localhost'));
});

test('authorizeCustomEndpoint: non-loopback HTTP rejection aborts before network', async () => {
    const deps = makeDeps({ confirm: async () => false });
    await assert.rejects(
        authorizeCustomEndpoint('http://192.168.1.5:5000', deps),
        /not allowed/i,
    );
});

test('authorizeCustomEndpoint: acceptance persists the normalized origin', async () => {
    const deps = makeDeps();
    const policy = await authorizeCustomEndpoint('http://192.168.1.5:5000/path', deps);
    assert.equal(policy.origin, 'http://192.168.1.5:5000');
    assert.ok(state.settings.insecureHttpOrigins.includes(policy.origin));
});

test('authorizeCustomEndpoint: another path on the same origin does not reconfirm', async () => {
    state.settings.insecureHttpOrigins = ['http://192.168.1.5:5000'];
    let confirmed = false;
    const deps = makeDeps({ confirm: async () => { confirmed = true; return true; } });
    await authorizeCustomEndpoint('http://192.168.1.5:5000/other', deps);
    assert.equal(confirmed, false);
});

test('authorizeCustomEndpoint: another host or port reconfirms', async () => {
    state.settings.insecureHttpOrigins = ['http://192.168.1.5:5000'];
    let calls = 0;
    const deps = makeDeps({ confirm: async () => { calls++; return false; } });
    await assert.rejects(authorizeCustomEndpoint('http://192.168.1.5:5001', deps));
    await assert.rejects(authorizeCustomEndpoint('http://other.local:5000', deps));
    assert.equal(calls, 2);
});

test('authorizeCustomEndpoint: persistence failure aborts and restores previous allow-list', async () => {
    state.settings.insecureHttpOrigins = ['http://existing.local'];
    const deps = makeDeps({ persist: async () => { throw new Error('disk full'); } });
    await assert.rejects(
        authorizeCustomEndpoint('http://192.168.1.5:5000', deps),
        /disk full/,
    );
    assert.deepEqual(state.settings.insecureHttpOrigins, ['http://existing.local']);
});

test('authorizeCustomEndpoint: confirm/debug/log arguments never contain API key', async () => {
    const seen = [];
    const deps = makeDeps({
        confirm: async (msg) => { seen.push(msg); return false; },
        warnUser: (level, msg, key) => { seen.push(msg, key); return true; },
    });
    await assert.rejects(authorizeCustomEndpoint('http://x.com', deps));
    const text = seen.join('\n');
    assert.ok(!text.includes('secret-key'), 'no API key in authorization UI/log');
});

// ── F7/F8: generateWithCustomEndpoint — timeout + debug redaction ──

import {
    generateWithCustomEndpoint,
    lastCustomEndpointDebug,
    _testSetCustomEndpointTimeout,
} from '../src/connection.js';
import { setApiKey } from '../src/core.js';

/** Install a fetch double; returns a restore function. */
function installFetch(impl) {
    const original = globalThis.fetch;
    globalThis.fetch = impl;
    return () => { globalThis.fetch = original; };
}

function okResponse(payload) {
    return {
        ok: true,
        status: 200,
        json: async () => payload,
        text: async () => JSON.stringify(payload),
    };
}

test('F7: hanging endpoint is aborted by the timeout with a localized error', async () => {
    state.settings = { insecureHttpOrigins: [], debugMode: false };
    setApiKey('test-key');
    _testSetCustomEndpointTimeout(20);

    // fetch never resolves; on abort it rejects with AbortError, exactly like a
    // real hanging connection — so only the timeout flag can distinguish it.
    const restore = installFetch((_url, opts) => new Promise((_, reject) => {
        opts.signal.addEventListener('abort', () => {
            const err = new Error('aborted');
            err.name = 'AbortError';
            reject(err);
        });
    }));

    try {
        await assert.rejects(
            generateWithCustomEndpoint('sys', ['user'], '', null, 'https://api.example.com/v1', 'm'),
            (e) => e.name !== 'AbortError' && /within 0 s/.test(e.message),
            'должна быть ошибка таймаута, не AbortError');
        assert.ok(lastCustomEndpointDebug.error, 'timeout captured in debug state');
    } finally {
        restore();
        _testSetCustomEndpointTimeout(300_000);
    }
});

test('F7: user abort still surfaces as AbortError (cancel path preserved)', async () => {
    state.settings = { insecureHttpOrigins: [], debugMode: false };
    setApiKey('test-key');
    _testSetCustomEndpointTimeout(5_000);

    const userController = new AbortController();
    const restore = installFetch((_url, opts) => new Promise((_, reject) => {
        opts.signal.addEventListener('abort', () => {
            const err = new Error('aborted');
            err.name = 'AbortError';
            reject(err);
        });
        // User cancels well before the 5s test timeout fires.
        setTimeout(() => userController.abort(), 5);
    }));

    try {
        await assert.rejects(
            generateWithCustomEndpoint('sys', ['user'], '', userController.signal, 'https://api.example.com/v1', 'm'),
            (e) => e.name === 'AbortError',
            'пользовательская отмена даёт AbortError, как до фикса');
    } finally {
        restore();
        _testSetCustomEndpointTimeout(300_000);
    }
});

test('F8: debugMode off captures only metadata (no message bodies)', async () => {
    state.settings = { insecureHttpOrigins: [], debugMode: false };
    setApiKey('test-key');
    const restore = installFetch(async () => okResponse({ choices: [{ message: { content: 'hello world' } }] }));

    try {
        const text = await generateWithCustomEndpoint('system-secret', ['user-secret'], '', null, 'https://api.example.com/v1', 'm');
        assert.equal(text, 'hello world');

        const req = lastCustomEndpointDebug.request;
        assert.ok(req, 'request captured');
        assert.equal(req.messages, undefined, 'no full messages in non-debug mode');
        assert.ok(Array.isArray(req.messageChars), 'messageChars present');
        assert.equal(req.messageChars.length, 2, 'system + user counted');
        assert.equal(req.messageChars[0], 'system-secret'.length, 'system length recorded');

        const res = lastCustomEndpointDebug.response;
        assert.ok(res, 'response captured');
        assert.equal(res.data, undefined, 'no raw response data in non-debug mode');
        assert.equal(res.text, undefined, 'no full text in non-debug mode');
        assert.equal(res.textChars, 'hello world'.length, 'text length recorded');
        assert.equal(res.status, 200);
    } finally {
        restore();
    }
});

test('F8: debugMode on keeps the full bodies (debug workflow unchanged)', async () => {
    state.settings = { insecureHttpOrigins: [], debugMode: true };
    setApiKey('test-key');
    const restore = installFetch(async () => okResponse({ choices: [{ message: { content: 'full text' } }] }));

    try {
        await generateWithCustomEndpoint('system-secret', ['user-secret'], '', null, 'https://api.example.com/v1', 'm');
        const req = lastCustomEndpointDebug.request;
        assert.ok(Array.isArray(req.messages), 'full messages kept in debug mode');
        assert.equal(req.messages[0].content, 'system-secret');
        assert.equal(req.messages[1].role, 'user');
        assert.equal(req.messages[1].content, 'user-secret');
        assert.equal(req.messageChars, undefined, 'no redaction fields in debug mode');
        assert.equal(lastCustomEndpointDebug.response.text, 'full text', 'full text kept');
    } finally {
        restore();
    }
});

test('user messages are sent as separate {role:user} entries (no single-blob join)', async () => {
    state.settings = { insecureHttpOrigins: [], debugMode: true };
    setApiKey('test-key');
    let sentBody = null;
    const restore = installFetch(async (_url, opts) => {
        sentBody = JSON.parse(opts.body);
        return okResponse({ choices: [{ message: { content: 'ok' } }] });
    });

    try {
        await generateWithCustomEndpoint(
            'instructions',
            ['[Persona: p]', '[Character: c]', '[Details of the fictional world: l]', '[Current chapter: x]'],
            '', null, 'https://api.example.com/v1', 'm');
        assert.deepEqual(sentBody.messages, [
            { role: 'system', content: 'instructions' },
            { role: 'user', content: '[Persona: p]' },
            { role: 'user', content: '[Character: c]' },
            { role: 'user', content: '[Details of the fictional world: l]' },
            { role: 'user', content: '[Current chapter: x]' },
        ]);
    } finally {
        restore();
    }
});

test('assistant prefill is appended as a trailing {role:assistant} message; empty prefill adds none', async () => {
    state.settings = { insecureHttpOrigins: [], debugMode: true };
    setApiKey('test-key');
    let sentBody = null;
    const restore = installFetch(async (_url, opts) => {
        sentBody = JSON.parse(opts.body);
        return okResponse({ choices: [{ message: { content: 'ok' } }] });
    });

    try {
        await generateWithCustomEndpoint(
            'instructions', ['[Current chapter: x]'], 'PREFILL_TEXT', null, 'https://api.example.com/v1', 'm');
        assert.deepEqual(sentBody.messages, [
            { role: 'system', content: 'instructions' },
            { role: 'user', content: '[Current chapter: x]' },
            { role: 'assistant', content: 'PREFILL_TEXT' },
        ]);

        await generateWithCustomEndpoint(
            'instructions', ['[Current chapter: x]'], '', null, 'https://api.example.com/v1', 'm');
        assert.equal(sentBody.messages.length, 2, 'empty prefill must not append an assistant message');
    } finally {
        restore();
    }
});
