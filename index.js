// @ts-check
/**
 * DS Comments — Main entry point
 * Lifecycle hooks + orchestrator.
 */

import {
    state, MODULE_NAME, DISPLAY_NAME, META_KEY, LF_PROMPTS, LF_API_KEY, LF_SOUND, LF_PINNED, LF_EVENTLOG,
    defaultSettings, FOLDER_NAME,
    loadSettings, saveSettings, flushSettings, getCtx, log, trace, warn, error, tr,
    setApiKey, flushApiKey, showConfirmModal, showInputModal, debounce, bumpGenerationEpoch,
    observePersistence, dumpRestoreLog, clearRestoreLog, collectRuntimeInfo,
    dumpDebugLog, clearDebugLog,
} from './src/core.js';
import { buildDiagnosticDump } from './src/diagnostic-dump.js';
import { generateFeed, getCurrentGenerationFingerprint } from './src/generator.js';
import {
    initPostScrollObserver, disconnectObservers, bindEvents, unbindEvents,
} from './src/events.js';
import {
    restoreForCurrentChatPost,
    clearFeed, clearAllFeeds,
    getCachedPost, getCachedPostForCurrentGeneration, initCacheRestore, storeFeed, showCurrentFeed,
    updatePostIndicator,
} from './src/cache.js';
import { initFeedController, showFeedHtml as setFeedText } from './src/ui/feed-controller.js';
import { playNotificationSound, initSoundKeyCounter, addCustomSound, migrateCustomSoundsToServer, missingCustomSoundKeys, BUNDLED_SOUNDS } from './src/sound.js';
import { deleteUserFile } from './src/user-files.js';
import {
    mountPanel, removePanel, isPanelVisible, syncPanelVisibility, initViewportSync, teardownWindowRuntime, isMobileViewport,
} from './src/ui/window.js';
import {
    bindChromeHandlers, syncRegenVisual, setStatus, makeRegenHandler,
} from './src/ui/chrome.js';
import { toggleQsMenu, closeQsMenu, isQsMenuOpen } from './src/ui/quickmenu.js';
import {
    syncDomFromState, syncPanelVisibility as syncSettingsSections, FIELD_MAP,
    applyFontSize, applyFontFamily, populateProfiles,
    syncPromptEditor, loadPromptContent, savePromptContent, savePromptAs, deletePrompt, resetPromptToBuiltin,
    syncNumericInput, createSettingsLorebookLifecycle,
} from './src/ui/settings-sync.js';
import { createLorebookPicker } from './src/ui/lorebook-picker.js';
import { getChatLoreConfig, saveChatLoreConfig } from './src/lorebooks.js';
import { lastCustomEndpointDebug } from './src/connection.js';
import {
    toggleTypographyPopover, closeTypographyPopover, isTypographyOpen,
} from './src/ui/typography.js';
import { initFeedGestures, destroyFeedGestures } from './src/ui/feed-gestures.js';
import { whenSendFormReady } from './src/ui/dom-ready.js';
import { initThemeSync, teardownThemeSync } from './src/ui/theme-sync.js';
// lifecycle.js breaks import cycles between cache↔index and quickmenu↔index.
// showEmptyState / onNoSaveModeChanged / setFeedText('') live there; dependencies
// from cache.js (storeFeed, showCurrentFeed, getCachedPost) and generator.js
// (generateFeed) are passed via the deps registry (initLifecycle).
// onNoSaveModeChanged is imported statically because the settings panel calls it
// directly on the "No save" toggle; this is safe — index→lifecycle is one-way.
import { initLifecycle, onNoSaveModeChanged, createInitializationController } from './src/lifecycle.js';
import { createPermanentRegistrationController } from './src/registration-lifecycle.js';
import { buildDscommentsCommand } from './src/slash-commands.js';
import { loadPinnedFeeds, flushPinnedPersist } from './src/pinned-store.js';
import { loadEventLog, flushEventLog, clearEventLog, dumpEventLog, recordEvent } from './src/event-log.js';
import { feedStoreSnapshot, mergeImportedEntries, loadFeedStore } from './src/feed-file-store.js';

// ── Lifecycle Hooks ──

const initialization = createInitializationController(init);

function startInit(label) {
    initialization.start().catch(e => error(`${label} error:`, e));
}

export function onActivate() {
    trace('onActivate: initializing…');
    startInit('init');
}

export async function onUpdate() {
    trace('onUpdate: no migrations required (settings migrations run in loadSettings).');
}

export function onEnable() {
    trace('onEnable: re-initializing…');
    startInit('onEnable');
}

export function onDisable() {
    trace('onDisable: cleaning up…');
    initialization.stop();
    try { cleanup(); } catch (e) { error('cleanup error:', e); }
}

