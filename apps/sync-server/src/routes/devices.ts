/**
 * Devices — 2.2, 6.4 and 6.7.
 *
 * The list this route serves is the one 5.4 warns about at length: it is the server's list, it is
 * not authenticated by anything, and a device that derives a key wrap for a public key taken from
 * it without checking that key against its own pin has handed the server the family key. The
 * server cannot enforce that; it is the sending device's precondition. What the server can do is
 * serve exactly the fields the pin check needs — the SPKI, the `bindProof` and the `inviteId` — so
 * that the check is possible at all, and never a verdict about authenticity, which 2.2 forbids it
 * to store.
 */
import type { FastifyInstance } from "fastify";

import { toBase64 } from "../bytes.ts";
import type { ServerContext } from "../context.ts";
import { forbidden, notFound } from "../errors.ts";
import { body, uuidField } from "./fields.ts";

interface DeviceListRow {
  readonly device_id: string;
  readonly member_id: string;
  readonly public_key: Uint8Array;
  readonly bind_proof: Uint8Array | null;
  readonly invite_id: string | null;
  readonly created_at: number;
  readonly last_seen_at: number;
  readonly revoked_at: number | null;
}

export function registerDeviceRoutes(app: FastifyInstance, context: ServerContext): void {
  app.get(
    "/v1/families/:familyId/devices",
    { schema: { params: body({ familyId: uuidField }, ["familyId"]) } },
    async (request) => {
      const auth = context.authenticate(request);
      const { familyId } = request.params as { familyId: string };
      const membership = context.requireFamily(auth, familyId);
      const rows = context.db
      .prepare(
        "SELECT d.device_id, m.member_id, d.public_key, d.bind_proof, d.invite_id," +
          " d.created_at, d.last_seen_at, d.revoked_at" +
          " FROM device d JOIN member m ON m.account_id = d.account_id" +
          " WHERE m.family_id = ? AND m.removed_at IS NULL" +
          " ORDER BY d.created_at, d.device_id",
      )
        .all(membership.familyId) as DeviceListRow[];
      return {
        devices: rows.map((row) => ({
          deviceId: row.device_id,
          memberId: row.member_id,
          publicKey: toBase64(new Uint8Array(row.public_key)),
          bindProof: row.bind_proof === null ? null : toBase64(new Uint8Array(row.bind_proof)),
          inviteId: row.invite_id,
          createdAt: row.created_at,
          lastSeenAt: row.last_seen_at,
          revokedAt: row.revoked_at,
        })),
      };
    },
  );

  app.post(
    "/v1/devices/:deviceId/revoke",
    { schema: { params: body({ deviceId: uuidField }, ["deviceId"]) } },
    async (request) => {
      const auth = context.authenticate(request);
      const { deviceId } = request.params as { deviceId: string };
      const target = context.db
        .prepare("SELECT device_id, account_id, revoked_at FROM device WHERE device_id = ?")
        .get(deviceId) as
        | { device_id: string; account_id: string; revoked_at: number | null }
        | undefined;
      if (target === undefined) throw notFound("no such device");

      // 6.7: the owner of the family revokes any device in it; anyone revokes their own. Both
      // paths exist in the document — "устройство отзывается владельцем или самим участником".
      let allowed = target.account_id === auth.accountId;
      if (!allowed) {
        const membership = context.requireMembership(auth);
        const sameFamily = context.db
          .prepare(
            "SELECT member_id FROM member WHERE family_id = ? AND account_id = ? AND removed_at IS NULL",
          )
          .get(membership.familyId, target.account_id);
        allowed = membership.role === "owner" && sameFamily !== undefined;
      }
      if (!allowed) throw forbidden("forbidden", "not entitled to revoke this device");

      const now = context.now();
      if (target.revoked_at === null) {
        context.db
          .prepare(
            "UPDATE device SET revoked_at = ?, refresh_token_hash = NULL," +
              " refresh_expires_at = NULL WHERE device_id = ?",
          )
          .run(now, deviceId);
      }
      // The flag is not politeness. 5.5 makes rotation mandatory after a revocation, and 6.7 says
      // the family screen shows the revoked device as "the key still works" until it happens.
      return { deviceId, revokedAt: target.revoked_at ?? now, rotationRequired: true };
    },
  );
}
