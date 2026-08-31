/**
 * Rotation — `SYNC_ARCHITECTURE.md` 5.5 — and the epoch continuity confirmation of 5.4.
 *
 * Rotation is mandatory, not advisory: a member who left, a member the owner removed, a revoked
 * device and a suspicion of compromise are all triggers, because revocation cancels tokens and
 * never the key sitting in someone else's IndexedDB. Journal compaction (5.7) reuses the same
 * machinery as a fifth, optional occasion.
 */
import { enc, equalBytes } from "./encoding.js";
import { openEnvelope, sealEnvelope, type SealedEnvelope } from "./envelope.js";
import { fail } from "./errors.js";
import { exportFamilyKey, familyKeyFingerprint, FIRST_KEY_EPOCH } from "./family-key.js";
import { hkdfSha256, hmacSha256 } from "./webcrypto.js";

const ROTATE_CONFIRM_LABEL = "nash-budget/rotate-confirm/v1";

export interface EpochConfirmParams {
  /** The key of the **previous** epoch: the confirmation is computed on it, never on the new one. */
  readonly previousFamilyKey: CryptoKey;
  readonly familyId: string;
  /** The new epoch number, `keyEpoch'`. */
  readonly keyEpoch: number;
  readonly rotationId: string;
  /** The new key, `FK'`. Only its `SHA-256` enters the message. */
  readonly nextFamilyKey: CryptoKey;
}

/**
 * ```
 * confirmKey    = HKDF-SHA-256(ikm = FK, salt = ∅, L = 32,
 *                   info = enc("nash-budget/rotate-confirm/v1", familyId))
 * rotateConfirm = HMAC-SHA-256(confirmKey,
 *                   enc(familyId, keyEpoch', rotationId, SHA-256(FK')))
 * ```
 *
 * The second line of defence of 5.4, and it does not depend on device keys at all: it closes the
 * same scenario even if the pinning half is implemented wrongly. A device that unwrapped `FK'` must
 * recompute this value and check it **before** it recognises the new epoch; a change of epoch
 * without a valid confirmation is not accepted, the device stays on its own epoch, shows "epoch not
 * confirmed" and keeps working locally.
 *
 * The honest boundary is wider than it looks, and 5.4 states it: anyone who knows the key of the
 * previous epoch can make this value — which is every device that ever held that key, including the
 * stolen, the lost and the already-revoked one. What it does close is the server, which never had
 * the key and therefore cannot confirm an `FK*` of its own invention. Protection from a device that
 * has been in the family comes from elsewhere: a wrap for an epoch whose key is already held is
 * always refused, and a new key is accepted only by chain or by a human-started ceremony (5.4.1).
 */
export async function computeEpochConfirm(params: EpochConfirmParams): Promise<Uint8Array> {
  const confirmKey = await hkdfSha256(
    await exportFamilyKey(params.previousFamilyKey),
    new Uint8Array(0),
    enc(ROTATE_CONFIRM_LABEL, params.familyId),
  );
  return hmacSha256(
    confirmKey,
    enc(
      params.familyId,
      params.keyEpoch,
      params.rotationId,
      await familyKeyFingerprint(params.nextFamilyKey),
    ),
  );
}

/** The receiving side of the same value, compared in constant time. */
export async function verifyEpochConfirm(
  params: EpochConfirmParams,
  confirm: Uint8Array,
): Promise<boolean> {
  if (!(confirm instanceof Uint8Array)) fail("invalid_input");
  return equalBytes(await computeEpochConfirm(params), confirm);
}

export interface ReencryptParams {
  readonly envelope: SealedEnvelope;
  readonly previousFamilyKey: CryptoKey;
  readonly nextFamilyKey: CryptoKey;
  /** `keyEpoch'`. Must be strictly greater than the envelope's epoch: epoch numbers only grow. */
  readonly nextKeyEpoch: number;
}

