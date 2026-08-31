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
  index of opening { or [
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
  pre-processed text (BOM stripped, code fences removed)
 * @returns {Array<object>|null}
 */
function extractObjectsFromText(text) {
    const objects = [];
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
 * Parse LLM output as JSON array of commentary messages.
 * Handles: markdown code blocks, extra text, invalid JSON, missing fields,
 * premature array closes, structural corruption.
 *
 * Expected schema: [{ username, content, reactions?, reply? }]
 *
 * Parse strategy (escalating):
 *   1. Direct JSON.parse — valid JSON
 *   2. tryRepairJson + parse — missing commas, trailing commas, bare newlines
 *   3. Object extraction — scans for {…} individually, ignores array structure
 *   4. Truncated recovery — cut-off responses
 *
 * @param {string} rawText
 * @returns {Array<{username: string, content: string, replyTo: string|null, replyQuote: string|null, reactions: Array<{emoji: string, count: string}>}>|null}
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

    let parsed;

    // ── Attempt 1: direct parse ──
    try {
        parsed = JSON.parse(text);
    } catch {
        // ── Attempt 2: repair + parse ──
        try {
            parsed = JSON.parse(tryRepairJson(text));
            trace('JSON repaired and parsed successfully');
        } catch {
            // ── Attempt 3: object extraction (ignores array structure) ──
            try {
                parsed = extractObjectsFromText(text);
                if (parsed) trace('Extracted', parsed.length, 'objects from broken JSON');
            } catch { /* fall through */ }

            // ── Attempt 4: truncated recovery ──
            if (!parsed) {
                try {
                    const lastObjEnd = text.lastIndexOf('}');
                    if (lastObjEnd > 0) {
                        const truncated = text.slice(0, lastObjEnd + 1);
                        let openBraces = 0, openBrackets = 0;
                        for (const ch of truncated) {
                            if (ch === '{') openBraces++;
                            if (ch === '}') openBraces--;
                            if (ch === '[') openBrackets++;
                            if (ch === ']') openBrackets--;
                        }
                        if (openBrackets >= 1 && openBraces <= 1) {
                            let repaired = truncated;
                            if (openBraces > 0) repaired += '}';
                            repaired += ']';
                            try {
                                parsed = JSON.parse(repaired);
                            } catch {
                                parsed = JSON.parse(tryRepairJson(repaired));
                            }
                            trace('Truncated JSON recovered —', Array.isArray(parsed) ? parsed.length : 0, 'messages');
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
        }
    }

    if (!Array.isArray(parsed)) return null;

    const messages = [];
    for (const item of parsed) {
        if (!item || typeof item !== 'object') continue;

        const username = cleanUsername(String(item.username || ''));
        if (!username) continue;

        const content = String(item.content || '').trim();
        if (!content) continue;

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

        messages.push({ username, content, replyTo, replyQuote, reactions });
    }

    return messages.length > 0 ? messages : null;
}
