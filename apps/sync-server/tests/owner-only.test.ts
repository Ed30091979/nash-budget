/**
 * 5.3 and 5.5 step 1 — issuing an invite and declaring a rotation are the owner's, and the
 * document addresses both checks to this phase by name.
 *
 * The second one is not a matter of tidiness. `409 rotation_in_progress` stops writing for every
 * device in the family, the owner's own included, for as long as six hours; without the role check
 * any member's device closes the family's journal with one command. 5.5 says exactly that, and
 * says it costs one comparison to close.
 */
import { afterEach, expect, test } from "vitest";

import {
  addMember,
  call,
  createFamily,
  createHarness,
  signIn,
  uuid,
  type Harness,
} from "./support.ts";

let harness: Harness | undefined;

afterEach(async () => {
  await harness?.close();
  harness = undefined;
});

test("a member may not issue an invite and the owner may", async () => {
  harness = createHarness();
  const owner = await signIn(harness);
  const family = await createFamily(harness, owner);
  const { session: member } = await addMember(harness, owner, family);

  const record = {
    familyId: family.familyId,
    keyEpoch: 1,
    inviteId: uuid(),
    iv: Buffer.alloc(12, 1).toString("base64"),
    ciphertext: Buffer.alloc(64, 2).toString("base64"),
    authTokenDigest: Buffer.alloc(32, 3).toString("base64"),
  };
  const refused = await call(harness, "POST", `/v1/families/${family.familyId}/invites`, {
    token: member.accessToken,
    payload: record,
  });
  expect(refused.statusCode).toBe(403);
  expect(refused.json().error.code).toBe("owner_required");
  // The refusal is a refusal: nothing of the attempt was stored.
  const stored = harness.server.db
    .prepare("SELECT COUNT(*) AS n FROM invite WHERE invite_id = ?")
    .get(record.inviteId) as { n: number };
  expect(stored.n).toBe(0);

  const allowed = await call(harness, "POST", `/v1/families/${family.familyId}/invites`, {
    token: owner.accessToken,
    payload: record,
  });
  expect(allowed.statusCode).toBe(201);
}, 60_000);

test("a member may not declare a rotation and the owner may", async () => {
  harness = createHarness();
  const owner = await signIn(harness);
  const family = await createFamily(harness, owner);
  const { session: member } = await addMember(harness, owner, family);

  const refused = await call(harness, "POST", `/v1/families/${family.familyId}/rotation`, {
    token: member.accessToken,
    payload: { rotationId: uuid() },
  });
  expect(refused.statusCode).toBe(403);
  expect(refused.json().error.code).toBe("owner_required");
  // Writing is still open for everyone, which is the whole point of the check.
  expect(harness.server.context.stagingEpoch(family.familyId)).toBeUndefined();
  const write = await call(harness, "POST", `/v1/families/${family.familyId}/envelopes`, {
    token: member.accessToken,
    payload: {
      envelopes: [
        {
          envelopeVersion: 1,
          kind: "operation",
          familyId: family.familyId,
          opId: uuid(),
          deviceId: member.deviceId,
          keyEpoch: 1,
          iv: Buffer.alloc(12, 4).toString("base64"),
          ciphertext: Buffer.alloc(48, 5).toString("base64"),
        },
      ],
    },
  });
  expect(write.statusCode).toBe(200);

  const declared = await call(harness, "POST", `/v1/families/${family.familyId}/rotation`, {
    token: owner.accessToken,
    payload: { rotationId: uuid() },
  });
  expect(declared.statusCode).toBe(201);
  expect(declared.json()).toMatchObject({ keyEpoch: 2, previousKeyEpoch: 1, freezeSeq: 1 });
}, 60_000);

test("a member may not advance, complete or cancel a rotation", async () => {
  harness = createHarness();
  const owner = await signIn(harness);
  const family = await createFamily(harness, owner);
  const { session: member } = await addMember(harness, owner, family);
  const rotationId = uuid();
  const declared = await call(harness, "POST", `/v1/families/${family.familyId}/rotation`, {
    token: owner.accessToken,
    payload: { rotationId },
  });
  expect(declared.statusCode).toBe(201);

  for (const [method, url, payload] of [
    ["POST", `/v1/families/${family.familyId}/rotation/keys`, { rotationId, wraps: [] }],
    ["POST", `/v1/families/${family.familyId}/rotation/complete`, { rotationId }],
    ["DELETE", `/v1/families/${family.familyId}/rotation`, undefined],
  ] as const) {
    const response = await call(harness, method, url, {
      token: member.accessToken,
      ...(payload === undefined ? {} : { payload }),
    });
    expect(response.statusCode, url).toBe(403);
    expect(response.json().error.code, url).toBe("owner_required");
  }
  // And the attempt is still standing, untouched by the member's three tries.
  expect(harness.server.context.stagingEpoch(family.familyId)?.key_epoch).toBe(2);
}, 60_000);

test("a member may not remove another member; the owner may", async () => {
  harness = createHarness();
  const owner = await signIn(harness);
  const family = await createFamily(harness, owner);
  const { session: member, memberId } = await addMember(harness, owner, family);

  const refused = await call(
    harness,
    "DELETE",
    `/v1/families/${family.familyId}/members/${family.memberId}`,
    { token: member.accessToken },
  );
  expect(refused.statusCode).toBe(403);
  expect(refused.json().error.code).toBe("owner_required");

  const removed = await call(
    harness,
    "DELETE",
    `/v1/families/${family.familyId}/members/${memberId}`,
    { token: owner.accessToken },
  );
  expect(removed.statusCode).toBe(200);
  // 6.6: every device of the removed account loses access at once, and the rotation is still owed.
  expect(removed.json().rotationRequired).toBe(true);
  const afterwards = await call(harness, "GET", "/v1/families/me", { token: member.accessToken });
  expect(afterwards.statusCode).toBe(401);
  expect(afterwards.json().error.code).toBe("device_revoked");
}, 60_000);

test("another family's journal is 403, not an empty list", async () => {
  harness = createHarness();
  const owner = await signIn(harness);
  const family = await createFamily(harness, owner);
  const stranger = await signIn(harness);
  const otherFamily = await createFamily(harness, stranger);

  const read = await call(harness, "GET", `/v1/families/${family.familyId}/envelopes?keyEpoch=1`, {
    token: stranger.accessToken,
  });
  expect(read.statusCode).toBe(403);
  expect(read.json().error.code).toBe("forbidden");

  const write = await call(harness, "POST", `/v1/families/${family.familyId}/envelopes`, {
    token: stranger.accessToken,
    payload: { envelopes: [] },
  });
  expect(write.statusCode).toBe(400);
  expect(otherFamily.familyId).not.toBe(family.familyId);
});
