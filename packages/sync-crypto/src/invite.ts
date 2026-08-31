/**
 * The invite — `SYNC_ARCHITECTURE.md` 5.3.
 *
 * A twelve-symbol Crockford Base32 code, 60 bits, single use, 24 hours, passed out of band by
 * voice or messenger. The server never sees it. From the code alone both sides derive 96 bytes of
 * Argon2id output and split them into three independent thirds: the key that encrypts the invite
 * box, the token that proves to the server a right to fetch it, and the key that binds the joining
 * device's public key to this invite.
 *
 * Three numbers carry the whole security argument, and none of them may be traded away: 60 bits of
 * entropy, 64 MiB per attempt and a 24-hour TTL. 5.3 works it out — an attacker holding a copy of
 * the box grinds it offline forever, and at a generous 10⁶ attempts per second the full 2⁶⁰ space
 * takes some 36 000 years. Lowering the Argon2id parameters "for slow phones" is the one change
 * that would make that copy cheap to open.
 */
import { argon2id } from "hash-wasm";

import { CROCKFORD_ALPHABET, normalizeCrockford, randomCrockford } from "./crockford.js";
import { decodeEnc, decodeEncHead, enc, equalBytes, fromUtf8, utf8 } from "./encoding.js";
import { fail } from "./errors.js";
import { exportFamilyKey, importFamilyKey } from "./family-key.js";
import { deviceKeyFingerprint } from "./device-key.js";
import {
  AES_GCM_IV_BYTES,
  aesGcmDecrypt,
  aesGcmEncrypt,
  hmacSha256,
  importAesKey,
  randomBytes,
  sha256,
} from "./webcrypto.js";

const INVITE_LABEL = "nash-budget/invite/v1";
/**
 * The box was the one construction of the scheme whose bound data carried a bare `"invite"` while
 * every neighbour carried `nash-budget/<purpose>/v1`. 5.3 brings it into line: a labelled purpose
 * is what keeps a value bound in one context from being replayed in another, and a version in the
 * label is what lets the box format change later without either side having to guess which of the
 * two it is holding.
 */
const INVITE_BOX_LABEL = "nash-budget/invite-box/v1";
const BIND_LABEL = "nash-budget/bind/v1";

/** Twelve symbols, exactly 5 bits each, exactly 60 bits (5.3). */
export const INVITE_CODE_LENGTH = 12;
/** Argon2id parameters, fixed by 5.3 and not negotiable per device. */
export const INVITE_ARGON2_ITERATIONS = 3;
export const INVITE_ARGON2_MEMORY_KIB = 64 * 1024;
export const INVITE_ARGON2_PARALLELISM = 1;
/** 96 bytes: three independent 32-byte thirds. */
export const INVITE_MASTER_BYTES = 96;
export const INVITE_SECRET_BYTES = 32;

/**
 * Format version of the invite payload, its first field. Initial value `1` (5.3).
 *
 * The envelope has carried a version since 2.2, read before decryption; the invite payload had
 * none, and its field count was pinned by the parser, so a sixth field added tomorrow would have
 * been announced by today's reader as a malformed payload — which the user reads as "wrong code".
 * A version field cannot be added later by the very trick it exists to make possible, which is why
 * it goes in now, while there is still exactly one version of it.
 */
export const INVITE_PAYLOAD_VERSION = 1;
/** How many fields version 1 of the payload has: the version itself and the five that follow. */
export const INVITE_PAYLOAD_FIELDS = 6;

/** Self-declared in the box, and useless on its own — see {@link openInvite}. */
export type InviteSenderRole = "owner" | "member";

/** A fresh invite code, uniform over the 32-symbol alphabet. */
export function generateInviteCode(): string {
  return randomCrockford(INVITE_CODE_LENGTH, randomBytes);
}

