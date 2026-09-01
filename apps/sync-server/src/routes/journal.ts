/**
 * The journal — 3.3 and 3.4.
 *
 * This is the whole of what the server does with the family's data: it takes opaque envelopes,
 * gives each a number that is monotone within its epoch, and hands them back in that order. It
 * cannot read one, cannot merge two and takes no part in resolving a conflict.
 *
 * One rule here is easier to get wrong than to get right, and 3.3 addresses it to this phase by
 * name: the server must **not** require the `deviceId` in an envelope header to match the device
 * presenting the token. The check looks obvious and breaks rotation outright — at step 4 of 5.5
 * the owner's device uploads the re-encrypted journal of the whole family, every envelope of which
 * keeps its original author. Belonging is decided by `familyId` plus membership, never by
 * authorship, and the mistake would be silent until the family's first rotation.
 */
import type { FastifyInstance } from "fastify";

import { toBase64 } from "../bytes.ts";
import type { ServerContext } from "../context.ts";
import { ApiError, conflict, forbidden } from "../errors.ts";
import {
  AES_GCM_IV_BYTES,
  DEFAULT_FETCH_LIMIT,
  ENVELOPE_BATCHES_PER_WINDOW,
  ENVELOPE_BATCH_WINDOW_MS,
  ENVELOPE_KINDS,
  FAMILY_ENVELOPE_QUOTA,
  FAMILY_EPOCH_CIPHERTEXT_BYTES,
  MAX_CHECKPOINT_CIPHERTEXT_BYTES,
  MAX_ENVELOPES_PER_BATCH,
  MAX_FETCH_LIMIT,
  MAX_OPERATION_CIPHERTEXT_BYTES,
  type EnvelopeKind,
} from "../limits.ts";
import { decodeBytes } from "./decode.ts";
import { base64Field, body, epochField, numericQueryField, uuidField } from "./fields.ts";

interface EnvelopeInput {
  readonly envelopeVersion: number;
  readonly kind: EnvelopeKind;
  readonly familyId: string;
  readonly opId: string;
  readonly deviceId: string;
  readonly keyEpoch: number;
  readonly iv: string;
  readonly ciphertext: string;
}

const envelopeSchema = body(
  {
    // Not checked against a known value. 2.2 puts the version in the clear precisely so that it
    // can be read before decryption, and the reader that acts on it is the client (3.4 step 4).
    // A server that refused an unknown version would be deciding which formats a family may use.
    envelopeVersion: { type: "integer", minimum: 1, maximum: 65535 },
    // The two values 2.2 names, as a closed set. It was open once, on the argument that the server
    // should not decide which formats a family may use — but `kind` is not only read here, it is
    // what `ciphertextLimit` picks the size bound by. Open, it let any sender award itself the
    // larger bound by writing a word of its own choosing, and the `8` KiB of 3.2 rested on the
    // client's word about itself. 2.2 enumerates the field; the schema now says the same.
    kind: { type: "string", enum: [...ENVELOPE_KINDS] },
    familyId: uuidField,
    opId: uuidField,
    deviceId: uuidField,
    keyEpoch: epochField,
    iv: base64Field(AES_GCM_IV_BYTES, AES_GCM_IV_BYTES),
    ciphertext: base64Field(MAX_CHECKPOINT_CIPHERTEXT_BYTES, 1),
  },
  ["envelopeVersion", "kind", "familyId", "opId", "deviceId", "keyEpoch", "iv", "ciphertext"],
);

/**
 * 3.2 caps an encoded operation at `8` KiB; the server sees the ciphertext, which is that plus the
 * `128`-bit tag. A checkpoint (3.6) is not an operation and has no documented size, so it gets the
 * bound chosen in `limits.ts` and named there as a phase-S3 decision.
 *
 * The larger bound is no longer free for the asking. Two things now stand behind it: the schema
 * accepts only the two kinds 2.2 names, and the epoch budget below is charged in bytes, so a
 * checkpoint spends eight operations' worth of it. Which of the two a family writes is still the
 * family's business; how much it may store is not.
 */
function ciphertextLimit(kind: EnvelopeKind): number {
  return kind === "checkpoint" ? MAX_CHECKPOINT_CIPHERTEXT_BYTES : MAX_OPERATION_CIPHERTEXT_BYTES;
}

