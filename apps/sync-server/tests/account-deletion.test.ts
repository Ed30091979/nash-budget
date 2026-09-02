/**
 * 6.8 — deleting an account, counted in rows rather than in status codes.
 *
 * Every test here asserts what is left in the database afterwards, because the failure mode this
 * route has is not "it answered 500": it is "it answered 200 and left a membership, a wrap or a
 * family behind". A half-deleted account has no owner and no route that would ever notice it, and
 * the promise the privacy policy makes is about rows, not about responses.
 *
 * The two shapes 6.8 distinguishes are both here with their numbers: an account with two devices
 * that is one of two live members — where the family must survive intact and the other member must
 * keep working — and the same account as the family's last live member, where the family goes with
 * every envelope, invite, epoch, wrap and confirmation in it.
 */
import { afterEach, expect, test } from "vitest";

import { REAUTH_WINDOW_MS } from "../src/limits.ts";
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
  type Response,
  type Session,
} from "./support.ts";

let harness: Harness | undefined;

afterEach(async () => {
  await harness?.close();
  harness = undefined;
});

/** A second sign-in on the same device: the login code of 6.1, which is what "fresh" means (6.8). */
async function reauthenticate(h: Harness, session: Session): Promise<Session> {
  return signIn(h, session.email, session.deviceId);
}

async function deleteAccount(
  h: Harness,
  session: Session,
  accountId: string = session.accountId,
): Promise<Response> {
  const fresh = await reauthenticate(h, session);
  return call(h, "DELETE", `/v1/accounts/${accountId}`, { token: fresh.accessToken });
}

function count(h: Harness, sql: string, ...params: unknown[]): number {
  return (h.server.db.prepare(sql).get(...(params as never[])) as { n: number }).n;
}

/**
 * Every table, scanned for any of these strings.
 *
 * Written as a scan rather than as a list of `WHERE` clauses on purpose: the point is the tables
 * nobody thought of. `key_wrap`, `epoch_confirm` and `throttle` carry no foreign key at all, so
 * they are exactly the rows a deletion written against the schema diagram leaves behind, and a
 * table added tomorrow joins this check by itself. Blob columns come back as buffers and serialise
 * to arrays of numbers, so an identifier cannot hide inside a ciphertext by accident.
 */
function residue(h: Harness, needles: readonly string[]): string[] {
  const db = h.server.db;
  const tables = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'")
    .all() as { name: string }[];
  const hits: string[] = [];
  for (const { name } of tables) {
    const rows = db.prepare(`SELECT * FROM "${name}"`).all() as Record<string, unknown>[];
    for (const row of rows) {
      const text = JSON.stringify(row);
      for (const needle of needles) if (text.includes(needle)) hits.push(`${name}: ${needle}`);
    }
  }
  return hits;
}

/** A wrap of the epoch in force, made by one device of the family for another (5.5, last part). */
async function wrapKeyFor(
  h: Harness,
  sender: Session,
  family: Family,
  targetDeviceId: string,
): Promise<void> {
  const response = await call(h, "POST", `/v1/families/${family.familyId}/keys`, {
    token: sender.accessToken,
    payload: {
      deviceId: targetDeviceId,
      salt: Buffer.alloc(32, 5).toString("base64"),
      iv: Buffer.alloc(12, 6).toString("base64"),
      ciphertext: Buffer.alloc(48, 7).toString("base64"),
    },
  });
  if (response.statusCode !== 201) throw new Error(`wrap failed: ${response.body}`);
}

async function issueInvite(h: Harness, owner: Session, family: Family): Promise<string> {
  const inviteId = uuid();
  const response = await call(h, "POST", `/v1/families/${family.familyId}/invites`, {
    token: owner.accessToken,
    payload: {
      familyId: family.familyId,
      keyEpoch: 1,
      inviteId,
      iv: Buffer.alloc(12, 1).toString("base64"),
      ciphertext: Buffer.alloc(64, 2).toString("base64"),
      authTokenDigest: Buffer.alloc(32, 3).toString("base64"),
    },
  });
  if (response.statusCode !== 201) throw new Error(`invite failed: ${response.body}`);
  return inviteId;
}

