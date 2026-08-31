// @ts-check
import '../test-helpers/stub-runtime.mjs';
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import ruRuLocale from '../src/i18n/ru-ru.json' with { type: 'json' };
import { tr } from '../src/core.js';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const html = readFileSync(path.join(root, 'settings.html'), 'utf8');

beforeEach(() => {
    globalThis._stCtx = {
        chat: [],
        chatMetadata: {},
        extensionSettings: {},
        saveSettingsDebounced: () => {},
        substituteParams: text => text,
    };
});

test('tr delegates its fallback text and DS Comments key to SillyTavern translate', () => {
    const calls = [];
    globalThis._stCtx.translate = (...args) => {
        calls.push(args);
        return 'Включить DS Comments';
    };

    assert.equal(tr('Enable DS Comments', 'dscomments.settings.enable'), 'Включить DS Comments');
    assert.deepEqual(calls, [['Enable DS Comments', 'dscomments.settings.enable']]);
});

test('Russian locale includes the disabled-state hint used by the empty feed', () => {
    assert.equal(ruRuLocale['dscomments.empty.disabledHint'], 'Включи галочку в настройках расширения.');
});

test('every settings data-i18n key has a Russian translation', () => {
    const raw = [...html.matchAll(/data-i18n="([^"]+)"/g)].map(match => match[1]);
    assert.ok(raw.length > 0, 'settings.html must contain data-i18n attributes');
    // ST i18n supports combined directives: "key1;[attr]key2" — each part
    // targets the element text or an attribute, so [attr] prefixes are
    // stripped before resolving the key against the locale.
    const expanding = new Set();
    for (const directive of new Set(raw)) {
        for (const part of directive.split(';')) {
            const key = part.replace(/^\[[^\]]+\]/, '').trim();
            if (key) expanding.add(key);
        }
    }
    const missing = [...expanding].filter(key => typeof ruRuLocale[key] !== 'string' || !ruRuLocale[key]);
    assert.deepEqual(missing, []);
});

test('every dscomments key referenced from JS has a Russian translation', () => {
    const files = [path.join(root, 'index.js')];
    const walk = (dir) => {
        for (const name of readdirSync(dir)) {
            const full = path.join(dir, name);
            if (statSync(full).isDirectory()) walk(full);
            else if (name.endsWith('.js')) files.push(full);
        }
    };
    walk(path.join(root, 'src'));
    const used = new Set();
    for (const file of files) {
        for (const m of readFileSync(file, 'utf8').matchAll(/'(dscomments\.[a-zA-Z.]+)'/g)) used.add(m[1]);
    }
    assert.ok(used.size > 100, `expected a substantial key set, got ${used.size}`);
    const missing = [...used].filter(key => typeof ruRuLocale[key] !== 'string' || !ruRuLocale[key]);
    assert.deepEqual(missing, [], 'every key referenced from JS must exist in ru-ru.json');
});
