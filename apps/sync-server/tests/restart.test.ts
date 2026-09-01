/**
 * 6.1 across a restart.
 *
 * The one-time code is stored as an HMAC under a server secret, and until the secret was kept with
 * the codes it authenticates the pair only worked within one process lifetime: a server restarted
 * between "send me a code" and "here is the code" answered a correct code with "the code is not
 * valid" — the very refusal 6.1 makes indistinguishable from a wrong one, so the symptom of the
 * defect was a user who is certain they typed it right.
 *
 * The harness of the other tests is `:memory:` by design; this one needs a database that survives
 * the process that made it, so it builds its servers by hand on a temporary file.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, expect, test } from "vitest";

import { buildServer, type SyncServer } from "../src/server.ts";

const START = Date.UTC(2026, 0, 15, 9, 0, 0);
const EMAIL = "restarted@example.test";

let directory: string | undefined;

afterEach(() => {
  if (directory !== undefined) rmSync(directory, { recursive: true, force: true });
  directory = undefined;
});

function start(databasePath: string, codes: string[]): SyncServer {
  return buildServer({
    databasePath,
    allowedOrigins: [],
    now: () => START,
    deliverLoginCode: (_email, code) => codes.push(code),
    logLevel: "silent",
  });
}

test("a code asked for before a restart still verifies after one", async () => {
  directory = mkdtempSync(join(tmpdir(), "sync-server-restart-"));
  const databasePath = join(directory, "sync.sqlite");
  const codes: string[] = [];

  const first = start(databasePath, codes);
  await first.app.ready();
  const requested = await first.app.inject({
    method: "POST",
    url: "/v1/auth/code",
    payload: { email: EMAIL },
  });
  expect(requested.statusCode).toBe(202);
  const secret = Buffer.from(first.config.tokenSecret);
  await first.close();

  const second = start(databasePath, codes);
  await second.app.ready();
  // The same secret, loaded rather than generated. Nothing in the configuration named it.
  expect(Buffer.from(second.config.tokenSecret).equals(secret)).toBe(true);
  const verified = await second.app.inject({
    method: "POST",
    url: "/v1/auth/verify",
    payload: {
      email: EMAIL,
      code: codes.at(-1),
      deviceId: "8f14e45f-ceea-4e78-b2f2-1e4b9c9a7c11",
      publicKey: Buffer.alloc(91, 4).toString("base64"),
    },
  });
  expect(verified.statusCode).toBe(200);
  const stored = second.db.prepare("SELECT COUNT(*) AS n FROM server_secret").get() as { n: number };
  expect(stored.n).toBe(1);
  await second.close();
});

test("a secret given in the configuration is still the caller's, and is not stored", async () => {
  directory = mkdtempSync(join(tmpdir(), "sync-server-restart-"));
  const databasePath = join(directory, "sync.sqlite");
  const supplied = new Uint8Array(32).fill(9);
  const server = buildServer({
    databasePath,
    allowedOrigins: [],
    tokenSecret: supplied,
    now: () => START,
    deliverLoginCode: () => undefined,
    logLevel: "silent",
  });
  await server.app.ready();
  expect(Buffer.from(server.config.tokenSecret).equals(Buffer.from(supplied))).toBe(true);
  // Loading is the default, not an override: a deployment that keeps its secret elsewhere does not
  // acquire a copy of it in the database by starting up.
  const stored = server.db.prepare("SELECT COUNT(*) AS n FROM server_secret").get() as { n: number };
  expect(stored.n).toBe(0);
  await server.close();
});