export function registerJournalRoutes(app: FastifyInstance, context: ServerContext): void {
  app.post(
    "/v1/families/:familyId/envelopes",
    {
      schema: {
        params: body({ familyId: uuidField }, ["familyId"]),
        body: body(
          {
            envelopes: {
              type: "array",
              minItems: 1,
              maxItems: MAX_ENVELOPES_PER_BATCH,
              items: envelopeSchema,
            },
          },
          ["envelopes"],
        ),
      },
    },
    async (request) => {
      const auth = context.authenticate(request);
      const { familyId } = request.params as { familyId: string };
      const membership = context.requireFamily(auth, familyId);
      const bucket = `envelopes:${auth.deviceId}`;
      context.throttleSweep("envelopes:", ENVELOPE_BATCH_WINDOW_MS);
      if (context.throttleCount(bucket, ENVELOPE_BATCH_WINDOW_MS) >= ENVELOPE_BATCHES_PER_WINDOW) {
        throw new ApiError(429, "rate_limited", "too many submissions from this device");
      }
      context.throttleRecord(bucket);

      const { envelopes } = request.body as { envelopes: EnvelopeInput[] };
      const decoded = envelopes.map((envelope) => {
        if (envelope.familyId !== membership.familyId) {
          throw forbidden("forbidden", "envelope addressed to another family");
        }
        return {
          ...envelope,
          ivBytes: decodeBytes(envelope.iv, "iv", { exact: AES_GCM_IV_BYTES }),
          ciphertextBytes: decodeBytes(envelope.ciphertext, "ciphertext", {
            min: 1,
            max: ciphertextLimit(envelope.kind),
          }),
        };
      });

      // 3.3 step 2. A staging epoch closes writing for everyone, the owner's own device included,
      // with exactly one exception: the envelopes of that staging epoch, from the device leading
      // the rotation. Without the exception the new epoch could not be loaded at all; with it
      // widened by one device, the rotation would be racing the very writes it exists to freeze.
      const staging = context.stagingEpoch(membership.familyId);
      let targetEpoch: number;
      if (staging !== undefined) {
        const allStaging = decoded.every((envelope) => envelope.keyEpoch === staging.key_epoch);
        if (!allStaging || auth.deviceId !== staging.rotating_device_id) {
          throw conflict("rotation_in_progress", "a key rotation is in progress for this family", {
            keyEpoch: membership.keyEpoch,
            stagingKeyEpoch: staging.key_epoch,
          });
        }
        targetEpoch = staging.key_epoch;
      } else {
        // 3.3 step 3. The whole batch is refused rather than the offending envelope, because 3.3
        // also says a `409` of any kind leaves the client's queue intact: a partially accepted
        // batch would have to be reconciled against a queue that was never cleared.
        const allCurrent = decoded.every((envelope) => envelope.keyEpoch === membership.keyEpoch);
        if (!allCurrent) {
          throw conflict("epoch_mismatch", "the batch names a key epoch that is not in force", {
            keyEpoch: membership.keyEpoch,
          });
        }
        targetEpoch = membership.keyEpoch;
      }

      const epoch = context.activeEpoch(membership.familyId, targetEpoch);
      if (epoch === undefined) throw new ApiError(500, "internal", "epoch row is missing");

      const now = context.now();
      const selectExisting = context.db.prepare(
        "SELECT seq FROM envelope WHERE family_id = ? AND key_epoch = ? AND op_id = ?",
      );
      const insert = context.db.prepare(
        "INSERT INTO envelope (family_id, key_epoch, op_id, seq, envelope_version, kind," +
          " device_id, iv, ciphertext, received_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      );
      const countRow = context.db.prepare(
        "SELECT COUNT(*) AS n FROM envelope WHERE family_id = ? AND key_epoch = ?",
      );

      // One transaction for the whole batch — 3.3 says "в одной транзакции" — and the driver is
      // synchronous, so nothing can interleave between the count, the numbering and the insert.
      const assign = context.db.transaction(() => {
        let counter = epoch.seq_counter;
        let stored = (countRow.get(membership.familyId, targetEpoch) as { n: number }).n;
        let bytes = epoch.ciphertext_bytes;
        let written = 0;
        const accepted: { opId: string; seq: number }[] = [];
        for (const envelope of decoded) {
          const existing = selectExisting.get(membership.familyId, targetEpoch, envelope.opId) as
            | { seq: number }
            | undefined;
          if (existing !== undefined) {
            // 3.3 step 6 and 3.5: a repeat of the same `opId` returns the number it already has.
            // A dropped connection after the write but before the answer is an ordinary event,
            // and the client's queue is cleared only by a confirmed `seq`.
            accepted.push({ opId: envelope.opId, seq: existing.seq });
            continue;
          }
          if (stored >= FAMILY_ENVELOPE_QUOTA) {
            throw conflict("quota_exhausted", "the family quota for this epoch is exhausted", {
              keyEpoch: targetEpoch,
              quota: FAMILY_ENVELOPE_QUOTA,
            });
          }
          // The same budget of 3.2.1, in the unit the count silently assumed. `100 000` envelopes
          // meant `100 000` operations of `8` KiB; at the checkpoint bound the identical count is
          // eight times the storage, and the difference was one word in a field the sender writes.
          // Charged in bytes it does not matter what the envelope calls itself.
          if (bytes + envelope.ciphertextBytes.length > FAMILY_EPOCH_CIPHERTEXT_BYTES) {
            throw conflict("quota_exhausted", "the family byte budget for this epoch is exhausted", {
              keyEpoch: targetEpoch,
              quota: FAMILY_ENVELOPE_QUOTA,
              quotaBytes: FAMILY_EPOCH_CIPHERTEXT_BYTES,
            });
          }
          counter += 1;
          stored += 1;
          written += 1;
          bytes += envelope.ciphertextBytes.length;
          insert.run(
            membership.familyId,
            targetEpoch,
            envelope.opId,
            counter,
            envelope.envelopeVersion,
            envelope.kind,
            envelope.deviceId,
            envelope.ivBytes,
            envelope.ciphertextBytes,
            now,
          );
          accepted.push({ opId: envelope.opId, seq: counter });
        }
        context.db
          .prepare(
            "UPDATE epoch SET seq_counter = ?, ciphertext_bytes = ?" +
              " WHERE family_id = ? AND key_epoch = ?",
          )
          .run(counter, bytes, membership.familyId, targetEpoch);
        if (staging !== undefined && written > 0) {
          // 5.5: every accepted staging batch is progress, and progress is what the idle timeout
          // measures. Without this the thirty-minute timer would cancel a rotation that is
          // visibly working, and a large journal on a slow link would never finish.
          //
          // `written > 0` is the other half of the same sentence. A batch of nothing but repeats
          // is accepted — 3.5 requires it — but it moves no journal, and letting it move the mark
          // would hand any device leading a rotation a way to hold the family in "writing closed"
          // for the six hours of the hard ceiling by resending one envelope it already sent.
          context.db
            .prepare("UPDATE epoch SET last_progress_at = ? WHERE family_id = ? AND key_epoch = ?")
            .run(now, membership.familyId, targetEpoch);
        }
        return accepted;
      });

      return { keyEpoch: targetEpoch, accepted: assign() };
    },
  );

  app.get(
    "/v1/families/:familyId/envelopes",
    {
      schema: {
        params: body({ familyId: uuidField }, ["familyId"]),
        querystring: body({ keyEpoch: numericQueryField, after: numericQueryField, limit: numericQueryField }, [
          "keyEpoch",
        ]),
      },
    },
    async (request) => {
      const auth = context.authenticate(request);
      const { familyId } = request.params as { familyId: string };
      const membership = context.requireFamily(auth, familyId);
      const query = request.query as { keyEpoch: string; after?: string; limit?: string };
      const keyEpoch = Number(query.keyEpoch);
      const after = query.after === undefined ? 0 : Number(query.after);
      const limit = Math.min(
        query.limit === undefined ? DEFAULT_FETCH_LIMIT : Number(query.limit),
        MAX_FETCH_LIMIT,
      );
      if (limit < 1) throw new ApiError(400, "invalid_request", "limit must be at least 1");

      // 3.4, last part: a cursor on a stale epoch is answered with `409 epoch_mismatch` on the
      // *fetch* as well, not with an empty list. A reading member who never sends anything would
      // otherwise take silence for "no news" and stay on the old epoch for ever, quietly stopping
      // to see the family at all.
      if (keyEpoch !== membership.keyEpoch) {
        throw conflict("epoch_mismatch", "the cursor names a key epoch that is not in force", {
          keyEpoch: membership.keyEpoch,
        });
      }

      const rows = context.db
        .prepare(
          "SELECT op_id, seq, envelope_version, kind, device_id, iv, ciphertext, received_at" +
            " FROM envelope WHERE family_id = ? AND key_epoch = ? AND seq > ?" +
            " ORDER BY seq ASC LIMIT ?",
        )
        .all(membership.familyId, keyEpoch, after, limit + 1) as {
        op_id: string;
        seq: number;
        envelope_version: number;
        kind: string;
        device_id: string;
        iv: Uint8Array;
        ciphertext: Uint8Array;
        received_at: number;
      }[];
      const hasMore = rows.length > limit;
      const page = hasMore ? rows.slice(0, limit) : rows;
      return {
        keyEpoch,
        // A hint for paging and nothing more. 3.6 is explicit that the client must decide the end
        // of the journal for itself — a server that left this true for ever would otherwise switch
        // off checkpoint comparison, the only defence against a truncated journal, with one bool.
        hasMore,
        envelopes: page.map((row) => ({
          envelopeVersion: row.envelope_version,
          kind: row.kind,
          familyId: membership.familyId,
          opId: row.op_id,
          deviceId: row.device_id,
          keyEpoch,
          seq: row.seq,
          receivedAt: row.received_at,
          iv: toBase64(new Uint8Array(row.iv)),
          ciphertext: toBase64(new Uint8Array(row.ciphertext)),
        })),
      };
    },
  );
}
