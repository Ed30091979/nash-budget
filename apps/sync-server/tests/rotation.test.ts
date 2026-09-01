/**
 * 5.5 — the server's part of a rotation, on values.
 *
 * While an epoch is `staging`, writing is closed for the whole family with one exception: the
 * envelopes of that staging epoch from the device leading the rotation. The exception is what
 * makes a rotation possible at all; widened by one device it would be racing the very writes it
 * exists to freeze, so both halves are checked here.
 */
import { afterEach, expect, test } from "vitest";

import { ROTATION_HARD_TIMEOUT_MS, ROTATION_IDLE_TIMEOUT_MS } from "../src/limits.ts";
import {
  addMember,
  call,
  createFamily,
  createHarness,
  envelope,
  refreshSession,
  signIn,
  uuid,
  type Family,
  type Harness,
  type Session,
} from "./support.ts";

let harness: Harness | undefined;

afterEach(async () => {
  await harness?.close();
  harness = undefined;
});

const send = (h: Harness, session: Session, family: Family, envelopes: unknown[]) =>
  call(h, "POST", `/v1/families/${family.familyId}/envelopes`, {
    token: session.accessToken,
    payload: { envelopes },
  });

async function familyOfTwo(h: Harness) {
  const owner = await signIn(h);
  const family = await createFamily(h, owner);
  const { session: member, memberId } = await addMember(h, owner, family);
  return { owner, family, member, memberId };
}

test("during a rotation the old epoch is closed to everyone and the new one only to the leader", async () => {
  harness = createHarness();
  const { owner, family, member } = await familyOfTwo(harness);
  expect((await send(harness, owner, family, [envelope(family.familyId, owner.deviceId, 1)])).statusCode).toBe(200);

  const rotationId = uuid();
  const declared = await call(harness, "POST", `/v1/families/${family.familyId}/rotation`, {
    token: owner.accessToken,
    payload: { rotationId },
  });
  expect(declared.statusCode).toBe(201);
  expect(declared.json()).toMatchObject({
    keyEpoch: 2,
    previousKeyEpoch: 1,
    freezeSeq: 1,
    rotatingDeviceId: owner.deviceId,
  });

  // The old epoch is closed for the member and for the owner alike — 5.5 step 1 says "including
  // the owner's own device".
  for (const sender of [member, owner]) {
    const refused = await send(harness, sender, family, [
      envelope(family.familyId, sender.deviceId, 1),
    ]);
    expect(refused.statusCode).toBe(409);
    expect(refused.json()).toMatchObject({
      error: { code: "rotation_in_progress", keyEpoch: 1, stagingKeyEpoch: 2 },
    });
  }

  // The new epoch is open to the leading device only.
  const fromMember = await send(harness, member, family, [
    envelope(family.familyId, member.deviceId, 2),
  ]);
  expect(fromMember.statusCode).toBe(409);
  expect(fromMember.json().error.code).toBe("rotation_in_progress");

  // 5.5 step 4: the leader uploads envelopes whose author is another device, and the server must
  // not object — a check of the header's `deviceId` against the token would break rotation (3.3).
  const staged = await send(harness, owner, family, [
    envelope(family.familyId, member.deviceId, 2),
    envelope(family.familyId, owner.deviceId, 2),
  ]);
  expect(staged.statusCode).toBe(200);
  // The staging epoch has its own counter, started at zero at step 1.
  expect(staged.json()).toMatchObject({ keyEpoch: 2 });
  expect(staged.json().accepted.map((a: { seq: number }) => a.seq)).toEqual([1, 2]);

  // A batch that mixes epochs is refused whole, even from the leader.
  const mixed = await send(harness, owner, family, [
    envelope(family.familyId, owner.deviceId, 2),
    envelope(family.familyId, owner.deviceId, 1),
  ]);
  expect(mixed.statusCode).toBe(409);
  expect(mixed.json().error.code).toBe("rotation_in_progress");

  // Nothing of the staging epoch is served to anyone until it is switched over.
  const read = await call(
    harness,
    "GET",
    `/v1/families/${family.familyId}/envelopes?keyEpoch=2&after=0`,
    { token: member.accessToken },
  );
  expect(read.statusCode).toBe(409);
  expect(read.json()).toMatchObject({ error: { code: "epoch_mismatch", keyEpoch: 1 } });
}, 60_000);

