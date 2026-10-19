/**
 * The product promise of section 9 and decision 7, as a test rather than as a sentence.
 *
 * «Без входа приложение работает ровно как сейчас»: not "with synchronisation switched off" but
 * the absence of the layer. So this file does not check that requests fail — it checks that
 * `fetch` is never reached, that the queue holds nothing, that no sync record exists, and that the
 * database is still at the version it had before family synchronisation was written.
 */
import "fake-indexeddb/auto";
import { makeSeedBudget } from "@family-budget/domain";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createAppBudgetSaveCoordinator } from "../../app/budget-store";
import { prepareBudgetState } from "../../backup";
import { createBudgetRepository } from "../../storage-repository";
import { createBudgetJournalWriter } from "./controller";
import {
  isSyncActive,
  loadSession,
  parseSession,
  persistSession,
  resolveSyncServerUrl,
  type FamilySession,
} from "./session";

const databaseNames = new Set<string>();

function databaseName(label: string): string {
  const value = `family-budget-family-${label}-${crypto.randomUUID()}`;
  databaseNames.add(value);
  return value;
}

function openedVersion(name: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(name);
    request.onsuccess = () => {
      const version = request.result.version;
      request.result.close();
      resolve(version);
    };
    request.onerror = () => reject(request.error);
  });
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
  vi.restoreAllMocks();
  for (const name of databaseNames) {
    await new Promise<void>((resolve) => {
      const request = indexedDB.deleteDatabase(name);
      request.onsuccess = () => resolve();
      request.onerror = () => resolve();
      request.onblocked = () => resolve();
    });
  }
  databaseNames.clear();
});

