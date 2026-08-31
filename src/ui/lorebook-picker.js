// @ts-check
/**
 * Per-chat lorebook context controller.
 *
 * Binds the static settings.html skeleton (#dsc_lore_enable, #dsc_lore_group,
 * #dsc_lore_mode_auto, #dsc_lore_mode_manual, #dsc_lore_manual_group,
 * #dsc_lore_book, #dsc_lore_entries) to the per-chat lore configuration.
 * Loading is lazy: book names are fetched once per refresh, and a book's
 * entries load only after the book has been added to the panel. When the
 * skeleton is absent (template not rendered), every method is a safe no-op.
 */

import { tr } from '../core.js';
import {
    LORE_MODE,
    LORE_SCOPE,
    listLorebookNames,
    loadLorebookEntries,
    loreRefKey,
    normalizeLoreConfig,
    resolveAttachedLorebookSources,
} from '../lorebooks.js';

/** i18n key + English fallback per attached-lorebook binding role. */
const SCOPE_SOURCE_LABELS = Object.freeze({
    char: { fallback: 'character', key: 'dscomments.lore.scopeSourceChar' },
    chat: { fallback: 'chat', key: 'dscomments.lore.scopeSourceChat' },
    persona: { fallback: 'persona', key: 'dscomments.lore.scopeSourcePersona' },
});

/**
 * Human-readable binding labels for one book, e.g. ['персонаж', 'чат'].
 * @param {Array<{ role: 'char'|'chat'|'persona', book: string }>} sources
 * @param {string} book
 */
function bookRoleLabels(sources, book) {
    const roles = [];
    for (const source of sources) {
        if (source.book !== book || roles.includes(source.role)) continue;
        roles.push(source.role);
    }
    return roles.map(role => tr(SCOPE_SOURCE_LABELS[role].fallback, SCOPE_SOURCE_LABELS[role].key));
}

/**
 * Badge appended to a book name in the picker: the chat bindings, or '' for a
 * book that is not bound here (global or standalone).
 * @param {Array<{ role: 'char'|'chat'|'persona', book: string }>} sources
 * @param {string} book
 */
function bookBindingBadge(sources, book) {
    const labels = bookRoleLabels(sources, book);
    return labels.length ? ` — ${labels.join('·')}` : '';
}

/** @param {HTMLElement} element @param {string} role */
function markRole(element, role) {
    element.dataset.role = role;
    return element;
}

/**
 * @param {{
 *   root: HTMLElement,
 *   getCtx: () => ReturnType<import('../core.js').getCtx>,
 *   onChange: (config: ReturnType<typeof normalizeLoreConfig>) => void,
 * }} options
 */
