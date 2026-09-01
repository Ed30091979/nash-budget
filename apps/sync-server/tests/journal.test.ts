/**
 * 3.3, 3.4 and 3.5 on concrete numbers.
 *
 * The plan's acceptance for this phase is stated in values, and so is this file: twelve envelopes
 * from two devices of one family come back in one order, a resent batch creates no second row, and
 * a fetch after a cursor returns exactly what is missing — no more, and not an empty list either.
 */
import { afterEach, expect, test } from "vitest";

import { FAMILY_ENVELOPE_QUOTA } from "../src/limits.ts";
import {
  addMember,
  call,
  createFamily,
  createHarness,
  envelope,
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

async function send(
  h: Harness,
  session: Session,
  family: Family,
  envelopes: Record<string, unknown>[],
) {
  return call(h, "POST", `/v1/families/${family.familyId}/envelopes`, {
    token: session.accessToken,
    payload: { envelopes },
  });
}

async function fetchAfter(
  h: Harness,
  session: Session,
  family: Family,
  query: string,
) {
  return call(h, "GET", `/v1/families/${family.familyId}/envelopes?${query}`, {
    token: session.accessToken,
  });
}

test("twelve envelopes from two devices are numbered 1..12 without a gap or a repeat", async () => {
  harness = createHarness();
  const owner = await signIn(harness);
  const family = await createFamily(harness, owner);
  const { session: member } = await addMember(harness, owner, family);

  const seqs: number[] = [];
  // Four batches, alternating devices, of three envelopes each: interleaving is where a counter
  // kept per device rather than per epoch would first show.
  for (const [index, sender] of [owner, member, owner, member].entries()) {
    const batch = [0, 1, 2].map(() => envelope(family.familyId, sender.deviceId, 1));
    const response = await send(harness, sender, family, batch);
    expect(response.statusCode, `batch ${index}`).toBe(200);
    expect(response.json().keyEpoch).toBe(1);
    for (const accepted of response.json().accepted) seqs.push(accepted.seq);
  }
  expect(seqs).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);

  // And the journal reads back in exactly that order, for either device.
  for (const reader of [owner, member]) {
    const read = await fetchAfter(harness, reader, family, "keyEpoch=1&after=0");
    expect(read.statusCode).toBe(200);
    const body = read.json();
    expect(body.envelopes.map((row: { seq: number }) => row.seq)).toEqual([
      1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12,
    ]);
    expect(body.hasMore).toBe(false);
  }
}, 60_000);

test("resending the same batch returns the same numbers and creates no second row", async () => {
  harness = createHarness();
  const owner = await signIn(harness);
  const family = await createFamily(harness, owner);

  const batch = [0, 1, 2].map(() => envelope(family.familyId, owner.deviceId, 1));
  const first = await send(harness, owner, family, batch);
  expect(first.statusCode).toBe(200);
  expect(first.json().accepted.map((a: { seq: number }) => a.seq)).toEqual([1, 2, 3]);

  // 3.3, step 6: a dropped connection after the write is an ordinary event, so the repeat is
  // answered with the numbers the envelopes already have.
  const again = await send(harness, owner, family, batch);
  expect(again.statusCode).toBe(200);
  expect(again.json().accepted).toEqual(first.json().accepted);

  const count = harness.server.db
    .prepare("SELECT COUNT(*) AS n FROM envelope WHERE family_id = ?")
    .get(family.familyId) as { n: number };
  expect(count.n).toBe(3);

  // A mixed batch — two known, one new — keeps the old numbers and takes the next one for the new.
  const fresh = envelope(family.familyId, owner.deviceId, 1);
  const mixed = await send(harness, owner, family, [batch[0]!, batch[2]!, fresh]);
  expect(mixed.statusCode).toBe(200);
  expect(mixed.json().accepted.map((a: { seq: number }) => a.seq)).toEqual([1, 3, 4]);
  const after = harness.server.db
    .prepare("SELECT COUNT(*) AS n FROM envelope WHERE family_id = ?")
    .get(family.familyId) as { n: number };
  expect(after.n).toBe(4);
});

test("the author in the header is not checked against the device presenting the token", async () => {
  harness = createHarness();
  const owner = await signIn(harness);
  const family = await createFamily(harness, owner);
  const { session: member } = await addMember(harness, owner, family);

  // 3.3 addresses this to phase S3 by name, because the mistake is silent until the family's first
  // rotation: at 5.5 step 4 the owner's device uploads the re-encrypted journal of the whole
  // family, every envelope of which keeps its original author. Belonging is decided by `familyId`
  // plus membership, never by authorship.
  const foreignAuthor = await send(harness, member, family, [
    envelope(family.familyId, owner.deviceId, 1),
    envelope(family.familyId, uuid(), 1),
  ]);
  expect(foreignAuthor.statusCode).toBe(200);
  const authors = harness.server.db
    .prepare("SELECT device_id FROM envelope WHERE family_id = ? ORDER BY seq")
    .all(family.familyId) as { device_id: string }[];
  expect(authors[0]?.device_id).toBe(owner.deviceId);
  expect(authors[1]?.device_id).not.toBe(member.deviceId);

  // What *is* checked is the family, and it is checked on every envelope of the batch.
  const otherFamily = await send(harness, member, family, [
    envelope(uuid(), member.deviceId, 1),
  ]);
  expect(otherFamily.statusCode).toBe(403);
  expect(otherFamily.json().error.code).toBe("forbidden");
}, 60_000);

