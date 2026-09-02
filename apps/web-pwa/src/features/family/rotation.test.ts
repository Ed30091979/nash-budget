/**
 * Смена ключа семьи — 5.5, целиком, против подставного сервера и на настоящей криптографии.
 *
 * Проверяется не то, что функция вызвана, а то, что после неё стало правдой: журнал читается новым
 * ключом и не читается старым, второе устройство принимает новую эпоху **цепочкой подтверждений**
 * через готовый `resolveEpochChain`, отозванное устройство обёртки не получает, а занижённая
 * граница переноса и разрыв в нумерации останавливают процедуру до того, как старая эпоха
 * перестанет существовать.
 */
import { resolveEpochChain, toBase64, type KeyWrapRecord } from "@family-budget/sync-client";
import type {
  DeliveredEnvelope,
  FetchQuery,
  FetchResult,
  OutgoingEnvelope,
  SubmitResult,
} from "@family-budget/sync-client";
import {
  deviceKeyFingerprint,
  exportDevicePublicKey,
  familyKeyFingerprint,
  generateDeviceKeyPair,
  generateFamilyKey,
  openEnvelope,
  sealEnvelope,
  toHex,
  utf8,
} from "@family-budget/sync-crypto";
import { beforeEach, describe, expect, it } from "vitest";

import type { DeviceRecord, MembershipSnapshot } from "./api";
import {
  rotateFamilyKey,
  RotationHalted,
  type RotateFamilyKeyParams,
  type RotationApi,
  type RotationTransport,
} from "./rotation";

const FAMILY_ID = "0f000000-0000-4000-8000-00000000fa11";
const OWNER_DEVICE = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1";
const PEER_DEVICE = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb1";
const LOST_DEVICE = "cccccccc-cccc-4ccc-8ccc-ccccccccccc1";
const UNPINNED_DEVICE = "dddddddd-dddd-4ddd-8ddd-ddddddddddd1";
const ROTATION_ID = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeee1";
const OWNER_MEMBER = "ffffffff-ffff-4fff-8fff-fffffffffff1";
const FIRST_EPOCH = 1;
const NEXT_EPOCH = 2;

/** Пять записей журнала первой эпохи: четыре операции и один чекпойнт на месте `seq = 3`. */
const JOURNAL_TEXT: Record<number, string> = {
  1: "операция 4000 рублей транспорт",
  2: "операция 1500 рублей продукты",
  3: "чекпойнт первой эпохи",
  4: "операция 250 рублей аптека",
  5: "операция 9900 рублей аренда",
};

interface Harness {
  readonly familyKey: CryptoKey;
  readonly ownerKeys: CryptoKeyPair;
  readonly ownerSpki: Uint8Array;
  readonly peerKeys: CryptoKeyPair;
  readonly peerSpki: Uint8Array;
  readonly pins: Map<string, Uint8Array>;
  readonly devices: DeviceRecord[];
  journal: Map<number, DeliveredEnvelope>;
  /** Что сервер согласен считать границей переноса. Занижается в отдельном тесте. */
  freezeSeq: number;
  /** Что сервер отвечает про членство после `complete`. */
  membershipAfter: MembershipSnapshot;
  readonly calls: string[];
  readonly submitted: OutgoingEnvelope[];
  readonly wraps: KeyWrapRecord[];
  epochConfirm: string | null;
  readonly api: RotationApi;
  readonly transport: RotationTransport;
}

function deviceRow(deviceId: string, publicKey: Uint8Array, revoked: boolean): DeviceRecord {
  return {
    deviceId,
    memberId: OWNER_MEMBER,
    publicKey: toBase64(publicKey),
    bindProof: null,
    inviteId: null,
    createdAt: 1,
    lastSeenAt: 2,
    revokedAt: revoked ? 3 : null,
  };
}

