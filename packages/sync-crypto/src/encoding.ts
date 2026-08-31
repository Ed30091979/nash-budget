/**
 * `enc` — the single length-prefixed encoding used by every bound construction in the scheme.
 *
 * `SYNC_ARCHITECTURE.md` 5.2 fixes it once for the whole document: each value becomes bytes
 * (strings as UTF-8, integers as their decimal representation in UTF-8, byte strings as they
 * are), each value is preceded by its length as a four-byte big-endian integer, and the results
 * are concatenated. An empty list encodes to an empty string.
 *
 * The pedantry has one purpose. Plain concatenation is ambiguous: `"ab" || "c"` and `"a" || "bc"`
 * are the same bytes, so a pair `(familyId, keyEpoch)` of `("f1", "23")` and `("f12", "3")` would
 * produce one and the same AAD, and an attacker could move an envelope between two families
 * without forging anything at all. The length prefix removes the ambiguity, and it has to be the
 * *same* encoding everywhere — envelope AAD, invite salt and AAD, HKDF `info`, `bindProof`,
 * checkpoint digests and `rotateConfirm` — or two constructions could collide with each other.
 */
import { fail } from "./errors.js";

/** A value `enc` accepts. Numbers must be non-negative safe integers; see {@link encodeValue}. */
export type EncodableValue = string | number | Uint8Array;

const ENCODER = new TextEncoder();
const DECODER = new TextDecoder("utf-8", { fatal: true });

/** Four-byte big-endian length prefix, so no value may be longer than this. */
const MAX_VALUE_BYTES = 0xff_ff_ff_ff;

/** UTF-8 bytes of `text`. */
export function utf8(text: string): Uint8Array {
  return ENCODER.encode(text);
}

/** `text` from UTF-8 bytes; refuses malformed sequences instead of substituting replacements. */
export function fromUtf8(bytes: Uint8Array): string {
  try {
    return DECODER.decode(bytes);
  } catch {
    return fail("invalid_input");
  }
}

function encodeValue(value: EncodableValue): Uint8Array {
  if (typeof value === "string") return utf8(value);
  if (typeof value === "number") {
    // Integers travel as their decimal text. Anything else — a float, a negative, a value past
    // the safe range — has no single decimal form two devices would agree on, so it is refused
    // rather than rounded into one.
    if (!Number.isSafeInteger(value) || value < 0) fail("invalid_input");
    return utf8(String(value));
  }
  if (!(value instanceof Uint8Array)) fail("invalid_input");
  return value;
}

/** The canonical binding encoding of 5.2. An empty argument list gives an empty result. */
export function enc(...values: readonly EncodableValue[]): Uint8Array {
  const parts = values.map(encodeValue);
  let total = 0;
  for (const part of parts) {
    if (part.length > MAX_VALUE_BYTES) fail("invalid_input");
    total += part.length + 4;
  }

  const out = new Uint8Array(total);
  const view = new DataView(out.buffer);
  let offset = 0;
  for (const part of parts) {
    view.setUint32(offset, part.length, false);
    offset += 4;
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

/**
 * The inverse of {@link enc}, used where a decrypted payload is itself an `enc` list — the invite
 * box of 5.3 is the only such place today.
 *
 * It returns the raw segments and never guesses their types: `enc` is injective on the byte level
 * but not on the type level, so deciding that a segment "is a number" belongs to the caller who
 * knows the schema. `count` is required, and a list of a different length is a rejection: a
 * payload with an extra or a missing field is not a payload with a default, it is a payload that
 * was written by something other than this version of the scheme.
 */
export function decodeEnc(bytes: Uint8Array, count: number): readonly Uint8Array[] {
  if (!Number.isSafeInteger(count) || count < 0) fail("invalid_input");
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const parts: Uint8Array[] = [];
  let offset = 0;

  while (offset < bytes.length) {
    if (offset + 4 > bytes.length) fail("invite_payload_invalid");
    const length = view.getUint32(offset, false);
    offset += 4;
    if (length > bytes.length - offset) fail("invite_payload_invalid");
    parts.push(bytes.subarray(offset, offset + length));
    offset += length;
    if (parts.length > count) fail("invite_payload_invalid");
  }

  if (parts.length !== count) fail("invite_payload_invalid");
  return parts;
}

/**
 * The first segment of an `enc` list, read without knowing how many segments follow.
 *
 * {@link decodeEnc} is strict about the count on purpose, and that strictness is exactly what
 * makes a version field necessary: a payload written by a later version of the scheme carries a
 * different number of fields, and a reader that insists on today's count throws it out as
 * malformed before it can notice that it is merely newer. 5.3 therefore has the invite payload
 * carry its version **first** and requires it to be read before the rest of the payload is parsed
 * at all. That is the one lenient step, and it stays this small: it reads one segment and says
 * nothing about what follows it.
 */
export function decodeEncHead(bytes: Uint8Array): Uint8Array {
  if (bytes.length < 4) fail("invite_payload_invalid");
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const length = view.getUint32(0, false);
  if (length > bytes.length - 4) fail("invite_payload_invalid");
  return bytes.subarray(4, 4 + length);
}

/**
 * Byte equality that does not stop at the first difference.
 *
 * Every comparison in this package is against something an attacker controls one end of — a
 * fingerprint delivered by the server, an `authToken` guessed from an invite code, an HMAC over a
 * chosen message. An early-exit comparison leaks how long the matching prefix was, and a prefix
 * oracle turns a search of the whole space into a search one byte at a time. 5.4 requires the
 * fingerprint comparison to be constant time by name; the rest follow the same rule because there
 * is no reason to keep two kinds of comparison around and pick the wrong one later.
 */
export function equalBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let index = 0; index < a.length; index += 1) diff |= a[index]! ^ b[index]!;
  return diff === 0;
}

const HEX: readonly string[] = Array.from({ length: 256 }, (_unused, value) =>
  value.toString(16).padStart(2, "0"),
);

/** Lowercase hexadecimal, for pinned fingerprints in local storage and for test vectors. */
export function toHex(bytes: Uint8Array): string {
  let hex = "";
  for (const byte of bytes) hex += HEX[byte]!;
  return hex;
}

/** The inverse of {@link toHex}. Refuses anything that is not an even run of hex digits. */
export function fromHex(hex: string): Uint8Array {
  if (hex.length % 2 !== 0 || !/^[0-9a-fA-F]*$/u.test(hex)) fail("invalid_input");
  const bytes = new Uint8Array(hex.length / 2);
  for (let index = 0; index < bytes.length; index += 1) {
    bytes[index] = Number.parseInt(hex.slice(index * 2, index * 2 + 2), 16);
  }
  return bytes;
}

/** Concatenation of byte runs, for the few places that build a buffer rather than an `enc` list. */
export function concatBytes(...parts: readonly Uint8Array[]): Uint8Array {
  let total = 0;
  for (const part of parts) total += part.length;
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}
