// @ts-check
/**
 * DS Comments — whenSendFormReady helper tests (spec F2 / AC4).
 *
 * Verifies the APP_READY-driven #send_form attachment helper:
 *  - sync attach when #send_form already present
 *  - deferred attach via APP_READY when absent
 *  - graceful fallback (onGiveUp, no throw) when APP_READY is unavailable
 */

import {
    install, uninstall, fakeDocument, registerElement, clearElements,
} from '../test-helpers/lifecycle-runtime.mjs';
import { beforeEach, afterEach, test } from 'node:test';
import assert from 'node:assert/strict';

let domReadyModule;

function makeEventSource() {
    const listeners = new Map();
    return {
        on: (name, fn) => { if (!listeners.has(name)) listeners.set(name, []); listeners.get(name).push(fn); },
        removeListener: (name, fn) => {
            const arr = listeners.get(name);
            if (arr) { const i = arr.indexOf(fn); if (i !== -1) arr.splice(i, 1); }
        },
        fire: (name) => { const arr = listeners.get(name); if (arr) for (const fn of [...arr]) fn(); },
        count: (name) => listeners.get(name)?.length || 0,
    };
}

beforeEach(async () => {
    install();
    // install() does not reset the shared ST ctx; clear any eventSource/eventTypes
    // leaked by a previous test so each case starts from the stub default.
    delete globalThis._stCtx.eventSource;
    delete globalThis._stCtx.eventTypes;
    // Dynamic import after install() so dom-ready.js captures the lifecycle fakes.
    domReadyModule = await import('../src/ui/dom-ready.js');
});

afterEach(() => {
    uninstall();
});

test('attaches synchronously when #send_form is already present', () => {
    const form = fakeDocument.createElement('div');
    registerElement('send_form', form);
    let attached = null;
    domReadyModule.whenSendFormReady((sf) => { attached = sf; });
    assert.strictEqual(attached, form, 'attach called synchronously with the element');
});

test('defers attachment to APP_READY when #send_form is absent', () => {
    const es = makeEventSource();
    globalThis._stCtx.eventSource = es;
    globalThis._stCtx.eventTypes = { APP_READY: 'app_ready' };

    let attached = null;
    domReadyModule.whenSendFormReady((sf) => { attached = sf; });

    assert.equal(attached, null, 'not attached before APP_READY');
    assert.equal(es.count('app_ready'), 1, 'subscribed to APP_READY');

    // #send_form appears, then APP_READY fires.
    const form = fakeDocument.createElement('div');
    registerElement('send_form', form);
    es.fire('app_ready');

    assert.strictEqual(attached, form, 'attached on APP_READY');
    assert.equal(es.count('app_ready'), 0, 'listener removed after firing');
});

test('onGiveUp fires and no throw when APP_READY is unavailable and #send_form absent', () => {
    // Stub ctx has no eventSource / eventTypes -> fallback path.
    let gaveUp = false;
    assert.doesNotThrow(() => {
        domReadyModule.whenSendFormReady(() => {}, { onGiveUp: () => { gaveUp = true; } });
    });
    assert.equal(gaveUp, true, 'onGiveUp invoked when no APP_READY surface');
});

test('onGiveUp fires when APP_READY fires but #send_form is still absent', () => {
    const es = makeEventSource();
    globalThis._stCtx.eventSource = es;
    globalThis._stCtx.eventTypes = { APP_READY: 'app_ready' };

    let attached = false;
    let gaveUp = false;
    domReadyModule.whenSendFormReady(() => { attached = true; }, { onGiveUp: () => { gaveUp = true; } });

    // APP_READY fires but #send_form never appeared.
    es.fire('app_ready');
    assert.equal(attached, false, 'attach NOT called (no #send_form)');
    assert.equal(gaveUp, true, 'onGiveUp invoked');
    assert.equal(es.count('app_ready'), 0, 'listener removed after firing');
});

// ── F6: disposer contract — teardown before APP_READY ──
// Without this, disabling the extension before APP_READY leaves the listener
// alive and the later event attaches orphaned observers/button after teardown.

test('F6: returns a disposer function (unified contract, always callable)', () => {
    // Sync-attach path still returns a no-op function.
    const form = fakeDocument.createElement('div');
    registerElement('send_form', form);
    const dispose = domReadyModule.whenSendFormReady(() => {});
    assert.equal(typeof dispose, 'function', 'sync path returns a function');
    assert.doesNotThrow(() => dispose(), 'sync disposer safe to call');

    clearElements();
    // No-APP_READY fallback path also returns a function.
    const dispose2 = domReadyModule.whenSendFormReady(() => {}, { onGiveUp: () => {} });
    assert.equal(typeof dispose2, 'function', 'fallback path returns a function');
    assert.doesNotThrow(() => dispose2(), 'fallback disposer safe to call');
});

test('F6: disposer removes the pending APP_READY listener before it fires', () => {
    const es = makeEventSource();
    globalThis._stCtx.eventSource = es;
    globalThis._stCtx.eventTypes = { APP_READY: 'app_ready' };

    let attached = false;
    const dispose = domReadyModule.whenSendFormReady(() => { attached = true; });
    assert.equal(es.count('app_ready'), 1, 'subscribed while waiting');

    dispose();
    assert.equal(es.count('app_ready'), 0, 'listener removed by disposer');

    // APP_READY fires after teardown — must NOT attach.
    const form = fakeDocument.createElement('div');
    registerElement('send_form', form);
    es.fire('app_ready');
    assert.equal(attached, false, 'attach NOT called after dispose');
});

test('F6: disposer is safe to call after the handler already fired', () => {
    const es = makeEventSource();
    globalThis._stCtx.eventSource = es;
    globalThis._stCtx.eventTypes = { APP_READY: 'app_ready' };

    let attached = null;
    const dispose = domReadyModule.whenSendFormReady((sf) => { attached = sf; });
    const form = fakeDocument.createElement('div');
    registerElement('send_form', form);
    es.fire('app_ready');
    assert.strictEqual(attached, form, 'attached on APP_READY');
    // Disposer after the handler self-removed must not throw.
    assert.doesNotThrow(() => dispose());
    assert.equal(es.count('app_ready'), 0, 'still 0 listeners after late dispose');
});
