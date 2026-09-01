/**
 * The refusals a client branches on, each provoked once.
 *
 * `errors.ts` calls its enumeration a contract, and until this file five of its codes were named
 * by no test at all — `no_rotation`, `invite_invalid`, `device_key_conflict`, `no_family` and
 * `internal` — which are precisely the ones the client phase has to act on when a rotation stalls
 * or a device tries to join a family. A code is a contract only if something holds the wire to it:
 * renaming one, or answering with a neighbour, has to break something here.
 *
 * `expectRefusal` checks two things at once — that the code on the wire is the expected one, and
 * that it is a member of `API_ERROR_CODES`. The second half is what stops a route from inventing a
 * code the enumeration does not list, which the compiler catches at the throw and nothing catches
 * on the wire.
 */
import { afterEach, expect, test } from "vitest";

import { API_ERROR_CODES, type ApiErrorCode } from "../src/errors.ts";
import { HKDF_SALT_BYTES } from "../src/limits.ts";
import {
  call,
  createFamily,
  createHarness,
  envelope,
  signIn,
  uuid,
  type Harness,
  type Response,
} from "./support.ts";

let harness: Harness | undefined;

afterEach(async () => {
  await harness?.close();
  harness = undefined;
});

function expectRefusal(response: Response, statusCode: number, code: ApiErrorCode): void {
  expect(API_ERROR_CODES).toContain(code);
  expect(response.statusCode, response.body).toBe(statusCode);
  expect(response.json().error.code).toBe(code);
}

test("a device in no family is told so, and not that it is forbidden", async () => {
  harness = createHarness();
  const stranger = await signIn(harness);
  const me = await call(harness, "GET", "/v1/families/me", { token: stranger.accessToken });
  // 403 with `no_family`, because the account is authenticated and simply has nothing to read:
  // the client's answer is the "create or join a family" screen, not "you are not allowed".
  expectRefusal(me, 403, "no_family");
});

test("a second public key under a registered deviceId is refused as a key conflict", async () => {
  harness = createHarness();
  const session = await signIn(harness);
  const requested = await call(harness, "POST", "/v1/auth/code", {
    payload: { email: session.email },
  });
  expect(requested.statusCode).toBe(202);
  const conflicting = await call(harness, "POST", "/v1/auth/verify", {
    payload: {
      email: session.email,
      code: harness.codes.at(-1)?.code,
      deviceId: session.deviceId,
      // 5.4: the device key is made once and a reinstall produces a new `deviceId`. This is either
      // a mistake or a substitution, and the client has to tell it apart from a bad code.
      publicKey: Buffer.alloc(91, 7).toString("base64"),
    },
  });
  expectRefusal(conflicting, 409, "device_key_conflict");
});

test("joining on an invite that does not exist is invite_invalid, and creating a taken one is not", async () => {
  harness = createHarness();
  const owner = await signIn(harness);
  const family = await createFamily(harness, owner);
  const joiner = await signIn(harness);

  const join = await call(harness, "POST", "/v1/invites/join", {
    token: joiner.accessToken,
    payload: {
      inviteId: uuid(),
      authToken: Buffer.alloc(32, 1).toString("base64"),
      memberId: uuid(),
      bindProof: Buffer.alloc(32, 2).toString("base64"),
    },
  });
  // The joining device's refusal: unknown, used or expired, and the remedy is a new code.
  expectRefusal(join, 404, "invite_invalid");

  const body = (inviteId: string): Record<string, unknown> => ({
    familyId: family.familyId,
    keyEpoch: 1,
    inviteId,
    iv: Buffer.alloc(12, 3).toString("base64"),
    ciphertext: Buffer.alloc(48, 4).toString("base64"),
    authTokenDigest: Buffer.alloc(32, 5).toString("base64"),
  });
  const inviteId = uuid();
  const url = `/v1/families/${family.familyId}/invites`;
  expect(
    (await call(harness, "POST", url, { token: owner.accessToken, payload: body(inviteId) }))
      .statusCode,
  ).toBe(201);
  const clash = await call(harness, "POST", url, {
    token: owner.accessToken,
    payload: body(inviteId),
  });
  // The issuing device's refusal, and a different one: the remedy is another identifier. The two
  // shared `invite_invalid` and could not even be told apart by status, being `409` and `404`.
  expectRefusal(clash, 409, "invite_exists");
});

