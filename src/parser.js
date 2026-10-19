// @ts-check
/**
 * DS Comments — Parser module
 * JSON-only parser with repair. The prompt explicitly requires JSON array output.
 */

import { warn, trace } from './core.js';

/**
 * Strip reasoning blocks from LLM output.
 * Handles <think>, <thinking>, <reflection> and similar tags.
 */
function stripReasoningBlocks(text) {
    if (!text) return text;
    text = text.replace(/<think>[\s\S]*?<\/think>/gi, '');
    text = text.replace(/<\/?think>/gi, '');
    text = text.replace(/<thinking>[\s\S]*?<\/thinking>/gi, '');
    text = text.replace(/<reflection>[\s\S]*?<\/reflection>/gi, '');
    return text.replace(/^\s+/, '');
}

/**
 * Strip markdown formatting from usernames.
 * Examples: **neon_dreamer42** → neon_dreamer42
 */
function cleanUsername(raw) {
    if (!raw) return raw;
    let name = raw.trim();
    name = name.replace(/^\*\*(.+)\*\*$/, '$1');
    name = name.replace(/^\*(.+)\*$/,     '$1');
    name = name.replace(/^__(.+)__$/,     '$1');
    name = name.replace(/^_(.+)_$/,       '$1');
    name = name.replace(/^`(.+)`$/,       '$1');
    name = name.replace(/^~~(.+)~~$/,     '$1');
    name = name.replace(/^[*`~_]+|[*`~_]+$/g, '');
    return name.trim();
}

/**
 * Lightweight JSON repair — fix common LLM formatting errors (missing commas,
 * trailing commas, unescaped quotes, bare newlines, stray control chars).
 * Safe: byte-identical on valid JSON input.
 */
function tryRepairJson(text) {
    const out = [];
    let inStr = false;
    let esc = false;

    for (let i = 0; i < text.length; i++) {
        const ch = text[i];

        // ── Handle escape sequences inside strings ──
        if (esc) { out.push(ch); esc = false; continue; }
        if (ch === '\\' && inStr) { out.push(ch); esc = true; continue; }

        if (inStr) {
            if (ch === '\n') { out.push('\\n'); continue; }
            if (ch === '\r') { continue; }
            if (ch === '\t') { out.push('\\t'); continue; }
            // Escape any other raw control char (0x00-0x1f) inside strings.
            // JSON forbids them bare; an LLM can emit e.g. a form feed / vertical
            // tab, which would fail every parse attempt. \b/\f use the standard
            // short escapes, the rest use \uXXXX.
            if (ch < ' ') {
                if (ch === '\b') out.push('\\b');
                else if (ch === '\f') out.push('\\f');
                else out.push('\\u' + ch.charCodeAt(0).toString(16).padStart(4, '0'));
                continue;
            }

            if (ch === '"') {
                // Look ahead past whitespace to decide if this " closes the string
                let j = i + 1;
                while (j < text.length && ' \t\r\n'.includes(text[j])) j++;
                const next = text[j];

                // Structural character → definitely closes the string
                if (next === ',' || next === '}' || next === ']' || next === ':') {
                    inStr = false;
                    out.push(ch);
                    continue;
                }

                // Another " follows → missing comma before next key/value
                if (next === '"') {
                    inStr = false;
                    out.push(ch);
                    out.push(',');
                    continue;
                }

                // End of text or unexpected char → close string (best effort)
                inStr = false;
                out.push(ch);
                continue;
            }

            out.push(ch);
            continue;
        }

        // ── Outside string ──
        if (ch === '"') { inStr = true; out.push(ch); continue; }

        // After } or ], insert missing comma before next value/key
        if (ch === '}' || ch === ']') {
            let j = i + 1;
            while (j < text.length && ' \t\r\n'.includes(text[j])) j++;
            const next = text[j];
            if (next === '"' || next === '{' || next === '[') {
                out.push(ch);
                out.push(',');
                continue;
            }
        }

        out.push(ch);
    }

    let result = out.join('');

    // Strip trailing commas before } or ] (common LLM mistake)
    result = result.replace(/,(\s*[}\]])/g, '$1');

    return result;
}

/**
 * Find matching closing brace/bracket for the one at `start`.
 * Tracks string context and escape sequences.
 * @param {string} text
 * @param {number} start index of opening { or [
 * @returns {number} index of matching close, or -1
 */
function findMatchingBrace(text, start) {
    const open = text[start];
    const close = open === '{' ? '}' : ']';
    let depth = 0;
    let inStr = false;
    let esc = false;

    for (let j = start; j < text.length; j++) {
        const ch = text[j];
        if (esc) { esc = false; continue; }
        if (ch === '\\' && inStr) { esc = true; continue; }
        if (ch === '"') { inStr = !inStr; continue; }
        if (inStr) continue;
        if (ch === open) depth++;
        if (ch === close) {
            depth--;
            if (depth === 0) return j;
        }
    }
    return -1;
}

