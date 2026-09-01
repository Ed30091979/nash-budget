/**
 * Everything the routes share: the database, the clock, authentication, family lookup, the
 * rotation sweep and the rate limiters.
 *
 * It is one object passed to the route registrars rather than a set of Fastify decorators, because
 * the checks below are ordinary functions with ordinary return types and the compiler can then see
 * that a handler asked for a membership before using one.
 */
import type { FastifyRequest } from "fastify";

import { equalBytes, sha256 } from "./bytes.ts";
import type { SyncServerConfig } from "./config.ts";
import type { Db } from "./db.ts";
import { ApiError, forbidden, unauthorized } from "./errors.ts";
import { ROTATION_HARD_TIMEOUT_MS, ROTATION_IDLE_TIMEOUT_MS } from "./limits.ts";
import { parseRefreshToken, verifyAccessToken } from "./tokens.ts";

export interface AuthContext {
  readonly accountId: string;
  readonly deviceId: string;
}

export type MemberRole = "owner" | "member";

export interface Membership {
  readonly familyId: string;
  readonly memberId: string;
  readonly role: MemberRole;
  /** The epoch in force (2.2). Server to client: the client never has to tell the server its own. */
  readonly keyEpoch: number;
  readonly maxKeyEpoch: number;
  readonly ownerMemberId: string;
}

export interface EpochRow {
  readonly family_id: string;
  readonly key_epoch: number;
  readonly seq_counter: number;
  /** 3.2.1 in bytes: the ciphertext the epoch already holds. Maintained with the insertion. */
  readonly ciphertext_bytes: number;
  readonly state: "staging" | "active" | "retired";
  readonly rotation_id: string | null;
  readonly rotating_device_id: string | null;
  readonly rotation_started_at: number | null;
  readonly last_progress_at: number | null;
  readonly freeze_seq: number | null;
}

interface DeviceRow {
  readonly device_id: string;
  readonly account_id: string;
  readonly revoked_at: number | null;
  readonly token_serial: number;
  readonly refresh_token_hash: Uint8Array | null;
  readonly refresh_expires_at: number | null;
}

export class ServerContext {
  readonly db: Db;
  readonly config: SyncServerConfig;

  constructor(db: Db, config: SyncServerConfig) {
    this.db = db;
    this.config = config;
  }

  now(): number {
    return this.config.now();
  }

  /**
   * Resolves the caller from the `Authorization` header.
   *
   * A revoked device fails here and not later (6.7): the document says the server stops accepting
   * envelopes from it and stops serving it the journal, so the refusal belongs at the door. It is
   * answered with `401` — the same status a missing token gets — because 6.7 has the revoked
   * device notice a `401` and drop to local-only mode.
   */
  authenticate(request: FastifyRequest): AuthContext {
    const header = request.headers.authorization;
    if (typeof header !== "string" || !header.startsWith("Bearer ")) throw unauthorized();
    const claims = verifyAccessToken(this.config.tokenSecret, header.slice(7), this.now());
    if (claims === null) throw unauthorized("invalid or expired access token");
    const device = this.db
      .prepare("SELECT device_id, account_id, revoked_at, token_serial FROM device WHERE device_id = ?")
      .get(claims.did) as DeviceRow | undefined;
    if (device === undefined || device.account_id !== claims.sub) throw unauthorized();
    if (device.revoked_at !== null) {
      throw new ApiError(401, "device_revoked", "this device has been revoked");
    }
    // 6.1: signing out ends the session, and the access token is half of one. Without this
    // comparison "signed out" meant "signed out in a quarter of an hour", which is not what the
    // word says and not what 6.7 does one line above for a revoked device.
    if (device.token_serial !== claims.tsn) throw unauthorized("this session has been ended");
    this.db
      .prepare("UPDATE device SET last_seen_at = ? WHERE device_id = ?")
      .run(this.now(), device.device_id);
    return { accountId: claims.sub, deviceId: device.device_id };
  }

