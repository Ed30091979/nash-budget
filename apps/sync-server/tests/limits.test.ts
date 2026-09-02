/**
 * The wire limits of 3.2 and the rate limits of 5.3 and phase S3, on their own numbers.
 *
 * Refusal, never truncation: 3.2 is explicit that a value over a limit is rejected rather than
 * trimmed, and the invite counter of 5.3 is the one that stands between a copied invite box and a
 * `60`-bit code, so it is checked here rather than assumed.
 */
import { afterEach, expect, test } from "vitest";

import {
  ENVELOPE_BATCHES_PER_WINDOW,
  ENVELOPE_BATCH_WINDOW_MS,
  ENVELOPE_KINDS,
  FAMILY_ENVELOPE_QUOTA,
  FAMILY_EPOCH_CIPHERTEXT_BYTES,
  INVITE_CLAIM_FAILURES_PER_WINDOW,
  INVITE_CLAIM_WINDOW_MS,
  MAX_CHECKPOINT_CIPHERTEXT_BYTES,
  MAX_ENVELOPES_PER_BATCH,
  MAX_OPERATION_CIPHERTEXT_BYTES,
} from "../src/limits.ts";
import {
  call,
  createFamily,
  createHarness,
  envelope,
  refreshSession,
  signIn,
  uuid,
  type Harness,
} from "./support.ts";

let harness: Harness | undefined;

afterEach(async () => {
  await harness?.close();
  harness = undefined;
});

test("a batch of more than 200 envelopes is refused, and 200 is accepted", async () => {
  harness = createHarness();
  const owner = await signIn(harness);
  const family = await createFamily(harness, owner);
  const url = `/v1/families/${family.familyId}/envelopes`;

  const full = Array.from({ length: MAX_ENVELOPES_PER_BATCH }, () =>
    envelope(family.familyId, owner.deviceId, 1),
  );
  const accepted = await call(harness, "POST", url, {
    token: owner.accessToken,
    payload: { envelopes: full },
  });
  expect(accepted.statusCode).toBe(200);
  expect(accepted.json().accepted).toHaveLength(MAX_ENVELOPES_PER_BATCH);
  expect(accepted.json().accepted.at(-1).seq).toBe(MAX_ENVELOPES_PER_BATCH);

  const oversized = await call(harness, "POST", url, {
    token: owner.accessToken,
    payload: {
      envelopes: [...full, envelope(family.familyId, owner.deviceId, 1)],
    },
  });
  expect(oversized.statusCode).toBe(400);
  expect(oversized.json().error.code).toBe("invalid_request");
});

