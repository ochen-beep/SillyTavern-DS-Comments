// @ts-check

import '../test-helpers/stub-runtime.mjs';
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createLorebookPicker } from '../src/ui/lorebook-picker.js';

class FakeElement {
    constructor(tagName, ownerDocument) {
        this.tagName = tagName.toUpperCase();
        this.ownerDocument = ownerDocument;
        this.parentElement = null;
        this.children = [];
        this.dataset = {};
        this.style = {};
        this.hidden = false;
        this.checked = false;
        this.disabled = false;
        this.type = '';
        this.id = '';
        this.value = '';
        this.className = '';
        this._textContent = '';
        Object.defineProperty(this, 'textContent', {
            get() {
                let text = this._textContent;
                for (const child of this.children) {
                    text += child.textContent;
                }
                return text;
            },
            set(value) { this._textContent = String(value); },
        });
        const classes = new Set();
        this.classList = {
            add: (...names) => names.forEach(name => classes.add(name)),
            remove: (...names) => names.forEach(name => classes.delete(name)),
            toggle: (name, force) => {
                const active = force ?? !classes.has(name);
                if (active) classes.add(name); else classes.delete(name);
                return active;
            },
            contains: name => classes.has(name),
        };
        this._attributes = new Map();
        this._listeners = new Map();
    }

    appendChild(child) {
        child.parentElement = this;
        this.children.push(child);
        return child;
    }

    replaceChildren(...children) {
        for (const child of this.children) child.parentElement = null;
        this.children = [];
        for (const child of children) this.appendChild(child);
    }

    remove() {
        if (!this.parentElement) return;
        this.parentElement.children = this.parentElement.children.filter(child => child !== this);
        this.parentElement = null;
    }

    addEventListener(type, listener) {
        if (!this._listeners.has(type)) this._listeners.set(type, new Set());
        this._listeners.get(type).add(listener);
    }

    removeEventListener(type, listener) {
        this._listeners.get(type)?.delete(listener);
    }

    dispatchEvent(event) {
        event.target ??= this;
        event.currentTarget = this;
        event.preventDefault ??= () => {};
        for (const listener of [...(this._listeners.get(event.type) ?? [])]) listener(event);
        return true;
    }

    setAttribute(name, value) {
        const text = String(value);
        this._attributes.set(name, text);
        if (name === 'id') this.id = text;
    }

    getAttribute(name) {
        if (name === 'id') return this.id || null;
        return this._attributes.get(name) ?? null;
    }

    querySelector(selector) {
        return this.querySelectorAll(selector)[0] ?? null;
    }

    querySelectorAll(selector) {
        const matches = [];
        const visit = element => {
            for (const child of element.children) {
                if (selector.startsWith('#') && child.id === selector.slice(1)) matches.push(child);
                visit(child);
            }
        };
        visit(this);
        return matches;
    }
}

class FakeDocument {
    createElement(tagName) {
        return new FakeElement(tagName, this);
    }
}

function descendants(root) {
    const result = [];
    const visit = element => {
        for (const child of element.children) {
            result.push(child);
            visit(child);
        }
    };
    visit(root);
    return result;
}

function byRole(root, role) {
    return descendants(root).filter(element => element.dataset.role === role);
}

function oneByRole(root, role, predicate = () => true) {
    const result = byRole(root, role).find(predicate);
    assert.ok(result, `Expected ${role} element`);
    return result;
}

function options(root) {
    return descendants(root).filter(element => element.tagName === 'OPTION');
}

