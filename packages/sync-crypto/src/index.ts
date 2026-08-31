export {
  CROCKFORD_ALPHABET,
  encodeCrockfordBits,
  normalizeCrockford,
  randomCrockford,
} from "./crockford.js";
export {
  computeOwnerAnnounce,
  deviceKeyFingerprint,
  exportDevicePublicKey,
  FINGERPRINT_BITS,
  FINGERPRINT_SYMBOLS,
  formatKeyFingerprint,
  generateDeviceKeyPair,
  importDevicePublicKey,
  unwrapFamilyKey,
  verifyOwnerAnnounce,
  wrapFamilyKey,
  WRAP_SALT_BYTES,
  type KeyWrap,
  type OwnerAnnounceParams,
  type UnwrapFamilyKeyParams,
  type WrapFamilyKeyParams,
} from "./device-key.js";
export {
  decodeEnc,
  decodeEncHead,
  enc,
  equalBytes,
  fromHex,
  fromUtf8,
  toHex,
  utf8,
  type EncodableValue,
} from "./encoding.js";
export {
  ENVELOPE_IV_BYTES,
  ENVELOPE_KINDS,
  ENVELOPE_TAG_BYTES,
  ENVELOPE_VERSION,
  envelopeAad,
  openEnvelope,
  sealEnvelope,
  type EnvelopeHeader,
  type EnvelopeKind,
  type SealedEnvelope,
} from "./envelope.js";
export { SYNC_CRYPTO_ERROR_CODES, SyncCryptoError, type SyncCryptoErrorCode } from "./errors.js";
export {
  exportFamilyKey,
  familyKeyFingerprint,
  FAMILY_KEY_BYTES,
  FIRST_KEY_EPOCH,
  generateFamilyKey,
  importFamilyKey,
} from "./family-key.js";
// `deriveInviteMaster` is deliberately absent. It returns the 96 raw bytes of the Argon2id output,
// and their first third *is* the invite wrapping key — a key this package otherwise imports
// non-extractable and has a test to keep that way. A property like that is only as strong as the
// widest public path to the material, so the widest path is not allowed to be an index export. The
// function stays exported from `./invite.js`, where the argon2 vectors, the invite tests and the
// no-leak sweep reach it directly and no consumer of the package meets it by autocompletion.
export {
  computeBindProof,
  deriveInviteSecrets,
  generateInviteCode,
  INVITE_ARGON2_ITERATIONS,
  INVITE_ARGON2_MEMORY_KIB,
  INVITE_ARGON2_PARALLELISM,
  INVITE_CODE_LENGTH,
  INVITE_MASTER_BYTES,
  INVITE_PAYLOAD_FIELDS,
  INVITE_PAYLOAD_VERSION,
  INVITE_SECRET_BYTES,
  inviteAuthTokenDigest,
  inviteSalt,
  normalizeInviteCode,
  openInvite,
  sealInvite,
  verifyBindProof,
  type BindProofParams,
  type InviteIssuerSecrets,
  type InviteSecrets,
  type InviteSenderRole,
  type InviteWireRecord,
  type OpenedInvite,
  type OpenInviteParams,
  type SealedInvite,
  type SealInviteParams,
} from "./invite.js";
export {
  computeEpochConfirm,
  reencryptEnvelope,
  reencryptJournal,
  verifyEpochConfirm,
  type EpochConfirmParams,
  type ReencryptJournalParams,
  type ReencryptParams,
} from "./rotation.js";