/**
 * Extract individual {…} objects from text, ignoring overall JSON structure.
 * Handles: premature ] / }, missing commas between top-level objects, mixed junk.
 * Each object is parsed independently — structural corruption elsewhere is irrelevant.
 *
 * @param {string} text pre-processed text (BOM stripped, code fences removed)
 * @returns {Array<object>|null}
 */
function extractObjectsFromText(text) {
    const objects = [];

    // Head-cut salvage: a prefill continuation can start mid-object, with the
    // opening '{' never echoed. If a "username" key precedes the first '{',
    // re-root from there and try to parse that object on its own.
    const firstBrace = text.indexOf('{');
    const firstUsername = text.indexOf('"username"');
    if (firstUsername !== -1 && (firstBrace === -1 || firstUsername < firstBrace)) {
        const candidate = '{' + text.slice(firstUsername);
        const end = findMatchingBrace(candidate, 0);
        if (end !== -1) {
            const objText = candidate.slice(0, end + 1);
            let obj = null;
            try {
                obj = JSON.parse(objText);
            } catch {
                try {
                    obj = JSON.parse(tryRepairJson(objText));
                } catch { /* skip */ }
            }
            if (obj && typeof obj === 'object' && !Array.isArray(obj)) {
                objects.push(obj);
            }
        }
    }

    let i = 0;

    while (i < text.length) {
        const start = text.indexOf('{', i);
        if (start === -1) break;

        const end = findMatchingBrace(text, start);
        if (end === -1) { i = start + 1; continue; }

        const objText = text.slice(start, end + 1);

        let obj = null;
        try {
            obj = JSON.parse(objText);
        } catch {
            try {
                obj = JSON.parse(tryRepairJson(objText));
            } catch { /* skip */ }
        }

        if (obj && typeof obj === 'object' && !Array.isArray(obj)) {
            objects.push(obj);
        }

        i = end + 1;
    }

    return objects.length > 0 ? objects : null;
}

/**
 * Clean a model-provided media search query ("gif"/"sticker" fields):
 * collapse whitespace, cap the length. Returns '' for anything unusable.
 */
function cleanMediaQuery(raw) {
    let s = String(raw ?? '').replace(/\s+/g, ' ').trim();
    if (s.length > 120) s = s.slice(0, 120).trim();
    return s;
}

/**
 * Normalize a model-provided meme recipe {"template", "top", "bottom"}.
 * Returns null unless the template hint is a non-empty string.
 */
function parseMemeRecipe(raw) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
    const cap = (v) => {
        let s = String(v ?? '').replace(/\s+/g, ' ').trim();
        if (s.length > 100) s = s.slice(0, 100).trim();
        return s;
    };
    const template = cap(raw.template);
    if (!template) return null;
    return { template, top: cap(raw.top), bottom: cap(raw.bottom) };
}

/**
 * Parse LLM output as JSON array of commentary messages.
 * Handles: markdown code blocks, extra text, invalid JSON, missing fields,
 * premature array closes, structural corruption.
 *
 * Expected schema: [{ username, content, reactions?, reply?, gif?, sticker?, meme? }]
 *
 * Parse strategy (escalating):
 *   1. Direct JSON.parse — valid JSON
 *   2. tryRepairJson + parse — missing commas, trailing commas, bare newlines
 *   3. Object extraction — scans for {…} individually, ignores array structure
 *   4. Truncated recovery — cut-off responses
 *
 * @param {string} rawText
 * @returns {Array<{username: string, content: string, replyTo: string|null, replyQuote: string|null, reactions: Array<{emoji: string, count: string}>, gif: string, sticker: string, meme: object|null}>|null}
 */
