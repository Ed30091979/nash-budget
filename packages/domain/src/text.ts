/**
 * The one rule for text a person types into the model.
 *
 * It used to be written out wherever a name was accepted — the category name here, and copies of
 * the same patterns in the planning and onboarding screens — and three copies of one rule are three
 * rules the moment one of them is edited. This is the domain's copy, and the domain's callers use
 * it; each keeps its own codes and its own words for the screen, because a refusal a person reads
 * belongs to the screen that shows it.
 *
 * It is the rule for input, and only for input. It asks the engine about Unicode — properties, NFC,
 * alphabets — and the engine's answers move with its Unicode version, so text it accepted on one
 * engine may be text it refuses on the next. What the model stores and the journal carries is held
 * to `isStorableLabel` and `isStorableNote` (stored-text.ts) instead, which ask the engine nothing,
 * and everything this rule produces passes them.
 */

import type { DisplayKey } from "./types.js";

/** A note on an operation: one line, at most this many UTF-16 units — the backup's text limit. */
export const NOTE_MAX_LENGTH = 500;
export const TAG_NAME_MAX_LENGTH = 40;
export const MAX_TAGS_PER_TRANSACTION = 10;
export const DISPLAY_KEY_MAX_LENGTH = 40;

/** Why a piece of text was refused, in codes every caller maps to its own words. */
export type TextErrorCode = "required" | "too_long" | "forbidden_characters" | "mixed_scripts";

/** A refusal of text. `code` is for the caller; the message is for a developer, not a screen. */
export class TextValidationError extends Error {
  readonly code: TextErrorCode;

  constructor(code: TextErrorCode, message: string) {
    super(message);
    this.name = "TextValidationError";
    this.code = code;
  }
}

function fail(code: TextErrorCode, message: string): never {
  throw new TextValidationError(code, message);
}

/**
 * Controls, bidirectional controls and everything Unicode treats as invisible by default — and,
 * on top of those, the line and paragraph separators, the interlinear annotation marks and unpaired
 * surrogates.
 *
 * The four additions are what the journal codec refuses in any text (`UNSAFE_TEXT` in
 * `sync-protocol/src/codec.ts`) and the first three classes do not cover. With them this rule is
 * strictly wider than the codec's, so whatever the domain stores, the journal carries: a category
 * named with a line separator used to be accepted here and then refused by every other device of
 * the family.
 */
const FORBIDDEN_FORMATTING_PATTERN =
  /[\p{Cc}\p{Bidi_Control}\p{Default_Ignorable_Code_Point}\u2028\u2029\ufff9-\ufffb]|\p{Cs}/u;

/**
 * Emoji presentation selectors. Default-ignorable, so refused in a name, but a phone keyboard puts
 * one after half the emoji it offers; a note drops them rather than refusing the person who picked
 * a heart from the emoji keyboard. The emoji itself stays.
 */
const PRESENTATION_SELECTORS = /[\ufe0e\ufe0f]/gu;

/** A design-token key: lowercase kebab-case that starts with a letter. */
const DISPLAY_KEY_PATTERN = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;

/**
 * Keys an object inherits. A display key is looked up in a table of tokens, and a key like these
 * finds a function of `Object.prototype` instead of a token in a plain object; they are refused
 * outright, and every table of tokens is read through `Map` or `Object.hasOwn` all the same.
 */
const INHERITED_KEYS = new Set(["constructor", "prototype"]);

/**
 * A name needs something to read: a letter or a digit somewhere, and not a combining mark first —
 * that one would attach to whatever the screen draws before the name. The braille blank (U+2800)
 * and the object replacement character (U+FFFC) are refused as well: neither is hidden to the text
 * rule, both are a blank or a placeholder to the eye.
 */
const NAME_LETTER_OR_DIGIT = /[\p{L}\p{N}]/u;
const NAME_LEADING_MARK = /^\p{M}/u;
const NAME_BLANKS = /[\u2800\ufffc]/u;

/**
 * Alphabets whose letters look alike. A name that mixes them — a Latin `a` inside a Cyrillic word —
 * reads as one name and compares as another, which is how a duplicate slips past a duplicate check.
 */
const LABEL_SCRIPT_PATTERNS = [
  /\p{Script=Latin}/u,
  /\p{Script=Cyrillic}/u,
  /\p{Script=Greek}/u,
] as const;

/**
 * Trims and normalises a short name the way it will be stored, or refuses it.
 *
 * NFC first, so that a name typed with a combining accent and the same name typed precomposed are
 * one name; then the surrounding whitespace goes. What is left must be non-empty, at most
 * `maxLength` UTF-16 units, free of hidden or control characters, and written in one alphabet.
 * Input longer than four times the limit is refused before it is normalised, so a megabyte pasted
 * into a field is not run through Unicode normalisation to find out it is too long.
 */
