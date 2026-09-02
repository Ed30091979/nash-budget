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
  LOGIN_CODE_REQUESTS_PER_SOURCE,
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

test("a code nobody ever tries does not stay in the table", async () => {
  harness = createHarness();
  const rows = (): { email: string }[] =>
    harness!.server.db.prepare("SELECT email FROM login_code").all() as { email: string }[];

  await requestCode(harness, "asked-for@example.test");
  expect(rows()).toHaveLength(1);

  // 6.1 gives the code ten minutes. Nothing used to remove the row but an attempt to use it, and
  // an address that never answers never makes one — so an unauthenticated request left a row for
  // good. The next request sweeps what has expired.
  harness.advance(LOGIN_CODE_TTL_MS + 1);
  await requestCode(harness, "someone-else@example.test");
  expect(rows().map((row) => row.email)).toEqual(["someone-else@example.test"]);
});

test("the address is not the only bucket: the source of the request has a ceiling of its own", async () => {
  harness = createHarness();
  // Every one of these is a different address, so 6.1's three-an-hour is nowhere near reached; the
  // address is a field of the body, and a limit keyed on it alone is a limit the sender sets.
  for (let request = 1; request <= LOGIN_CODE_REQUESTS_PER_SOURCE; request += 1) {
    const response = await requestCode(harness, `flood-${request}@example.test`);
    expect(response.response.statusCode, `request ${request}`).toBe(202);
  }
  const refused = await requestCode(harness, "flood-one-more@example.test");
  expect(refused.response.statusCode).toBe(429);
  expect(refused.response.json().error.code).toBe("rate_limited");
  const stored = harness.server.db.prepare("SELECT COUNT(*) AS n FROM login_code").get() as {
    n: number;
  };
  expect(stored.n).toBeLessThanOrEqual(LOGIN_CODE_REQUESTS_PER_SOURCE);

  harness.advance(LOGIN_CODE_REQUEST_WINDOW_MS + 1);
  const afterTheHour = await requestCode(harness, "flood-one-more@example.test");
  expect(afterTheHour.response.statusCode).toBe(202);
}, 60_000);

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