test("a member with two devices leaves; the family and the other member stay whole", async () => {
  harness = createHarness();
  const owner = await signIn(harness);
  const family = await createFamily(harness, owner);
  const joined = await addMember(harness, owner, family);
  // The same account on a second device: 6.4, and the case 6.8 has to count rather than assume.
  const secondDevice = await signIn(harness, joined.session.email, uuid());
  expect(secondDevice.accountId).toBe(joined.session.accountId);
  // The owner's copy of the key for the member's device, and the member's for the owner's.
  await wrapKeyFor(harness, owner, family, joined.session.deviceId);
  await wrapKeyFor(harness, joined.session, family, owner.deviceId);
  const submitted = await call(harness, "POST", `/v1/families/${family.familyId}/envelopes`, {
    token: joined.session.accessToken,
    payload: { envelopes: [envelope(family.familyId, joined.session.deviceId, 1)] },
  });
  expect(submitted.statusCode).toBe(200);

  expect(count(harness, "SELECT COUNT(*) AS n FROM device WHERE account_id = ?", joined.session.accountId)).toBe(2);

  const deleted = await deleteAccount(harness, joined.session);
  expect(deleted.statusCode, deleted.body).toBe(200);
  expect(deleted.json()).toMatchObject({
    accountId: joined.session.accountId,
    devices: 2,
    memberships: 1,
    familyDeleted: false,
    // 6.6: what remains of this departure is a family key still sitting in the leaver's IndexedDB.
    rotationRequired: true,
  });

  // Gone: the account, both its devices, its membership, and the wrap addressed to its device.
  expect(count(harness, "SELECT COUNT(*) AS n FROM account WHERE account_id = ?", joined.session.accountId)).toBe(0);
  expect(count(harness, "SELECT COUNT(*) AS n FROM device WHERE account_id = ?", joined.session.accountId)).toBe(0);
  expect(count(harness, "SELECT COUNT(*) AS n FROM member WHERE account_id = ?", joined.session.accountId)).toBe(0);
  expect(count(harness, "SELECT COUNT(*) AS n FROM key_wrap WHERE device_id = ?", joined.session.deviceId)).toBe(0);
  // Nothing anywhere still names the account, its address or the device that only ever signed in.
  expect(residue(harness, [joined.session.accountId, secondDevice.deviceId, joined.session.email])).toEqual([]);
  // The first device is named in exactly two places, and both are deliberate: it authored an
  // envelope of a journal that belongs to the family, and it sent the owner a wrap of the family
  // key. Deleting either would destroy data of an account that was not deleted — the journal would
  // develop a hole in everyone's `seq` (3.4), and the owner would lose its copy of the key. What is
  // gone is the join that made either of them a name: `device` no longer has a row to reach
  // `account.email` through (2.4).
  expect(residue(harness, [joined.session.deviceId])).toEqual([
    `envelope: ${joined.session.deviceId}`,
    `key_wrap: ${joined.session.deviceId}`,
  ]);

  // Standing: the family, the owner's membership, and the wrap the departing device had made for
  // the owner — that one is the owner's copy of the family key, and deleting it would take the
  // family key away from an account that was not deleted.
  expect(count(harness, "SELECT COUNT(*) AS n FROM family WHERE family_id = ?", family.familyId)).toBe(1);
  expect(count(harness, "SELECT COUNT(*) AS n FROM member WHERE family_id = ? AND removed_at IS NULL", family.familyId)).toBe(1);
  expect(count(harness, "SELECT COUNT(*) AS n FROM key_wrap WHERE device_id = ?", owner.deviceId)).toBe(1);
  // The journal is the family's, not the leaver's: the envelope stays, or the numbering of 3.4
  // would develop a hole in everyone else's cursor.
  expect(count(harness, "SELECT COUNT(*) AS n FROM envelope WHERE family_id = ?", family.familyId)).toBe(1);
  // The invite the member joined by keeps its row and loses the reference to a device that is gone.
  const invite = harness.server.db
    .prepare("SELECT used_at, used_by_device_id FROM invite WHERE invite_id = ?")
    .get(joined.inviteId) as { used_at: number | null; used_by_device_id: string | null };
  expect(invite.used_at).not.toBeNull();
  expect(invite.used_by_device_id).toBeNull();

  // And the other member keeps working, which is the whole claim: read the journal, write to it.
  const me = await call(harness, "GET", "/v1/families/me", { token: owner.accessToken });
  expect(me.statusCode, me.body).toBe(200);
  expect(me.json()).toMatchObject({ familyId: family.familyId, keyEpoch: 1, role: "owner" });
  const fetched = await call(harness, "GET", `/v1/families/${family.familyId}/envelopes?keyEpoch=1&after=0`, {
    token: owner.accessToken,
  });
  expect(fetched.statusCode, fetched.body).toBe(200);
  expect(fetched.json().envelopes).toHaveLength(1);
  const wrote = await call(harness, "POST", `/v1/families/${family.familyId}/envelopes`, {
    token: owner.accessToken,
    payload: { envelopes: [envelope(family.familyId, owner.deviceId, 1)] },
  });
  expect(wrote.statusCode, wrote.body).toBe(200);
  expect(wrote.json().accepted[0].seq).toBe(2);
});