test("an operation ciphertext over 8 KiB plus the tag is refused, not truncated", async () => {
  harness = createHarness();
  const owner = await signIn(harness);
  const family = await createFamily(harness, owner);
  const url = `/v1/families/${family.familyId}/envelopes`;

  const atTheLimit = envelope(family.familyId, owner.deviceId, 1, {
    ciphertext: Buffer.alloc(MAX_OPERATION_CIPHERTEXT_BYTES, 1).toString("base64"),
  });
  expect(
    (await call(harness, "POST", url, {
      token: owner.accessToken,
      payload: { envelopes: [atTheLimit] },
    })).statusCode,
  ).toBe(200);

  const oneOver = envelope(family.familyId, owner.deviceId, 1, {
    ciphertext: Buffer.alloc(MAX_OPERATION_CIPHERTEXT_BYTES + 1, 1).toString("base64"),
  });
  const refused = await call(harness, "POST", url, {
    token: owner.accessToken,
    payload: { envelopes: [oneOver] },
  });
  expect(refused.statusCode).toBe(400);
  expect(refused.json().error.code).toBe("invalid_request");
  // Nothing of the refused batch was stored, and nothing was shortened to fit.
  const stored = harness.server.db
    .prepare("SELECT LENGTH(ciphertext) AS bytes FROM envelope WHERE family_id = ?")
    .all(family.familyId) as { bytes: number }[];
  expect(stored).toEqual([{ bytes: MAX_OPERATION_CIPHERTEXT_BYTES }]);

  // A checkpoint (3.6) is not an operation and gets the larger bound named in `limits.ts`. The
  // bound belongs to the kind, and the kind is one of the two 2.2 enumerates — so the larger bound
  // is not something a sender awards itself by inventing a word for what it is sending. This is
  // the half the earlier version of this test left out: it checked that the bigger limit was
  // granted and never that it was earned.
  expect([...ENVELOPE_KINDS]).toEqual(["operation", "checkpoint"]);
  // Refused on the word alone, at any size: 2.2 names two kinds, and a field that decides which
  // limit applies may not be a free-text field. An invented kind used to be stored happily, held
  // to the operation bound — which is the same as saying that what the bound applied to was
  // whatever the sender had decided to call it.
  for (const kind of ["chekpoint", "checkpoint-v2", "anchor", "operation-large"]) {
    const invented = await call(harness, "POST", url, {
      token: owner.accessToken,
      payload: { envelopes: [envelope(family.familyId, owner.deviceId, 1, { kind })] },
    });
    expect(invented.statusCode, kind).toBe(400);
    expect(invented.json().error.code).toBe("invalid_request");
  }
  const kinds = harness.server.db
    .prepare("SELECT DISTINCT kind FROM envelope WHERE family_id = ?")
    .all(family.familyId) as { kind: string }[];
  expect(kinds.map((row) => row.kind)).toEqual(["operation"]);

  const spent = (): number =>
    (
      harness!.server.db
        .prepare("SELECT ciphertext_bytes AS bytes FROM epoch WHERE family_id = ? AND key_epoch = 1")
        .get(family.familyId) as { bytes: number }
    ).bytes;
  const before = spent();
  const checkpoint = envelope(family.familyId, owner.deviceId, 1, {
    kind: "checkpoint",
    ciphertext: Buffer.alloc(MAX_CHECKPOINT_CIPHERTEXT_BYTES, 2).toString("base64"),
  });
  expect(
    (await call(harness, "POST", url, {
      token: owner.accessToken,
      payload: { envelopes: [checkpoint] },
    })).statusCode,
  ).toBe(200);
  // Stored whole and charged whole: the epoch budget of 3.2.1 counts the bytes a checkpoint
  // actually costs, which is what makes the larger bound a price rather than a loophole.
  expect(spent() - before).toBe(MAX_CHECKPOINT_CIPHERTEXT_BYTES);
});

test("the epoch budget is spent in bytes, so the larger envelope buys no extra storage", async () => {
  harness = createHarness();
  const owner = await signIn(harness);
  const family = await createFamily(harness, owner);
  const url = `/v1/families/${family.familyId}/envelopes`;

  // 3.2.1 allots the epoch `100 000` envelopes of the `8` KiB of 3.2 — call it what it is, a
  // budget of bytes. Spending it through the route would be a hundred thousand round trips for one
  // assertion, so the counter is set underneath and the boundary is crossed through the route.
  harness.server.db
    .prepare("UPDATE epoch SET ciphertext_bytes = ? WHERE family_id = ? AND key_epoch = 1")
    .run(FAMILY_EPOCH_CIPHERTEXT_BYTES - MAX_OPERATION_CIPHERTEXT_BYTES, family.familyId);

  const checkpoint = envelope(family.familyId, owner.deviceId, 1, {
    kind: "checkpoint",
    ciphertext: Buffer.alloc(MAX_CHECKPOINT_CIPHERTEXT_BYTES, 3).toString("base64"),
  });
  const refused = await call(harness, "POST", url, {
    token: owner.accessToken,
    payload: { envelopes: [checkpoint] },
  });
  expect(refused.statusCode).toBe(409);
  expect(refused.json()).toMatchObject({
    error: {
      code: "quota_exhausted",
      keyEpoch: 1,
      quota: FAMILY_ENVELOPE_QUOTA,
      quotaBytes: FAMILY_EPOCH_CIPHERTEXT_BYTES,
    },
  });
  // The envelope count is nowhere near `100 000`: what ran out is the storage that figure stands
  // for, and no `kind` gets to spend more of it than it takes.
  const held = harness.server.db
    .prepare("SELECT COUNT(*) AS n FROM envelope WHERE family_id = ?")
    .get(family.familyId) as { n: number };
  expect(held.n).toBe(0);

  // What fits is still accepted, and the last operation the budget pays for is one of them.
  const fitting = await call(harness, "POST", url, {
    token: owner.accessToken,
    payload: {
      envelopes: [
        envelope(family.familyId, owner.deviceId, 1, {
          ciphertext: Buffer.alloc(MAX_OPERATION_CIPHERTEXT_BYTES, 4).toString("base64"),
        }),
      ],
    },
  });
  expect(fitting.statusCode).toBe(200);
});

