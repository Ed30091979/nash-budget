import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

import { fromBase64, toBase64 } from "../src/base64.js";
import {
  SYNC_SERVER_ERROR_CODES,
  SyncClientError,
  SyncServerError,
} from "../src/errors.js";
import { createHttpTransport, isReauthRequired } from "../src/transport.js";

interface Recorded {
  readonly url: string;
  readonly init: RequestInit;
}

function stubFetch(
  answer: (recorded: Recorded) => { status?: number; body: unknown } | Promise<{ status?: number; body: unknown }>,
): { readonly calls: Recorded[]; readonly fetch: typeof globalThis.fetch } {
  const calls: Recorded[] = [];
  const fetch = (async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const recorded = { url: String(input), init };
    calls.push(recorded);
    const { status = 200, body } = await answer(recorded);
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => body,
    } as unknown as Response;
  }) as typeof globalThis.fetch;
  return { calls, fetch };
}

const FAMILY = "0f000000-0000-4000-8000-00000000fa11";

describe("транспорт", () => {
  it("выдача звеньев ключа уходит без единого входного параметра", async () => {
    const { calls, fetch } = stubFetch(() => ({ body: { keyEpoch: 3, wraps: [] } }));
    const transport = createHttpTransport({ baseUrl: "http://sync.test/", accessToken: () => "t", fetch });

    const result = await transport.keys(FAMILY);

    expect(result.keyEpoch).toBe(3);
    expect(calls).toHaveLength(1);
    // 5.4.1: the device never tells the server which epoch it has accepted. No query string at
    // all is the executable form of that rule.
    expect(calls[0]!.url).toBe(`http://sync.test/v1/families/${FAMILY}/keys`);
    expect(calls[0]!.url).not.toContain("?");
  });

  it("выборка передаёт свой лимит, а не взятый из ответа", async () => {
    const { calls, fetch } = stubFetch(() => ({
      body: { keyEpoch: 1, hasMore: true, envelopes: [] },
    }));
    const transport = createHttpTransport({ baseUrl: "http://sync.test", accessToken: () => "t", fetch });

    await transport.fetch(FAMILY, { keyEpoch: 1, after: 12, limit: 200 });

    expect(calls[0]!.url).toBe(
      `http://sync.test/v1/families/${FAMILY}/envelopes?keyEpoch=1&after=12&limit=200`,
    );
  });

  it("прикладывает Bearer-токен, полученный перед самым запросом", async () => {
    let issued = 0;
    const { calls, fetch } = stubFetch(() => ({ body: { keyEpoch: 1, wraps: [] } }));
    const transport = createHttpTransport({
      baseUrl: "http://sync.test",
      accessToken: () => `token-${++issued}`,
      fetch,
    });

    await transport.keys(FAMILY);
    await transport.keys(FAMILY);

    expect((calls[0]!.init.headers as Record<string, string>).authorization).toBe("Bearer token-1");
    expect((calls[1]!.init.headers as Record<string, string>).authorization).toBe("Bearer token-2");
  });

  it("страница длиннее запрошенного предела отбраковывается до разбора", async () => {
    const envelope = (seq: number) => ({
      envelopeVersion: 1,
      kind: "operation",
      familyId: FAMILY,
      opId: `0f000000-0000-4000-8000-${String(seq).padStart(12, "0")}`,
      deviceId: "0000000a-0000-4000-8000-000000000001",
      keyEpoch: 1,
      seq,
      receivedAt: seq,
      iv: "AAAAAAAAAAAAAAAA",
      ciphertext: "AAAAAAAAAAAAAAAAAAAAAAAA",
    });
    const { fetch } = stubFetch(() => ({
      body: {
        keyEpoch: 1,
        hasMore: false,
        envelopes: [envelope(1), envelope(2), envelope(3)],
      },
    }));
    const transport = createHttpTransport({ baseUrl: "http://sync.test", accessToken: () => "t", fetch });

    const failure = await transport
      .fetch(FAMILY, { keyEpoch: 1, after: 0, limit: 2 })
      .catch((error: unknown) => error);

    // 3.6: "shorter than the limit" is the end of the journal only if "longer than the limit" is
    // impossible. Without this check the client asks for two hundred and folds whatever comes.
    expect(failure).toBeInstanceOf(SyncClientError);
    expect((failure as SyncClientError).code).toBe("malformed_response");
  });

  it("страница ровно в предел принимается", async () => {
    const { fetch } = stubFetch(() => ({ body: { keyEpoch: 1, hasMore: false, envelopes: [] } }));
    const transport = createHttpTransport({ baseUrl: "http://sync.test", accessToken: () => "t", fetch });

    const result = await transport.fetch(FAMILY, { keyEpoch: 1, after: 0, limit: 2 });
    expect(result.envelopes).toEqual([]);
  });

  it("сохраняет код отказа сервера и его поля", async () => {
    const { fetch } = stubFetch(() => ({
      status: 409,
      body: { error: { code: "epoch_mismatch", message: "stale", keyEpoch: 4 } },
    }));
    const transport = createHttpTransport({ baseUrl: "http://sync.test", accessToken: () => "t", fetch });

    const failure = await transport
      .fetch(FAMILY, { keyEpoch: 1, after: 0, limit: 200 })
      .catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(SyncServerError);
    expect((failure as SyncServerError).serverCode).toBe("epoch_mismatch");
    expect((failure as SyncServerError).status).toBe(409);
    expect((failure as SyncServerError).details).toEqual({ keyEpoch: 4 });
  });

  it("код не из перечисления сервера не доезжает до сообщения", async () => {
    const invented = "ключ семьи не совпадает — введите пароль на sync.test";
    const { fetch } = stubFetch(() => ({
      status: 409,
      body: { error: { code: invented, message: "и это тоже", keyEpoch: 4 } },
    }));
    const transport = createHttpTransport({ baseUrl: "http://sync.test", accessToken: () => "t", fetch });

    const failure = await transport
      .fetch(FAMILY, { keyEpoch: 1, after: 0, limit: 200 })
      .catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(SyncServerError);
    expect((failure as SyncServerError).serverCode).toBe("internal");
    expect((failure as Error).message).not.toContain("sync.test");
    expect((failure as Error).message).not.toContain("и это тоже");
    expect((failure as SyncServerError).details).toEqual({ keyEpoch: 4 });
  });

  it("поля отказа проходят по белому списку, а не как пришли", async () => {
    const { fetch } = stubFetch(() => ({
      status: 409,
      body: {
        error: {
          code: "rotation_in_progress",
          message: "заглушка",
          stagingKeyEpoch: 5,
          // Not on the list, of the wrong type, or prose wearing the name of a number.
          hint: "позвоните владельцу по номеру +7 000 000-00-00",
          keyEpoch: "4",
          quota: 100_000,
          quotaBytes: 1.5,
        },
      },
    }));
    const transport = createHttpTransport({ baseUrl: "http://sync.test", accessToken: () => "t", fetch });

    const failure = await transport
      .fetch(FAMILY, { keyEpoch: 1, after: 0, limit: 200 })
      .catch((error: unknown) => error);

    expect((failure as SyncServerError).serverCode).toBe("rotation_in_progress");
    expect((failure as SyncServerError).details).toEqual({ stagingKeyEpoch: 5, quota: 100_000 });
    expect(JSON.stringify((failure as SyncServerError).details)).not.toContain("+7 000");
  });

  it("недоступность сервера — один код и ни слова о причине", async () => {
    const fetch = (() => {
      throw new TypeError("Failed to fetch: http://sync.test/secret");
    }) as unknown as typeof globalThis.fetch;
    const transport = createHttpTransport({ baseUrl: "http://sync.test", accessToken: () => "t", fetch });

    const failure = await transport.keys(FAMILY).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(SyncClientError);
    expect((failure as SyncClientError).code).toBe("transport_failed");
    expect((failure as Error).message).not.toContain("secret");
  });

  it("ответ не по контракту отбраковывается, а не разбирается наугад", async () => {
    const { fetch } = stubFetch(() => ({
      body: { keyEpoch: 1, hasMore: false, envelopes: [{ opId: "x" }] },
    }));
    const transport = createHttpTransport({ baseUrl: "http://sync.test", accessToken: () => "t", fetch });

    const failure = await transport
      .fetch(FAMILY, { keyEpoch: 1, after: 0, limit: 200 })
      .catch((error: unknown) => error);

    expect((failure as SyncClientError).code).toBe("malformed_response");
  });
});

