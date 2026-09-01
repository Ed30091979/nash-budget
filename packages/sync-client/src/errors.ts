/**
 * Refusals of the sync client, as one closed set.
 *
 * The set is closed for the same reason the server's is: every one of these codes is a branch a
 * user interface has to render differently — «журнал неполон» is a retry, «ключ семьи не
 * совпадает» is an alarm that stops the cursor for good — and a code spelled differently in two
 * places is a screen that never appears.
 *
 * None of them carries text written by a peer. An operation is authored by whichever device sent
 * it, so a message built around a value out of one would put a hundred and twenty-eight
 * characters of somebody else's prose on this family's screen.
 */
export const SYNC_CLIENT_ERROR_CODES = [
  /** The stored sync record is not the shape this version writes. */
  "corrupt_sync_state",
  /** The transport could not reach the server, or answered with something that is not JSON. */
  "transport_failed",
  /** The server refused. The refusal's own code travels in {@link SyncServerError.serverCode}. */
  "server_refused",
  /** A response passed the status check and then failed to parse against the contract of S3. */
  "malformed_response",
  /** A local write lost its compare-and-set more times than the engine retries. */
  "write_conflict",
  /**
   * The sync state on disk and the key this engine holds name different epochs, in the one
   * direction that is never a rotation: the record is *ahead* of the engine, or it is the same
   * number carrying another key.
   *
   * A separate branch from every other code here, and deliberately not the alarm: an epoch moving
   * forward is the ordinary rotation of 5.5 step 8 and resets the cursor, while an epoch this
   * device has already passed is a step down 5.4.1 forbids outright. Reporting either as
   * «ключ семьи не совпадает» would spend the one loud signal the system has on a state error.
   */
  "epoch_conflict",
] as const;

export type SyncClientErrorCode = (typeof SYNC_CLIENT_ERROR_CODES)[number];

/**
 * The server's own closed set, mirrored — `apps/sync-server/src/errors.ts`.
 *
 * A refusal arrives as bytes the server wrote, and `code` is a string of its choosing until this
 * list has seen it. Everything the client branches on is decided here: a code that is not one of
 * these becomes `internal`, so a server cannot smuggle a hundred and twenty-eight characters of
 * its own prose into a message this family reads by spelling them into the `code` field. The
 * mirror is checked against the server's own source by `tests/transport.test.ts`.
 */
export const SYNC_SERVER_ERROR_CODES = [
  "unauthorized",
  "device_revoked",
  "forbidden",
  "owner_required",
  "not_found",
  "invalid_request",
  "batch_too_large",
  "rate_limited",
  "already_in_family",
  "family_exists",
  "no_family",
  "rotation_in_progress",
  "epoch_mismatch",
  "quota_exhausted",
  "no_rotation",
  "epoch_not_wrappable",
  "invite_invalid",
  "invite_exists",
  "wrap_exists",
  "device_key_conflict",
  "login_code_invalid",
  "non_json_response",
  "internal",
] as const;

export type SyncServerErrorCode = (typeof SYNC_SERVER_ERROR_CODES)[number];

/** The code the server spelled, if this build knows it, and `internal` otherwise. */
export function toServerErrorCode(value: unknown): SyncServerErrorCode {
  return typeof value === "string" &&
    (SYNC_SERVER_ERROR_CODES as readonly string[]).includes(value)
    ? (value as SyncServerErrorCode)
    : "internal";
}

/**
 * The machine-readable fields a refusal may carry, as a white list.
 *
 * Every one of them is a number a route of `apps/sync-server` puts beside a code — the epoch in
 * force beside `epoch_mismatch`, the staging epoch beside `rotation_in_progress`, the two quota
 * ceilings beside `quota_exhausted`. Nothing else survives the crossing: a response is free to
 * carry any field it likes, and a field kept "as it came" is a value some part of the client will
 * eventually render.
 */
export const SYNC_SERVER_ERROR_DETAILS = [
  "keyEpoch",
  "stagingKeyEpoch",
  "quota",
  "quotaBytes",
] as const;

export function toServerErrorDetails(value: unknown): Readonly<Record<string, number>> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return {};
  const source = value as Record<string, unknown>;
  const details: Record<string, number> = {};
  for (const field of SYNC_SERVER_ERROR_DETAILS) {
    const candidate = source[field];
    // Numbers only, and only safe ones: these are compared and displayed as counts, and a string
    // in the epoch field is a piece of a server's prose arriving under a name the client trusts.
    if (typeof candidate === "number" && Number.isSafeInteger(candidate)) details[field] = candidate;
  }
  return details;
}

export class SyncClientError extends Error {
  readonly code: SyncClientErrorCode;

  constructor(code: SyncClientErrorCode, message: string) {
    super(message);
    this.name = "SyncClientError";
    this.code = code;
  }
}

/**
 * A refusal the server issued, with its own code preserved.
 *
 * The status alone is not enough to act on: `409` is `rotation_in_progress`, `epoch_mismatch` and
 * `quota_exhausted` at once, and the three ask for three different things. So the code is kept —
 * but it is matched against {@link SYNC_SERVER_ERROR_CODES} on the way in rather than on the way
 * out, because the message built from it is text and the field it is built from is written by the
 * other side. A code this build does not know becomes `internal`, and the details are reduced to
 * the numbers of {@link SYNC_SERVER_ERROR_DETAILS}: the promise at the top of this file — that no
 * prose of a peer reaches this family's screen — is only kept if it holds for the code as well as
 * for the message.
 */
export class SyncServerError extends SyncClientError {
  readonly status: number;
  readonly serverCode: SyncServerErrorCode;
  readonly details: Readonly<Record<string, number>>;

  constructor(status: number, serverCode: unknown, details: unknown = {}) {
    const code = toServerErrorCode(serverCode);
    super("server_refused", `sync server refused with ${status} ${code}`);
    this.name = "SyncServerError";
    this.status = status;
    this.serverCode = code;
    this.details = toServerErrorDetails(details);
  }
}