export async function onClean() {
    trace('onClean: cleaning up + clearing storage…');
    initialization.stop();
    try { cleanup(); } catch (e) { error('cleanup error:', e); }
    // Cancel pending event-log writes before removing storage; otherwise a
    // debounce queued by cleanup() can recreate LF_EVENTLOG after deletion.
    try { await clearEventLog(); } catch (e) { error('clearEventLog error:', e); }
    // Mode-agnostic cleanup: clear both pinned Map and metadata.
    // clearPinnedPersist must finish (write chain settled + key removed) before
    // the loop below, or an in-flight pinned write can recreate the key.
    try { await clearAllFeeds(); } catch (e) { error('clearAllFeeds error:', e); }
    // Custom sounds are user content on the server now: delete the uploaded
    // files (parallel — same HOOK_TIMEOUT reasoning as the loop below) and
    // reset the registry so the dropdown doesn't keep dead entries.
    try {
        const soundMeta = state.settings.soundFiles || {};
        if (Object.keys(soundMeta).length) {
            const names = [...new Set(Object.values(soundMeta).map(m => m?.file).filter(Boolean))];
            await Promise.allSettled(names.map(n => deleteUserFile(n)));
            state.settings.soundFiles = {};
            state.settings.soundId = 'default';
            saveSettings();
        }
    } catch (e) { error('custom sound cleanup error:', e); }
    // Parallel removal: ST's callExtensionHook races every hook against a 5s
    // timeout (extensions.js HOOK_TIMEOUT). A sequenced `await removeItem`
    // loop over many custom sounds can exceed that on slow devices (Termux),
    // leaving the hook to time out silently while removal continues in the
    // background. Promise.allSettled collapses the loop into ~1-2 IndexedDB
    // transactions regardless of key count; allSettled so one failure does
    // not abort the rest.
    try {
        const keys = await SillyTavern.libs.localforage.keys();
        const targets = keys.filter(k =>
            k === LF_PROMPTS || k === LF_API_KEY || k === LF_PINNED || k === LF_EVENTLOG || k.startsWith(LF_SOUND));
        await Promise.allSettled(
            targets.map(k => SillyTavern.libs.localforage.removeItem(k)));
    } catch (e) { error('localforage cleanup error:', e); }
}

// ── Initialization ──

let _settingsPanelLoaded = false;
let _documentRuntimeBound = false;
let _launcherObserver = null;   // MutationObserver re-mounting launcher after ST re-renders QR bar
let _launcherRemount = null;    // debounced remount callback
let _launcherReadyDispose = null; // whenSendFormReady disposer — removes pending APP_READY listener on teardown

export function createPanelLifecycleGuard() {
    let token = 0;
    return {
        begin: () => ++token,
        isCurrent: (snapshot, { enabled, collapsed, visible }) => snapshot === token
            && enabled
            && !collapsed
            && visible,
    };
}

const panelLifecycle = createPanelLifecycleGuard();

function beginPanelLifecycleTransition() {
    return panelLifecycle.begin();
}

function isCurrentOpenPanel(snapshot) {
    return panelLifecycle.isCurrent(snapshot, {
        enabled: state.settings.enabled,
        collapsed: state.settings.collapsed,
        visible: isPanelVisible(),
    });
}

const lorebookPickerLifecycle = createSettingsLorebookLifecycle({
    createPicker: createLorebookPicker,
    getContext: getCtx,
    readConfig: getChatLoreConfig,
    persistConfig: saveChatLoreConfig,
    invalidate: bumpGenerationEpoch,
    getState: () => state,
});

/** Refresh the settings picker from the current chat, discarding stale loads. */
export async function refreshLorebookPicker() {
    await lorebookPickerLifecycle.refresh();
}

const permanentRegistrations = createPermanentRegistrationController({
    getContext: getCtx,
    buildSlashCommand,
    debugDefinitions: getDebugDefinitions,
    warn,
});

