// @ts-check
/**
 * DS Comments — UI: Settings panel sync
 * DOM ↔ state bridge for the ST settings panel (settings.html), plus font
 * application and prompt-template management (localforage, edit-on-place).
 */

import { state, getCtx, BASE_URL, saveSettings, escapeHtml, getApiKey, setApiKey, DSC_FONTS, LF_PROMPTS, log, warn, NUMERIC_SETTINGS, normalizeFiniteNumber, tr } from '../core.js';
import { getProfiles, getProfileDetails } from '../connection.js';

// ── Settings field map: settings.html id → state prop + input type ──
const FIELD_MAP = {
    dsc_enabled:        { prop: 'enabled',                     type: 'checkbox' },
    dsc_autoupdate:     { prop: 'autoUpdate',                  type: 'checkbox' },
    dsc_nosave:         { prop: 'noSaveMode',                  type: 'checkbox' },
    dsc_source:         { prop: 'apiSource',                   type: 'segmented' }, // 2 buttons: Profile / Custom
    dsc_profile:        { prop: 'profileId',                   type: 'select' },
    dsc_endpoint:       { prop: 'customEndpoint',              type: 'text' },
    dsc_model:          { prop: 'customModel',                 type: 'text' },
    dsc_apikey:         { prop: '__apikey',                    type: 'password' }, // localforage-backed
    dsc_count:          { prop: 'userCount',                   type: 'number' },
    dsc_depth:          { prop: 'contextDepth',                type: 'number' },
    dsc_hist:           { prop: 'includeChatHistory',          type: 'checkbox' },
    dsc_persona:        { prop: 'includePersona',              type: 'checkbox' },
    dsc_chardesc:       { prop: 'includeCharacterDescription', type: 'checkbox' },
    dsc_fontfam:        { prop: 'fontFamily',                  type: 'select' },
    dsc_fontsize:       { prop: 'fontSize',                    type: 'number' },
    dsc_template:       { prop: 'promptTemplate',              type: 'select' },
    dsc_jb_enable:      { prop: 'enableJailbreakBlock',        type: 'checkbox' },
    dsc_jb_role:        { prop: 'jailbreakRole',               type: 'select' },
    dsc_jb_text:        { prop: 'jailbreakText',               type: 'textarea' },
    dsc_sound_enable:   { prop: 'soundEnabled',                type: 'checkbox' },
    dsc_sound_volume:   { prop: 'soundVolume',                 type: 'range' },
    dsc_sound_select:   { prop: 'soundId',                     type: 'select' },
    dsc_debug_mode:     { prop: 'debugMode',                   type: 'checkbox' },
};

/**
 * Owns one settings lorebook picker without coupling its lifecycle to global settings.
 * @param {{
 *   createPicker: Function,
 *   getContext: Function,
 *   readConfig: Function,
 *   persistConfig: Function,
 *   invalidate: Function,
 *   getState: Function,
 * }} deps
 */
export function createSettingsLorebookLifecycle({
    createPicker,
    getContext,
    readConfig,
    persistConfig,
    invalidate,
    getState,
}) {
    let picker = null;

    async function refresh() {
        if (!picker) return;
        const ctx = getContext();
        picker.setConfig(readConfig(ctx));
        await picker.refresh();
    }

    return {
        async mount(root) {
            if (picker || !root) return;
            picker = createPicker({
                root,
                getCtx: getContext,
                onChange(config) {
                    const ctx = getContext();
                    invalidate();
                    const runtimeState = getState();
                    const controller = runtimeState.abortController;
                    controller?.abort();
                    if (runtimeState.abortController === controller) {
                        runtimeState.abortController = null;
                    }
                    runtimeState.generationOwner = null;
                    runtimeState.generationInProgress = false;
                    runtimeState.generationTarget = null;
                    runtimeState.generationObservedTarget = null;
                    persistConfig(config, ctx);
                },
            });
            await refresh();
        },
        refresh,
        destroy() {
            picker?.destroy();
            picker = null;
        },
    };
}

/** Push state → DOM values in the ST settings panel. */
export function syncDomFromState() {
    for (const [id, cfg] of Object.entries(FIELD_MAP)) {
        const el = document.getElementById(id);
        if (!el) continue;
        if (cfg.type === 'checkbox') {
            el.checked = !!state.settings[cfg.prop];
        } else {
            el.value = state.settings[cfg.prop] ?? '';
        }
    }
    // Segmented source picker
    syncSegmentedSource();
    // API key from localforage
    syncApiKeyField();
    // Volume label
    const volLbl = document.getElementById('dsc_sound_volume_val');
    if (volLbl) volLbl.textContent = `${state.settings.soundVolume ?? 30}%`;
}

/** Update dependent visibility after a settings load. */
export function syncPanelVisibility() {
    updateSourceFieldsVisibility();
    updateDepthVisibility();
    updateJailbreakVisibility();
    // Sound body: on load unhide it when sound is enabled, otherwise the slider/
    // list/test button stay invisible even though the checkbox is checked.
    updateSoundVisibility();
    syncPromptEditor();
}

// ── Font application (exported — used by index.js and quickmenu.js) ──