/**
 * Canonical form of a code as a human typed it: upper case, separators dropped, `I`/`L` read as
 * `1` and `O` as `0`, and exactly twelve symbols afterwards.
 *
 * The document does not spell this step out, and it has to exist: the code is not decoded to bytes
 * before use, it *is* the Argon2id password and the input of the salt, so both devices must agree
 * on the exact string. Canonicalising is what makes a code read out over the phone and a code
 * typed in on the other end the same secret. Anything outside the alphabet — a `U`, a letter that
 * is not there, a code of the wrong length — is a refusal, never a repair.
 */
export function normalizeInviteCode(code: string): string {
  const normalized = normalizeCrockford(code);
  if (normalized.length !== INVITE_CODE_LENGTH) fail("invalid_input");
  for (const symbol of normalized) if (!CROCKFORD_ALPHABET.includes(symbol)) fail("invalid_input");
  return normalized;
}

/**
 * `salt = SHA-256(enc("nash-budget/invite/v1", UTF8(code)))`.
 *
 * A salt derived from the secret itself is a departure from ordinary practice, and 5.3 justifies it
 * precisely rather than generally. A salt has two jobs. Separating users who chose the same
 * password is unreachable *and unnecessary* here: the code is uniform over 60 bits and single use,
 * so two codes colliding has probability around 2⁻⁶⁰. Making precomputed tables pointless is
 * achieved not by keeping the salt secret but by the cost of the table: precomputing `master` for
 * the whole code space is 2⁶⁰ Argon2id runs at 64 MiB and roughly 37 exabytes to store the wrapping
 * keys alone — dearer than the brute force it was meant to accelerate. In exchange the joining
 * device computes `authToken` and `bindKey` *before* its first request, so the server never has to
 * tell it the salt, or anything else about the code.
 */
export async function inviteSalt(code: string): Promise<Uint8Array> {
  return sha256(enc(INVITE_LABEL, utf8(normalizeInviteCode(code))));
}

/**
 * The raw 96-byte Argon2id output.
 *
 * WebCrypto has no Argon2id, so this is the one primitive in the package that comes from a
 * dependency. 5.3 pins it: the package `hash-wasm`, an exact version with no range, locked in
 * `pnpm-lock.yaml` with an integrity check. WASM rather than a native build, because one and the
 * same implementation has to run in the browser, in the Capacitor shell and in Node under test.
 * The known-answer vectors in `tests/argon2.test.ts` are part of that pinning: bumping the version
 * without re-running them is what the requirement forbids.
 *
 * Every parameter of the derivation is written out here, the empty `secret` included. 5.3 has no
 * keyed pepper — there is no server-side secret the joining device could hold, and inventing one
 * would put the invite behind a value the family does not control — but "no pepper" has to be a
 * line of this file rather than a default of `hash-wasm`. Left out, the byte string that Argon2id
 * actually consumes would be chosen by the dependency, and the next version of it, or the next
 * library, is entitled to choose differently; the vectors would then move under a bump that looked
 * like nothing.
 */
export async function deriveInviteMaster(code: string): Promise<Uint8Array> {
  const normalized = normalizeInviteCode(code);
  return argon2id({
    password: utf8(normalized),
    salt: await inviteSalt(normalized),
    secret: new Uint8Array(0),
    iterations: INVITE_ARGON2_ITERATIONS,
    parallelism: INVITE_ARGON2_PARALLELISM,
    memorySize: INVITE_ARGON2_MEMORY_KIB,
    hashLength: INVITE_MASTER_BYTES,
    outputType: "binary",
  });
}

/**
 * The three thirds of 5.3.
 *
 * No third is derived from another: Argon2id is a KDF, its output is indistinguishable from
 * random, and knowing `authToken` — which the server does, in hashed form — yields neither `KEK`
 * nor `bindKey`. That is what lets the server gate the delivery of the box without ever being able
 * to open it.
 */
