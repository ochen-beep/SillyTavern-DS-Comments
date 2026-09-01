// @ts-check
/**
 * DS Comments — Sound notification module
 *
 * Sources of the notification sound (state.settings.soundId):
 *   'default'       — bundled DEFAULT_SOUND_FILENAME shipped in sounds/ (HTTP)
 *   'folder:<file>' — other bundled sounds shipped in sounds/ (HTTP)
 *   'custom_<n>'    — user uploads. The audio file lives SERVER-side in the
 *                     per-user file store (data/<user>/user/files/, see
 *                     user-files.js) under 'dsc_sound_<key>.<ext>'; settings.json
 *                     keeps only metadata { name, file }. Playback uses the
 *                     static /user/files/<name> URL, so custom sounds travel
 *                     with the SillyTavern data directory and work in any
 *                     browser/device on the same user profile.
 *
 * Legacy: blobs used to live in browser localforage (device-bound, lost on
 * browser/device change). migrateCustomSoundsToServer() lifts surviving blobs
 * into the server store once per entry; missingCustomSoundKeys() reports the
 * ones whose file is gone so the UI can say so instead of silently playing
 * the default sound.
 */

import { state, BASE_URL, LF_SOUND, warn, error, tr, NUMERIC_SETTINGS, normalizeFiniteNumber, persistSettingsNow, notifyUser, getCtx, MODULE_NAME } from './core.js';
import { userFileUrl, uploadUserFile, deleteUserFile, verifyUserFiles } from './user-files.js';

export const DEFAULT_SOUND_FILENAME = 'Tiny_minimalist_bubb_#4-1780921666702.wav';

// Bundled sounds shipped in sounds/ folder (keys prefixed 'folder:' resolve from disk).
// This list MUST mirror the sounds/ directory — test/sounds-on-disk.test.mjs enforces it.
export const BUNDLED_SOUNDS = [
    { name: 'Tiny crystalline',     key: 'folder:Tiny_crystalline_gla_#2-1780921518367.wav' },
    { name: 'Tiny minimalist bubb', key: 'folder:Tiny_minimalist_bubb_#4-1780921666702.wav' },
];

// Uploadable audio extensions — mirrors the accept attribute of
// #dsc_sound_file in settings.html (test/settings-html.test.mjs enforces sync).
export const SOUND_EXTENSIONS = ['ogg', 'mp3', 'wav', 'm4a'];

const MIME_TO_EXT = {
    'audio/mpeg': 'mp3',
    'audio/mp3': 'mp3',
    'audio/wav': 'wav',
    'audio/x-wav': 'wav',
    'audio/wave': 'wav',
    'audio/vnd.wave': 'wav',
    'audio/ogg': 'ogg',
    'audio/vorbis': 'ogg',
    'audio/mp4': 'm4a',
    'audio/x-m4a': 'm4a',
    'audio/aac': 'm4a',
};

// Monotonic id for user-uploaded sounds. Seeded in initSoundKeyCounter() from
// the highest existing custom_N key so new uploads never collide with stored ones.
let _nextSoundId = 1;

function _nextSoundKey() {
    return `custom_${_nextSoundId++}`;
}

// Server-side file name for a custom sound key. Charset stays inside ST's
// validateAssetFileName whitelist (user display names are NOT file-name-safe).
function _soundFileName(key, ext) {
    return `dsc_sound_${key}.${ext}`;
}

/**
 * Split a FileReader data-URL into { mime, isBase64, payload }. Returns null
 * for anything that is not a data-URL (unit tests pass raw strings).
 */
function _splitDataUrl(input) {
    const s = String(input ?? '');
    const comma = s.indexOf(',');
    if (comma === -1 || !s.startsWith('data:')) return null;
    const meta = s.slice(5, comma);
    return {
        mime: meta.split(';', 1)[0].trim(),
        isBase64: /;base64/i.test(meta),
        payload: s.slice(comma + 1),
    };
}

/** Resolve the stored-file extension: data-URL mime first, then the original
 * file's extension, then 'wav'. Anything outside SOUND_EXTENSIONS is rejected. */
function _pickExtension(mime, fallbackExt) {
    const byMime = MIME_TO_EXT[String(mime || '').toLowerCase()];
    if (byMime) return byMime;
    const fb = String(fallbackExt || '').toLowerCase().replace(/^\./, '');
    return SOUND_EXTENSIONS.includes(fb) ? fb : 'wav';
}

async function _resolveSoundUri() {
    const key = state.settings.soundId || 'default';
    if (key.startsWith('custom_')) {
        const file = state.settings.soundFiles?.[key]?.file;
        if (file) return userFileUrl(file);
        // No server file (legacy entry pending migration, or lost blob):
        // fall through to the default bundled sound.
    }
    if (key.startsWith('folder:')) {
        return `${BASE_URL}/sounds/${encodeURIComponent(key.slice(7))}`;
    }
    // encodeURIComponent: filenames contain '#' which would become a URL fragment.
    return `${BASE_URL}/sounds/${encodeURIComponent(DEFAULT_SOUND_FILENAME)}`;
}

export async function playNotificationSound() {
    if (!state.settings.soundEnabled) return;
    try {
        const uri = await _resolveSoundUri();
        const vol = normalizeFiniteNumber(state.settings.soundVolume, NUMERIC_SETTINGS.soundVolume) / 100;
        const audio = new Audio(uri);
        audio.volume = vol;
        await audio.play();
    } catch { /* skip */ }
}

