/**
 * The numbers the document fixes, in one place, each next to the section that fixes it.
 *
 * They are values, not policy the code may reinterpret: a limit re-derived at the call site drifts
 * from the document silently, and 3.2.1 is explicit that a limit is only meaningful when both
 * sides agree on the number.
 */

/** 3.2.1: envelopes per epoch. Exceeding it is `409 quota_exhausted`, not a truncation. */
export const FAMILY_ENVELOPE_QUOTA = 100_000;

/**
 * 2.2, envelope table: `kind` is `operation` or `checkpoint`. Both values, as one closed set.
 *
 * The enumeration is load-bearing rather than descriptive. The size a ciphertext is held to is
 * chosen by `kind` (see `ciphertextLimit` in the journal route), and `kind` is written by the
 * sender, so an open field would let any client name itself into the larger bound — the `8` KiB of
 * 3.2 would then be enforced by nothing but the client's word about itself.
 */
export const ENVELOPE_KINDS = ["operation", "checkpoint"] as const;
export type EnvelopeKind = (typeof ENVELOPE_KINDS)[number];

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

/**
 * The same epoch budget of 3.2.1, counted in bytes as well as in envelopes.
 *
 * The count alone stopped being a budget the moment two sizes existed: `100 000` envelopes at the
 * checkpoint bound is eight times the storage the figure of 3.2.1 stands for, and reaching it costs
 * a client nothing but the word `checkpoint` in a field it writes itself. So the epoch carries the
 * product the document's own numbers imply — `100 000` operations of `8` KiB each — and every
 * envelope is charged its real ciphertext length against it.
 *
 * The alternative was a second, much narrower counter for checkpoints, and it was rejected on the
 * numbers of 3.6: a device writes one after every `200` applied operations, so a full epoch is
 * `500` checkpoints per device rather than the handful one might assume. A counter tight enough to
 * matter would start refusing checkpoints in an honest long-lived epoch — and a refused checkpoint
 * switches off the only defence 3.6 has against a truncated journal. A byte budget refuses nothing
 * until the family has actually spent the storage the document allots it, whatever the mix.
 */
export const FAMILY_EPOCH_CIPHERTEXT_BYTES = FAMILY_ENVELOPE_QUOTA * MAX_OPERATION_CIPHERTEXT_BYTES;

/** 3.4: envelopes returned by one fetch. The client asks for no more than the server allows. */
export const MAX_FETCH_LIMIT = 200;
export const DEFAULT_FETCH_LIMIT = 200;

/** 6.1: one-time login code. */
export const LOGIN_CODE_DIGITS = 6;
export const LOGIN_CODE_TTL_MS = 10 * 60 * 1000;
export const LOGIN_CODE_MAX_ATTEMPTS = 5;
export const LOGIN_CODE_MAX_REQUESTS_PER_HOUR = 3;
export const LOGIN_CODE_REQUEST_WINDOW_MS = 60 * 60 * 1000;
/**
 * The second bucket of the same window, keyed by the source address instead of the e-mail.
 *
 * 6.1 fixes only the per-address figure, and per-address alone is not a limit at all: the address
 * is a field of the request body, so `3` an hour multiplied by every address ever typed is
 * unbounded, and each one leaves a row behind. `30` an hour per source is generous for a household
 * behind one address — several people, several devices, mistyped codes included — and it is a
 * ceiling the sender does not get to choose.
 *
 * What counts as the source is the socket's address: Fastify is built here without `trustProxy`,
 * so a forwarded header cannot move a caller into somebody else's bucket. A deployment that puts a
 * proxy in front has to configure that trust deliberately, and until it does, everything behind the
 * proxy shares one bucket — which is the safe direction for a backstop to fail in.
 */
export const LOGIN_CODE_REQUESTS_PER_SOURCE = 30;

/** 6.1: token pair. Access `15` minutes, refresh `30` days, refresh rotated on every use. */
export const ACCESS_TOKEN_TTL_MS = 15 * 60 * 1000;
export const REFRESH_TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1000;

/** 5.3: invite TTL. The server sets it; a client-supplied expiry would not be a limit at all. */
export const INVITE_TTL_MS = 24 * 60 * 60 * 1000;

/**
 * 5.3: an invite is one code, read out loud to one person, live for `24` hours and spent once.
 * The document never contemplates a second live one, and the server holds the family to it: a new
 * invite supersedes the family's live one rather than joining it.
 *
 * The cap is what keeps the claim lookup from being a list any owner may lengthen at will, and it
 * doubles as the withdrawal 5.3 otherwise lacks — a code read out to the wrong person can be
 * replaced instead of standing for a day.
 */
export const MAX_LIVE_INVITES_PER_FAMILY = 1;

/**
 * Invite creation, per family. The document fixes no figure; `5` an hour is far above a ceremony
 * that requires a person to read twelve characters aloud, and far below a loop.
 */
export const INVITE_CREATES_PER_WINDOW = 5;
export const INVITE_CREATE_WINDOW_MS = 60 * 60 * 1000;

/**
 * Rows the claim lookup may touch. Keyed by the digest, so honest traffic returns exactly one; the
 * bound is here so that the work of a claim is a constant and not a length someone else writes.
 */
export const INVITE_CLAIM_SCAN_ROWS = 8;

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