function buildSkeleton(document, root) {
    const enable = document.createElement('input');
    enable.type = 'checkbox';
    enable.id = 'dsc_lore_enable';
    const group = document.createElement('div');
    group.id = 'dsc_lore_group';
    group.hidden = true;
    const auto = document.createElement('button');
    auto.id = 'dsc_lore_mode_auto';
    const manual = document.createElement('button');
    manual.id = 'dsc_lore_mode_manual';
    const scopeGroup = document.createElement('div');
    scopeGroup.id = 'dsc_lore_scope_group';
    scopeGroup.hidden = true;
    const scopeToggle = document.createElement('input');
    scopeToggle.type = 'checkbox';
    scopeToggle.id = 'dsc_lore_scope_attached';
    const scopeHint = document.createElement('small');
    scopeHint.id = 'dsc_lore_scope_hint';
    const manualGroup = document.createElement('div');
    manualGroup.id = 'dsc_lore_manual_group';
    manualGroup.hidden = true;
    const select = document.createElement('select');
    select.id = 'dsc_lore_book';
    const entries = document.createElement('div');
    entries.id = 'dsc_lore_entries';

    scopeGroup.appendChild(scopeToggle);
    scopeGroup.appendChild(scopeHint);
    manualGroup.appendChild(select);
    manualGroup.appendChild(entries);
    group.appendChild(auto);
    group.appendChild(manual);
    group.appendChild(scopeGroup);
    group.appendChild(manualGroup);
    root.appendChild(enable);
    root.appendChild(group);
    return {
        enable, group, auto, manual,
        scopeGroup, scopeToggle, scopeHint,
        manualGroup, select, entries,
    };
}

function makeCtx(books) {
    const ctx = {
        loads: [],
        namesCalls: 0,
        getWorldInfoNames: async () => { ctx.namesCalls++; return Object.keys(books); },
        loadWorldInfo: async book => { ctx.loads.push(book); return { entries: books[book] ?? {} }; },
    };
    return ctx;
}

function deferred() {
    let resolve;
    let reject;
    const promise = new Promise((done, fail) => { resolve = done; reject = fail; });
    return { promise, resolve, reject };
}

// Two macrotask turns: user-action loads chain names → book entries through
// several microtask hops, and a single setImmediate can race them.
const flush = async () => {
    await new Promise(resolve => setImmediate(resolve));
    await new Promise(resolve => setImmediate(resolve));
};

let originalDocument;
let document;
let root;
let skeleton;

beforeEach(() => {
    originalDocument = globalThis.document;
    document = new FakeDocument();
    globalThis.document = document;
    root = document.createElement('section');
    skeleton = buildSkeleton(document, root);
});

afterEach(() => {
    globalThis.document = originalDocument;
});

test('fresh chat config keeps the group hidden and skips all lore loading', async () => {
    const ctx = makeCtx({ Main: { 1: { uid: 1 } } });
    const picker = createLorebookPicker({ root, getCtx: () => ctx, onChange: () => {} });

    picker.setConfig(undefined);
    await picker.refresh();

    assert.equal(skeleton.enable.checked, false);
    assert.equal(skeleton.group.hidden, true);
    assert.equal(ctx.namesCalls, 0);
    assert.deepEqual(ctx.loads, []);
});

test('enabled automatic mode shows mode controls, hides the manual group, and skips loading', async () => {
    const ctx = makeCtx({ Main: { 1: { uid: 1 } } });
    const picker = createLorebookPicker({ root, getCtx: () => ctx, onChange: () => {} });

    picker.setConfig({ enabled: true, mode: 'automatic' });
    await picker.refresh();

    assert.equal(skeleton.enable.checked, true);
    assert.equal(skeleton.group.hidden, false);
    assert.equal(skeleton.auto.classList.contains('dsc_seg_active'), true);
    assert.equal(skeleton.auto.getAttribute('aria-pressed'), 'true');
    assert.equal(skeleton.manual.classList.contains('dsc_seg_active'), false);
    assert.equal(skeleton.manualGroup.hidden, true);
    assert.equal(ctx.namesCalls, 0);
    assert.deepEqual(ctx.loads, []);
});

