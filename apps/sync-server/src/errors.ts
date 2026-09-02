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
  /**
   * 6.8: the token is good and the act is irreversible, so the token alone is not enough.
   *
   * `401` and not `403`, because the remedy is an act of the caller's own — request a code, enter
   * it, try again — and a client that read `forbidden` here would tell the user they are not
   * allowed to delete their own account. Distinct from `unauthorized` for the same reason: that
   * one means the session is over.
   */
  "reauth_required",
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
  /**
   * The `familyId` offered at creation belongs to some family already.
   *
   * Not `already_in_family`: that one is about the caller, and the answer to it is "you are done,
   * you have a family". This one is about the identifier, and the answer is to generate another
   * one and try again. The two used to share a code, and a client branching on it would have shown
   * one of the two users the other's remedy.
   */
  "family_exists",
  /** The account is in no family, and the route needs one. */
  "no_family",
  /** 3.3 step 2 / 5.5 step 1: an epoch is in `staging`, writing is closed for everyone. */
  "rotation_in_progress",
  /** 3.3 step 3 and 3.4: the epoch named by the caller is not the family's current one. */
  "epoch_mismatch",
  /** 3.2.1: `100 000` envelopes per epoch. */
  "quota_exhausted",
  /**
   * The rotation the caller names cannot be carried further: none is in progress, the attempt is
   * not the one in progress, or its `rotateConfirm` has not been uploaded yet (5.5, 5.4).
   */
  "no_rotation",
  /**
   * The epoch in force carries no `rotationId`, so no out-of-band wrap can cite one (5.5, last
   * part).
   *
   * Nothing to do with a rotation, which is why it is no longer spelled `no_rotation`: a client
   * that read that code here would offer to finish or retry a rotation that was never declared.
   * Every epoch this server creates is given a `rotationId` — the family's first by 6.2, each
   * later one by 5.5 step 1 — so this is a state the code refuses to assume away rather than one
   * a caller can reach.
   */
  "epoch_not_wrappable",
  /** The invite does not exist, has expired, or has already been used. `404`. */
  "invite_invalid",
  /**
   * The `inviteId` offered at creation belongs to an invite already. `409`.
   *
   * The issuing device's remedy is a fresh identifier; the joining device's remedy for
   * `invite_invalid` is a fresh code from the owner. Nothing connects the two, and they shared a
   * code — and, being thrown with two different statuses, could not even be told apart by that.
   */
  "invite_exists",
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