test("a body over a megabyte is refused with a code the client can act on", async () => {
  harness = createHarness();
  const owner = await signIn(harness);
  const family = await createFamily(harness, owner);
  const fat = Array.from({ length: MAX_ENVELOPES_PER_BATCH }, () =>
    envelope(family.familyId, owner.deviceId, 1, {
      ciphertext: Buffer.alloc(MAX_OPERATION_CIPHERTEXT_BYTES, 7).toString("base64"),
    }),
  );
  const response = await call(harness, "POST", `/v1/families/${family.familyId}/envelopes`, {
    token: owner.accessToken,
    payload: { envelopes: fat },
    headers: { "content-type": "application/json" },
  });
  expect(response.statusCode).toBe(413);
  expect(response.json().error.code).toBe("batch_too_large");
});

test("a device may send sixty batches a minute and not sixty-one", async () => {
  harness = createHarness();
  const owner = await signIn(harness);
  const family = await createFamily(harness, owner);
  const url = `/v1/families/${family.familyId}/envelopes`;
  for (let batch = 1; batch <= ENVELOPE_BATCHES_PER_WINDOW; batch += 1) {
    const response = await call(harness, "POST", url, {
      token: owner.accessToken,
      payload: { envelopes: [envelope(family.familyId, owner.deviceId, 1)] },
    });
    expect(response.statusCode, `batch ${batch}`).toBe(200);
  }
  const refused = await call(harness, "POST", url, {
    token: owner.accessToken,
    payload: { envelopes: [envelope(family.familyId, owner.deviceId, 1)] },
  });
  expect(refused.statusCode).toBe(429);
  expect(refused.json().error.code).toBe("rate_limited");

  harness.advance(ENVELOPE_BATCH_WINDOW_MS + 1);
  await refreshSession(harness, owner);
  const afterTheWindow = await call(harness, "POST", url, {
    token: owner.accessToken,
    payload: { envelopes: [envelope(family.familyId, owner.deviceId, 1)] },
  });
  expect(afterTheWindow.statusCode).toBe(200);
  expect(afterTheWindow.json().accepted[0].seq).toBe(ENVELOPE_BATCHES_PER_WINDOW + 1);
}, 60_000);

test("five failed invite lookups in a quarter of an hour and no more", async () => {
  harness = createHarness();
  const joiner = await signIn(harness);
  const guess = Buffer.alloc(32, 1).toString("base64");
  for (let attempt = 1; attempt <= INVITE_CLAIM_FAILURES_PER_WINDOW; attempt += 1) {
    const response = await call(harness, "POST", "/v1/invites/claim", {
      token: joiner.accessToken,
      payload: { authToken: guess },
    });
    expect(response.statusCode, `attempt ${attempt}`).toBe(404);
    expect(response.json().error.code).toBe("not_found");
  }
  const throttled = await call(harness, "POST", "/v1/invites/claim", {
    token: joiner.accessToken,
    payload: { authToken: guess },
  });
  expect(throttled.statusCode).toBe(429);
  expect(throttled.json().error.code).toBe("rate_limited");
});

