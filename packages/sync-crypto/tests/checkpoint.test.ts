import { describe, expect, it } from "vitest";

import {
  checkpointDigest,
  checkpointSeedDigest,
  SyncCryptoError,
  toHex,
} from "../src/index.js";
import { DEVICE_A, DEVICE_B, FAMILY_ID, OP_ID, OP_ID_2, OP_ID_3 } from "./support.js";

describe("the checkpoint digest of 3.6", () => {
  it("is a set: order and repetition do not reach the hash", async () => {
    const forward = await checkpointDigest({
      familyId: FAMILY_ID,
      keyEpoch: 1,
      opIds: [OP_ID, OP_ID_2, OP_ID_3],
    });
    const shuffled = await checkpointDigest({
      familyId: FAMILY_ID,
      keyEpoch: 1,
      opIds: [OP_ID_3, OP_ID, OP_ID_2, OP_ID],
    });
    expect(toHex(shuffled)).toBe(toHex(forward));
  });

  it("separates a set from every longer set that begins with it", async () => {
    const two = await checkpointDigest({ familyId: FAMILY_ID, keyEpoch: 1, opIds: [OP_ID, OP_ID_2] });
    const three = await checkpointDigest({
      familyId: FAMILY_ID,
      keyEpoch: 1,
      opIds: [OP_ID, OP_ID_2, OP_ID_3],
    });
    expect(toHex(three)).not.toBe(toHex(two));
  });

  it("is bound to the family and to the epoch", async () => {
    const here = await checkpointDigest({ familyId: FAMILY_ID, keyEpoch: 1, opIds: [OP_ID] });
    const nextEpoch = await checkpointDigest({ familyId: FAMILY_ID, keyEpoch: 2, opIds: [OP_ID] });
    const elsewhere = await checkpointDigest({ familyId: DEVICE_A, keyEpoch: 1, opIds: [OP_ID] });
    expect(toHex(nextEpoch)).not.toBe(toHex(here));
    expect(toHex(elsewhere)).not.toBe(toHex(here));
  });

  it("is defined on the empty set — a device that has applied nothing", async () => {
    const digest = await checkpointDigest({ familyId: FAMILY_ID, keyEpoch: 1, opIds: [] });
    expect(digest).toHaveLength(32);
  });

  it("refuses an identifier outside the alphabet the ordering is defined on", async () => {
    await expect(
      checkpointDigest({ familyId: FAMILY_ID, keyEpoch: 1, opIds: [OP_ID, "не-uuid"] }),
    ).rejects.toBeInstanceOf(SyncCryptoError);
  });

  it("survives a set far larger than an argument list would carry", async () => {
    const many = Array.from({ length: 200_000 }, (_unused, index) =>
      `${index.toString(16).padStart(8, "0")}-0000-4000-8000-000000000000`,
    );
    const digest = await checkpointDigest({ familyId: FAMILY_ID, keyEpoch: 1, opIds: many });
    expect(digest).toHaveLength(32);
  });
});

describe("the seed of a device's checkpoint chain", () => {
  it("cannot be moved between devices, epochs or families", async () => {
    const mine = toHex(
      await checkpointSeedDigest({ familyId: FAMILY_ID, keyEpoch: 4, deviceId: DEVICE_A }),
    );
    expect(
      toHex(await checkpointSeedDigest({ familyId: FAMILY_ID, keyEpoch: 4, deviceId: DEVICE_B })),
    ).not.toBe(mine);
    expect(
      toHex(await checkpointSeedDigest({ familyId: FAMILY_ID, keyEpoch: 5, deviceId: DEVICE_A })),
    ).not.toBe(mine);
    expect(
      toHex(await checkpointSeedDigest({ familyId: DEVICE_B, keyEpoch: 4, deviceId: DEVICE_A })),
    ).not.toBe(mine);
  });

  it("is not the digest of the empty set: the two labels keep the contexts apart", async () => {
    const seed = await checkpointSeedDigest({ familyId: FAMILY_ID, keyEpoch: 1, deviceId: DEVICE_A });
    const empty = await checkpointDigest({ familyId: FAMILY_ID, keyEpoch: 1, opIds: [] });
    expect(toHex(seed)).not.toBe(toHex(empty));
  });
});
