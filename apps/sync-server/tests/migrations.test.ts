/**
 * The upgrade, on a database that already had something in it.
 *
 * Every other test in this package starts from `:memory:` and therefore from a schema built by
 * running every migration back to back on an empty file. That proves the end state and says
 * nothing about the path, which is the half the rule in `db.ts` is about: a migration runs against
 * tables that already have rows in them, and one that rebuilds a table without carrying its rows —
 * migration 2 rebuilds `member`, and backfills a counter on `epoch` — passes the whole suite and
 * empties a family on the first deployment.
 *
 * So this file does what a deployment does. It builds a database at version `1`, writes into it
 * exactly what the build that shipped version `1` would have written — no `token_serial`, no
 * `ciphertext_bytes`, a `member` table keyed on the identifier alone — migrates it the rest of the
 * way, and then serves the same rows over the API to a device that signs in normally.
 *
 * What it does not hold, and no test in a package can: that an entry already shipped has not been
 * *edited*. Both the seeded database and the fresh one run the text this build carries, so an
 * older version of migration 1 exists nowhere to be compared with. That one stays a rule for
 * review, which is why it is written where the array is.
 */
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import Database from "better-sqlite3";
import { afterEach, expect, test } from "vitest";

import { SCHEMA_VERSION, migrate, openDatabase, type Db } from "../src/db.ts";
import { buildServer, type SyncServer } from "../src/server.ts";

const START = Date.UTC(2026, 0, 15, 9, 0, 0);
const EMAIL = "upgraded@example.test";
const DEVICE_ID = "8f14e45f-ceea-4e78-b2f2-1e4b9c9a7c11";
const PUBLIC_KEY = Buffer.alloc(91, 4);
/** Two envelopes of known size, so the backfilled byte counter has a number to be checked against. */
const CIPHERTEXTS = [Buffer.alloc(40, 1), Buffer.alloc(72, 2)];

let directory: string | undefined;

afterEach(() => {
  if (directory !== undefined) rmSync(directory, { recursive: true, force: true });
  directory = undefined;
});

function databasePath(): string {
  directory = mkdtempSync(join(tmpdir(), "sync-server-migrations-"));
  return join(directory, "sync.sqlite");
}

/** A connection opened the way `openDatabase` opens one, so the upgrade runs under the same pragmas. */
function open(path: string): Db {
  const db = new Database(path);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  return db;
}

interface Seeded {
  readonly accountId: string;
  readonly familyId: string;
  readonly memberId: string;
  readonly opIds: readonly string[];
}

/** The rows a build at schema version `1` would have left behind, written in that schema's shape. */
function seedVersionOne(db: Db): Seeded {
  const accountId = randomUUID();
  const familyId = randomUUID();
  const memberId = randomUUID();
  const opIds = [randomUUID(), randomUUID()];
  db.prepare("INSERT INTO account (account_id, email, created_at) VALUES (?, ?, ?)").run(
    accountId,
    EMAIL,
    START,
  );
  // No `token_serial`: the column arrives in migration 2, and the point of this row is to be one
  // the older build could actually have written.
  db.prepare(
    "INSERT INTO device (device_id, account_id, public_key, created_at, last_seen_at)" +
      " VALUES (?, ?, ?, ?, ?)",
  ).run(DEVICE_ID, accountId, PUBLIC_KEY, START, START);
  db.prepare(
    "INSERT INTO family (family_id, created_at, key_epoch, max_key_epoch, owner_member_id)" +
      " VALUES (?, ?, 1, 1, ?)",
  ).run(familyId, START, memberId);
  db.prepare(
    "INSERT INTO member (member_id, family_id, account_id, role, joined_at)" +
      " VALUES (?, ?, ?, 'owner', ?)",
  ).run(memberId, familyId, accountId, START);
  db.prepare(
    "INSERT INTO epoch (family_id, key_epoch, seq_counter, state, rotation_id)" +
      " VALUES (?, 1, 2, 'active', ?)",
  ).run(familyId, randomUUID());
  const insert = db.prepare(
    "INSERT INTO envelope (family_id, key_epoch, op_id, seq, envelope_version, kind," +
      " device_id, iv, ciphertext, received_at) VALUES (?, 1, ?, ?, 1, 'operation', ?, ?, ?, ?)",
  );
  CIPHERTEXTS.forEach((ciphertext, index) => {
    insert.run(familyId, opIds[index], index + 1, DEVICE_ID, Buffer.alloc(12, 9), ciphertext, START);
  });
  return { accountId, familyId, memberId, opIds };
}

