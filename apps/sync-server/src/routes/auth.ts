/**
 * Registration and sign-in — 6.1.
 *
 * E-mail plus a six-digit one-time code, then an access/refresh pair. Three properties of the
 * document are load-bearing here and each is visible in the code below:
 *
 *  - the answer to a code request does not depend on whether the account exists, so this endpoint
 *    cannot be used to enumerate addresses;
 *  - the code is stored as HMAC-SHA-256 under a server secret rather than as a plain hash, because
 *    a space of `10^6` values is a lookup table, not a search;
 *  - the code never reaches the log. It leaves the process only through the configured sink, which
 *    stands in for the mail transport that phase S3 does not ship.
 */
import type { FastifyInstance } from "fastify";

import { equalBytes, hmacSha256, randomBytes } from "../bytes.ts";
import type { ServerContext } from "../context.ts";
import { ApiError, unauthorized } from "../errors.ts";
import {
  LOGIN_CODE_MAX_ATTEMPTS,
  LOGIN_CODE_MAX_REQUESTS_PER_HOUR,
  LOGIN_CODE_REQUESTS_PER_SOURCE,
  LOGIN_CODE_REQUEST_WINDOW_MS,
  LOGIN_CODE_TTL_MS,
  MAX_SPKI_BYTES,
} from "../limits.ts";
import { issueRefreshToken, signAccessToken } from "../tokens.ts";
import { base64Field, body, emailField, loginCodeField, uuidField } from "./fields.ts";
import { decodeBytes } from "./decode.ts";

interface LoginCodeRow {
  readonly email: string;
  readonly code_mac: Uint8Array;
  readonly expires_at: number;
  readonly attempts: number;
}

interface DeviceRow {
  readonly device_id: string;
  readonly account_id: string;
  readonly public_key: Uint8Array;
  readonly revoked_at: number | null;
}

function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

/** Uniform over `000000 … 999999`: rejection sampling, not `% 1_000_000` on a 32-bit draw. */
function generateLoginCode(): string {
  for (;;) {
    const bytes = randomBytes(4);
    const value =
      ((bytes[0] ?? 0) << 24) | ((bytes[1] ?? 0) << 16) | ((bytes[2] ?? 0) << 8) | (bytes[3] ?? 0);
    const unsigned = value >>> 0;
    if (unsigned >= 4_294_000_000) continue;
    return String(unsigned % 1_000_000).padStart(6, "0");
  }
}

function codeMac(secret: Uint8Array, email: string, code: string): Uint8Array {
  return hmacSha256(secret, new TextEncoder().encode(`nash-budget/login-code/v1|${email}|${code}`));
}

export function issueTokenPair(
  context: ServerContext,
  accountId: string,
  deviceId: string,
): Record<string, unknown> {
  const now = context.now();
  const serial = context.db
    .prepare("SELECT token_serial FROM device WHERE device_id = ?")
    .get(deviceId) as { token_serial: number } | undefined;
  const access = signAccessToken(
    context.config.tokenSecret,
    accountId,
    deviceId,
    serial?.token_serial ?? 0,
    now,
  );
  const refresh = issueRefreshToken(deviceId, now);
  context.db
    .prepare("UPDATE device SET refresh_token_hash = ?, refresh_expires_at = ? WHERE device_id = ?")
    .run(refresh.hash, refresh.expiresAt, deviceId);
  return {
    accountId,
    deviceId,
    accessToken: access.token,
    accessExpiresAt: access.expiresAt,
    refreshToken: refresh.token,
    refreshExpiresAt: refresh.expiresAt,
  };
}

/** The bucket of 6.1's per-address limit. One name, used by the limiter and by the reset alike. */
function emailBucket(email: string): string {
  return `login-code:email:${email}`;
}