async function init(isCancelled) {
    trace('Initializing…');

    if (typeof SillyTavern === 'undefined' || !SillyTavern.getContext) {
        error('SillyTavern not available — aborting.');
        return;
    }
    const ctx = getCtx();
    if (!ctx) { warn('SillyTavern context not available'); return; }

    await loadSettings();
    if (isCancelled()) return;
    // Hydrate the noSave pinned-feeds Map from localforage BEFORE any restore,
    // so a noSave feed that survived F5 is visible on the first render. The
    // save-mode path ignores this Map entirely (it reads chatMetadata), so the
    // load is a no-op for save-mode users.
    await loadPinnedFeeds(state.pinnedFeeds, { currentChatId: ctx.chatId });
    if (isCancelled()) return;
    // Hydrate the persistent event log so the dump can cross the F5 boundary.
    await loadEventLog();
    if (isCancelled()) return;
    recordEvent('log', `session start (init, chat=${ctx.chatId || 'start screen'})`);
    initSoundKeyCounter();
    // Lift legacy browser-local sound blobs (localforage) into the server file
    // store so custom sounds survive device/browser changes. One-time per
    // entry, idempotent; per-entry failures retry on the next init.
    const migratedSounds = await migrateCustomSoundsToServer();
    if (isCancelled()) return;
    if (migratedSounds) trace(`sound: migrated ${migratedSounds} custom sound(s) to server storage`);

    if (!_settingsPanelLoaded) {
        try {
            if (ctx.renderExtensionTemplateAsync) {
                const settingsHtml = await ctx.renderExtensionTemplateAsync(`third-party/${FOLDER_NAME}`, 'settings');
                if (isCancelled()) return;
                const container = document.createElement('div');
                container.id = 'dsc_settings_container';
                container.className = 'extension_block';
                container.innerHTML = `<div class="inline-drawer">
                    <div class="inline-drawer-toggle inline-drawer-header">
                        <b>DS Comments</b>
                        <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
                    </div>
                    <div class="inline-drawer-content">${settingsHtml}</div>
                </div>`;
                // Resolve the host before append: under optional chaining a missing
                // #extensions_settings (extension init racing during early load)
                // silently skipped the append but still flipped _settingsPanelLoaded,
                // so the panel never appeared until reload. Gate the flag on a real
                // append so a later init retries cleanly.
                const host = document.getElementById('extensions_settings');
                if (!host) {
                    warn('settings host #extensions_settings not found — retry on next init');
                } else {
                    host.appendChild(container);
                    _settingsPanelLoaded = true;
                    bindSettingsPanelEvents();
                }
            }
        } catch (e) { warn('Failed to load settings panel:', e); }
    }

    await lorebookPickerLifecycle.mount(document.getElementById('dsc_settings_container'));
    if (isCancelled()) {
        lorebookPickerLifecycle.destroy();
        return;
    }

    // Sync DOM ↔ state (idempotent).
    syncDomFromState();
    syncSettingsSections();
    applyFontFamily(state.settings.fontFamily);
    applyFontSize(state.settings.fontSize);
    // Ensure built-in sounds appear in the dropdown before any custom upload.
    populateSoundDropdown();
    // Mark custom entries whose server file is gone (device move without the
    // file store, deleted file) instead of letting them silently play default.
    refreshSoundDropdownHealth();

    // Panel is always rendered (idempotent); visibility follows state.
    renderPanel();

    state.currentChatId = ctx.chatId;
    initCacheRestore({ getGenerationFingerprint: getCurrentGenerationFingerprint });
    const panelToken = beginPanelLifecycleTransition();
    if (ctx.chatId && !state.settings.noSaveMode) await loadFeedStore();
    if (ctx.chatId || state.settings.noSaveMode) await restoreFeedForCurrentContext();
    if (isCancelled()) return;
    if (isCurrentOpenPanel(panelToken)) initPostScrollObserver();

    bindEvents(generateFeed, undefined, {
        getGenerationFingerprint: getCurrentGenerationFingerprint,
        onChatChanged: () => refreshLorebookPicker(),
    });
    initLifecycle({ generateFeed, getCachedPostForCurrentGeneration, storeFeed, showCurrentFeed, syncRegenVisual });
    initFeedController({ generateFeed });

    // Flush settings + metadata on page hide (prevent data loss)
    bindDocumentRuntime();

    // Recompute opaque theme tokens whenever SillyTavern rewrites --SmartTheme*
    // on <html> (applyThemeColor). Keeps the comments window opaque on browsers
    // without CSS relative-color support (the style.css @supports fallback's gap).
    initThemeSync();

    permanentRegistrations.ensureSlashCommandRegistered();
    permanentRegistrations.ensureDebugFunctionsRegistered();

    // Re-mount launcher after SillyTavern rebuilds the quick-reply bar
    // (chat switch, group change, QR edits, etc.), which would otherwise wipe
    // our button. #send_form is core UI guaranteed present by APP_READY; if
    // already present (post-ready enable), attach synchronously, otherwise
    // wait for APP_READY (event-driven, no polling). The initial mount is
    // triggered here too: the observer only catches FUTURE mutations, but
    // #send_form was populated before APP_READY, so ensureLauncher() runs
    // once on attach to mount the launcher for the already-present QR bar.
    if (!_launcherObserver) {
        _launcherRemount = debounce(() => {
            if (state.settings.enabled) ensureLauncher();
        }, 100);
        // Keep the disposer so an extension disabled before APP_READY removes
        // the pending listener instead of attaching an orphan observer+button.
        _launcherReadyDispose = whenSendFormReady((sendForm) => {
            _launcherObserver = new MutationObserver(_launcherRemount);
            _launcherObserver.observe(sendForm, { childList: true, subtree: true });
            if (state.settings.enabled) ensureLauncher();
        });
    }

    log('Initialized.');
}

// ── Panel orchestration ──

/** Wrap a restore promise: log rejections instead of surfacing them. */
function observeRestore(result) {
    return Promise.resolve(result).catch(e => warn('restore feed error:', e));
}

/**
 * Restore the feed for the current context. noSaveMode reads the locally
 * persisted pinned feed; saveMode reloads from chat metadata.
 *
 * Raises navLockUntil across the (async) restore so the scroll observer's
 * first IntersectionObserver pick — which fires immediately after the panel is
 * revealed — cannot clobber the freshly restored target. This is what lets
 * scroll-follow stay enabled on mobile at all other times (see events.js
 * schedulePick): the suppression is a short reopen window, not the panel's
 * whole open lifetime.
 */
function restoreFeedForCurrentContext() {
    // Suppress scroll-driven auto-follow for the restore window. Set BEFORE the
    // await so it covers the synchronous reopen tail (initPostScrollObserver
    // runs right after this returns). 600ms is the upper bound for a slow
    // fingerprint lookup; the post-restore tail below trims it to a short
    // settle buffer when restore finishes early. Keep the window short: a long
    // one over-suppresses scroll-follow after a quick restore on mobile.
    const prevLock = state.navLockUntil;
    const raised = Math.max(state.navLockUntil, Date.now() + 600);
    state.navLockUntil = raised;
    const restore = state.settings.noSaveMode ? showCurrentFeed() : restoreForCurrentChatPost();
    const wrapped = observeRestore(restore);
    wrapped.then(() => {
        // Only trim if we still own the lock. A fast open->close->open
        // (or a scroll during restore) can raise navLockUntil above `raised`
        // after this .then captured `prevLock`; trimming to max(prevLock, now+250)
        // in that case would clobber the newer, higher lock and re-enable
        // auto-follow too early. Equality check: locks only rise via Math.max,
        // so navLockUntil === raised means no one superseded us.
        if (state.navLockUntil === raised) {
            state.navLockUntil = Math.max(prevLock, Date.now() + 250);
        }
    });
    return wrapped;
}

function renderPanel() {
    const bar = mountPanel();
    if (!bar) return;
    bindChromeHandlers({
        onToggleType: (btn) => toggleTypographyPopover(btn),
        onRegen: makeRegenHandler(generateFeed),
        onToggleQs: (btn) => toggleQsMenu(btn),
    });
    syncPanelVisibility();
    syncRegenVisual();
    initViewportSync();
    initFeedGestures();
    ensureLauncher();
}