test("both steps of accepting an invite spend one counter, and joining cannot outrun it", async () => {
  harness = createHarness();
  const joiner = await signIn(harness);
  const guess = Buffer.alloc(32, 3).toString("base64");
  const join = (inviteId: string) =>
    call(harness as Harness, "POST", "/v1/invites/join", {
      token: joiner.accessToken,
      payload: {
        inviteId,
        authToken: guess,
        memberId: uuid(),
        bindProof: Buffer.alloc(32, 4).toString("base64"),
      },
    });

  // 5.3 states the limit once, for the acceptance of an invite, and the acceptance is two steps.
  // Three failed lookups and two failed joins are five failures, not three and two.
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    const lookup = await call(harness, "POST", "/v1/invites/claim", {
      token: joiner.accessToken,
      payload: { authToken: guess },
    });
    expect(lookup.statusCode, `lookup ${attempt}`).toBe(404);
  }
  // A fresh `inviteId` each time: the bucket is keyed by the account and the address of the
  // socket, never by a value out of the body, so changing the one field the caller chooses does
  // not buy another budget.
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    const refused = await join(uuid());
    expect(refused.statusCode, `join ${attempt}`).toBe(404);
    expect(refused.json().error.code).toBe("invite_invalid");
  }

  const sixthJoin = await join(uuid());
  expect(sixthJoin.statusCode).toBe(429);
  expect(sixthJoin.json().error.code).toBe("rate_limited");
  const sixthLookup = await call(harness, "POST", "/v1/invites/claim", {
    token: joiner.accessToken,
    payload: { authToken: guess },
  });
  expect(sixthLookup.statusCode).toBe(429);

  // The window is fifteen minutes wide and not a day: past it, the same request is answered again.
  harness.advance(INVITE_CLAIM_WINDOW_MS + 1);
  await refreshSession(harness, joiner);
  const later = await join(uuid());
  expect(later.statusCode).toBe(404);
  expect(later.json().error.code).toBe("invite_invalid");
});

test("a join that fails on anything but the token spends nothing", async () => {
  harness = createHarness();
  const owner = await signIn(harness);
  await createFamily(harness, owner);
  // The owner is in a family already, so this join is refused before it is ever a guess. Charging
  // it to the counter of 5.3 would let an honest mistake spend the budget that guards the code.
  for (let attempt = 1; attempt <= INVITE_CLAIM_FAILURES_PER_WINDOW + 1; attempt += 1) {
    const refused = await call(harness, "POST", "/v1/invites/join", {
      token: owner.accessToken,
      payload: {
        inviteId: uuid(),
        authToken: Buffer.alloc(32, 5).toString("base64"),
        memberId: uuid(),
        bindProof: Buffer.alloc(32, 6).toString("base64"),
      },
    });
    expect(refused.statusCode, `attempt ${attempt}`).toBe(409);
    expect(refused.json().error.code).toBe("already_in_family");
  }
  expect(
    (
      harness.server.db
        .prepare("SELECT COUNT(*) AS n FROM throttle WHERE bucket LIKE 'invite-claim:%'")
        .get() as { n: number }
    ).n,
  ).toBe(0);
});

test("an account belongs to at most one family", async () => {
  harness = createHarness();
  const owner = await signIn(harness);
  await createFamily(harness, owner);
  const second = await call(harness, "POST", "/v1/families", {
    token: owner.accessToken,
    payload: { familyId: uuid(), memberId: uuid(), rotationId: uuid() },
  });
  expect(second.statusCode).toBe(409);
  expect(second.json().error.code).toBe("already_in_family");
});

test("two families may use the same member identifier, and neither is told of the other", async () => {
  harness = createHarness();
  const first = await signIn(harness);
  const second = await signIn(harness);
  // 2.2 lets the client choose `memberId`, and with a globally keyed table one family's choice
  // could collide with another's — a `500` for the caller and, read the other way, an answer to
  // "does this identifier exist somewhere". The key is the pair, so the question cannot be asked.
  const shared = uuid();
  const one = await call(harness, "POST", "/v1/families", {
    token: first.accessToken,
    payload: { familyId: uuid(), memberId: shared, rotationId: uuid() },
  });
  expect(one.statusCode).toBe(201);
  const other = await call(harness, "POST", "/v1/families", {
    token: second.accessToken,
    payload: { familyId: uuid(), memberId: shared, rotationId: uuid() },
  });
  expect(other.statusCode).toBe(201);
  expect(other.json().familyId).not.toBe(one.json().familyId);

  for (const [session, created] of [
    [first, one],
    [second, other],
  ] as const) {
    const me = await call(harness, "GET", "/v1/families/me", { token: session.accessToken });
    expect(me.json()).toMatchObject({
      familyId: created.json().familyId,
      memberId: shared,
      role: "owner",
    });
  }
});