test("completing the rotation switches the epoch, deletes the old journal and keeps the wraps", async () => {
  harness = createHarness();
  const { owner, family, member } = await familyOfTwo(harness);
  await send(harness, owner, family, [envelope(family.familyId, owner.deviceId, 1)]);
  const rotationId = uuid();
  await call(harness, "POST", `/v1/families/${family.familyId}/rotation`, {
    token: owner.accessToken,
    payload: { rotationId },
  });
  await send(harness, owner, family, [envelope(family.familyId, member.deviceId, 2)]);

  const wrap = {
    deviceId: member.deviceId,
    senderDeviceId: owner.deviceId,
    salt: Buffer.alloc(32, 4).toString("base64"),
    iv: Buffer.alloc(12, 5).toString("base64"),
    ciphertext: Buffer.alloc(48, 6).toString("base64"),
  };
  const keys = await call(harness, "POST", `/v1/families/${family.familyId}/rotation/keys`, {
    token: owner.accessToken,
    payload: {
      rotationId,
      epochConfirm: Buffer.alloc(32, 7).toString("base64"),
      wraps: [wrap],
    },
  });
  expect(keys.statusCode).toBe(200);
  expect(keys.json().wraps).toBe(1);

  const completed = await call(harness, "POST", `/v1/families/${family.familyId}/rotation/complete`, {
    token: owner.accessToken,
    payload: { rotationId },
  });
  expect(completed.statusCode).toBe(200);
  expect(completed.json()).toMatchObject({ keyEpoch: 2, previousKeyEpoch: 1 });

  // 5.5 step 7: the old epoch's envelopes are gone physically, and the new epoch's counter is not
  // reset — the transferred journal already occupies those numbers.
  const remaining = harness.server.db
    .prepare("SELECT key_epoch, COUNT(*) AS n FROM envelope WHERE family_id = ? GROUP BY key_epoch")
    .all(family.familyId) as { key_epoch: number; n: number }[];
  expect(remaining).toEqual([{ key_epoch: 2, n: 1 }]);
  const next = await send(harness, owner, family, [envelope(family.familyId, owner.deviceId, 2)]);
  expect(next.json().accepted[0].seq).toBe(2);

  // The wrap and the confirmation survive the deletion: the catch-up chain of 5.4 needs them.
  const served = await call(harness, "GET", `/v1/families/${family.familyId}/keys`, {
    token: member.accessToken,
  });
  expect(served.statusCode).toBe(200);
  expect(served.json()).toMatchObject({ keyEpoch: 2 });
  expect(served.json().wraps).toHaveLength(1);
  expect(served.json().wraps[0]).toMatchObject({
    keyEpoch: 2,
    deviceId: member.deviceId,
    senderDeviceId: owner.deviceId,
    rotationId,
    salt: wrap.salt,
    iv: wrap.iv,
    ciphertext: wrap.ciphertext,
    rotateConfirm: Buffer.alloc(32, 7).toString("base64"),
  });
  // A device is served its own wraps and nobody else's.
  const ownerSees = await call(harness, "GET", `/v1/families/${family.familyId}/keys`, {
    token: owner.accessToken,
  });
  expect(ownerSees.json().wraps).toEqual([]);
}, 60_000);

