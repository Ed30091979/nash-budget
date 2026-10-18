/**
 * The one rule for text a person types into the model.
 *
 * It used to be written out wherever a name was accepted — the category name here, and copies of
 * the same patterns in the planning and onboarding screens — and three copies of one rule are three
 * rules the moment one of them is edited. This is the domain's copy, and the domain's callers use
 * it; each keeps its own codes and its own words for the screen, because a refusal a person reads
 * belongs to the screen that shows it.
 */

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

/** Controls, bidirectional controls and everything Unicode treats as invisible by default. */
const FORBIDDEN_FORMATTING_PATTERN = /[\p{Cc}\p{Bidi_Control}\p{Default_Ignorable_Code_Point}]/u;

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