function start(path: string, codes: string[]): SyncServer {
  return buildServer({
    databasePath: path,
    allowedOrigins: [],
    now: () => START,
    deliverLoginCode: (_email, code) => codes.push(code),
    logLevel: "silent",
  });
}

/** The ordinary sign-in of 6.1, on the device the older build had already registered. */
async function signInAsSeeded(server: SyncServer, codes: string[]): Promise<string> {
  await server.app.ready();
  const requested = await server.app.inject({
    method: "POST",
    url: "/v1/auth/code",
    payload: { email: EMAIL },
  });
  expect(requested.statusCode).toBe(202);
  const verified = await server.app.inject({
    method: "POST",
    url: "/v1/auth/verify",
    payload: {
      email: EMAIL,
      code: codes.at(-1),
      deviceId: DEVICE_ID,
      // The same key the row already holds. A migration that lost it would land here as
      // `device_key_conflict`, which is the refusal 5.4 reserves for a substitution.
      publicKey: PUBLIC_KEY.toString("base64"),
    },
  });
  expect(verified.statusCode).toBe(200);
  return JSON.parse(verified.body).accessToken as string;
}

test("a database written at schema version 1 is carried forward with its rows", async () => {
  const path = databasePath();
  const old = open(path);
  migrate(old, 1);
  expect(Number(old.pragma("user_version", { simple: true }))).toBe(1);
  const seeded = seedVersionOne(old);

  migrate(old);
  expect(Number(old.pragma("user_version", { simple: true }))).toBe(SCHEMA_VERSION);

  // The membership survived a migration that rebuilt its table under a different primary key.
  const member = old
    .prepare("SELECT member_id, family_id, role, removed_at FROM member WHERE account_id = ?")
    .get(seeded.accountId) as { member_id: string; family_id: string; role: string; removed_at: number | null };
  expect(member).toMatchObject({
    member_id: seeded.memberId,
    family_id: seeded.familyId,
    role: "owner",
    removed_at: null,
  });
  // And it is the *new* key: the identifier is free in another family, which is the whole reason
  // the table was rebuilt. Another account, because 2.1's "at most one family" is a second index
  // on the same table and it is still in force.
  const otherFamily = randomUUID();
  const otherAccount = randomUUID();
  old
    .prepare("INSERT INTO account (account_id, email, created_at) VALUES (?, ?, ?)")
    .run(otherAccount, `other-${otherAccount}@example.test`, START);
  old
    .prepare("INSERT INTO family (family_id, created_at, key_epoch, max_key_epoch, owner_member_id) VALUES (?, ?, 1, 1, ?)")
    .run(otherFamily, START, seeded.memberId);
  expect(() =>
    old
      .prepare("INSERT INTO member (member_id, family_id, account_id, role, joined_at) VALUES (?, ?, ?, 'owner', ?)")
      .run(seeded.memberId, otherFamily, otherAccount, START),
  ).not.toThrow();

  // The columns added by migration 2, on rows written before they existed: the serial defaults to
  // the value the access tokens of a signed-in device will carry, and the byte counter is not
  // left at its default but backfilled from the envelopes that were already there.
  const device = old
    .prepare("SELECT token_serial FROM device WHERE device_id = ?")
    .get(DEVICE_ID) as { token_serial: number };
  expect(device.token_serial).toBe(0);
  const epoch = old
    .prepare("SELECT seq_counter, ciphertext_bytes FROM epoch WHERE family_id = ? AND key_epoch = 1")
    .get(seeded.familyId) as { seq_counter: number; ciphertext_bytes: number };
  expect(epoch.ciphertext_bytes).toBe(CIPHERTEXTS[0]!.length + CIPHERTEXTS[1]!.length);
  expect(epoch.seq_counter).toBe(2);
  old.close();

  // Now the same file, through the server. This is the assertion the rest of the suite cannot
  // make: the family that existed before the upgrade is reachable after it, by its own device.
  const codes: string[] = [];
  const server = start(path, codes);
  const token = await signInAsSeeded(server, codes);
  const me = await server.app.inject({
    method: "GET",
    url: "/v1/families/me",
    headers: { authorization: `Bearer ${token}` },
  });
  expect(me.statusCode).toBe(200);
  expect(JSON.parse(me.body)).toMatchObject({
    familyId: seeded.familyId,
    keyEpoch: 1,
    memberId: seeded.memberId,
    role: "owner",
  });

  const journal = await server.app.inject({
    method: "GET",
    url: `/v1/families/${seeded.familyId}/envelopes?keyEpoch=1&after=0`,
    headers: { authorization: `Bearer ${token}` },
  });
  expect(journal.statusCode).toBe(200);
  expect(JSON.parse(journal.body).envelopes.map((row: { opId: string }) => row.opId)).toEqual([
    ...seeded.opIds,
  ]);

  // And the journal goes on from where it stopped rather than beginning again on top of it.
  const appended = await server.app.inject({
    method: "POST",
    url: `/v1/families/${seeded.familyId}/envelopes`,
    headers: { authorization: `Bearer ${token}` },
    payload: {
      envelopes: [
        {
          envelopeVersion: 1,
          kind: "operation",
          familyId: seeded.familyId,
          opId: randomUUID(),
          deviceId: DEVICE_ID,
          keyEpoch: 1,
          iv: Buffer.alloc(12, 3).toString("base64"),
          ciphertext: Buffer.alloc(16, 5).toString("base64"),
        },
      ],
    },
  });
  expect(appended.statusCode).toBe(200);
  expect(JSON.parse(appended.body).accepted[0].seq).toBe(3);
  await server.close();
});

