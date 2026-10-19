// @ts-check
/**
 * DS Comments — parser unit tests.
 *
 * Covers the LLM-output parser (parser.js). All internal helpers
 * (stripReasoningBlocks, cleanUsername, tryRepairJson, extractObjectsFromText,
 * truncated-recovery) are exercised through the single public export
 * parseCommentary — exactly how production code sees them.
 *
 * The parser contract is the rigid JSON format from prompt-contract.js; the
 * cross-check «the contract example parses» lives in test/contract.test.mjs.
 */

import '../test-helpers/stub-runtime.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseCommentary } from '../src/parser.js';
import { state, dumpDebugLog, clearDebugLog } from '../src/core.js';

// ── normalization of valid input ──

test('valid JSON array → normalized messages with all fields', () => {
    const raw = JSON.stringify([
        { username: 'coder_42', content: 'hi', reactions: [{ emoji: '😭', count: '12' }] },
        { username: 'ghost_reader', content: 'reply text', reply: { to: 'coder_42', quote: 'short fragment' }, reactions: [{ emoji: '🙏', count: '10' }] },
    ]);
    const out = parseCommentary(raw);
    assert.equal(out.length, 2);
    assert.deepEqual(out[0], { username: 'coder_42', content: 'hi', replyTo: null, replyQuote: null, reactions: [{ emoji: '😭', count: '12' }], gif: '', sticker: '', meme: null });
    assert.equal(out[1].replyTo, 'coder_42');
    assert.equal(out[1].replyQuote, 'short fragment');
    assert.equal(out[1].reactions[0].emoji, '🙏');
});

test('username markdown wrappers are stripped (cleanUsername via parse)', () => {
    const raw = JSON.stringify([{ username: '**neon_dreamer42**', content: 'x' }]);
    const out = parseCommentary(raw);
    assert.equal(out[0].username, 'neon_dreamer42');
});

test('reply without `to` → replyTo stays null', () => {
    const raw = JSON.stringify([{ username: 'a', content: 'x', reply: { quote: 'q' } }]);
    const out = parseCommentary(raw);
    assert.equal(out[0].replyTo, null);
    assert.equal(out[0].replyQuote, null);
});

test('reply with `to` and empty quote → replyTo set, replyQuote ""', () => {
    const raw = JSON.stringify([{ username: 'a', content: 'x', reply: { to: 'b' } }]);
    const out = parseCommentary(raw);
    assert.equal(out[0].replyTo, 'b');
    assert.equal(out[0].replyQuote, '');
});

test('malformed reactions filtered: non-array ignored, missing-emoji dropped, message kept', () => {
    const raw = JSON.stringify([{ username: 'a', content: 'x', reactions: [{ count: '5' }, { emoji: '😀' }] }]);
    const out = parseCommentary(raw);
    assert.equal(out.length, 1);
    assert.deepEqual(out[0].reactions, [{ emoji: '😀', count: '' }]);
});

// ── guard / degenerate inputs → null ──

test('empty / null / whitespace → null', () => {
    assert.equal(parseCommentary(''), null);
    assert.equal(parseCommentary(null), null);
    assert.equal(parseCommentary('   \n\t '), null);
});

test('bare object (not array) → salvaged via object extraction', () => {
    // Was null before the salvage hardening: the direct-parse object
    // short-circuited the escalating attempts. Now an implausible-shape result
    // escalates to object extraction, which recovers the single comment.
    const out = parseCommentary('{"username":"a","content":"x"}');
    assert.equal(out.length, 1);
    assert.equal(out[0].username, 'a');
});

// ── parse-failure logging: console gets metadata only, body goes to the ring ──

test('parse failure logs metadata without retaining the response body', () => {
    const badBody = 'SECRET_SCENE_TEXT definitely not JSON at all {{{';
    const warnCalls = [];
    const originalWarn = console.warn;
    console.warn = (...args) => warnCalls.push(args.map(a => typeof a === 'string' ? a : JSON.stringify(a)).join(' '));
    let dump = '';
    clearDebugLog();
    state.settings.debugMode = true;
    try {
        assert.equal(parseCommentary(badBody), null);
    } finally {
        // dumpDebugLog() gates on debugMode — read the ring BEFORE turning it off.
        dump = dumpDebugLog();
        state.settings.debugMode = false;
        console.warn = originalWarn;
    }
    clearDebugLog();

    assert.equal(warnCalls.filter(c => c.includes('parse attempts failed')).length, 1);
    const warnLine = warnCalls.find(c => c.includes('parse attempts failed'));
    assert.ok(warnLine.includes('"length":' + badBody.length), 'metadata length present');
    assert.ok(!warnLine.includes('SECRET_SCENE_TEXT'), 'console warn carries no scene content');
    assert.ok(!dump.includes('SECRET_SCENE_TEXT'), 'debug dump contains no scene content');
});

