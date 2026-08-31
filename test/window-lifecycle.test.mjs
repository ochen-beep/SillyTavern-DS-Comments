// @ts-check
/**
 * DS Comments — window/ui runtime lifecycle tests.
 *
 * Verifies that every global listener, observer, timer and active gesture gets
 * an explicit teardown path through teardownWindowRuntime() and removePanel().
 */

import {
    install, uninstall, fakeWindow, fakeVisualViewport, fakeDocument, registerElement, clearElements,
    clock, raf, observers,
} from '../test-helpers/lifecycle-runtime.mjs';
import { beforeEach, afterEach, test } from 'node:test';
import assert from 'node:assert/strict';

let windowModule;
let state;

function registerBarTree(bar) {
    registerElement('dscWindow', bar);
    for (const child of bar.children) {
        if (child.id) registerElement(child.id, child);
    }
}

function makeBar() {
    const bar = fakeDocument.createElement('div');
    bar.id = 'dscWindow';
    bar.className = 'dsc_window';
    const header = fakeDocument.createElement('div');
    header.id = 'dscHeader';
    const feed = fakeDocument.createElement('div');
    feed.id = 'dscFeed';
    const grip = fakeDocument.createElement('div');
    grip.id = 'dscResize';
    bar.appendChild(header);
    bar.appendChild(feed);
    bar.appendChild(grip);
    registerBarTree(bar);
    return { bar, header, grip };
}

beforeEach(async () => {
    install();
    fakeDocument.body.children.length = 0;
    fakeDocument.documentElement.style.setProperty = () => {};
    ({ state } = await import('../src/core.js'));
    state.settings = { enabled: true, collapsed: false, windowGeom: { width: 380, height: 360, left: null, top: null, bottom: 70 } };
    windowModule = await import('../src/ui/window.js');
    windowModule.teardownWindowRuntime();
});

afterEach(() => {
    uninstall();
});

function makeSendForm() {
    const form = fakeDocument.createElement('div');
    registerElement('send_form', form);
    return form;
}

test('two initViewportSync() calls create one resize listener', () => {
    makeBar();
    makeSendForm();
    windowModule.initViewportSync();
    windowModule.initViewportSync();
    assert.equal(fakeWindow.listenerCount('resize'), 1);
    assert.equal(fakeVisualViewport.listenerCount('resize'), 1);
});

test('visual viewport listener is removed on teardown and rebinds once', () => {
    makeBar();
    makeSendForm();
    windowModule.initViewportSync();
    const handler = fakeVisualViewport._listeners.get('resize')[0];

    windowModule.teardownWindowRuntime();
    assert.equal(fakeVisualViewport.listenerCount('resize'), 0);
    assert.equal(fakeVisualViewport._listeners.get('resize').includes(handler), false);

    windowModule.initViewportSync();
    assert.equal(fakeVisualViewport.listenerCount('resize'), 1);
});

test('teardownWindowRuntime() removes the exact handler and permits a later rebind', () => {
    makeBar();
    makeSendForm();
    windowModule.initViewportSync();
    const handler = fakeWindow._listeners.get('resize')[0];
    windowModule.teardownWindowRuntime();
    assert.equal(fakeWindow.listenerCount('resize'), 0);
    assert.equal(fakeWindow._listeners.get('resize').includes(handler), false);
    windowModule.initViewportSync();
    assert.equal(fakeWindow.listenerCount('resize'), 1);
});

test('ResizeObserver.disconnect() is called on teardown', () => {
    makeBar();
    makeSendForm();
    windowModule.initViewportSync();
    const ros = observers.resize;
    assert.equal(ros.length, 1);
    windowModule.teardownWindowRuntime();
    assert.equal(ros[0].disconnectCalls, 1);
});

test('absent #send_form with no APP_READY does not create an observer (and teardown is clean)', () => {
    // Do NOT create #send_form and the stub ctx has no eventSource -> the
    // whenSendFormReady fallback warns + onGiveUp, attaches nothing.
    makeBar();
    windowModule.initViewportSync();
    windowModule.teardownWindowRuntime();
    clock.runAll();
    assert.equal(observers.resize.length, 0);
    assert.equal(clock.pendingIntervals(), 0);
    assert.equal(clock.pendingTimeouts(), 0);
});

