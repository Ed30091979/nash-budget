/**
 * Every refusal this package raises.
 *
 * The messages are deliberately fixed strings. A cryptographic failure is the one place where a
 * helpful message is a leak: the caller's inputs here are the family key, the plaintext of an
 * operation and the invite code, and echoing any part of them into an `Error` puts them into logs,
 * crash reporters and screenshots — the three places from which they can never be withdrawn.
 * `SYNC_ARCHITECTURE.md` 5.2 states the rule directly: a failed tag check is a refusal whose
 * message contains no part of the ciphertext, no part of the plaintext and nothing derived from a
 * key. Callers that need to tell one refusal from another read {@link SyncCryptoError.code}, which
 * names the class of failure and never a value.
 */
export type SyncCryptoErrorCode =
  /** A structural rejection of an argument: wrong length, wrong shape, out of range. */
  | "invalid_input"
  /** AES-GCM tag verification failed: the envelope was not written by this key, or was altered. */
  | "envelope_open_failed"
  /** The invite box did not open: the code is wrong, or the box was altered. */
  | "invite_open_failed"
  /** The invite box opened but its contents are not a well-formed payload. */
  | "invite_payload_invalid"
  /**
   * The invite payload opened and declares a format version this build does not know (5.3).
   *
   * Distinct from {@link SyncCryptoErrorCode} `invite_open_failed` and `invite_payload_invalid` on
   * purpose. The box opened, so the code was right and the bytes are intact; the only thing wrong
   * is that a newer version of the app wrote it. Folded into either of the other two, that reads
   * to the user as "wrong code" and sends him looking for a mistake he did not make.
   */
  | "invite_version_unsupported"
  /** The invite claims a sender who is not the owner, so the whole invite is refused (5.3). */
  | "invite_sender_not_owner"
  /** The delivered sender public key does not hash to the pinned fingerprint (5.4). */
  | "sender_key_mismatch"
  /**
   * The recipient's public key does not hash to the fingerprint pinned for that device (5.4).
   *
   * Deliberately not folded into {@link SyncCryptoErrorCode} `sender_key_mismatch`: it names the
   * opposite failure. That one is "someone handed me a key I do not trust"; this one is "I was
   * about to wrap the family key *onto* a key I do not trust", which is the direction that gives
   * the key away rather than merely refusing one. They reach the user as different sentences and
   * the caller acts on them differently, so one code for both would lose the distinction.
   */
  | "recipient_key_mismatch"
  /** The key wrap did not open under the derived wrapping key. */
  | "key_wrap_open_failed"
  /** An envelope offered for re-encryption does not belong to the epoch being rotated (5.5). */
  | "epoch_mismatch";

/** A refusal from the family-synchronisation crypto layer. Carries a class, never a value. */
export class SyncCryptoError extends Error {
  readonly code: SyncCryptoErrorCode;

  constructor(code: SyncCryptoErrorCode, message: string) {
    super(message);
    this.name = "SyncCryptoError";
    this.code = code;
  }
}

/** Every message this package can produce, in one place, so the no-leak rule stays auditable. */
const MESSAGES: Record<SyncCryptoErrorCode, string> = {
  invalid_input: "argument rejected by the sync crypto layer",
  envelope_open_failed: "envelope authentication failed",
  invite_open_failed: "invite box authentication failed",
  invite_payload_invalid: "invite payload is malformed",
  invite_version_unsupported: "invite was issued by a newer version of the app",
  invite_sender_not_owner: "invite was not issued by the family owner",
  sender_key_mismatch: "sender key does not match the pinned fingerprint",
  recipient_key_mismatch: "recipient key does not match the pinned fingerprint",
  key_wrap_open_failed: "key wrap authentication failed",
  epoch_mismatch: "envelope belongs to a different key epoch",
};

/**
 * Every code, read off the table above instead of written out a second time.
 *
 * `SyncCryptoErrorCode` is a type and does not survive to runtime, but {@link MESSAGES} is declared
 * as a total `Record` over it: the compiler refuses a table that has lost a code, and the keys of
 * that table are therefore the one list that cannot drift from the union. `tests/no-leak.test.ts`
 * drives every entry of this list into a real refusal, so a message added here and never provoked
 * is a failing test rather than an unaudited string. A list written out by hand in the test could
 * not promise that, and did not: `recipient_key_mismatch` was added to the union and the hand-made
 * list stayed at nine.
 */
export const SYNC_CRYPTO_ERROR_CODES: readonly SyncCryptoErrorCode[] = Object.keys(
  MESSAGES,
) as readonly SyncCryptoErrorCode[];

export function fail(code: SyncCryptoErrorCode): never {
  throw new SyncCryptoError(code, MESSAGES[code]);
}