test('empty array → null', () => {
    assert.equal(parseCommentary('[]'), null);
});

test('message missing username → dropped → null', () => {
    assert.equal(parseCommentary(JSON.stringify([{ content: 'x' }])), null);
});

test('message missing content → dropped → null', () => {
    assert.equal(parseCommentary(JSON.stringify([{ username: 'a' }])), null);
});

test('oversized response (>100k) → null', () => {
    const huge = JSON.stringify([{ username: 'a', content: 'x'.repeat(100_001) }]);
    assert.ok(huge.length > 100_000);
    assert.equal(parseCommentary(huge), null);
});

// ── stripReasoningBlocks ──

test('reasoning blocks (stripped, valid JSON survives', () => {
    const arr = JSON.stringify([{ username: 'a', content: 'x' }]);
    assert.equal(parseCommentary('thinking>hmm</thinking>\n' + arr).length, 1);
    assert.equal(parseCommentary('<reflection>self crit</reflection>' + arr).length, 1);
});

test('text without reasoning blocks is parsed unchanged', () => {
    const arr = JSON.stringify([{ username: 'a', content: 'x' }]);
    assert.deepEqual(parseCommentary(arr), parseCommentary(arr));
    assert.equal(parseCommentary(arr).length, 1);
});

// ── code-block / BOM stripping ──

test('markdown json code-block wrapper stripped', () => {
    const arr = JSON.stringify([{ username: 'a', content: 'x' }]);
    const wrapped = '```json\n' + arr + '\n```';
    assert.equal(parseCommentary(wrapped).length, 1);
});

test('BOM + leading whitespace stripped', () => {
    const arr = JSON.stringify([{ username: 'a', content: 'x' }]);
    assert.equal(parseCommentary('\uFEFF  \n' + arr).length, 1);
});

// ── tryRepairJson (through parseCommentary, attempt 2) ──

test('repair: missing comma between array objects → 2 messages', () => {
    // }{ without a comma — the most common LLM mistake
    const raw = '[{"username":"a","content":"x"}{"username":"b","content":"y"}]';
    assert.equal(parseCommentary(raw).length, 2);
});

test('repair: missing comma between object properties → 1 message', () => {
    const raw = '[{"username":"a" "content":"x"}]';
    const out = parseCommentary(raw);
    assert.equal(out.length, 1);
    assert.equal(out[0].username, 'a');
    assert.equal(out[0].content, 'x');
});

test('repair: trailing comma before } → 1 message', () => {
    const raw = '[{"username":"a","content":"x",}]';
    assert.equal(parseCommentary(raw).length, 1);
});

test('repair: bare newline inside string becomes escaped', () => {
    // literal newline inside a JSON string — invalid JSON,
    // tryRepairJson escapes it. Parses fine, content keeps the newline.
    const raw = '[{"username":"a","content":"line1\nline2"}]';
    const out = parseCommentary(raw);
    assert.equal(out.length, 1);
    assert.ok(out[0].content.includes('\n'), 'newline preserved in content');
});

// ── extractObjectsFromText (attempt 3) ──

test('broken array structure (missing ]) but complete objects → recovered', () => {
    // the closing ] of the array is missing — JSON.parse fails, but
    // extractObjects pulls each {...} individually.
    const raw = '[{"username":"a","content":"x"}, {"username":"b","content":"y"}';
    const out = parseCommentary(raw);
    assert.equal(out.length, 2);
    assert.equal(out[0].username, 'a');
    assert.equal(out[1].username, 'b');
});

test('truncated: one complete + one incomplete object → partial recovery', () => {
    // realistic truncated response: the first object is intact, the second is
    // cut off. extractObjects saves the intact one, the truncated one is
    // dropped.
    const raw = '[{"username":"a","content":"x"},{"username":"b","content":"partial';
    const out = parseCommentary(raw);
    assert.equal(out.length, 1);
    assert.equal(out[0].username, 'a');
});

test('garbage unparseable text → null (all attempts exhausted)', () => {
    assert.equal(parseCommentary('this is not json at all'), null);
    assert.equal(parseCommentary('<<< not even close >>>'), null);
});

// ── content_filter / truncation hardening ──

