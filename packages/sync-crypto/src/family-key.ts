/**
 * The family key `FK` — `SYNC_ARCHITECTURE.md` 5.1.
 *
 * 256-bit AES-GCM key, generated on the device that creates the family from
 * `crypto.getRandomValues`, imported into WebCrypto, and never leaving the device in the clear.
 * One live key per family, plus a generation number `keyEpoch` that starts at `1`.
 */
import { fail } from "./errors.js";
import { AES_KEY_BYTES, exportAesKey, importAesKey, randomBytes, sha256 } from "./webcrypto.js";

/** 256 bits, as required by 5.1. */
export const FAMILY_KEY_BYTES = AES_KEY_BYTES;

/** The first generation of a family key. Epoch numbers only ever grow, and may skip (5.5). */
export const FIRST_KEY_EPOCH = 1;

/**
 * Generates a family key.
 *
 * The key is imported `extractable: true`, and 5.1 both requires it and names its price. The
 * requirement: an unextractable key cannot be wrapped — neither for an invite nor for rotation —
 * so a family holding one could never let a second device in. The price: code running inside the
 * application already reads the whole budget at any value of the flag, because the `CryptoKey` is
 * right there and `decrypt` is one call; `extractable: true` adds exactly one thing, the ability
 * to carry the 32 bytes away and keep using them off the device, turning a one-off session
 * compromise into a compromise of the family until the next rotation. Narrowing that window —
 * keeping the working copy unextractable and raising an extractable one only while a wrap is being
 * made — is recorded in 5.1 as a deferred hardening, deliberately not done here.
 */
export async function generateFamilyKey(): Promise<CryptoKey> {
  return importFamilyKey(randomBytes(FAMILY_KEY_BYTES));
}

/** Imports 32 raw bytes as a family key. Any other length is a refusal, never a rehash. */
export async function importFamilyKey(raw: Uint8Array): Promise<CryptoKey> {
  if (raw.length !== FAMILY_KEY_BYTES) fail("invalid_input");
  return importAesKey(raw, true);
}

export async function exportFamilyKey(key: CryptoKey): Promise<Uint8Array> {
  return exportAesKey(key);
}

/**
 * `SHA-256(FK)` — the value a device stores for the epoch it has accepted.
 *
 * 5.4 and 5.4.1 make this hash, not any server field, the thing that decides "I have already
 * closed this epoch": a wrap for an epoch whose key the device already holds is refused always,
 * and a wrap of the same epoch that opens to a *different* key is an impersonation, an alarm and a
 * refusal — never a "key update". That was the exact move by which a server sidestepped the
 * continuity confirmation: a wrap of the *current* epoch changed the key without changing the
 * number, and no confirmation is required when the number does not change.
 */
export async function familyKeyFingerprint(key: CryptoKey): Promise<Uint8Array> {
  return sha256(await exportAesKey(key));
}
