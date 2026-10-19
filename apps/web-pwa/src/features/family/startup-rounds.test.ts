/**
 * Старт приложения в семье: в полёте один круг опроса, а не столько, сколько пришло ответов.
 *
 * Цикл опроса начинался заново на каждое прибытие пинов и списка устройств: от них зависел
 * `acceptIncomingEpoch`, а от него — эффект опроса. Список семьи перечитывается при каждом
 * обновлении токена, поэтому то же повторялось и через пятнадцать минут работы. Новый цикл сразу
 * начинал свой круг на том же курсоре, пока прежний ещё ждал ответа: две выборки одних и тех же
 * конвертов, конфликт ревизии при записи документа и, после четырёх попыток, мелькающий «отказ» в
 * шапке. Экран при этом был прав (ec18e1c), но платил за каждый перезапуск.
 *
 * Здесь хук работает целиком: настоящий `useFamily`, база в `fake-indexeddb`, сервер — `fetch`
 * в несколько десятков строк, который отвечает так, как это бывает на старте: список семьи
 * приходит, пока первый круг ждёт конвертов, а доступ, записанный на диск, уже устарел.
 */
/// <reference types="node" />
import "fake-indexeddb/auto";
import { createElement, useEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import { makeSeedBudget } from "@family-budget/domain";
import { toBase64, type KeyWrapRecord } from "@family-budget/sync-client";
import {
  computeEpochConfirm,
  deviceKeyFingerprint,
  exportDevicePublicKey,
  generateDeviceKeyPair,
  generateFamilyKey,
  toHex,
  wrapFamilyKey,
} from "@family-budget/sync-crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { prepareBudgetState } from "../../backup";
import { createBudgetRepository } from "../../storage-repository";
import type { DeviceRecord } from "./api";
import { useFamily, type FamilyController } from "./controller";
import { PINS_STATE_KEY, persistSession } from "./session";

const BASE = "http://127.0.0.1:8787";
const FAMILY_ID = "0f000000-0000-4000-8000-00000000fa11";
const DEVICE_OWN = "0000000a-0000-4000-8000-000000000001";
const DEVICE_PEER = "0000000b-0000-4000-8000-000000000002";
const MEMBER_OWN = "0000000a-0000-4000-8000-00000000aaaa";
const MEMBER_PEER = "0000000b-0000-4000-8000-00000000bbbb";
const ROTATION_ID = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeee1";
/** Доступ, с которым устройство открылось: сервер его уже не принимает. */
const STALE_ACCESS = "access-0";

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function device(deviceId: string, memberId: string, spki: Uint8Array): DeviceRecord {
  return { deviceId, memberId, publicKey: toBase64(spki), bindProof: null, inviteId: null, createdAt: 1, lastSeenAt: 1, revokedAt: null };
}

interface ServerOptions {
  readonly devices: readonly DeviceRecord[];
  /** Ответ на выборку конвертов эпохи `keyEpoch`; по умолчанию — пусто. */
  readonly envelopes?: (keyEpoch: number) => Response;
  readonly wraps?: readonly KeyWrapRecord[];
}

/**
 * Сервер семьи для одного старта.
 *
 * Выборки конвертов ждут, пока тест их не отпустит, — так видно, сколько кругов в полёте сразу.
 * Список устройств придержан до первой выборки: на старте он приходит позже, чем первый круг
 * доходит до сети (два запроса подряд против чтения с диска), и именно тогда перезапуск цикла
 * оставлял прежний круг в полёте.
 */
function startupServer(options: ServerOptions) {
  let issued = 0;
  let firstFetch!: () => void;
  const fetched = new Promise<void>((resolve) => {
    firstFetch = resolve;
  });
  let open!: () => void;
  const gate = new Promise<void>((resolve) => {
    open = resolve;
  });
  const state = { fetches: [] as number[], inFlight: 0, maxInFlight: 0, refreshes: 0 };

  const fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = new URL(String(input));
    const method = init?.method ?? "GET";
    const headers = (init?.headers ?? {}) as Record<string, string>;
    if (url.pathname === "/v1/auth/refresh") {
      state.refreshes += 1;
      issued += 1;
      return json({
        accountId: "account",
        deviceId: DEVICE_OWN,
        accessToken: `access-${issued}`,
        accessExpiresAt: 4_102_444_800_000,
        refreshToken: `refresh-${issued}`,
      });
    }
    if (headers.authorization === `Bearer ${STALE_ACCESS}`) return json({ error: { code: "unauthorized" } }, 401);
    const family = `/v1/families/${FAMILY_ID}`;
    if (url.pathname === "/v1/families/me") {
      return json({ familyId: FAMILY_ID, keyEpoch: 1, memberId: MEMBER_OWN, role: "owner", ownerMemberId: MEMBER_OWN, rotation: null });
    }
    if (url.pathname === `${family}/members`) {
      return json({
        members: [
          { memberId: MEMBER_OWN, role: "owner", joinedAt: 1, removedAt: null },
          { memberId: MEMBER_PEER, role: "member", joinedAt: 2, removedAt: null },
        ],
      });
    }
    if (url.pathname === `${family}/devices`) {
      await fetched;
      return json({ devices: options.devices });
    }
    if (url.pathname === `${family}/keys`) {
      return json({ keyEpoch: 2, wraps: options.wraps ?? [] });
    }
    if (url.pathname === `${family}/envelopes` && method === "GET") {
      const keyEpoch = Number(url.searchParams.get("keyEpoch"));
      state.fetches.push(keyEpoch);
      state.inFlight += 1;
      state.maxInFlight = Math.max(state.maxInFlight, state.inFlight);
      firstFetch();
      try {
        await gate;
        return options.envelopes?.(keyEpoch) ?? json({ keyEpoch, hasMore: false, envelopes: [] });
      } finally {
        state.inFlight -= 1;
      }
    }
    if (url.pathname === `${family}/envelopes` && method === "POST") {
      const body = JSON.parse(String(init?.body)) as { readonly envelopes: readonly { readonly opId: string }[] };
      return json({ keyEpoch: 1, accepted: body.envelopes.map((envelope, index) => ({ opId: envelope.opId, seq: index + 1 })) });
    }
    return json({ error: { code: "not_found" } }, 404);
  };

  return { fetch, state, fetched, release: () => open() };
}