  /** Presented refresh token to device, or `null`. Constant-time on the secret half. */
  resolveRefreshToken(token: string): DeviceRow | null {
    const parsed = parseRefreshToken(token);
    if (parsed === null) return null;
    const device = this.db
      .prepare(
        "SELECT device_id, account_id, revoked_at, token_serial, refresh_token_hash," +
          " refresh_expires_at FROM device WHERE device_id = ?",
      )
      .get(parsed.deviceId) as DeviceRow | undefined;
    if (device === undefined || device.revoked_at !== null) return null;
    if (device.refresh_token_hash === null || device.refresh_expires_at === null) return null;
    if (device.refresh_expires_at <= this.now()) return null;
    if (!equalBytes(sha256(parsed.secret), new Uint8Array(device.refresh_token_hash))) return null;
    return device;
  }

  /** The caller's live membership. Being in no family is a refusal, not an empty answer. */
  requireMembership(auth: AuthContext): Membership {
    const row = this.db
      .prepare(
        "SELECT m.family_id, m.member_id, m.role, f.key_epoch, f.max_key_epoch, f.owner_member_id" +
          " FROM member m JOIN family f ON f.family_id = m.family_id" +
          " WHERE m.account_id = ? AND m.removed_at IS NULL",
      )
      .get(auth.accountId) as
      | {
          family_id: string;
          member_id: string;
          role: MemberRole;
          key_epoch: number;
          max_key_epoch: number;
          owner_member_id: string;
        }
      | undefined;
    if (row === undefined) {
      throw new ApiError(403, "no_family", "this account is not a member of any family");
    }
    this.sweepRotations(row.family_id);
    const family = this.db
      .prepare("SELECT key_epoch, max_key_epoch FROM family WHERE family_id = ?")
      .get(row.family_id) as { key_epoch: number; max_key_epoch: number };
    return {
      familyId: row.family_id,
      memberId: row.member_id,
      role: row.role,
      keyEpoch: family.key_epoch,
      maxKeyEpoch: family.max_key_epoch,
      ownerMemberId: row.owner_member_id,
    };
  }

  /**
   * Membership *in the family named by the URL*.
   *
   * Family-scoped routes carry the identifier rather than the word "me", so that asking for
   * another family's journal is a request the server can refuse rather than a request it silently
   * reinterprets as one's own. The refusal is `403`: the caller is authenticated, and what they
   * are not is entitled. 7.1 lists this — "авторизация доступа к семье" — as one of the points
   * that rest on the server alone and are checked by nothing cryptographic.
   */
  requireFamily(auth: AuthContext, familyId: string): Membership {
    const membership = this.requireMembership(auth);
    if (membership.familyId !== familyId) {
      throw forbidden("forbidden", "this account is not a member of that family");
    }
    return membership;
  }

  /**
   * 5.3 and 5.5 step 1, the two places where the document makes the role check a requirement on
   * this phase by name: only the owner issues an invite, only the owner declares a rotation. The
   * second one is not decoration — without it any member's device closes writing for the whole
   * family for up to six hours with one command.
   */
  requireOwner(membership: Membership): Membership {
    if (membership.role !== "owner") {
      throw forbidden("owner_required", "only the family owner may perform this operation");
    }
    return membership;
  }

  activeEpoch(familyId: string, keyEpoch: number): EpochRow | undefined {
    return this.db
      .prepare("SELECT * FROM epoch WHERE family_id = ? AND key_epoch = ?")
      .get(familyId, keyEpoch) as EpochRow | undefined;
  }

  stagingEpoch(familyId: string): EpochRow | undefined {
    return this.db
      .prepare("SELECT * FROM epoch WHERE family_id = ? AND state = 'staging'")
      .get(familyId) as EpochRow | undefined;
  }

