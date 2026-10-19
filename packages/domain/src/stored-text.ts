import { NOTE_MAX_LENGTH } from "./text.js";

/*
 * ─────────────────────────── Stored text ───────────────────────────
 *
 * The rule a stored or transmitted label or note is held to: by the domain on every calculation, by
 * the backup gate, and by the codec of the sync journal.
 *
 * It is not the rule a person's typing is held to (`normalizeLabel`, `normalizeNote` in text.ts), and
 * the difference is the whole point. The input rule asks the JavaScript engine — Unicode properties,
 * NFC, alphabets — and the engine's answers move with its Unicode version: a tag name ending in
 * U+A7CD, a letter new in Unicode 16, was valid on Unicode 15.1 and invalid on 16.0, and a note
 * whose characters NFC composes only in 16.0 was normalised on one engine and not on the next. Held
 * to the input rule, data a device stored yesterday became data that device refused after a routine
 * WebView update: the journal stopped restoring, the stored document stopped opening, and a backup
 * made the day before no longer restored. A family member could plant such a string on purpose.
 *
 * So this rule asks the engine nothing. It is a fixed list of code points, a fixed list of
 * whitespace and a length, and it answers the same on every engine that will ever run it. Whatever
 * the input rule produces passes it (a test walks the plane to hold that), and a code point this
 * file does not name — including one no Unicode version has assigned yet — passes it too. This file
 * uses no Unicode property escape and no normalisation, and a test reads its source to keep it so.
 */

/** A closed range of code points, both ends included. */
export type CodePointRange = readonly [number, number];

/**
 * Code points no stored label or note may contain: controls, and the invisible and formatting
 * characters that let one string read as another — every one of them refused by the input rule on
 * every engine new enough to run this app (Unicode 9 and later), so the input rule never produces
 * one. Only characters assigned long before that are listed: a character assigned later may be
 * invisible to a newer engine and visible to an older one, and listing it here would refuse on
 * every device what an older device stored.
 */
export const STORED_TEXT_FORBIDDEN: readonly CodePointRange[] = Object.freeze([
  [0x0000, 0x001f], // C0 controls: line feed, tab and carriage return among them
  [0x007f, 0x009f], // DEL and the C1 controls
  [0x00ad, 0x00ad], // soft hyphen
  [0x034f, 0x034f], // combining grapheme joiner
  [0x061c, 0x061c], // Arabic letter mark
  [0x115f, 0x1160], // Hangul choseong and jungseong fillers
  [0x17b4, 0x17b5], // Khmer inherent vowels
  [0x180b, 0x180e], // Mongolian free variation selectors and vowel separator
  [0x200b, 0x200f], // zero-width space, non-joiner and joiner, left-to-right and right-to-left marks
  [0x2028, 0x2029], // line and paragraph separators
  [0x202a, 0x202e], // bidirectional embeddings, pops and overrides
  [0x2060, 0x2064], // word joiner and the invisible operators
  [0x2066, 0x206f], // bidirectional isolates and the deprecated format controls
  [0x3164, 0x3164], // Hangul filler
  [0xfe00, 0xfe0f], // variation selectors, the emoji presentation selectors among them
  [0xfeff, 0xfeff], // byte-order mark
  [0xffa0, 0xffa0], // halfwidth Hangul filler
  [0xfff9, 0xfffb], // interlinear annotation marks
  [0x1bca0, 0x1bca3], // shorthand format controls
  [0x1d173, 0x1d17a], // musical symbol format controls
  [0xe0001, 0xe0001], // language tag
  [0xe0020, 0xe007f], // tag characters
  [0xe0100, 0xe01ef], // variation selectors supplement
] as const);

/**
 * Whitespace a stored label or note may not begin or end with: every character JavaScript's `trim`
 * has removed in every version — the controls among them, refused anyway — so a string the input
 * rule trimmed is a trimmed string here.
 */
export const STORED_TEXT_EDGE_WHITESPACE: readonly number[] = Object.freeze([
  0x0009, 0x000a, 0x000b, 0x000c, 0x000d, 0x0020, 0x00a0, 0x1680,
  0x2000, 0x2001, 0x2002, 0x2003, 0x2004, 0x2005, 0x2006, 0x2007, 0x2008, 0x2009, 0x200a,
  0x2028, 0x2029, 0x202f, 0x205f, 0x3000, 0xfeff,
]);

const EDGE_WHITESPACE = new Set(STORED_TEXT_EDGE_WHITESPACE);

/**
 * Whether `value` holds nothing but {@link STORED_TEXT_EDGE_WHITESPACE}, the empty string included.
 *
 * The engine-independent spelling of "nothing is left once trimmed", for the paths that read stored
 * or transmitted text — an identifier, a name, any required string of a document, a backup or an
 * operation. `String.prototype.trim` removes whatever the engine's Unicode version calls white space,
 * and that list has moved before (U+180E left it in Unicode 6.3), so an identifier one engine
 * accepted could be "empty" on another; this list never moves. Every code point here is one every
 * engine trims, so nothing the engine called non-blank becomes blank.
 */
export function isBlankStoredText(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    if (!EDGE_WHITESPACE.has(value.charCodeAt(index))) return false;
  }
  return true;
}

function isForbidden(codePoint: number): boolean {
  for (const [first, last] of STORED_TEXT_FORBIDDEN) {
    if (codePoint < first) return false;
    if (codePoint <= last) return true;
  }
  return false;
}

/**
 * Whether `value` is text of 1 to `maxLength` UTF-16 units that neither begins nor ends with
 * whitespace and holds no forbidden code point and no unpaired surrogate. One pass, no allocation.
 */
function isStorableText(value: unknown, maxLength: number): value is string {
  if (typeof value !== "string" || value.length === 0 || value.length > maxLength) return false;
  if (EDGE_WHITESPACE.has(value.charCodeAt(0)) || EDGE_WHITESPACE.has(value.charCodeAt(value.length - 1))) return false;
  for (let index = 0; index < value.length; index += 1) {
    let codePoint = value.charCodeAt(index);
    if (codePoint >= 0xd800 && codePoint <= 0xdfff) {
      const next = value.charCodeAt(index + 1);
      // A high surrogate followed by a low one is one astral code point; anything else is unpaired.
      if (codePoint > 0xdbff || !(next >= 0xdc00 && next <= 0xdfff)) return false;
      codePoint = 0x10000 + ((codePoint - 0xd800) << 10) + (next - 0xdc00);
      index += 1;
    }
    if (isForbidden(codePoint)) return false;
  }
  return true;
}

/**
 * Whether `value` is a label — a tag name, a counterparty, the name of a rule — the model may store
 * and the journal may carry. No alphabet rule and no normal form: those belong to the input rule.
 */
export function isStorableLabel(value: unknown, maxLength: number): value is string {
  return isStorableText(value, maxLength);
}

/** Whether `value` is a note the model may store and the journal may carry: one line, at most 500. */
export function isStorableNote(value: unknown): value is string {
  return isStorableText(value, NOTE_MAX_LENGTH);
}