export interface InviteSecrets {
  /** `master[0..32)` — encrypts the invite box. */
  readonly wrappingKey: CryptoKey;
  /** `master[32..64)` — proves to the server a right to fetch the box. */
  readonly authToken: Uint8Array;
  /** `master[64..96)` — binds the joining device's public key to this invite (5.4). */
  readonly bindKey: Uint8Array;
}

export async function deriveInviteSecrets(code: string): Promise<InviteSecrets> {
  const master = await deriveInviteMaster(code);
  if (master.length !== INVITE_MASTER_BYTES) fail("invalid_input");
  return {
    wrappingKey: await importAesKey(master.subarray(0, 32), false),
    authToken: master.slice(32, 64),
    bindKey: master.slice(64, 96),
  };
}

/** What the server stores in place of the token, compared in constant time on presentation (5.3). */
export async function inviteAuthTokenDigest(authToken: Uint8Array): Promise<Uint8Array> {
  return sha256(authToken);
}

/** The invite box AAD: `enc("nash-budget/invite-box/v1", familyId, keyEpoch, inviteId)`. */
function inviteBoxAad(params: {
  readonly familyId: string;
  readonly keyEpoch: number;
  readonly inviteId: string;
}): Uint8Array {
  return enc(INVITE_BOX_LABEL, params.familyId, params.keyEpoch, params.inviteId);
}

export interface SealInviteParams {
  readonly code: string;
  readonly familyId: string;
  readonly keyEpoch: number;
  readonly inviteId: string;
  readonly familyKey: CryptoKey;
  readonly senderDeviceId: string;
  readonly senderSpki: Uint8Array;
  readonly senderRole: InviteSenderRole;
  readonly senderMemberId: string;
}

/**
 * The invite row the server stores, whole — 5.3 lists it field by field: `inviteId`, `familyId`,
 * `keyEpoch`, `SHA-256(authToken)`, `iv`, `inviteBox`. Every field here is meant to be handed over,
 * so serialising the record entire is the intended act rather than an accident. `expiresAt` and
 * `usedAt` from the same list are the server's own lifecycle columns, carry no key material and are
 * not this package's business.
 */
export interface InviteWireRecord {
  readonly familyId: string;
  readonly keyEpoch: number;
  readonly inviteId: string;
  readonly iv: Uint8Array;
  readonly ciphertext: Uint8Array;
  /** `SHA-256(authToken)` — what the server keeps in place of the token, and all it may keep. */
  readonly authTokenDigest: Uint8Array;
}

/**
 * The two thirds that stay on the issuing device.
 *
 * They live in their own record, not beside the wire fields, because the distinction is not one
 * the call site can be trusted to remember. 5.3 allows the server the *hash* of the token and
 * never the token itself; `bindKey` it may not hold in any form at all — with `bindKey` it forges
 * the joining device's `bindProof` and the automatic half of two-way key authentication (5.4)
 * falls over. In one mixed object a single `JSON.stringify` on the server-facing path gives away
 * both. Split apart, handing them over is something one has to write out on purpose.
 */
export interface InviteIssuerSecrets {
  /** Travels out of band with the code; the server is told only `SHA-256(authToken)`. */
  readonly authToken: Uint8Array;
  /**
   * Kept by the owner's device for the life of the invite so that it can check the joining
   * device's `bindProof` (5.4). If it is lost — the app reinstalled before the invitee joins —
   * the automatic check is impossible and only the two-way manual comparison remains.
   */
  readonly bindKey: Uint8Array;
}

/** Sealing yields two things at once: the record to send, and the secrets to keep away from it. */
export interface SealedInvite {
  readonly record: InviteWireRecord;
  readonly issuerSecrets: InviteIssuerSecrets;
}

