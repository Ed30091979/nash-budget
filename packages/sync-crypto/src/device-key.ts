/**
 * The device key and the wrap that carries the family key to it — `SYNC_ARCHITECTURE.md` 5.4.
 *
 * Authentication here has to be **two-way**, and 5.4 shows what a one-way scheme buys: a server
 * that generates its own pair `(privM, pubM)` and an arbitrary `FK*`, announces a new epoch, hands
 * device `B` a wrap it made with `privM` for the genuine `pubB`, and presents `pubM` as the
 * owner's key. Every input of the derivation is available to it, `B` unwraps `FK*`, re-encrypts its
 * outbound queue under it, and from then on everything decrypts, `seq` stays continuous and the
 * checkpoints agree with each other — while the server reads the family in the clear. So the
 * **sender's** key is pinned exactly as strictly as the recipient's, and the fingerprint of the
 * delivered SPKI is compared against the pin *before* it is used for anything.
 */
import { enc, equalBytes } from "./encoding.js";
import { encodeCrockfordBits } from "./crockford.js";
import { fail } from "./errors.js";
import { importFamilyKey } from "./family-key.js";
import {
  aesGcmDecrypt,
  aesGcmEncrypt,
  AES_GCM_IV_BYTES,
  ecdhSharedSecret,
  exportAesKey,
  exportSpki,
  generateEcdhKeyPair,
  hkdfSha256,
  hmacSha256,
  importAesKey,
  importSpki,
  randomBytes,
  sha256,
} from "./webcrypto.js";

const ROTATE_LABEL = "nash-budget/rotate/v1";
const OWNER_ANNOUNCE_LABEL = "nash-budget/owner-announce/v1";

/** 32 random bytes per wrap, and never a fixed value — see {@link wrapFamilyKey}. */
export const WRAP_SALT_BYTES = 32;
/** Bits of `SHA-256(SPKI)` shown to a human on the comparison screen (5.4). */
export const FINGERPRINT_BITS = 100;
/** `100 / 5` Crockford symbols, displayed as five groups of four. */
export const FINGERPRINT_SYMBOLS = FINGERPRINT_BITS / 5;
const FINGERPRINT_GROUP = 4;

/**
 * A device key pair: ECDH P-256, private half non-extractable.
 *
 * The pair exists for one purpose — delivering the family key to this device, at rotation and when
 * a wrap of the current epoch is issued (5.5). It never signs an operation: authorship in this
 * protocol is attribution, not proof, and signing operations is listed in section 1 as a deferred
 * hardening rather than something this phase pretends to have.
 */
export async function generateDeviceKeyPair(): Promise<CryptoKeyPair> {
  return generateEcdhKeyPair();
}

/** SPKI is the only wire format for a device public key (2.2). */
export async function exportDevicePublicKey(publicKey: CryptoKey): Promise<Uint8Array> {
  return exportSpki(publicKey);
}

export async function importDevicePublicKey(spki: Uint8Array): Promise<CryptoKey> {
  return importSpki(spki);
}

/** `SHA-256(SPKI)`: the value that is pinned locally and compared in constant time (5.4). */
export async function deviceKeyFingerprint(spki: Uint8Array): Promise<Uint8Array> {
  if (!(spki instanceof Uint8Array) || spki.length === 0) fail("invalid_input");
  return sha256(spki);
}

/**
 * The fingerprint as a human reads it aloud: the first 100 bits in Crockford Base32, twenty
 * symbols in five groups of four.
 *
 * The length is not a comfort decision. A 40-bit fingerprint is something a server can *reach* by
 * generating its own key pairs until one collides — a search of about a trillion, which is hours of
 * commodity hardware — and the comparison over the voice channel would then confirm a substituted
 * key. 100 bits puts that search out of reach, and five groups of four is what makes twenty symbols
 * something two people can actually read to each other without losing their place.
 */