/**
 * Re-encrypts one envelope into the new epoch — step 4 of 5.5.
 *
 * Exactly three things change — **`iv`, `keyEpoch` and the ciphertext** — and everything else is
 * carried across untouched: the format version, the `kind`, the `familyId`, the `opId` and the
 * author's `deviceId`. The plaintext is moved byte for byte and never re-serialised, which is what
 * keeps `lamport` and `memberId` — both of which live inside it — untouched, and what keeps the
 * merge producing the same result: the tiebreaker is a hash of the canonical text, so rewriting
 * even the action of a winning operation would give it a different hash and let two devices
 * disagree in silence (5.7 makes the same point about compaction).
 *
 * Preserving the author's `deviceId` is why 3.3 forbids the server to require that the header
 * `deviceId` match the uploading device: on this step the owner uploads envelopes authored by every
 * device in the family. The requirement is addressed to phase S3 directly, because getting it wrong
 * is silent and only shows up at the first rotation.
 */
export async function reencryptEnvelope(params: ReencryptParams): Promise<SealedEnvelope> {
  const { envelope } = params;
  if (!Number.isSafeInteger(params.nextKeyEpoch) || params.nextKeyEpoch <= envelope.keyEpoch) {
    fail("invalid_input");
  }
  const plaintext = await openEnvelope(params.previousFamilyKey, envelope);
  return sealEnvelope(
    params.nextFamilyKey,
    {
      envelopeVersion: envelope.envelopeVersion,
      kind: envelope.kind,
      familyId: envelope.familyId,
      opId: envelope.opId,
      deviceId: envelope.deviceId,
      keyEpoch: params.nextKeyEpoch,
    },
    plaintext,
  );
}

export interface ReencryptJournalParams {
  /**
   * The journal of the epoch being retired, plus the owner's own outbound queue.
   *
   * The queue belongs in this set and 5.5 is emphatic about it: unsent envelopes of the owner's
   * device are as much a part of the journal as anyone else's, and while `FK'` does not exist yet
   * they are still readable under the old key. The owner never receives `409 epoch_mismatch` — he
   * switched the epoch himself — and a `409` would not clear the queue anyway, so envelopes left
   * behind here would sit under the key of an epoch that no longer exists and would never leave.
   */
  readonly envelopes: readonly SealedEnvelope[];
  readonly previousFamilyKey: CryptoKey;
  readonly previousKeyEpoch: number;
  readonly nextFamilyKey: CryptoKey;
  readonly nextKeyEpoch: number;
}

/**
 * Re-encrypts a whole journal into the new epoch.
 *
 * An envelope of any other epoch is refused rather than carried along: the set being moved is the
 * journal of one epoch, and quietly re-encrypting a stray envelope from another one would import
 * into the new history something the continuity rules never covered. A refusal to decrypt is
 * likewise a refusal here and stops the rotation — 5.5 makes that a decision for the owner, taken
 * by hand: the undecryptable envelope is not carried over and its `seq` goes into `inheritedGaps`
 * of the first checkpoint of the new epoch, so the family sees exactly what was lost. There is no
 * automatic path, and this function offers none.
 */
export async function reencryptJournal(
  params: ReencryptJournalParams,
): Promise<readonly SealedEnvelope[]> {
  if (!Number.isSafeInteger(params.previousKeyEpoch) || params.previousKeyEpoch < FIRST_KEY_EPOCH) {
    fail("invalid_input");
  }
  if (params.nextKeyEpoch <= params.previousKeyEpoch) fail("invalid_input");

  const moved: SealedEnvelope[] = [];
  for (const envelope of params.envelopes) {
    if (envelope.keyEpoch !== params.previousKeyEpoch) fail("epoch_mismatch");
    moved.push(
      await reencryptEnvelope({
        envelope,
        previousFamilyKey: params.previousFamilyKey,
        nextFamilyKey: params.nextFamilyKey,
        nextKeyEpoch: params.nextKeyEpoch,
      }),
    );
  }
  return moved;
}