test('truncated tail mid-string (content_filter cut) → complete comments survive', () => {
    // The provider cut the stream inside the last object's reactions block.
    const raw = JSON.stringify([
        { username: 'a', content: 'x', reactions: [{ emoji: '🔥', count: '1' }] },
        { username: 'b', content: 'y' },
        { username: 'c', content: 'z', reactions: [{ emoji: '🔥', count: '7' }] },
    ], null, 2).slice(0, -30);
    const out = parseCommentary(raw);
    assert.deepEqual(out.map(m => m.username), ['a', 'b']);
});

test('truncated structured wrapper {"comments":[...]} → recovered in right order', () => {
    // Regression: the old recovery appended '}' before ']', producing invalid
    // JSON for the json_schema envelope.
    const raw = JSON.stringify({ comments: [
        { username: 'a', content: 'x' },
        { username: 'b', content: 'y' },
        { username: 'c', content: 'z' },
    ] }, null, 2).slice(0, -25);
    const out = parseCommentary(raw);
    assert.deepEqual(out.map(m => m.username), ['a', 'b']);
});

test('head-cut prefill continuation: object missing only its opening { is salvaged', () => {
    // A prefill continuation can start mid-object — the '{' was in the prefill
    // and is never echoed in the response text.
    const raw = '"username": "seth",\n"content": "продолжение",\n"reply": {"to": "a", "quote": "q"}\n},\n{\n"username": "tail", "content": "обрезан по';
    const out = parseCommentary(raw);
    assert.deepEqual(out.map(m => m.username), ['seth']);
    assert.equal(out[0].replyTo, 'a');
});

test('repair-result shape validation: nested reply object alone does not short-circuit', () => {
    // Extraction may find only a nested "reply" object (no username/content) —
    // that must not count as success and block the truncated-recovery attempt.
    const raw = '"username": "seth", "content": "x", "reply": {"to": "a", "quote": "q"} }';
    const out = parseCommentary(raw);
    assert.equal(out.length, 1);
    assert.equal(out[0].username, 'seth');
});

test('non-comments envelope {"status":...,"data":[...]} → array dug out one level down', () => {
    const raw = JSON.stringify({ status: 'ok', data: [{ username: 'a', content: 'x' }] });
    const out = parseCommentary(raw);
    assert.equal(out.length, 1);
    assert.equal(out[0].username, 'a');
});

test('verbatim user-reported cut (head mid-string + tail mid-string) → 7 of 9 recovered', () => {
    const raw = `раму буквально предложил за нее гелендваген",
      "reply": {
        "to": "dead_inside_enjoyer",
        "quote": "ДВА КОЛОДЦА И ДЕСЯТОК БЫКОВ"
      }
    },
    {
      "username": "red_flag_collector",
      "content": "«Когда я сдохну, Баст»\\nОСУЖДАЮ 😡",
      "reactions": [ { "emoji": "🐈", "count": "93" }, { "emoji": "😡", "count": "41" } ]
    },
    {
      "username": "shiba_sticker_bot",
      "content": "[стикер с плачущим котом в шапке фараона]"
    },
    {
      "username": "seth_apologist",
      "content": "вы не понимаете это другое!!",
      "reply": { "to": "red_flag_collector", "quote": "Мгновенный отмен" }
    },
    {
      "username": "fashion_police_ru",
      "content": "что у софии за туфли",
      "reactions": [ { "emoji": "👠", "count": "19" } ]
    },
    {
      "username": "lore_diggger",
      "content": "кстати про то как она исекайнулась",
      "reactions": [ { "emoji": "👀", "count": "52" } ]
    },
    {
      "username": "cringe_inspector",
      "content": "словил дикий испанский стыд",
      "reactions": [ { "emoji": "💀", "count": "78" }, { "emoji": "🤡", "count": "15" } ]
    },
    {
      "username": "milf_hunter_69",
      "content": "да ладно тебе",
      "reply": { "to": "cringe_inspector", "quote": "словил дикий испанский стыд" }
    },
    {
      "username": "yandere_enjoyer",
      "content": "зато как нефр триггернулся",
      "reactions": [
        {
          "emoji": "🔥",
          "count": "`;
    const out = parseCommentary(raw);
    assert.deepEqual(out.map(m => m.username), [
        'red_flag_collector', 'shiba_sticker_bot', 'seth_apologist',
        'fashion_police_ru', 'lore_diggger', 'cringe_inspector', 'milf_hunter_69',
    ]);
    assert.equal(out[0].reactions.length, 2, 'nested reactions survive extraction');
    assert.equal(out[2].replyTo, 'red_flag_collector', 'nested reply survives extraction');
});