export function normalizeLabel(value: string, maxLength: number): string {
  if (typeof value !== "string" || value.length > maxLength * 4) {
    fail("too_long", `label must be at most ${maxLength} characters`);
  }
  const normalized = value.normalize("NFC").trim();
  if (!normalized) fail("required", "label must not be empty");
  if (normalized.length > maxLength) fail("too_long", `label must be at most ${maxLength} characters`);
  if (FORBIDDEN_FORMATTING_PATTERN.test(normalized)) {
    fail("forbidden_characters", "label must not contain hidden or control characters");
  }
  if (LABEL_SCRIPT_PATTERNS.filter((pattern) => pattern.test(normalized)).length > 1) {
    fail("mixed_scripts", "label must not mix look-alike alphabets");
  }
  return normalized;
}

/**
 * Whether `value` is a label exactly as {@link normalizeLabel} would produce it, on this engine.
 *
 * For input only — a form deciding whether to show what it has. Never for stored or transmitted
 * text: the answer depends on the engine's Unicode version, so a stored label held to it could turn
 * invalid after a browser update. Stored text is checked by `isStorableLabel` (stored-text.ts).
 */
export function isNormalizedLabel(value: unknown, maxLength: number): value is string {
  if (typeof value !== "string") return false;
  try {
    return normalizeLabel(value, maxLength) === value;
  } catch (error) {
    if (error instanceof TextValidationError) return false;
    throw error;
  }
}

/**
 * Normalises a note the way it will be stored: emoji presentation selectors dropped, then NFC, then
 * the surrounding whitespace trimmed. A note that is empty after that is no note at all and comes
 * back as `undefined`, because an operation without a note omits the field rather than carrying `""`.
 *
 * The selectors go first, and the order is the point. A selector is a starter (canonical class 0),
 * so one sitting between a letter and a combining mark keeps NFC from composing the two; dropped
 * after NFC, it left the pair side by side uncomposed, and the stored note was a string the same
 * rule then refused as not normalised.
 *
 * The same hidden-character rule as {@link normalizeLabel}, and one line only — a line feed is a
 * control character — but no rule on alphabets: a note is prose, «кофе в Starbucks» is an honest
 * one, and nothing compares notes against each other to be fooled by a look-alike letter.
 */
export function normalizeNote(value: string): string | undefined {
  if (typeof value !== "string" || value.length > NOTE_MAX_LENGTH * 4) {
    fail("too_long", `note must be at most ${NOTE_MAX_LENGTH} characters`);
  }
  const normalized = value.replace(PRESENTATION_SELECTORS, "").normalize("NFC").trim();
  if (!normalized) return undefined;
  if (normalized.length > NOTE_MAX_LENGTH) fail("too_long", `note must be at most ${NOTE_MAX_LENGTH} characters`);
  if (FORBIDDEN_FORMATTING_PATTERN.test(normalized)) {
    fail("forbidden_characters", "note must not contain hidden or control characters");
  }
  return normalized;
}

/**
 * Whether `value` is a non-empty note exactly as {@link normalizeNote} would produce it, on this
 * engine. For input only, for the reason {@link isNormalizedLabel} gives; stored notes are checked by
 * `isStorableNote` (stored-text.ts).
 */
export function isNormalizedNote(value: unknown): value is string {
  if (typeof value !== "string") return false;
  try {
    return normalizeNote(value) === value;
  } catch (error) {
    if (error instanceof TextValidationError) return false;
    throw error;
  }
}

/**
 * Whether `value` names a design token: kebab-case, at most {@link DISPLAY_KEY_MAX_LENGTH}, and not
 * a key every object inherits. Engine-independent, so it is the rule for stored keys as well.
 */
export function isDisplayKey(value: unknown): value is DisplayKey {
  return typeof value === "string" && value.length <= DISPLAY_KEY_MAX_LENGTH && DISPLAY_KEY_PATTERN.test(value)
    && !INHERITED_KEYS.has(value);
}

/**
 * Whether a label {@link normalizeLabel} already accepted is a name someone can read: it carries a
 * letter or a digit, does not begin with a combining mark, and holds no braille blank and no object
 * replacement character. For input only, like the rest of this file; each caller refuses with its
 * own code and words. Tag names, counterparties and the names of rules are held to it.
 */
export function isReadableName(label: string): boolean {
  return NAME_LETTER_OR_DIGIT.test(label) && !NAME_LEADING_MARK.test(label) && !NAME_BLANKS.test(label);
}

/**
 * Comparison key for duplicate detection: case- and width-insensitive, Russian locale.
 *
 * Not a normal form — nothing is ever stored this way — only the key two names are compared by,
 * so «Отпуск», «отпуск» and «ОТПУСК» are one name to a duplicate check.
 */
export function labelKey(value: string): string {
  return value.normalize("NFKC").trim().toLocaleLowerCase("ru-RU");
}