/**
 * Store a user-uploaded sound server-side and select it.
 * @param {string} name display name (any charset)
 * @param {string} dataUrl FileReader data-URL of the audio file
 * @param {{ext?: string, persistSettings?: Function, notify?: Function}} opts
 * @returns {Promise<string|null>} the new custom_<n> key, or null on failure
 */
export async function addCustomSound(name, dataUrl, {
    ext = '',
    persistSettings = persistSettingsNow,
    notify = notifyUser,
} = {}) {
    if (!name || !dataUrl) return null;
    const key = _nextSoundKey();
    const parsed = _splitDataUrl(dataUrl);
    const base64 = parsed?.isBase64 ? parsed.payload : String(dataUrl);
    const fileName = _soundFileName(key, _pickExtension(parsed?.mime, ext));
    const previousFiles = { ...(state.settings.soundFiles || {}) };
    const previousId = state.settings.soundId;
    const extSettings = getCtx().extensionSettings?.[MODULE_NAME];
    const previousExtensionSnapshot = extSettings ? { ...extSettings } : null;

    try {
        await uploadUserFile(fileName, base64);
        state.settings.soundFiles = {
            ...previousFiles,
            [key]: { name, file: fileName },
        };
        state.settings.soundId = key;
        await persistSettings('custom-sound-save');
        return key;
    } catch (cause) {
        state.settings.soundFiles = previousFiles;
        state.settings.soundId = previousId;
        if (previousExtensionSnapshot && extSettings) {
            Object.assign(extSettings, previousExtensionSnapshot);
        }
        // The uploaded file is now an orphan (settings rolled back) — best effort removal.
        try { await deleteUserFile(fileName); }
        catch (rollbackCause) { warn('Custom sound rollback failed:', rollbackCause); }
        error('Custom sound persistence failed:', cause);
        notify('error', tr('Could not save the custom sound.', 'dscomments.sound.saveError'), 'custom-sound-save');
        return null;
    }
}

/**
 * One-time migration: lift legacy browser-local (localforage) sound blobs into
 * the server file store. Idempotent — an entry is migrated only while its
 * metadata lacks `file`; per-entry failures are swallowed and retried on the
 * next init. Returns how many entries were migrated.
 */
export async function migrateCustomSoundsToServer({
    persistSettings = persistSettingsNow,
} = {}) {
    const files = state.settings.soundFiles || {};
    const pending = Object.entries(files).filter(([k, m]) =>
        k.startsWith('custom_') && m && typeof m === 'object' && !m.file);
    if (!pending.length) return 0;

    let migrated = 0;
    for (const [key, meta] of pending) {
        try {
            const dataUrl = await SillyTavern.libs.localforage.getItem(`${LF_SOUND}${key}`);
            if (!dataUrl) continue; // blob already lost — missingCustomSoundKeys reports it
            const parsed = _splitDataUrl(dataUrl);
            if (!parsed?.isBase64) continue;
            const fileName = _soundFileName(key, _pickExtension(parsed.mime, ''));
            await uploadUserFile(fileName, parsed.payload);
            files[key] = { ...meta, file: fileName };
            migrated++;
        } catch (cause) {
            warn(`Sound migration skipped for ${key} (will retry next init):`, cause?.message || cause);
        }
    }
    if (!migrated) return 0;

    try {
        await persistSettings('custom-sound-migrate');
    } catch (cause) {
        warn('Sound migration settings flush failed (re-migrated next init):', cause?.message || cause);
        return migrated;
    }
    // Blob now lives server-side; drop the device-local copy. Removal failures
    // are harmless — a surviving blob is simply re-uploaded (idempotent overwrite).
    for (const [, meta] of Object.entries(files)) {
        if (!meta?.file) continue;
        const m = String(meta.file).match(/^dsc_sound_(custom_\d+)\./);
        if (!m) continue;
        try { await SillyTavern.libs.localforage.removeItem(`${LF_SOUND}${m[1]}`); }
        catch { /* skip */ }
    }
    return migrated;
}

/**
 * Keys of custom sounds that will NOT play from the server store: their file
 * is confirmed absent, or (legacy entry) they have no server file and no
 * surviving local blob either. Unknown verification results never count as
 * missing. Used to mark dropdown entries instead of silently playing default.
 */
export async function missingCustomSoundKeys() {
    const files = state.settings.soundFiles || {};
    const names = [...new Set(Object.values(files).map(m => m?.file).filter(Boolean))];
    const verified = await verifyUserFiles(names);
    const missing = new Set();
    for (const [key, meta] of Object.entries(files)) {
        if (!key.startsWith('custom_') || !meta) continue;
        if (meta.file) {
            if (verified[meta.file] === false) missing.add(key);
            continue;
        }
        try {
            if (!(await SillyTavern.libs.localforage.getItem(`${LF_SOUND}${key}`))) missing.add(key);
        } catch { /* unknown — skip */ }
    }
    return missing;
}

export function initSoundKeyCounter() {
    let max = 0;
    for (const k of Object.keys(state.settings.soundFiles || {})) {
        const m = k.match(/^custom_(\d+)$/);
        if (m) max = Math.max(max, parseInt(m[1], 10));
    }
    _nextSoundId = max + 1;
}