describe("без входа приложение работает ровно как сейчас", () => {
  it("полный локальный сценарий не делает ни одного сетевого обращения и не поднимает базу", async () => {
    const name = databaseName("local");
    const repository = createBudgetRepository({ databaseName: name });

    const created = await repository.createIfAbsent(makeSeedBudget());
    expect(created.status).toBe("created");
    const snapshot = await repository.loadVersioned();
    expect(snapshot).not.toBeNull();
    await repository.saveIfRevision(snapshot!.revision, makeSeedBudget());
    await repository.setLastSuccessfulBackup("2026-07-16T00:00:00.000Z");

    // Чтение сессии — единственное, что делает приложение при старте на локальном пути.
    expect(await loadSession(repository)).toBeNull();

    expect(calls).toEqual([]);
    expect(await repository.syncRecordCount()).toEqual({ outbox: 0, state: 0 });
    expect(await repository.countOutbox()).toBe(0);
    // Версия базы до синхронизации — `2`. Приложение без входа её не поднимает.
    expect(await openedVersion(name)).toBe(2);
  });

  it("запись бюджета без семьи идёт прежним путём и не создаёт ни очереди, ни журнала", async () => {
    const name = databaseName("journal-off");
    const repository = createBudgetRepository({ databaseName: name });
    const created = await repository.createIfAbsent(prepareBudgetState(makeSeedBudget()));
    expect(created.status).toBe("created");

    // Ровно тот же путь, что в приложении: координатор спрашивает журнал на каждой записи, а
    // журнал без адреса сервера и без сессии отвечает «меня нет».
    const readSyncState = vi.spyOn(repository, "readSyncState");
    const writer = createBudgetJournalWriter({
      engineFor: async () => null,
      store: repository as never,
      memberId: () => undefined,
      saveIfRevision: (revision, value) =>
        repository.saveIfRevision(revision, value as never) as never,
    });

    let shown = prepareBudgetState(created.value);
    let revision: string | null = null;
    const coordinator = createAppBudgetSaveCoordinator({
      repository: repository as never,
      getCurrent: () => shown,
      getRevision: () => revision,
      setRevision: (value) => {
        revision = value;
      },
      publish: (next, value) => {
        shown = next;
        revision = value;
      },
      journalWrite: () => writer,
    });

    const saved = await coordinator.apply((state) => ({
      ...state,
      transactions: [
        ...state.transactions,
        {
          id: "55555555-5555-4555-8555-55555555ffff",
          occurredOn: "2026-07-09",
          status: "posted",
          kind: "expense",
          amountMinor: 400_000,
          accountId: "22222222-2222-4222-8222-222222222221",
          categoryId: "33333333-3333-4333-8333-333333333333",
        },
      ],
    }));
    expect(saved.transactions).toHaveLength(6);

    // «Журнала нет» решается до единственного чтения хранилища, поэтому схема не поднимается.
    expect(readSyncState).not.toHaveBeenCalled();
    expect(calls).toEqual([]);
    expect(await repository.countOutbox()).toBe(0);
    expect(await repository.syncRecordCount()).toEqual({ outbox: 0, state: 0 });
    expect(await openedVersion(name)).toBe(2);
  });

  it("вход и только вход поднимает схему до версии с синхронизацией", async () => {
    const name = databaseName("signed-in");
    const repository = createBudgetRepository({ databaseName: name });
    await repository.createIfAbsent(makeSeedBudget());
    expect(await openedVersion(name)).toBe(2);

    const session: FamilySession = {
      email: "semya@example.com",
      deviceId: "77777777-7777-4777-8777-777777777777",
      accountId: "88888888-8888-4888-8888-888888888888",
      accessToken: "access",
      accessExpiresAt: 1_800_000_000_000,
      refreshToken: "refresh",
      familyId: null,
      memberId: null,
      role: null,
    };
    await persistSession(repository, session);

    expect(await openedVersion(name)).toBe(3);
    expect(await loadSession(repository)).toEqual(session);
    // Даже после входа очередь пуста, пока не записана ни одна операция.
    expect(await repository.countOutbox()).toBe(0);
  });

  it("адрес сервера берётся из конфигурации и по умолчанию отсутствует", () => {
    expect(resolveSyncServerUrl({})).toBeNull();
    expect(resolveSyncServerUrl({ VITE_SYNC_SERVER_URL: "" })).toBeNull();
    expect(resolveSyncServerUrl({ VITE_SYNC_SERVER_URL: "нет" })).toBeNull();
    expect(resolveSyncServerUrl({ VITE_SYNC_SERVER_URL: "javascript:alert(1)" })).toBeNull();
    expect(resolveSyncServerUrl({ VITE_SYNC_SERVER_URL: "http://127.0.0.1:8787/" })).toBe(
      "http://127.0.0.1:8787",
    );
  });

  it("в исходниках экрана семьи нет зашитого адреса сервера", async () => {
    const sources = await Promise.all(
      ["./api.ts", "./session.ts", "./FamilyScreen.tsx"].map((path) =>
        import("node:fs/promises").then((fs) =>
          fs.readFile(new URL(path, import.meta.url), "utf8"),
        ),
      ),
    );
    for (const source of sources) {
      expect(source).not.toMatch(/https?:\/\/(?!127\.0\.0\.1|localhost)/u);
    }
  });

  it("движок семьи отказывает раньше, чем притрагивается к хранилищу", async () => {
    const controller = await import("node:fs/promises").then((fs) =>
      fs.readFile(new URL("./controller.ts", import.meta.url), "utf8"),
    );
    // Порядок проверок — это и есть обещание: адрес и сессия решают всё до чтения ключа семьи,
    // потому что само чтение подняло бы схему устройства, которое никогда не входило.
    expect(controller).toMatch(
      /const current = sessionRef\.current;\s*\n\s*if \(serverUrl === null \|\| current === null \|\| current\.familyId === null\) return null;\s*\n\s*const stored = await store\.readSyncState/u,
    );
    // И запись бюджета спрашивает движок первым делом, до любого чтения журнала.
    expect(controller).toMatch(
      /const engine = await options\.engineFor\(\);\s*\n\s*if \(engine === null\) return null;/u,
    );
  });

  it("сеть закрыта, пока нет и адреса, и сессии", () => {
    const session = parseSession({
      email: "semya@example.com",
      deviceId: "77777777-7777-4777-8777-777777777777",
      accountId: "88888888-8888-4888-8888-888888888888",
      accessToken: "access",
      accessExpiresAt: 1_800_000_000_000,
      refreshToken: "refresh",
    });
    expect(session).not.toBeNull();
    expect(isSyncActive(null, session)).toBe(false);
    expect(isSyncActive("http://127.0.0.1:8787", null)).toBe(false);
    expect(isSyncActive("http://127.0.0.1:8787", session)).toBe(true);
  });

  it("полусохранённая запись сессии не делает устройство наполовину вошедшим", () => {
    expect(parseSession(null)).toBeNull();
    expect(parseSession("сессия")).toBeNull();
    expect(parseSession({ email: "semya@example.com", accessToken: "access" })).toBeNull();
    expect(
      parseSession({
        email: "semya@example.com",
        deviceId: "77777777-7777-4777-8777-777777777777",
        accountId: "88888888-8888-4888-8888-888888888888",
        accessToken: "access",
        accessExpiresAt: "скоро",
        refreshToken: "refresh",
      }),
    ).toBeNull();
  });
});