async function harness(): Promise<Harness> {
  const familyKey = await generateFamilyKey();
  const ownerKeys = await generateDeviceKeyPair();
  const ownerSpki = await exportDevicePublicKey(ownerKeys.publicKey);
  const peerKeys = await generateDeviceKeyPair();
  const peerSpki = await exportDevicePublicKey(peerKeys.publicKey);
  const lostSpki = await exportDevicePublicKey((await generateDeviceKeyPair()).publicKey);
  const unpinnedSpki = await exportDevicePublicKey((await generateDeviceKeyPair()).publicKey);

  const journal = new Map<number, DeliveredEnvelope>();
  for (const [seq, text] of Object.entries(JOURNAL_TEXT)) {
    const number = Number(seq);
    const kind = number === 3 ? "checkpoint" : "operation";
    const header = {
      envelopeVersion: 1,
      kind,
      familyId: FAMILY_ID,
      opId: `00000000-0000-4000-8000-00000000000${number}`,
      deviceId: number % 2 === 0 ? PEER_DEVICE : OWNER_DEVICE,
      keyEpoch: FIRST_EPOCH,
    };
    const sealed = await sealEnvelope(familyKey, header, utf8(text));
    journal.set(number, {
      ...header,
      seq: number,
      receivedAt: 1_700_000_000_000 + number,
      iv: toBase64(sealed.iv),
      ciphertext: toBase64(sealed.ciphertext),
    });
  }

  const pins = new Map<string, Uint8Array>([
    [PEER_DEVICE, await deviceKeyFingerprint(peerSpki)],
    [LOST_DEVICE, await deviceKeyFingerprint(lostSpki)],
  ]);

  const calls: string[] = [];
  const submitted: OutgoingEnvelope[] = [];
  const wraps: KeyWrapRecord[] = [];

  const state = {
    freezeSeq: 5,
    epochConfirm: null as string | null,
    membershipAfter: {
      familyId: FAMILY_ID,
      keyEpoch: NEXT_EPOCH,
      memberId: OWNER_MEMBER,
      role: "owner",
      ownerMemberId: OWNER_MEMBER,
      rotation: null,
    } as MembershipSnapshot,
    journal,
  };

  const self: Harness = {
    familyKey,
    ownerKeys,
    ownerSpki,
    peerKeys,
    peerSpki,
    pins,
    devices: [
      deviceRow(OWNER_DEVICE, ownerSpki, false),
      deviceRow(PEER_DEVICE, peerSpki, false),
      deviceRow(LOST_DEVICE, lostSpki, true),
      deviceRow(UNPINNED_DEVICE, unpinnedSpki, false),
    ],
    get journal() {
      return state.journal;
    },
    set journal(value: Map<number, DeliveredEnvelope>) {
      state.journal = value;
    },
    get freezeSeq() {
      return state.freezeSeq;
    },
    set freezeSeq(value: number) {
      state.freezeSeq = value;
    },
    get membershipAfter() {
      return state.membershipAfter;
    },
    set membershipAfter(value: MembershipSnapshot) {
      state.membershipAfter = value;
    },
    get epochConfirm() {
      return state.epochConfirm;
    },
    set epochConfirm(value: string | null) {
      state.epochConfirm = value;
    },
    calls,
    submitted,
    wraps,
    api: {
      async declareRotation(familyId, rotationId) {
        calls.push("declareRotation");
        return {
          keyEpoch: NEXT_EPOCH,
          previousKeyEpoch: FIRST_EPOCH,
          rotationId,
          freezeSeq: state.freezeSeq,
          rotatingDeviceId: OWNER_DEVICE,
          startedAt: 1_700_000_100_000,
        };
      },
      async uploadRotationKeys(_familyId, input) {
        calls.push("uploadRotationKeys");
        if (input.epochConfirm !== undefined) state.epochConfirm = input.epochConfirm;
        for (const wrap of input.wraps ?? []) {
          wraps.push({
            keyEpoch: NEXT_EPOCH,
            deviceId: wrap.deviceId,
            senderDeviceId: wrap.senderDeviceId,
            rotationId: input.rotationId,
            salt: wrap.salt,
            iv: wrap.iv,
            ciphertext: wrap.ciphertext,
            rotateConfirm: null,
            confirmRotationId: null,
          });
        }
        return { keyEpoch: NEXT_EPOCH, wraps: (input.wraps ?? []).length };
      },
      async completeRotation() {
        calls.push("completeRotation");
        return { keyEpoch: NEXT_EPOCH, previousKeyEpoch: FIRST_EPOCH };
      },
      async membership() {
        calls.push("membership");
        return state.membershipAfter;
      },
    },
    transport: {
      async fetch(_familyId: string, query: FetchQuery): Promise<FetchResult> {
        calls.push(`fetch(after=${query.after})`);
        const page = [...state.journal.values()]
          .filter((envelope) => envelope.seq > query.after)
          .sort((left, right) => left.seq - right.seq)
          .slice(0, query.limit);
        return { keyEpoch: FIRST_EPOCH, hasMore: false, envelopes: page };
      },
      async submit(_familyId: string, envelopes): Promise<SubmitResult> {
        calls.push(`submit(${envelopes.length})`);
        submitted.push(...envelopes);
        return {
          keyEpoch: NEXT_EPOCH,
          accepted: envelopes.map((envelope, index) => ({
            opId: envelope.opId,
            seq: submitted.length - envelopes.length + index + 1,
          })),
        };
      },
    },
  };
  return self;
}

