import { describe, expect, it } from "vitest";

import { fromBase64, toBase64 } from "../src/base64.js";
import { SyncClientError, SyncServerError } from "../src/errors.js";
import { createHttpTransport } from "../src/transport.js";

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