test("no envelope content reaches the log", async () => {
  harness = createHarness();
  const owner = await signIn(harness);
  const family = await createFamily(harness, owner);
  const secret = Buffer.from("a ciphertext the server may never write down").toString("base64");
  const one = envelope(family.familyId, owner.deviceId, 1, { ciphertext: secret });
  expect((await send(harness, owner, family, [one])).statusCode).toBe(200);
  expect((await fetchAfter(harness, owner, family, "keyEpoch=1&after=0")).statusCode).toBe(200);
  const log = harness.logLines.join("\n");
  expect(log).toContain("/envelopes");
  expect(log).not.toContain(secret);
  expect(log).not.toContain(one["iv"]);
  expect(log).not.toContain(one["opId"]);
});

test("a fetch after a cursor returns exactly the missing envelopes", async () => {
  harness = createHarness();
  const owner = await signIn(harness);
  const family = await createFamily(harness, owner);
  const batch = Array.from({ length: 12 }, () => envelope(family.familyId, owner.deviceId, 1));
  expect((await send(harness, owner, family, batch)).statusCode).toBe(200);

  const tail = await fetchAfter(harness, owner, family, "keyEpoch=1&after=5");
  expect(tail.json().envelopes.map((row: { seq: number }) => row.seq)).toEqual([
    6, 7, 8, 9, 10, 11, 12,
  ]);
  expect(tail.json().hasMore).toBe(false);

  const page = await fetchAfter(harness, owner, family, "keyEpoch=1&after=5&limit=3");
  expect(page.json().envelopes.map((row: { seq: number }) => row.seq)).toEqual([6, 7, 8]);
  expect(page.json().hasMore).toBe(true);

  const end = await fetchAfter(harness, owner, family, "keyEpoch=1&after=12");
  expect(end.json().envelopes).toEqual([]);
  expect(end.json().hasMore).toBe(false);

  // The envelope comes back with the header it was sent with, byte for byte — including the
  // author's `deviceId`, which 3.3 forbids the server to reinterpret.
  const first = await fetchAfter(harness, owner, family, "keyEpoch=1&after=0&limit=1");
  expect(first.json().envelopes[0]).toMatchObject({
    envelopeVersion: 1,
    kind: "operation",
    familyId: family.familyId,
    opId: batch[0]!["opId"],
    deviceId: owner.deviceId,
    keyEpoch: 1,
    seq: 1,
    iv: batch[0]!["iv"],
    ciphertext: batch[0]!["ciphertext"],
  });
});

test("a cursor on a stale epoch is refused with the number in force, not answered emptily", async () => {
  harness = createHarness();
  const owner = await signIn(harness);
  const family = await createFamily(harness, owner);
  const rotationId = uuid();
  await call(harness, "POST", `/v1/families/${family.familyId}/rotation`, {
    token: owner.accessToken,
    payload: { rotationId },
  });
  await call(harness, "POST", `/v1/families/${family.familyId}/rotation/keys`, {
    token: owner.accessToken,
    payload: { rotationId, epochConfirm: Buffer.alloc(32, 9).toString("base64"), wraps: [] },
  });
  await call(harness, "POST", `/v1/families/${family.familyId}/rotation/complete`, {
    token: owner.accessToken,
    payload: { rotationId },
  });

  const stale = await fetchAfter(harness, owner, family, "keyEpoch=1&after=0");
  expect(stale.statusCode).toBe(409);
  expect(stale.json()).toMatchObject({
    error: { code: "epoch_mismatch", keyEpoch: 2 },
  });
});

test("the envelope quota of an epoch is 100 000 and the batch that crosses it is refused whole", async () => {
  harness = createHarness();
  const owner = await signIn(harness);
  const family = await createFamily(harness, owner);

  // Filling the quota through the API would be a hundred thousand HTTP round trips for one
  // assertion, so the journal is filled underneath and the boundary is crossed through the route.
  const insert = harness.server.db.prepare(
    "INSERT INTO envelope (family_id, key_epoch, op_id, seq, envelope_version, kind," +
      " device_id, iv, ciphertext, received_at) VALUES (?, 1, ?, ?, 1, 'operation', ?, ?, ?, ?)",
  );
  const iv = Buffer.alloc(12, 1);
  const ciphertext = Buffer.alloc(32, 2);
  const fill = harness.server.db.transaction((count: number) => {
    for (let seq = 1; seq <= count; seq += 1) {
      insert.run(family.familyId, uuid(), seq, owner.deviceId, iv, ciphertext, harness!.now);
    }
    harness!.server.db
      .prepare("UPDATE epoch SET seq_counter = ? WHERE family_id = ? AND key_epoch = 1")
      .run(count, family.familyId);
  });
  fill(FAMILY_ENVELOPE_QUOTA - 1);

  const overflowing = await send(harness, owner, family, [
    envelope(family.familyId, owner.deviceId, 1),
    envelope(family.familyId, owner.deviceId, 1),
  ]);
  expect(overflowing.statusCode).toBe(409);
  expect(overflowing.json()).toMatchObject({
    error: { code: "quota_exhausted", keyEpoch: 1, quota: FAMILY_ENVELOPE_QUOTA },
  });
  // 3.3: a `409` of any kind leaves the client's queue intact, so neither envelope was kept.
  const held = harness.server.db
    .prepare("SELECT COUNT(*) AS n FROM envelope WHERE family_id = ?")
    .get(family.familyId) as { n: number };
  expect(held.n).toBe(FAMILY_ENVELOPE_QUOTA - 1);

  // The last free slot is still free, and the one after it is not.
  const last = await send(harness, owner, family, [envelope(family.familyId, owner.deviceId, 1)]);
  expect(last.statusCode).toBe(200);
  expect(last.json().accepted[0].seq).toBe(FAMILY_ENVELOPE_QUOTA);
  const over = await send(harness, owner, family, [envelope(family.familyId, owner.deviceId, 1)]);
  expect(over.statusCode).toBe(409);
  expect(over.json().error.code).toBe("quota_exhausted");
}, 60_000);