export function registerAuthRoutes(app: FastifyInstance, context: ServerContext): void {
  /**
   * 6.1: a code lives `10` minutes. Until this sweep the row outlived it by however long it took
   * someone to try the code — and nobody ever tries a code they did not receive, so a row written
   * for an address that never answers stayed for good. The table is written by an unauthenticated
   * request, which makes "stays for good" the whole of the problem.
   */
  const sweepLoginCodes = (): void => {
    context.db.prepare("DELETE FROM login_code WHERE expires_at <= ?").run(context.now());
  };

  app.post(
    "/v1/auth/code",
    { schema: { body: body({ email: emailField }, ["email"]) } },
    async (request, reply) => {
      const { email: raw } = request.body as { email: string };
      const email = normalizeEmail(raw);
      const bucket = emailBucket(email);
      // The second bucket is the point of this pair. 6.1 fixes `3` an hour per address, and the
      // address is a field of the body: `3` an hour multiplied by every address anyone cares to
      // type is not a limit, and each one used to leave a row behind. The source of the request is
      // the one dimension the sender does not choose, so it carries a ceiling of its own.
      const sourceBucket = `login-code:source:${request.ip}`;
      context.throttleSweep("login-code:", LOGIN_CODE_REQUEST_WINDOW_MS);
      sweepLoginCodes();
      if (
        context.throttleCount(bucket, LOGIN_CODE_REQUEST_WINDOW_MS) >=
        LOGIN_CODE_MAX_REQUESTS_PER_HOUR
      ) {
        throw new ApiError(429, "rate_limited", "too many code requests for this address");
      }
      if (
        context.throttleCount(sourceBucket, LOGIN_CODE_REQUEST_WINDOW_MS) >=
        LOGIN_CODE_REQUESTS_PER_SOURCE
      ) {
        // Deliberately the same words as the line above: which of the two counters was reached is
        // not something the sender is told, and 6.1 already requires this endpoint to answer
        // identically whatever it knows about the address.
        throw new ApiError(429, "rate_limited", "too many code requests for this address");
      }
      context.throttleRecord(bucket);
      context.throttleRecord(sourceBucket);
      const code = generateLoginCode();
      context.db
        .prepare(
          "INSERT INTO login_code (email, code_mac, expires_at, attempts) VALUES (?, ?, ?, 0)" +
            " ON CONFLICT (email) DO UPDATE SET code_mac = excluded.code_mac," +
            " expires_at = excluded.expires_at, attempts = 0",
        )
        .run(email, codeMac(context.config.tokenSecret, email, code), context.now() + LOGIN_CODE_TTL_MS);
      context.config.deliverLoginCode(email, code);
      // Always the same answer, for every address, existing or not.
      return reply.code(202).send({ status: "sent" });
    },
  );

  app.post(
    "/v1/auth/verify",
    {
      schema: {
        body: body(
          {
            email: emailField,
            code: loginCodeField,
            deviceId: uuidField,
            publicKey: base64Field(MAX_SPKI_BYTES, 1),
          },
          ["email", "code", "deviceId", "publicKey"],
        ),
      },
    },
    async (request) => {
      const input = request.body as {
        email: string;
        code: string;
        deviceId: string;
        publicKey: string;
      };
      const email = normalizeEmail(input.email);
      const publicKey = decodeBytes(input.publicKey, "publicKey");
      const row = context.db
        .prepare("SELECT * FROM login_code WHERE email = ?")
        .get(email) as LoginCodeRow | undefined;
      const invalidCode = new ApiError(400, "login_code_invalid", "the code is not valid");
      if (row === undefined) throw invalidCode;
      if (row.expires_at <= context.now() || row.attempts >= LOGIN_CODE_MAX_ATTEMPTS) {
        context.db.prepare("DELETE FROM login_code WHERE email = ?").run(email);
        throw invalidCode;
      }
      const expected = codeMac(context.config.tokenSecret, email, input.code);
      if (!equalBytes(new Uint8Array(row.code_mac), expected)) {
        context.db.prepare("UPDATE login_code SET attempts = attempts + 1 WHERE email = ?").run(email);
        throw invalidCode;
      }
      context.db.prepare("DELETE FROM login_code WHERE email = ?").run(email);
      // Only the address's own counter. The per-source ceiling is not the sender's to reset — a
      // successful sign-in from one address would otherwise clear the count of every other.
      context.throttleClear(emailBucket(email));

      const now = context.now();
      const account = context.db
        .prepare("SELECT account_id FROM account WHERE email = ?")
        .get(email) as { account_id: string } | undefined;
      const accountId = account?.account_id ?? crypto.randomUUID();
      if (account === undefined) {
        context.db
          .prepare("INSERT INTO account (account_id, email, created_at) VALUES (?, ?, ?)")
          .run(accountId, email, now);
      }

      const device = context.db
        .prepare("SELECT device_id, account_id, public_key, revoked_at FROM device WHERE device_id = ?")
        .get(input.deviceId) as DeviceRow | undefined;
      if (device === undefined) {
        context.db
          .prepare(
            "INSERT INTO device (device_id, account_id, public_key, created_at, last_seen_at)" +
              " VALUES (?, ?, ?, ?, ?)",
          )
          .run(input.deviceId, accountId, publicKey, now, now);
      } else {
        if (device.revoked_at !== null) {
          throw new ApiError(401, "device_revoked", "this device has been revoked");
        }
        // 5.4: the device key is generated once, at registration, and a reinstall produces a new
        // `deviceId`. A second key under an existing identifier is therefore either a mistake or a
        // substitution, and both are refused rather than overwritten — silently replacing it would
        // hand the family a new public key over an authenticated channel with no ceremony at all.
        if (
          device.account_id !== accountId ||
          !equalBytes(new Uint8Array(device.public_key), publicKey)
        ) {
          throw new ApiError(
            409,
            "device_key_conflict",
            "this device identifier is registered with a different account or key",
          );
        }
        context.db.prepare("UPDATE device SET last_seen_at = ? WHERE device_id = ?").run(now, input.deviceId);
      }
      return issueTokenPair(context, accountId, input.deviceId);
    },
  );

  app.post(
    "/v1/auth/refresh",
    {
      schema: {
        body: body({ refreshToken: { type: "string", minLength: 1, maxLength: 256 } }, [
          "refreshToken",
        ]),
      },
    },
    async (request) => {
      const { refreshToken } = request.body as { refreshToken: string };
      const device = context.resolveRefreshToken(refreshToken);
      if (device === null) throw unauthorized("invalid or expired refresh token");
      // 6.1: rotated on every use. The previous hash is overwritten inside `issueTokenPair`, so a
      // replay of the token just presented fails against the new hash.
      return issueTokenPair(context, device.account_id, device.device_id);
    },
  );

  app.post("/v1/auth/logout", async (request) => {
    const auth = context.authenticate(request);
    // 6.6/6.7 keep "revoke" for the destructive act; signing out is not destructive — the device
    // can sign in again with a fresh code and still holds the family key it had. What it must be
    // is *immediate*: the serial is incremented alongside the refresh token, so every access token
    // already issued to this device stops being accepted at the door. Dropping only the refresh
    // token left the session alive for up to the fifteen minutes of 6.1, which is a strange thing
    // for a server to do one route away from a revocation that acts at once.
    context.db
      .prepare(
        "UPDATE device SET refresh_token_hash = NULL, refresh_expires_at = NULL," +
          " token_serial = token_serial + 1 WHERE device_id = ?",
      )
      .run(auth.deviceId);
    return { status: "signed_out" };
  });
}