/**
 * Seals the invite box.
 *
 * The box carries more than the family key. Its first field is `inviteVersion`, and after it,
 * under the same `KEK`, travel `deviceIdA`, the
 * **fingerprint of the sender's device key** and the sender's role and `memberId`. This is the
 * first pin in the reverse direction: the invitee learns the owner's genuine key from the code
 * rather than from a server response, and its authenticity rests on the same knowledge of the code
 * as the family key itself. The server cannot substitute the box — it is under AES-GCM on a key it
 * does not have.
 *
 * The result comes apart along the line 5.3 draws: `record` is what the server is given, digest of
 * the token included, and `issuerSecrets` is what the issuing device keeps until the invite dies.
 */
export async function sealInvite(params: SealInviteParams): Promise<SealedInvite> {
  const secrets = await deriveInviteSecrets(params.code);
  const plain = enc(
    INVITE_PAYLOAD_VERSION,
    await exportFamilyKey(params.familyKey),
    params.senderDeviceId,
    await deviceKeyFingerprint(params.senderSpki),
    params.senderRole,
    params.senderMemberId,
  );
  const iv = randomBytes(AES_GCM_IV_BYTES);
  const ciphertext = await aesGcmEncrypt(secrets.wrappingKey, iv, plain, inviteBoxAad(params));
  return {
    record: {
      familyId: params.familyId,
      keyEpoch: params.keyEpoch,
      inviteId: params.inviteId,
      iv,
      ciphertext,
      authTokenDigest: await inviteAuthTokenDigest(secrets.authToken),
    },
    issuerSecrets: { authToken: secrets.authToken, bindKey: secrets.bindKey },
  };
}

/** What a joining device learns from a code, and pins. */
export interface OpenedInvite {
  readonly familyKey: CryptoKey;
  readonly senderDeviceId: string;
  /** `SHA-256(SPKI_A)`, pinned locally from here on (5.3). */
  readonly senderKeyFingerprint: Uint8Array;
  readonly senderRole: InviteSenderRole;
  readonly senderMemberId: string;
  /** Needed to compute `bindProof` for the join request. */
  readonly bindKey: Uint8Array;
  readonly authToken: Uint8Array;
}

export interface OpenInviteParams {
  readonly code: string;
  readonly familyId: string;
  readonly keyEpoch: number;
  readonly inviteId: string;
  readonly iv: Uint8Array;
  readonly ciphertext: Uint8Array;
}

/**
 * The payload's first field, read before anything else in it is looked at.
 *
 * Order is the whole point. The version is decoded on its own, without asserting how many fields
 * the payload holds, so that a payload written by a later version of the scheme — which will hold
 * a different number of fields — is refused *as a newer payload* rather than as a malformed one.
 * A version that is not a plain decimal integer is a different matter: nothing ever wrote that, so
 * it is a broken payload and says so.
 */
function readInvitePayloadVersion(payload: Uint8Array): number {
  const head = decodeEncHead(payload);
  let text: string;
  try {
    text = fromUtf8(head);
  } catch {
    return fail("invite_payload_invalid");
  }
  if (!/^(?:0|[1-9][0-9]*)$/u.test(text)) fail("invite_payload_invalid");
  const version = Number(text);
  if (!Number.isSafeInteger(version)) fail("invite_payload_invalid");
  return version;
}

/**
 * Opens the invite box, or refuses.
 *
 * Success means the code was right, and yields both `FK` and the pinned owner key at once.
 *
 * The payload's version is read first, before the rest of it is parsed (5.3), and a version this
 * build does not know is refused by its own name rather than as a malformed payload — otherwise
 * an invite issued by a newer app would reach the user as "wrong code", and a code he typed
 * correctly would have no explanation.
 *
 * The role inside the box is checked here and the whole invite is refused when it is not `owner` — the
 * second of the two independent checks 5.3 requires, the first being the server refusing to let a
 * `member` create an invite at all.
 *
 * The role in the box is **self-declared**, and this check alone proves nothing: whoever assembles
 * the box writes the role, so an ordinary member can write `owner` as easily as the owner can. It
 * has meaning only as one half of a cross-check — the caller must take `senderMemberId` from here
 * and compare it against the role in the server's member list. Agreed: accept. Diverged: refuse.
 * Neither source deserves trust alone, because the box is written by the inviter and the list is
 * kept by the server. What this closes is a lone member acting by himself; what it does not close
 * is a member **colluding with the server**, and 5.3 says so rather than implying otherwise. That
 * comparison needs the member list, so it lives in the sync engine, not here.
 */