export function applyFontSize(size) {
    const bar = document.getElementById('dscWindow');
    if (bar) bar.style.setProperty('--dsc-font-size', `${size}px`);
}

export function applyFontFamily(key) {
    const font = DSC_FONTS[key] || DSC_FONTS.system;
    const bar = document.getElementById('dscWindow');
    if (bar) bar.style.setProperty('--dsc-font-family', font.value);
}

// ── Numeric input normalization ──

/**
 * Read a numeric input, clamp/truncate it to the policy for its setting,
 * write the normalized value back to both state and the element, and apply
 * any immediate side effects (font size, volume label).
 * Returns the normalized integer or null if the field is not a known numeric
 * setting.
 */
export function syncNumericInput(el) {
    const cfg = FIELD_MAP[el.id];
    if (!cfg || (cfg.type !== 'number' && cfg.type !== 'range')) return null;
    const rule = NUMERIC_SETTINGS[cfg.prop];
    if (!rule) return null;
    const v = normalizeFiniteNumber(el.value, rule);
    state.settings[cfg.prop] = v;
    el.value = String(v);
    if (cfg.prop === 'fontSize') applyFontSize(v);
    if (cfg.prop === 'soundVolume') {
        const lbl = document.getElementById('dsc_sound_volume_val');
        if (lbl) lbl.textContent = `${v}%`;
    }
    return v;
}

// ── Source picker (segmented) ──

function syncSegmentedSource() {
    const src = state.settings.apiSource || 'profile';
    document.querySelectorAll('[data-dsc-src]').forEach(b => {
        const active = b.dataset.dscSrc === src;
        b.classList.toggle('dsc_seg_active', active);
        b.setAttribute('aria-pressed', String(active));
    });
}

export function updateSourceFieldsVisibility() {
    const profile = document.getElementById('dsc_profile_group');
    const custom = document.getElementById('dsc_custom_group');
    const isProfile = state.settings.apiSource === 'profile';
    const isCustom = state.settings.apiSource === 'custom';
    if (profile) profile.hidden = !isProfile;
    if (custom) custom.hidden = !isCustom;
    if (isProfile) {
        populateProfiles().catch(() => { /* skip */ });
    }
}

function updateDepthVisibility() {
    const el = document.getElementById('dsc_depth_group');
    if (el) el.hidden = !state.settings.includeChatHistory;
}

function updateJailbreakVisibility() {
    const el = document.getElementById('dsc_jb_body');
    if (el) el.hidden = !state.settings.enableJailbreakBlock;
}

function updateSoundVisibility() {
    const enabled = !!state.settings.soundEnabled;
    const body = document.getElementById('dsc_sound_body');
    if (body) body.hidden = !enabled;
    const volume = document.getElementById('dsc_sound_volume');
    if (volume) volume.disabled = !enabled;
}

// ── API key (localforage-backed password field) ──

async function syncApiKeyField() {
    const el = document.getElementById('dsc_apikey');
    if (!el) return;
    try { el.value = await getApiKey() || ''; } catch { /* skip */ }
}

// ── Connection profiles ──

// Monotonic-request guard: rapid profile refreshes fire several calls; the
// first async getProfileDetails can resolve AFTER the second and overwrite the
// select with stale labels. Snapshot request order and skip stale writes
// (same pattern as _promptEditorReq below).
let _profilesReq = 0;

export async function populateProfiles() {
    const req = ++_profilesReq;
    const select = document.getElementById('dsc_profile');
    if (!select) return;
    try {
        const profiles = await getProfiles();
        if (req !== _profilesReq) return;   // superseded by a newer refresh
        // Details come from the same local Connection Manager list as the names, so
        // enrich every option at once: «Name · API · Model».
        // Order is preserved: collect labels first, then build <option>.
        const enriched = await Promise.all(profiles.map(async (p) => {
            const value = p.id || p.name;
            let label = p.name;
            try {
                const d = await getProfileDetails(value);
                if (d) {
                    const parts = [];
                    const api = d.api || '';
                    if (api) parts.push(String(api).toUpperCase());
                    const model = d.model || d.modelName || d.model_name || d.settings?.model || '';
                    if (model) parts.push(String(model));
                    if (parts.length) label = `${p.name} · ${parts.join(' · ')}`;
                }
            } catch { /* profile without data — keep only the name */ }
            if (req !== _profilesReq) return null;   // stale — discard
            return { value, label };
        }));
        if (req !== _profilesReq) return;   // a newer refresh owns the select
        const current = enriched.filter(Boolean);
        select.innerHTML = `<option value="">${tr('Select a connection profile', 'dscomments.profile.select')}</option>`;
        for (const { value, label } of current) {
            const opt = document.createElement('option');
            opt.value = value;
            opt.textContent = label;
            if (value === state.settings.profileId) {
                opt.selected = true;
                // Full text in the tooltip — a native select may truncate long labels.
                select.title = label;
            }
            select.appendChild(opt);
        }
    } catch {
        if (req !== _profilesReq) return;   // stale — let the newer call render the error
        select.innerHTML = `<option value="">${tr('Could not load profiles', 'dscomments.profile.error')}</option>`;
    }
}

