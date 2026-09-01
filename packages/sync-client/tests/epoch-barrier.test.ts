/**
 * The one place two epoch numbers meet — `SYNC_ARCHITECTURE.md` 5.5 step 8 and 5.4.1.
 *
 * Every case here is a rotation, and a rotation is the ordinary business of this system: it is
 * mandatory when a member leaves and when a device is revoked (5.5), so it happens to honest
 * families on a normal day. The property under test is therefore not that the client survives it
 * but that the client stays *quiet* through it: «ключ семьи не совпадает» is the single loud
 * signal the design has, it has no automatic skip, and a signal raised by every lawful key change
 * is a signal nobody reads by the third time.
 */
import { type SyncedBudgetState } from "@family-budget/sync-protocol";
import { IndexedDbBudgetRepository } from "@family-budget/storage";
import { afterEach, describe, expect, it } from "vitest";

import { SyncEngine, SYNC_STATE_KEYS } from "../src/engine.js";
import { SyncClientError } from "../src/errors.js";
import type { OutgoingEnvelope } from "../src/types.js";
import {
  createFamilyKey,
  databaseName,
  deleteDatabases,
  DEVICE_A,
  DEVICE_B,
  FAMILY_ID,
  FakeSyncServer,
  FIRST_EPOCH,
  SECOND_EPOCH,
  sealOperation,
  stampDrafts,
} from "./support.js";

afterEach(deleteDatabases);

function expense(index: number) {
  return {
    entity: "transaction" as const,
    action: "create" as const,
    targetId: `7aaaaaaa-aaaa-4aaa-8aaa-${String(index).padStart(12, "0")}`,
    fields: {
      kind: "expense" as const,
      occurredOn: "2026-07-20",
      status: "posted" as const,
      amountMinor: 1_000,
      accountId: "22222222-2222-4222-8222-222222222221",
      categoryId: "73333333-3333-4333-8333-333333333335",
    },
  };
}

function engineOn(
  repository: IndexedDbBudgetRepository<SyncedBudgetState>,
  transport: FakeSyncServer | SyncEngineTransport,
  familyKey: CryptoKey,
  keyDigest: string,
  keyEpoch: number,
  deviceId = DEVICE_B,
): SyncEngine {
  return new SyncEngine({
    repository,
    transport,
    familyId: FAMILY_ID,
    deviceId,
    familyKey,
    keyEpoch,
    keyDigest,
  });
}

type SyncEngineTransport = ConstructorParameters<typeof SyncEngine>[0]["transport"];

function repositoryFor(label: string): IndexedDbBudgetRepository<SyncedBudgetState> {
  return new IndexedDbBudgetRepository<SyncedBudgetState>({ databaseName: databaseName(label) });
}

/** The owner's half of 5.5: the journal re-encrypted under `FK'`, with `opId` and `lamport` kept. */
async function reencrypt(
  server: FakeSyncServer,
  next: CryptoKey,
  operations: readonly Parameters<typeof sealOperation>[1][],
): Promise<void> {
  server.rotateTo(SECOND_EPOCH);
  for (const operation of operations) {
    server.seed(await sealOperation(next, operation, { keyEpoch: SECOND_EPOCH }));
  }
}