test("the last live member takes the family, its envelopes and its invites with them", async () => {
  harness = createHarness();
  const owner = await signIn(harness);
  const family = await createFamily(harness, owner);
  const second = await signIn(harness, owner.email, uuid());

  // A rotation carried to the end, so the family owns everything 5.5 leaves behind: a retired
  // epoch, an active one, a wrap and the confirmation of continuity.
  const rotationId = uuid();
  const declared = await call(harness, "POST", `/v1/families/${family.familyId}/rotation`, {
    token: owner.accessToken,
    payload: { rotationId },
  });
  expect(declared.statusCode, declared.body).toBe(201);
  const staged = await call(harness, "POST", `/v1/families/${family.familyId}/rotation/keys`, {
    token: owner.accessToken,
    payload: {
      rotationId,
      epochConfirm: Buffer.alloc(32, 9).toString("base64"),
      wraps: [
        {
          deviceId: second.deviceId,
          senderDeviceId: owner.deviceId,
          salt: Buffer.alloc(32, 5).toString("base64"),
          iv: Buffer.alloc(12, 6).toString("base64"),
          ciphertext: Buffer.alloc(48, 7).toString("base64"),
        },
      ],
    },
  });
  expect(staged.statusCode, staged.body).toBe(200);
  const completed = await call(harness, "POST", `/v1/families/${family.familyId}/rotation/complete`, {
    token: owner.accessToken,
    payload: { rotationId },
  });
  expect(completed.statusCode, completed.body).toBe(200);

  const inviteId = await call(harness, "POST", `/v1/families/${family.familyId}/invites`, {
    token: owner.accessToken,
    payload: {
      familyId: family.familyId,
      keyEpoch: 2,
      inviteId: uuid(),
      iv: Buffer.alloc(12, 1).toString("base64"),
      ciphertext: Buffer.alloc(64, 2).toString("base64"),
      authTokenDigest: Buffer.alloc(32, 3).toString("base64"),
    },
  });
  expect(inviteId.statusCode, inviteId.body).toBe(201);
  const submitted = await call(harness, "POST", `/v1/families/${family.familyId}/envelopes`, {
    token: owner.accessToken,
    payload: {
      envelopes: [
        envelope(family.familyId, owner.deviceId, 2),
        envelope(family.familyId, owner.deviceId, 2),
      ],
    },
  });
  expect(submitted.statusCode, submitted.body).toBe(200);

  expect(count(harness, "SELECT COUNT(*) AS n FROM envelope WHERE family_id = ?", family.familyId)).toBe(2);
  expect(count(harness, "SELECT COUNT(*) AS n FROM epoch WHERE family_id = ?", family.familyId)).toBe(2);
  expect(count(harness, "SELECT COUNT(*) AS n FROM key_wrap WHERE family_id = ?", family.familyId)).toBe(1);
  expect(count(harness, "SELECT COUNT(*) AS n FROM epoch_confirm WHERE family_id = ?", family.familyId)).toBe(1);
  expect(count(harness, "SELECT COUNT(*) AS n FROM invite WHERE family_id = ?", family.familyId)).toBe(1);

  const deleted = await deleteAccount(harness, owner);
  expect(deleted.statusCode, deleted.body).toBe(200);
  expect(deleted.json()).toMatchObject({
    accountId: owner.accountId,
    devices: 2,
    memberships: 1,
    familyDeleted: true,
    // Nothing survives to be rotated, and saying "rotation required" here would send the client
    // to a screen about a family that no longer exists.
    rotationRequired: false,
  });

  for (const table of ["envelope", "epoch", "key_wrap", "epoch_confirm", "invite", "member"]) {
    expect(count(harness, `SELECT COUNT(*) AS n FROM ${table} WHERE family_id = ?`, family.familyId), table).toBe(0);
  }
  expect(count(harness, "SELECT COUNT(*) AS n FROM family WHERE family_id = ?", family.familyId)).toBe(0);
  expect(count(harness, "SELECT COUNT(*) AS n FROM account WHERE account_id = ?", owner.accountId)).toBe(0);
  expect(count(harness, "SELECT COUNT(*) AS n FROM device WHERE account_id = ?", owner.accountId)).toBe(0);
  expect(count(harness, "SELECT COUNT(*) AS n FROM login_code WHERE email = ?", owner.email)).toBe(0);
  // No table anywhere still names the account, either of its devices, the family or the address —
  // including the three that no foreign key would have reached.
  expect(residue(harness, [owner.accountId, owner.deviceId, second.deviceId, family.familyId, owner.email])).toEqual([]);
  expect(harness.server.db.pragma("foreign_key_check")).toEqual([]);
  // What is *not* cleared, and the distinction is the whole of 3.2.1's reasoning applied to a
  // deletion: the windows keyed by this account, its address and its devices are the account's own
  // and go with it, but the window keyed by the source address of the requests belongs to no
  // account. Clearing it would let anyone reset the backstop of 6.1 by deleting an account they
  // control — a limit measured by the party it binds.
  expect(count(harness, "SELECT COUNT(*) AS n FROM throttle WHERE bucket LIKE 'login-code:source:%'")).toBeGreaterThan(0);
});

