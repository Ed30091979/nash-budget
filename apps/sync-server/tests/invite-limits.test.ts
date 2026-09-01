/**
 * 5.3 — what bounds the invite table, and who gets to choose its length.
 *
 * The claim of 5.3 is a comparison the server makes on behalf of a stranger, and the number of
 * rows it touches is therefore not a performance question: on a synchronous driver, a list one
 * party may lengthen at will is a list everybody else waits behind. Three things keep it short and
 * all three are checked here — one live invite per family, a rate limit on issuing, and the
 * physical deletion of what has expired.
 */
import { createHash, randomUUID } from "node:crypto";

import { afterEach, expect, test } from "vitest";

import {
  INVITE_CREATES_PER_WINDOW,
  INVITE_CREATE_WINDOW_MS,
  INVITE_TTL_MS,
  MAX_LIVE_INVITES_PER_FAMILY,
} from "../src/limits.ts";
import {
  call,
  createFamily,
  createHarness,
  refreshSession,
  signIn,
  type Family,
  type Harness,
  type Session,
} from "./support.ts";

let harness: Harness | undefined;

afterEach(async () => {
  await harness?.close();
  harness = undefined;
});

/**
 * An invite as the server sees one: a box it cannot open and the digest of a token it never holds.
 *
 * Sealed invites are made by `sync-crypto` and tested there and in `invite-secrets`; what matters
 * to these tests is only that the digest is the SHA-256 of the token that will be presented, which
 * is the whole of what the claim compares.
 */
function invite(familyId: string, tokenByte: number) {
  const authToken = Buffer.alloc(32, tokenByte);
  return {
    authToken: authToken.toString("base64"),
    body: {
      familyId,
      keyEpoch: 1,
      inviteId: randomUUID(),
      iv: Buffer.alloc(12, tokenByte).toString("base64"),
      ciphertext: Buffer.alloc(64, tokenByte).toString("base64"),
      authTokenDigest: createHash("sha256").update(authToken).digest("base64"),
    },
  };
}

const issue = (h: Harness, owner: Session, family: Family, body: Record<string, unknown>) =>
  call(h, "POST", `/v1/families/${family.familyId}/invites`, {
    token: owner.accessToken,
    payload: body,
  });

const liveInvites = (h: Harness, familyId: string): number =>
  (
    h.server.db
      .prepare(
        "SELECT COUNT(*) AS n FROM invite WHERE family_id = ? AND used_at IS NULL AND expires_at > ?",
      )
      .get(familyId, h.now) as { n: number }
  ).n;

test("a family holds one live invite, and the new code retires the old one", async () => {
  harness = createHarness();
  const owner = await signIn(harness);
  const family = await createFamily(harness, owner);
  const first = invite(family.familyId, 1);
  const second = invite(family.familyId, 2);

  expect((await issue(harness, owner, family, first.body)).statusCode).toBe(201);
  const replaced = await issue(harness, owner, family, second.body);
  expect(replaced.statusCode).toBe(201);
  // The device that issued the new code has to be able to say which one has stopped working.
  expect(replaced.json().supersededInviteIds).toEqual([first.body.inviteId]);
  expect(liveInvites(harness, family.familyId)).toBe(MAX_LIVE_INVITES_PER_FAMILY);

  const joiner = await signIn(harness);
  const stale = await call(harness, "POST", "/v1/invites/claim", {
    token: joiner.accessToken,
    payload: { authToken: first.authToken },
  });
  expect(stale.statusCode).toBe(404);
  const current = await call(harness, "POST", "/v1/invites/claim", {
    token: joiner.accessToken,
    payload: { authToken: second.authToken },
  });
  expect(current.statusCode).toBe(200);
  expect(current.json().inviteId).toBe(second.body.inviteId);
});

test("issuing invites is rate limited, so no owner sets the length of everyone's lookup", async () => {
  harness = createHarness();
  const owner = await signIn(harness);
  const family = await createFamily(harness, owner);

  for (let attempt = 1; attempt <= INVITE_CREATES_PER_WINDOW; attempt += 1) {
    const response = await issue(harness, owner, family, invite(family.familyId, attempt).body);
    expect(response.statusCode, `invite ${attempt}`).toBe(201);
  }
  const refused = await issue(harness, owner, family, invite(family.familyId, 200).body);
  expect(refused.statusCode).toBe(429);
  expect(refused.json().error.code).toBe("rate_limited");
  // Five issued and one refused, and the table holds one row: the flood left nothing to walk.
  expect(liveInvites(harness, family.familyId)).toBe(MAX_LIVE_INVITES_PER_FAMILY);
  const rows = (
    harness.server.db.prepare("SELECT COUNT(*) AS n FROM invite").get() as { n: number }
  ).n;
  expect(rows).toBe(MAX_LIVE_INVITES_PER_FAMILY);

  harness.advance(INVITE_CREATE_WINDOW_MS + 1);
  await refreshSession(harness, owner);
  const afterTheWindow = await issue(harness, owner, family, invite(family.familyId, 9).body);
  expect(afterTheWindow.statusCode).toBe(201);
});

test("an expired invite is deleted, not merely emptied", async () => {
  harness = createHarness();
  const owner = await signIn(harness);
  const family = await createFamily(harness, owner);
  const expiring = invite(family.familyId, 3);
  expect((await issue(harness, owner, family, expiring.body)).statusCode).toBe(201);

  harness.advance(INVITE_TTL_MS + 1);
  const joiner = await signIn(harness);
  const claimed = await call(harness, "POST", "/v1/invites/claim", {
    token: joiner.accessToken,
    payload: { authToken: expiring.authToken },
  });
  expect(claimed.statusCode).toBe(404);
  // 5.3 deletes the box on expiry; the row it sat in has no reason to outlive it, and a row that
  // outlives it is a row every later claim in the system pays for.
  const rows = (
    harness.server.db.prepare("SELECT COUNT(*) AS n FROM invite").get() as { n: number }
  ).n;
  expect(rows).toBe(0);
});
