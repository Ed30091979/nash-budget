/**
 * 2.2 and 5.4.1 — the server neither asks a device which key epoch it accepts nor records it.
 *
 * The number in force travels server to client: `family.keyEpoch` is the server's own row, and a
 * device that has not accepted it is told so by `409 epoch_mismatch`, not asked about it. What a
 * device has *accepted* is its own state (5.4.1 keeps it there), and a server told that state
 * could act on it — offer a continuity chain starting where a device is weakest, or read off which
 * devices are behind and pick the moment to ask a human to confirm a key (7.1).
 *
 * So this file audits the two surfaces where such a field could appear: the schemas of every
 * registered route, and the columns of every table.
 */
import { afterEach, expect, test } from "vitest";

import { call, createFamily, createHarness, signIn, uuid, type Harness } from "./support.ts";

let harness: Harness | undefined;

afterEach(async () => {
  await harness?.close();
  harness = undefined;
});

interface Located {
  readonly route: string;
  readonly location: string;
  readonly property: string;
}

function clientSuppliedProperties(harness: Harness): Located[] {
  const found: Located[] = [];
  const visit = (route: string, location: string, node: unknown): void => {
    if (typeof node !== "object" || node === null) return;
    const schema = node as Record<string, unknown>;
    const properties = schema["properties"];
    if (typeof properties === "object" && properties !== null) {
      for (const [property, child] of Object.entries(properties)) {
        found.push({ route, location, property });
        visit(route, location, child);
      }
    }
    if (schema["items"] !== undefined) visit(route, location, schema["items"]);
  };
  for (const route of harness.server.routes) {
    if (route.schema === undefined) continue;
    for (const location of ["body", "querystring", "params"]) {
      visit(`${route.method} ${route.url}`, location, route.schema[location]);
    }
  }
  return found;
}

test("no route has a field for the epoch a device considers accepted", async () => {
  harness = createHarness();
  await harness.server.app.ready();
  for (const field of clientSuppliedProperties(harness)) {
    expect(field.property, `${field.route} ${field.location}`).not.toMatch(
      /accept|current|known|latest|have|holds|myEpoch/i,
    );
  }
});

test("the only epoch a client may name is the envelope header, the invite and the cursor", async () => {
  harness = createHarness();
  await harness.server.app.ready();
  const named = clientSuppliedProperties(harness)
    .filter((field) => /epoch/i.test(field.property) && !field.route.startsWith("HEAD "))
    .map((field) => `${field.route} ${field.location}.${field.property}`)
    .sort();
  // Each of the three is required by the document by name, and none of them is a statement about
  // what the sending device has accepted:
  //   - the envelope header carries `keyEpoch` because it is in the AAD (2.2), so the server could
  //     not strip it even if it wanted to;
  //   - the invite record names the epoch its box was sealed for (5.3);
  //   - the fetch cursor names the epoch it is a cursor *in*, and 3.4 requires the server to
  //     answer a stale one with `409 epoch_mismatch` rather than with an empty list;
  //   - `epochConfirm` is the opaque `rotateConfirm` MAC of 5.4, uploaded by the device leading
  //     the rotation it belongs to. It carries no number the server reads and says nothing about
  //     what any device has accepted — the server cannot even check it.
  expect(named).toEqual([
    "GET /v1/families/:familyId/envelopes querystring.keyEpoch",
    "POST /v1/families/:familyId/envelopes body.keyEpoch",
    "POST /v1/families/:familyId/invites body.keyEpoch",
    "POST /v1/families/:familyId/rotation/keys body.epochConfirm",
  ]);
});

test("the key-wrap listing takes no input at all beyond the family", async () => {
  harness = createHarness();
  const owner = await signIn(harness);
  const family = await createFamily(harness, owner);
  const plain = await call(harness, "GET", `/v1/families/${family.familyId}/keys`, {
    token: owner.accessToken,
  });
  expect(plain.statusCode).toBe(200);
  expect(plain.json()).toMatchObject({ keyEpoch: 1, wraps: [] });
  for (const query of ["acceptedKeyEpoch=1", "keyEpoch=1", "afterEpoch=0"]) {
    const response = await call(harness, "GET", `/v1/families/${family.familyId}/keys?${query}`, {
      token: owner.accessToken,
    });
    expect(response.statusCode, query).toBe(400);
    expect(response.json().error.code).toBe("invalid_request");
  }
});

test("no table records what epoch a device is on", () => {
  harness = createHarness();
  const db = harness.server.db;
  const tables = (
    db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[]
  ).map((table) => table.name);
  const columnsOf = (table: string): string[] =>
    (db.prepare(`PRAGMA table_info("${table}")`).all() as { name: string }[]).map((c) => c.name);

  // The device row is the natural home for such a field, and it has no epoch column of any kind.
  expect(columnsOf("device").filter((column) => /epoch/.test(column))).toEqual([]);

  // Elsewhere a device and an epoch may meet in exactly two rows, and neither is an opinion about
  // acceptance: `key_wrap` is an opaque wrap addressed to a device, `envelope` is the open
  // authorship of 2.2. Anything else pairing the two would be the state 5.4.1 keeps on the client.
  const pairing = tables.filter((table) => {
    const columns = columnsOf(table);
    return columns.includes("device_id") && columns.some((column) => /epoch/.test(column));
  });
  expect(pairing.sort()).toEqual(["envelope", "key_wrap"]);
});

test("a device that never speaks to the server leaves no epoch trace behind", async () => {
  harness = createHarness();
  const owner = await signIn(harness);
  const family = await createFamily(harness, owner);
  const member = await signIn(harness);

  const rotationId = uuid();
  const started = await call(harness, "POST", `/v1/families/${family.familyId}/rotation`, {
    token: owner.accessToken,
    payload: { rotationId },
  });
  expect(started.statusCode).toBe(201);
  const keys = await call(harness, "POST", `/v1/families/${family.familyId}/rotation/keys`, {
    token: owner.accessToken,
    payload: { rotationId, epochConfirm: Buffer.alloc(32, 5).toString("base64"), wraps: [] },
  });
  expect(keys.statusCode).toBe(200);
  const completed = await call(harness, "POST", `/v1/families/${family.familyId}/rotation/complete`, {
    token: owner.accessToken,
    payload: { rotationId },
  });
  expect(completed.statusCode).toBe(200);
  expect(completed.json().keyEpoch).toBe(2);

  // The owner's own device crossed the epoch; the server still knows nothing about either device
  // beyond identity, keys and liveness.
  const rows = harness.server.db.prepare("SELECT * FROM device").all() as Record<string, unknown>[];
  expect(rows.length).toBe(2);
  for (const row of rows) {
    expect(Object.keys(row).some((column) => /epoch|cursor|seq|accepted/.test(column))).toBe(false);
  }
  expect(member.deviceId).not.toBe(owner.deviceId);
});
