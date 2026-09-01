/**
 * Обновление доступа: один вызов, один повтор, и ни одной лишней попытки.
 *
 * Доступ живёт пятнадцать минут (6.1). До этой правки клиент умел обновляться и не обновлялся
 * ниоткуда: через пятнадцать минут работы человек с действующей сессией читал «Вход устарел.
 * Войдите ещё раз по коду из письма» — и это про обе половины сети сразу, про запросы семьи и про
 * журнал. Поэтому здесь проверяются обе.
 *
 * Повтор ровно один. Сервер поворачивает refresh-токен на каждом использовании, так что цепочка
 * обновлений — это второе обновление уже потраченным токеном, то есть выход из учётной записи на
 * ровном месте.
 */
import { SyncServerError, type SyncTransport } from "@family-budget/sync-client";
import { describe, expect, it, vi } from "vitest";

import { createFamilyApi, FamilyApiError } from "./api";
import { transportWithTokenRefresh } from "./controller";

const BASE = "http://127.0.0.1:8787";

function refusal(code: string): Response {
  return new Response(JSON.stringify({ error: { code } }), {
    status: 401,
    headers: { "content-type": "application/json" },
  });
}

function accepted(body: unknown = { familyId: "f", keyEpoch: 1, memberId: "m", role: "owner", ownerMemberId: "m" }): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

describe("обновление доступа в запросах семьи", () => {
  it("истёкший доступ обновляется и запрос повторяется — один раз", async () => {
    let token = "stale";
    const fetch = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const authorization = (init?.headers as Record<string, string> | undefined)?.authorization;
      return authorization === "Bearer fresh" ? accepted() : refusal("unauthorized");
    });
    const refreshAccess = vi.fn(async () => {
      token = "fresh";
      return true;
    });

    const api = createFamilyApi({
      baseUrl: BASE,
      accessToken: () => token,
      fetch: fetch as unknown as typeof globalThis.fetch,
      refreshAccess,
    });

    await expect(api.membership()).resolves.toMatchObject({ familyId: "f" });
    expect(refreshAccess).toHaveBeenCalledTimes(1);
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("второй отказ — настоящий: повтор не повторяется", async () => {
    const fetch = vi.fn(async () => refusal("unauthorized"));
    const refreshAccess = vi.fn(async () => true);
    const api = createFamilyApi({
      baseUrl: BASE,
      accessToken: () => "stale",
      fetch: fetch as unknown as typeof globalThis.fetch,
      refreshAccess,
    });

    await expect(api.membership()).rejects.toBeInstanceOf(FamilyApiError);
    expect(refreshAccess).toHaveBeenCalledTimes(1);
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("несостоявшееся обновление не превращается в бесконечный повтор", async () => {
    const fetch = vi.fn(async () => refusal("unauthorized"));
    const refreshAccess = vi.fn(async () => false);
    const api = createFamilyApi({
      baseUrl: BASE,
      accessToken: () => "stale",
      fetch: fetch as unknown as typeof globalThis.fetch,
      refreshAccess,
    });

    await expect(api.membership()).rejects.toMatchObject({ code: "unauthorized" });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("отзыв устройства обновлением не лечится", async () => {
    const fetch = vi.fn(async () => {
      return new Response(JSON.stringify({ error: { code: "device_revoked" } }), {
        status: 403,
        headers: { "content-type": "application/json" },
      });
    });
    const refreshAccess = vi.fn(async () => true);
    const api = createFamilyApi({
      baseUrl: BASE,
      accessToken: () => "live",
      fetch: fetch as unknown as typeof globalThis.fetch,
      refreshAccess,
    });

    await expect(api.membership()).rejects.toMatchObject({ code: "device_revoked" });
    expect(refreshAccess).not.toHaveBeenCalled();
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("сам запрос обновления не аутентифицирован и потому не рекурсивен", async () => {
    const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      expect((init?.headers as Record<string, string> | undefined)?.authorization).toBeUndefined();
      expect(String(input)).toBe(`${BASE}/v1/auth/refresh`);
      return refusal("unauthorized");
    });
    const refreshAccess = vi.fn(async () => true);
    const api = createFamilyApi({
      baseUrl: BASE,
      accessToken: () => "stale",
      fetch: fetch as unknown as typeof globalThis.fetch,
      refreshAccess,
    });

    await expect(api.refresh("token")).rejects.toBeInstanceOf(FamilyApiError);
    expect(refreshAccess).not.toHaveBeenCalled();
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});

describe("обновление доступа в журнале", () => {
  function stubTransport(behaviour: () => Promise<unknown>): SyncTransport {
    return {
      submit: behaviour as never,
      fetch: behaviour as never,
      keys: behaviour as never,
    };
  }

  it("отправка конвертов переживает истёкший доступ", async () => {
    let live = false;
    const inner = stubTransport(async () => {
      if (!live) throw new SyncServerError(401, "unauthorized");
      return { keyEpoch: 1, accepted: [] };
    });
    const refreshAccess = vi.fn(async () => {
      live = true;
      return true;
    });

    const transport = transportWithTokenRefresh(inner, refreshAccess);
    await expect(transport.submit("family", [])).resolves.toMatchObject({ keyEpoch: 1 });
    expect(refreshAccess).toHaveBeenCalledTimes(1);
  });

  it("повтор один: второй отказ доходит до вызывающего как отказ", async () => {
    const inner = stubTransport(async () => {
      throw new SyncServerError(401, "unauthorized");
    });
    const refreshAccess = vi.fn(async () => true);
    const transport = transportWithTokenRefresh(inner, refreshAccess);

    await expect(transport.fetch("family", { keyEpoch: 1, after: 0, limit: 10 })).rejects.toMatchObject({
      serverCode: "unauthorized",
    });
    expect(refreshAccess).toHaveBeenCalledTimes(1);
  });

  it("отказ не про доступ обновление не трогает", async () => {
    const inner = stubTransport(async () => {
      throw new SyncServerError(409, "epoch_mismatch", { keyEpoch: 2 });
    });
    const refreshAccess = vi.fn(async () => true);
    const transport = transportWithTokenRefresh(inner, refreshAccess);

    await expect(transport.keys("family")).rejects.toMatchObject({ serverCode: "epoch_mismatch" });
    expect(refreshAccess).not.toHaveBeenCalled();
  });
});