test("a deletion during someone else's rotation neither cancels it nor blocks it", async () => {
  harness = createHarness();
  const owner = await signIn(harness);
  const family = await createFamily(harness, owner);
  const joined = await addMember(harness, owner, family);

  const rotationId = uuid();
  const declared = await call(harness, "POST", `/v1/families/${family.familyId}/rotation`, {
    token: owner.accessToken,
    payload: { rotationId },
  });
  expect(declared.statusCode, declared.body).toBe(201);
  const staged = await call(harness, "POST", `/v1/families/${family.familyId}/rotation/keys`, {
    token: owner.accessToken,
    payload: {
      rotationId,
      epochConfirm: Buffer.alloc(32, 9).toString("base64"),
      wraps: [
        {
          deviceId: joined.session.deviceId,
          senderDeviceId: owner.deviceId,
          salt: Buffer.alloc(32, 5).toString("base64"),
          iv: Buffer.alloc(12, 6).toString("base64"),
          ciphertext: Buffer.alloc(48, 7).toString("base64"),
        },
      ],
    },
  });
  expect(staged.statusCode, staged.body).toBe(200);

  // The member deletes their account while the owner's rotation is half-finished. The attempt is
  // not theirs to cancel — it is led by a device that still exists, and 6.6 makes exactly this
  // rotation mandatory after a departure, so cancelling it would undo the remedy.
  const deleted = await deleteAccount(harness, joined.session);
  expect(deleted.statusCode, deleted.body).toBe(200);
  expect(count(harness, "SELECT COUNT(*) AS n FROM epoch WHERE family_id = ? AND state = 'staging'", family.familyId)).toBe(1);
  // Their copy of the new key goes, though: it is addressed to a device that no longer exists.
  expect(count(harness, "SELECT COUNT(*) AS n FROM key_wrap WHERE device_id = ?", joined.session.deviceId)).toBe(0);

  const completed = await call(harness, "POST", `/v1/families/${family.familyId}/rotation/complete`, {
    token: owner.accessToken,
    payload: { rotationId },
  });
  expect(completed.statusCode, completed.body).toBe(200);
  const me = await call(harness, "GET", "/v1/families/me", { token: owner.accessToken });
  expect(me.json()).toMatchObject({ keyEpoch: 2, rotation: null });
});