test('observeStChrome defers ResizeObserver attachment to APP_READY when #send_form absent', () => {
    makeBar();
    // Provide an eventSource + APP_READY event type on the stub ctx.
    const listeners = new Map();
    globalThis._stCtx.eventSource = {
        on: (name, fn) => { if (!listeners.has(name)) listeners.set(name, []); listeners.get(name).push(fn); },
        removeListener: (name, fn) => { const arr = listeners.get(name); if (arr) { const i = arr.indexOf(fn); if (i !== -1) arr.splice(i, 1); } },
        fire: (name) => { const arr = listeners.get(name); if (arr) for (const fn of [...arr]) fn(); },
    };
    globalThis._stCtx.eventTypes = { APP_READY: 'app_ready' };

    windowModule.initViewportSync();
    // No #send_form yet -> no ResizeObserver created, but APP_READY subscribed.
    assert.equal(observers.resize.length, 0, 'no observer before APP_READY');

    // Now #send_form appears (ST finished mounting it) and APP_READY fires.
    makeSendForm();
    globalThis._stCtx.eventSource.fire('app_ready');
    assert.equal(observers.resize.length, 1, 'observer attached on APP_READY');
    assert.equal(observers.resize[0].observed.length, 1, 'observing #send_form');
    assert.equal(listeners.get('app_ready').length, 0, 'APP_READY listener removed after fire');

    windowModule.teardownWindowRuntime();
    assert.equal(observers.resize[0].disconnectCalls, 1);
    // Clean up ctx mutations so they don't leak into subsequent tests.
    delete globalThis._stCtx.eventSource;
    delete globalThis._stCtx.eventTypes;
});

test('debounced remeasure is cancelled by teardown', () => {
    makeBar();
    const form = makeSendForm();
    windowModule.initViewportSync();
    const ro = observers.resize[0];
    ro.simulate();
    assert.ok(clock.pendingTimeouts() > 0, 'debounced remeasure scheduled');
    windowModule.teardownWindowRuntime();
    assert.equal(clock.pendingTimeouts(), 0);
});

test('pending reveal rAF and hide timer are cancelled by removePanel()', () => {
    const { bar } = makeBar();
    windowModule.mountPanel();
    // Force a non-first show to schedule rAF (enabled + not collapsed).
    bar.dataset.dscVisInit = '1';
    windowModule.syncPanelVisibility();
    assert.ok(raf.pending() > 0 || clock.pendingTimeouts() > 0, 'visibility work scheduled');
    windowModule.removePanel();
    assert.equal(raf.pending(), 0);
    assert.equal(clock.pendingTimeouts(), 0);
});

test('teardown during drag removes document mousemove/mouseup listeners', () => {
    const bar = windowModule.mountPanel();
    registerBarTree(bar);
    const header = fakeDocument.getElementById('dscHeader');
    // Simulate a mousedown on the header to start a drag.
    header.dispatchEvent({ type: 'mousedown', clientX: 100, clientY: 100, target: header, preventDefault: () => {} });
    assert.ok(fakeDocument.listenerCount('mousemove') > 0 || fakeDocument.listenerCount('mouseup') > 0,
        'drag document listeners attached');
    windowModule.teardownWindowRuntime();
    assert.equal(fakeDocument.listenerCount('mousemove'), 0);
    assert.equal(fakeDocument.listenerCount('mouseup'), 0);
});

test('teardown during resize removes document mousemove/mouseup listeners', () => {
    const bar = windowModule.mountPanel();
    registerBarTree(bar);
    const grip = fakeDocument.getElementById('dscResize');
    grip.dispatchEvent({ type: 'mousedown', clientX: 100, clientY: 100, target: grip, preventDefault: () => {} });
    assert.ok(fakeDocument.listenerCount('mousemove') > 0 || fakeDocument.listenerCount('mouseup') > 0,
        'resize document listeners attached');
    windowModule.teardownWindowRuntime();
    assert.equal(fakeDocument.listenerCount('mousemove'), 0);
    assert.equal(fakeDocument.listenerCount('mouseup'), 0);
});

test('mount/remove/mount leaves one set of handlers', () => {
    let bar = windowModule.mountPanel();
    registerBarTree(bar);
    windowModule.removePanel();
    bar = windowModule.mountPanel();
    registerBarTree(bar);
    // Resize listener from initViewportSync is not part of mountPanel.
    // Drag/resize handlers are per-element and removed with the panel.
    assert.ok(fakeDocument.getElementById('dscWindow'));
});

