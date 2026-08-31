/**
 * The envelope — `SYNC_ARCHITECTURE.md` 2.2 and 5.2.
 *
 * AES-GCM with a 256-bit key, a fresh 96-bit random IV per envelope, a 128-bit tag carried inside
 * the ciphertext, and the cleartext header as additional authenticated data. The plaintext is the
 * canonical JSON of one operation or one checkpoint in UTF-8; this package never looks at it and
 * never re-serialises it, because rotation has to move it from one epoch to the next without
 * changing a single byte (5.5) and the merge tiebreaker is computed over that exact text.
 */
import { enc } from "./encoding.js";
import { fail } from "./errors.js";
import {
  AES_GCM_IV_BYTES,
  AES_GCM_TAG_BYTES,
  aesGcmDecrypt,
  aesGcmEncrypt,
  randomBytes,
} from "./webcrypto.js";

/** Format version of the envelope and of the operation inside it. Initial value `1` (2.2). */
export const ENVELOPE_VERSION = 1;
/** 96 bits, random per envelope, never reused (5.2). */
export const ENVELOPE_IV_BYTES = AES_GCM_IV_BYTES;
/** 128 bits, inside the ciphertext (5.2). */
export const ENVELOPE_TAG_BYTES = AES_GCM_TAG_BYTES;

/** Open, in the AAD, and the reason the server can tell checkpoints from operations (3.6). */
export type EnvelopeKind = "operation" | "checkpoint";

export const ENVELOPE_KINDS: readonly EnvelopeKind[] = ["operation", "checkpoint"];

/**
 * The six header fields, and only these six, that are bound into the AAD.
 *
 * All six are known to the recipient before decryption, which is what makes the scheme executable:
 * the server cannot move an envelope into another family, attribute it to another device or
 * declare it a different key epoch without breaking the tag. `seq` and `receivedAt` are not here
 * and cannot be: the server stamps them after the envelope is sealed. The consequence is stated in
 * 2.2 rather than hidden — numbering, ordering and the fact of delivery stay under the server's
 * control, and the client answers that with the `seq` continuity check (3.4) and the journal
 * integrity anchor (3.6), not with cryptography.
 */
export interface EnvelopeHeader {
  readonly envelopeVersion: number;
  readonly kind: EnvelopeKind | string;
  readonly familyId: string;
  readonly opId: string;
  readonly deviceId: string;
  readonly keyEpoch: number;
}

/** A sealed envelope: the header in the clear, plus the IV and the ciphertext-with-tag. */
export interface SealedEnvelope extends EnvelopeHeader {
  readonly iv: Uint8Array;
  readonly ciphertext: Uint8Array;
}

/**
 * `enc(envelopeVersion, kind, familyId, opId, deviceId, keyEpoch)`, in this order (2.2).
 *
 * The order is part of the construction, not a formatting choice: `enc` binds the *sequence*, and
 * two devices that disagree about the order produce two different AADs and stop being able to read
 * each other's envelopes.
 */
export function envelopeAad(header: EnvelopeHeader): Uint8Array {
  return enc(
    header.envelopeVersion,
    header.kind,
    header.familyId,
    header.opId,
    header.deviceId,
    header.keyEpoch,
  );
}

/**
 * Structural check applied when *writing* an envelope, and deliberately not when reading one.
 *
 * On the reading side every one of these fields is already covered by the tag: a header the server
 * altered produces a different AAD and the envelope simply does not open. Re-checking the shape
 * before decryption would be worse than useless — it would turn a forged byte in the header into a
 * distinct, earlier, differently-classified refusal, and 3.4 is explicit that verdicts based on
 * header values may only be reached *after* the tag has verified, precisely so that a server
 * cannot raise "update your application" by flipping one open byte.
 */
function assertWritableHeader(header: EnvelopeHeader): void {
  if (!Number.isSafeInteger(header.envelopeVersion) || header.envelopeVersion < 1) fail("invalid_input");
  if (!Number.isSafeInteger(header.keyEpoch) || header.keyEpoch < 1) fail("invalid_input");
  if (typeof header.kind !== "string" || !ENVELOPE_KINDS.includes(header.kind as EnvelopeKind)) {
    fail("invalid_input");
  }
  for (const id of [header.familyId, header.opId, header.deviceId]) {
    if (typeof id !== "string" || id.length === 0 || id.length > 128) fail("invalid_input");
  }
}

/**
 * Seals one operation or checkpoint.
 *
 * `plaintext` is bytes and stays bytes. The canonical JSON is produced by the protocol codec
 * (phase S1); re-encoding it here would risk changing the text that the merge hashes.
 */
export async function sealEnvelope(
  familyKey: CryptoKey,
  header: EnvelopeHeader,
  plaintext: Uint8Array,
): Promise<SealedEnvelope> {
  assertWritableHeader(header);
  if (!(plaintext instanceof Uint8Array)) fail("invalid_input");
  const iv = randomBytes(ENVELOPE_IV_BYTES);
  const ciphertext = await aesGcmEncrypt(familyKey, iv, plaintext, envelopeAad(header));
  return {
    envelopeVersion: header.envelopeVersion,
    kind: header.kind,
    familyId: header.familyId,
    opId: header.opId,
    deviceId: header.deviceId,
    keyEpoch: header.keyEpoch,
    iv,
    ciphertext,
  };
}

/**
 * Opens an envelope, or refuses.
 *
 * A failed tag check is a refusal and never a warning (5.2), and what the caller does with it is
 * decided by 3.4: for an envelope of the device's own live epoch it is an alarm from the very
 * first one — the cursor stops, and there is no automatic skip, because that is the single loud
 * symptom of an imposed key. This function reports the failure and nothing else; classifying it
 * belongs to the sync engine, which is the only layer that knows which epoch is its own.
 */
export async function openEnvelope(
  familyKey: CryptoKey,
  envelope: SealedEnvelope,
): Promise<Uint8Array> {
  if (envelope.iv.length !== ENVELOPE_IV_BYTES) fail("envelope_open_failed");
  if (envelope.ciphertext.length < ENVELOPE_TAG_BYTES) fail("envelope_open_failed");
  const opened = await aesGcmDecrypt(familyKey, envelope.iv, envelope.ciphertext, envelopeAad(envelope));
  if (opened === undefined) fail("envelope_open_failed");
  return opened;
}
