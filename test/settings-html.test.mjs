// @ts-check

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import ruRuLocale from '../src/i18n/ru-ru.json' with { type: 'json' };
import manifest from '../manifest.json' with { type: 'json' };

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const html = readFileSync(path.join(root, 'settings.html'), 'utf8');

test('settings.html contains the static lore context skeleton', () => {
    for (const id of [
        'dsc_lore_enable',
        'dsc_lore_group',
        'dsc_lore_mode',
        'dsc_lore_mode_auto',
        'dsc_lore_mode_manual',
        'dsc_lore_scope_group',
        'dsc_lore_scope_attached',
        'dsc_lore_scope_hint',
        'dsc_lore_manual_group',
        'dsc_lore_book',
        'dsc_lore_entries',
    ]) {
        assert.ok(html.includes(`id="${id}"`), `missing #${id}`);
    }
    assert.ok(html.includes('World information'));
    assert.ok(html.includes('>Automatic<'));
    assert.ok(html.includes('>Manual<'));
    assert.ok(html.includes('Only lorebooks attached to this chat'));
});

test('settings.html removes local token budget controls and caps context depth at 50', () => {
    assert.doesNotMatch(html, /id="dsc_custom_maxctx"/);
    assert.doesNotMatch(html, /id="dsc_custom_maxtok"/);
    assert.doesNotMatch(html, /dscomments\.settings\.maxContext|dscomments\.settings\.maxTokens/);
    assert.match(html, /id="dsc_depth"[^>]*max="50"/);
});

test('every settings data-i18n key is present in the Russian locale', () => {
    const raw = [...html.matchAll(/data-i18n="([^"]+)"/g)].map(match => match[1]);
    assert.ok(raw.length > 0, 'settings.html must contain data-i18n attributes');
    // ST i18n supports combined directives: "key1;[attr]key2". Each part is a
    // target (text or [attribute]); strip the [attr] prefix and resolve against
    // the locale so combined/[placeholder]/[title] keys are also covered.
    const expanding = new Set();
    for (const directive of new Set(raw)) {
        for (const part of directive.split(';')) {
            const key = part.replace(/^\[[^\]]+\]/, '').trim();
            if (key) expanding.add(key);
        }
    }
    const missing = [...expanding].filter(key => !(key in ruRuLocale));
    assert.deepEqual(missing, []);
});

test('settings.html keeps English base text for translated static controls', () => {
    assert.match(html, /data-i18n="dscomments\.settings\.enable"[^>]*>Enable DS Comments/);
    assert.match(html, /data-i18n="dscomments\.settings\.behavior"[^>]*>.*Behavior and generation/);
});

test('plain text localization directives do not wrap Font Awesome icons', () => {
    assert.doesNotMatch(html, /data-i18n="(?!\[)[^"]+"[^>]*>\s*<i\b/);
});

test('settings.html no longer mounts the old self-rendering picker host', () => {
    assert.ok(!html.includes('dsc_lorebook_context'));
});

test('settings.html footer version matches manifest.json', () => {
    // The footer is a static literal; this guards the drift between it and
    // manifest.json so the installed version is always readable in the UI.
    assert.ok(html.includes(`DS Comments v${manifest.version}`), `footer must show v${manifest.version}`);
});
