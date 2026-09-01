/**
 * Invites — 5.3, 6.3 and 6.4.
 *
 * This is the route where what the server is *allowed to hold* is at its narrowest, so the body it
 * accepts is not written by hand. `sync-crypto` splits the result of sealing an invite into two
 * records on purpose: {@link InviteWireRecord}, every field of which is meant to be handed over,
 * and `InviteIssuerSecrets`, which holds `authToken` and `bindKey` and never leaves the issuing
 * device. That split is the whole protection, and the comment in that package says why — in one
 * mixed object a single `JSON.stringify` on the server-facing path gives both away.
 *
 * So this file imports the wire record as a type, derives the accepted field set from it, and lets
 * the compiler fail if the record ever grows a field the schema does not name. `InviteIssuerSecrets`
 * is not imported here at all, and with `additionalProperties: false` a body that carries
 * `authToken` beside the record is refused rather than quietly stripped.
 */
import type { FastifyInstance } from "fastify";

import type { InviteWireRecord } from "@family-budget/sync-crypto";

import { equalBytes, sha256, toBase64 } from "../bytes.ts";
import type { ServerContext } from "../context.ts";
import { ApiError, invalid, notFound } from "../errors.ts";
import {
  AES_GCM_IV_BYTES,
  INVITE_CLAIM_DAY_MS,
  INVITE_CLAIM_FAILURES_PER_DAY,
  INVITE_CLAIM_FAILURES_PER_WINDOW,
  INVITE_CLAIM_WINDOW_MS,
  INVITE_CREATES_PER_WINDOW,
  INVITE_CREATE_WINDOW_MS,
  INVITE_TTL_MS,
  MAX_INVITE_BOX_BYTES,
  MAX_LIVE_INVITES_PER_FAMILY,
  SHA256_BYTES,
} from "../limits.ts";
import { decodeBytes } from "./decode.ts";
import { base64Field, body, epochField, identifierField, uuidField } from "./fields.ts";

/**
 * The wire record as it travels in JSON: byte fields base64, everything else unchanged.
 *
 * Written as a mapped type over `InviteWireRecord` rather than as a fresh interface, so that a
 * field added to the record in `sync-crypto` appears here without anyone remembering to add it.
 */
type InviteWireBody = {
  [K in keyof InviteWireRecord]: InviteWireRecord[K] extends Uint8Array
    ? string
    : InviteWireRecord[K];
};

/**
 * Compile-time completeness. If `InviteWireRecord` gains or loses a field, this object stops
 * type-checking and the schema below has to be updated deliberately — which is the only way a
 * change to what the server stores can happen without someone deciding to make it.
 */
const INVITE_WIRE_FIELDS: Readonly<Record<keyof InviteWireRecord, true>> = {
  familyId: true,
  keyEpoch: true,
  inviteId: true,
  iv: true,
  ciphertext: true,
  authTokenDigest: true,
};

interface InviteRow {
  readonly invite_id: string;
  readonly family_id: string;
  readonly key_epoch: number;
  readonly auth_token_digest: Uint8Array;
  readonly iv: Uint8Array;
  readonly ciphertext: Uint8Array | null;
  readonly expires_at: number;
  readonly used_at: number | null;
}

