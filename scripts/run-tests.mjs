// @ts-check
/**
 * Portable Node test runner for DS Comments.
 *
 * Discovers all `test/*.test.mjs` files, runs them under `node --test`, and
 * injects NODE_TEST=1 so production code can expose test-only exports.
 */

import { spawnSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const testDir = path.join(root, 'test');
const testFiles = readdirSync(testDir)
    .filter(name => name.endsWith('.test.mjs'))
    .sort()
    .map(name => path.join(testDir, name));
const result = spawnSync(process.execPath, ['--test', ...testFiles], {
    cwd: root,
    env: { ...process.env, NODE_TEST: '1' },
    stdio: 'inherit',
});

if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
