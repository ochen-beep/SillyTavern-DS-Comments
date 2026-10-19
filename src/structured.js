// @ts-check
/**
 * DS Comments — structured output (json_schema) mode.
 *
 * Enforces the commentary contract at the transport level instead of relying
 * on the prompt alone: the provider has to return { "comments": [...] } in the
 * contract's shape. This also replaces the assistant-role jailbreak prefill
 * for sources that support it — a refusal cannot be the first token when the
 * response must validate against the schema. The prompt text is unchanged;
 * parser.js's repair ladder stays as the fallback for sources/endpoints that
 * accept but ignore the constraint.
 *
 * Not ported from recast's structured prefill: its newline-token/regex-prefix/
 * envelope machinery exists to fake a TEXT prefill — our constraint is a pure
 * object schema and needs none of it. Ported: the source-support table (which
 * ST backends map json_schema natively vs prompt-hack it) and the truncation
 * caveat (see structuredMaxTokens).
 */

// chat_completion_source values (NOT profile.api keys — resolve via
// ctx.CONNECT_API_MAP[profile.api].source first).
const STRICT_SOURCES = new Set([
    // Server-side these map json_schema to a native structured-outputs
    // mechanism with full JSON Schema support (additionalProperties, anyOf).
    'openai', 'openrouter', 'mistralai', 'xai', 'aimlapi', 'electronhub',
    'chutes', 'azure_openai', 'cohere', 'groq', 'fireworks', 'perplexity',
    'workers_ai',
]);
const LOOSE_SOURCES = new Set([
    // Gemini's native responseSchema subset: no additionalProperties, weak
    // anyOf — send the loose variant without those keywords.
    'makersuite', 'vertexai', 'google',
]);
const UNSUPPORTED_SOURCES = new Set([
    // Server maps json_schema to prompt hacks / forced tooling there — the
    // constraint is not reliably enforced.
    'claude', 'ai21', 'deepseek', 'moonshot', 'zai', 'siliconflow', 'cometapi',
    'textgenerationwebui',
]);

const GEMINI_MODEL_RE = /(?:^|[/:_-])(gemini|gemma)(?:[.:/_-]|$)/i;

/**
 * Which schema variant a source can enforce.
 * @param {string} source chat_completion_source
 * @param {string} [model] model id (detects Gemini behind a custom source)
 * @returns {'strict' | 'loose' | 'unknown' | null} null = do not send a schema
 */
export function schemaVariantForSource(source, model = '') {
    const src = String(source ?? '').trim().toLowerCase();
    if (!src) return 'unknown';
    if (UNSUPPORTED_SOURCES.has(src)) return null;
    if (LOOSE_SOURCES.has(src)) return 'loose';
    if (STRICT_SOURCES.has(src)) return 'strict';
    if (src === 'custom') return GEMINI_MODEL_RE.test(String(model)) ? 'loose' : 'unknown';
    return 'unknown';
}

/**
 * Whether to send the schema for this generation, and which variant.
 * 'always' additionally forces the attempt on 'unknown' sources (custom
 * OpenAI-compatible endpoints); 'auto' only on known-good ones. Unsupported
 * sources never get a schema — the server would turn it into a prompt hack.
 * @returns {'strict' | 'loose' | null}
 */
export function structuredOutputFor(settings, source, model = '') {
    const mode = String(settings?.structuredOutput ?? 'off');
    if (mode === 'off') return null;
    const variant = schemaVariantForSource(source, model);
    if (!variant) return null;
    if (variant === 'unknown') return mode === 'always' ? 'strict' : null;
    return variant;
}

/**
 * The commentary contract as a JSON Schema. Root must be an OBJECT (OpenAI
 * json_schema rejects a bare array root), so the payload is {"comments": [...]}
 * — parser.js unwraps it back.
 *
 * strict: OpenAI-style strict mode — all properties required, optionals as
 *         anyOf-with-null, additionalProperties:false everywhere.
 * loose:  Gemini responseSchema subset — no additionalProperties, no anyOf;
 *         optionals simply not required.
 */
export function buildCommentsSchema(variant = 'strict') {
    const reaction = {
        type: 'object',
        properties: { emoji: { type: 'string' }, count: { type: 'string' } },
        required: ['emoji', 'count'],
    };
    const reply = {
        type: 'object',
        properties: { to: { type: 'string' }, quote: { type: 'string' } },
        required: ['to', 'quote'],
    };
    const meme = {
        type: 'object',
        properties: {
            template: { type: 'string' },
            top: { type: 'string' },
            bottom: { type: 'string' },
        },
        required: ['template', 'top', 'bottom'],
    };
    // Media request fields — always present in the schema (even when the
    // media features are off) so toggling them doesn't change the schema
    // shape; the contract sections decide whether the model fills them.
    if (variant === 'strict') meme.additionalProperties = false;

    let item;
    if (variant === 'strict') {
        reaction.additionalProperties = false;
        reply.additionalProperties = false;
        item = {
            type: 'object',
            properties: {
                username: { type: 'string' },
                content: { type: 'string' },
                reply: { anyOf: [reply, { type: 'null' }] },
                reactions: { anyOf: [{ type: 'array', items: reaction }, { type: 'null' }] },
                gif: { anyOf: [{ type: 'string' }, { type: 'null' }] },
                sticker: { anyOf: [{ type: 'string' }, { type: 'null' }] },
                meme: { anyOf: [meme, { type: 'null' }] },
            },
            required: ['username', 'content', 'reply', 'reactions', 'gif', 'sticker', 'meme'],
            additionalProperties: false,
        };
    } else {
        item = {
            type: 'object',
            properties: {
                username: { type: 'string' },
                content: { type: 'string' },
                reply,
                reactions: { type: 'array', items: reaction },
                gif: { type: 'string' },
                sticker: { type: 'string' },
                meme,
            },
            required: ['username', 'content'],
        };
    }

    const value = {
        type: 'object',
        properties: { comments: { type: 'array', items: item } },
        required: ['comments'],
        ...(variant === 'strict' ? { additionalProperties: false } : {}),
    };

    // Payload key for CM's sendRequest overridePayload (recast's wire shape:
    // the ST server maps this to the provider-native structured-outputs field).
    return {
        json_schema: { name: 'dscomments', strict: variant === 'strict', value },
        // OpenAI wire shape for our own custom-endpoint body.
        response_format: { type: 'json_schema', json_schema: { name: 'dscomments', schema: value, strict: variant === 'strict' } },
    };
}

/**
 * Structured output cannot be repair-parsed when truncated — an envelope cut
 * by the token limit is unrecoverable JSON, unlike the free-form array the
 * parser ladder salvages. Thinking models burn the budget on reasoning first.
 * Only used in structured mode; sized by the requested comment count.
 */
export function structuredMaxTokens(userCount) {
    const count = Number.isFinite(parseInt(userCount)) ? parseInt(userCount) : 5;
    return Math.min(8000, 1000 + count * 200);
}