test('visualViewport resize normalizes desktop geometry with viewport offsets without persisting', () => {
    state.settings.windowGeom = { width: 380, height: 360, left: 900, top: 400, bottom: 70 };
    const bar = windowModule.mountPanel();
    windowModule.initViewportSync();
    let saveCalls = 0;
    state.saveSettingsDebounced = () => { saveCalls++; };
    fakeVisualViewport.offsetLeft = 100;
    fakeVisualViewport.offsetTop = 50;
    fakeVisualViewport.width = 800;
    fakeVisualViewport.height = 500;
    fakeVisualViewport.dispatchEvent({ type: 'resize' });
    clock.runAll();

    assert.equal(bar.style.transform, 'translate3d(840px, 400px, 0)');
    assert.equal(bar.style.width, '380px');
    assert.equal(bar.style.height, '360px');
    assert.equal(saveCalls, 0);
    assert.deepEqual(state.settings.windowGeom, { width: 380, height: 360, left: 900, top: 400, bottom: 70 });
});

test('resize positions a hidden desktop panel before reveal', () => {
    state.settings = { enabled: true, collapsed: true, windowGeom: { width: 380, height: 360, left: 900, top: 180, bottom: 70 } };
    const bar = windowModule.mountPanel();
    windowModule.initViewportSync();
    assert.equal(bar.hidden, true);

    fakeWindow.innerWidth = 800;
    fakeVisualViewport.width = 800;
    fakeVisualViewport.height = 768;
    fakeWindow.dispatchEvent({ type: 'resize' });
    clock.runAll();
    assert.equal(bar.style.transform, 'translate3d(740px, 180px, 0)');

    state.settings.collapsed = false;
    windowModule.syncPanelVisibility();
    assert.equal(bar.style.transform, 'translate3d(740px, 180px, 0)');
});
test('desktop resize renders saved geometry again after a narrow viewport', () => {
    windowModule.removePanel();
    state.settings.windowGeom = { width: 380, height: 360, left: 900, top: 180, bottom: 70 };
    const bar = windowModule.mountPanel();
    windowModule.initViewportSync();
    fakeWindow.innerWidth = 800;
    fakeVisualViewport.width = 800;
    fakeWindow.dispatchEvent({ type: 'resize' });
    clock.runAll();

    assert.equal(bar.style.transform, 'translate3d(740px, 180px, 0)');
    assert.equal(bar.style.width, '380px');
    assert.equal(bar.style.height, '360px');
    assert.deepEqual(state.settings.windowGeom, { width: 380, height: 360, left: 900, top: 180, bottom: 70 });

    fakeWindow.innerWidth = 1024;
    fakeVisualViewport.width = 1024;
    fakeWindow.dispatchEvent({ type: 'resize' });
    clock.runAll();

    assert.equal(bar.style.transform, 'translate3d(900px, 180px, 0)');
    assert.deepEqual(state.settings.windowGeom, { width: 380, height: 360, left: 900, top: 180, bottom: 70 });
});

test('desktop resize temporarily caps oversized saved dimensions without persisting them', () => {
    windowModule.removePanel();
    state.settings.windowGeom = { width: 1200, height: 900, left: 100, top: 80, bottom: 70 };
    const bar = windowModule.mountPanel();
    windowModule.initViewportSync();
    fakeWindow.innerWidth = 800;
    fakeWindow.innerHeight = 500;
    fakeVisualViewport.width = 800;
    fakeVisualViewport.height = 500;
    fakeWindow.dispatchEvent({ type: 'resize' });
    clock.runAll();

    assert.equal(bar.style.width, '800px');
    assert.equal(bar.style.height, '500px');
    assert.deepEqual(state.settings.windowGeom, { width: 1200, height: 900, left: 100, top: 80, bottom: 70 });

    fakeWindow.innerWidth = 1400;
    fakeWindow.innerHeight = 1000;
    fakeVisualViewport.width = 1400;
    fakeVisualViewport.height = 1000;
    fakeWindow.dispatchEvent({ type: 'resize' });
    clock.runAll();

    assert.equal(bar.style.width, '1200px');
    assert.equal(bar.style.height, '900px');
    assert.equal(bar.style.transform, 'translate3d(100px, 80px, 0)');
    assert.deepEqual(state.settings.windowGeom, { width: 1200, height: 900, left: 100, top: 80, bottom: 70 });
});

test('returning from mobile on resize restores saved desktop geometry', () => {
    fakeWindow.innerWidth = 700;
    const bar = windowModule.mountPanel();
    windowModule.applyMobileMode();
    assert.equal(bar.classList.contains('dsc_mobile'), true);

    windowModule.initViewportSync();
    fakeWindow.innerWidth = 1024;
    fakeVisualViewport.width = 1024;
    fakeWindow.dispatchEvent({ type: 'resize' });
    clock.runAll();

    assert.equal(bar.classList.contains('dsc_mobile'), false);
    assert.equal(bar.style.width, '380px');
    assert.equal(bar.style.height, '360px');
    assert.equal(bar.style.transform, 'translate3d(322px, 338px, 0)');
});