test("a memberId that is not a UUID is refused, and refused before anything is written", async () => {
  harness = createHarness();
  const owner = await signIn(harness);

  // 2.1 calls `memberId` a UUID and 3.2 refuses control characters in any string; the codec of
  // `sync-protocol` refuses the bidirectional overrides with them. This value passed the server's
  // own schema, reached the database, and came back out of `GET /members` to reverse the text it
  // was displayed beside — checked in one layer, used in another.
  const reversing = "\u202eabcdefgh";
  const refused = await call(harness, "POST", "/v1/families", {
    token: owner.accessToken,
    payload: { familyId: uuid(), memberId: reversing, rotationId: uuid() },
  });
  expect(refused.statusCode).toBe(400);
  expect(refused.json().error.code).toBe("invalid_request");
  // Nothing was created on the way to the refusal: the account is still in no family.
  const me = await call(harness, "GET", "/v1/families/me", { token: owner.accessToken });
  expect(me.statusCode).toBe(403);
  expect(me.json().error.code).toBe("no_family");

  // Length was the whole of the old rule, so a hundred and twenty-eight plain characters passed.
  const bounded = "m".repeat(128);
  const long = await call(harness, "POST", "/v1/families", {
    token: owner.accessToken,
    payload: { familyId: uuid(), memberId: bounded, rotationId: uuid() },
  });
  expect(long.statusCode).toBe(400);
  expect(long.json().error.code).toBe("invalid_request");

  // The same identifier, on the other two routes that take one. The joining device chooses its
  // own, and the owner names one to remove it.
  const joining = await call(harness, "POST", "/v1/invites/join", {
    token: owner.accessToken,
    payload: {
      inviteId: uuid(),
      authToken: Buffer.alloc(32, 1).toString("base64"),
      memberId: reversing,
      bindProof: Buffer.alloc(32, 2).toString("base64"),
    },
  });
  expect(joining.statusCode).toBe(400);
  expect(joining.json().error.code).toBe("invalid_request");

  const family = await createFamily(harness, owner);
  const removing = await call(
    harness,
    "DELETE",
    `/v1/families/${family.familyId}/members/${encodeURIComponent(reversing)}`,
    { token: owner.accessToken },
  );
  expect(removing.statusCode).toBe(400);
  expect(removing.json().error.code).toBe("invalid_request");

  // And the shape the document names is still accepted, so this is a narrowing and not a wall.
  const listed = await call(harness, "GET", `/v1/families/${family.familyId}/members`, {
    token: owner.accessToken,
  });
  expect(listed.json().members).toEqual([
    { memberId: family.memberId, role: "owner", joinedAt: harness.now, removedAt: null },
  ]);
});

test("one rate limit never sweeps another's counter away", async () => {
  harness = createHarness();
  const owner = await signIn(harness);
  const family = await createFamily(harness, owner);
  const guess = Buffer.alloc(32, 2).toString("base64");

  // Four of the five failed invite lookups 5.3 allows in a quarter of an hour.
  for (let attempt = 1; attempt < INVITE_CLAIM_FAILURES_PER_WINDOW; attempt += 1) {
    expect(
      (await call(harness, "POST", "/v1/invites/claim", {
        token: owner.accessToken,
        payload: { authToken: guess },
      })).statusCode,
    ).toBe(404);
  }

  // A minute later an ordinary envelope batch arrives. Its own window is a minute wide, and a
  // sweep written to that width would delete every throttle row older than a minute — including
  // the four above, which is the counter that stands between a copied invite box and a 60-bit
  // code. The counters are swept per family of buckets, so the fifth lookup is still the last.
  harness.advance(ENVELOPE_BATCH_WINDOW_MS + 1);
  await refreshSession(harness, owner);
  expect(
    (await call(harness, "POST", `/v1/families/${family.familyId}/envelopes`, {
      token: owner.accessToken,
      payload: { envelopes: [envelope(family.familyId, owner.deviceId, 1)] },
    })).statusCode,
  ).toBe(200);

  const fifth = await call(harness, "POST", "/v1/invites/claim", {
    token: owner.accessToken,
    payload: { authToken: guess },
  });
  expect(fifth.statusCode).toBe(404);
  const sixth = await call(harness, "POST", "/v1/invites/claim", {
    token: owner.accessToken,
    payload: { authToken: guess },
  });
  expect(sixth.statusCode).toBe(429);
  expect(sixth.json().error.code).toBe("rate_limited");
});
