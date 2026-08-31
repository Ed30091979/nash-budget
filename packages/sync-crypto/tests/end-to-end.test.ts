/**
 * The acceptance scenario of phase S2, end to end: an envelope written on "device A" is read on
 * "device B" after B has unwrapped an invite — and then the same two devices go through a rotation
 * and a catch-up chain, which is where the scheme either holds together or does not.
 */
import { describe, expect, it } from "vitest";

import {
  computeBindProof,
  computeEpochConfirm,
  deriveInviteSecrets,
  deviceKeyFingerprint,
  ENVELOPE_VERSION,
  exportFamilyKey,
  familyKeyFingerprint,
  generateFamilyKey,
  generateInviteCode,
  inviteAuthTokenDigest,
  openEnvelope,
  openInvite,
  reencryptJournal,
  sealEnvelope,
  sealInvite,
  toHex,
  unwrapFamilyKey,
  verifyBindProof,
  verifyEpochConfirm,
  wrapFamilyKey,
  type EnvelopeHeader,
  type KeyWrap,
  type SealedEnvelope,
} from "../src/index.js";
import {
  DEVICE_A,
  DEVICE_B,
  DEVICE_C,
  FAMILY_ID,
  INVITE_ID,
  MEMBER_A,
  OP_ID,
  OP_ID_2,
  ROTATION_ID,
  ROTATION_ID_2,
  makeDevice,
  samplePlaintext,
  type Device,
} from "./support.js";

function header(keyEpoch: number, overrides: Partial<EnvelopeHeader> = {}): EnvelopeHeader {
  return {
    envelopeVersion: ENVELOPE_VERSION,
    kind: "operation",
    familyId: FAMILY_ID,
    opId: OP_ID,
    deviceId: DEVICE_A,
    keyEpoch,
    ...overrides,
  };
}

interface Family {
  readonly owner: Device;
  readonly member: Device;
  readonly familyKey: CryptoKey;
  readonly memberFamilyKey: CryptoKey;
  readonly pinnedOwnerFingerprint: Uint8Array;
}

/** Everything up to and including "B is in the family and holds `FK`". */
async function joinedFamily(): Promise<Family> {
  const owner = await makeDevice(DEVICE_A);
  const member = await makeDevice(DEVICE_B);
  const familyKey = await generateFamilyKey();
  const code = generateInviteCode();

  const invite = await sealInvite({
    code,
    familyId: FAMILY_ID,
    keyEpoch: 1,
    inviteId: INVITE_ID,
    familyKey,
    senderDeviceId: owner.deviceId,
    senderSpki: owner.spki,
    senderRole: "owner",
    senderMemberId: MEMBER_A,
  });

  // Step one of 5.3: the joining device derives the three thirds from the code alone, before its
  // first request, and presents the token. The server compares its stored hash and hands back the
  // box; it never learns the code and cannot open what it stores.
  const presented = await deriveInviteSecrets(code);
  expect(toHex(await inviteAuthTokenDigest(presented.authToken))).toBe(
    toHex(invite.record.authTokenDigest),
  );

  const opened = await openInvite({
    code,
    familyId: invite.record.familyId,
    keyEpoch: invite.record.keyEpoch,
    inviteId: invite.record.inviteId,
    iv: invite.record.iv,
    ciphertext: invite.record.ciphertext,
  });
  expect(opened.senderRole).toBe("owner");

  // Step two: the joining device proves its own public key against the invite, and the owner —
  // who kept `bindKey` for the life of the invite — checks it. This is the automatic binding, in
  // the direction "device → owner"; the other direction came inside the box.
  const bindParams = {
    familyId: FAMILY_ID,
    inviteId: INVITE_ID,
    deviceId: member.deviceId,
    spki: member.spki,
  };
  const bindProof = await computeBindProof(opened.bindKey, bindParams);
  expect(await verifyBindProof(invite.issuerSecrets.bindKey, bindParams, bindProof)).toBe(true);

  return {
    owner,
    member,
    familyKey,
    memberFamilyKey: opened.familyKey,
    pinnedOwnerFingerprint: opened.senderKeyFingerprint,
  };
}

