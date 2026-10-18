/**
 * The one rule for text a person types into the model.
 *
 * It used to be written out wherever a name was accepted — the category name here, and copies of
 * the same patterns in the planning and onboarding screens — and three copies of one rule are three
 * rules the moment one of them is edited. This is the domain's copy, and the domain's callers use
 * it; each keeps its own codes and its own words for the screen, because a refusal a person reads
 * belongs to the screen that shows it.
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
 * Whether `value` is a label exactly as {@link normalizeLabel} would store it.
 *
 * The check a stored label is held to: a backup, a journal entry and the domain all ask this one
 * question, so a label one of them accepts the others accept too.
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

/** Whether `value` is a non-empty note exactly as {@link normalizeNote} would store it. */
export function isNormalizedNote(value: unknown): value is string {
  if (typeof value !== "string") return false;
  try {
    return normalizeNote(value) === value;
  } catch (error) {
    if (error instanceof TextValidationError) return false;
    throw error;
  }
}

/** Whether `value` names a design token: kebab-case, at most {@link DISPLAY_KEY_MAX_LENGTH}. */
export function isDisplayKey(value: unknown): value is DisplayKey {
  return typeof value === "string" && value.length <= DISPLAY_KEY_MAX_LENGTH && DISPLAY_KEY_PATTERN.test(value);
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