test("a cancelled attempt takes its epoch number with it", async () => {
  harness = createHarness();
  const owner = await signIn(harness);
  const family = await createFamily(harness, owner);

  const first = uuid();
  const declared = await call(harness, "POST", `/v1/families/${family.familyId}/rotation`, {
    token: owner.accessToken,
    payload: { rotationId: first },
  });
  expect(declared.json().keyEpoch).toBe(2);
  await send(harness, owner, family, [envelope(family.familyId, owner.deviceId, 2)]);

  const cancelled = await call(harness, "DELETE", `/v1/families/${family.familyId}/rotation`, {
    token: owner.accessToken,
  });
  expect(cancelled.statusCode).toBe(200);
  expect(cancelled.json()).toMatchObject({ cancelledKeyEpoch: 2, keyEpoch: 1 });
  const leftovers = harness.server.db
    .prepare("SELECT COUNT(*) AS n FROM envelope WHERE family_id = ? AND key_epoch = 2")
    .get(family.familyId) as { n: number };
  expect(leftovers.n).toBe(0);

  // 5.4: the number of a cancelled attempt is never handed out again. The retry is epoch 3.
  const retry = await call(harness, "POST", `/v1/families/${family.familyId}/rotation`, {
    token: owner.accessToken,
    payload: { rotationId: uuid() },
  });
  expect(retry.json().keyEpoch).toBe(3);
  // And writing to the epoch in force is open again in between, which is what cancelling is for.
  expect(harness.server.context.stagingEpoch(family.familyId)?.key_epoch).toBe(3);
});

test("cancelling asks whether there is an attempt to cancel before it deletes anything", async () => {
  harness = createHarness();
  const owner = await signIn(harness);
  const family = await createFamily(harness, owner);
  expect((await send(harness, owner, family, [envelope(family.familyId, owner.deviceId, 1)])).statusCode).toBe(200);

  // The epoch in force, handed to the function that cancels attempts. Its `state = 'staging'`
  // condition carries the whole decision, and while it stood at the end of the transaction it
  // guarded only the row: everything else — the family's envelopes, its wraps, its confirmation —
  // was already deleted by the time the condition was consulted. Nothing in the server calls it
  // this way today, which is exactly why the order needs holding down.
  harness.server.context.cancelRotation(family.familyId, 1);

  const kept = harness.server.db
    .prepare("SELECT COUNT(*) AS n FROM envelope WHERE family_id = ? AND key_epoch = 1")
    .get(family.familyId) as { n: number };
  expect(kept.n).toBe(1);
  expect(harness.server.context.activeEpoch(family.familyId, 1)?.state).toBe("active");
  const journal = await call(
    harness,
    "GET",
    `/v1/families/${family.familyId}/envelopes?keyEpoch=1&after=0`,
    { token: owner.accessToken },
  );
  expect(journal.json().envelopes).toHaveLength(1);
});

test("a rotation is cancelled after 30 idle minutes and after 6 hours regardless of progress", async () => {
  harness = createHarness();
  const owner = await signIn(harness);
  const family = await createFamily(harness, owner);

  await call(harness, "POST", `/v1/families/${family.familyId}/rotation`, {
    token: owner.accessToken,
    payload: { rotationId: uuid() },
  });
  harness.advance(ROTATION_IDLE_TIMEOUT_MS - 1000);
  await refreshSession(harness, owner);
  const stillOpen = await send(harness, owner, family, [
    envelope(family.familyId, owner.deviceId, 1),
  ]);
  expect(stillOpen.statusCode).toBe(409);
  expect(stillOpen.json().error.code).toBe("rotation_in_progress");

  harness.advance(2000);
  await refreshSession(harness, owner);
  // The sweep runs on the next family-scoped request, so the write that was refused a second ago
  // is now the write that succeeds — into the epoch that is still in force.
  const reopened = await send(harness, owner, family, [
    envelope(family.familyId, owner.deviceId, 1),
  ]);
  expect(reopened.statusCode).toBe(200);
  expect(reopened.json().keyEpoch).toBe(1);

  // The hard ceiling: an attempt that reports progress every ten minutes is still cancelled at six
  // hours, because `409 rotation_in_progress` is a stop on writing for the whole family.
  const rotationId = uuid();
  const second = await call(harness, "POST", `/v1/families/${family.familyId}/rotation`, {
    token: owner.accessToken,
    payload: { rotationId },
  });
  expect(second.json().keyEpoch).toBe(3);
  const staged = second.json().keyEpoch;
  for (let elapsed = 0; elapsed < ROTATION_HARD_TIMEOUT_MS; elapsed += 10 * 60 * 1000) {
    harness.advance(10 * 60 * 1000);
    await refreshSession(harness, owner);
    const progress = await send(harness, owner, family, [
      envelope(family.familyId, owner.deviceId, staged),
    ]);
    if (progress.statusCode !== 200) {
      expect(progress.json().error.code).toBe("epoch_mismatch");
      break;
    }
  }
  expect(harness.server.context.stagingEpoch(family.familyId)).toBeUndefined();
  const afterCeiling = await call(harness, "GET", "/v1/families/me", { token: owner.accessToken });
  expect(afterCeiling.json().keyEpoch).toBe(1);
  expect(afterCeiling.json().rotation).toBeNull();
});