describe("барьер эпохи", () => {
  it("честная ротация не поднимает тревогу и проходит журнал заново", async () => {
    const server = new FakeSyncServer();
    const family = await createFamilyKey();
    const rotated = await createFamilyKey();
    const repository = repositoryFor("rotation");

    const operations = stampDrafts(DEVICE_A, [expense(1), expense(2), expense(3)]);
    for (const operation of operations) server.seed(await sealOperation(family.key, operation));

    const before = engineOn(repository, server, family.key, family.digest, FIRST_EPOCH);
    const first = await before.pull();
    expect(first.stop).toBeNull();
    expect(first.applied).toBe(3);
    expect((await before.status()).cursor).toEqual({ keyEpoch: FIRST_EPOCH, seq: 3 });
    const journalBefore = await repository.readSyncState(SYNC_STATE_KEYS.journal);

    // The owner rotates: the journal is re-encrypted under `FK'`, the old epoch's envelopes are
    // destroyed with it, and the new epoch numbers its own journal from `1`.
    await reencrypt(server, rotated.key, operations);

    // This device accepts `FK'` by the chain of 5.4 — which happens outside the engine — and is
    // then rebuilt on the new key. The store still holds the cursor of the epoch before it.
    const after = engineOn(repository, server, rotated.key, rotated.digest, SECOND_EPOCH);
    const second = await after.pull();

    expect(second.stop).toBeNull();
    expect(second.notices).toEqual([]);
    expect(second.applied).toBe(3);
    expect(second.cursor).toEqual({ keyEpoch: SECOND_EPOCH, seq: 3 });

    const status = await after.status();
    expect(status.stop).toBeNull();
    expect(status.cursor).toEqual({ keyEpoch: SECOND_EPOCH, seq: 3 });
    // Re-applying the same journal changes nothing: 5.5 step 8 says the local state is not wiped
    // and that walking it again is harmless.
    expect(await repository.readSyncState(SYNC_STATE_KEYS.journal)).toEqual(journalBefore);
  });

  it("сброс курсора переживает перезапуск между сбросом и первой страницей", async () => {
    const server = new FakeSyncServer();
    const family = await createFamilyKey();
    const rotated = await createFamilyKey();
    const name = databaseName("rotation-restart");
    const repository = new IndexedDbBudgetRepository<SyncedBudgetState>({ databaseName: name });

    const operations = stampDrafts(DEVICE_A, [expense(1), expense(2)]);
    for (const operation of operations) server.seed(await sealOperation(family.key, operation));
    await engineOn(repository, server, family.key, family.digest, FIRST_EPOCH).pull();

    await reencrypt(server, rotated.key, operations);

    // The link dies on the first request after the reset.
    server.offline = true;
    const after = engineOn(repository, server, rotated.key, rotated.digest, SECOND_EPOCH);
    await expect(after.pull()).rejects.toBeInstanceOf(SyncClientError);

    const restarted = engineOn(
      new IndexedDbBudgetRepository<SyncedBudgetState>({ databaseName: name }),
      server,
      rotated.key,
      rotated.digest,
      SECOND_EPOCH,
    );
    expect((await restarted.status()).cursor).toEqual({ keyEpoch: SECOND_EPOCH, seq: 0 });

    server.offline = false;
    const healed = await restarted.pull();
    expect(healed.stop).toBeNull();
    expect(healed.cursor).toEqual({ keyEpoch: SECOND_EPOCH, seq: 2 });
  });

  it("тревога прошлой эпохи не переезжает в новую", async () => {
    const server = new FakeSyncServer();
    const family = await createFamilyKey();
    const imposed = await createFamilyKey();
    const rotated = await createFamilyKey();
    const repository = repositoryFor("rotation-alarm");

    // A genuine envelope of a key this device does not hold: the alarm of 3.4, raised honestly.
    const operations = stampDrafts(DEVICE_A, [expense(1)]);
    for (const operation of operations) server.seed(await sealOperation(imposed.key, operation));

    const before = engineOn(repository, server, family.key, family.digest, FIRST_EPOCH);
    const stopped = await before.pull();
    expect(stopped.stop).toMatchObject({ reason: "key_mismatch", attempts: 1 });

    // The family reacts the way 5.5 prescribes — by rotating the key.
    await reencrypt(server, rotated.key, operations);

    const after = engineOn(repository, server, rotated.key, rotated.digest, SECOND_EPOCH);
    // The alarm named an envelope of a journal that no longer exists, so it is gone before the
    // first request rather than counted on into the new epoch.
    expect((await after.status()).stop).toBeNull();
    const healed = await after.pull();
    expect(healed.stop).toBeNull();
    expect(healed.applied).toBe(1);
    expect(await repository.readSyncState(SYNC_STATE_KEYS.stop)).toBeNull();
  });

  it("курсор, ушедший вперёд ключа, — ошибка состояния, а не тревога о подмене", async () => {
    const server = new FakeSyncServer();
    const family = await createFamilyKey();
    const repository = repositoryFor("cursor-ahead");
    await repository.writeSyncState([
      { key: SYNC_STATE_KEYS.cursor, value: { keyEpoch: SECOND_EPOCH, seq: 7 } },
    ]);

    // The engine holds the key of the epoch *before* the cursor: a step down, which 5.4.1 refuses.
    const engine = engineOn(repository, server, family.key, family.digest, FIRST_EPOCH);

    const failure = await engine.pull().catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(SyncClientError);
    expect((failure as SyncClientError).code).toBe("epoch_conflict");
    expect(server.fetches).toBe(0);
    // And the refusal changed nothing: the cursor is where it was.
    expect(await repository.readSyncState(SYNC_STATE_KEYS.cursor)).toEqual({
      keyEpoch: SECOND_EPOCH,
      seq: 7,
    });
  });

  it("живость отмечается адресно: ротация гасит её и новая эпоха доказывает себя сама", async () => {
    const server = new FakeSyncServer();
    const family = await createFamilyKey();
    const rotated = await createFamilyKey();
    const repository = repositoryFor("liveness");

    const before = engineOn(repository, server, family.key, family.digest, FIRST_EPOCH, DEVICE_A);
    await before.enqueue([expense(1)]);
    await before.push();
    expect((await before.status()).epoch).toEqual({
      keyEpoch: FIRST_EPOCH,
      keyDigest: family.digest,
      live: true,
    });

    server.rotateTo(SECOND_EPOCH);
    const after = engineOn(repository, server, rotated.key, rotated.digest, SECOND_EPOCH, DEVICE_A);

    // The mark belonged to the epoch it was earned in. The new one is not live because the old
    // one was: 5.4.1 makes liveness the server's number on an envelope of *this* key.
    expect((await after.status()).epoch).toEqual({
      keyEpoch: SECOND_EPOCH,
      keyDigest: rotated.digest,
      live: false,
    });

    await after.enqueue([expense(2)]);
    await after.push();
    expect((await after.status()).epoch).toEqual({
      keyEpoch: SECOND_EPOCH,
      keyDigest: rotated.digest,
      live: true,
    });
    expect(await repository.readSyncState(SYNC_STATE_KEYS.epoch)).toEqual({
      keyEpoch: SECOND_EPOCH,
      keyDigest: rotated.digest,
      live: true,
    });
  });

  it("номер, выданный конверту прошлой эпохи, живость новой не доказывает", async () => {
    const server = new FakeSyncServer();
    const family = await createFamilyKey();
    const rotated = await createFamilyKey();
    const repository = repositoryFor("stale-ack");

    // The queue is filled under the epoch in force and stays sealed under it.
    const before = engineOn(repository, server, family.key, family.digest, FIRST_EPOCH, DEVICE_A);
    await before.enqueue([expense(1)]);

    // A server that numbers whatever it is sent, whichever epoch it belongs to.
    const compliant = {
      submit: async (_familyId: string, envelopes: readonly OutgoingEnvelope[]) => ({
        keyEpoch: SECOND_EPOCH,
        accepted: envelopes.map((envelope, index) => ({ opId: envelope.opId, seq: index + 1 })),
      }),
      fetch: server.fetch.bind(server),
      keys: server.keys.bind(server),
    };
    const after = engineOn(repository, compliant, rotated.key, rotated.digest, SECOND_EPOCH, DEVICE_A);

    const failure = await after.push().catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(SyncClientError);
    expect((failure as SyncClientError).code).toBe("epoch_conflict");
    // Not one word of liveness was written for the epoch this device now seals under.
    expect(await repository.readSyncState(SYNC_STATE_KEYS.epoch)).toBeUndefined();
  });

  it("испорченные записи состояния отвергаются так же, как испорченный курсор", async () => {
    const server = new FakeSyncServer();
    const family = await createFamilyKey();
    const repository = repositoryFor("corrupt-state");
    const engine = engineOn(repository, server, family.key, family.digest, FIRST_EPOCH);

    const corrupt = async (key: string, value: unknown) => {
      await repository.writeSyncState([{ key, value }]);
      const failure = await engine.status().catch((error: unknown) => error);
      expect(failure).toBeInstanceOf(SyncClientError);
      expect((failure as SyncClientError).code).toBe("corrupt_sync_state");
      await repository.writeSyncState([{ key, value: null }]);
    };

    // The attempt counter is compared against the threshold of 3.4; a string there turns the
    // comparison into a lexicographic accident.
    await corrupt(SYNC_STATE_KEYS.stop, {
      reason: "key_mismatch",
      seq: 1,
      opId: "0f000000-0000-4000-8000-00000000f00d",
      attempts: "9",
    });
    await corrupt(SYNC_STATE_KEYS.stop, {
      reason: "не наш повод",
      seq: 1,
      opId: "0f000000-0000-4000-8000-00000000f00d",
      attempts: 1,
    });
    await corrupt(SYNC_STATE_KEYS.epoch, { keyEpoch: FIRST_EPOCH, keyDigest: 42, live: true });
    await corrupt(SYNC_STATE_KEYS.epoch, {
      keyEpoch: FIRST_EPOCH,
      keyDigest: family.digest,
      live: "да",
    });
    await corrupt(SYNC_STATE_KEYS.cursor, { keyEpoch: FIRST_EPOCH, seq: "12" });
  });

  it("та же эпоха под другим ключом — отказ по имени, а не молчаливая запись", async () => {
    const server = new FakeSyncServer();
    const family = await createFamilyKey();
    const other = await createFamilyKey();
    const repository = repositoryFor("substituted");
    await repository.writeSyncState([
      {
        key: SYNC_STATE_KEYS.epoch,
        value: { keyEpoch: FIRST_EPOCH, keyDigest: other.digest, live: true },
      },
    ]);

    const engine = engineOn(repository, server, family.key, family.digest, FIRST_EPOCH);

    const failure = await engine.status().catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(SyncClientError);
    expect((failure as SyncClientError).code).toBe("epoch_conflict");
  });
});
