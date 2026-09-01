/**
 * Key rotation — 5.5.
 *
 * The server's part is small and entirely mechanical: allocate the next epoch number, freeze the
 * old epoch against writes, hold the staging epoch while the owner's device re-encrypts the
 * journal into it, and then switch the two over in one transaction. It never sees a key, never
 * makes a wrap and never decides that a rotation should happen — 5.7 is explicit that a server
 * able to start one would hold a "rewrite the family's history" button.
 *
 * Two rules here come from the document as requirements on this phase:
 *
 *  - only the owner may declare a rotation. Without the check, any member's device closes writing
 *    for the whole family for up to six hours with one command — a denial of service that costs
 *    one comparison to close;
 *  - a retry after a cancelled attempt takes the *next* epoch number, never the same one. 5.4
 *    spends a page on why: with the number reused, the server can hand one device the consistent
 *    wrap-and-confirmation pair of the cancelled attempt and another device the pair of the
 *    successful one, and the family splits across two keys of one epoch with no symptom at all.
 */
import type { FastifyInstance, FastifyRequest } from "fastify";

import type { ServerContext } from "../context.ts";
import { ApiError, conflict, forbidden } from "../errors.ts";
import {
  AES_GCM_IV_BYTES,
  HKDF_SALT_BYTES,
  MAX_EPOCH_CONFIRM_BYTES,
  MAX_KEY_WRAP_BYTES,
} from "../limits.ts";
import { decodeBytes } from "./decode.ts";
import { base64Field, body, uuidField } from "./fields.ts";

const wrapSchema = body(
  {
    deviceId: uuidField,
    senderDeviceId: uuidField,
    salt: base64Field(HKDF_SALT_BYTES, HKDF_SALT_BYTES),
    iv: base64Field(AES_GCM_IV_BYTES, AES_GCM_IV_BYTES),
    ciphertext: base64Field(MAX_KEY_WRAP_BYTES, 1),
  },
  ["deviceId", "senderDeviceId", "salt", "iv", "ciphertext"],
);

interface WrapInput {
  readonly deviceId: string;
  readonly senderDeviceId: string;
  readonly salt: string;
  readonly iv: string;
  readonly ciphertext: string;
}

