/**
 * Две проверки приглашения и две привязки — 5.3, 5.4, 6.3 и 6.4, исполнением, а не поиском строк.
 *
 * Все три находки этого файла имели одну форму: половина протокола на сервере есть, вызова на
 * устройстве нет. Поэтому и тесты здесь гоняют настоящую криптографию против подставного сервера,
 * который отвечает ровно тем, чем отвечает настоящий, — и проверяют, что легло на диск, а не какая
 * строка есть в исходнике.
 */
import { toBase64 } from "@family-budget/sync-client";
import {
  computeBindProof,
  deriveInviteSecrets,
  deviceKeyFingerprint,
  exportDevicePublicKey,
  familyKeyFingerprint,
  generateDeviceKeyPair,
  generateFamilyKey,
  generateInviteCode,
  sealInvite,
  toHex,
} from "@family-budget/sync-crypto";
import { describe, expect, it } from "vitest";

import type { ClaimedInvite, MemberRecord } from "./api";
import {
  checkInviteBinding,
  joinFamilyByCode,
  parseStoredInvite,
  type SyncStateStore,
} from "./controller";

const FAMILY_ID = "0f000000-0000-4000-8000-00000000fa11";
const INVITE_ID = "11111111-1111-4111-8111-111111111111";
const OWNER_DEVICE = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1";
const OWNER_MEMBER = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb1";
const JOINING_DEVICE = "cccccccc-cccc-4ccc-8ccc-ccccccccccc1";
const JOINING_MEMBER = "dddddddd-dddd-4ddd-8ddd-ddddddddddd1";
const KEY_EPOCH = 1;

/** Ровно тот кусок хранилища, который трогает вступление. Ничего не имитирует сверх этого. */
function memoryStore(initial: Record<string, unknown> = {}): SyncStateStore & {
  readonly written: Map<string, unknown>;
} {
  const written = new Map<string, unknown>(Object.entries(initial));
  return {
    written,
    async readSyncState<V = unknown>(key: string): Promise<V | undefined> {
      return written.has(key) ? (written.get(key) as V) : undefined;
    },
    async writeSyncState(entries) {
      for (const entry of entries) written.set(entry.key, entry.value);
    },
    async clearSyncData() {
      written.clear();
    },
    async countOutbox() {
      return 0;
    },
    async loadVersioned() {
      return null;
    },
    async listOutbox() {
      return [];
    },
    async confirmOutbox() {
      return 0;
    },
  };
}

interface Scenario {
  readonly code: string;
  readonly claimed: ClaimedInvite;
  readonly ownerFingerprint: Uint8Array;
  readonly familyKeyDigest: string;
  readonly store: ReturnType<typeof memoryStore>;
}

/** Владелец выпускает приглашение по-настоящему: тот же `sealInvite`, что и на экране. */
async function issueInvite(): Promise<Scenario> {
  const code = generateInviteCode();
  const ownerKeys = await generateDeviceKeyPair();
  const ownerSpki = await exportDevicePublicKey(ownerKeys.publicKey);
  const familyKey = await generateFamilyKey();
  const sealed = await sealInvite({
    code,
    familyId: FAMILY_ID,
    keyEpoch: KEY_EPOCH,
    inviteId: INVITE_ID,
    familyKey,
    senderDeviceId: OWNER_DEVICE,
    senderSpki: ownerSpki,
    senderRole: "owner",
    senderMemberId: OWNER_MEMBER,
  });
  const joiningKeys = await generateDeviceKeyPair();
  const joiningSpki = await exportDevicePublicKey(joiningKeys.publicKey);
  return {
    code,
    claimed: {
      inviteId: INVITE_ID,
      familyId: FAMILY_ID,
      keyEpoch: KEY_EPOCH,
      iv: toBase64(sealed.record.iv),
      inviteBox: toBase64(sealed.record.ciphertext),
    },
    ownerFingerprint: await deviceKeyFingerprint(ownerSpki),
    familyKeyDigest: toHex(await familyKeyFingerprint(familyKey)),
    store: memoryStore({
      "device-key": { keyPair: joiningKeys, spki: toBase64(joiningSpki) },
    }),
  };
}

function api(roster: readonly MemberRecord[], claimed: ClaimedInvite) {
  const calls: string[] = [];
  return {
    calls,
    async claimInvite() {
      calls.push("claimInvite");
      return claimed;
    },
    async joinInvite() {
      calls.push("joinInvite");
    },
    async members(familyId: string) {
      calls.push(`members(${familyId})`);
      return roster;
    },
    async leaveFamily(familyId: string) {
      calls.push(`leaveFamily(${familyId})`);
    },
  };
}

const OWNER_ROW: MemberRecord = {
  memberId: OWNER_MEMBER,
  role: "owner",
  joinedAt: 1_700_000_000_000,
  removedAt: null,
};