function params(
  self: Harness,
  overrides: Partial<RotateFamilyKeyParams> = {},
): RotateFamilyKeyParams {
  return {
    api: self.api,
    transport: self.transport,
    familyId: FAMILY_ID,
    deviceId: OWNER_DEVICE,
    deviceSpki: self.ownerSpki,
    devicePrivateKey: self.ownerKeys.privateKey,
    familyKey: self.familyKey,
    keyEpoch: FIRST_EPOCH,
    devices: self.devices,
    pin: (deviceId) => self.pins.get(deviceId),
    bindVerdict: () => null,
    cursorSeq: 5,
    highWaterSeq: 5,
    queued: [],
    rotationId: ROTATION_ID,
    ...overrides,
  };
}

let self: Harness;

beforeEach(async () => {
  self = await harness();
});

describe("ротация переносит журнал и выдаёт новый ключ", () => {
  it("журнал читается новым ключом, чекпойнты не едут, отозванное устройство остаётся без ключа", async () => {
    const result = await rotateFamilyKey(params(self));

    expect(result.keyEpoch).toBe(NEXT_EPOCH);
    expect(result.previousKeyEpoch).toBe(FIRST_EPOCH);
    // Пять записей в журнале, четыре операции — чекпойнт `seq = 3` не переносится: его цепочка и
    // оба его дайджеста считаны по номеру ушедшей эпохи (3.6), и в новой он был бы неповторим.
    expect(result.moved).toBe(4);
    expect(self.submitted).toHaveLength(4);
    expect(self.submitted.map((envelope) => envelope.kind)).toEqual([
      "operation",
      "operation",
      "operation",
      "operation",
    ]);

    // 5.5 шаг 4: меняются только `iv`, `keyEpoch` и шифротекст. Открытый текст — байт в байт.
    for (const moved of self.submitted) {
      expect(moved.keyEpoch).toBe(NEXT_EPOCH);
      const original = [...self.journal.values()].find((row) => row.opId === moved.opId);
      expect(original).toBeDefined();
      // Авторский `deviceId` сохранён, хотя грузит конверты владелец (3.3).
      expect(moved.deviceId).toBe(original!.deviceId);
      expect(moved.iv).not.toBe(original!.iv);
      const opened = await openEnvelope(result.familyKey, {
        envelopeVersion: moved.envelopeVersion,
        kind: moved.kind,
        familyId: moved.familyId,
        opId: moved.opId,
        deviceId: moved.deviceId,
        keyEpoch: moved.keyEpoch,
        iv: Uint8Array.from(atob(moved.iv), (char) => char.charCodeAt(0)),
        ciphertext: Uint8Array.from(atob(moved.ciphertext), (char) => char.charCodeAt(0)),
      });
      const seq = [...self.journal.entries()].find(([, row]) => row.opId === moved.opId)![0];
      expect(new TextDecoder().decode(opened)).toBe(JOURNAL_TEXT[seq]);
    }

    // Обёртка ушла привязанному и живому; отозванное и незакреплённое перечислены с причиной.
    expect(result.wrapped).toEqual([PEER_DEVICE]);
    expect(result.skipped).toEqual([
      { deviceId: LOST_DEVICE, reason: "revoked" },
      { deviceId: UNPINNED_DEVICE, reason: "not_pinned" },
    ]);
    expect(result.inheritedGaps).toEqual([]);
  });

  it("второе устройство принимает новую эпоху цепочкой подтверждений, а не словом сервера", async () => {
    const ownerPin = await deviceKeyFingerprint(self.ownerSpki);
    const result = await rotateFamilyKey(params(self));
    expect(self.epochConfirm).not.toBeNull();

    // Ровно то, что отдаёт `GET /keys`: обёртка плюс подтверждение преемственности.
    const offered: KeyWrapRecord[] = self.wraps.map((wrap) => ({
      ...wrap,
      rotateConfirm: self.epochConfirm,
      confirmRotationId: ROTATION_ID,
    }));

    const accepted = await resolveEpochChain({
      familyId: FAMILY_ID,
      deviceId: PEER_DEVICE,
      deviceSpki: self.peerSpki,
      devicePrivateKey: self.peerKeys.privateKey,
      wraps: offered,
      accepted: { keyEpoch: FIRST_EPOCH, key: self.familyKey, live: true },
      // Пин владельца у второго устройства — закреплённая запись, приехавшая под `KEK` в посылке
      // приглашения (5.3). Именно она, а не ответ сервера, решает, чей это ключ.
      pin: (senderDeviceId) =>
        senderDeviceId === OWNER_DEVICE
          ? { state: "pinned", fingerprint: ownerPin }
          : { state: "absent" },
      senderSpki: () => self.ownerSpki,
    });

    expect(accepted.refusal).toBeNull();
    expect(accepted.advanced).toBe(1);
    expect(accepted.epoch?.keyEpoch).toBe(NEXT_EPOCH);
    // Тот же ключ, что у владельца: цепочка сошлась на нём, а не на чём-то, что предложил сервер.
    expect(accepted.epoch?.keyDigest).toBe(result.keyDigest);
    expect(accepted.epoch?.keyDigest).toBe(toHex(await familyKeyFingerprint(result.familyKey)));
  });

  it("устройство с несошедшимся bindProof обёртки не получает", async () => {
    const result = await rotateFamilyKey(
      params(self, { bindVerdict: (deviceId) => (deviceId === PEER_DEVICE ? "failed" : null) }),
    );
    expect(result.wrapped).toEqual([]);
    expect(result.skipped).toContainEqual({ deviceId: PEER_DEVICE, reason: "bind_failed" });
  });

  it("собственная очередь владельца уезжает в новую эпоху вместе с журналом", async () => {
    const queuedHeader = {
      envelopeVersion: 1,
      kind: "operation",
      familyId: FAMILY_ID,
      opId: "99999999-9999-4999-8999-999999999999",
      deviceId: OWNER_DEVICE,
      keyEpoch: FIRST_EPOCH,
    };
    const sealed = await sealEnvelope(self.familyKey, queuedHeader, utf8("ещё не отправлено"));
    const queued: OutgoingEnvelope = {
      ...queuedHeader,
      iv: toBase64(sealed.iv),
      ciphertext: toBase64(sealed.ciphertext),
    };

    const result = await rotateFamilyKey(params(self, { queued: [queued] }));

    // Механизм шага 8 к очереди владельца неприменим — `409 epoch_mismatch` он не получает, — и без
    // этого переноса конверт остался бы под ключом несуществующей эпохи навсегда.
    expect(result.moved).toBe(5);
    expect(result.movedQueueOpIds).toEqual([queuedHeader.opId]);
    const moved = self.submitted.find((envelope) => envelope.opId === queuedHeader.opId);
    expect(moved?.keyEpoch).toBe(NEXT_EPOCH);
  });
});

