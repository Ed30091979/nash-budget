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
  INVITE_CLAIM_FAILURES_PER_WINDOW,
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

  // A checkpoint (3.6) is not an operation and gets the larger bound named in `limits.ts`.
  const checkpoint = envelope(family.familyId, owner.deviceId, 1, {
    kind: "checkpoint",
    ciphertext: Buffer.alloc(MAX_OPERATION_CIPHERTEXT_BYTES + 1, 2).toString("base64"),
  });
  expect(
    (await call(harness, "POST", url, {
      token: owner.accessToken,
      payload: { envelopes: [checkpoint] },
    })).statusCode,
  ).toBe(200);
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
