/**
 * Key wraps outside a rotation — 5.5, last part, and the invariant of 5.6.
 *
 * Two endpoints, and between them they carry the whole of what the server may do with a family
 * key: hold opaque wraps addressed to a device and hand them back to that device. It never makes
 * one, never opens one and never decides that a device deserves one.
 *
 * The upload path is the case 5.5 spells out at the end: a device bound *after* the last change of
 * key — a second phone, a reinstall — must not wait for the next rotation, so the owner (path «б»
 * of 5.6) or, after a two-way comparison, any member (path «в») makes it a wrap of the **current**
 * epoch. The epoch number does not change, so no `rotateConfirm` is involved and no `staging` row
 * is created; 5.6 is explicit that this is not a fourth way of getting the key but the same
 * ceremony that bound the device.
 *
 * The hard half of the same rule is the refusal: a device that already holds this epoch's key must
 * never take such a wrap, because that is exactly how the continuity chain was once bypassed — a
 * wrap of the current epoch changes the key without changing the number, and nothing has to be
 * confirmed. The receiver enforces it by comparing key digests; the server enforces what it can,
 * which is that the slot `(family, epoch, device)` is not free for the taking — a second wrap is
 * refused with `wrap_exists` rather than silently overwriting the first.
 *
 * "Written once" is not quite the rule, and the exception is deliberate: the owner may replace a
 * wrap that the owner did not place. Written once for everyone, any member could fill another
 * device's slot first and leave it filled — no route deletes a wrap — and the owner would be
 * unable to hand over the real one without a full rotation. That is an insider's denial of exactly
 * the path 5.5 provides so that a rotation is *not* needed, and it is not a key substitution: the
 * receiver compares key digests (5.6). The reasoning sits again at the check itself.
 *
 * The fetch path is written to take **no input at all** beyond the family in the URL. It would be
 * natural to let the device say which epoch it has accepted and answer with the difference, and it
 * is precisely what 2.2 and 5.4.1 forbid: what a device accepts is its own state, kept on the
 * device, and a server that were told it would be able to act on it — offer a chain that starts
 * where the device is weakest, or notice which devices are behind. So the answer is everything
 * addressed to this device, in epoch order, and the device picks its own path through it.
 *
 * The same answer carries the pair a *sender* needs before it can make a wrap at all: the epoch in
 * force and the `rotationId` that produced it. That is the other half of the rule, not an
 * exception to it — 5.5 says both values travel from the server and are not named in the request,
 * and until this route stated the second one the upload path was writable only by a device that
 * happened to still hold a value nothing ever gave it back.
 */
import type { FastifyInstance } from "fastify";

import { toBase64 } from "../bytes.ts";
import type { ServerContext } from "../context.ts";
import { ApiError, forbidden } from "../errors.ts";
import { AES_GCM_IV_BYTES, HKDF_SALT_BYTES, MAX_KEY_WRAP_BYTES } from "../limits.ts";
import { decodeBytes } from "./decode.ts";
import { base64Field, body, uuidField } from "./fields.ts";

interface WrapRow {
  readonly key_epoch: number;
  readonly device_id: string;
  readonly sender_device_id: string;
  readonly rotation_id: string;
  readonly salt: Uint8Array;
  readonly iv: Uint8Array;
  readonly ciphertext: Uint8Array;
  readonly created_at: number;
  readonly rotate_confirm: Uint8Array | null;
  readonly confirm_rotation_id: string | null;
}

