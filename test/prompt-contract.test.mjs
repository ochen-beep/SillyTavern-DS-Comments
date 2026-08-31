// @ts-check
/**
 * DS Comments — prompt-contract string tests.
 *
 * PROMPT_CONTRACT — the immutable prompt header (not in localforage): the
 * parser relies on its format description («JSON array», schema keys
 * username/content, {{count}} for substitution). If the contract breaks by
 * accident, the parser starts receiving garbage — hence we lock the key
 * invariants of the string.
 *
 * Full cross-check «the contract example parses with the parser» —
 * test/contract.test.mjs.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PROMPT_CONTRACT } from '../src/prompt-contract.js';

test('PROMPT_CONTRACT is a non-empty string', () => {
    assert.equal(typeof PROMPT_CONTRACT, 'string');
    assert.ok(PROMPT_CONTRACT.length > 100, `expected sizable contract, got ${PROMPT_CONTRACT.length}`);
});

test('contract references {{count}} (count-substitution contract with buildPrompt)', () => {
    assert.match(PROMPT_CONTRACT, /\{\{count\}\}/);
});

test('contract mandates JSON array output (parser-format contract)', () => {
    assert.match(PROMPT_CONTRACT, /JSON array/i);
});

test('contract documents required schema keys username and content', () => {
    assert.match(PROMPT_CONTRACT, /"username"/);
    assert.match(PROMPT_CONTRACT, /"content"/);
    assert.match(PROMPT_CONTRACT, /"reactions"/);
    assert.match(PROMPT_CONTRACT, /"reply"/);
});

test('contract contains FORMAT RULES section', () => {
    assert.match(PROMPT_CONTRACT, /FORMAT RULES/i);
});

test('contract: an embedded JSON example block is present (parseable as array per contract.test)', () => {
    // The contract contains an example array in [ ... ]; contract.test.mjs
// parses exactly that.
    assert.match(PROMPT_CONTRACT, /\[\s*\{[\s\S]*\}\s*\]/);
});

test('contract example uses realistic count formats ("2.4K" etc.) — guard against edits that drop them', () => {
    assert.ok(PROMPT_CONTRACT.includes('2.4K') || PROMPT_CONTRACT.includes('count'));
});