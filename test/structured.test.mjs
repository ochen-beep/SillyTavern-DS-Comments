// @ts-check
/**
 * DS Comments — structured output (json_schema) tests.
 *
 * Covers src/structured.js (source table, mode gate, schema shapes, token
 * budget) and the parser's {comments} unwrap.
 */
import '../test-helpers/stub-runtime.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {
    schemaVariantForSource, structuredOutputFor, buildCommentsSchema, structuredMaxTokens,
} from '../src/structured.js';
import { parseCommentary } from '../src/parser.js';
import { _testExtractTextFromResponse } from '../src/connection.js';

test('extractTextFromResponse: ST auto-parsed json_schema object content is re-stringified', () => {
    // CM extractData path returns { content: <parsed object>, reasoning } for
    // structured replies — a regression test for the live failure on Gemini.
    const text = _testExtractTextFromResponse({
        content: { comments: [{ username: 'n', content: 'c', reply: null, reactions: null }] },
        reasoning: '',
    });
    const out = parseCommentary(text);
    assert.equal(out.length, 1);
    assert.equal(out[0].username, 'n');
    // choices[] with object content too
    const text2 = _testExtractTextFromResponse({ choices: [{ message: { content: { comments: [{ username: 'x', content: 'y' }] } } }] });
    assert.equal(parseCommentary(text2)[0].username, 'x');
    // string content untouched
    assert.equal(_testExtractTextFromResponse({ content: 'plain' }), 'plain');
});

test('schemaVariantForSource: supported / envelope / unsupported / unknown', () => {
    assert.equal(schemaVariantForSource('openai'), 'strict');
    assert.equal(schemaVariantForSource('openrouter'), 'strict');
    assert.equal(schemaVariantForSource('makersuite'), 'loose');
    assert.equal(schemaVariantForSource('vertexai'), 'loose');
    assert.equal(schemaVariantForSource('custom', 'gemini-3.1-pro-preview'), 'loose');
    assert.equal(schemaVariantForSource('custom', 'my-local-model'), 'unknown');
    assert.equal(schemaVariantForSource('claude'), null);
    assert.equal(schemaVariantForSource('deepseek'), null);
    assert.equal(schemaVariantForSource('zai'), null);
    assert.equal(schemaVariantForSource('textgenerationwebui'), null);
    assert.equal(schemaVariantForSource(''), 'unknown');
});

test('structuredOutputFor: mode gate over the variant table', () => {
    // off never sends
    assert.equal(structuredOutputFor({ structuredOutput: 'off' }, 'openai'), null);
    // default (absent setting) = off
    assert.equal(structuredOutputFor({}, 'openai'), null);
    // auto: known variants only
    assert.equal(structuredOutputFor({ structuredOutput: 'auto' }, 'openai'), 'strict');
    assert.equal(structuredOutputFor({ structuredOutput: 'auto' }, 'makersuite'), 'loose');
    assert.equal(structuredOutputFor({ structuredOutput: 'auto' }, 'custom', 'some-model'), null);
    // always: unknown gets the strict attempt; unsupported never
    assert.equal(structuredOutputFor({ structuredOutput: 'always' }, 'custom', 'some-model'), 'strict');
    assert.equal(structuredOutputFor({ structuredOutput: 'always' }, 'claude'), null);
});

test('buildCommentsSchema: strict variant is OpenAI-strict-shaped', () => {
    const { json_schema, response_format } = buildCommentsSchema('strict');
    const value = json_schema.value;
    assert.equal(json_schema.strict, true);
    assert.equal(value.type, 'object');
    assert.equal(value.additionalProperties, false);
    assert.deepEqual(value.required, ['comments']);
    const item = value.properties.comments.items;
    assert.deepEqual(item.required, ['username', 'content', 'reply', 'reactions', 'gif', 'sticker', 'meme'], 'strict mode: all props required');
    assert.equal(item.additionalProperties, false);
    // CM payload key and OpenAI wire key carry the same schema
    assert.deepEqual(response_format.json_schema.schema, value);
});

test('buildCommentsSchema: loose variant fits the Gemini responseSchema subset', () => {
    const { json_schema } = buildCommentsSchema('loose');
    const value = json_schema.value;
    assert.equal(json_schema.strict, false);
    assert.equal('additionalProperties' in value, false, 'Gemini rejects additionalProperties');
    const item = value.properties.comments.items;
    assert.deepEqual(item.required, ['username', 'content'], 'loose mode: optionals not required');
    assert.ok(!JSON.stringify(item).includes('anyOf'), 'no anyOf unions in loose mode');
});

test('structuredMaxTokens: scales with count, capped', () => {
    assert.equal(structuredMaxTokens(5), 2000);
    assert.equal(structuredMaxTokens(1), 1200);
    assert.equal(structuredMaxTokens(50), 8000);
    assert.equal(structuredMaxTokens('junk'), 2000, 'bad input falls back to count=5');
});

test('parseCommentary: unwraps the structured {comments:[...]} envelope', () => {
    const wrapped = JSON.stringify({
        comments: [
            { username: 'n1', content: 'c1', reactions: [{ emoji: '🔥', count: '3' }], reply: null },
            { username: 'n2', content: 'c2', reply: { to: 'n1', quote: 'c1' } },
        ],
    });
    const out = parseCommentary(wrapped);
    assert.equal(out.length, 2);
    assert.equal(out[0].username, 'n1');
    assert.equal(out[0].reactions[0].emoji, '🔥');
    assert.equal(out[1].replyTo, 'n1');
    // nullable optionals from strict mode normalize away
    assert.equal(out[0].replyTo, null);
});

test('parseCommentary: bare array still parses (envelope support is additive)', () => {
    const out = parseCommentary(JSON.stringify([{ username: 'n', content: 'c' }]));
    assert.equal(out.length, 1);
    assert.equal(out[0].username, 'n');
});

// ── media fields in the schema ──

test('strict schema includes gif/sticker/meme with null optionals and additionalProperties:false', () => {
    const { json_schema } = buildCommentsSchema('strict');
    const item = json_schema.value.properties.comments.items;
    assert.deepEqual(item.properties.gif, { anyOf: [{ type: 'string' }, { type: 'null' }] });
    assert.deepEqual(item.properties.sticker, { anyOf: [{ type: 'string' }, { type: 'null' }] });
    assert.equal(item.properties.meme.anyOf[0].type, 'object');
    assert.deepEqual(item.properties.meme.anyOf[0].required, ['template', 'top', 'bottom']);
    assert.deepEqual(item.properties.meme.anyOf[0].properties.template, { type: 'string' });
    assert.equal(item.properties.meme.anyOf[0].additionalProperties, false);
    for (const k of ['gif', 'sticker', 'meme']) assert.ok(item.required.includes(k));
    assert.deepEqual(item.required, ['username', 'content', 'reply', 'reactions', 'gif', 'sticker', 'meme']);
});

test('loose schema includes gif/sticker/meme as non-required optionals', () => {
    const { json_schema } = buildCommentsSchema('loose');
    const item = json_schema.value.properties.comments.items;
    assert.deepEqual(item.properties.gif, { type: 'string' });
    assert.deepEqual(item.properties.sticker, { type: 'string' });
    assert.equal(item.properties.meme.type, 'object');
    assert.deepEqual(item.required, ['username', 'content']);
});
