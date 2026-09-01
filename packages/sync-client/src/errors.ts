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
  /** The engine was asked to do something that needs an account, and there is no account. */
  "not_signed_in",
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
] as const;

export type SyncClientErrorCode = (typeof SYNC_CLIENT_ERROR_CODES)[number];

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
 * `quota_exhausted` at once, and the three ask for three different things. The code is carried
 * through as the server spelled it and matched against the server's enumeration by the caller.
 */
export class SyncServerError extends SyncClientError {
  readonly status: number;
  readonly serverCode: string;
  readonly details: Readonly<Record<string, unknown>>;

  constructor(
    status: number,
    serverCode: string,
    details: Readonly<Record<string, unknown>> = {},
  ) {
    super("server_refused", `sync server refused with ${status} ${serverCode}`);
    this.name = "SyncServerError";
    this.status = status;
    this.serverCode = serverCode;
    this.details = details;
  }
}
