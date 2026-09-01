/**
 * Refusals of the sync server, as one closed set.
 *
 * Every failure the client can provoke leaves here as `{ error: { code, message, ... } }` and
 * never as a stack trace or a database message. Two reasons, both from the document: the server
 * must not leak envelope content into responses or logs (plan, phase S3), and three of these codes
 * — `rotation_in_progress`, `epoch_mismatch`, `quota_exhausted` — are named by
 * `SYNC_ARCHITECTURE.md` itself (3.3, 3.4, 3.2.1) and the client keys behaviour off them. A code
 * spelled differently on the wire is a protocol break, so they live in one enumeration the
 * compiler forces to stay complete rather than in string literals scattered over the routes.
 */
export const API_ERROR_CODES = [
  /** Missing, malformed or expired access token. */
  "unauthorized",
  /** The device presenting the token has been revoked (6.7); it also gets `401`. */
  "device_revoked",
  /** Authenticated, but not entitled: another family, or a member where the owner is required. */
  "forbidden",
  /** 5.3 and 5.5 step 1: only the owner issues invites and declares rotation. */
  "owner_required",
  /** No such route, or no such object the caller may see. */
  "not_found",
  /** Body or query failed the schema: shape, size, or an unknown property. */
  "invalid_request",
  /** A wire limit of 3.2 was exceeded: envelopes per batch, bytes per envelope, bytes per body. */
  "batch_too_large",
  /** Rate limits of 5.3 and 6.1, and the submission limit of phase S3. */
  "rate_limited",
  /** The account is already in a family; 2.1 allows at most one. */
  "already_in_family",
  /** The account is in no family, and the route needs one. */
  "no_family",
  /** 3.3 step 2 / 5.5 step 1: an epoch is in `staging`, writing is closed for everyone. */
  "rotation_in_progress",
  /** 3.3 step 3 and 3.4: the epoch named by the caller is not the family's current one. */
  "epoch_mismatch",
  /** 3.2.1: `100 000` envelopes per epoch. */
  "quota_exhausted",
  /** No `staging` epoch to advance, complete or cancel. */
  "no_rotation",
  /** The invite does not exist, has expired, or has already been used. */
  "invite_invalid",
  /** A wrap for this device and epoch already exists (5.5, last part). */
  "wrap_exists",
  /** The `deviceId` is known but registered with a different public key. */
  "device_key_conflict",
  /** The one-time login code did not verify, or its attempts ran out (6.1). */
  "login_code_invalid",
  /** Guard of 1.1: a handler tried to answer with something other than `application/json`. */
  "non_json_response",
  /** Anything unforeseen. The cause is logged without a body; the client is told nothing else. */
  "internal",
] as const;

export type ApiErrorCode = (typeof API_ERROR_CODES)[number];

/** Extra machine-readable fields a refusal may carry, e.g. `keyEpoch` beside `epoch_mismatch`. */
export type ApiErrorDetails = Readonly<Record<string, number | string>>;

export class ApiError extends Error {
  readonly statusCode: number;
  readonly code: ApiErrorCode;
  readonly details: ApiErrorDetails;

  constructor(
    statusCode: number,
    code: ApiErrorCode,
    message: string,
    details: ApiErrorDetails = {},
  ) {
    super(message);
    this.name = "ApiError";
    this.statusCode = statusCode;
    this.code = code;
    this.details = details;
  }
}

export function unauthorized(message = "authentication required"): ApiError {
  return new ApiError(401, "unauthorized", message);
}

export function forbidden(
  code: Extract<ApiErrorCode, "forbidden" | "owner_required">,
  message: string,
): ApiError {
  return new ApiError(403, code, message);
}

export function notFound(message = "not found"): ApiError {
  return new ApiError(404, "not_found", message);
}

export function invalid(message: string): ApiError {
  return new ApiError(400, "invalid_request", message);
}

export function conflict(
  code: ApiErrorCode,
  message: string,
  details: ApiErrorDetails = {},
): ApiError {
  return new ApiError(409, code, message, details);
}
