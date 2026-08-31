// @ts-check
/**
 * DS Comments — cross-module contract test.
 *
 * The most valuable regression test: ties together three modules that only
 * reference each other by text — prompt-contract → parser → renderer.
 *
 *   prompt-contract.js  defines the rigid JSON format (prompt header)
 *   parser.js           parses model output into that format
 *   renderer.js         renders the parsed output as HTML
 *
 * If someone edits the contract example (field order / schema / breaks JSON),
 * or changes the format documentation so the model returns a different layout,
 * parse/contract fails HERE first, before users see an empty feed. Individual
 * module tests do not catch this class of drift.
 *
 * Also: buildPrompt(PROMPT_CONTRACT, {count}) substitutes {{count}} across the
 * whole contract BEFORE ST macros. Without {{count}} in the contract,
 * «exactly N messages» breaks, so it is part of the same contract.
 */

import '../test-helpers/stub-runtime.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PROMPT_CONTRACT } from '../src/prompt-contract.js';
import { parseCommentary } from '../src/parser.js';
import { renderMessages } from '../src/renderer.js';
import { buildPrompt } from '../src/core.js';
import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// ── Entrypoint syntax/contract guard ──

test('index.js parses and defines restoreFeedForCurrentContext', () => {
    const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
    const entrypoint = path.join(root, 'index.js');
    execFileSync(process.execPath, ['--check', entrypoint], { cwd: root, stdio: 'pipe' });
});

test('panel lifecycle guard invalidates older transitions and requires an open visible panel', async () => {
    const { createPanelLifecycleGuard } = await import('../index.js');
    const guard = createPanelLifecycleGuard();
    const first = guard.begin();
    const second = guard.begin();

    assert.equal(guard.isCurrent(first, { enabled: true, collapsed: false, visible: true }), false);
    assert.equal(guard.isCurrent(second, { enabled: true, collapsed: false, visible: true }), true);
    assert.equal(guard.isCurrent(second, { enabled: false, collapsed: false, visible: true }), false);
    assert.equal(guard.isCurrent(second, { enabled: true, collapsed: true, visible: true }), false);
    assert.equal(guard.isCurrent(second, { enabled: true, collapsed: false, visible: false }), false);
});

// ── {{count}} substitution ──

test('buildPrompt substitutes {{count}} across the whole contract', () => {
    const prompt = buildPrompt('vibe', { count: 7, contract: PROMPT_CONTRACT });
    assert.ok(!prompt.includes('{{count}}'), 'no literal {{count}} should remain');
    assert.ok(prompt.includes('exactly 7 chat messages'), 'count injected into instruction');
});

// ── vibe templates must not duplicate the contract ──
// The contract lives in code (prompt-contract.js) and is glued in
// buildPrompt(); if someone copies it into chat-styles/*.md, the model gets
// the header twice.

test('chat-styles templates must not duplicate the prompt contract', () => {
    const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
    const stylesDir = path.join(root, 'chat-styles');
    const files = readdirSync(stylesDir).filter(name => name.endsWith('.md'));
    assert.ok(files.length > 0, 'expected at least one chat-styles template');
    for (const name of files) {
        const text = readFileSync(path.join(stylesDir, name), 'utf8');
        assert.ok(!text.includes('#Chat Commentary'), `${name} duplicates the contract header`);
        assert.ok(!text.includes('## OUTPUT FORMAT'), `${name} duplicates the contract format block`);
    }
});

// ── the contract example parses into 3 messages of the expected structure ──

test('contract example parses to 3 messages with expected usernames (parser ↔ contract drift guard)', () => {
    const msgs = parseCommentary(PROMPT_CONTRACT);
    assert.ok(msgs, 'parser must extract messages from the contract example (else contract/parser drifted)');
    assert.equal(msgs.length, 3);
    assert.deepEqual(msgs.map(m => m.username), ['coder_42', 'ghost_reader', 'ALLCAPS_CHAOS']);
});

test('contract example: first message has 2 reactions with expected emojis', () => {
    const msgs = parseCommentary(PROMPT_CONTRACT);
    assert.equal(msgs[0].reactions.length, 2);
    assert.deepEqual(msgs[0].reactions.map(r => r.emoji), ['😭', '🐈']);
    assert.deepEqual(msgs[0].reactions.map(r => r.count), ['12', '25']);
});

test('contract example: second message replies to coder_42 with a quote', () => {
    const msgs = parseCommentary(PROMPT_CONTRACT);
    assert.equal(msgs[1].replyTo, 'coder_42');
    assert.equal(msgs[1].replyQuote, 'short 4-8 word fragment');
});

test('contract example: third message content preserves Cyrillic', () => {
    const msgs = parseCommentary(PROMPT_CONTRACT);
    assert.ok(msgs[2].content.includes('АХАХАХА'), 'Cyrillic content must survive normalize');
    assert.deepEqual(msgs[2].reactions.map(r => r.emoji), ['🤣', '💀']);
});

// ── the contract example renders losslessly ──

test('contract example renders to HTML containing all 3 usernames + a reply bar (renderer ↔ parser ↔ contract)', () => {
    const msgs = parseCommentary(PROMPT_CONTRACT);
    const html = renderMessages(msgs);
    assert.ok(html.includes('data-username="coder_42"'), 'coder_42 rendered');
    assert.ok(html.includes('data-username="ghost_reader"'), 'ghost_reader rendered');
    assert.ok(html.includes('data-username="ALLCAPS_CHAOS"'), 'ALLCAPS_CHAOS rendered');
    assert.ok(html.includes('class="dsc_reply_bar"'), 'reply bar present for ghost_reader');
    // 3 messages → 3× dsc_message
    assert.equal((html.match(/class="dsc_message"/g) || []).length, 3);
    // reactions present
    assert.ok(html.includes('😭') && html.includes('🤣'), 'reaction emojis preserved through render');
});