test("an out-of-rotation wrap is written once and never replaced", async () => {
  harness = createHarness();
  const { owner, family, member } = await familyOfTwo(harness);
  const wrap = {
    deviceId: member.deviceId,
    salt: Buffer.alloc(32, 1).toString("base64"),
    iv: Buffer.alloc(12, 2).toString("base64"),
    ciphertext: Buffer.alloc(48, 3).toString("base64"),
  };
  const issued = await call(harness, "POST", `/v1/families/${family.familyId}/keys`, {
    token: owner.accessToken,
    payload: wrap,
  });
  expect(issued.statusCode).toBe(201);
  expect(issued.json()).toMatchObject({
    keyEpoch: 1,
    deviceId: member.deviceId,
    senderDeviceId: owner.deviceId,
    rotationId: family.rotationId,
  });

  // 5.5, last part: a device that already holds this epoch's key never accepts another wrap of it,
  // and the server refuses to overwrite the row rather than offer a key change without an epoch
  // change — the exact move the continuity chain of 5.4 exists to make impossible.
  const again = await call(harness, "POST", `/v1/families/${family.familyId}/keys`, {
    token: owner.accessToken,
    payload: { ...wrap, ciphertext: Buffer.alloc(48, 9).toString("base64") },
  });
  expect(again.statusCode).toBe(409);
  expect(again.json().error.code).toBe("wrap_exists");
  const stored = await call(harness, "GET", `/v1/families/${family.familyId}/keys`, {
    token: member.accessToken,
  });
  expect(stored.json().wraps[0].ciphertext).toBe(wrap.ciphertext);
  // No rotation happened: the epoch in force is untouched, and there is no confirmation to give.
  expect(stored.json().keyEpoch).toBe(1);
  expect(stored.json().wraps[0].rotateConfirm).toBeNull();

  // A wrap for a device outside the family is refused whatever it contains.
  const stranger = await signIn(harness);
  const outside = await call(harness, "POST", `/v1/families/${family.familyId}/keys`, {
    token: owner.accessToken,
    payload: { ...wrap, deviceId: stranger.deviceId },
  });
  expect(outside.statusCode).toBe(403);
  expect(outside.json().error.code).toBe("forbidden");
}, 60_000);