describe("device A writes, device B reads, after the invite", () => {
  it("delivers the same family key and the owner's pin through the code", async () => {
    const family = await joinedFamily();
    expect(toHex(await exportFamilyKey(family.memberFamilyKey))).toBe(
      toHex(await exportFamilyKey(family.familyKey)),
    );
    expect(toHex(family.pinnedOwnerFingerprint)).toBe(toHex(await deviceKeyFingerprint(family.owner.spki)));
  });

  it("opens on B an envelope sealed on A, and the other way round", async () => {
    const family = await joinedFamily();
    const fromA = await sealEnvelope(family.familyKey, header(1), samplePlaintext(500_00));
    expect([...(await openEnvelope(family.memberFamilyKey, fromA))]).toEqual([
      ...samplePlaintext(500_00),
    ]);

    const fromB = await sealEnvelope(
      family.memberFamilyKey,
      header(1, { opId: OP_ID_2, deviceId: DEVICE_B }),
      samplePlaintext(700_00),
    );
    expect([...(await openEnvelope(family.familyKey, fromB))]).toEqual([...samplePlaintext(700_00)]);
  });

  it("does not open for a stranger's key, a stranger's family or a stranger's epoch", async () => {
    const family = await joinedFamily();
    const envelope = await sealEnvelope(family.familyKey, header(1), samplePlaintext());
    const strangerKey = await generateFamilyKey();

    await expect(openEnvelope(strangerKey, envelope)).rejects.toMatchObject({
      code: "envelope_open_failed",
    });
    await expect(
      openEnvelope(family.memberFamilyKey, { ...envelope, familyId: INVITE_ID }),
    ).rejects.toMatchObject({ code: "envelope_open_failed" });
    await expect(
      openEnvelope(family.memberFamilyKey, { ...envelope, keyEpoch: 2 }),
    ).rejects.toMatchObject({ code: "envelope_open_failed" });
  });
});

describe("rotation, from the owner's device to the family", () => {
  it("moves the journal to the new epoch and lets B in through the wrap and the confirmation", async () => {
    const family = await joinedFamily();

    // Step 2 of 5.5: the owner takes the journal of the epoch — his own outbound queue with it —
    // and decrypts it with the old key while the old key is still the only one there is.
    const journal: SealedEnvelope[] = [
      await sealEnvelope(family.familyKey, header(1), samplePlaintext(1)),
      await sealEnvelope(family.familyKey, header(1, { opId: OP_ID_2, deviceId: DEVICE_B }), samplePlaintext(2)),
    ];

    // Steps 3 to 5: a new key, a confirmation on the *old* key, the journal re-encrypted, and a
    // wrap for every remaining bound device.
    const nextFamilyKey = await generateFamilyKey();
    const confirmParams = {
      previousFamilyKey: family.familyKey,
      familyId: FAMILY_ID,
      keyEpoch: 2,
      rotationId: ROTATION_ID,
      nextFamilyKey,
    };
    const rotateConfirm = await computeEpochConfirm(confirmParams);
    const moved = await reencryptJournal({
      envelopes: journal,
      previousFamilyKey: family.familyKey,
      previousKeyEpoch: 1,
      nextFamilyKey,
      nextKeyEpoch: 2,
    });
    const wrap = await wrapFamilyKey({
      familyKey: nextFamilyKey,
      senderPrivateKey: family.owner.keyPair.privateKey,
      senderSpki: family.owner.spki,
      senderDeviceId: family.owner.deviceId,
      recipientSpki: family.member.spki,
      recipientDeviceId: family.member.deviceId,
      pinnedRecipientFingerprint: await deviceKeyFingerprint(family.member.spki),
      familyId: FAMILY_ID,
      keyEpoch: 2,
      rotationId: ROTATION_ID,
    });

    // Step 8, on B: check the owner's fingerprint against the pin, unwrap, verify the confirmation
    // on the key of its own previous epoch, and only then recognise the new epoch.
    const received = await unwrapFamilyKey({
      wrap,
      recipientPrivateKey: family.member.keyPair.privateKey,
      recipientSpki: family.member.spki,
      senderSpki: family.owner.spki,
      pinnedSenderFingerprint: family.pinnedOwnerFingerprint,
    });
    expect(
      await verifyEpochConfirm(
        { ...confirmParams, previousFamilyKey: family.memberFamilyKey, nextFamilyKey: received },
        rotateConfirm,
      ),
    ).toBe(true);

    for (const [index, envelope] of moved.entries()) {
      expect([...(await openEnvelope(received, envelope))]).toEqual([
        ...(await openEnvelope(family.familyKey, journal[index]!)),
      ]);
    }
  });

  it("shuts out a device that kept the old key: the point of rotating at all", async () => {
    const family = await joinedFamily();
    const revokedKey = family.memberFamilyKey; // the stolen phone's copy of FK, epoch 1
    const nextFamilyKey = await generateFamilyKey();
    const future = await sealEnvelope(nextFamilyKey, header(2), samplePlaintext(4242));
    await expect(openEnvelope(revokedKey, future)).rejects.toMatchObject({
      code: "envelope_open_failed",
    });
  });

  it("refuses a rotation announced by a server that invented the key", async () => {
    const family = await joinedFamily();
    const server = await makeDevice(DEVICE_C);
    const inventedKey = await generateFamilyKey();
    const forged = await wrapFamilyKey({
      familyKey: inventedKey,
      senderPrivateKey: server.keyPair.privateKey,
      senderSpki: server.spki,
      senderDeviceId: family.owner.deviceId,
      recipientSpki: family.member.spki,
      recipientDeviceId: family.member.deviceId,
      pinnedRecipientFingerprint: await deviceKeyFingerprint(family.member.spki),
      familyId: FAMILY_ID,
      keyEpoch: 2,
      rotationId: ROTATION_ID,
    });

    // First line: the pin. The server's SPKI does not hash to the pinned fingerprint.
    await expect(
      unwrapFamilyKey({
        wrap: forged,
        recipientPrivateKey: family.member.keyPair.privateKey,
        recipientSpki: family.member.spki,
        senderSpki: server.spki,
        pinnedSenderFingerprint: family.pinnedOwnerFingerprint,
      }),
    ).rejects.toMatchObject({ code: "sender_key_mismatch" });

    // Second line, independent of the first: even granted the wrap, the server cannot confirm the
    // epoch, because the confirmation is computed on the key of the previous epoch and it has none.
    const forgedConfirm = await computeEpochConfirm({
      previousFamilyKey: inventedKey,
      familyId: FAMILY_ID,
      keyEpoch: 2,
      rotationId: ROTATION_ID,
      nextFamilyKey: inventedKey,
    });
    expect(
      await verifyEpochConfirm(
        {
          previousFamilyKey: family.memberFamilyKey,
          familyId: FAMILY_ID,
          keyEpoch: 2,
          rotationId: ROTATION_ID,
          nextFamilyKey: inventedKey,
        },
        forgedConfirm,
      ),
    ).toBe(false);
  });
});