/**
 * Sync panel visibility and feed after the enabled setting changes.
 */
async function syncPanelToSettings() {
    const panelToken = beginPanelLifecycleTransition();
    const bar = document.getElementById('dscWindow');
    if (state.settings.enabled) {
        state.settings.collapsed = false;   // enabling always expands the panel
        if (!bar) renderPanel();
        else syncPanelVisibility();
        ensureLauncher();
        await restoreFeedForCurrentContext();
        if (isCurrentOpenPanel(panelToken)) {
            initPostScrollObserver();
            if (!state.generationInProgress) generateFeed(null, null, false);
        }
    } else {
        if (bar) syncPanelVisibility();
        disconnectObservers();
    }
    syncRegenVisual();
    const enabledCb = document.getElementById('dsc_enabled');
    if (enabledCb) enabledCb.checked = state.settings.enabled;
    ensureLauncher();
}

// ── Launcher button (in quick-reply bar) ──

function getQuickReplyBar() {
    return document.querySelector('#send_form #qr--bar')
        || document.getElementById('qr--bar')
        || document.querySelector('#send_form .qr--bar');
}

/**
 * Where to mount the launcher. #qr--bar's button styling is scoped to
 * `.qr--buttons`, so a bare child of #qr--bar gets neither styling nor a proper
 * flex slot on mobile. Prefer the inner .qr--buttons row when it exists.
 */
function getLauncherHost() {
    const qrBar = getQuickReplyBar();
    if (!qrBar) return null;
    return qrBar.querySelector('.qr--buttons') || qrBar;
}

export function ensureLauncher() {
    const existing = document.getElementById('dsc_launcher');
    if (!state.settings.enabled) {
        if (existing) existing.remove();
        document.body.classList.remove('dsc-launcher-mounted');
        return null;
    }
    const host = getLauncherHost();
    if (!host) { document.body.classList.remove('dsc-launcher-mounted'); return null; }
    let btn = existing;
    if (!btn) {
        btn = document.createElement('div');
        btn.id = 'dsc_launcher';
        btn.className = 'qr--button menu_button interactable dsc_launcher';
        btn.tabIndex = 0;
        btn.setAttribute('role', 'button');
        btn.setAttribute('aria-label', 'DS Comments');
        btn.innerHTML = '<span aria-hidden="true">💬</span>';
        btn.addEventListener('click', (e) => { e.preventDefault(); e.stopPropagation(); toggleLauncherPanel(); });
        btn.addEventListener('keydown', (e) => {
            if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggleLauncherPanel(); }
        });
    }
    if (btn.parentElement !== host) host.appendChild(btn);
    document.body.classList.add('dsc-launcher-mounted');
    btn.classList.toggle('dsc_launcher_active', isPanelVisible());
    return btn;
}

/**
 * Launcher click handler: toggle the panel open/collapsed. Does NOT touch
 * `enabled` (that's the power button / checkbox's job).
 */
async function toggleLauncherPanel() {
    if (!state.settings.enabled) return;
    const panelToken = beginPanelLifecycleTransition();
    state.settings.collapsed = !state.settings.collapsed;
    saveSettings();
    mountPanel();                       // ensure DOM exists (idempotent)
    syncPanelVisibility();              // apply new collapsed state
    bindChromeHandlers({                // header buttons work on (re)open
        onToggleType: (btn) => toggleTypographyPopover(btn),
        onRegen: makeRegenHandler(generateFeed),
        onToggleQs: (btn) => toggleQsMenu(btn),
    });
    ensureLauncher();                   // refresh launcher active state
    if (!state.settings.collapsed) {
        await restoreFeedForCurrentContext();
        if (isCurrentOpenPanel(panelToken)) initPostScrollObserver();
    } else {
        disconnectObservers();
    }
}

// ── Settings panel event binding ──