test('manual mode loads names once and entries only for added books', async () => {
    const ctx = makeCtx({
        Added: { 1: { uid: 1, comment: 'One' }, 2: { uid: 2, comment: 'Two' } },
        Other: { 1: { uid: 1, comment: 'Other entry' } },
    });
    const picker = createLorebookPicker({ root, getCtx: () => ctx, onChange: () => {} });

    picker.setConfig({
        enabled: true, mode: 'manual',
        manualBooks: ['Added'],
        selectedEntries: [{ book: 'Added', uid: 2 }],
    });
    await picker.refresh();

    assert.equal(skeleton.manualGroup.hidden, false);
    assert.equal(ctx.namesCalls, 1);
    assert.deepEqual(ctx.loads, ['Added'], 'books not added to the panel must never load');
    const checkboxes = byRole(root, 'entry-checkbox');
    assert.equal(checkboxes.length, 2);
    assert.equal(checkboxes[0].checked, false);
    assert.equal(checkboxes[1].checked, true);
    assert.deepEqual(options(root).map(option => option.value), ['', 'Other']);
});

test('adding a book from the dropdown emits config, lazily loads entries, and excludes it from options', async () => {
    const changes = [];
    const ctx = makeCtx({
        Main: { 1: { uid: 1, comment: 'One' }, 2: { uid: 2, comment: 'Two' } },
        Second: { 5: { uid: 5, comment: 'Five' } },
    });
    const picker = createLorebookPicker({
        root,
        getCtx: () => ctx,
        onChange: config => changes.push(config),
    });
    picker.setConfig({ enabled: true, mode: 'manual', manualBooks: [], selectedEntries: [] });
    await picker.refresh();
    assert.deepEqual(ctx.loads, []);

    skeleton.select.value = 'Main';
    skeleton.select.dispatchEvent({ type: 'change' });
    assert.deepEqual(changes.at(-1), {
        enabled: true, mode: 'manual', manualBooks: ['Main'], selectedEntries: [], autoScope: undefined,
    });
    assert.equal(skeleton.select.value, '');

    await flush();
    assert.deepEqual(ctx.loads, ['Main']);
    const checkboxes = byRole(root, 'entry-checkbox');
    assert.equal(checkboxes.length, 2);
    assert.ok(checkboxes.every(checkbox => checkbox.checked === false),
        'entries of a freshly added book must be unchecked');
    assert.ok(!options(root).some(option => option.value === 'Main'));
    assert.ok(options(root).some(option => option.value === 'Second'));
});

test('toggling an entry checkbox emits updated refs', async () => {
    const changes = [];
    const ctx = makeCtx({ Main: { 1: { uid: 1, comment: 'One' }, 2: { uid: 2, comment: 'Two' } } });
    const picker = createLorebookPicker({
        root,
        getCtx: () => ctx,
        onChange: config => changes.push(config),
    });
    picker.setConfig({ enabled: true, mode: 'manual', manualBooks: ['Main'], selectedEntries: [] });
    await picker.refresh();

    let checkbox = byRole(root, 'entry-checkbox')[0];
    checkbox.checked = true;
    checkbox.dispatchEvent({ type: 'change' });
    assert.deepEqual(changes.at(-1), {
        enabled: true, mode: 'manual',
        manualBooks: ['Main'],
        selectedEntries: [{ book: 'Main', uid: 1 }],
        autoScope: undefined,
    });

    // Re-query after render replaced the DOM.
    checkbox = byRole(root, 'entry-checkbox')[0];
    assert.equal(checkbox.checked, true);
    checkbox.checked = false;
    checkbox.dispatchEvent({ type: 'change' });
    assert.deepEqual(changes.at(-1).selectedEntries, []);
});

