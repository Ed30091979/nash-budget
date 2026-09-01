/**
 * 6.1 — the one-time code and the token pair, on the numbers the document fixes: a code lives
 * `10` minutes, survives `5` wrong tries and may be asked for `3` times an hour per address.
 *
 * The code is also the one secret this server generates itself, so the last test here is about
 * where it does *not* go: the plan requires that no token and no code reaches the log.
 */
import { afterEach, expect, test } from "vitest";

import {
  LOGIN_CODE_MAX_ATTEMPTS,
  LOGIN_CODE_MAX_REQUESTS_PER_HOUR,
  LOGIN_CODE_REQUEST_WINDOW_MS,
  LOGIN_CODE_TTL_MS,
} from "../src/limits.ts";
import { call, createHarness, signIn, uuid, type Harness } from "./support.ts";

let harness: Harness | undefined;

afterEach(async () => {
  await harness?.close();
  harness = undefined;
});

const EMAIL = "owner@example.test";

const wrongCode = (code: string): string => (code === "000000" ? "111111" : "000000");

async function requestCode(h: Harness, email = EMAIL) {
  const response = await call(h, "POST", "/v1/auth/code", { payload: { email } });
  return { response, code: h.codes.at(-1)?.code ?? "" };
}

function verify(h: Harness, code: string, deviceId = uuid()) {
  return call(h, "POST", "/v1/auth/verify", {
    payload: {
      email: EMAIL,
      code,
      deviceId,
      publicKey: Buffer.alloc(91, 4).toString("base64"),
    },
  });
}

test("the code dies after five wrong tries, and the right code after them is refused too", async () => {
  harness = createHarness();
  const { response, code } = await requestCode(harness);
  expect(response.statusCode).toBe(202);
  expect(code).toMatch(/^[0-9]{6}$/);

  for (let attempt = 1; attempt <= LOGIN_CODE_MAX_ATTEMPTS; attempt += 1) {
    const refused = await verify(harness, wrongCode(code));
    expect(refused.statusCode, `attempt ${attempt}`).toBe(400);
    expect(refused.json().error.code).toBe("login_code_invalid");
  }
  const tooLate = await verify(harness, code);
  expect(tooLate.statusCode).toBe(400);
  expect(tooLate.json().error.code).toBe("login_code_invalid");
  // Burnt, not merely locked: the row is gone, so a sixth try has nothing to count against.
  const rows = harness.server.db
    .prepare("SELECT COUNT(*) AS n FROM login_code WHERE email = ?")
    .get(EMAIL) as { n: number };
  expect(rows.n).toBe(0);
});

test("four wrong tries do not spend the code", async () => {
  harness = createHarness();
  const { code } = await requestCode(harness);
  for (let attempt = 1; attempt < LOGIN_CODE_MAX_ATTEMPTS; attempt += 1) {
    expect((await verify(harness, wrongCode(code))).statusCode).toBe(400);
  }
  const accepted = await verify(harness, code);
  expect(accepted.statusCode).toBe(200);
  expect(accepted.json()).toMatchObject({ accountId: expect.any(String) });
  // 6.1: a used code is a spent code.
  const replayed = await verify(harness, code);
  expect(replayed.statusCode).toBe(400);
});

test("the code expires after ten minutes to the millisecond", async () => {
  harness = createHarness();
  const { code } = await requestCode(harness);
  harness.advance(LOGIN_CODE_TTL_MS - 1);
  const inTime = await verify(harness, code);
  expect(inTime.statusCode).toBe(200);

  const second = await requestCode(harness);
  harness.advance(LOGIN_CODE_TTL_MS);
  const tooLate = await verify(harness, second.code);
  expect(tooLate.statusCode).toBe(400);
  expect(tooLate.json().error.code).toBe("login_code_invalid");
});

test("no more than three codes an hour for one address", async () => {
  harness = createHarness();
  for (let request = 1; request <= LOGIN_CODE_MAX_REQUESTS_PER_HOUR; request += 1) {
    expect((await requestCode(harness)).response.statusCode, `request ${request}`).toBe(202);
  }
  const refused = await requestCode(harness);
  expect(refused.response.statusCode).toBe(429);
  expect(refused.response.json().error.code).toBe("rate_limited");
  // The limit is per address, so another one is unaffected.
  const other = await requestCode(harness, "second@example.test");
  expect(other.response.statusCode).toBe(202);

  harness.advance(LOGIN_CODE_REQUEST_WINDOW_MS + 1);
  const afterTheHour = await requestCode(harness);
  expect(afterTheHour.response.statusCode).toBe(202);
});

test("the answer to a code request does not depend on whether the account exists", async () => {
  harness = createHarness();
  const known = await signIn(harness, "known@example.test");
  expect(known.accountId).toMatch(/^[0-9a-f-]{36}$/);
  const first = await call(harness, "POST", "/v1/auth/code", {
    payload: { email: "known@example.test" },
  });
  const second = await call(harness, "POST", "/v1/auth/code", {
    payload: { email: "never-seen@example.test" },
  });
  expect(first.statusCode).toBe(second.statusCode);
  expect(first.body).toBe(second.body);
});

test("no code and no token reaches the log", async () => {
  harness = createHarness();
  const session = await signIn(harness, EMAIL);
  const { code } = await requestCode(harness);
  await call(harness, "GET", "/v1/families/me", { token: session.accessToken });
  await verify(harness, wrongCode(code));
  const log = harness.logLines.join("\n");
  expect(log.length).toBeGreaterThan(0);
  expect(log).not.toContain(code);
  expect(log).not.toContain(session.accessToken);
  expect(log).not.toContain(session.refreshToken);
});

test("the refresh token is rotated on every use and the spent one is dead", async () => {
  harness = createHarness();
  const session = await signIn(harness);
  const rotated = await call(harness, "POST", "/v1/auth/refresh", {
    payload: { refreshToken: session.refreshToken },
  });
  expect(rotated.statusCode).toBe(200);
  expect(rotated.json().refreshToken).not.toBe(session.refreshToken);

  const replayed = await call(harness, "POST", "/v1/auth/refresh", {
    payload: { refreshToken: session.refreshToken },
  });
  expect(replayed.statusCode).toBe(401);
  expect(replayed.json().error.code).toBe("unauthorized");
});

test("a revoked device is refused at the door with the status 6.7 expects", async () => {
  harness = createHarness();
  const session = await signIn(harness);
  const revoked = await call(harness, "POST", `/v1/devices/${session.deviceId}/revoke`, {
    token: session.accessToken,
  });
  expect(revoked.statusCode).toBe(200);
  expect(revoked.json().rotationRequired).toBe(true);

  const afterwards = await call(harness, "GET", "/v1/families/me", { token: session.accessToken });
  expect(afterwards.statusCode).toBe(401);
  expect(afterwards.json().error.code).toBe("device_revoked");
  const refreshed = await call(harness, "POST", "/v1/auth/refresh", {
    payload: { refreshToken: session.refreshToken },
  });
  expect(refreshed.statusCode).toBe(401);
});