function bindSettingsPanelEvents() {
    const root = document.getElementById('dsc_settings_container') || document.getElementById('extensions_settings');
    if (!root) return;

    // Section accordion toggles
    root.addEventListener('click', (e) => {
        const header = e.target.closest('.dsc_section_header');
        if (header) {
            e.stopPropagation();
            const expanded = header.getAttribute('aria-expanded') === 'true';
            header.setAttribute('aria-expanded', String(!expanded));
            const body = header.nextElementSibling;
            if (body) body.hidden = expanded;
            return;
        }
        // Segmented source buttons
        const segBtn = e.target.closest('[data-dsc-src]');
        if (segBtn) {
            state.settings.apiSource = segBtn.dataset.dscSrc;
            saveSettings();
            root.querySelectorAll('[data-dsc-src]').forEach(b => {
                const active = b === segBtn;
                b.classList.toggle('dsc_seg_active', active);
                b.setAttribute('aria-pressed', String(active));
            });
            syncSettingsSections();
            return;
        }
        // Prompt save / create / reset / delete
        if (e.target.closest('#dsc_template_save'))   { handleTemplateSave(); return; }
        if (e.target.closest('#dsc_template_create')) { handleTemplateCreate(); return; }
        if (e.target.closest('#dsc_template_reset'))  { handleTemplateReset(); return; }
        if (e.target.closest('#dsc_template_del'))    { handleTemplateDel(); return; }
        if (e.target.closest('#dsc_sound_test')) { playNotificationSound(); return; }
        // Danger zone: clear feed + all cached commentary.
        if (e.target.closest('#dsc_clear_all')) { handleClearAll(); return; }
        // Debug: export captured restore/feed-loss log as a downloadable .json.
        if (e.target.closest('#dsc_dump_logs')) { handleDumpLogs(); return; }
        // Comments export/import (server-file store travels outside the chat).
        if (e.target.closest('#dsc_export_feeds')) { handleExportFeeds(); return; }
        if (e.target.closest('#dsc_import_feeds')) {
            const fileInput = root.querySelector('#dsc_import_feeds_file');
            if (fileInput) { fileInput.value = ''; fileInput.click(); }
            return;
        }
    });

    // change events (selects, checkboxes)
    root.addEventListener('change', (e) => {
        const el = e.target;
        // Custom sound upload: a file input is not a FIELD_MAP setting, so the
        // cfg gate below would silently drop its change event. Handle it first.
        if (el.id === 'dsc_sound_file') {
            const file = el.files?.[0];
            if (file) {
                if (file.size > 5 * 1024 * 1024) { toastr?.error(tr('File is too large. Maximum: 5 MB.', 'dscomments.file.tooLarge')); el.value = ''; return; }
                const reader = new FileReader();
                reader.onload = async () => {
                    // Original extension is the fallback when the data-URL mime
                    // doesn't map (sound.js maps known audio mimes first).
                    const ext = (file.name.match(/\.([a-z0-9]+)\s*$/i) || [])[1];
                    const key = await addCustomSound(file.name.replace(/\.[^.]+$/, ''), reader.result, { ext });
                    if (key) { _missingSoundKeys.delete(key); populateSoundDropdown(); }
                };
                reader.readAsDataURL(file);
                el.value = '';
            }
            return;
        }
        // Comments import: read the picked JSON and merge into the store.
        if (el.id === 'dsc_import_feeds_file') {
            const file = el.files?.[0];
            el.value = '';
            if (file) handleImportFeeds(file);
            return;
        }
        const cfg = FIELD_MAP[el.id];
        if (!cfg) return;
        if (el.id === 'dsc_apikey') { flushApiKey(); return; }
        if (el.id === 'dsc_template') {
            state.settings.promptTemplate = el.value;
            saveSettings();
            syncPromptEditor();
            return;
        }
        if (el.id === 'dsc_profile') {
            state.settings.profileId = el.value;
            saveSettings();
            // The option label already contains the model; full text is in the select's tooltip.
            el.title = el.selectedOptions[0]?.textContent || '';
            return;
        }
        if (el.id === 'dsc_sound_select') {
            state.settings.soundId = el.value || 'default';
            saveSettings();
            return;
        }
        if (el.id === 'dsc_nosave') {
            state.settings.noSaveMode = el.checked;
            onNoSaveModeChanged().catch(e => error('onNoSaveModeChanged error:', e));
            return;
        }
        if (cfg.type === 'checkbox') {
            state.settings[cfg.prop] = el.checked;
        } else if (cfg.type === 'number' || cfg.type === 'range') {
            syncNumericInput(el);
        } else {
            state.settings[cfg.prop] = el.value;
        }
        saveSettings();

        // Section visibility follow-ups
        if (el.id === 'dsc_hist') syncSettingsSections();
        if (el.id === 'dsc_jb_enable') syncSettingsSections();
        if (el.id === 'dsc_sound_enable') {
            document.getElementById('dsc_sound_body').hidden = !el.checked;
            const volume = document.getElementById('dsc_sound_volume');
            if (volume) volume.disabled = !el.checked;
        }
        if (el.id === 'dsc_fontfam') { applyFontFamily(el.value); }
        if (el.id === 'dsc_enabled') { syncPanelToSettings().catch(e => error('syncPanelToSettings error:', e)); }
    });

    // input events (text, number, range, textarea)
    root.addEventListener('input', (e) => {
        const el = e.target;
        const cfg = FIELD_MAP[el.id];
        if (!cfg) return;
        if (el.id === 'dsc_apikey') { setApiKey(el.value); return; }
        // Not saved on every keystroke: dsc_template_text is saved by the Save
        // button, dsc_jb_text by a change event on blur through the common
        // FIELD_MAP path below.
        if (el.id === 'dsc_template_text' || el.id === 'dsc_jb_text') return;
        if (cfg.type === 'number' || cfg.type === 'range') {
            syncNumericInput(el);
        } else {
            state.settings[cfg.prop] = el.value;
        }
        saveSettings();
    });
}

// Built-in templates are read-only. Saving an active built-in forces a name
// prompt and creates a new user template.
async function handleTemplateSave() {
    const ta = document.getElementById('dsc_template_text');
    const cur = state.settings.promptTemplate || 'main';
    const content = ta?.value || '';
    // An accidental empty save would later read back as "template exists but
    // blank" and break generation with a confusing no-template error — refuse.
    if (!content.trim()) {
        toastr?.warning(tr('The template is empty — enter some text first.', 'dscomments.template.emptySave'));
        return;
    }
    if (cur === 'main') {
        const name = await showInputModal(tr('Save as a new template:', 'dscomments.template.saveAs'), 'main_copy');
        if (!name) return;
        const ok = await savePromptAs(name, content);
        if (ok) { await syncPromptEditor(); toastr?.success(tr('Template created', 'dscomments.template.created')); }
        else { toastr?.warning(tr('The name \'main\' is reserved for the built-in template.', 'dscomments.template.reservedName')); }
        return;
    }
    await savePromptContent(cur, content);
    toastr?.success(tr('Template saved', 'dscomments.template.saved'));
}

async function handleTemplateCreate() {
    const ta = document.getElementById('dsc_template_text');
    const cur = state.settings.promptTemplate || 'main';
    const name = await showInputModal(tr('New template name:', 'dscomments.template.name'), `${cur}_copy`);
    if (!name) return;
    const ok = await savePromptAs(name, ta?.value || '');
    if (ok) { await syncPromptEditor(); toastr?.success(tr('Template created', 'dscomments.template.created')); }
    else { toastr?.warning(tr('The name \'main\' is reserved for the built-in template.', 'dscomments.template.reservedName')); }
}

