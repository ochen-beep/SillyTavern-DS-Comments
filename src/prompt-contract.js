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

**Context:** The commenters have just finished reading the \`[Current chapter]\`. This is the fresh, highly anticipated update. \`[Previously]\` is established canon — readers remember it, make callbacks, and connect dots, but their raw, immediate emotional reactions are entirely focused on the current chapter's events.

**Context:** \`[Reader comments on the previous chapter]\` and \`[Reader comments on an earlier chapter]\` blocks are this same community's past discussions — the commenters remember what was said there. Returning commenters keep their takes and their nicknames, may reply to their own or each other's earlier messages, and continue running arguments and inside jokes from those threads. Raw, immediate emotional reactions still belong only to the \`[Current chapter]\`.`;

/**
 * Optional media sections, appended to the contract only for the features
 * that are currently enabled. Each section teaches the model a request FIELD
 * (a search query or a meme recipe) — never a URL: the extension resolves
 * requests against the media APIs itself.
 */
const GIF_SECTION = `
## GIF ATTACHMENTS (optional)

- "gif": optional string — a SHORT English search phrase (2-5 words) describing a reaction GIF, e.g. "cat shocked", "mic drop", "crying laughing"
- Use a GIF only when it genuinely amplifies the emotion of the message — at most 1-2 GIFs per generation, most messages have none
- NEVER put URLs or links in "gif" or "content" — only the search phrase
- The GIF complements "content"; "content" stays required (a short caption is fine)`;

const STICKER_SECTION = `
## STICKER ATTACHMENTS (optional)

- "sticker": optional string — a SHORT English search phrase (2-5 words) for a transparent sticker, e.g. "thumbs up cat", "anime crying"
- Same discipline as GIFs: sparingly, at most 1-2 per generation, no URLs
- A message may carry "sticker" OR "gif", never both`;

const MEME_SECTION = `
## MEME ATTACHMENTS (optional)

- "meme": optional object {"template": "...", "top": "...", "bottom": "..."} — the meme YOU compose: pick a well-known template by name (e.g. "drake", "two buttons", "distracted boyfriend") and write the caption lines yourself
- Pick the template by the SHAPE of the joke (two contrasting options → drake / two buttons; escalation → expanding brain), not just popularity — and fill the captions with a SPECIFIC detail from the current scene, never generic filler. If nothing fits, skip the meme
- "top" is the text above the image, "bottom" below; either may be "" for one-panel templates
- Write captions in the commenters' language; keep each line short (max ~60 chars)
- Same discipline: sparingly, at most 1-2 memes per generation, no URLs
- A message carries at most ONE media field ("gif", "sticker" or "meme")`;

/**
 * Build the full contract for a generation. With every media feature off the
 * output is byte-identical to the plain PROMPT_CONTRACT.
 * @param {{ gif?: boolean, sticker?: boolean, meme?: boolean }} media
 * @returns {string}
 */
export function buildContract({ gif = false, sticker = false, meme = false } = {}) {
    const sections = [PROMPT_CONTRACT];
    if (gif) sections.push(GIF_SECTION);
    if (sticker) sections.push(STICKER_SECTION);
    if (meme) sections.push(MEME_SECTION);
    return sections.join('\n');
}