test("the second call is refused exactly as any dead token is, and changes nothing", async () => {
  harness = createHarness();
  const owner = await signIn(harness);
  await createFamily(harness, owner);
  const fresh = await reauthenticate(harness, owner);

  const first = await call(harness, "DELETE", `/v1/accounts/${owner.accountId}`, {
    token: fresh.accessToken,
  });
  expect(first.statusCode).toBe(200);
  const rowsAfterFirst = residue(harness, [owner.accountId]);

  const second = await call(harness, "DELETE", `/v1/accounts/${owner.accountId}`, {
    token: fresh.accessToken,
  });
  // The account is gone and so is the device the token names, so the second call is refused at the
  // door in the words of an unauthenticated request — to the byte. That is the honest answer and
  // the only uniform one: there is nothing left to be idempotent about, no half-deleted state to
  // trip over, and no way to tell this apart from a token that was never issued.
  const anonymous = await call(harness, "DELETE", `/v1/accounts/${owner.accountId}`);
  expect(second.statusCode).toBe(401);
  expect(second.json().error.code).toBe("unauthorized");
  expect(second.body).toBe(anonymous.body);
  expect(second.statusCode).toBe(anonymous.statusCode);
  expect(residue(harness, [owner.accountId])).toEqual(rowsAfterFirst);
  expect(rowsAfterFirst).toEqual([]);
});

test("another account cannot be deleted, and the refusal says nothing about it", async () => {
  harness = createHarness();
  const victim = await signIn(harness);
  const victimFamily = await createFamily(harness, victim);
  const attacker = await signIn(harness);
  const fresh = await reauthenticate(harness, attacker);

  const attempt = await call(harness, "DELETE", `/v1/accounts/${victim.accountId}`, {
    token: fresh.accessToken,
  });
  // 404 and not 403: "there is no such account here" is the same sentence for an account that
  // exists and one that never did, and this route must not be the difference between them.
  const nowhere = await call(harness, "DELETE", `/v1/accounts/${uuid()}`, {
    token: fresh.accessToken,
  });
  expect(attempt.statusCode).toBe(404);
  expect(attempt.json().error.code).toBe("not_found");
  expect(attempt.body).toBe(nowhere.body);

  expect(count(harness, "SELECT COUNT(*) AS n FROM account WHERE account_id = ?", victim.accountId)).toBe(1);
  expect(count(harness, "SELECT COUNT(*) AS n FROM family WHERE family_id = ?", victimFamily.familyId)).toBe(1);
  const me = await call(harness, "GET", "/v1/families/me", { token: victim.accessToken });
  expect(me.statusCode).toBe(200);
});

test("a live access token is not enough: the sign-in has to be fresh", async () => {
  harness = createHarness();
  const owner = await signIn(harness);
  await createFamily(harness, owner);

  // Straight after signing in, the same token deletes nothing once the window has passed — and it
  // is still a perfectly good token everywhere else, which is the point of the separate code.
  harness.advance(REAUTH_WINDOW_MS + 1000);
  const refreshed = await refreshSession(harness, owner);
  const stale = await call(harness, "DELETE", `/v1/accounts/${owner.accountId}`, {
    token: refreshed.accessToken,
  });
  expect(stale.statusCode).toBe(401);
  expect(stale.json().error.code).toBe("reauth_required");
  expect(count(harness, "SELECT COUNT(*) AS n FROM account WHERE account_id = ?", owner.accountId)).toBe(1);
  const stillWorking = await call(harness, "GET", "/v1/families/me", { token: refreshed.accessToken });
  expect(stillWorking.statusCode).toBe(200);

  // A refresh mints a new access token and does not touch the moment of authentication: thirty
  // days of refresh token must not add up to one fresh sign-in.
  const again = await refreshSession(harness, refreshed);
  const afterRefresh = await call(harness, "DELETE", `/v1/accounts/${owner.accountId}`, {
    token: again.accessToken,
  });
  expect(afterRefresh.statusCode).toBe(401);
  expect(afterRefresh.json().error.code).toBe("reauth_required");

  // The code ceremony of 6.1, and now it works.
  const fresh = await reauthenticate(harness, owner);
  const deleted = await call(harness, "DELETE", `/v1/accounts/${owner.accountId}`, {
    token: fresh.accessToken,
  });
  expect(deleted.statusCode, deleted.body).toBe(200);
});

test("a token from a superseded sign-in of the same device is never fresh", async () => {
  harness = createHarness();
  const owner = await signIn(harness);
  await createFamily(harness, owner);
  const first = owner.accessToken;

  // The user signs in again on this device a minute later — a new episode, and the token of the
  // previous one is left behind. It is still inside the freshness window by the clock, so only the
  // comparison against the device row can tell the two apart.
  harness.advance(60_000);
  const second = await reauthenticate(harness, owner);
  expect(second.accessToken).not.toBe(first);

  const withOld = await call(harness, "DELETE", `/v1/accounts/${owner.accountId}`, { token: first });
  expect(withOld.statusCode).toBe(401);
  expect(withOld.json().error.code).toBe("reauth_required");
  const withNew = await call(harness, "DELETE", `/v1/accounts/${owner.accountId}`, {
    token: second.accessToken,
  });
  expect(withNew.statusCode, withNew.body).toBe(200);
});