test("the address of 6.1 is ASCII, and what is refused is refused before any state", async () => {
  harness = createHarness();
  const ch = (code: number): string => String.fromCodePoint(code);
  const publicKey = Buffer.alloc(91, 4).toString("base64");
  // Each of these used to be accepted: the pattern excluded `@` and whitespace and nothing else.
  // The first five are the finding — an address that does not display as what it is — and the
  // rest are the shapes a mailbox cannot have, refused here rather than discovered by the mail
  // transport after an account exists.
  const refused: readonly (readonly [string, string])[] = [
    [ch(0x202e) + "admin@example.test", "a bidirectional override reverses the text beside it"],
    ["a" + ch(0x200b) + "dmin@example.test", "a zero-width space is invisible and is not a letter"],
    [ch(0xfeff) + "admin@example.test", "a byte-order mark in front of a name"],
    ["a" + ch(0x2066) + "dmin@example.test", "an isolate does the same as an override"],
    ["ad" + ch(0x0000) + "min@example.test", "3.2 refuses codes below 0x20 in any string"],
    [ch(0x0430) + "dmin@example.test", "a Cyrillic a in place of the Latin one"],
    ["admin@" + ch(0x0435) + "xample.test", "the same homoglyph, in the domain"],
    // The two that would defeat the normalisation rather than the display. Case folding is what
    // makes one address one string, and outside ASCII it stops being a fold: the first of these
    // lower-cases into *two* code points, so what is stored is not what was typed; the second is
    // a Kelvin sign, which lower-cases to a plain `k` and would quietly merge two addresses that
    // a person reads as different.
    [ch(0x0130) + "van@example.test", "its lower case is two code points, not one"],
    ["a" + ch(0x212a) + "@example.test", "a Kelvin sign lower-cases into an ordinary k"],
    ['"john doe"@example.test', "the quoted local part, legal and never typed"],
    ["admin@[192.0.2.1]", "the address literal, legal and never typed"],
    ["admin@example", "a mailbox needs more than one label"],
    ["admin@example.t", "a one-character last label is not a domain"],
    ["admin@-example.test", "a label does not begin with a hyphen"],
    ["admin@example-.test", "a label does not end with one either"],
    [".admin@example.test", "a dot separates atoms, so it cannot lead"],
    ["admin.@example.test", "nor trail"],
    ["ad..min@example.test", "nor stand beside itself"],
    ["a".repeat(65) + "@example.test", "5321 keeps the local part to 64"],
    ["admin@@example.test", "two separators are not one"],
    ["admin @example.test", "a space is not part of an address"],
  ];
  for (const [address, why] of refused) {
    const asked = await call(harness, "POST", "/v1/auth/code", { payload: { email: address } });
    expect(asked.statusCode, why).toBe(400);
    expect(asked.json().error.code, why).toBe("invalid_request");
    // The second door takes the same address and refuses it the same way. `login_code_invalid`
    // would be the wrong answer here: nothing about a code was reached.
    const verified = await call(harness, "POST", "/v1/auth/verify", {
      payload: { email: address, code: "123456", deviceId: uuid(), publicKey },
    });
    expect(verified.statusCode, why).toBe(400);
    expect(verified.json().error.code, why).toBe("invalid_request");
  }

  // Refused at the schema, so nothing downstream ever saw the string: no row was written for it,
  // no account was made, and — the one that matters for a rate limit — no bucket was created in
  // its name. Every one of them, and the tables are as they started.
  const rows = (table: string): number =>
    (harness!.server.db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
  expect(rows("login_code")).toBe(0);
  expect(rows("account")).toBe(0);
  expect(rows("throttle")).toBe(0);

  // And the addresses people actually have still pass, punycode among them: a domain written in
  // another script arrives here in its `xn--` form, so the ASCII rule needs no exception for it.
  const accepted = [
    "plain@example.test",
    "first.last+tag@sub.example.co.uk",
    "o'brien@mail.ru",
    "user-3f2b@example.test",
    "x@xn--80ak6aa92e.xn--p1ai",
    "a".repeat(64) + "@example.test",
  ];
  for (const address of accepted) {
    const asked = await call(harness, "POST", "/v1/auth/code", { payload: { email: address } });
    expect(asked.statusCode, address).toBe(202);
  }
  expect(rows("login_code")).toBe(accepted.length);
});

test("one address is one account, however it is spelled", async () => {
  harness = createHarness();
  const publicKey = Buffer.alloc(91, 5).toString("base64");
  const deviceId = uuid();

  const asked = await call(harness, "POST", "/v1/auth/code", {
    payload: { email: "Mixed.Case@Example.Test" },
  });
  expect(asked.statusCode).toBe(202);
  // The code is delivered to the folded address and the row is keyed by it, so the second
  // spelling finds the first one's code instead of missing it.
  expect(harness.codes.at(-1)?.email).toBe("mixed.case@example.test");
  const stored = harness.server.db.prepare("SELECT email FROM login_code").all() as {
    email: string;
  }[];
  expect(stored.map((row) => row.email)).toEqual(["mixed.case@example.test"]);

  const verified = await call(harness, "POST", "/v1/auth/verify", {
    payload: {
      email: "mixed.case@EXAMPLE.test",
      code: harness.codes.at(-1)?.code,
      deviceId,
      publicKey,
    },
  });
  expect(verified.statusCode).toBe(200);
  const accountId = verified.json().accountId;

  // A third spelling signs into the same account. Were the spellings kept apart, this would be a
  // second `account` row for one mailbox — reachable only by typing the address the same way
  // twice, and carrying a code budget of its own.
  const again = await requestCode(harness, "MIXED.CASE@EXAMPLE.TEST");
  expect(again.response.statusCode).toBe(202);
  const reverified = await call(harness, "POST", "/v1/auth/verify", {
    payload: { email: "Mixed.Case@Example.Test", code: again.code, deviceId, publicKey },
  });
  expect(reverified.statusCode).toBe(200);
  expect(reverified.json().accountId).toBe(accountId);
  const accounts = harness.server.db.prepare("SELECT email FROM account").all() as {
    email: string;
  }[];
  expect(accounts.map((row) => row.email)).toEqual(["mixed.case@example.test"]);

  // And the per-address counter of 6.1 is one counter. Three requests in three spellings spend
  // it; the fourth is refused. The source ceiling is `30` and stands nowhere near this, so the
  // limit that answered is the address's own.
  const spellings = ["Rate@Example.Test", "rate@EXAMPLE.test", "RATE@example.TEST"];
  expect(spellings).toHaveLength(LOGIN_CODE_MAX_REQUESTS_PER_HOUR);
  for (const spelling of spellings) {
    expect((await requestCode(harness, spelling)).response.statusCode, spelling).toBe(202);
  }
  const fourth = await requestCode(harness, "rate@example.test");
  expect(fourth.response.statusCode).toBe(429);
  expect(fourth.response.json().error.code).toBe("rate_limited");
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

test("signing out ends the access token too, not the refresh token alone", async () => {
  harness = createHarness();
  const session = await signIn(harness, EMAIL);
  expect((await call(harness, "GET", "/v1/families/me", { token: session.accessToken })).statusCode)
    .toBe(403);

  const out = await call(harness, "POST", "/v1/auth/logout", { token: session.accessToken });
  expect(out.statusCode).toBe(200);
  // 6.7 revokes at the door and takes effect at once. Signing out used to leave the access token
  // good for the rest of its fifteen minutes, which is not what the word says.
  const afterwards = await call(harness, "GET", "/v1/families/me", { token: session.accessToken });
  expect(afterwards.statusCode).toBe(401);
  expect(afterwards.json().error.code).toBe("unauthorized");
  const refreshed = await call(harness, "POST", "/v1/auth/refresh", {
    payload: { refreshToken: session.refreshToken },
  });
  expect(refreshed.statusCode).toBe(401);

  // And signing out is not revocation: the same device signs in again and is itself once more.
  const again = await signIn(harness, EMAIL, session.deviceId);
  expect((await call(harness, "GET", "/v1/families/me", { token: again.accessToken })).statusCode)
    .toBe(403);
  expect(again.deviceId).toBe(session.deviceId);
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
