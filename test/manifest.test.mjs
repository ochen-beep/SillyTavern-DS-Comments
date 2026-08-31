// @ts-check
/**
 * DS Comments — manifest contract tests.
 *
 * Verifies the manifest key naming agreed in the architecture plan
 * (camelCase `homePage`, not snake_case `home_page`), locale declarations,
 * the settings-template path contract (P1-1: derived from BASE_URL, never a
 * hardcoded folder name) and the settings-footer version sync (P3).
 */

import '../test-helpers/stub-runtime.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const manifestUrl = new URL('../manifest.json', import.meta.url);
const manifest = JSON.parse(await readFile(manifestUrl, 'utf8'));

test('manifest uses the documented homePage field', () => {
    assert.ok(Object.hasOwn(manifest, 'homePage'));
    assert.equal(Object.hasOwn(manifest, 'home_page'), false);
});

test('manifest requires client version 1.18.0', () => {
    assert.equal(manifest.minimum_client_version, '1.18.0');
});

test('manifest declares the Russian locale for SillyTavern (English is the base language)', () => {
    // Only `ru-ru`: ST compares manifest i18n keys against the current locale
    // string strictly, and no `ru` locale exists in ST (locales/ru-ru.json only).
    assert.deepEqual(manifest.i18n, {
        'ru-ru': 'src/i18n/ru-ru.json',
    });
});

test('manifest locale resources exist and contain a flat translation map', async () => {
    for (const path of new Set(Object.values(manifest.i18n))) {
        const localeUrl = new URL(`../${path}`, import.meta.url);
        const locale = JSON.parse(await readFile(localeUrl, 'utf8'));
        assert.ok(locale && typeof locale === 'object' && !Array.isArray(locale));
        assert.equal(typeof locale['dscomments.settings.enable'], 'string');
        assert.ok(Object.values(locale).every(value => typeof value === 'string'));
    }
});

test('FOLDER_NAME is derived from BASE_URL and is a single path segment', async () => {
    const { BASE_URL, FOLDER_NAME } = await import('../src/core.js');
    assert.equal(typeof FOLDER_NAME, 'string');
    assert.ok(FOLDER_NAME.length > 0, 'FOLDER_NAME must not be empty');
    assert.ok(!/[\\/]/.test(FOLDER_NAME), 'FOLDER_NAME must be a single path segment');
    assert.ok(BASE_URL.endsWith(`/${FOLDER_NAME}`), 'FOLDER_NAME must be the last segment of BASE_URL');
});

test('settings template path is not hardcoded to a folder name (P1-1 regression)', async () => {
    const indexSrc = await readFile(new URL('../index.js', import.meta.url), 'utf8');
    assert.doesNotMatch(
        indexSrc,
        /renderExtensionTemplateAsync\(\s*(['"`])third-party\/[^$]/,
        'the template path must be built from FOLDER_NAME (`third-party/${FOLDER_NAME}`), not a literal folder name',
    );
    assert.match(indexSrc, /renderExtensionTemplateAsync\(`third-party\/\$\{FOLDER_NAME\}`/);
});

test('settings.html footer version matches the manifest version', async () => {
    const settingsHtml = await readFile(new URL('../settings.html', import.meta.url), 'utf8');
    const match = settingsHtml.match(/DS Comments v([0-9][0-9a-zA-Z.\-]*)</);
    assert.ok(match, 'settings.html must render a "DS Comments v<version>" footer');
    assert.equal(match[1], manifest.version, 'footer version must track manifest.json (update both together)');
});