export function registerInviteRoutes(app: FastifyInstance, context: ServerContext): void {
  /**
   * 5.3: the box is deleted on use and on expiry. Expiry has no event, so it is swept.
   *
   * The row goes with the box, and that is the difference from the first version of this function.
   * Emptying the ciphertext left a row per invite ever issued, for ever, and those rows were what
   * every claim in the system had to walk. Nothing needs them: a claim requires a live box, a join
   * requires an unexpired invite, and what 5.4 keeps for the owner's HMAC — the `bindProof` and
   * the `inviteId` — lives on the device row, not here.
   */
  const sweepExpiredInvites = (): void => {
    context.db.prepare("DELETE FROM invite WHERE expires_at <= ?").run(context.now());
  };

  app.post(
    "/v1/families/:familyId/invites",
    {
      schema: {
        params: body({ familyId: uuidField }, ["familyId"]),
        body: body(
          {
            familyId: uuidField,
            keyEpoch: epochField,
            inviteId: uuidField,
            iv: base64Field(AES_GCM_IV_BYTES, AES_GCM_IV_BYTES),
            ciphertext: base64Field(MAX_INVITE_BOX_BYTES, 1),
            authTokenDigest: base64Field(SHA256_BYTES, SHA256_BYTES),
          },
          Object.keys(INVITE_WIRE_FIELDS),
        ),
      },
    },
    async (request, reply) => {
      const auth = context.authenticate(request);
      const { familyId } = request.params as { familyId: string };
      // 5.3: "Сервер отказывает в создании приглашения аккаунту с ролью `member`." One of the two
      // independent checks; the other one is the joining device's, against the member list.
      const membership = context.requireOwner(context.requireFamily(auth, familyId));
      const input = request.body as InviteWireBody;
      if (input.familyId !== membership.familyId) {
        throw new ApiError(403, "forbidden", "invite is addressed to another family");
      }
      if (input.keyEpoch !== membership.keyEpoch) {
        throw new ApiError(409, "epoch_mismatch", "the invite names a stale key epoch", {
          keyEpoch: membership.keyEpoch,
        });
      }
      const iv = decodeBytes(input.iv, "iv", { exact: AES_GCM_IV_BYTES });
      const ciphertext = decodeBytes(input.ciphertext, "ciphertext", {
        min: 1,
        max: MAX_INVITE_BOX_BYTES,
      });
      const authTokenDigest = decodeBytes(input.authTokenDigest, "authTokenDigest", {
        exact: SHA256_BYTES,
      });
      const now = context.now();
      sweepExpiredInvites();
      // Issuing is a rate-limited act like claiming one, and for the same reason: every live
      // invite is a row the whole system carries, and until this counter existed the number of
      // them was chosen by whichever owner cared to write a loop. The bucket is the family, which
      // no outsider can reach — `requireOwner` above has already refused everyone else.
      const createBucket = `invite-create:family:${membership.familyId}`;
      context.throttleSweep("invite-create:", INVITE_CREATE_WINDOW_MS);
      if (context.throttleCount(createBucket, INVITE_CREATE_WINDOW_MS) >= INVITE_CREATES_PER_WINDOW) {
        throw new ApiError(429, "rate_limited", "too many invites issued for this family");
      }
      const clash = context.db
        .prepare("SELECT invite_id FROM invite WHERE invite_id = ?")
        .get(input.inviteId);
      if (clash !== undefined) {
        // The issuing owner's clash, and not the joining device's `invite_invalid`: one is fixed
        // by choosing another identifier, the other by asking for another code.
        throw new ApiError(409, "invite_exists", "this invite identifier is taken");
      }
      // 5.3 fixes the TTL at `24` hours, and the server sets it. Accepting an expiry from the
      // client would not be a limit: the issuer would be free to write ten years.
      const expiresAt = now + INVITE_TTL_MS;
      const superseded = context.db.transaction(() => {
        // 5.3 knows one live code per family at a time, and this is where that is made true. The
        // older code is deleted rather than left beside the new one: two live boxes are two
        // offline targets for the same `60` bits, and the family gains nothing from the second.
        // It also gives 5.3 the withdrawal it otherwise lacks — a code read out to the wrong
        // person is replaced instead of standing for a day.
        const live = context.db
          .prepare(
            "SELECT invite_id FROM invite WHERE family_id = ? AND used_at IS NULL AND expires_at > ?" +
              " ORDER BY created_at DESC",
          )
          .all(membership.familyId, now) as { invite_id: string }[];
        const doomed = live.slice(Math.max(0, MAX_LIVE_INVITES_PER_FAMILY - 1));
        for (const row of doomed) {
          context.db.prepare("DELETE FROM invite WHERE invite_id = ?").run(row.invite_id);
        }
        context.db
          .prepare(
            "INSERT INTO invite (invite_id, family_id, key_epoch, auth_token_digest, iv," +
              " ciphertext, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
          )
          .run(
            input.inviteId,
            membership.familyId,
            membership.keyEpoch,
            authTokenDigest,
            iv,
            ciphertext,
            now,
            expiresAt,
          );
        return doomed.map((row) => row.invite_id);
      })();
      context.throttleRecord(createBucket);
      return reply.code(201).send({
        inviteId: input.inviteId,
        familyId: membership.familyId,
        keyEpoch: membership.keyEpoch,
        expiresAt,
        // Said out loud, because a code that has just stopped working is something the issuing
        // device has to be able to tell the person holding it.
        supersededInviteIds: superseded,
      });
    },
  );

  app.post(
    "/v1/invites/claim",
    {
      schema: {
        body: body({ authToken: base64Field(SHA256_BYTES, SHA256_BYTES) }, ["authToken"]),
      },
    },
    async (request) => {
      const auth = context.authenticate(request);
      const { authToken } = request.body as { authToken: string };
      const accountBucket = `invite-claim:account:${auth.accountId}`;
      const ipBucket = `invite-claim:ip:${request.ip}`;
      context.throttleSweep("invite-claim:", INVITE_CLAIM_DAY_MS);
      // 5.3: no more than `5` failed lookups in `15` minutes and `20` in a day, per account and
      // per IP. This is the counter that stands between a copied invite box and a `60`-bit code,
      // so it is stored, not held in memory, and both dimensions are checked.
      for (const bucket of [accountBucket, ipBucket]) {
        if (
          context.throttleCount(bucket, INVITE_CLAIM_WINDOW_MS) >= INVITE_CLAIM_FAILURES_PER_WINDOW ||
          context.throttleCount(bucket, INVITE_CLAIM_DAY_MS) >= INVITE_CLAIM_FAILURES_PER_DAY
        ) {
          throw new ApiError(429, "rate_limited", "too many invite lookups");
        }
      }
      const digest = sha256(decodeBytes(authToken, "authToken", { exact: SHA256_BYTES }));
      sweepExpiredInvites();
      // What used to stand here was a walk over every live invite in the database, comparing each
      // digest with `equalBytes` for the constant-time comparison 5.3 asks for. The walk is gone:
      // it was constant-time in the wrong variable — its length was the number of live invites,
      // which any owner could raise, on a synchronous driver, for every claim made by anyone.
      //
      // With the row found through `invite_digest`, the comparison is the index's and there is
      // nothing left in this function to compare: the predicate is equality on the digest, so a
      // row that comes back matches by construction and a loop over the result could reject
      // nothing. Constancy of work is `LIMIT 1` and the equality behind it, not a loop; the
      // ordering is there so that the one row is a chosen row rather than whichever the engine
      // reached first, in the collision case that would return more than one.
      //
      // Being keyed leaks nothing an attacker can walk: the value in the index is
      // `SHA-256(authToken)`, and to steer one byte of it they would have to choose a preimage.
      // What guards the `60`-bit code behind `authToken` is the pair of counters above — `5`
      // failures in `15` minutes, `20` in a day — and it is the only thing that ever did.
      const matched = context.db
        .prepare(
          "SELECT * FROM invite WHERE auth_token_digest = ? AND used_at IS NULL" +
            " AND expires_at > ? AND ciphertext IS NOT NULL" +
            " ORDER BY created_at DESC, invite_id ASC LIMIT 1",
        )
        .get(digest, context.now()) as InviteRow | undefined;
      if (matched === undefined || matched.ciphertext === null) {
        context.throttleRecord(accountBucket);
        context.throttleRecord(ipBucket);
        throw notFound("no invite matches this token");
      }
      return {
        inviteId: matched.invite_id,
        familyId: matched.family_id,
        keyEpoch: matched.key_epoch,
        iv: toBase64(new Uint8Array(matched.iv)),
        inviteBox: toBase64(new Uint8Array(matched.ciphertext)),
      };
    },
  );

  app.post(
    "/v1/invites/join",
    {
      schema: {
        body: body(
          {
            inviteId: uuidField,
            authToken: base64Field(SHA256_BYTES, SHA256_BYTES),
            memberId: identifierField,
            bindProof: base64Field(SHA256_BYTES, SHA256_BYTES),
          },
          ["inviteId", "authToken", "memberId", "bindProof"],
        ),
      },
    },
    async (request, reply) => {
      const auth = context.authenticate(request);
      const input = request.body as {
        inviteId: string;
        authToken: string;
        memberId: string;
        bindProof: string;
      };
      const existing = context.db
        .prepare("SELECT member_id FROM member WHERE account_id = ? AND removed_at IS NULL")
        .get(auth.accountId);
      if (existing !== undefined) {
        throw new ApiError(409, "already_in_family", "this account already belongs to a family");
      }
      const digest = sha256(decodeBytes(input.authToken, "authToken", { exact: SHA256_BYTES }));
      const bindProof = decodeBytes(input.bindProof, "bindProof", { exact: SHA256_BYTES });
      sweepExpiredInvites();
      const invite = context.db
        .prepare("SELECT * FROM invite WHERE invite_id = ?")
        .get(input.inviteId) as InviteRow | undefined;
      // The token is required again here, and not only at the lookup step. Without it, knowing an
      // `inviteId` — which the server itself hands out — would be enough to join, and the code
      // would guard nothing.
      if (
        invite === undefined ||
        invite.used_at !== null ||
        invite.expires_at <= context.now() ||
        !equalBytes(digest, new Uint8Array(invite.auth_token_digest))
      ) {
        throw new ApiError(404, "invite_invalid", "the invite is unknown, used or expired");
      }
      // The joining device chooses its own `memberId`, and since migration 2 that identifier is
      // unique within its family rather than globally. Two consequences, both wanted: a collision
      // with another family's member is impossible, so this route stopped being a way to ask
      // whether some identifier exists somewhere; and a collision inside *this* family — the one
      // the caller holds an invite to, so nothing is disclosed by saying so — is answered in words
      // instead of arriving as a constraint violation and a `500`.
      const taken = context.db
        .prepare("SELECT member_id FROM member WHERE family_id = ? AND member_id = ?")
        .get(invite.family_id, input.memberId);
      if (taken !== undefined) {
        throw invalid("this member identifier is already used in that family");
      }
      const now = context.now();
      context.db.transaction(() => {
        context.db
          .prepare(
            "INSERT INTO member (member_id, family_id, account_id, role, joined_at)" +
              " VALUES (?, ?, ?, 'member', ?)",
          )
          .run(input.memberId, invite.family_id, auth.accountId, now);
        // 5.4: the server keeps `bindProof` and the `inviteId` so the owner's device can recompute
        // the HMAC on its own `bindKey`. It cannot check them itself — `bindKey` is derived from a
        // code it never sees — and it stores no verdict about the result, because 2.2 says the
        // verdict about a key's authenticity may not live on the server that hands the key out.
        context.db
          .prepare("UPDATE device SET bind_proof = ?, invite_id = ? WHERE device_id = ?")
          .run(bindProof, invite.invite_id, auth.deviceId);
        // 5.3: used once, and the box is deleted on use. It shortens the window for an offline
        // attack on the code; it does not close it for anyone who already copied the box.
        context.db
          .prepare("UPDATE invite SET used_at = ?, used_by_device_id = ?, ciphertext = NULL WHERE invite_id = ?")
          .run(now, auth.deviceId, invite.invite_id);
      })();
      return reply.code(201).send({
        familyId: invite.family_id,
        keyEpoch: invite.key_epoch,
        memberId: input.memberId,
        role: "member",
      });
    },
  );
}