async function handleTemplateReset() {
    const cur = state.settings.promptTemplate || 'main';
    if (cur === 'main') return;   // Built-ins cannot be reset (button is disabled; guard anyway).
    const ok = await showConfirmModal(tr('Reset vibe to the built-in template (main)?', 'dscomments.template.resetConfirm'));
    if (!ok) return;
    await resetPromptToBuiltin();
    await syncPromptEditor();
    toastr?.success(tr('Vibe reset to main', 'dscomments.template.reset'));
}

async function handleTemplateDel() {
    const cur = state.settings.promptTemplate || 'main';
    if (cur === 'main') return;   // Built-ins cannot be deleted (button is disabled; guard anyway).
    const ok = await showConfirmModal(tr('Delete this template?', 'dscomments.template.deleteConfirm'));
    if (!ok) return;
    await deletePrompt(cur);
    await syncPromptEditor();
    toastr?.success(tr('Template deleted', 'dscomments.template.deleted'));
}

/**
 * Abort an in-flight generation AND invalidate the epoch so a request resolving
 * afterwards can't render/store — used by every cache-clear path (settings
 * button, slash command, debug function) and by cleanup(). Distinct from the
 * status-overlay cancel (chrome.js), which aborts WITHOUT bumping the epoch so
 * the generator's catch renders the "Генерация отменена" state; a clear must
 * throw the result away entirely.
 */
function abortActiveGeneration() {
    bumpGenerationEpoch();
    if (state.abortController) { state.abortController.abort(); state.abortController = null; }
    state.generationOwner = null;
    state.generationInProgress = false;
    state.generationTarget = null;
    state.generationObservedTarget = null;
}

/** Clear feed + cache for current chat. */
async function handleClearAll() {
    const ok = await showConfirmModal(tr('Clear the current chat feed and all commentary cache?', 'dscomments.cache.clearConfirm'));
    if (!ok) return;
    // Mode-agnostic: noSaveMode deletes from Map, saveMode deletes metadata.
    abortActiveGeneration();
    clearFeed();
    setFeedText('');
    updatePostIndicator();
    toastr?.success(tr('Feed and cache cleared', 'dscomments.cache.cleared'));
}

/**
 * Export the diagnostic log + non-sensitive runtime context as a .json download.
 * JSON is human-readable AND machine-parseable (the earlier restore probe already
 * prints structured lines), with runtime info included so mobile-feed-loss causes
 * (Connection Manager readiness, fingerprint drift) can be diagnosed offline.
 */
async function handleDumpLogs() {
    try {
        const runtimeInfo = await collectRuntimeInfo();
        const payload = buildDiagnosticDump({
            runtime: runtimeInfo,
            restoreLog: dumpRestoreLog(),
            debugLog: dumpDebugLog(),
            eventLog: dumpEventLog(),
        });
        const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const stamp = new Date().toISOString().replace(/[:.]/g, '-');
        const a = document.createElement('a');
        a.href = url;
        a.download = `dscomments-debug-${stamp}.json`;
        document.body.appendChild(a);
        a.click();
        a.remove();
        setTimeout(() => URL.revokeObjectURL(url), 1000);
        toastr?.success(tr('Logs exported', 'dscomments.debug.exported'));
    } catch (e) {
        error('handleDumpLogs error:', e);
        toastr?.error(`${tr('Could not export logs: {msg}', 'dscomments.debug.exportError').replace('{msg}', e?.message || e)}`);
    }
}

// ── Comments export / import (server-file store) ──
// Comments no longer travel inside the chat file; these buttons are the
// portable backup/transfer path between devices and ST instances.

async function handleExportFeeds() {
    try {
        const snap = feedStoreSnapshot();
        if (!snap?.loaded) {
            await loadFeedStore();
        }
        const finalSnap = feedStoreSnapshot();
        if (!finalSnap?.loaded || !Object.keys(finalSnap.entries).length) {
            toastr?.warning(tr('No comments to export in this chat.', 'dscomments.storage.exportEmpty'));
            return;
        }
        const payload = {
            probe: 'DS Comments feed export',
            exportedAt: new Date().toISOString(),
            chatId: getCtx()?.chatId ?? null,
            file: finalSnap.key,
            v: 2,
            entries: finalSnap.entries,
        };
        const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 10);
        const a = document.createElement('a');
        a.href = url;
        a.download = `dscomments-feeds-${stamp}.json`;
        document.body.appendChild(a);
        a.click();
        a.remove();
        setTimeout(() => URL.revokeObjectURL(url), 1000);
        toastr?.success(tr('Comments exported', 'dscomments.storage.exported'));
    } catch (e) {
        error('handleExportFeeds error:', e);
        toastr?.error(`${tr('Failed to export comments: {msg}', 'dscomments.storage.exportError').replace('{msg}', e?.message || e)}`);
    }
}