/**
 * Ровно то, что `react-dom` трогает в документе, когда компонент ничего не рисует, и то, что
 * трогает сам хук: видимость, её событие и таймер. Интервал не заводится: каждый цикл опроса
 * заводит его ровно один раз, и потому счёт заведённых интервалов — это счёт циклов.
 */
function installBrowser() {
  const cycles: number[] = [];
  const document = {
    nodeType: 9,
    visibilityState: "visible",
    activeElement: null,
    addEventListener() {},
    removeEventListener() {},
  } as Record<string, unknown>;
  const window = {
    document,
    event: undefined,
    HTMLIFrameElement: class {},
    setInterval: (_callback: () => void, ms: number) => cycles.push(ms),
    clearInterval: () => undefined,
  };
  document.defaultView = window;
  vi.stubGlobal("document", document);
  vi.stubGlobal("window", window);
  const container = {
    nodeType: 1,
    nodeName: "DIV",
    tagName: "DIV",
    namespaceURI: "http://www.w3.org/1999/xhtml",
    ownerDocument: document,
    textContent: "",
    addEventListener() {},
    removeEventListener() {},
  };
  return { cycles, container: container as unknown as Element };
}

const databases = new Set<string>();
let root: Root | null = null;
let releaseServer: (() => void) | null = null;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", false);
});

afterEach(async () => {
  releaseServer?.();
  releaseServer = null;
  root?.unmount();
  root = null;
  // Размонтирование доделывает свои эффекты задачей планировщика — ей ещё нужен `window`.
  await new Promise((resolve) => setTimeout(resolve, 50));
  vi.unstubAllGlobals();
  for (const name of databases) {
    await new Promise<void>((resolve) => {
      const request = indexedDB.deleteDatabase(name);
      request.onsuccess = () => resolve();
      request.onerror = () => resolve();
      request.onblocked = () => resolve();
    });
  }
  databases.clear();
});

/** Устройство, которое уже в семье: бюджет, сессия с устаревшим доступом, ключ семьи и пины. */
async function memberDevice(syncState: readonly { readonly key: string; readonly value: unknown }[]) {
  const databaseName = `family-startup-${crypto.randomUUID()}`;
  databases.add(databaseName);
  const repository = createBudgetRepository({ databaseName });
  await repository.createIfAbsent(prepareBudgetState(makeSeedBudget()));
  await persistSession(repository as never, {
    email: "anna@example.com",
    deviceId: DEVICE_OWN,
    accountId: "account",
    accessToken: STALE_ACCESS,
    accessExpiresAt: 1,
    refreshToken: "refresh-0",
    familyId: FAMILY_ID,
    memberId: MEMBER_OWN,
    role: "owner",
  });
  await repository.writeSyncState(syncState);
  return repository;
}

/**
 * Хук на устройстве и всё, что он отдал экрану, — после эффектов каждого кадра: эффект ниже
 * объявлен после эффектов `useFamily` в том же компоненте и выполняется после них.
 */
function startApp(repository: ReturnType<typeof createBudgetRepository>, server: ReturnType<typeof startupServer>) {
  releaseServer = server.release;
  vi.stubGlobal("fetch", server.fetch);
  const browser = installBrowser();
  const committed: FamilyController[] = [];
  function Probe() {
    const family = useFamily(repository, BASE);
    useEffect(() => {
      committed.push(family);
    });
    return null;
  }
  root = createRoot(browser.container);
  root.render(createElement(Probe));
  return { cycles: browser.cycles, latest: () => committed.at(-1) };
}

