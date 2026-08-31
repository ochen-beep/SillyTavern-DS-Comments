// @ts-check
/**
 * DS Comments — static guard: no setInterval polling for #send_form (spec F2 / AC3).
 *
 * Asserts index.js and window.js source contain no setInterval() calls. The
 * previous setInterval(500)+8s-deadline polling was replaced by the
 * APP_READY-driven whenSendFormReady helper. This guard prevents a regression
 * that reintroduces polling for core UI that is guaranteed present by APP_READY.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';

const root = path.resolve(fileURLToPath(import.meta.url), '..', '..');

const FILES = [
    path.join(root, 'index.js'),
    path.join(root, 'src', 'ui', 'window.js'),
];

test('index.js and window.js contain no setInterval() calls', () => {
    for (const file of FILES) {
        const src = readFileSync(file, 'utf8');
        assert.ok(
            !/setInterval\s*\(/.test(src),
            `${path.relative(root, file)} still contains setInterval() - #send_form attachment must use whenSendFormReady (APP_READY), not polling`,
        );
    }
});