describe("границу переноса называет сервер, а меряет устройство", () => {
  it("freezeSeq ниже собственного курсора — отказ до единого запроса журнала", async () => {
    self.freezeSeq = 3;
    await expect(rotateFamilyKey(params(self, { cursorSeq: 5, highWaterSeq: 5 }))).rejects.toThrow(
      /границу переноса 3, а это устройство видело записи до 5/u,
    );
    expect(self.calls).toEqual(["declareRotation"]);
    expect(self.submitted).toHaveLength(0);
  });

  it("freezeSeq ниже наибольшего виденного номера — тот же отказ, даже если курсор ниже", async () => {
    // Курсор стоит на `2`, потому что приём остановился на конверте `5` (3.4). Номер `5` устройство
    // видело, и граница `4` означала бы, что хвост журнала вырезан незаметно.
    self.freezeSeq = 4;
    await expect(rotateFamilyKey(params(self, { cursorSeq: 2, highWaterSeq: 5 }))).rejects.toThrow(
      /границу переноса 4, а это устройство видело записи до 5/u,
    );
    expect(self.calls).toEqual(["declareRotation"]);
  });

  it("сервер отдаёт записи за объявленной границей — отказ: усечение с конца непрерывно", async () => {
    // Граница `4` проходит собственные величины устройства, но за ней лежит `5`, и сервер его
    // отдаёт. Разрывом это не выглядит — именно поэтому спрашивается отдельно.
    self.freezeSeq = 4;
    await expect(rotateFamilyKey(params(self, { cursorSeq: 4, highWaterSeq: 4 }))).rejects.toThrow(
      /отдаёт записи и после неё \(5\)/u,
    );
    expect(self.calls).not.toContain("completeRotation");
    expect(self.submitted).toHaveLength(0);
  });
});