async function handleImportFeeds(file) {
    try {
        // Same cap as custom sound uploads: a multi-hundred-MB JSON would be
        // parsed and merged into the mirror before any limit could react.
        if (file.size > 5 * 1024 * 1024) {
            toastr?.error(tr('File is too large. Maximum: 5 MB.', 'dscomments.file.tooLarge'));
            return;
        }
        const text = await file.text();
        const doc = JSON.parse(text);
        if (!doc || typeof doc !== 'object' || !doc.entries || typeof doc.entries !== 'object') {
            toastr?.error(tr('This file does not look like a DS Comments export.', 'dscomments.storage.importBadFile'));
            return;
        }
        if (!feedStoreSnapshot()?.loaded) {
            await loadFeedStore();
        }
        const { merged, skipped } = mergeImportedEntries(doc);
        if (merged > 0) {
            recordEvent('log', `imported ${merged} feed entries from ${file.name}`);
            toastr?.success(tr('Imported entries: {n}', 'dscomments.storage.imported').replace('{n}', String(merged)));
            if (skipped > 0) {
                toastr?.warning(tr('Skipped entries: {n} (size or count limit).', 'dscomments.storage.importSkipped').replace('{n}', String(skipped)));
            }
            // Refresh the panel if the current post gained an entry.
            updatePostIndicator();
        } else if (skipped > 0) {
            toastr?.warning(tr('Skipped entries: {n} (size or count limit).', 'dscomments.storage.importSkipped').replace('{n}', String(skipped)));
        } else {
            toastr?.info(tr('No new entries found (all already present or newer).', 'dscomments.storage.importNoop'));
        }
    } catch (e) {
        error('handleImportFeeds error:', e);
        toastr?.error(`${tr('Failed to import comments: {msg}', 'dscomments.storage.importError').replace('{msg}', e?.message || e)}`);
    }
}

// ── Sound dropdown population ──

// Custom keys whose server file is gone — label marker only; playback falls
// back to the default bundled sound for those entries.
let _missingSoundKeys = new Set();

function refreshSoundDropdownHealth() {
    missingCustomSoundKeys().then((missing) => {
        if (!missing.size) return;
        _missingSoundKeys = missing;
        populateSoundDropdown();
    }).catch(() => { /* diagnostics only — never block the UI */ });
}

function populateSoundDropdown() {
    const select = document.getElementById('dsc_sound_select');
    if (!select) return;
    select.innerHTML = '';
    if (BUNDLED_SOUNDS.length) {
        const grp = document.createElement('optgroup');
        grp.label = tr('Built-in', 'dscomments.sound.builtIn');
        for (const s of BUNDLED_SOUNDS) {
            const o = document.createElement('option');
            o.value = s.key; o.textContent = s.name;
            grp.appendChild(o);
        }
        select.appendChild(grp);
    }
    const custom = state.settings.soundFiles || {};
    const keys = Object.keys(custom);
    if (keys.length) {
        const grp = document.createElement('optgroup');
        grp.label = tr('Custom', 'dscomments.sound.custom');
        for (const k of keys) {
            const o = document.createElement('option');
            o.value = k;
            o.textContent = custom[k]?.name || k;
            if (_missingSoundKeys.has(k)) {
                o.textContent += ` ⚠ ${tr('file not found', 'dscomments.sound.missing')}`;
            }
            grp.appendChild(o);
        }
        select.appendChild(grp);
    }
    select.value = state.settings.soundId || 'default';
}

// ── Permanent SillyTavern registrations ──

/**
 * Action bodies for the flat /dscomments command. ST 1.18.0 has no
 * `subcommands` support (see src/slash-commands.js), so the three former
 * subcommand callbacks live here as plain handlers dispatched by argument.
 */
function buildSlashCommand(st) {
    return buildDscommentsCommand(st, {
        toggle: () => {
            state.settings.enabled = !state.settings.enabled;
            saveSettings();
            syncPanelToSettings();
            return state.settings.enabled ? tr('DS Comments enabled', 'dscomments.command.enabled') : tr('DS Comments disabled', 'dscomments.command.disabled');
        },
        regenerate: () => {
            if (!state.settings.enabled) return tr('DS Comments disabled', 'dscomments.command.disabled');
            if (state.generationInProgress) return tr('Already generating…', 'dscomments.command.alreadyGenerating');
            generateFeed(null, null, true);
            return tr('Regenerating…', 'dscomments.command.regenerating');
        },
        clear: async () => {
            try {
                abortActiveGeneration();
                clearFeed();
                setFeedText('');
                updatePostIndicator();
                return tr('Feed and cache cleared', 'dscomments.cache.cleared');
            } catch (e) { return `${tr('Error: {msg}', 'dscomments.status.error').replace('{msg}', e.message)}`; }
        },
    });
}

