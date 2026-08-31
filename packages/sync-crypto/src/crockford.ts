/**
 * Crockford Base32 — the alphabet in which humans read this scheme's two spoken values: the invite
 * code (5.3) and a device key fingerprint (5.4).
 *
 * The alphabet contains 32 symbols *by definition*: the digits `0–9` and the Latin letters with
 * the visually confusable `I`, `L`, `O` and `U` already removed. 5.3 states plainly that nothing
 * is dropped on top of that — throwing out four more would leave 28 symbols, and a twelve-symbol
 * code would then carry `log₂(28¹²) ≈ 57.7` bits instead of the `60` on which every brute-force
 * estimate in the document is built. Exactly 5 bits per symbol, exactly 60 bits per code.
 */
import { fail } from "./errors.js";

/** Digits and letters, `I`, `L`, `O`, `U` excluded. Exactly 32 symbols. */
export const CROCKFORD_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

/**
 * Reading substitutions. Crockford's decoding is deliberately forgiving because the value is meant
 * to be read out loud: `I` and `l` are heard and written as one, `O` as zero. `U` has no
 * substitution — it is not in the alphabet and never produced, so a `U` in an entered code is a
 * typing error and is refused rather than guessed at.
 */
const SUBSTITUTIONS = new Map<string, string>([
  ["I", "1"],
  ["L", "1"],
  ["O", "0"],
]);

/**
 * Canonical form of a human-entered Crockford string: upper case, separators removed, reading
 * substitutions applied.
 *
 * This matters more here than in a general-purpose decoder. The invite code is not decoded to
 * bytes before use — it *is* the password of the Argon2id derivation and the input of the salt
 * (5.3), so the two devices must agree on the exact string. Canonicalising on entry is what makes
 * "the code I read out to you over the phone" and "the code you typed" the same secret.
 */
export function normalizeCrockford(text: string): string {
  if (typeof text !== "string") fail("invalid_input");
  let out = "";
  for (const character of text.toUpperCase()) {
    if (character === "-" || character === " ") continue;
    const mapped = SUBSTITUTIONS.get(character) ?? character;
    if (!CROCKFORD_ALPHABET.includes(mapped)) fail("invalid_input");
    out += mapped;
  }
  return out;
}

/**
 * `length` uniformly random symbols.
 *
 * The uniformity is exact rather than approximate, and it is worth one sentence because the whole
 * security argument of 5.3 rests on it. 256 is 8 × 32, so the low five bits of a uniform byte are
 * themselves uniform over the alphabet: there is no modulo bias to reject samples for, and the
 * `60` bits of a twelve-symbol code are 60 real bits.
 */
export function randomCrockford(length: number, randomBytes: (count: number) => Uint8Array): string {
  if (!Number.isSafeInteger(length) || length < 1) fail("invalid_input");
  const bytes = randomBytes(length);
  let out = "";
  for (const byte of bytes) out += CROCKFORD_ALPHABET[byte & 31]!;
  return out;
}

/** Big-endian bit slice of `bytes`, rendered as Crockford symbols. `bits` must be a multiple of 5. */
export function encodeCrockfordBits(bytes: Uint8Array, bits: number): string {
  if (!Number.isSafeInteger(bits) || bits < 5 || bits % 5 !== 0) fail("invalid_input");
  if (bytes.length * 8 < bits) fail("invalid_input");

  let out = "";
  let accumulator = 0;
  let held = 0;
  let produced = 0;
  for (const byte of bytes) {
    accumulator = (accumulator << 8) | byte;
    held += 8;
    while (held >= 5 && produced * 5 < bits) {
      held -= 5;
      out += CROCKFORD_ALPHABET[(accumulator >>> held) & 31]!;
      produced += 1;
    }
    if (produced * 5 >= bits) break;
    accumulator &= (1 << held) - 1;
  }
  return out;
}