test("a member may not hold another device's wrap slot against the owner", async () => {
  harness = createHarness();
  const { owner, family, member } = await familyOfTwo(harness);
  const { session: third } = await addMember(harness, owner, family);
  const slot = {
    deviceId: third.deviceId,
    salt: Buffer.alloc(32, 4).toString("base64"),
    iv: Buffer.alloc(12, 5).toString("base64"),
    ciphertext: Buffer.alloc(48, 6).toString("base64"),
  };
  const url = `/v1/families/${family.familyId}/keys`;

  // 5.6 path «в» lets any member wrap the key for another device, so a member gets there first.
  const squatted = await call(harness, "POST", url, {
    token: member.accessToken,
    payload: slot,
  });
  expect(squatted.statusCode).toBe(201);

  // Written once must not mean "whoever wrote first decides". The owner replaces a wrap the owner
  // did not place; otherwise a member's one request would deny the whole family the path of 5.5
  // that exists precisely so that a rotation is not needed.
  const real = { ...slot, ciphertext: Buffer.alloc(48, 7).toString("base64") };
  const replaced = await call(harness, "POST", url, { token: owner.accessToken, payload: real });
  expect(replaced.statusCode).toBe(201);
  expect(replaced.json().replacedSenderDeviceId).toBe(member.deviceId);
  const listed = await call(harness, "GET", url, { token: third.accessToken });
  expect(listed.json().wraps).toHaveLength(1);
  expect(listed.json().wraps[0].ciphertext).toBe(real.ciphertext);
  expect(listed.json().wraps[0].senderDeviceId).toBe(owner.deviceId);

  // And once the wrap is the owner's, it is written once again — for the member, and for the
  // owner too. 5.5 keeps the row it protects.
  const memberAgain = await call(harness, "POST", url, {
    token: member.accessToken,
    payload: { ...slot, ciphertext: Buffer.alloc(48, 8).toString("base64") },
  });
  expect(memberAgain.statusCode).toBe(409);
  expect(memberAgain.json().error.code).toBe("wrap_exists");
  const ownerAgain = await call(harness, "POST", url, {
    token: owner.accessToken,
    payload: { ...slot, ciphertext: Buffer.alloc(48, 9).toString("base64") },
  });
  expect(ownerAgain.statusCode).toBe(409);
  expect(ownerAgain.json().error.code).toBe("wrap_exists");
}, 60_000);


test("an empty progress request does not postpone the idle timeout", async () => {
  harness = createHarness();
  const owner = await signIn(harness);
  const family = await createFamily(harness, owner);
  const rotationId = uuid();
  const declared = await call(harness, "POST", `/v1/families/${family.familyId}/rotation`, {
    token: owner.accessToken,
    payload: { rotationId },
  });
  expect(declared.statusCode).toBe(201);

  // One minute short of the thirty of 5.5, the leading device sends a request that carries
  // nothing: no wrap, no confirmation. It is accepted — there is nothing wrong with it — and it is
  // not progress. Counted as progress it would let the device hold the family in "writing closed"
  // for the whole six-hour ceiling by sending the same emptiness twice an hour.
  harness.advance(ROTATION_IDLE_TIMEOUT_MS - 60_000);
  await refreshSession(harness, owner);
  const empty = await call(harness, "POST", `/v1/families/${family.familyId}/rotation/keys`, {
    token: owner.accessToken,
    payload: { rotationId },
  });
  expect(empty.statusCode).toBe(200);
  expect(empty.json().lastProgressAt).toBe(declared.json().startedAt);

  harness.advance(60_001);
  await refreshSession(harness, owner);
  const swept = await call(harness, "GET", "/v1/families/me", { token: owner.accessToken });
  expect(swept.json().rotation).toBeNull();
  expect(swept.json().keyEpoch).toBe(1);

  // A request that carries something is progress, and moves the mark: the difference is what was
  // written, not what was asked for.
  const second = uuid();
  const restarted = await call(harness, "POST", `/v1/families/${family.familyId}/rotation`, {
    token: owner.accessToken,
    payload: { rotationId: second },
  });
  expect(restarted.statusCode).toBe(201);
  harness.advance(60_000);
  await refreshSession(harness, owner);
  const real = await call(harness, "POST", `/v1/families/${family.familyId}/rotation/keys`, {
    token: owner.accessToken,
    payload: { rotationId: second, epochConfirm: Buffer.alloc(32, 6).toString("base64") },
  });
  expect(real.statusCode).toBe(200);
  expect(real.json().lastProgressAt).toBe(harness.now);
}, 60_000);