describe("непрерывность журнала проверяется до переноса", () => {
  it("пропущенный номер останавливает ротацию и ничего не загружает", async () => {
    // Пропадает операция `seq = 4` — «250 рублей аптека». Именно операция, а не чекпойнт: потеря
    // операции и есть то, что после переноса стало бы законной новой историей.
    self.journal.delete(4);
    const halted = await rotateFamilyKey(params(self)).catch((failure: unknown) => failure);
    expect(halted).toBeInstanceOf(RotationHalted);
    expect((halted as RotationHalted).gap).toEqual({ missing: [4], undecryptable: [] });
    expect((halted as RotationHalted).freezeSeq).toBe(5);
    // Ни одного конверта новой эпохи, ни одной обёртки, ни переключения: старая эпоха цела.
    expect(self.submitted).toHaveLength(0);
    expect(self.calls).not.toContain("uploadRotationKeys");
    expect(self.calls).not.toContain("completeRotation");
  });

  it("осознанное решение человека проносит пропуск в inheritedGaps первого чекпойнта", async () => {
    self.journal.delete(4);
    const result = await rotateFamilyKey(params(self, { acceptGaps: true }));
    expect(result.inheritedGaps).toEqual([4]);
    // Остались номера 1, 2, 3 и 5, из них 3 — чекпойнт, который не едет никогда. Значит, перенесены
    // три операции, а потерянная запись названа номером, а не растворилась в «журнал полон».
    expect(result.moved).toBe(3);
    expect(self.submitted.map((envelope) => envelope.opId)).not.toContain(
      "00000000-0000-4000-8000-000000000004",
    );
  });

  it("присутствующий, но нечитаемый конверт обходится так же, как отсутствующий", async () => {
    const damaged = self.journal.get(2)!;
    self.journal.set(2, { ...damaged, ciphertext: toBase64(new Uint8Array(48).fill(0x7a)) });

    const halted = await rotateFamilyKey(params(self)).catch((failure: unknown) => failure);
    expect(halted).toBeInstanceOf(RotationHalted);
    expect((halted as RotationHalted).gap).toEqual({ missing: [], undecryptable: [2] });

    const result = await rotateFamilyKey(params(self, { acceptGaps: true }));
    expect(result.inheritedGaps).toEqual([2]);
    expect(result.moved).toBe(3);
  });
});

describe("завершённость ротации не назначает тот, кого она ограничивает", () => {
  it("сервер сказал «завершено», а членство показывает прежнюю эпоху — старый ключ остаётся", async () => {
    self.membershipAfter = { ...self.membershipAfter, keyEpoch: FIRST_EPOCH };
    await expect(rotateFamilyKey(params(self))).rejects.toThrow(
      /не показывает новую эпоху действующей/u,
    );
    expect(self.calls).toContain("completeRotation");
  });

  it("членство показывает новую эпоху, но и незавершённую ротацию — тот же отказ", async () => {
    self.membershipAfter = {
      ...self.membershipAfter,
      rotation: { keyEpoch: 3, startedAt: 1_700_000_200_000 },
    };
    await expect(rotateFamilyKey(params(self))).rejects.toThrow(
      /Смена ключа не завершена, старый ключ на устройстве сохранён/u,
    );
  });

  it("сервер объявил номер эпохи не выше действующей — ротация не начинается", async () => {
    const api: RotationApi = {
      ...self.api,
      async declareRotation(_familyId, rotationId) {
        self.calls.push("declareRotation");
        return {
          keyEpoch: FIRST_EPOCH,
          previousKeyEpoch: FIRST_EPOCH,
          rotationId,
          freezeSeq: 5,
          rotatingDeviceId: OWNER_DEVICE,
          startedAt: 1,
        };
      },
    };
    await expect(rotateFamilyKey(params(self, { api }))).rejects.toThrow(
      /номер эпохи не выше действующей/u,
    );
    expect(self.submitted).toHaveLength(0);
  });
});