test("a taken familyId is not the same answer as an account that already has a family", async () => {
  harness = createHarness();
  const first = await signIn(harness);
  const family = await createFamily(harness, first);

  const second = await signIn(harness);
  const taken = await call(harness, "POST", "/v1/families", {
    token: second.accessToken,
    payload: { familyId: family.familyId, memberId: uuid(), rotationId: uuid() },
  });
  // The caller is in no family: told `already_in_family`, a client would show them a family they
  // do not have. What they need is another identifier.
  expectRefusal(taken, 409, "family_exists");

  const again = await call(harness, "POST", "/v1/families", {
    token: first.accessToken,
    payload: { familyId: uuid(), memberId: uuid(), rotationId: uuid() },
  });
  expectRefusal(again, 409, "already_in_family");
});

test("no_rotation covers a rotation that cannot be carried further, and nothing else", async () => {
  harness = createHarness();
  const owner = await signIn(harness);
  const family = await createFamily(harness, owner);
  const rotationUrl = `/v1/families/${family.familyId}/rotation`;

  const cancelled = await call(harness, "DELETE", rotationUrl, { token: owner.accessToken });
  expectRefusal(cancelled, 409, "no_rotation");

  const rotationId = uuid();
  const declared = await call(harness, "POST", rotationUrl, {
    token: owner.accessToken,
    payload: { rotationId },
  });
  expect(declared.statusCode).toBe(201);

  const other = await call(harness, "POST", `${rotationUrl}/keys`, {
    token: owner.accessToken,
    payload: { rotationId: uuid() },
  });
  expectRefusal(other, 409, "no_rotation");

  // 5.4: without the confirmation the switch would leave every other device unable to accept the
  // new key. Still the rotation's own refusal, and still the same code.
  const early = await call(harness, "POST", `${rotationUrl}/complete`, {
    token: owner.accessToken,
    payload: { rotationId },
  });
  expectRefusal(early, 409, "no_rotation");
});

test("an epoch with no rotation identifier is its own refusal, not a rotation one", async () => {
  harness = createHarness();
  const owner = await signIn(harness);
  const family = await createFamily(harness, owner);
  // Every epoch this server writes carries a `rotationId` — 6.2 for the first, 5.5 step 1 for each
  // later one — so the state has to be made underneath. The route refuses to assume it away, and
  // what it must not do is call it a rotation: no rotation was asked for here.
  harness.server.db
    .prepare("UPDATE epoch SET rotation_id = NULL WHERE family_id = ? AND key_epoch = 1")
    .run(family.familyId);

  const wrap = await call(harness, "POST", `/v1/families/${family.familyId}/keys`, {
    token: owner.accessToken,
    payload: {
      deviceId: uuid(),
      salt: Buffer.alloc(HKDF_SALT_BYTES, 1).toString("base64"),
      iv: Buffer.alloc(12, 2).toString("base64"),
      ciphertext: Buffer.alloc(64, 3).toString("base64"),
    },
  });
  expectRefusal(wrap, 409, "epoch_not_wrappable");
});

test("an internal refusal is logged and the client is told nothing else", async () => {
  harness = createHarness();
  const owner = await signIn(harness);
  const family = await createFamily(harness, owner);
  // A state no request can produce: the family stands, its epoch row does not. The route answers
  // `internal` here, and `internal` says what that means — the cause is logged without a body and
  // the client is told nothing else.
  harness.server.db.prepare("DELETE FROM epoch WHERE family_id = ?").run(family.familyId);

  const sent = await call(harness, "POST", `/v1/families/${family.familyId}/envelopes`, {
    token: owner.accessToken,
    payload: { envelopes: [envelope(family.familyId, owner.deviceId, 1)] },
  });
  expectRefusal(sent, 500, "internal");
  expect(sent.json().error.message).toBe("internal error");
  // The words that used to travel to the client instead. They belong in the log, and until the
  // handler applied one rule to every five-hundred they were in neither.
  expect(sent.body).not.toContain("epoch row is missing");
  expect(harness.logLines.join("\n")).toContain("epoch row is missing");
});
