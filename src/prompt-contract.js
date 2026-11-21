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

// The example's reactions are the strongest few-shot signal the model follows
// (measured live: a unicode example kept unicode reactions dominant even with
// a pack listed in the emote section). With emotes on, buildContract swaps
// this block for an emote-first one built from the taught codes.
const EXAMPLE_REACTIONS_UNICODE = `[
  {"username": "coder_42", "content": "I can't believe the author just did that", "reactions": [{"emoji": "😭", "count": "12"}, {"emoji": "🐈", "count": "25"}]},
  {"username": "ghost_reader", "content": "SAME. I had to put my phone down and stare at the wall for a minute", "reply": {"to": "coder_42", "quote": "the author just did that"}, "reactions": [{"emoji": "🙏", "count": "10"}]},
  {"username": "ALLCAPS_CHAOS", "content": "АХАХАХА ОН ЖЕ ПРОСТО КОТ А НЕ ИМПЕРАТОР", "reactions": [{"emoji": "🤣", "count": "45"}, {"emoji": "💀", "count": "20"}]}
]`;

export const PROMPT_CONTRACT = `#Chat Commentary

Generate exactly {{count}} chat messages reacting to the current scene. Use the EXACT format below.

## OUTPUT FORMAT — respond with ONLY a JSON array. No markdown, no code blocks, no extra text.

Example (note: reply's "content" is a real message, and its "quote" is copied from the target's message):
${EXAMPLE_REACTIONS_UNICODE}

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
const gifSection = (max) => `
## GIF ATTACHMENTS

- "gif": optional string — a SHORT English search phrase (2-5 words) describing a reaction GIF. Anchor on a classic reaction mood, then adapt the words to THIS scene, and vary the moods across the feed: shock ("cat shocked", "jaw drop"), hype ("mic drop", "confetti explosion"), despair ("head in hands", "crying on the floor"), cringe ("cringe so hard", "yikes"), cope ("clown makeup", "this is fine"), applause ("slow clap", "standing ovation")
- Use a GIF only when it genuinely amplifies the emotion of the message — at most ${max} GIF${max === 1 ? '' : 's'} per generation, most messages have none
- NEVER put URLs or links in "gif" or "content" — only the search phrase
- The GIF complements "content"; "content" stays required (a short caption is fine)`;

const stickerSection = (max) => `
## STICKER ATTACHMENTS

- "sticker": optional string — a SHORT English search phrase (1-3 words) for a transparent sticker
- The sticker pool is SMALL: simple gestures and moods hit it (thumbs up, crying, shock, clap, saluting); long scene-specific phrases usually find nothing
- Same discipline as GIFs: sparingly, at most ${max} sticker${max === 1 ? '' : 's'} per generation, no URLs`;

const memeSection = (max) => `
## MEME ATTACHMENTS

- "meme": optional object {"template": "...", "top": "...", "bottom": "..."} — pick "template" EXACTLY from this verified list (any other name may fail to resolve and the meme is silently dropped), then write the caption lines yourself:
    drake — rejects "top", approves "bottom"
    ds — sweating over two buttons: "top" = left button label, "bottom" = right button label
    spongebob — mocking: "bottom" repeats "top" in sarcastic alternating caps
    woman-cat — "top" = furious accusation, "bottom" = the cat's unhinged reply
    fine — "top" = what is objectively going wrong, "bottom" = calm denial
    harold — "top" = the painful situation, "bottom" = the strained smile line
    disastergirl — "top" = the innocent look, "bottom" = the chaos she just caused
    mordor — "top" = "one does not simply..." setup, "bottom" = the hard thing
    buzz — "top" = the thing, "bottom" = "X, X everywhere"
    spiderman — "top" and "bottom" = two identical accusations
    rollsafe — "top" = the flawed logic, "bottom" = the smug conclusion
    cmm — "top" = the provocative statement on the sign; leave "bottom" empty