test("a rotation led by a departing device is cancelled rather than left to expire", async () => {
  harness = createHarness();
  const owner = await signIn(harness);
  const family = await createFamily(harness, owner);
  const joined = await addMember(harness, owner, family);
  const liveInvite = await issueInvite(harness, owner, family);

  const rotationId = uuid();
  const declared = await call(harness, "POST", `/v1/families/${family.familyId}/rotation`, {
    token: owner.accessToken,
    payload: { rotationId },
  });
  expect(declared.statusCode, declared.body).toBe(201);
  // 3.3 step 2: while the epoch is staging the family is closed for writing.
  const blocked = await call(harness, "POST", `/v1/families/${family.familyId}/envelopes`, {
    token: joined.session.accessToken,
    payload: { envelopes: [envelope(family.familyId, joined.session.deviceId, 1)] },
  });
  expect(blocked.statusCode).toBe(409);
  expect(blocked.json().error.code).toBe("rotation_in_progress");

  const deleted = await deleteAccount(harness, owner);
  expect(deleted.statusCode, deleted.body).toBe(200);
  expect(deleted.json()).toMatchObject({ familyDeleted: false, rotationRequired: true });

  // The staging epoch is gone with the device that was leading it; the epoch in force is
  // untouched, and the number the attempt spent stays spent (5.5, 5.4).
  expect(count(harness, "SELECT COUNT(*) AS n FROM epoch WHERE family_id = ? AND state = 'staging'", family.familyId)).toBe(0);
  const familyRow = harness.server.db
    .prepare("SELECT key_epoch, max_key_epoch FROM family WHERE family_id = ?")
    .get(family.familyId) as { key_epoch: number; max_key_epoch: number };
  expect(familyRow).toEqual({ key_epoch: 1, max_key_epoch: 2 });
  const wrote = await call(harness, "POST", `/v1/families/${family.familyId}/envelopes`, {
    token: joined.session.accessToken,
    payload: { envelopes: [envelope(family.familyId, joined.session.deviceId, 1)] },
  });
  expect(wrote.statusCode, wrote.body).toBe(200);

  // The live code the departing owner had issued goes with them: it hands the family key to
  // whoever holds it, and no one is left who could withdraw it. The spent one is history and stays.
  expect(count(harness, "SELECT COUNT(*) AS n FROM invite WHERE invite_id = ?", liveInvite)).toBe(0);
  expect(count(harness, "SELECT COUNT(*) AS n FROM invite WHERE invite_id = ?", joined.inviteId)).toBe(1);
});

test("a member who left first makes the remaining one the last: the family goes", async () => {
  harness = createHarness();
  const owner = await signIn(harness);
  const family = await createFamily(harness, owner);
  const joined = await addMember(harness, owner, family);

  const left = await call(harness, "POST", `/v1/families/${family.familyId}/leave`, {
    token: joined.session.accessToken,
  });
  expect(left.statusCode, left.body).toBe(200);

  // The count is of *live* members, so the row the departure left behind does not keep the family
  // alive — and it is deleted with it, rather than pointing at a family that is gone.
  const deleted = await deleteAccount(harness, owner);
  expect(deleted.statusCode, deleted.body).toBe(200);
  expect(deleted.json()).toMatchObject({ familyDeleted: true, memberships: 1 });
  expect(count(harness, "SELECT COUNT(*) AS n FROM family WHERE family_id = ?", family.familyId)).toBe(0);
  expect(count(harness, "SELECT COUNT(*) AS n FROM member WHERE family_id = ?", family.familyId)).toBe(0);
  // The account that left keeps its own row: 6.6 says a departed member goes on using their local
  // copy, and nothing about this deletion touches somebody else's account.
  expect(count(harness, "SELECT COUNT(*) AS n FROM account WHERE account_id = ?", joined.session.accountId)).toBe(1);
  expect(harness.server.db.pragma("foreign_key_check")).toEqual([]);
});