test('the book remove button drops the book and all of its refs', async () => {
    const changes = [];
    const ctx = makeCtx({
        Alpha: { 1: { uid: 1, comment: 'A1' } },
        Beta: { 2: { uid: 2, comment: 'B2' } },
    });
    const picker = createLorebookPicker({
        root,
        getCtx: () => ctx,
        onChange: config => changes.push(config),
    });
    picker.setConfig({
        enabled: true, mode: 'manual',
        manualBooks: ['Alpha', 'Beta'],
        selectedEntries: [{ book: 'Alpha', uid: 1 }, { book: 'Beta', uid: 2 }],
    });
    await picker.refresh();

    const remove = oneByRole(root, 'book-remove', element => element.getAttribute('aria-label') === 'Remove entry Alpha');
    remove.dispatchEvent({ type: 'click' });

    assert.deepEqual(changes.at(-1), {
        enabled: true, mode: 'manual',
        manualBooks: ['Beta'],
        selectedEntries: [{ book: 'Beta', uid: 2 }],
        autoScope: undefined,
    });
    assert.deepEqual(byRole(root, 'book-name').map(element => element.textContent), ['Beta']);
});

test('an unavailable book renders a marked section, never loads, and can be removed', async () => {
    const changes = [];
    const ctx = makeCtx({});
    const picker = createLorebookPicker({
        root,
        getCtx: () => ctx,
        onChange: config => changes.push(config),
    });
    picker.setConfig({
        enabled: true, mode: 'manual',
        manualBooks: ['Ghost'],
        selectedEntries: [{ book: 'Ghost', uid: 7 }],
    });
    await picker.refresh();

    assert.deepEqual(ctx.loads, []);
    assert.match(oneByRole(root, 'book-name').textContent, /unavailable/);
    assert.equal(skeleton.select.disabled, true, 'no books → disabled select');

    oneByRole(root, 'book-remove').dispatchEvent({ type: 'click' });
    assert.deepEqual(changes.at(-1), {
        enabled: true, mode: 'manual', manualBooks: [], selectedEntries: [], autoScope: undefined,
    });
});

test('an unavailable uid renders a removable missing row inside its book', async () => {
    const changes = [];
    const ctx = makeCtx({ Main: { 1: { uid: 1, comment: 'Available' } } });
    const picker = createLorebookPicker({
        root,
        getCtx: () => ctx,
        onChange: config => changes.push(config),
    });
    picker.setConfig({
        enabled: true, mode: 'manual',
        manualBooks: ['Main'],
        selectedEntries: [{ book: 'Main', uid: 1 }, { book: 'Main', uid: 99 }],
    });
    await picker.refresh();

    const row = oneByRole(root, 'missing-row');
    assert.match(row.textContent, /99/);
    const checkbox = oneByRole(row, 'missing-checkbox');
    assert.equal(checkbox.checked, true);
    checkbox.checked = false;
    checkbox.dispatchEvent({ type: 'change' });

    assert.deepEqual(changes.at(-1).selectedEntries, [{ book: 'Main', uid: 1 }]);
    assert.equal(byRole(root, 'missing-row').length, 0);
});

test('disabling the lore toggle emits enabled false and hides the group', async () => {
    const changes = [];
    const ctx = makeCtx({ Main: { 1: { uid: 1, comment: 'One' } } });
    const picker = createLorebookPicker({
        root,
        getCtx: () => ctx,
        onChange: config => changes.push(config),
    });
    picker.setConfig({
        enabled: true, mode: 'manual',
        manualBooks: ['Main'],
        selectedEntries: [{ book: 'Main', uid: 1 }],
    });
    await picker.refresh();

    skeleton.enable.checked = false;
    skeleton.enable.dispatchEvent({ type: 'change' });

    assert.equal(changes.at(-1).enabled, false);
    assert.equal(skeleton.group.hidden, true);
    assert.equal(byRole(root, 'entry-checkbox').length, 0);
});

test('switching to manual loads lazily; switching back to automatic hides the manual group', async () => {
    const changes = [];
    const ctx = makeCtx({ Main: { 1: { uid: 1, comment: 'One' } } });
    const picker = createLorebookPicker({
        root,
        getCtx: () => ctx,
        onChange: config => changes.push(config),
    });
    picker.setConfig({ enabled: true, mode: 'automatic', manualBooks: ['Main'] });
    await picker.refresh();
    assert.equal(ctx.namesCalls, 0);

    skeleton.manual.dispatchEvent({ type: 'click' });
    assert.equal(changes.at(-1).mode, 'manual');
    await flush();
    assert.equal(ctx.namesCalls, 1);
    assert.deepEqual(ctx.loads, ['Main']);
    assert.equal(skeleton.manualGroup.hidden, false);

    skeleton.auto.dispatchEvent({ type: 'click' });
    assert.equal(changes.at(-1).mode, 'automatic');
    assert.equal(skeleton.manualGroup.hidden, true);
});