/** Первый круг дошёл до сети и ждёт; за это время пришли пины, доступ обновился, и список семьи прочитан с новым. */
async function startupSettled(app: ReturnType<typeof startApp>, server: ReturnType<typeof startupServer>, devices: number) {
  await server.fetched;
  await vi.waitFor(() => {
    const latest = app.latest();
    expect(latest?.devices).toHaveLength(devices);
    expect(latest?.pinOf(DEVICE_PEER)).toMatchObject({ state: "pinned" });
    expect(latest?.session?.accessToken).not.toBe(STALE_ACCESS);
  });
  expect(server.state.refreshes).toBe(1);
  // Перезапущенный цикл начал бы свой круг сразу, но до сети дошёл бы не сразу: чтения с диска.
  // Время ему дано — выборки при этом всё ещё придержаны.
  await new Promise((resolve) => setTimeout(resolve, 200));
}

describe("старт в семье", () => {
  it("в полёте один круг: пины, список устройств и обновление токена цикл опроса не перезапускают", async () => {
    const repository = await memberDevice([
      { key: "family-key", value: { key: await generateFamilyKey(), keyEpoch: 1 } },
      { key: PINS_STATE_KEY, value: { [DEVICE_PEER]: "22".repeat(32) } },
    ]);
    const server = startupServer({
      devices: [
        device(DEVICE_OWN, MEMBER_OWN, new Uint8Array(91).fill(1)),
        device(DEVICE_PEER, MEMBER_PEER, new Uint8Array(91).fill(2)),
      ],
    });
    const app = startApp(repository, server);

    await startupSettled(app, server, 2);
    expect(server.state.maxInFlight).toBe(1);
    expect(server.state.fetches).toHaveLength(1);
    expect(app.cycles).toEqual([15_000]);

    // Круг отпущен и доведён до отчёта — и второго круга на том же курсоре так и не было.
    server.release();
    await vi.waitFor(() => expect(app.latest()?.status).not.toBeNull());
    expect(server.state.fetches).toHaveLength(1);
    expect(server.state.maxInFlight).toBe(1);
    expect(app.latest()?.syncRound).toBe("ok");
  });

  it("приём новой эпохи после старта видит пины и список устройств, пришедшие без перезапуска цикла", async () => {
    // 5.4.1 на настоящих обёртках: соседнее устройство сменило ключ и завернуло новый этому, а
    // преемственность подтверждена ключом прошлой эпохи. Отпечаток соседа закреплён здесь, его
    // открытый ключ — только в списке устройств с сервера.
    const firstKey = await generateFamilyKey();
    const secondKey = await generateFamilyKey();
    const own = await generateDeviceKeyPair();
    const ownSpki = await exportDevicePublicKey(own.publicKey);
    const peer = await generateDeviceKeyPair();
    const peerSpki = await exportDevicePublicKey(peer.publicKey);
    const made = await wrapFamilyKey({
      familyKey: secondKey,
      senderPrivateKey: peer.privateKey,
      senderSpki: peerSpki,
      senderDeviceId: DEVICE_PEER,
      recipientSpki: ownSpki,
      recipientDeviceId: DEVICE_OWN,
      pinnedRecipientFingerprint: await deviceKeyFingerprint(ownSpki),
      familyId: FAMILY_ID,
      keyEpoch: 2,
      rotationId: ROTATION_ID,
    });
    const confirm = await computeEpochConfirm({
      previousFamilyKey: firstKey,
      familyId: FAMILY_ID,
      keyEpoch: 2,
      rotationId: ROTATION_ID,
      nextFamilyKey: secondKey,
    });
    const repository = await memberDevice([
      { key: "family-key", value: { key: firstKey, keyEpoch: 1 } },
      { key: "device-key", value: { keyPair: own, spki: toBase64(ownSpki) } },
      { key: PINS_STATE_KEY, value: { [DEVICE_PEER]: toHex(await deviceKeyFingerprint(peerSpki)) } },
    ]);
    const server = startupServer({
      devices: [device(DEVICE_OWN, MEMBER_OWN, ownSpki), device(DEVICE_PEER, MEMBER_PEER, peerSpki)],
      // Эпоха 1 закрыта: сервер отказывает выборке, и круг идёт за обёрткой.
      envelopes: (keyEpoch) =>
        keyEpoch === 1
          ? json({ error: { code: "epoch_mismatch" } }, 409)
          : json({ keyEpoch, hasMore: false, envelopes: [] }),
      wraps: [
        {
          keyEpoch: 2,
          deviceId: DEVICE_OWN,
          senderDeviceId: DEVICE_PEER,
          rotationId: ROTATION_ID,
          salt: toBase64(made.salt),
          iv: toBase64(made.iv),
          ciphertext: toBase64(made.ciphertext),
          rotateConfirm: toBase64(confirm),
          confirmRotationId: ROTATION_ID,
        },
      ],
    });
    const app = startApp(repository, server);

    // Отказ приходит первому кругу старта — тому, что начался до пинов и списка устройств.
    await startupSettled(app, server, 2);
    server.release();
    await vi.waitFor(() => expect(app.latest()?.status).not.toBeNull());
    expect(app.latest()?.epochAlarm).toBeNull();
    expect(server.state.fetches).toEqual([1, 2]);
    expect(app.latest()?.syncRound).toBe("ok");
    expect(await repository.readSyncState<{ readonly keyEpoch: number }>("family-key")).toMatchObject({ keyEpoch: 2 });
    expect(app.cycles).toEqual([15_000]);
    expect(server.state.maxInFlight).toBe(1);
  });
});