export async function openInvite(params: OpenInviteParams): Promise<OpenedInvite> {
  const secrets = await deriveInviteSecrets(params.code);
  const opened = await aesGcmDecrypt(
    secrets.wrappingKey,
    params.iv,
    params.ciphertext,
    inviteBoxAad(params),
  );
  if (opened === undefined) fail("invite_open_failed");

  // The version, before the rest of the payload is parsed at all (5.3). Reversing these two steps
  // would defeat the field entirely: the strict field count below would reject a newer payload as
  // malformed before its version was ever looked at, and the user would be told, in effect, that
  // he mistyped a code he typed correctly.
  const version = readInvitePayloadVersion(opened);
  if (version !== INVITE_PAYLOAD_VERSION) fail("invite_version_unsupported");

  const [, rawKey, senderDeviceId, senderKeyFingerprint, senderRole, senderMemberId] = decodeEnc(
    opened,
    INVITE_PAYLOAD_FIELDS,
  );
  if (
    rawKey === undefined ||
    senderDeviceId === undefined ||
    senderKeyFingerprint === undefined ||
    senderRole === undefined ||
    senderMemberId === undefined
  ) {
    fail("invite_payload_invalid");
  }
  if (senderKeyFingerprint.length !== 32) fail("invite_payload_invalid");

  const role = fromUtf8(senderRole);
  if (role !== "owner") fail("invite_sender_not_owner");

  let familyKey: CryptoKey;
  try {
    familyKey = await importFamilyKey(rawKey);
  } catch {
    return fail("invite_payload_invalid");
  }

  return {
    familyKey,
    senderDeviceId: fromUtf8(senderDeviceId),
    senderKeyFingerprint: senderKeyFingerprint.slice(),
    senderRole: role,
    senderMemberId: fromUtf8(senderMemberId),
    bindKey: secrets.bindKey,
    authToken: secrets.authToken,
  };
}

export interface BindProofParams {
  readonly familyId: string;
  readonly inviteId: string;
  /** The joining device. */
  readonly deviceId: string;
  /** The joining device's SPKI, exactly as it is sent to the server. */
  readonly spki: Uint8Array;
}

/**
 * `bindProof = HMAC-SHA-256(bindKey, enc("nash-budget/bind/v1", familyId, inviteId, deviceId, SPKI))`
 * — the automatic half of binding, in the direction "device → owner" (5.4).
 *
 * Only whoever knows the invite code knows `bindKey`. The server never sees the code and cannot
 * forge the proof; substituting the SPKI breaks the HMAC, and so does substituting the `deviceId`.
 * Substituting the `inviteId` gains nothing either — the owner recomputes on *his* value and the
 * check does not agree.
 */
export async function computeBindProof(
  bindKey: Uint8Array,
  params: BindProofParams,
): Promise<Uint8Array> {
  if (!(bindKey instanceof Uint8Array) || bindKey.length !== INVITE_SECRET_BYTES) fail("invalid_input");
  return hmacSha256(
    bindKey,
    enc(BIND_LABEL, params.familyId, params.inviteId, params.deviceId, params.spki),
  );
}

/** The owner's side of the same check, in constant time. */
export async function verifyBindProof(
  bindKey: Uint8Array,
  params: BindProofParams,
  proof: Uint8Array,
): Promise<boolean> {
  if (!(proof instanceof Uint8Array)) fail("invalid_input");
  return equalBytes(await computeBindProof(bindKey, params), proof);
}
