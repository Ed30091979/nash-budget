/**
 * Section 9, as a test rather than as a promise.
 *
 * "Синхронизация необязательна" is a property of the product, and the way it is worded matters:
 * with no account this is **not** a mode with synchronisation switched off, it is the absence of
 * the network layer. So the test does not check that requests succeed or fail — it checks that
 * `fetch` is never reached at all, that the queue holds nothing, and that no cursor exists.
 */
import { IndexedDbBudgetRepository } from "@family-budget/storage";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { databaseName, deleteDatabases } from "./support.js";

interface Doc {
  readonly amountMinor: number;
}

const originalFetch = globalThis.fetch;
let calls: string[] = [];

beforeEach(() => {
  calls = [];
  globalThis.fetch = ((input: RequestInfo | URL) => {
    calls.push(String(input));
    throw new Error("the local-only path must not reach the network");
  }) as typeof globalThis.fetch;
});

afterEach(async () => {
  globalThis.fetch = originalFetch;
  await deleteDatabases();
});

describe("полностью локальный режим", () => {
  it("проходит полный сценарий без единого сетевого обращения и без очереди", async () => {
    const repository = new IndexedDbBudgetRepository<Doc>({ databaseName: databaseName("local") });

    const created = await repository.createIfAbsent({ amountMinor: 0 });
    expect(created.status).toBe("created");
    const first = await repository.loadVersioned();
    const saved = await repository.saveIfRevision(first!.revision, { amountMinor: 1_980_900 });
    expect(saved.status).toBe("saved");
    await repository.setLastSuccessfulBackup("2026-07-16T00:00:00.000Z");
    await repository.restore('{"amountMinor":4419100}', (text) => JSON.parse(text) as Doc);
    expect(await repository.load()).toEqual({ amountMinor: 4_419_100 });
    expect(await repository.getLastSuccessfulBackup()).toBe("2026-07-16T00:00:00.000Z");

    expect(calls).toEqual([]);
    expect(await repository.syncRecordCount()).toEqual({ outbox: 0, state: 0 });
    expect(await repository.listOutbox()).toEqual([]);
    expect(await repository.countOutbox()).toBe(0);
    expect(await repository.readSyncState("cursor")).toBeUndefined();
    expect(await repository.readSyncState("journal")).toBeUndefined();
    expect(await repository.readSyncState("epoch")).toBeUndefined();
  });

  it("импорт модуля синхронизации сам по себе не обращается к сети", async () => {
    vi.resetModules();
    const module = await import("../src/index.js");
    expect(typeof module.SyncEngine).toBe("function");
    expect(typeof module.createHttpTransport).toBe("function");
    expect(calls).toEqual([]);
  });

  it("транспорт создаётся без запроса и берёт адрес из конфигурации, а не из кода", async () => {
    const { createHttpTransport } = await import("../src/transport.js");
    const transport = createHttpTransport({
      baseUrl: "http://127.0.0.1:0",
      accessToken: () => "token",
    });
    expect(typeof transport.fetch).toBe("function");
    expect(calls).toEqual([]);

    const source = await import("node:fs/promises").then((fs) =>
      fs.readFile(new URL("../src/transport.ts", import.meta.url), "utf8"),
    );
    // §9: "Адрес сервера задаётся конфигурацией сборки и не содержит зашитого production-URL."
    expect(source).not.toMatch(/https?:\/\/(?!127\.0\.0\.1|localhost)/);
  });
});