export function formatKeyFingerprint(fingerprint: Uint8Array): string {
  if (!(fingerprint instanceof Uint8Array) || fingerprint.length * 8 < FINGERPRINT_BITS) {
    fail("invalid_input");
  }
  const symbols = encodeCrockfordBits(fingerprint, FINGERPRINT_BITS);
  const groups: string[] = [];
  for (let index = 0; index < symbols.length; index += FINGERPRINT_GROUP) {
    groups.push(symbols.slice(index, index + FINGERPRINT_GROUP));
  }
  return groups.join("-");
}

/**
 * One wrapped family key, as the server stores it: `(familyId, keyEpoch, deviceId)` plus the
 * sender, the rotation attempt, the salt, the IV and the ciphertext (2.2). The server holds all of
 * it as opaque bytes and can check none of it.
 */
export interface KeyWrap {
  readonly familyId: string;
  readonly keyEpoch: number;
  readonly rotationId: string;
  readonly senderDeviceId: string;
  readonly recipientDeviceId: string;
  readonly salt: Uint8Array;
  readonly iv: Uint8Array;
  readonly ciphertext: Uint8Array;
}

interface WrapContext {
  readonly familyId: string;
  readonly keyEpoch: number;
  readonly rotationId: string;
  readonly senderDeviceId: string;
  readonly recipientDeviceId: string;
  readonly senderFingerprint: Uint8Array;
  readonly recipientFingerprint: Uint8Array;
  readonly salt: Uint8Array;
}

function wrapInfo(context: WrapContext): Uint8Array {
  return enc(
    ROTATE_LABEL,
    context.familyId,
    context.keyEpoch,
    context.rotationId,
    context.senderDeviceId,
    context.recipientDeviceId,
    context.senderFingerprint,
    context.recipientFingerprint,
  );
}

function wrapAad(context: WrapContext): Uint8Array {
  return enc(context.familyId, context.keyEpoch, context.rotationId, context.recipientDeviceId);
}

async function deriveWrapKey(
  privateKey: CryptoKey,
  publicKey: CryptoKey,
  context: WrapContext,
): Promise<CryptoKey> {
  const shared = await ecdhSharedSecret(privateKey, publicKey);
  const raw = await hkdfSha256(shared, context.salt, wrapInfo(context));
  // Non-extractable: this key exists for one wrap, and nothing ever needs its bytes again.
  return importAesKey(raw, false);
}

export interface WrapFamilyKeyParams {
  /** The key being delivered: `FK'` during rotation, or `FK` when a device is issued the live one. */
  readonly familyKey: CryptoKey;
  readonly senderPrivateKey: CryptoKey;
  readonly senderSpki: Uint8Array;
  readonly senderDeviceId: string;
  readonly recipientSpki: Uint8Array;
  readonly recipientDeviceId: string;
  readonly familyId: string;
  readonly keyEpoch: number;
  /**
   * The rotation attempt, a UUID v4 **generated by the owner's device** and never by the server.
   *
   * Without it an aborted attempt and the successful one that follows carry the same epoch number,
   * and a server may hand one device the wrap and confirmation of the first and another device
   * those of the second: both keys are genuine, both were made by the owner, both pass every
   * check, and the family splits into two halves on two keys of one epoch with no symptom at all.
   * Letting the *server* mint the identifier would not help — it could simply issue the same one
   * twice. Generated on the owner's device it also cannot be substituted, because it is bound into
   * both the HKDF `info` and the AAD.
   */
  readonly rotationId: string;
}

/**
 * Makes the wrap of 5.4 for one recipient device.
 *
 * The salt and the IV are fresh random values for every wrap, and both are stored beside it. The
 * case they close is real: a rotation is interrupted (5.5), the epoch has not changed, the owner
 * starts over and derives a wrap for the same pair of devices with the same `keyEpoch'`. A pair of
 * static ECDH keys yields always the same shared secret, so without a random salt the wrapping key
 * would repeat — and a repeated IV under a repeated AES-GCM key destroys both the confidentiality
 * and the integrity of the mode.
 */