- VARY templates across the feed and across generations — the audience notices reruns
- Fill the captions with a SPECIFIC detail from the current scene, never generic filler. If nothing fits, skip the meme
- "top" is the first caption line, "bottom" the second
- Write captions in the commenters' language; keep each line short (max ~60 chars)
- Same discipline: sparingly, at most ${max} meme${max === 1 ? '' : 's'} per generation, no URLs
- The meme complements "content"; "content" stays required (a short caption is fine)`;

// Mutual exclusion is taught once, only when more than one media type is in
// play — with a single enabled type there is nothing to exclude. The rule
// names only the fields whose sections are present: mentioning a field the
// model was never taught invites it to emit one anyway.
const oneMediaFieldRule = (names) => `
- A message carries at most ONE media field (${names.map(n => `"${n}"`).join(', ')})`;

/**
 * Emote-first example reactions: the main example's five unicode reactions
 * swap for taught codes (cycled — the list always has at least one member).
 * @param {string[]} codes
 * @returns {string}
 */
function emoteExampleReactions(codes) {
    const at = (i) => codes[i % codes.length];
    return `[
  {"username": "coder_42", "content": "I can't believe the author just did that", "reactions": [{"emoji": "${at(0)}", "count": "12"}, {"emoji": "${at(1)}", "count": "25"}]},
  {"username": "ghost_reader", "content": "SAME. I had to put my phone down and stare at the wall for a minute", "reply": {"to": "coder_42", "quote": "the author just did that"}, "reactions": [{"emoji": "${at(2)}", "count": "10"}]},
  {"username": "ALLCAPS_CHAOS", "content": "АХАХАХА ОН ЖЕ ПРОСТО КОТ А НЕ ИМПЕРАТОР", "reactions": [{"emoji": "${at(3)}", "count": "45"}, {"emoji": "${at(4)}", "count": "20"}]}
]`;
}

/**
 * Reaction emotes: teaches the built-in pack plus famous codes from the
 * user's set (getEmoteCodes filters the set layer). Pack codes are the
 * DEFAULT reaction form; plain unicode emoji are demoted to the rare
 * exception — the user reads a Twitch-style feed, not an emoji one.
 * @param {string[]} codes
 * @returns {string}
 */
function emoteSection(codes) {
    return `
## REACTION EMOTES

- In "reactions", "emoji" may be a Twitch-style emote CODE instead of a unicode emoji, e.g.: ${codes.join(', ')}
- Example: "reactions": [{"emoji": "${codes[0]}", "count": "12"}]
- React with pack codes by default — plain unicode emoji are the last resort, only for moods no code covers (laugh → KEKW/LuL/ICANT, sad → BibleThump/FeelsBadMan, shock/cringe → WutFace/monkaS, hype → peepoHappy/PartyParrot, smug → EZ); never post the unicode twin of a code the pack already has
- VARY the codes across the feed — the audience notices reruns
- These are Twitch/Discord-style meme emotes — use them for meme moods (cope, hype, cringe, dread, smug)
- Other well-known emote codes render as pictures too; unknown or invented ones silently show as text
- Emotes are reactions, not message text — "content" still carries the words`;
}

/**
 * Build the full contract for a generation. With every media feature off the
 * output is byte-identical to the plain PROMPT_CONTRACT. A media type whose
 * cap is 0 contributes no section — cheaper and more reliable than asking
 * the model to "use it 0 times".
 * @param {{ gif?: boolean, sticker?: boolean, meme?: boolean,
 *           gifMax?: number, stickerMax?: number, memeMax?: number,
 *           emoteCodes?: string[]|null }} media
 * @returns {string}
 */
export function buildContract({ gif = false, sticker = false, meme = false, gifMax = 2, stickerMax = 1, memeMax = 1, emoteCodes = null } = {}) {
    // With emotes on the main example's reactions go emote-first — the example
    // outweighs any written rule, so the few-shot signal must point the same
    // way as the REACTION EMOTES section.
    const base = Array.isArray(emoteCodes) && emoteCodes.length > 0
        ? PROMPT_CONTRACT.replace(EXAMPLE_REACTIONS_UNICODE, () => emoteExampleReactions(emoteCodes))
        : PROMPT_CONTRACT;
    const sections = [base];
    const mediaNames = [];
    if (gif && gifMax > 0) { sections.push(gifSection(gifMax)); mediaNames.push('gif'); }
    if (sticker && stickerMax > 0) { sections.push(stickerSection(stickerMax)); mediaNames.push('sticker'); }
    if (meme && memeMax > 0) { sections.push(memeSection(memeMax)); mediaNames.push('meme'); }
    if (mediaNames.length > 1) sections.push(oneMediaFieldRule(mediaNames));
    if (Array.isArray(emoteCodes) && emoteCodes.length > 0) sections.push(emoteSection(emoteCodes));
    return sections.join('\n');
}