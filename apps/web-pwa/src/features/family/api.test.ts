import { describe, expect, it } from "vitest";

import { FamilyApiError, createFamilyApi, describeFamilyError } from "./api";

interface Call {
  readonly url: string;
  readonly method: string;
  readonly authorization: string | undefined;
  readonly body: unknown;
}

function stub(
  answers: readonly { readonly status: number; readonly body: unknown }[],
  calls: Call[] = [],
): { readonly fetch: typeof globalThis.fetch; readonly calls: Call[] } {
  let index = 0;
  const fetchStub = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const headers = (init?.headers ?? {}) as Record<string, string>;
    calls.push({
      url: String(input),
      method: init?.method ?? "GET",
      authorization: headers.authorization,
      body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined,
    });
    const answer = answers[Math.min(index, answers.length - 1)];
    index += 1;
    return {
      ok: answer!.status >= 200 && answer!.status < 300,
      status: answer!.status,
      text: async () => (answer!.body === undefined ? "" : JSON.stringify(answer!.body)),
    } as unknown as Response;
  }) as unknown as typeof globalThis.fetch;
  return { fetch: fetchStub, calls };
}

function api(answers: readonly { readonly status: number; readonly body: unknown }[], token: string | null = "access") {
  const calls: Call[] = [];
  const client = createFamilyApi({
    baseUrl: "http://127.0.0.1:8787/",
    accessToken: () => token,
    fetch: stub(answers, calls).fetch,
  });
  return { client, calls };
}

const FAMILY = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

