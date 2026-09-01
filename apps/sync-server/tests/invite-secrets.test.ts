/**
 * 5.3 — the server holds the digest of the invite token and nothing else of the invite.
 *
 * `sync-crypto` splits the result of sealing an invite in two on purpose: `record`, every field of
 * which is meant to be handed over, and `issuerSecrets`, which holds `authToken` and `bindKey` and
 * never leaves the issuing device. The split is the protection, so these tests use the real
 * `sealInvite` rather than hand-built bytes — a test that made up its own "token" would be proving
 * a property of the test.
 *
 * Two directions are checked. The server must not *accept* the secrets — a body carrying one is
 * refused rather than quietly stripped, which is why the application turns Fastify's
 * `removeAdditional` off — and it must not *hold* them: after a real invite has been issued and
 * claimed, the whole database is swept for the exact bytes.
 */
import {
  generateFamilyKey,
  generateInviteCode,
  inviteAuthTokenDigest,
  sealInvite,
  type InviteWireRecord,
} from "@family-budget/sync-crypto";
import { afterEach, expect, test } from "vitest";

import { call, createFamily, createHarness, signIn, uuid, type Harness } from "./support.ts";

let harness: Harness | undefined;

afterEach(async () => {
  await harness?.close();
  harness = undefined;
});

const b64 = (bytes: Uint8Array): string => Buffer.from(bytes).toString("base64");

/** Every byte the database holds, in one buffer: table names, column names and values alike. */
function databaseBytes(harness: Harness): Buffer {
  const parts: Buffer[] = [];
  const tables = harness.server.db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
    .all() as { name: string }[];
  for (const { name } of tables) {
    parts.push(Buffer.from(name, "utf8"));
    const rows = harness.server.db.prepare(`SELECT * FROM "${name}"`).all() as Record<
      string,
      unknown
    >[];
    for (const row of rows) {
      for (const [column, value] of Object.entries(row)) {
        parts.push(Buffer.from(column, "utf8"));
        if (value === null || value === undefined) continue;
        if (typeof value === "string") parts.push(Buffer.from(value, "utf8"));
        else if (typeof value === "number" || typeof value === "bigint") {
          parts.push(Buffer.from(String(value), "utf8"));
        } else parts.push(Buffer.from(value as Uint8Array));
      }
    }
  }
  return Buffer.concat(parts);
}

async function issueRealInvite(harness: Harness) {
  const owner = await signIn(harness);
  const family = await createFamily(harness, owner);
  const code = generateInviteCode();
  const sealed = await sealInvite({
    code,
    familyId: family.familyId,
    keyEpoch: 1,
    inviteId: uuid(),
    familyKey: await generateFamilyKey(),
    senderDeviceId: owner.deviceId,
    senderSpki: new Uint8Array(91).fill(11),
    senderRole: "owner",
    senderMemberId: family.memberId,
  });
  return { owner, family, code, sealed };
}

function wireBody(record: InviteWireRecord): Record<string, unknown> {
  return {
    familyId: record.familyId,
    keyEpoch: record.keyEpoch,
    inviteId: record.inviteId,
    iv: b64(record.iv),
    ciphertext: b64(record.ciphertext),
    authTokenDigest: b64(record.authTokenDigest),
  };
}

test("the wire record is accepted whole and the issuer's secrets are nowhere in the database", async () => {
  harness = createHarness();
  const { owner, family, code, sealed } = await issueRealInvite(harness);
  const created = await call(harness, "POST", `/v1/families/${family.familyId}/invites`, {
    token: owner.accessToken,
    payload: wireBody(sealed.record),
  });
  expect(created.statusCode).toBe(201);

  // The claim is what the digest is for: the joining device proves it knows the token.
  const joiner = await signIn(harness);
  const claimed = await call(harness, "POST", "/v1/invites/claim", {
    token: joiner.accessToken,
    payload: { authToken: b64(sealed.issuerSecrets.authToken) },
  });
  expect(claimed.statusCode).toBe(200);
  expect(claimed.json().inviteBox).toBe(b64(sealed.record.ciphertext));
  // What comes back is the box and its addressing, and never anything derived from the code.
  expect(Object.keys(claimed.json()).sort()).toEqual([
    "familyId",
    "inviteId",
    "iv",
    "keyEpoch",
    "inviteBox",
  ].sort());

  const stored = databaseBytes(harness);
  expect(stored.includes(Buffer.from(sealed.issuerSecrets.authToken))).toBe(false);
  expect(stored.includes(Buffer.from(sealed.issuerSecrets.bindKey))).toBe(false);
  expect(stored.includes(Buffer.from(code, "utf8"))).toBe(false);
  // The one thing 5.3 does allow, present and proving the sweep above can find what is there.
  const digest = await inviteAuthTokenDigest(sealed.issuerSecrets.authToken);
  expect(stored.includes(Buffer.from(digest))).toBe(true);
}, 60_000);

test("a body carrying the token or the binding key is refused, not stripped", async () => {
  harness = createHarness();
  const { owner, family, sealed } = await issueRealInvite(harness);
  for (const extra of [
    { authToken: b64(sealed.issuerSecrets.authToken) },
    { bindKey: b64(sealed.issuerSecrets.bindKey) },
    { code: "ABCDEFGHJKMN" },
  ]) {
    const response = await call(harness, "POST", `/v1/families/${family.familyId}/invites`, {
      token: owner.accessToken,
      payload: { ...wireBody(sealed.record), ...extra },
    });
    expect(response.statusCode, JSON.stringify(extra)).toBe(400);
    expect(response.json().error.code).toBe("invalid_request");
  }
  // Refused means refused: nothing was written on the way.
  const rows = harness.server.db.prepare("SELECT COUNT(*) AS n FROM invite").get() as { n: number };
  expect(rows.n).toBe(0);
}, 60_000);

test("the accepted field set is exactly the wire record's, taken from the record itself", async () => {
  harness = createHarness();
  await harness.server.app.ready();
  const route = harness.server.routes.find(
    (candidate) =>
      candidate.method === "POST" && candidate.url === "/v1/families/:familyId/invites",
  );
  expect(route).toBeDefined();
  const schema = route?.schema as { body: { properties: Record<string, unknown>; additionalProperties: boolean } };
  const { sealed } = await issueRealInvite(harness);
  expect(Object.keys(schema.body.properties).sort()).toEqual(Object.keys(sealed.record).sort());
  expect(schema.body.additionalProperties).toBe(false);
}, 60_000);

test("the invite table has a column for the digest and none for a token or a key", () => {
  harness = createHarness();
  const columns = (
    harness.server.db.prepare("PRAGMA table_info(invite)").all() as { name: string }[]
  ).map((column) => column.name);
  expect(columns).toContain("auth_token_digest");
  for (const column of columns) {
    expect(column).not.toMatch(/^auth_token$|token$|bind_key|secret|code|kek/);
  }
});