export async function wrapFamilyKey(params: WrapFamilyKeyParams): Promise<KeyWrap> {
  const context: WrapContext = {
    familyId: params.familyId,
    keyEpoch: params.keyEpoch,
    rotationId: params.rotationId,
    senderDeviceId: params.senderDeviceId,
    recipientDeviceId: params.recipientDeviceId,
    senderFingerprint: await deviceKeyFingerprint(params.senderSpki),
    recipientFingerprint: await deviceKeyFingerprint(params.recipientSpki),
    salt: randomBytes(WRAP_SALT_BYTES),
  };

  const wrappingKey = await deriveWrapKey(
    params.senderPrivateKey,
    await importDevicePublicKey(params.recipientSpki),
    context,
  );
  const iv = randomBytes(AES_GCM_IV_BYTES);
  const ciphertext = await aesGcmEncrypt(
    wrappingKey,
    iv,
    await exportAesKey(params.familyKey),
    wrapAad(context),
  );

  return {
    familyId: context.familyId,
    keyEpoch: context.keyEpoch,
    rotationId: context.rotationId,
    senderDeviceId: context.senderDeviceId,
    recipientDeviceId: context.recipientDeviceId,
    salt: context.salt,
    iv,
    ciphertext,
  };
}

export interface UnwrapFamilyKeyParams {
  readonly wrap: KeyWrap;
  readonly recipientPrivateKey: CryptoKey;
  readonly recipientSpki: Uint8Array;
  /** The sender's SPKI exactly as the server delivered it — untrusted until it hashes to the pin. */
  readonly senderSpki: Uint8Array;
  /** `SHA-256(SPKI)` of the sender, pinned locally by an invite (5.3) or by a comparison (5.4). */
  readonly pinnedSenderFingerprint: Uint8Array;
}

/**
 * Opens a wrap, in the order 5.4 prescribes and no other.
 *
 * Take the SPKI the server sent, hash it, compare in constant time with the pinned fingerprint,
 * refuse on any difference — and only on a match go on to ECDH and the derivation. The wording
 * "derive on the pinned key" would be unimplementable and 5.4 says so: what is pinned is the
 * *fingerprint*, the full SPKI still arrives from the server, and that is exactly why the hash
 * comparison has to come before any use of the delivered value.
 *
 * What this function does **not** decide is whether the new epoch may be accepted. That is 5.4.1,
 * it belongs to the sync engine, and it has two paths and no third: a chain of confirmations from
 * an epoch whose key the device already holds, or a comparison ceremony the *user* started. A wrap
 * that opens is material, not authority.
 */
export async function unwrapFamilyKey(params: UnwrapFamilyKeyParams): Promise<CryptoKey> {
  const delivered = await deviceKeyFingerprint(params.senderSpki);
  if (!equalBytes(delivered, params.pinnedSenderFingerprint)) fail("sender_key_mismatch");

  const { wrap } = params;
  const context: WrapContext = {
    familyId: wrap.familyId,
    keyEpoch: wrap.keyEpoch,
    rotationId: wrap.rotationId,
    senderDeviceId: wrap.senderDeviceId,
    recipientDeviceId: wrap.recipientDeviceId,
    senderFingerprint: delivered,
    recipientFingerprint: await deviceKeyFingerprint(params.recipientSpki),
    salt: wrap.salt,
  };

  const wrappingKey = await deriveWrapKey(
    params.recipientPrivateKey,
    await importDevicePublicKey(params.senderSpki),
    context,
  );
  const opened = await aesGcmDecrypt(wrappingKey, wrap.iv, wrap.ciphertext, wrapAad(context));
  if (opened === undefined) fail("key_wrap_open_failed");
  return importFamilyKey(opened);
}