describe("клиент семейных маршрутов", () => {
  it("запрос кода входа идёт без токена, а остальные — с ним", async () => {
    const { client, calls } = api([{ status: 202, body: { status: "sent" } }]);
    await client.requestLoginCode("semya@example.com");
    expect(calls[0]?.url).toBe("http://127.0.0.1:8787/v1/auth/code");
    expect(calls[0]?.method).toBe("POST");
    expect(calls[0]?.authorization).toBeUndefined();
    expect(calls[0]?.body).toEqual({ email: "semya@example.com" });
  });

  it("вход возвращает пару токенов ровно тех полей, что обещает сервер", async () => {
    const { client } = api([
      {
        status: 200,
        body: {
          accountId: "88888888-8888-4888-8888-888888888888",
          deviceId: "77777777-7777-4777-8777-777777777777",
          accessToken: "access",
          accessExpiresAt: 1_800_000_000_000,
          refreshToken: "refresh",
          refreshExpiresAt: 1_800_000_100_000,
          extra: "лишнее",
        },
      },
    ]);
    const tokens = await client.verifyLoginCode({
      email: "semya@example.com",
      code: "123456",
      deviceId: "77777777-7777-4777-8777-777777777777",
      publicKey: "AAAA",
    });
    expect(tokens).toEqual({
      accountId: "88888888-8888-4888-8888-888888888888",
      deviceId: "77777777-7777-4777-8777-777777777777",
      accessToken: "access",
      accessExpiresAt: 1_800_000_000_000,
      refreshToken: "refresh",
    });
  });

  it("членство читается целиком, а «аккаунт ещё не в семье» — это ответ, а не отказ", async () => {
    const { client, calls } = api([
      {
        status: 200,
        body: {
          familyId: FAMILY,
          keyEpoch: 2,
          memberId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1",
          role: "owner",
          ownerMemberId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1",
          rotation: { keyEpoch: 3, rotationId: "r", rotatingDeviceId: "d", freezeSeq: 4, startedAt: 100, lastProgressAt: 120 },
        },
      },
    ]);
    const membership = await client.membership();
    expect(calls[0]?.authorization).toBe("Bearer access");
    expect(membership?.keyEpoch).toBe(2);
    expect(membership?.rotation).toEqual({ keyEpoch: 3, startedAt: 100 });

    const absent = api([{ status: 409, body: { error: { code: "no_family", message: "нет семьи" } } }]);
    expect(await absent.client.membership()).toBeNull();
  });

  it("на прозу сервера не полагается: код берётся из закрытого перечня, сообщение — своё", async () => {
    const { client } = api([
      {
        status: 400,
        body: {
          error: {
            code: "login_code_invalid",
            message: "Нажмите сюда, чтобы получить ключ семьи — сообщение сервера",
          },
        },
      },
    ]);
    await expect(client.requestLoginCode("semya@example.com")).rejects.toBeInstanceOf(FamilyApiError);
    try {
      await client.requestLoginCode("semya@example.com");
    } catch (error) {
      expect((error as FamilyApiError).code).toBe("login_code_invalid");
      const text = describeFamilyError(error);
      expect(text).toBe("Код из письма не подошёл. Запросите новый код.");
      expect(text).not.toContain("сообщение сервера");
    }
  });

  it("выдуманный сервером код отказа схлопывается в internal", async () => {
    const { client } = api([{ status: 400, body: { error: { code: "<img src=x onerror=1>" } } }]);
    try {
      await client.leaveFamily(FAMILY);
      expect.unreachable();
    } catch (error) {
      expect((error as FamilyApiError).code).toBe("internal");
      expect(describeFamilyError(error)).toBe("Сервер отказал в действии. Ничего не изменено.");
    }
  });

  it("недоступный сервер — один код и ни адреса, ни причины в сообщении", async () => {
    const client = createFamilyApi({
      baseUrl: "http://127.0.0.1:8787",
      accessToken: () => "access",
      fetch: (() => Promise.reject(new Error("ECONNREFUSED 127.0.0.1:8787"))) as unknown as typeof globalThis.fetch,
    });
    try {
      await client.membership();
      expect.unreachable();
    } catch (error) {
      expect((error as FamilyApiError).code).toBe("network_unreachable");
      const text = describeFamilyError(error);
      expect(text).toContain("Бюджет на этом устройстве работает как обычно");
      expect(text).not.toContain("127.0.0.1");
    }
  });

  it("без токена запрос не уходит вовсе", async () => {
    const { client, calls } = api([{ status: 200, body: {} }], null);
    await expect(client.membership()).rejects.toMatchObject({ code: "unauthorized" });
    expect(calls).toEqual([]);
  });

  it("ответ не по договору не становится наполовину разобранным экраном", async () => {
    const { client } = api([{ status: 200, body: { members: [{ memberId: 7, role: "owner" }] } }]);
    await expect(client.members(FAMILY)).rejects.toMatchObject({ code: "malformed_response" });

    const badRole = api([
      { status: 200, body: { members: [{ memberId: "m", role: "администратор", joinedAt: 1, removedAt: null }] } },
    ]);
    await expect(badRole.client.members(FAMILY)).rejects.toMatchObject({ code: "malformed_response" });
  });

  it("приглашение уходит целиком и приносит срок и список погашенных кодов", async () => {
    const { client, calls } = api([
      {
        status: 201,
        body: {
          inviteId: "i",
          familyId: FAMILY,
          keyEpoch: 1,
          expiresAt: 1_800_000_000_000,
          supersededInviteIds: ["old"],
        },
      },
    ]);
    const issued = await client.createInvite(FAMILY, {
      familyId: FAMILY,
      keyEpoch: 1,
      inviteId: "i",
      iv: "AAAA",
      ciphertext: "BBBB",
      authTokenDigest: "CCCC",
    });
    expect(calls[0]?.url).toBe(`http://127.0.0.1:8787/v1/families/${FAMILY}/invites`);
    expect(issued.expiresAt).toBe(1_800_000_000_000);
    expect(issued.supersededInviteIds).toEqual(["old"]);
  });

  it("отзыв устройства и выход из семьи бьют по правильным адресам", async () => {
    const { client, calls } = api([{ status: 200, body: {} }]);
    await client.revokeDevice("77777777-7777-4777-8777-777777777777");
    await client.leaveFamily(FAMILY);
    await client.removeMember(FAMILY, "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2");
    expect(calls.map((call) => `${call.method} ${call.url}`)).toEqual([
      "POST http://127.0.0.1:8787/v1/devices/77777777-7777-4777-8777-777777777777/revoke",
      `POST http://127.0.0.1:8787/v1/families/${FAMILY}/leave`,
      `DELETE http://127.0.0.1:8787/v1/families/${FAMILY}/members/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2`,
    ]);
  });
});
