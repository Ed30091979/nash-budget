/**
 * 5.4, 6.4 and 6.7 — the device list and revocation.
 *
 * The list is the one 5.4 warns about at length: it is the server's, it is authenticated by
 * nothing, and a device that wraps the family key for a public key taken from it without checking
 * that key against its own pin has handed the server the family key. What the server owes is the
 * material the check needs — the SPKI, the `bindProof` and the `inviteId` — and never a verdict
 * about authenticity, which 2.2 forbids it to store.
 */
import { afterEach, expect, test } from "vitest";

import {
  addMember,
  call,
  createFamily,
  createHarness,
  signIn,
  spkiOf,
  type Harness,
} from "./support.ts";

let harness: Harness | undefined;

afterEach(async () => {
  await harness?.close();
  harness = undefined;
});

test("the device list carries the material a pin check needs and no verdict about it", async () => {
  harness = createHarness();
  const owner = await signIn(harness);
  const family = await createFamily(harness, owner);
  const { session: member, inviteId } = await addMember(harness, owner, family);

  const listed = await call(harness, "GET", `/v1/families/${family.familyId}/devices`, {
    token: owner.accessToken,
  });
  expect(listed.statusCode).toBe(200);
  const devices = listed.json().devices as Record<string, unknown>[];
  expect(devices).toHaveLength(2);
  const joined = devices.find((device) => device["deviceId"] === member.deviceId);
  expect(joined).toBeDefined();
  expect(joined?.["publicKey"]).toBe(Buffer.from(spkiOf(member.deviceId)).toString("base64"));
  // 5.4: the server keeps `bindProof` and the `inviteId` so the owner can recompute the HMAC on
  // its own `bindKey`. It cannot check them itself and stores no answer.
  expect(typeof joined?.["bindProof"]).toBe("string");
  expect(joined?.["inviteId"]).toBe(inviteId);
  for (const device of devices) {
    for (const field of Object.keys(device)) {
      expect(field).not.toMatch(/bound|verified|trusted|pinned|authentic/i);
    }
  }
  // A device that joined without an invite has nothing to show, and the absence is explicit.
  const ownerRow = devices.find((device) => device["deviceId"] === owner.deviceId);
  expect(ownerRow?.["bindProof"]).toBeNull();
  expect(ownerRow?.["inviteId"]).toBeNull();
}, 60_000);

test("a device is revoked by its own account or by the owner, and by nobody else", async () => {
  harness = createHarness();
  const owner = await signIn(harness);
  const family = await createFamily(harness, owner);
  const { session: member } = await addMember(harness, owner, family);
  // The owner of *another* family: authenticated, in a family, and entitled to nothing here.
  const stranger = await signIn(harness);
  await createFamily(harness, stranger);

  const outsider = await call(harness, "POST", `/v1/devices/${member.deviceId}/revoke`, {
    token: stranger.accessToken,
  });
  expect(outsider.statusCode).toBe(403);
  expect(outsider.json().error.code).toBe("forbidden");
  expect(
    (await call(harness, "GET", "/v1/families/me", { token: member.accessToken })).statusCode,
  ).toBe(200);

  const byOwner = await call(harness, "POST", `/v1/devices/${member.deviceId}/revoke`, {
    token: owner.accessToken,
  });
  expect(byOwner.statusCode).toBe(200);
  // 6.7: revocation is not the end of it — the family key is still on that device, so the screen
  // says "the key still works" until the owner has rotated.
  expect(byOwner.json().rotationRequired).toBe(true);
  const afterwards = await call(harness, "GET", "/v1/families/me", { token: member.accessToken });
  expect(afterwards.statusCode).toBe(401);
  expect(afterwards.json().error.code).toBe("device_revoked");
  // The row stays and is shown as revoked; 6.7 wants the family to see it.
  const listed = await call(harness, "GET", `/v1/families/${family.familyId}/devices`, {
    token: owner.accessToken,
  });
  const revoked = (listed.json().devices as Record<string, unknown>[]).find(
    (device) => device["deviceId"] === member.deviceId,
  );
  expect(revoked?.["revokedAt"]).toBe(harness.now);
}, 60_000);