describe("вступление по коду сверяет отправителя со списком участников", () => {
  it("владелец в списке — ключ и пин ложатся на диск", async () => {
    const scenario = await issueInvite();
    const server = api([OWNER_ROW], scenario.claimed);

    const joined = await joinFamilyByCode(scenario.code, {
      api: server,
      store: scenario.store,
      deviceId: JOINING_DEVICE,
      memberId: JOINING_MEMBER,
      pins: new Map(),
    });

    // Список действительно запрошен, и запрошен по той семье, которую назвало приглашение.
    expect(server.calls).toContain(`members(${FAMILY_ID})`);
    expect(server.calls).not.toContain(`leaveFamily(${FAMILY_ID})`);
    expect(joined.keyEpoch).toBe(KEY_EPOCH);
    const stored = scenario.store.written.get("family-key") as { key: CryptoKey; keyEpoch: number };
    expect(stored.keyEpoch).toBe(KEY_EPOCH);
    // Развёрнут ровно тот ключ, который владелец положил в посылку.
    expect(toHex(await familyKeyFingerprint(stored.key))).toBe(scenario.familyKeyDigest);
    // Пин владельца — из посылки под `KEK`, а не из ответа сервера.
    expect(joined.pins.get(OWNER_DEVICE)).toEqual(scenario.ownerFingerprint);
    expect(scenario.store.written.get("device-pins")).toEqual({
      [OWNER_DEVICE]: toHex(scenario.ownerFingerprint),
    });
    expect(scenario.store.written.get("journal-origin")).toBe("family");
  });

  it("отправитель числится участником — отказ, откат и ни байта ключа на диске", async () => {
    const scenario = await issueInvite();
    // Посылка утверждает `owner` — её собрал тот, кто её собрал. Сервер держит другую правду.
    const server = api([{ ...OWNER_ROW, role: "member" }], scenario.claimed);

    await expect(
      joinFamilyByCode(scenario.code, {
        api: server,
        store: scenario.store,
        deviceId: JOINING_DEVICE,
        memberId: JOINING_MEMBER,
        pins: new Map(),
      }),
    ).rejects.toThrow("Код выпущен не владельцем семьи");

    expect(server.calls).toEqual([
      "claimInvite",
      "joinInvite",
      `members(${FAMILY_ID})`,
      `leaveFamily(${FAMILY_ID})`,
    ]);
    expect(scenario.store.written.has("family-key")).toBe(false);
    expect(scenario.store.written.has("device-pins")).toBe(false);
    expect(scenario.store.written.has("journal-origin")).toBe(false);
  });

  it("отправителя в списке нет — тот же отказ", async () => {
    const scenario = await issueInvite();
    const server = api([{ ...OWNER_ROW, memberId: JOINING_MEMBER }], scenario.claimed);
    await expect(
      joinFamilyByCode(scenario.code, {
        api: server,
        store: scenario.store,
        deviceId: JOINING_DEVICE,
        memberId: JOINING_MEMBER,
        pins: new Map(),
      }),
    ).rejects.toThrow("Ключ семьи не развёрнут");
    expect(scenario.store.written.has("family-key")).toBe(false);
  });

  it("владелец, уже удалённый из семьи, тоже не подтверждает роль", async () => {
    const scenario = await issueInvite();
    const server = api([{ ...OWNER_ROW, removedAt: 1_700_000_100_000 }], scenario.claimed);
    await expect(
      joinFamilyByCode(scenario.code, {
        api: server,
        store: scenario.store,
        deviceId: JOINING_DEVICE,
        memberId: JOINING_MEMBER,
        pins: new Map(),
      }),
    ).rejects.toThrow("Ключ семьи не развёрнут");
    expect(scenario.store.written.has("family-key")).toBe(false);
  });
});

describe("устройство владельца проверяет bindProof вступившего", () => {
  it("доказательство, посчитанное вступлением, сходится у владельца", async () => {
    // Один и тот же код с двух сторон: вступающий считает `bindProof`, владелец — проверяет.
    const code = generateInviteCode();
    const secrets = await deriveInviteSecrets(code);
    const joining = await generateDeviceKeyPair();
    const spki = await exportDevicePublicKey(joining.publicKey);
    const proof = await computeBindProof(secrets.bindKey, {
      familyId: FAMILY_ID,
      inviteId: INVITE_ID,
      deviceId: JOINING_DEVICE,
      spki,
    });
    const invite = parseStoredInvite({
      inviteId: INVITE_ID,
      familyId: FAMILY_ID,
      keyEpoch: KEY_EPOCH,
      expiresAt: 4_102_444_800_000,
      supersededCount: 0,
      bindKey: toHex(secrets.bindKey),
    });
    expect(invite).not.toBeNull();

    const outcome = await checkInviteBinding(invite!, [
      {
        deviceId: JOINING_DEVICE,
        memberId: JOINING_MEMBER,
        publicKey: toBase64(spki),
        bindProof: toBase64(proof),
        inviteId: INVITE_ID,
        createdAt: 1,
        lastSeenAt: 1,
        revokedAt: null,
      },
    ]);
    expect(outcome).toEqual({
      deviceId: JOINING_DEVICE,
      verdict: "bound",
      fingerprint: await deviceKeyFingerprint(spki),
    });
  });
});
