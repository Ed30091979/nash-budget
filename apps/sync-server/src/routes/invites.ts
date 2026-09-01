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
import { ApiError, notFound } from "../errors.ts";
import {
  AES_GCM_IV_BYTES,
  INVITE_CLAIM_DAY_MS,
  INVITE_CLAIM_FAILURES_PER_DAY,
  INVITE_CLAIM_FAILURES_PER_WINDOW,
  INVITE_CLAIM_WINDOW_MS,
  INVITE_TTL_MS,
  MAX_INVITE_BOX_BYTES,
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
  /** 5.3: the box is deleted on use and on expiry. Expiry has no event, so it is swept. */
  const sweepInviteBoxes = (): void => {
    context.db
      .prepare("UPDATE invite SET ciphertext = NULL WHERE expires_at <= ? AND ciphertext IS NOT NULL")
      .run(context.now());
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
      sweepInviteBoxes();
      const clash = context.db
        .prepare("SELECT invite_id FROM invite WHERE invite_id = ?")
        .get(input.inviteId);
      if (clash !== undefined) {
        throw new ApiError(409, "invite_invalid", "this invite identifier is taken");
      }
      // 5.3 fixes the TTL at `24` hours, and the server sets it. Accepting an expiry from the
      // client would not be a limit: the issuer would be free to write ten years.
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
          now + INVITE_TTL_MS,
        );
      return reply.code(201).send({
        inviteId: input.inviteId,
        familyId: membership.familyId,
        keyEpoch: membership.keyEpoch,
        expiresAt: now + INVITE_TTL_MS,
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
      sweepInviteBoxes();
      // 5.3 asks for a constant-time comparison. An index probe on the digest would leak which
      // stored value was reached; the live invites are walked instead and every one is compared,
      // without an early exit, so the work done does not depend on which row matched or whether
      // any did. Live invites are few — one per family at a time, with a 24-hour TTL.
      const rows = context.db
        .prepare(
          "SELECT * FROM invite WHERE used_at IS NULL AND expires_at > ? AND ciphertext IS NOT NULL",
        )
        .all(context.now()) as InviteRow[];
      let matched: InviteRow | null = null;
      for (const row of rows) {
        if (equalBytes(digest, new Uint8Array(row.auth_token_digest))) matched = row;
      }
      if (matched === null || matched.ciphertext === null) {
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
