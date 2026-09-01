/**
 * The token pair of 6.1: an access JWT valid `15` minutes and a refresh token valid `30` days,
 * bound to a `deviceId` and rotated on every use, of which the server keeps only a hash.
 *
 * Both are built here from `node:crypto` rather than from a JWT library. The format used is the
 * smallest subset of JWT that is unambiguous — compact serialisation, `HS256`, three fields — and
 * verification refuses anything else, `alg: "none"` and `alg: "RS256"` included: accepting an
 * algorithm named by the token is the classic way a JWT verifier is turned into a signature oracle.
 */
import { equalBytes, fromBase64Url, hmacSha256, randomBytes, sha256, toBase64Url } from "./bytes.ts";
import { ACCESS_TOKEN_TTL_MS, REFRESH_TOKEN_TTL_MS } from "./limits.ts";

const HEADER = toBase64Url(new TextEncoder().encode(JSON.stringify({ alg: "HS256", typ: "JWT" })));

export interface AccessTokenClaims {
  /** `accountId`. */
  readonly sub: string;
  /** `deviceId`. The token names the device so that revocation (6.7) can act on it at once. */
  readonly did: string;
  /**
   * The device's token serial at the moment of issue.
   *
   * 6.1 has signing out drop the refresh token, and that used to be all it dropped: the access
   * token of a signed-out device stayed good for the rest of its fifteen minutes, while 6.7's
   * revocation acts at the door immediately. The serial closes the gap without a clock — signing
   * out increments the device's serial, and a token that names the previous one is no longer the
   * session it was issued for.
   */
  readonly tsn: number;
  readonly iat: number;
  readonly exp: number;
}

export interface IssuedTokens {
  readonly accessToken: string;
  readonly accessExpiresAt: number;
  readonly refreshToken: string;
  readonly refreshExpiresAt: number;
}

function utf8(value: string): Uint8Array {
  return new TextEncoder().encode(value);
}

export function signAccessToken(
  secret: Uint8Array,
  accountId: string,
  deviceId: string,
  tokenSerial: number,
  now: number,
): { token: string; expiresAt: number } {
  const expiresAt = now + ACCESS_TOKEN_TTL_MS;
  const claims: AccessTokenClaims = {
    sub: accountId,
    did: deviceId,
    tsn: tokenSerial,
    iat: Math.floor(now / 1000),
    exp: Math.floor(expiresAt / 1000),
  };
  const body = `${HEADER}.${toBase64Url(utf8(JSON.stringify(claims)))}`;
  const mac = hmacSha256(secret, utf8(body));
  return { token: `${body}.${toBase64Url(mac)}`, expiresAt };
}

/** Returns the claims, or `null` for every reason a token can be unacceptable. No throwing: the
 * caller answers `401` identically whatever the reason, and distinguishing them on the wire would
 * only tell an attacker which half of the token to work on. */
export function verifyAccessToken(
  secret: Uint8Array,
  token: string,
  now: number,
): AccessTokenClaims | null {
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const [header, payload, signature] = parts;
  if (header === undefined || payload === undefined || signature === undefined) return null;
  if (header !== HEADER) return null;
  const provided = fromBase64Url(signature);
  if (provided === null) return null;
  const expected = hmacSha256(secret, utf8(`${header}.${payload}`));
  if (!equalBytes(provided, expected)) return null;
  const decoded = fromBase64Url(payload);
  if (decoded === null) return null;
  let claims: unknown;
  try {
    claims = JSON.parse(new TextDecoder().decode(decoded));
  } catch {
    return null;
  }
  if (typeof claims !== "object" || claims === null) return null;
  const { sub, did, tsn, iat, exp } = claims as Record<string, unknown>;
  if (typeof sub !== "string" || typeof did !== "string") return null;
  // A token without a serial is not an older token to be tolerated, it is a token this build did
  // not issue: the field is signed like the rest, so the only way to arrive without one is to have
  // been made elsewhere.
  if (typeof tsn !== "number" || !Number.isSafeInteger(tsn)) return null;
  if (typeof iat !== "number" || typeof exp !== "number") return null;
  if (exp * 1000 <= now) return null;
  return { sub, did, tsn, iat, exp };
}

/**
 * A refresh token is `deviceId.secret`.
 *
 * The device is named in the clear so that presentation is a single indexed lookup rather than a
 * scan of every stored hash; the secret is `32` random bytes, and only its SHA-256 is stored, so a
 * copy of the database does not yield a usable token. There is nothing to guess in the `deviceId`
 * half — it is public in every envelope header (2.2).
 */
export function issueRefreshToken(
  deviceId: string,
  now: number,
): { token: string; hash: Uint8Array; expiresAt: number } {
  const secret = randomBytes(32);
  return {
    token: `${deviceId}.${toBase64Url(secret)}`,
    hash: sha256(secret),
    expiresAt: now + REFRESH_TOKEN_TTL_MS,
  };
}

export function parseRefreshToken(token: string): { deviceId: string; secret: Uint8Array } | null {
  const separator = token.indexOf(".");
  if (separator <= 0) return null;
  const deviceId = token.slice(0, separator);
  const secret = fromBase64Url(token.slice(separator + 1));
  if (secret === null || secret.length !== 32) return null;
  return { deviceId, secret };
}