let _promptEditorReq = 0;

// ── Prompt templates (edit-on-place via localforage) ──

// Built-in templates: served from /chat-styles/*.md, cannot be deleted or reset.
const BUILTIN_TEMPLATES = {
    main: 'main',
};
const isBuiltinTemplate = (name) => Object.prototype.hasOwnProperty.call(BUILTIN_TEMPLATES, name);
const _builtinCache = {};

export async function loadPromptContent(name) {
    if (!name) return '';
    // User copy in localforage (edit-on-place), if present.
    try {
        const all = await SillyTavern.libs.localforage.getItem(LF_PROMPTS) || {};
        // hasOwn, not truthiness: an empty saved template must show as empty,
        // not silently render the builtin text in the editor.
        if (Object.hasOwn(all, name)) return all[name];
    } catch { /* skip */ }
    // Builtin .md
    if (_builtinCache[name]) return _builtinCache[name];
    try {
        const resp = await fetch(`${BASE_URL}/chat-styles/${name}.md`);
        if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
        const text = await resp.text();
        _builtinCache[name] = text;
        return text;
    } catch (e) { warn(`loadPromptContent(${name}):`, e); return ''; }
}

export async function savePromptContent(name, content) {
    const all = await SillyTavern.libs.localforage.getItem(LF_PROMPTS) || {};
    all[name] = content;
    await SillyTavern.libs.localforage.setItem(LF_PROMPTS, all);
}

export async function savePromptAs(newName, content) {
    if (!newName) return false;
    // 'main' (and any future builtin) is reserved. A user template saved
    // under this name would permanently shadow the builtin: loadPromptContent
    // reads localforage first, and deletePrompt refuses to remove builtins, so
    // the override could never be cleared. Reject up front.
    if (isBuiltinTemplate(newName)) return false;
    await savePromptContent(newName, content);
    state.settings.promptTemplate = newName;
    saveSettings();
    return true;
}

export async function deletePrompt(name) {
    if (isBuiltinTemplate(name)) return false; // built-in cannot be deleted (button disabled)
    const all = await SillyTavern.libs.localforage.getItem(LF_PROMPTS) || {};
    delete all[name];
    await SillyTavern.libs.localforage.setItem(LF_PROMPTS, all);
    if (state.settings.promptTemplate === name) {
        state.settings.promptTemplate = 'main';
        saveSettings();
    }
    return true;
}

/**
 * Roll a user template back to the original builtin `main` vibe
 * (overwrites the localforage entry with the content of chat-styles/main.md).
 * For built-ins — no-op (Reset button is disabled, this won't be reached).
 */
export async function resetPromptToBuiltin() {
    const name = state.settings.promptTemplate;
    if (isBuiltinTemplate(name)) return;
    const builtinVibe = await loadPromptContent('main');
    if (!builtinVibe) return;
    await savePromptContent(name, builtinVibe);
}

async function listTemplateNames() {
    const all = await SillyTavern.libs.localforage.getItem(LF_PROMPTS) || {};
    return Object.keys(all).sort((a, b) => a.localeCompare(b, 'ru'));
}

/** Populate the template dropdown, load the current template into the textarea,
 *  and set button states. */
export async function syncPromptEditor() {
    // Monotonic-request guard: rapid template switches fire several calls; the
    // first async loadPromptContent can resolve AFTER the second and overwrite the
    // textarea with stale content. Snapshot request order and skip stale writes.
    const req = ++_promptEditorReq;

    const select = document.getElementById('dsc_template');
    const textarea = document.getElementById('dsc_template_text');
    const delBtn = document.getElementById('dsc_template_del');
    const resetBtn = document.getElementById('dsc_template_reset');
    const cur = state.settings.promptTemplate || 'main';
    const isBuiltin = isBuiltinTemplate(cur);

    if (select) {
        select.innerHTML = '';
        // Builtin
        for (const id of Object.keys(BUILTIN_TEMPLATES)) {
            const o = document.createElement('option');
            o.value = id; o.textContent = `${id} 🔒`;
            select.appendChild(o);
        }
        // User
        for (const name of await listTemplateNames()) {
            if (isBuiltinTemplate(name)) continue;   // built-in already listed
            const o = document.createElement('option');
            o.value = name; o.textContent = name;
            select.appendChild(o);
        }
        if (req !== _promptEditorReq) return;          // stale — a newer switch won
        select.value = cur;
        if (!select.value && select.options.length) {
            select.value = select.options[0].value;
            state.settings.promptTemplate = select.value;
            saveSettings();   // persist the fallback so state and disk stay in sync
        }
    }
    const content = await loadPromptContent(cur);
    if (req !== _promptEditorReq) return;              // stale — don't overwrite the textarea
    if (textarea) textarea.value = content || '';

    // Buttons: Reset/Del always visible, but disabled for built-ins (layout stable).
    if (delBtn)   { delBtn.hidden = false;   delBtn.disabled = isBuiltin; }
    if (resetBtn) { resetBtn.hidden = false; resetBtn.disabled = isBuiltin; }
}

export { FIELD_MAP };