export function createLorebookPicker({ root, getCtx, onChange }) {
    const doc = root.ownerDocument || document;
    const enableToggle = root.querySelector('#dsc_lore_enable');
    const group = root.querySelector('#dsc_lore_group');
    const modeAutoButton = root.querySelector('#dsc_lore_mode_auto');
    const modeManualButton = root.querySelector('#dsc_lore_mode_manual');
    const scopeGroup = root.querySelector('#dsc_lore_scope_group');
    const scopeToggle = root.querySelector('#dsc_lore_scope_attached');
    const scopeHint = root.querySelector('#dsc_lore_scope_hint');
    const manualGroup = root.querySelector('#dsc_lore_manual_group');
    const bookSelect = root.querySelector('#dsc_lore_book');
    const entriesHost = root.querySelector('#dsc_lore_entries');
    const bound = Boolean(
        enableToggle && group && modeAutoButton && modeManualButton
        && scopeGroup && scopeToggle && scopeHint
        && manualGroup && bookSelect && entriesHost,
    );

    /** @type {Array<{ element: HTMLElement, type: string, listener: EventListener }>} */
    const staticListeners = [];
    /** @type {Array<{ element: HTMLElement, type: string, listener: EventListener }>} */
    let renderedListeners = [];

    let config = normalizeLoreConfig();
    /** @type {string[]} */
    let bookNames = [];
    let namesLoaded = false;
    let namesError = false;
    /** @type {Map<string, { status: 'loading'|'ready'|'error', entries: Array<{ book: string, uid: number, label: unknown }> }>} */
    let bookData = new Map();
    let refreshToken = 0;
    let destroyed = false;

    /** @param {HTMLElement} element @param {string} type @param {EventListener} listener @param {boolean} [isStatic] */
    function listen(element, type, listener, isStatic = false) {
        element.addEventListener(type, listener);
        (isStatic ? staticListeners : renderedListeners).push({ element, type, listener });
    }

    function selectedKeys() {
        return new Set(config.selectedEntries.map(loreRefKey));
    }

    function emit(nextConfig) {
        if (destroyed || !bound) return;
        config = normalizeLoreConfig(nextConfig);
        render();
        void ensureData();
        onChange(config);
    }

    /** @param {HTMLElement} button @param {boolean} active */
    function setModeButtonState(button, active) {
        button.classList.toggle('dsc_seg_active', active);
        button.setAttribute('aria-pressed', String(active));
    }

    function renderModeControls() {
        enableToggle.checked = config.enabled;
        group.hidden = !config.enabled;
        const manual = config.mode === LORE_MODE.MANUAL;
        setModeButtonState(modeAutoButton, !manual);
        setModeButtonState(modeManualButton, manual);
        scopeGroup.hidden = manual;
        scopeToggle.checked = (config.autoScope ?? LORE_SCOPE.ALL) === LORE_SCOPE.ATTACHED;
        renderScopeHint();
        manualGroup.hidden = !manual;
    }

    /** Attached-books summary under the scope toggle (sync — pure ctx reads). */
    function renderScopeHint() {
        const sources = resolveAttachedLorebookSources(getCtx());
        if (!sources.length) {
            scopeHint.textContent = tr(
                'No lorebooks attached to this chat (character, chat or persona book).',
                'dscomments.lore.scopeHintNone',
            );
            return;
        }
        // Same book bound twice (e.g. char + chat) — show once with both roles.
        const seen = new Set();
        const items = [];
        for (const source of sources) {
            if (seen.has(source.book)) continue;
            seen.add(source.book);
            items.push(`${source.book} (${bookRoleLabels(sources, source.book).join('/')})`);
        }
        scopeHint.textContent = tr(
            'Attached lorebooks: {list}',
            'dscomments.lore.scopeHintList',
        ).replace('{list}', items.join(' · '));
    }

    function renderBookSelect() {
        const placeholder = doc.createElement('option');
        placeholder.value = '';
        placeholder.textContent = namesError
            ? tr('Could not load lorebooks', 'dscomments.lore.listError')
            : tr('Select a lorebook', 'dscomments.lore.select');
        const selectOptions = [placeholder];
        const added = new Set(config.manualBooks);
        if (!namesError) {
            // Binding badges («— персонаж/чат») separate chat-attached books
            // from globally-enabled or standalone ones at selection time.
            const sources = resolveAttachedLorebookSources(getCtx());
            for (const name of bookNames) {
                if (added.has(name)) continue;
                const option = doc.createElement('option');
                option.value = name;
                option.textContent = `${name}${bookBindingBadge(sources, name)}`;
                selectOptions.push(option);
            }
        }
        bookSelect.replaceChildren(...selectOptions);
        bookSelect.value = '';
        bookSelect.disabled = namesError || (namesLoaded && bookNames.length === 0);
    }

    /** @param {string} book */
    function renderBookSection(book) {
        const section = doc.createElement('section');
        const header = doc.createElement('div');
        const name = doc.createElement('span');
        const removeButton = doc.createElement('button');
        const missing = namesLoaded && !namesError && !bookNames.includes(book);

        markRole(section, 'lore-book');
        markRole(header, 'book-header');
        markRole(name, 'book-name');
        name.textContent = missing
            ? `${book} (${tr('unavailable', 'dscomments.lore.unavailable')})`
            : `${book}${bookBindingBadge(resolveAttachedLorebookSources(getCtx()), book)}`;
        removeButton.type = 'button';
        removeButton.textContent = '×';
        removeButton.setAttribute('aria-label', `${tr('Remove entry', 'dscomments.lore.remove')} ${book}`);
        markRole(removeButton, 'book-remove');

        header.appendChild(name);
        header.appendChild(removeButton);
        section.appendChild(header);

        listen(removeButton, 'click', () => {
            emit({
                ...config,
                manualBooks: config.manualBooks.filter(item => item !== book),
                selectedEntries: config.selectedEntries.filter(ref => ref.book !== book),
            });
        });

        if (missing) {
            entriesHost.appendChild(section);
            return;
        }

        const list = doc.createElement('div');
        markRole(list, 'entry-list');
        section.appendChild(list);

        const data = bookData.get(book);
        if (!data || data.status === 'loading') {
            const status = doc.createElement('span');
            status.textContent = tr('Loading lorebooks…', 'dscomments.lore.loading');
            markRole(status, 'book-status');
            list.appendChild(status);
        } else if (data.status === 'error') {
            const status = doc.createElement('span');
            status.textContent = tr('Could not load entries.', 'dscomments.lore.entriesError');
            markRole(status, 'book-status');
            list.appendChild(status);
        } else {
            renderEntryRows(list, book, data.entries);
        }
        entriesHost.appendChild(section);
    }

    /**
     * @param {HTMLElement} list
     * @param {string} book
     * @param {Array<{ book: string, uid: number, label: unknown }>} entries
     */
    function renderEntryRows(list, book, entries) {
        const selected = selectedKeys();
        const available = new Set(entries.map(loreRefKey));

        for (const entry of entries) {
            const row = doc.createElement('label');
            const checkbox = doc.createElement('input');
            const text = doc.createElement('span');

            checkbox.type = 'checkbox';
            checkbox.checked = selected.has(loreRefKey(entry));
            markRole(checkbox, 'entry-checkbox');
            text.textContent = String(entry.label ?? `${tr('Entry', 'dscomments.lore.entry')} ${entry.uid}`);

            row.appendChild(checkbox);
            row.appendChild(text);
            if (entry.vectorized) {
                const badge = doc.createElement('span');
                badge.textContent = '⬡';
                badge.title = tr('Vectorized entry', 'dscomments.lore.vectorized');
                markRole(badge, 'entry-vectorized');
                row.appendChild(badge);
            }
            list.appendChild(row);

            listen(checkbox, 'change', () => {
                const key = loreRefKey(entry);
                const refs = config.selectedEntries.filter(ref => loreRefKey(ref) !== key);
                if (checkbox.checked) refs.push({ book, uid: entry.uid });
                emit({ ...config, selectedEntries: refs });
            });
        }

        for (const ref of config.selectedEntries) {
            if (ref.book !== book || available.has(loreRefKey(ref))) continue;
            const row = doc.createElement('label');
            const checkbox = doc.createElement('input');
            const text = doc.createElement('span');

            checkbox.type = 'checkbox';
            checkbox.checked = true;
            markRole(checkbox, 'missing-checkbox');
            markRole(row, 'missing-row');
            text.textContent = `${tr('unavailable', 'dscomments.lore.unavailable')}: ${ref.uid}`;

            row.appendChild(checkbox);
            row.appendChild(text);
            list.appendChild(row);

            listen(checkbox, 'change', () => {
                if (checkbox.checked) return;
                const key = loreRefKey(ref);
                emit({
                    ...config,
                    selectedEntries: config.selectedEntries.filter(item => loreRefKey(item) !== key),
                });
            });
        }

        if (entries.length === 0) {
            const status = doc.createElement('span');
            status.textContent = tr('Empty book', 'dscomments.lore.emptyBook');
            markRole(status, 'book-status');
            list.appendChild(status);
        }
    }

    function render() {
        if (destroyed || !bound) return;
        for (const { element, type, listener } of renderedListeners) {
            element.removeEventListener(type, listener);
        }
        renderedListeners = [];
        renderModeControls();
        entriesHost.replaceChildren();
        if (!config.enabled || config.mode !== LORE_MODE.MANUAL) return;
        renderBookSelect();
        for (const book of config.manualBooks) renderBookSection(book);
    }

    /** @param {number} token */
    async function loadNames(token) {
        let names;
        try {
            names = await listLorebookNames(getCtx());
        } catch {
            if (destroyed || token !== refreshToken) return;
            namesError = true;
            namesLoaded = true;
            render();
            return;
        }
        if (destroyed || token !== refreshToken) return;
        bookNames = names;
        namesLoaded = true;
        namesError = false;
        render();
    }

    /** @param {string} book @param {number} token */
    async function loadBook(book, token) {
        const existing = bookData.get(book);
        if (existing && existing.status !== 'error') return;
        bookData.set(book, { status: 'loading', entries: [] });
        render();
        let entries;
        try {
            entries = await loadLorebookEntries(getCtx(), book);
        } catch {
            if (destroyed || token !== refreshToken) return;
            bookData.set(book, { status: 'error', entries: [] });
            render();
            return;
        }
        if (destroyed || token !== refreshToken) return;
        bookData.set(book, { status: 'ready', entries });
        render();
    }

    async function ensureData() {
        if (destroyed || !bound) return;
        if (!config.enabled || config.mode !== LORE_MODE.MANUAL) return;
        const token = refreshToken;
        if (!namesLoaded && !namesError) await loadNames(token);
        if (destroyed || token !== refreshToken || namesError) return;
        await Promise.all(config.manualBooks
            .filter(book => bookNames.includes(book) && !bookData.has(book))
            .map(book => loadBook(book, token)));
    }

    function resetLoads() {
        refreshToken++;
        bookNames = [];
        namesLoaded = false;
        namesError = false;
        bookData = new Map();
    }

    function setConfig(nextConfig) {
        if (destroyed || !bound) return;
        resetLoads();
        config = normalizeLoreConfig(nextConfig);
        render();
        // No ensureData() here: the only caller (the settings lifecycle) always
        // follows with refresh(), and loading twice would duplicate requests.
    }

    async function refresh() {
        if (destroyed || !bound) return;
        resetLoads();
        render();
        await ensureData();
    }

    /** @type {{ eventSource: object, type: string, listener: EventListener } | null} */
    let wiUpdatedSub = null;

    function unsubscribeWiUpdated() {
        if (wiUpdatedSub) {
            wiUpdatedSub.eventSource.removeListener(wiUpdatedSub.type, wiUpdatedSub.listener);
            wiUpdatedSub = null;
        }
    }

    function destroy() {
        if (destroyed) return;
        destroyed = true;
        unsubscribeWiUpdated();
        refreshToken++;
        for (const { element, type, listener } of [...staticListeners, ...renderedListeners]) {
            element.removeEventListener(type, listener);
        }
        staticListeners.length = 0;
        renderedListeners = [];
        bookData = new Map();
    }

    if (bound) {
        listen(enableToggle, 'change', () => {
            emit({ ...config, enabled: enableToggle.checked });
        }, true);
        listen(modeAutoButton, 'click', () => {
            if (config.mode !== LORE_MODE.AUTOMATIC) emit({ ...config, mode: LORE_MODE.AUTOMATIC });
        }, true);
        listen(modeManualButton, 'click', () => {
            if (config.mode !== LORE_MODE.MANUAL) emit({ ...config, mode: LORE_MODE.MANUAL });
        }, true);
        listen(scopeToggle, 'change', () => {
            const next = scopeToggle.checked ? LORE_SCOPE.ATTACHED : LORE_SCOPE.ALL;
            if ((config.autoScope ?? LORE_SCOPE.ALL) !== next) {
                emit({ ...config, autoScope: next });
            }
        }, true);
        listen(bookSelect, 'change', () => {
            const book = bookSelect.value;
            bookSelect.value = '';
            if (!book || config.manualBooks.includes(book)) return;
            emit({ ...config, manualBooks: [...config.manualBooks, book] });
        }, true);
        render();

        // ── WORLDINFO_UPDATED: invalidate cached entries when lorebook changes in ST ──
        if (typeof getCtx().eventTypes?.WORLDINFO_UPDATED === 'string') {
            const eventSource = getCtx().eventSource;
            if (eventSource && typeof eventSource.on === 'function') {
                const wiEventType = getCtx().eventTypes.WORLDINFO_UPDATED;
                const wiListener = () => { if (!destroyed) refresh(); };
                eventSource.on(wiEventType, wiListener);
                wiUpdatedSub = { eventSource, type: wiEventType, listener: wiListener };
            }
        }
    }

    return { refresh, setConfig, destroy };
}