export function registerKeyRoutes(app: FastifyInstance, context: ServerContext): void {
  const familyParams = { params: body({ familyId: uuidField }, ["familyId"]) };

  app.post(
    "/v1/families/:familyId/keys",
    {
      schema: {
        ...familyParams,
        body: body(
          {
            deviceId: uuidField,
            salt: base64Field(HKDF_SALT_BYTES, HKDF_SALT_BYTES),
            iv: base64Field(AES_GCM_IV_BYTES, AES_GCM_IV_BYTES),
            ciphertext: base64Field(MAX_KEY_WRAP_BYTES, 1),
          },
          ["deviceId", "salt", "iv", "ciphertext"],
        ),
      },
    },
    async (request, reply) => {
      const auth = context.authenticate(request);
      const { familyId } = request.params as { familyId: string };
      const membership = context.requireFamily(auth, familyId);
      const input = request.body as {
        deviceId: string;
        salt: string;
        iv: string;
        ciphertext: string;
      };

      // 5.5: the wrap is made for the epoch in force, and the number is the server's to state.
      // The sender does not name it — a client-named epoch here would let a stale device write a
      // wrap into an epoch that has already been replaced, and the receiver would have no way to
      // tell that from a fresh one.
      const epoch = context.activeEpoch(membership.familyId, membership.keyEpoch);
      if (epoch === undefined) throw new ApiError(500, "internal", "epoch row is missing");
      if (epoch.rotation_id === null) {
        // Not `no_rotation`: no rotation was asked for here, and a client told otherwise would
        // offer to finish one. 5.5 has the out-of-band wrap carry the `rotationId` that produced
        // the epoch in force, and this epoch has none to carry.
        throw new ApiError(
          409,
          "epoch_not_wrappable",
          "this epoch carries no rotation identifier and cannot be wrapped for out of band",
        );
      }
      // 5.5: while an epoch is staging the family key of the *next* epoch is being made, and a
      // wrap of the current one issued in that window would be handed to a device that is about to
      // be told the number has changed. The rotation's own wraps travel on the rotation route.
      const staging = context.stagingEpoch(membership.familyId);
      if (staging !== undefined) {
        throw new ApiError(409, "rotation_in_progress", "a key rotation is in progress", {
          keyEpoch: membership.keyEpoch,
          stagingKeyEpoch: staging.key_epoch,
        });
      }

      const target = context.db
        .prepare(
          "SELECT d.device_id, d.revoked_at FROM device d" +
            " JOIN member m ON m.account_id = d.account_id" +
            " WHERE d.device_id = ? AND m.family_id = ? AND m.removed_at IS NULL",
        )
        .get(input.deviceId, membership.familyId) as
        | { device_id: string; revoked_at: number | null }
        | undefined;
      if (target === undefined) {
        throw forbidden("forbidden", "the wrap is addressed to a device outside this family");
      }
      if (target.revoked_at !== null) {
        throw forbidden("forbidden", "the wrap is addressed to a revoked device");
      }
      if (target.device_id === auth.deviceId) {
        throw forbidden("forbidden", "a device does not wrap the family key for itself");
      }

      // Who put the existing wrap there, if there is one. The role is read from the family's own
      // member list rather than taken from the row, because the row records a device and roles
      // live on members.
      const existing = context.db
        .prepare(
          "SELECT w.sender_device_id, m.role AS sender_role FROM key_wrap w" +
            " LEFT JOIN device d ON d.device_id = w.sender_device_id" +
            " LEFT JOIN member m ON m.account_id = d.account_id AND m.family_id = w.family_id" +
            " AND m.removed_at IS NULL" +
            " WHERE w.family_id = ? AND w.key_epoch = ? AND w.device_id = ?",
        )
        .get(membership.familyId, membership.keyEpoch, input.deviceId) as
        | { sender_device_id: string; sender_role: string | null }
        | undefined;
      // 5.5: a wrap is written once, and a server that silently replaced it would be offering the
      // "key change without an epoch change" that the confirmation chain of 5.4 exists to make
      // impossible. That is why the refusal stays — but it has to count the sender, and until now
      // it did not. Any member could put a wrap of their own into another device's slot first;
      // the slot never freed, no route deleted it, and the owner was left unable to hand over the
      // real wrap without a full rotation. That is not a key substitution — the receiver compares
      // key digests (5.6) and refuses — it is an insider's denial of exactly the path 5.5 provides
      // so that a rotation is *not* needed.
      //
      // So: the owner may replace a wrap that the owner did not place. A wrap placed by the owner
      // is still written once, for everyone, the owner included. The narrow reading of 5.5 is
      // preserved where it protects something, and dropped where it only held a door shut.
      const replaceable =
        existing !== undefined && membership.role === "owner" && existing.sender_role !== "owner";
      if (existing !== undefined && !replaceable) {
        throw new ApiError(409, "wrap_exists", "a wrap of this epoch already exists for that device", {
          keyEpoch: membership.keyEpoch,
        });
      }

      const salt = decodeBytes(input.salt, "salt", { exact: HKDF_SALT_BYTES });
      const iv = decodeBytes(input.iv, "iv", { exact: AES_GCM_IV_BYTES });
      const ciphertext = decodeBytes(input.ciphertext, "ciphertext", {
        min: 1,
        max: MAX_KEY_WRAP_BYTES,
      });
      const now = context.now();
      context.db
        .prepare(
          "INSERT INTO key_wrap (family_id, key_epoch, device_id, sender_device_id," +
            " rotation_id, salt, iv, ciphertext, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)" +
            " ON CONFLICT (family_id, key_epoch, device_id) DO UPDATE SET" +
            " sender_device_id = excluded.sender_device_id, rotation_id = excluded.rotation_id," +
            " salt = excluded.salt, iv = excluded.iv, ciphertext = excluded.ciphertext," +
            " created_at = excluded.created_at",
        )
        .run(
          membership.familyId,
          membership.keyEpoch,
          input.deviceId,
          auth.deviceId,
          epoch.rotation_id,
          salt,
          iv,
          ciphertext,
          now,
        );
      return reply.code(201).send({
        keyEpoch: membership.keyEpoch,
        deviceId: input.deviceId,
        senderDeviceId: auth.deviceId,
        rotationId: epoch.rotation_id,
        createdAt: now,
        // Said out loud: the receiving device is being handed something in place of what was
        // there, and 5.6 has it compare key digests before accepting either.
        replacedSenderDeviceId: replaceable ? (existing?.sender_device_id ?? null) : null,
      });
    },
  );

  app.get(
    "/v1/families/:familyId/keys",
    // No query string is accepted, and the empty schema is the point: `additionalProperties` is
    // `false`, so a device that tries to tell the server which epoch it holds is refused rather
    // than served. See the header of this file.
    { schema: { ...familyParams, querystring: body({}, []) } },
    async (request) => {
      const auth = context.authenticate(request);
      const { familyId } = request.params as { familyId: string };
      const membership = context.requireFamily(auth, familyId);
      // 5.5 names two values the *sender* of an out-of-band wrap needs and may not invent: the
      // number of the epoch in force and the `rotationId` that produced it. Both are put into the
      // wrap's HKDF info and its AAD, and the upload route stamps the `rotationId` from this same
      // row — so a sender that guessed it wrote a wrap whose AAD disagreed with the row recorded
      // beside it, and the receiver's unwrap failed every time. Until now no route stated it: the
      // creation response did not echo it, `/families/me` carries only the `rotationId` of a
      // *staging* attempt, and the wraps below carry only the ones already addressed to this
      // device. So the owner who created the family and then reloaded the page could not hand a
      // wrap to a member's second phone — the case 5.5 ends on, and the one it exists for.
      //
      // It travels here and only here, in the answer to a route that is scoped to a family the
      // caller has been found a live member of. That is the audience: 5.6 makes the owner (path
      // «б») and, after a two-way comparison, any member (path «в») a possible sender, and nobody
      // outside the family is one. It is not a value to volunteer to a stranger holding an invite:
      // `POST /v1/invites/claim` answers before there is a membership to check, and says nothing
      // of it.
      //
      // And it still never travels the other way. The POST above accepts no epoch and no rotation
      // identifier in its body; this is the server telling the sender what it will record, not the
      // sender telling the server what to record.
      const epoch = context.activeEpoch(membership.familyId, membership.keyEpoch);
      const rows = context.db
        .prepare(
          "SELECT w.key_epoch, w.device_id, w.sender_device_id, w.rotation_id, w.salt, w.iv," +
            " w.ciphertext, w.created_at, c.rotate_confirm," +
            " c.rotation_id AS confirm_rotation_id" +
            " FROM key_wrap w LEFT JOIN epoch_confirm c" +
            " ON c.family_id = w.family_id AND c.key_epoch = w.key_epoch" +
            " WHERE w.family_id = ? AND w.device_id = ?" +
            " ORDER BY w.key_epoch ASC",
        )
        .all(membership.familyId, auth.deviceId) as WrapRow[];
      return {
        // The epoch in force travels server to client and never the other way (2.2).
        keyEpoch: membership.keyEpoch,
        // `null` only for a state no route can produce — an epoch row missing, or one written
        // without an identifier. Not a `500`: this is the route every device fetches its keys
        // from, and refusing all of them would be a worse answer than saying that no wrap can be
        // made right now, which is what the POST above already says with `epoch_not_wrappable`.
        rotationId: epoch?.rotation_id ?? null,
        wraps: rows.map((row) => ({
          keyEpoch: row.key_epoch,
          deviceId: row.device_id,
          senderDeviceId: row.sender_device_id,
          rotationId: row.rotation_id,
          salt: toBase64(new Uint8Array(row.salt)),
          iv: toBase64(new Uint8Array(row.iv)),
          ciphertext: toBase64(new Uint8Array(row.ciphertext)),
          createdAt: row.created_at,
          // 5.4: the wrap alone does not authorise a change of epoch number. The confirmation of
          // continuity travels with it so that the receiving device can check it on the key of the
          // epoch it already holds — and it is `null` for an epoch reached without a rotation.
          rotateConfirm:
            row.rotate_confirm === null ? null : toBase64(new Uint8Array(row.rotate_confirm)),
          confirmRotationId: row.confirm_rotation_id,
        })),
      };
    },
  );
}
