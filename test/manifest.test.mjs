// @ts-check
/**
 * DS Comments — manifest contract test.
 *
 * Verifies the manifest key naming agreed in the architecture plan:
 * camelCase `homePage`, not snake_case `home_page`.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const manifestUrl = new URL('../manifest.json', import.meta.url);

test('manifest uses the documented homePage field', async () => {
    const manifest = JSON.parse(await readFile(manifestUrl, 'utf8'));
    assert.ok(Object.hasOwn(manifest, 'homePage'));
    assert.equal(Object.hasOwn(manifest, 'home_page'), false);
});

test('manifest requires client version 1.18.0', async () => {
    const manifest = JSON.parse(await readFile(manifestUrl, 'utf8'));
    assert.equal(manifest.minimum_client_version, '1.18.0');
});

test('manifest declares the Russian locale for SillyTavern (English is the base language)', async () => {
    const manifest = JSON.parse(await readFile(manifestUrl, 'utf8'));

    assert.deepEqual(manifest.i18n, {
        ru: 'src/i18n/ru-ru.json',
        'ru-ru': 'src/i18n/ru-ru.json',
    });
});

test('manifest locale resources exist and contain a flat translation map', async () => {
    const manifest = JSON.parse(await readFile(manifestUrl, 'utf8'));

    for (const path of new Set(Object.values(manifest.i18n))) {
        const localeUrl = new URL(`../${path}`, import.meta.url);
        const locale = JSON.parse(await readFile(localeUrl, 'utf8'));
        assert.ok(locale && typeof locale === 'object' && !Array.isArray(locale));
        assert.equal(typeof locale['dscomments.settings.enable'], 'string');
        assert.ok(Object.values(locale).every(value => typeof value === 'string'));
    }
});