export interface OwnerAnnounceParams {
  readonly familyId: string;
  readonly keyEpoch: number;
  readonly senderDeviceId: string;
  readonly recipientDeviceId: string;
  /** The owner's next device, the one being announced as the successor. */
  readonly successorDeviceId: string;
  readonly successorSpki: Uint8Array;
}

async function deriveAnnounceKey(
  privateKey: CryptoKey,
  publicKey: CryptoKey,
  params: OwnerAnnounceParams,
  senderFingerprint: Uint8Array,
  recipientFingerprint: Uint8Array,
): Promise<Uint8Array> {
  const shared = await ecdhSharedSecret(privateKey, publicKey);
  const info = enc(
    OWNER_ANNOUNCE_LABEL,
    params.familyId,
    params.keyEpoch,
    params.senderDeviceId,
    params.recipientDeviceId,
    senderFingerprint,
    recipientFingerprint,
  );
  return hkdfSha256(shared, new Uint8Array(0), info);
}

async function announceMessage(params: OwnerAnnounceParams): Promise<Uint8Array> {
  return enc(
    params.familyId,
    params.keyEpoch,
    params.successorDeviceId,
    await deviceKeyFingerprint(params.successorSpki),
  );
}

/**
 * The owner's successor announcement of 5.4.1, so that one person's phone and tablet do not force
 * a voice comparison at every rotation.
 *
 * It deliberately is **not** authenticated with the family key. Every device in the family holds
 * that key, including a stolen one that has not been revoked yet, so any of them could silently
 * name whatever it liked as the owner's key — and the cure for a theft would be switched off by
 * the theft itself. Worse, after a forged announcement the family would reject the *real* owner as
 * "the key changed", breaking the one rotation that has to work. So the announcement is bound to
 * the shared secret of the pinned owner device `A` and the recipient `B`, which neither the server
 * nor any other device in the family has.
 *
 * Two rules live above this function, in the sync engine: a verified announcement never replaces a
 * pin silently — it moves the pin to "re-pinning required" and shows both values, old and proposed,
 * each labelled with where it came from — and two announcements for one epoch are a refusal and an
 * alarm, never a choice of the larger, the later or the first.
 */
export async function computeOwnerAnnounce(
  params: OwnerAnnounceParams & {
    readonly senderPrivateKey: CryptoKey;
    readonly senderSpki: Uint8Array;
    readonly recipientSpki: Uint8Array;
  },
): Promise<Uint8Array> {
  const announceKey = await deriveAnnounceKey(
    params.senderPrivateKey,
    await importDevicePublicKey(params.recipientSpki),
    params,
    await deviceKeyFingerprint(params.senderSpki),
    await deviceKeyFingerprint(params.recipientSpki),
  );
  return hmacSha256(announceKey, await announceMessage(params));
}

/**
 * Verifies an announcement against the **pinned** fingerprint of the owner's current device, in the
 * order of 5.4: hash the delivered SPKI, compare with the pin, and only then derive.
 */
export async function verifyOwnerAnnounce(
  params: OwnerAnnounceParams & {
    readonly recipientPrivateKey: CryptoKey;
    readonly recipientSpki: Uint8Array;
    readonly senderSpki: Uint8Array;
    readonly pinnedSenderFingerprint: Uint8Array;
    readonly announce: Uint8Array;
  },
): Promise<boolean> {
  const delivered = await deviceKeyFingerprint(params.senderSpki);
  if (!equalBytes(delivered, params.pinnedSenderFingerprint)) fail("sender_key_mismatch");

  const announceKey = await deriveAnnounceKey(
    params.recipientPrivateKey,
    await importDevicePublicKey(params.senderSpki),
    params,
    delivered,
    await deviceKeyFingerprint(params.recipientSpki),
  );
  const expected = await hmacSha256(announceKey, await announceMessage(params));
  return equalBytes(expected, params.announce);
}
