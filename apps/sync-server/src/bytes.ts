/**
 * Byte and identifier handling shared by the routes.
 *
 * Everything opaque travels as standard base64 in JSON and is stored as a BLOB. The server never
 * looks inside any of it: an IV, a ciphertext, a wrap and a `rotateConfirm` are all just lengths
 * to it, which is exactly what 1.1 requires it to be.
 */
import { createHash, createHmac, randomBytes as nodeRandomBytes, timingSafeEqual } from "node:crypto";

import { MAX_ID_LENGTH } from "./limits.ts";

export function randomBytes(length: number): Uint8Array {
  return new Uint8Array(nodeRandomBytes(length));
}

export function sha256(input: Uint8Array): Uint8Array {
  return new Uint8Array(createHash("sha256").update(input).digest());
}

export function hmacSha256(key: Uint8Array, input: Uint8Array): Uint8Array {
  return new Uint8Array(createHmac("sha256", key).update(input).digest());
}

/** Constant time in the length-equal case, and `false` — not a throw — when lengths differ. */
export function equalBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

export function toBase64(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64");
}

export function toBase64Url(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64url");
}

/**
 * Strict base64 decoding.
 *
 * `Buffer.from(s, "base64")` is famously forgiving — it drops anything it does not recognise and
 * returns a short buffer rather than an error. On this boundary that would turn a malformed IV
 * into a silently truncated one, so the decoded bytes are re-encoded and compared: only input that
 * round-trips is accepted.
 */
export function fromBase64(value: string): Uint8Array | null {
  if (typeof value !== "string") return null;
  const decoded = Buffer.from(value, "base64");
  if (decoded.toString("base64") !== value) return null;
  return new Uint8Array(decoded);
}

export function fromBase64Url(value: string): Uint8Array | null {
  if (typeof value !== "string") return null;
  const decoded = Buffer.from(value, "base64url");
  if (decoded.toString("base64url") !== value) return null;
  return new Uint8Array(decoded);
}

const UUID_V4 =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

/**
 * 2.2: `deviceId` and `opId` are UUID v4 in canonical lower case, and the form is normative rather
 * than cosmetic — both feed the merge tiebreaker of 4.1, where `A1B2…` and `a1b2…` would hash
 * differently and give two devices two different states. The server refuses the wrong form instead
 * of lower-casing it: a value it silently rewrote would no longer be the value bound into the AAD.
 */
export function isUuidV4(value: unknown): value is string {
  return typeof value === "string" && UUID_V4.test(value);
}

/** 3.2: identifiers are at most `128` characters. Used for `memberId`, which is a `StableId`. */
export function isIdentifier(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= MAX_ID_LENGTH;
}