test('a names load failure renders a disabled error option and recovers on the next refresh', async () => {
    let fail = true;
    const ctx = {
        getWorldInfoNames: async () => {
            if (fail) throw new Error('network unavailable');
            return ['Main'];
        },
        loadWorldInfo: async () => ({ entries: {} }),
    };
    const picker = createLorebookPicker({ root, getCtx: () => ctx, onChange: () => {} });
    picker.setConfig({ enabled: true, mode: 'manual' });
    await picker.refresh();

    assert.equal(skeleton.select.disabled, true);
    assert.match(options(root)[0].textContent, /Could not load lorebooks/);

    fail = false;
    await picker.refresh();
    assert.equal(skeleton.select.disabled, false);
    assert.deepEqual(options(root).map(option => option.value), ['', 'Main']);
});

test('a book load failure renders an error status inside its section', async () => {
    const ctx = {
        getWorldInfoNames: async () => ['Broken'],
        loadWorldInfo: async () => { throw new Error('book load failed'); },
    };
    const picker = createLorebookPicker({ root, getCtx: () => ctx, onChange: () => {} });
    picker.setConfig({ enabled: true, mode: 'manual', manualBooks: ['Broken'], selectedEntries: [] });
    await picker.refresh();

    assert.match(oneByRole(root, 'book-status').textContent, /Could not load entries\./);
});

test('a stale refresh cannot overwrite a newer render', async () => {
    const oldNames = deferred();
    let ctx = {
        getWorldInfoNames: () => oldNames.promise,
        loadWorldInfo: async () => ({ entries: { 1: { uid: 1, comment: 'Old entry' } } }),
    };
    const picker = createLorebookPicker({ root, getCtx: () => ctx, onChange: () => {} });
    picker.setConfig({ enabled: true, mode: 'manual', manualBooks: ['Old'], selectedEntries: [{ book: 'Old', uid: 1 }] });
    const oldRefresh = picker.refresh();

    picker.setConfig({ enabled: true, mode: 'manual', manualBooks: ['New'], selectedEntries: [{ book: 'New', uid: 2 }] });
    ctx = makeCtx({ New: { 2: { uid: 2, comment: 'New entry' } } });
    await picker.refresh();
    oldNames.resolve(['Old']);
    await oldRefresh;

    assert.deepEqual(byRole(root, 'book-name').map(element => element.textContent), ['New']);
});

test('destroy removes listeners and ignores pending loads', async () => {
    const names = deferred();
    const changes = [];
    const picker = createLorebookPicker({
        root,
        getCtx: () => ({
            getWorldInfoNames: () => names.promise,
            loadWorldInfo: async () => ({ entries: {} }),
        }),
        onChange: config => changes.push(config),
    });
    picker.setConfig({ enabled: true, mode: 'manual' });
    const pending = picker.refresh();

    picker.destroy();
    skeleton.enable.checked = true;
    skeleton.enable.dispatchEvent({ type: 'change' });
    names.resolve(['Main']);
    await assert.doesNotReject(pending);

    assert.deepEqual(changes, []);
    assert.doesNotThrow(() => picker.setConfig({ enabled: true }));
    await assert.doesNotReject(picker.refresh());
});

test('an empty skeleton keeps every picker method a safe no-op', async () => {
    const bareRoot = document.createElement('div');
    const picker = createLorebookPicker({
        root: bareRoot,
        getCtx: () => ({
            getWorldInfoNames: async () => { throw new Error('must not be called'); },
        }),
        onChange: () => { throw new Error('must not be called'); },
    });

    assert.doesNotThrow(() => picker.setConfig({ enabled: true, mode: 'manual' }));
    await assert.doesNotReject(picker.refresh());
    assert.doesNotThrow(() => picker.destroy());
});