test("an upgraded database and a fresh one end up with the same schema", async () => {
  // The other half of "a database that has already run a migration agrees with a fresh one": the
  // rows are checked above, and here it is the schema itself, after the same list was applied in
  // two stints to a populated file and in one to an empty one. The statements that make the two
  // diverge are the ones whose effect depends on what is already there — an `IF NOT EXISTS` over a
  // table a later entry rebuilt, an index recreated on one path and not the other — and the
  // divergence surfaces months later as a query that is an index seek on one deployment and a scan
  // on the next.
  const upgradedPath = databasePath();
  const upgraded = open(upgradedPath);
  migrate(upgraded, 1);
  seedVersionOne(upgraded);
  migrate(upgraded);

  const freshPath = join(directory!, "fresh.sqlite");
  const fresh = openDatabase(freshPath);

  const schemaOf = (db: Db): unknown[] =>
    db
      .prepare(
        "SELECT type, name, tbl_name, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_stat%'" +
          " ORDER BY type, name",
      )
      .all();
  expect(schemaOf(upgraded)).toEqual(schemaOf(fresh));
  upgraded.close();
  fresh.close();
});

test("opening a database that is already current changes nothing", async () => {
  const path = databasePath();
  const first = openDatabase(path);
  first
    .prepare("INSERT INTO account (account_id, email, created_at) VALUES (?, ?, ?)")
    .run(randomUUID(), EMAIL, START);
  first.close();

  const second = openDatabase(path);
  expect(Number(second.pragma("user_version", { simple: true }))).toBe(SCHEMA_VERSION);
  const accounts = second.prepare("SELECT COUNT(*) AS n FROM account").get() as { n: number };
  expect(accounts.n).toBe(1);
  second.close();
});

test("a database written by a newer build is refused rather than half-read", async () => {
  const path = databasePath();
  const ahead = open(path);
  migrate(ahead);
  // The state a rollback produces: the file has been through a migration this build does not have,
  // so its schema is not the one every query here is written against.
  ahead.pragma(`user_version = ${SCHEMA_VERSION + 1}`);
  ahead.close();

  expect(() => openDatabase(path)).toThrow(/newer than this build understands/);
});