export function parseCommentary(rawText) {
    if (!rawText) return null;

    let text = stripReasoningBlocks(rawText);

    if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1);

    text = text.replace(/^```\w*\s*\n?/gm, '');
    text = text.replace(/```\s*$/gm, '');
    text = text.trim();

    // Guard: skip oversized responses
    if (text.length > 100_000) {
        warn('parseCommentary: response too large, skipping JSON parse');
        return null;
    }

    // Structured-output mode wraps the array in an object root (json_schema
    // forbids a bare-array root): { "comments": [...] }. Unwrap it here so the
    // rest of the pipeline never cares which mode produced the text.
    // Validation matters: a lower attempt may yield VALID JSON of the WRONG
    // shape (repair can turn a mid-string cut into an array of strings, or
    // extraction may return only a nested "reply" object). Accepting that
    // short-circuits the stronger attempts below, so implausible results
    // escalate instead of returning null.
    const asCommentsArray = (p) => {
        // Unwrap envelopes: { "comments": [...] } from structured mode, or any
        // other single wrapper object holding the array one level down.
        if (p && !Array.isArray(p) && typeof p === 'object') {
            for (const v of Object.values(p)) {
                if (Array.isArray(v) && v.some(it => it && typeof it === 'object' && (it.username || it.content))) {
                    p = v;
                    break;
                }
            }
        }
        if (!Array.isArray(p)) return null;
        return p.some(it => it && typeof it === 'object' && (it.username || it.content)) ? p : null;
    };

    let parsed = null;

    // ── Attempt 1: direct parse ──
    try {
        parsed = asCommentsArray(JSON.parse(text));
    } catch { /* fall through */ }

    // ── Attempt 2: repair + parse ──
    if (!parsed) {
        try {
            parsed = asCommentsArray(JSON.parse(tryRepairJson(text)));
            if (parsed) trace('JSON repaired and parsed successfully');
        } catch { /* fall through */ }
    }

    // ── Attempt 3: object extraction (ignores array structure) ──
    if (!parsed) {
        try {
            parsed = asCommentsArray(extractObjectsFromText(text));
            if (parsed) trace('Extracted', parsed.length, 'objects from broken JSON');
        } catch { /* fall through */ }
    }

    // ── Attempt 4: truncated recovery ──
    if (!parsed) {
        try {
            const lastObjEnd = text.lastIndexOf('}');
            if (lastObjEnd > 0) {
                const truncated = text.slice(0, lastObjEnd + 1);
                // Close openers in reverse nesting order, tracking string
                // context so braces inside comment text don't skew the count
                // (and so a structured {"comments":[...]} wrapper gets "]}"
                // in the right order, not "}]").
                const stack = [];
                let inStr = false, esc = false;
                for (const ch of truncated) {
                    if (esc) { esc = false; continue; }
                    if (ch === '\\' && inStr) { esc = true; continue; }
                    if (ch === '"') { inStr = !inStr; continue; }
                    if (inStr) continue;
                    if (ch === '{' || ch === '[') stack.push(ch);
                    else if (ch === '}' && stack[stack.length - 1] === '{') stack.pop();
                    else if (ch === ']' && stack[stack.length - 1] === '[') stack.pop();
                }
                // A negative depth (closer without opener) means the head is
                // cut mid-object — attempt 3's job, not this one's.
                if (stack.length > 0 && stack.includes('[')) {
                    let repaired = truncated;
                    for (let i = stack.length - 1; i >= 0; i--) {
                        repaired += stack[i] === '{' ? '}' : ']';
                    }
                    try {
                        parsed = asCommentsArray(JSON.parse(repaired));
                    } catch { /* fall through */ }
                    if (!parsed) {
                        try {
                            parsed = asCommentsArray(JSON.parse(tryRepairJson(repaired)));
                        } catch { /* fall through */ }
                    }
                    if (parsed) trace('Truncated JSON recovered —', parsed.length, 'messages');
                }
            }
        } catch { /* fall through */ }
    }

    if (!parsed) {
        // Console and debug export get metadata only; the response body may
        // contain private scene text and must not be retained for diagnostics.
        warn('parseCommentary: all parse attempts failed', { length: text.length });
        trace('parseCommentary: raw text omitted', { length: text.length });
        return null;
    }

    const messages = [];
    for (const item of parsed) {
        if (!item || typeof item !== 'object') continue;

        const username = cleanUsername(String(item.username || ''));
        if (!username) continue;

        const content = String(item.content || '').trim();

        // Media requests: at most one survives, in the priority order the
        // contract teaches (gif > sticker > meme). A media-only comment (no
        // text) is legitimate — the image IS the message.
        const gif = cleanMediaQuery(item.gif);
        const sticker = cleanMediaQuery(item.sticker);
        let meme = parseMemeRecipe(item.meme);
        if (gif) meme = null;   // one media field per message: gif > sticker > meme
        const hasGif = !!gif;
        const hasSticker = !hasGif && !!sticker;
        const hasMeme = !hasGif && !hasSticker && !!meme;
        if (!content && !hasGif && !hasSticker && !hasMeme) continue;

        let reactions = [];
        if (Array.isArray(item.reactions)) {
            reactions = item.reactions
                .filter(r => r && typeof r === 'object')
                .map(r => ({
                    emoji: String(r.emoji || ''),
                    count: String(r.count || ''),
                }))
                .filter(r => r.emoji);
        }

        let replyTo = null, replyQuote = null;
        if (item.reply && typeof item.reply === 'object') {
            const target = cleanUsername(String(item.reply.to || ''));
            if (target) {
                replyTo = target;
                replyQuote = String(item.reply.quote || '').trim();
            }
        }

        messages.push({
            username, content, replyTo, replyQuote, reactions,
            gif: hasGif ? gif : '',
            sticker: hasSticker ? sticker : '',
            meme: hasMeme ? meme : null,
        });
    }

    return messages.length > 0 ? messages : null;
}