test('vectorized entries render a badge next to their label', async () => {
    const ctx = makeCtx({
        Main: {
            1: { uid: 1, comment: 'Plain' },
            2: { uid: 2, comment: 'Vec', vectorized: true },
            3: { uid: 3, comment: 'Another vec', vectorized: true },
        },
    });
    const picker = createLorebookPicker({ root, getCtx: () => ctx, onChange: () => {} });
    picker.setConfig({ enabled: true, mode: 'manual', manualBooks: ['Main'], selectedEntries: [] });
    await picker.refresh();

    const badges = byRole(root, 'entry-vectorized');
    assert.equal(badges.length, 2, 'two vectorized entries should each render a badge');
    assert.equal(badges[0].textContent, '⬡');
    assert.equal(badges[0].title, 'Vectorized entry');
});

test('WORLDINFO_UPDATED invalidates the book cache and reloads entries', async () => {
    let bookData = { 1: { uid: 1, comment: 'Old' } };
    const wiListeners = new Map();
    const eventSource = {
        on(name, fn) {
            if (!wiListeners.has(name)) wiListeners.set(name, []);
            wiListeners.get(name).push(fn);
        },
        removeListener(name, fn) {
            const arr = wiListeners.get(name);
            if (arr) { const idx = arr.indexOf(fn); if (idx !== -1) arr.splice(idx, 1); }
        },
    };
    const ctx = {
        ...makeCtx({ Main: bookData }),
        eventTypes: { WORLDINFO_UPDATED: 'worldinfo_updated' },
        eventSource,
    };
    const picker = createLorebookPicker({ root, getCtx: () => ctx, onChange: () => {} });
    picker.setConfig({ enabled: true, mode: 'manual', manualBooks: ['Main'] });
    await picker.refresh();
    // The entry-checkbox is the <input> — its label text comes from the next sibling <span>.
    const rows = byRole(root, 'entry-list')[0]?.children || [];
    assert.ok(rows.length > 0 && rows[0].textContent.includes('Old'),
        'initial render should contain the original entry label');

    // User edited the lorebook in SillyTavern
    bookData[1] = { uid: 1, comment: 'New' };
    const wiHandler = wiListeners.get('worldinfo_updated')[0];
    wiHandler();

    await flush();
    const refreshedRows = byRole(root, 'entry-list')[0]?.children || [];
    assert.ok(refreshedRows.length > 0 && refreshedRows[0].textContent.includes('New'),
        'after WORLDINFO_UPDATED the picker should show updated entry label');
});

test('destroy unsubscribes WORLDINFO_UPDATED listener', async () => {
    let bookData = { 1: { uid: 1, comment: 'Only' } };
    const wiListeners = new Map();
    const eventSource = {
        on(name, fn) {
            if (!wiListeners.has(name)) wiListeners.set(name, []);
            wiListeners.get(name).push(fn);
        },
        removeListener(name, fn) {
            const arr = wiListeners.get(name);
            if (arr) { const idx = arr.indexOf(fn); if (idx !== -1) arr.splice(idx, 1); }
        },
    };
    const ctx = {
        ...makeCtx({ Main: bookData }),
        eventTypes: { WORLDINFO_UPDATED: 'worldinfo_updated' },
        eventSource,
    };
    const picker = createLorebookPicker({ root, getCtx: () => ctx, onChange: () => {} });
    picker.setConfig({ enabled: true, mode: 'manual', manualBooks: ['Main'] });
    await picker.refresh();
    assert.equal((wiListeners.get('worldinfo_updated') || []).length, 1);

    picker.destroy();
    assert.equal((wiListeners.get('worldinfo_updated') || []).length, 0);
});

// ── Auto-scope toggle and binding badges ──