  /**
   * 5.5: an unfinished rotation must not hang the family, and a running one must not be cut off.
   *
   * Idleness first — no accepted staging batch for `30` minutes — and a hard ceiling of `6` hours
   * from the start regardless of activity. The sweep runs on every family-scoped request rather
   * than on a timer: a timer would make the timeout depend on process uptime, and a server
   * restarted every ten minutes would never cancel anything.
   */
  sweepRotations(familyId: string): void {
    const staging = this.stagingEpoch(familyId);
    if (staging === undefined) return;
    const now = this.now();
    const idleSince = staging.last_progress_at ?? staging.rotation_started_at ?? now;
    const startedAt = staging.rotation_started_at ?? now;
    const idle = now - idleSince >= ROTATION_IDLE_TIMEOUT_MS;
    const overdue = now - startedAt >= ROTATION_HARD_TIMEOUT_MS;
    if (idle || overdue) this.cancelRotation(familyId, staging.key_epoch);
  }

  /**
   * 5.5: cancelling deletes the epoch row together with its counter, its wraps and its
   * confirmation. The *number* is not released — `family.max_key_epoch` keeps it burnt — because a
   * retry that reused it would let the server hand one device the consistent set of the cancelled
   * attempt and another the consistent set of the successful one, splitting the family across two
   * keys of one epoch with no symptom at all (5.4).
   */
  cancelRotation(familyId: string, keyEpoch: number): void {
    const run = this.db.transaction(() => {
      this.db
        .prepare("DELETE FROM envelope WHERE family_id = ? AND key_epoch = ?")
        .run(familyId, keyEpoch);
      this.db
        .prepare("DELETE FROM key_wrap WHERE family_id = ? AND key_epoch = ?")
        .run(familyId, keyEpoch);
      this.db
        .prepare("DELETE FROM epoch_confirm WHERE family_id = ? AND key_epoch = ?")
        .run(familyId, keyEpoch);
      this.db
        .prepare("DELETE FROM epoch WHERE family_id = ? AND key_epoch = ? AND state = 'staging'")
        .run(familyId, keyEpoch);
    });
    run();
  }

  /**
   * Fixed-window counting over a table of events.
   *
   * Not a token bucket and not in memory: the limits of 5.3 and 6.1 are per address and per
   * account and have to survive a restart, or a process bounce would reset the invite brute-force
   * counter — which is the one counter that guards a `60`-bit secret.
   */
  throttleCount(bucket: string, windowMs: number): number {
    const since = this.now() - windowMs;
    const row = this.db
      .prepare("SELECT COUNT(*) AS n FROM throttle WHERE bucket = ? AND at > ?")
      .get(bucket, since) as { n: number };
    return row.n;
  }

  throttleRecord(bucket: string): void {
    this.db.prepare("INSERT INTO throttle (bucket, at) VALUES (?, ?)").run(bucket, this.now());
  }

  throttleClear(bucket: string): void {
    this.db.prepare("DELETE FROM throttle WHERE bucket = ?").run(bucket);
  }

  /**
   * Drops rows no window can still see, so the table does not grow without bound.
   *
   * Scoped to one family of buckets by prefix, and that is not tidiness. The windows differ by
   * three orders of magnitude — a minute for envelope batches, an hour for login codes, a day for
   * invite lookups — so a sweep that deleted every row older than the *caller's* window would let
   * the shortest window erase the longest one's counter. Concretely: one envelope batch would wipe
   * the invite-lookup counter of 5.3, the counter that stands between a copied invite box and a
   * `60`-bit code, and it would do it from an ordinary authenticated request. `substr` rather than
   * `LIKE` because `_` is a wildcard there and a bucket prefix is not a pattern.
   */
  throttleSweep(bucketPrefix: string, windowMs: number): void {
    this.db
      .prepare("DELETE FROM throttle WHERE substr(bucket, 1, ?) = ? AND at <= ?")
      .run(bucketPrefix.length, bucketPrefix, this.now() - windowMs);
  }
}
