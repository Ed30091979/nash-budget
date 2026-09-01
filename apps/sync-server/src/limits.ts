/**
 * The numbers the document fixes, in one place, each next to the section that fixes it.
 *
 * They are values, not policy the code may reinterpret: a limit re-derived at the call site drifts
 * from the document silently, and 3.2.1 is explicit that a limit is only meaningful when both
 * sides agree on the number.
 */

/** 3.2.1: envelopes per epoch. Exceeding it is `409 quota_exhausted`, not a truncation. */
export const FAMILY_ENVELOPE_QUOTA = 100_000;

/** 3.2, last row: envelopes per batch. */
export const MAX_ENVELOPES_PER_BATCH = 200;

/** 3.2, last row: bytes per batch body. */
export const MAX_BATCH_BODY_BYTES = 1024 * 1024;

/**
 * 3.2, first row: `8` KiB of encoded operation, plus the `128`-bit AES-GCM tag that 5.2 carries
 * inside the ciphertext. The plaintext limit is the codec's (phase S1); the server can only see
 * the ciphertext, so it checks the one number it can.
 */
export const MAX_OPERATION_CIPHERTEXT_BYTES = 8 * 1024 + 16;

/**
 * Checkpoints (3.6) have no documented size.
 *
 * Their plaintext is not an operation: `skipped` holds one identifier per envelope the device
 * passed over through quarantine and `inheritedGaps` one number per gap inherited at rotation, so
 * the `8` KiB of 3.2 does not apply and no other figure is written down. The server needs *some*
 * bound — an unbounded envelope is an unbounded write — so this one is chosen here, at `64` KiB,
 * and named as a phase-S3 choice rather than a quotation. It is reported back to the document as a
 * gap; if the document later fixes a number, this constant is where it lands.
 */
export const MAX_CHECKPOINT_CIPHERTEXT_BYTES = 64 * 1024 + 16;

/** 3.4: envelopes returned by one fetch. The client asks for no more than the server allows. */
export const MAX_FETCH_LIMIT = 200;
export const DEFAULT_FETCH_LIMIT = 200;

/** 6.1: one-time login code. */
export const LOGIN_CODE_DIGITS = 6;
export const LOGIN_CODE_TTL_MS = 10 * 60 * 1000;
export const LOGIN_CODE_MAX_ATTEMPTS = 5;
export const LOGIN_CODE_MAX_REQUESTS_PER_HOUR = 3;
export const LOGIN_CODE_REQUEST_WINDOW_MS = 60 * 60 * 1000;

/** 6.1: token pair. Access `15` minutes, refresh `30` days, refresh rotated on every use. */
export const ACCESS_TOKEN_TTL_MS = 15 * 60 * 1000;
export const REFRESH_TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1000;

/** 5.3: invite TTL. The server sets it; a client-supplied expiry would not be a limit at all. */
export const INVITE_TTL_MS = 24 * 60 * 60 * 1000;

/** 5.3: `5` failed invite lookups per `15` minutes and `20` per day, per account and per IP. */
export const INVITE_CLAIM_FAILURES_PER_WINDOW = 5;
export const INVITE_CLAIM_WINDOW_MS = 15 * 60 * 1000;
export const INVITE_CLAIM_FAILURES_PER_DAY = 20;
export const INVITE_CLAIM_DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Submission rate limit, per device (plan, phase S3: "rate limit … на приём операций").
 *
 * The document fixes no figure. `60` batches per minute is far above what the client's polling
 * loop produces (3.4: on start, on focus, after each send, on a timer) and far below what a loop
 * gone wrong produces.
 */
export const ENVELOPE_BATCHES_PER_WINDOW = 60;
export const ENVELOPE_BATCH_WINDOW_MS = 60 * 1000;

/**
 * 5.5: rotation timeouts. Idle first — `30` minutes without an accepted staging batch — and a hard
 * ceiling of `6` hours from `rotationStartedAt` regardless of activity. Both are needed and the
 * document says why: without the ceiling one device trickling an envelope every twenty minutes
 * holds the whole family in "writing closed"; with only the ceiling, a large journal on a slow
 * mobile link never finishes the rotation that a stolen device makes mandatory.
 */
export const ROTATION_IDLE_TIMEOUT_MS = 30 * 60 * 1000;
export const ROTATION_HARD_TIMEOUT_MS = 6 * 60 * 60 * 1000;

/** 5.2 / 5.4: byte lengths the server stores blindly but must still bound. */
export const AES_GCM_IV_BYTES = 12;
export const SHA256_BYTES = 32;
export const HKDF_SALT_BYTES = 32;
/** SPKI of an ECDH P-256 public key is 91 bytes; the bound is loose on purpose. */
export const MAX_SPKI_BYTES = 256;
/** The invite box (5.3) holds a version, a 32-byte key, two identifiers and a fingerprint. */
export const MAX_INVITE_BOX_BYTES = 1024;
/** One wrapped family key (5.4): 32 bytes plus the tag. The bound leaves room for nothing else. */
export const MAX_KEY_WRAP_BYTES = 128;
/** `rotateConfirm` (5.4) is a MAC. */
export const MAX_EPOCH_CONFIRM_BYTES = 128;
/** 3.2: identifiers. */
export const MAX_ID_LENGTH = 128;
/** Long enough for any address, short enough not to be a storage decision. */
export const MAX_EMAIL_LENGTH = 254;