export function registerRotationRoutes(app: FastifyInstance, context: ServerContext): void {
  const familyParams = { params: body({ familyId: uuidField }, ["familyId"]) };

  app.post(
    "/v1/families/:familyId/rotation",
    { schema: { ...familyParams, body: body({ rotationId: uuidField }, ["rotationId"]) } },
    async (request, reply) => {
      const auth = context.authenticate(request);
      const { familyId } = request.params as { familyId: string };
      const membership = context.requireOwner(context.requireFamily(auth, familyId));
      const { rotationId } = request.body as { rotationId: string };

      const staging = context.stagingEpoch(familyId);
      if (staging !== undefined) {
        throw conflict("rotation_in_progress", "a rotation is already in progress", {
          keyEpoch: membership.keyEpoch,
          stagingKeyEpoch: staging.key_epoch,
        });
      }
      const current = context.activeEpoch(familyId, membership.keyEpoch);
      if (current === undefined) throw new ApiError(500, "internal", "epoch row is missing");

      const now = context.now();
      // 2.2: the epoch number only grows and may skip. `max_key_epoch` is the high-water mark, so
      // a number spent on a cancelled attempt is never handed out a second time.
      const nextEpoch = membership.maxKeyEpoch + 1;
      // 5.5 step 1: `freezeSeq` is the current maximum of the epoch in force. The owner's device
      // does not take this number on trust — it refuses anything below its own cursor and below
      // the highest `seq` it has ever seen, because truncation from the end is continuous and
      // would otherwise become legitimate history the moment the old epoch is deleted.
      const freezeSeq = current.seq_counter;
      context.db.transaction(() => {
        context.db
          .prepare(
            "INSERT INTO epoch (family_id, key_epoch, seq_counter, state, rotation_id," +
              " rotating_device_id, rotation_started_at, last_progress_at, freeze_seq)" +
              " VALUES (?, ?, 0, 'staging', ?, ?, ?, ?, ?)",
          )
          .run(familyId, nextEpoch, rotationId, auth.deviceId, now, now, freezeSeq);
        context.db
          .prepare("UPDATE family SET max_key_epoch = ? WHERE family_id = ?")
          .run(nextEpoch, familyId);
      })();

      return reply.code(201).send({
        keyEpoch: nextEpoch,
        previousKeyEpoch: membership.keyEpoch,
        rotationId,
        freezeSeq,
        rotatingDeviceId: auth.deviceId,
        startedAt: now,
      });
    },
  );

  /** The staging epoch of this family, with the caller checked as the device leading it. */
  const requireLeadingRotation = (
    request: FastifyRequest,
    familyId: string,
    rotationId: string,
  ) => {
    const auth = context.authenticate(request);
    const membership = context.requireOwner(context.requireFamily(auth, familyId));
    const staging = context.stagingEpoch(familyId);
    if (staging === undefined) {
      throw new ApiError(409, "no_rotation", "no rotation is in progress for this family");
    }
    if (staging.rotation_id !== rotationId) {
      throw new ApiError(409, "no_rotation", "this rotation attempt is not the one in progress");
    }
    if (staging.rotating_device_id !== auth.deviceId) {
      throw forbidden("forbidden", "only the device leading the rotation may advance it");
    }
    return { auth, membership, staging };
  };

  app.post(
    "/v1/families/:familyId/rotation/keys",
    {
      schema: {
        ...familyParams,
        body: body(
          {
            rotationId: uuidField,
            epochConfirm: base64Field(MAX_EPOCH_CONFIRM_BYTES, 1),
            wraps: { type: "array", minItems: 0, maxItems: 64, items: wrapSchema },
          },
          ["rotationId"],
        ),
      },
    },
    async (request) => {
      const { familyId } = request.params as { familyId: string };
      const input = request.body as {
        rotationId: string;
        epochConfirm?: string;
        wraps?: WrapInput[];
      };
      const { staging } = requireLeadingRotation(request, familyId, input.rotationId);
      const now = context.now();
      const wraps = input.wraps ?? [];

      const decodedWraps = wraps.map((wrap) => {
        // 5.5 step 5 wraps the new key for every remaining *bound* device. The server cannot check
        // binding — the pin lives on the owner's device and nowhere else — but it can refuse a
        // wrap addressed outside the family or to a revoked device, and it must: 6.7 revokes
        // precisely so that the device stops receiving anything, and rotation is the act that
        // finally takes the key away from it.
        const target = context.db
          .prepare(
            "SELECT d.device_id, d.revoked_at FROM device d" +
              " JOIN member m ON m.account_id = d.account_id" +
              " WHERE d.device_id = ? AND m.family_id = ? AND m.removed_at IS NULL",
          )
          .get(wrap.deviceId, familyId) as { device_id: string; revoked_at: number | null } | undefined;
        if (target === undefined) {
          throw forbidden("forbidden", "a wrap is addressed to a device outside this family");
        }
        if (target.revoked_at !== null) {
          throw forbidden("forbidden", "a wrap is addressed to a revoked device");
        }
        if (wrap.senderDeviceId !== staging.rotating_device_id) {
          throw forbidden("forbidden", "a wrap claims a sender other than the rotating device");
        }
        return {
          deviceId: wrap.deviceId,
          senderDeviceId: wrap.senderDeviceId,
          salt: decodeBytes(wrap.salt, "salt", { exact: HKDF_SALT_BYTES }),
          iv: decodeBytes(wrap.iv, "iv", { exact: AES_GCM_IV_BYTES }),
          ciphertext: decodeBytes(wrap.ciphertext, "ciphertext", { min: 1, max: MAX_KEY_WRAP_BYTES }),
        };
      });
      const epochConfirm =
        input.epochConfirm === undefined
          ? null
          : decodeBytes(input.epochConfirm, "epochConfirm", { min: 1, max: MAX_EPOCH_CONFIRM_BYTES });

      const wrote = decodedWraps.length > 0 || epochConfirm !== null;
      context.db.transaction(() => {
        for (const wrap of decodedWraps) {
          // Replacing is allowed while the epoch is still staging: 5.4 has the owner regenerate a
          // wrap with a fresh salt and IV when an attempt is retried, and refusing the second one
          // would leave the first, made for a key that no longer exists.
          context.db
            .prepare(
              "INSERT INTO key_wrap (family_id, key_epoch, device_id, sender_device_id," +
                " rotation_id, salt, iv, ciphertext, created_at)" +
                " VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)" +
                " ON CONFLICT (family_id, key_epoch, device_id) DO UPDATE SET" +
                " sender_device_id = excluded.sender_device_id, rotation_id = excluded.rotation_id," +
                " salt = excluded.salt, iv = excluded.iv, ciphertext = excluded.ciphertext," +
                " created_at = excluded.created_at",
            )
            .run(
              familyId,
              staging.key_epoch,
              wrap.deviceId,
              wrap.senderDeviceId,
              input.rotationId,
              wrap.salt,
              wrap.iv,
              wrap.ciphertext,
              now,
            );
        }
        if (epochConfirm !== null) {
          context.db
            .prepare(
              "INSERT INTO epoch_confirm (family_id, key_epoch, rotation_id, rotate_confirm, created_at)" +
                " VALUES (?, ?, ?, ?, ?)" +
                " ON CONFLICT (family_id, key_epoch) DO UPDATE SET" +
                " rotation_id = excluded.rotation_id, rotate_confirm = excluded.rotate_confirm," +
                " created_at = excluded.created_at",
            )
            .run(familyId, staging.key_epoch, input.rotationId, epochConfirm, now);
        }
        // 5.5 measures the idle timeout in *progress*, and an empty request is not progress. It
        // used to move the mark all the same, which turned the thirty-minute timeout into a thing
        // the rotating device could postpone indefinitely by sending `{}` twice an hour — and a
        // staging epoch holds writing closed for the whole family while it lasts. The mark moves
        // when a wrap or a confirmation was actually written, and not otherwise.
        if (wrote) {
          context.db
            .prepare("UPDATE epoch SET last_progress_at = ? WHERE family_id = ? AND key_epoch = ?")
            .run(now, familyId, staging.key_epoch);
        }
      })();

      return {
        keyEpoch: staging.key_epoch,
        wraps: decodedWraps.length,
        lastProgressAt: wrote ? now : staging.last_progress_at,
      };
    },
  );

  app.post(
    "/v1/families/:familyId/rotation/complete",
    { schema: { ...familyParams, body: body({ rotationId: uuidField }, ["rotationId"]) } },
    async (request) => {
      const { familyId } = request.params as { familyId: string };
      const input = request.body as { rotationId: string };
      const { membership, staging } = requireLeadingRotation(request, familyId, input.rotationId);
      const confirm = context.db
        .prepare("SELECT key_epoch FROM epoch_confirm WHERE family_id = ? AND key_epoch = ?")
        .get(familyId, staging.key_epoch);
      if (confirm === undefined) {
        // 5.4: a device recognises a *change of epoch number* only through the chain of
        // confirmations. Switching without one would leave every other device unable to accept
        // the new key by any legitimate path, and the family stuck on a retired epoch.
        throw new ApiError(
          409,
          "no_rotation",
          "the epoch confirmation has not been uploaded for this rotation",
        );
      }
      const now = context.now();
      context.db.transaction(() => {
        // 5.5 step 7, one transaction. The staging counter is deliberately left alone: it was
        // created at step 1 and spent by the staging upload, and resetting it here would hand the
        // next envelopes numbers the transferred journal already occupies.
        context.db
          .prepare("UPDATE epoch SET state = 'retired' WHERE family_id = ? AND key_epoch = ?")
          .run(familyId, membership.keyEpoch);
        context.db
          .prepare(
            "UPDATE epoch SET state = 'active', rotating_device_id = NULL," +
              " last_progress_at = NULL WHERE family_id = ? AND key_epoch = ?",
          )
          .run(familyId, staging.key_epoch);
        context.db
          .prepare("UPDATE family SET key_epoch = ? WHERE family_id = ?")
          .run(staging.key_epoch, familyId);
        // Physically, not by a flag. The old epoch's envelopes are encrypted under a key that has
        // just been retired, and a family member who left keeps that key.
        context.db
          .prepare("DELETE FROM envelope WHERE family_id = ? AND key_epoch = ?")
          .run(familyId, membership.keyEpoch);
        // Its byte budget goes with its envelopes. The retired epoch accepts no writes, so this
        // changes nothing that can be observed; a counter left standing for rows that no longer
        // exist is simply a lie kept on a row.
        context.db
          .prepare("UPDATE epoch SET ciphertext_bytes = 0 WHERE family_id = ? AND key_epoch = ?")
          .run(familyId, membership.keyEpoch);
        // 5.5 step 7 again: every live invite goes too. An invite box carries the family key of
        // the epoch it was issued in, and that epoch has just stopped being the family's.
        context.db.prepare("DELETE FROM invite WHERE family_id = ?").run(familyId);
      })();
      return {
        keyEpoch: staging.key_epoch,
        previousKeyEpoch: membership.keyEpoch,
        completedAt: now,
      };
    },
  );

  app.delete(
    "/v1/families/:familyId/rotation",
    { schema: familyParams },
    async (request) => {
      const auth = context.authenticate(request);
      const { familyId } = request.params as { familyId: string };
      const membership = context.requireOwner(context.requireFamily(auth, familyId));
      const staging = context.stagingEpoch(familyId);
      if (staging === undefined) {
        throw new ApiError(409, "no_rotation", "no rotation is in progress for this family");
      }
      // 5.5: the owner may cancel an attempt that is not their own and need not wait for either
      // timeout — otherwise an attempt stuck on a lost device would block exactly the rotation
      // that the loss of that device makes necessary.
      context.cancelRotation(familyId, staging.key_epoch);
      // The epoch in force is the one already resolved: cancelling deletes the staging row and
      // leaves `family.key_epoch` alone, which is the whole point of being able to cancel.
      return { cancelledKeyEpoch: staging.key_epoch, keyEpoch: membership.keyEpoch };
    },
  );
}
