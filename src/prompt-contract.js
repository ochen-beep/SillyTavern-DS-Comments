// @ts-check
/**
 * DS Comments — Prompt contract (read-only, non-editable).
 *
 * Static prompt header: #Chat Commentary + OUTPUT FORMAT + ## FORMAT RULES.
 * Rigid JSON contract that the parser (parser.js) relies on. Breaking it would
 * break parsing, so the contract lives in code, not in the editable vibe.
 *
 * Editable part (vibe) — in chat-styles/*.md (builtin) or localforage
 * (user templates). contract + '\n\n' + vibe glue happens in buildPrompt()
 * (core.js) BEFORE macro substitution.
 */

export const PROMPT_CONTRACT = `#Chat Commentary

Generate exactly {{count}} chat messages reacting to the current scene. Use the EXACT format below.

## OUTPUT FORMAT — respond with ONLY a JSON array. No markdown, no code blocks, no extra text.

Example (note: reply's "content" is a real message, and its "quote" is copied from the target's message):
[
  {"username": "coder_42", "content": "I can't believe the author just did that", "reactions": [{"emoji": "😭", "count": "12"}, {"emoji": "🐈", "count": "25"}]},
  {"username": "ghost_reader", "content": "SAME. I had to put my phone down and stare at the wall for a minute", "reply": {"to": "coder_42", "quote": "the author just did that"}, "reactions": [{"emoji": "🙏", "count": "10"}]},
  {"username": "ALLCAPS_CHAOS", "content": "АХАХАХА ОН ЖЕ ПРОСТО КОТ А НЕ ИМПЕРАТОР", "reactions": [{"emoji": "🤣", "count": "45"}, {"emoji": "💀", "count": "20"}]}
]

## FORMAT RULES

- Respond with ONLY the JSON array — nothing else before or after
- Each object: "username" (required), "content" (required)
- "content": message text. Can be multi-line with \\n. Can contain markdown, roleplay actions, ANY text
- "reactions": optional array of {emoji, count} objects — only for messages that genuinely hit
- "reply": optional object {to, quote} — quote is 4-8 words copied from the target's message; the reply's "content" is the commenter's own real reaction — NEVER a placeholder like "reply text here"
- Nickname: max 32 chars, NO colons inside nickname
- Max 1–4 reactions per message — only messages that genuinely hit
- Counts: realistic numbers like "3", "17", "2.4K" — NOT every message needs reactions

## SCENE FOCUS: THE ONGOING UPDATE VIBE

**Context:** The commenters have just finished reading the \`[Current chapter]\`. This is the fresh, highly anticipated update. \`[Previously]\` is established canon — readers remember it, make callbacks, and connect dots, but their raw, immediate emotional reactions are entirely focused on the current chapter's events.`;