import { afterEach, expect, test } from "vitest";

import { call, createFamily, createHarness, signIn, type Harness } from "./support.ts";

let harness: Harness | undefined;

afterEach(async () => {
  await harness?.close();
  harness = undefined;
});

test("a family can be created and read back", async () => {
  harness = createHarness();
  const owner = await signIn(harness);
  const family = await createFamily(harness, owner);
  const me = await call(harness, "GET", "/v1/families/me", { token: owner.accessToken });
  expect(me.statusCode).toBe(200);
  expect(me.json()).toMatchObject({
    familyId: family.familyId,
    keyEpoch: 1,
    memberId: family.memberId,
    role: "owner",
    rotation: null,
  });
});