describe("the catch-up chain of 5.4", () => {
  interface Link {
    readonly keyEpoch: number;
    readonly wrap: KeyWrap;
    readonly confirm: Uint8Array;
    readonly key: CryptoKey;
  }

  async function makeLink(
    family: Family,
    previousKey: CryptoKey,
    keyEpoch: number,
    rotationId: string,
  ): Promise<Link> {
    const key = await generateFamilyKey();
    return {
      keyEpoch,
      key,
      confirm: await computeEpochConfirm({
        previousFamilyKey: previousKey,
        familyId: FAMILY_ID,
        keyEpoch,
        rotationId,
        nextFamilyKey: key,
      }),
      wrap: await wrapFamilyKey({
        familyKey: key,
        senderPrivateKey: family.owner.keyPair.privateKey,
        senderSpki: family.owner.spki,
        senderDeviceId: family.owner.deviceId,
        recipientSpki: family.member.spki,
        recipientDeviceId: family.member.deviceId,
        pinnedRecipientFingerprint: await deviceKeyFingerprint(family.member.spki),
        familyId: FAMILY_ID,
        keyEpoch,
        rotationId,
      }),
    };
  }

  /** Walk the links the server actually handed over, in order, refusing to skip one. */
  async function walk(family: Family, held: CryptoKey, links: readonly Link[]): Promise<CryptoKey> {
    let accepted = held;
    for (const link of links) {
      const unwrapped = await unwrapFamilyKey({
        wrap: link.wrap,
        recipientPrivateKey: family.member.keyPair.privateKey,
        recipientSpki: family.member.spki,
        senderSpki: family.owner.spki,
        pinnedSenderFingerprint: family.pinnedOwnerFingerprint,
      });
      const confirmed = await verifyEpochConfirm(
        {
          previousFamilyKey: accepted,
          familyId: FAMILY_ID,
          keyEpoch: link.keyEpoch,
          rotationId: link.wrap.rotationId,
          nextFamilyKey: unwrapped,
        },
        link.confirm,
      );
      if (!confirmed) throw new Error("epoch not confirmed");
      accepted = unwrapped;
    }
    return accepted;
  }

  it("carries a device that slept through two rotations, gap in the numbering included", async () => {
    // 5.4: a gap in epoch numbers is not a break. An aborted attempt takes its number away with it
    // for good, and a reader that walks every number from its own to the current one would call
    // each honest gap a break and lock out any device that slept through an aborted rotation.
    const family = await joinedFamily();
    const second = await makeLink(family, family.familyKey, 2, ROTATION_ID);
    const seventh = await makeLink(family, second.key, 7, ROTATION_ID_2);

    const reached = await walk(family, family.memberFamilyKey, [second, seventh]);
    expect(toHex(await familyKeyFingerprint(reached))).toBe(
      toHex(await familyKeyFingerprint(seventh.key)),
    );
  });

  it("stops at the last confirmed epoch when a link is missing", async () => {
    // A break is a missing *link*, not a missing number: the wrap is there and the confirmation is
    // not, or the confirmation does not verify on the key actually held. Either way the walk stops
    // on the last confirmed epoch rather than quietly accepting the last one offered.
    const family = await joinedFamily();
    const second = await makeLink(family, family.familyKey, 2, ROTATION_ID);
    const seventh = await makeLink(family, second.key, 7, ROTATION_ID_2);

    await expect(walk(family, family.memberFamilyKey, [seventh])).rejects.toThrow("epoch not confirmed");
    expect(
      toHex(await familyKeyFingerprint(await walk(family, family.memberFamilyKey, [second]))),
    ).toBe(toHex(await familyKeyFingerprint(second.key)));
  });
});