test('automatic mode shows the scope group reflecting config; manual mode hides it', async () => {
    const ctx = makeCtx({ Main: { 1: { uid: 1 } } });
    const picker = createLorebookPicker({ root, getCtx: () => ctx, onChange: () => {} });

    // Default config: scope visible (lore enabled + automatic), unchecked.
    picker.setConfig({ enabled: true, mode: 'automatic' });
    await picker.refresh();
    assert.equal(skeleton.scopeGroup.hidden, false);
    assert.equal(skeleton.scopeToggle.checked, false);

    // Explicit attached scope → checked.
    picker.setConfig({ enabled: true, mode: 'automatic', autoScope: 'attached' });
    await picker.refresh();
    assert.equal(skeleton.scopeToggle.checked, true);

    // Manual mode hides the scope group (it only governs automatic lore).
    picker.setConfig({ enabled: true, mode: 'manual', manualBooks: [] });
    await picker.refresh();
    assert.equal(skeleton.scopeGroup.hidden, true);
});

test('scope toggle emits attached and back to all through emit normalization', async () => {
    const changes = [];
    const ctx = makeCtx({ Main: { 1: { uid: 1 } } });
    const picker = createLorebookPicker({
        root,
        getCtx: () => ctx,
        onChange: config => changes.push(config),
    });
    picker.setConfig({ enabled: true, mode: 'automatic' });
    await picker.refresh();

    skeleton.scopeToggle.checked = true;
    skeleton.scopeToggle.dispatchEvent({ type: 'change' });
    assert.equal(changes.at(-1).autoScope, 'attached');
    assert.equal(skeleton.scopeToggle.checked, true);

    skeleton.scopeToggle.checked = false;
    skeleton.scopeToggle.dispatchEvent({ type: 'change' });
    assert.equal(changes.at(-1).autoScope, undefined, 'default scope normalizes to undefined');
});

test('scope hint lists attached books with roles or reports none', async () => {
    const plain = makeCtx({ Main: { 1: { uid: 1 } } });
    const plainPicker = createLorebookPicker({ root, getCtx: () => plain, onChange: () => {} });
    plainPicker.setConfig({ enabled: true, mode: 'automatic' });
    await plainPicker.refresh();
    assert.match(skeleton.scopeHint.textContent, /No lorebooks attached/);

    const bound = {
        ...makeCtx({ Main: { 1: { uid: 1 } } }),
        chatMetadata: { world_info: 'Main' },
    };
    const boundPicker = createLorebookPicker({ root, getCtx: () => bound, onChange: () => {} });
    boundPicker.setConfig({ enabled: true, mode: 'automatic' });
    await boundPicker.refresh();
    // English fallbacks: tr has no translate() in the test runtime.
    assert.match(skeleton.scopeHint.textContent, /Attached lorebooks: Main \(chat\)/);
});

test('manual picker badges chat-attached books in the dropdown and section headers', async () => {
    const ctx = {
        ...makeCtx({ Main: { 1: { uid: 1 } }, Second: { 1: { uid: 1 } } }),
        chatMetadata: { world_info: 'Second' },
    };
    const picker = createLorebookPicker({ root, getCtx: () => ctx, onChange: () => {} });
    picker.setConfig({ enabled: true, mode: 'manual', manualBooks: [] });
    await picker.refresh();

    // Dropdown: unbound book has no badge, the chat book carries one.
    const labels = options(root).map(option => option.textContent);
    assert.ok(labels.includes('Main'), 'unbound book shows no badge');
    assert.ok(labels.includes('Second — chat'), `got: ${labels.join(' | ')}`);

    // Added section header repeats the badge.
    const changes = [];
    const picker2 = createLorebookPicker({
        root,
        getCtx: () => ctx,
        onChange: config => changes.push(config),
    });
    picker2.setConfig({ enabled: true, mode: 'manual', manualBooks: ['Second'] });
    await picker2.refresh();
    assert.equal(oneByRole(root, 'book-name').textContent, 'Second — chat');
});