function getDebugDefinitions() {
    return [
        {
            id: 'dscomments_clear_cache',
            name: 'Очистить кэш DS Comments',
            description: 'Удалить кэш комментариев текущего чата (адаптер)',
            callback: async () => {
                abortActiveGeneration();
                clearFeed();
                setFeedText('');
                return { ok: true, message: 'Кэш DS Comments очищен (текущий чат).' };
            },
        },
        {
            id: 'dscomments_cache_info',
            name: 'Информация о кэше DS Comments',
            description: 'Статистика кэша',
            callback: () => {
                const snap = feedStoreSnapshot();
                if (!snap?.loaded) return { ok: true, message: 'Кэш не загружен (нет активного чата).' };
                const entries = Object.keys(snap.entries).length;
                return { ok: true, message: `Файл: ${snap.key}, записей: ${entries}, текущий: #${state.currentPostId ?? 'нет'}[${state.currentSwipeIdx}]` };
            },
        },
        {
            id: 'dscomments_custom_endpoint_log',
            name: 'DS Comments: последний запрос кастомного эндпоинта',
            description: 'Показать последний запрос/ответ для отладки',
            callback: () => {
                const d = lastCustomEndpointDebug;
                if (!d.request && !d.response && !d.error) return { ok: true, message: 'Запросов к кастомному эндпоинту ещё не было.' };
                const lines = [];
                if (d.request) {
                    lines.push(`→ URL: ${d.request.url}`);
                    lines.push(`  Модель: ${d.request.model}`);
                    if (Array.isArray(d.request.messages)) {
                        lines.push(`  Сообщений: ${d.request.messages.length}`);
                    } else if (Array.isArray(d.request.messageChars)) {
                        lines.push(`  Сообщений: ${d.request.messageChars.length} (объём, зн.: ${d.request.messageChars.join('/')})`);
                        lines.push('  Полные тела запроса доступны только в Debug-режиме (настройки расширения).');
                    }
                }
                if (d.response) {
                    lines.push(`← Статус: ${d.response.status} (${d.response.durationMs}ms)`);
                    if (typeof d.response.textChars === 'number' && d.response.text === undefined) {
                        lines.push(`  Ответ: ${d.response.textChars} зн. (полный текст — в Debug-режиме)`);
                    }
                }
                if (d.error) lines.push(`✗ Ошибка: ${d.error.message}`);
                return { ok: true, message: lines.join('\n') };
            },
        },
        {
            id: 'dscomments_pinned_info',
            name: 'DS Comments: состояние pinned-фидов',
            description: 'Показать state.pinnedFeeds для отладки noSaveMode',
            callback: () => {
                const map = state.pinnedFeeds;
                if (!map || map.size === 0) {
                    return { ok: true, message: `pinnedFeeds пуст. noSaveMode=${state.settings.noSaveMode}.` };
                }
                const lines = [`pinnedFeeds (${map.size} ${map.size === 1 ? 'запись' : 'записей'}), noSaveMode=${state.settings.noSaveMode}:`];
                for (const [chatId, feed] of map.entries()) {
                    lines.push(`  chat ${chatId}: #${feed.msgId}[${feed.swipeIdx}] (${feed.html.length} chars, ${new Date(feed.ts).toLocaleTimeString()})`);
                }
                return { ok: true, message: lines.join('\n') };
            },
        },
        {
            id: 'dscomments_restore_log',
            name: 'DS Comments: лог восстановлений фида',
            description: 'Зонд: последние решения restore (расследование потери комментариев на мобиле)',
            callback: () => ({ ok: true, message: dumpRestoreLog() }),
        },
        {
            id: 'dscomments_restore_log_clear',
            name: 'DS Comments: очистить лог восстановлений',
            description: 'Очистить буфер зонда restore',
            callback: () => { clearRestoreLog(); return { ok: true, message: 'Лог восстановлений очищен.' }; },
        },
        {
            id: 'dscomments_debug_log',
            name: 'DS Comments: полный дебаг-лог',
            description: 'Полный лог log/warn/error расширения + последняя генерация (промпты/ответ). Включите Debug-режим в настройках.',
            callback: () => ({ ok: true, message: dumpDebugLog() }),
        },
        {
            id: 'dscomments_debug_log_clear',
            name: 'DS Comments: очистить дебаг-лог',
            description: 'Очистить буфер полного лога и слоты последней генерации',
            callback: () => { clearDebugLog(); return { ok: true, message: 'Дебаг-лог очищен.' }; },
        },
    ];
}

// ── Document-level runtime bindings (click + visibility) ──

function onVisibilityChange() {
    if (document.visibilityState !== 'hidden') return;
    flushSettings();
    flushApiKey();
    flushPinnedPersist();
    flushEventLog();
    observePersistence(
        getCtx().saveMetadata?.(),
        'metadata-flush',
        tr('Failed to save commentary cache', 'dscomments.toast.cachefail'),
    );
}

function onDocumentClick(event) {
    if (isQsMenuOpen() && !event.target.closest('#dscQs, #dscQsBody')) closeQsMenu();
    if (isTypographyOpen() && !event.target.closest('#dscType, #dscTypeBody')) closeTypographyPopover();
}

function bindDocumentRuntime() {
    if (_documentRuntimeBound) return;
    _documentRuntimeBound = true;
    document.addEventListener('visibilitychange', onVisibilityChange);
    document.addEventListener('click', onDocumentClick);
}

function unbindDocumentRuntime() {
    if (!_documentRuntimeBound) return;
    document.removeEventListener('visibilitychange', onVisibilityChange);
    document.removeEventListener('click', onDocumentClick);
    _documentRuntimeBound = false;
}

function unbindLauncherRuntime() {
    _launcherRemount?.cancel?.();
    _launcherRemount = null;
    _launcherReadyDispose?.();
    _launcherReadyDispose = null;
    if (_launcherObserver) { _launcherObserver.disconnect(); _launcherObserver = null; }
    const launcher = document.getElementById('dsc_launcher');
    if (launcher) launcher.remove();
    document.body.classList.remove('dsc-launcher-mounted');
}

// ── Cleanup ──

function cleanup() {
    beginPanelLifecycleTransition();
    recordEvent('log', 'session cleanup');
    // Dismiss any open popover/quick-menu first: unbindDocumentRuntime below
    // removes the outside-click handler, so they'd be orphaned in document.body
    // and the user couldn't dismiss them after teardown.
    if (isQsMenuOpen()) closeQsMenu();
    if (isTypographyOpen()) closeTypographyPopover();
    // Disable/clean mid-generation: abort + epoch invalidation so a request
    // resolving after cleanup can't render/store.
    abortActiveGeneration();
    unbindEvents();
    unbindDocumentRuntime();
    disconnectObservers();
    unbindLauncherRuntime();
    lorebookPickerLifecycle.destroy();
    teardownThemeSync();
    teardownWindowRuntime();
    destroyFeedGestures();   // remove panel-bound touch/wheel listeners before removePanel unbinds the DOM
    removePanel();
    log('Cleanup completed');
}