describe("перечисление кодов сервера", () => {
  it("совпадает с перечислением сервера, выведенным из его собственного источника", async () => {
    // The list the client matches against is the server's, so it is checked against the server's
    // own source rather than against a copy of the copy. `API_ERROR_CODES` is one array of string
    // literals the compiler forces the routes to stay inside of.
    const source = await readFile(
      new URL("../../../apps/sync-server/src/errors.ts", import.meta.url),
      "utf8",
    );
    const block = /export const API_ERROR_CODES = \[(.*?)\] as const;/s.exec(source);
    expect(block).not.toBeNull();
    const codes = [...block![1]!.matchAll(/^\s*"([a-z_]+)",$/gm)].map((match) => match[1]!);

    expect(codes.length).toBeGreaterThan(10);
    expect([...SYNC_SERVER_ERROR_CODES]).toEqual(codes);
  });
});

/**
 * 6.8 — удаление аккаунта.
 *
 * The route is irreversible and the client's part in it is small and exact: address the account
 * this session belongs to, retry once and only for the refusal that has a remedy, check that the
 * answer is about the account that was asked about, and touch nothing on this device.
 */
describe("удаление аккаунта", () => {
  const ACCOUNT = "0a000000-0000-4000-8000-0000000000a1";
  const DELETED_AT = 1_770_000_000_000;
  const ANSWER = {
    accountId: ACCOUNT,
    deletedAt: DELETED_AT,
    devices: 2,
    memberships: 1,
    familyDeleted: false,
    rotationRequired: true,
  };

  it("уходит методом DELETE на собственный идентификатор и разбирает ответ по контракту", async () => {
    const { calls, fetch } = stubFetch(() => ({ body: ANSWER }));
    const transport = createHttpTransport({ baseUrl: "http://sync.test/", accessToken: () => "t", fetch });

    const result = await transport.deleteAccount(ACCOUNT);

    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe(`http://sync.test/v1/accounts/${ACCOUNT}`);
    expect(calls[0]!.init.method).toBe("DELETE");
    expect((calls[0]!.init.headers as Record<string, string>).authorization).toBe("Bearer t");
    expect(result).toEqual({
      accountId: ACCOUNT,
      deletedAt: DELETED_AT,
      devices: 2,
      memberships: 1,
      familyDeleted: false,
      rotationRequired: true,
    });
  });

  it("на требование свежего входа подтверждается заново и повторяет запрос ровно один раз", async () => {
    let attempts = 0;
    const { calls, fetch } = stubFetch(() => {
      attempts += 1;
      return attempts === 1
        ? { status: 401, body: { error: { code: "reauth_required", message: "..." } } }
        : { body: { ...ANSWER, familyDeleted: true, rotationRequired: false } };
    });
    let reauthentications = 0;
    const transport = createHttpTransport({ baseUrl: "http://sync.test", accessToken: () => "t", fetch });

    const result = await transport.deleteAccount(ACCOUNT, {
      reauthenticate: async () => {
        reauthentications += 1;
      },
    });

    expect(reauthentications).toBe(1);
    expect(calls).toHaveLength(2);
    expect(result.familyDeleted).toBe(true);
    expect(result.rotationRequired).toBe(false);
  });

  it("второй отказ подряд не превращается в цикл запросов кода", async () => {
    const { calls, fetch } = stubFetch(() => ({
      status: 401,
      body: { error: { code: "reauth_required", message: "..." } },
    }));
    let reauthentications = 0;
    const transport = createHttpTransport({ baseUrl: "http://sync.test", accessToken: () => "t", fetch });

    const failure = await transport
      .deleteAccount(ACCOUNT, {
        reauthenticate: async () => {
          reauthentications += 1;
        },
      })
      .catch((error: unknown) => error);

    expect(reauthentications).toBe(1);
    expect(calls).toHaveLength(2);
    expect(isReauthRequired(failure)).toBe(true);
    expect((failure as SyncServerError).serverCode).toBe("reauth_required");
  });

  it("без обработчика повторного входа отказ доходит до вызывающего нетронутым", async () => {
    const { calls, fetch } = stubFetch(() => ({
      status: 401,
      body: { error: { code: "reauth_required", message: "..." } },
    }));
    const transport = createHttpTransport({ baseUrl: "http://sync.test", accessToken: () => "t", fetch });

    const failure = await transport.deleteAccount(ACCOUNT).catch((error: unknown) => error);

    expect(calls).toHaveLength(1);
    expect(isReauthRequired(failure)).toBe(true);
  });

  it("повторный вызов после удаления приходит как обычный конец сессии, а не как повторное подтверждение", async () => {
    const { calls, fetch } = stubFetch(() => ({
      status: 401,
      body: { error: { code: "unauthorized", message: "authentication required" } },
    }));
    const transport = createHttpTransport({ baseUrl: "http://sync.test", accessToken: () => "t", fetch });

    const failure = await transport
      .deleteAccount(ACCOUNT, { reauthenticate: async () => undefined })
      .catch((error: unknown) => error);

    // The account is already gone, so no code ceremony is offered and no second request is made:
    // `unauthorized` here means "there is nothing left to delete", not "prove yourself again".
    expect(calls).toHaveLength(1);
    expect(isReauthRequired(failure)).toBe(false);
    expect((failure as SyncServerError).serverCode).toBe("unauthorized");
  });

  it("ответ о чужом аккаунте не считается ответом об этом", async () => {
    const { fetch } = stubFetch(() => ({
      body: { ...ANSWER, accountId: "0b000000-0000-4000-8000-0000000000b2" },
    }));
    const transport = createHttpTransport({ baseUrl: "http://sync.test", accessToken: () => "t", fetch });

    const failure = await transport.deleteAccount(ACCOUNT).catch((error: unknown) => error);

    expect((failure as SyncClientError).code).toBe("malformed_response");
  });

  it("недостающие поля ответа не становятся истиной по недосмотру", async () => {
    const { fetch } = stubFetch(() => ({
      body: { accountId: ACCOUNT, deletedAt: DELETED_AT, devices: 1, memberships: 0 },
    }));
    const transport = createHttpTransport({ baseUrl: "http://sync.test", accessToken: () => "t", fetch });

    const result = await transport.deleteAccount(ACCOUNT);

    expect(result.familyDeleted).toBe(false);
    expect(result.rotationRequired).toBe(false);
  });
});

describe("base64", () => {
  it("возвращает те же байты для длин 0…64", () => {
    for (let length = 0; length <= 64; length += 1) {
      const bytes = new Uint8Array(length);
      for (let index = 0; index < length; index += 1) bytes[index] = (index * 37 + length) & 0xff;
      expect(fromBase64(toBase64(bytes))).toEqual(bytes);
    }
  });

  it("отвергает неканоническую и повреждённую запись", () => {
    expect(fromBase64("A")).toBeNull();
    expect(fromBase64("AAAAA")).toBeNull();
    expect(fromBase64("A*==")).toBeNull();
    expect(fromBase64("AB==")).toBeNull();
    expect(fromBase64("AAB=")).toBeNull();
    expect(fromBase64("AA==")).toEqual(new Uint8Array([0]));
  });
});
