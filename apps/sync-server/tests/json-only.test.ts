/**
 * 1.1 — the sync server hands out no HTML and no JavaScript under any configuration.
 *
 * The document makes this a requirement on the code rather than on the deployment, and says why in
 * one sentence: a sync server able to return one script becomes, when compromised, a compromised
 * client, and the end-to-end encryption is worth nothing. So the checks below are deliberately not
 * "the routes we wrote answer JSON" — they walk the application's own route table, so a route
 * added later cannot quietly escape them, and they include the case that does not exist yet: a
 * handler that tries to answer with a page.
 */
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, test } from "vitest";

import { resolveConfig } from "../src/config.ts";
import { call, createHarness, uuid, type Harness } from "./support.ts";

let harness: Harness | undefined;

afterEach(async () => {
  await harness?.close();
  harness = undefined;
});

const SOURCE_DIR = fileURLToPath(new URL("../src/", import.meta.url));

function sourceFiles(): { path: string; text: string }[] {
  const files: { path: string; text: string }[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = `${dir}${entry.name}`;
      if (entry.isDirectory()) walk(`${path}/`);
      else if (entry.name.endsWith(".ts")) files.push({ path, text: readFileSync(path, "utf8") });
    }
  };
  walk(SOURCE_DIR);
  return files;
}

test("GET / is 404 and the answer is JSON, not a page", async () => {
  harness = createHarness();
  const response = await call(harness, "GET", "/");
  expect(response.statusCode).toBe(404);
  expect(String(response.headers["content-type"])).toMatch(/^application\/json/);
  expect(response.json().error.code).toBe("not_found");
  expect(response.body).not.toContain("<");
});

test("every registered route answers application/json and nothing else", async () => {
  harness = createHarness();
  await harness.server.app.ready();
  const routes = harness.server.routes.filter((route) => route.method !== "HEAD");
  // The table is not empty and is the application's own, so a new route joins this test by itself.
  expect(routes.length).toBeGreaterThan(15);
  for (const route of routes) {
    const url = route.url.replaceAll(/:[A-Za-z]+/g, uuid()).replace("/*", "/anything");
    const method = route.method as "GET" | "POST" | "DELETE" | "OPTIONS";
    // No token and no body: every one of these fails, which is the interesting case — refusals are
    // where a framework is most tempted to answer with its own HTML error page.
    const response = await call(harness, method, url, { payload: method === "GET" ? undefined : {} });
    const contentType = response.headers["content-type"];
    if (response.body === "") {
      expect(contentType, `${route.method} ${route.url}`).toBeUndefined();
      continue;
    }
    expect(String(contentType), `${route.method} ${route.url}`).toMatch(/^application\/json/);
    expect(() => response.json(), `${route.method} ${route.url}`).not.toThrow();
  }
});

test("a handler that answers HTML is turned into a JSON refusal", async () => {
  harness = createHarness();
  // There is no such handler in this build. The point is that adding one is a visible failure
  // rather than a quiet erosion of the boundary the whole scheme rests on.
  harness.server.app.get("/rogue", async (_request, reply) => {
    return reply.type("text/html").send("<script>stealTheFamilyKey()</script>");
  });
  const response = await call(harness, "GET", "/rogue");
  expect(response.statusCode).toBe(500);
  expect(String(response.headers["content-type"])).toMatch(/^application\/json/);
  expect(response.json().error.code).toBe("non_json_response");
  expect(response.body).not.toContain("<script>");
});

/**
 * The origin the Capacitor shell calls from, measured on the emulator in phase S9.
 *
 * `androidScheme` defaults to `https`, so the WebView runs the packaged page at `https://localhost`
 * and sends that as its `Origin` — with a preflight first, because the transport carries
 * `authorization` and `content-type`. It is a browser and CORS applies to it in full. The comment
 * these tests replace claimed the shell "has no origin", which would have made an empty allowlist
 * a working production configuration for Android; it is not one.
 */
const ANDROID_SHELL_ORIGIN = "https://localhost";

describe("the CORS allowlist is explicit", () => {
  test('"*" is refused at construction, not checked at request time', () => {
    expect(() =>
      resolveConfig({ allowedOrigins: ["*"], deliverLoginCode: () => undefined }),
    ).toThrow(/may not contain/);
    expect(() =>
      resolveConfig({ allowedOrigins: ["not-an-origin"], deliverLoginCode: () => undefined }),
    ).toThrow(/not an origin/);
  });

  test("an empty allowlist is legitimate and permits no client — the Android shell included", async () => {
    harness = createHarness({ allowedOrigins: [] });
    for (const origin of ["https://app.example.test", ANDROID_SHELL_ORIGIN]) {
      const preflight = await call(harness, "OPTIONS", "/v1/auth/code", {
        headers: { origin, "access-control-request-method": "POST" },
      });
      expect(preflight.statusCode, origin).toBe(204);
      expect(preflight.headers["access-control-allow-origin"], origin).toBeUndefined();
      expect(preflight.headers["access-control-allow-methods"], origin).toBeUndefined();
      expect(preflight.headers["access-control-allow-headers"], origin).toBeUndefined();

      // The request itself is answered — CORS is enforced in the browser, not here — but the
      // answer carries no permission to read it, so the WebView discards it. That is exactly what
      // an Android build against an empty allowlist sees: every call fails.
      const requested = await call(harness, "POST", "/v1/auth/code", {
        headers: { origin },
        payload: { email: `someone-${uuid()}@example.test` },
      });
      expect(requested.statusCode, origin).toBe(202);
      expect(requested.headers["access-control-allow-origin"], origin).toBeUndefined();
    }
  });

  test("the Android shell's origin, once listed, passes both the preflight and the request", async () => {
    harness = createHarness({ allowedOrigins: [ANDROID_SHELL_ORIGIN] });
    const preflight = await call(harness, "OPTIONS", "/v1/auth/code", {
      headers: {
        origin: ANDROID_SHELL_ORIGIN,
        "access-control-request-method": "POST",
        "access-control-request-headers": "authorization, content-type",
      },
    });
    expect(preflight.statusCode).toBe(204);
    expect(preflight.headers["access-control-allow-origin"]).toBe("https://localhost");
    expect(preflight.headers["vary"]).toBe("Origin");
    const methods = String(preflight.headers["access-control-allow-methods"]);
    expect(methods).toContain("POST");
    expect(methods).toContain("GET");
    expect(methods).toContain("DELETE");
    const headers = String(preflight.headers["access-control-allow-headers"]);
    expect(headers).toContain("authorization");
    expect(headers).toContain("content-type");
    expect(preflight.headers["access-control-max-age"]).toBe("600");

    const requested = await call(harness, "POST", "/v1/auth/code", {
      headers: { origin: ANDROID_SHELL_ORIGIN },
      payload: { email: `shell-${uuid()}@example.test` },
    });
    expect(requested.statusCode).toBe(202);
    expect(requested.headers["access-control-allow-origin"]).toBe("https://localhost");
    expect(requested.headers["vary"]).toBe("Origin");
    // A second origin is not admitted by the first one being listed.
    const other = await call(harness, "POST", "/v1/auth/code", {
      headers: { origin: "https://evil.example.test" },
      payload: { email: `other-${uuid()}@example.test` },
    });
    expect(other.headers["access-control-allow-origin"]).toBeUndefined();
  });

  test("an unlisted origin is named in the log, once, and changes nothing in the answer", async () => {
    harness = createHarness({ allowedOrigins: ["https://app.example.test"] });
    const withOrigin = await call(harness, "POST", "/v1/auth/code", {
      headers: { origin: ANDROID_SHELL_ORIGIN },
      payload: { email: "diagnosed@example.test" },
    });
    // Said in the log — the only place a CORS misconfiguration is visible from the server side.
    const log = harness.logLines.join("\n");
    expect(log).toContain(ANDROID_SHELL_ORIGIN);
    expect(log).toContain("SYNC_ALLOWED_ORIGINS");

    // And said nowhere else: the answer to an unlisted origin is the answer to no origin at all.
    const withoutOrigin = await call(harness, "POST", "/v1/auth/code", {
      payload: { email: "diagnosed@example.test" },
    });
    expect(withOrigin.statusCode).toBe(withoutOrigin.statusCode);
    expect(withOrigin.body).toBe(withoutOrigin.body);
    expect(Object.keys(withOrigin.headers).filter((name) => name.startsWith("access-control"))).toEqual([]);

    // Once per origin: the header is attacker-controlled on an unauthenticated route, so repeating
    // the request may not repeat the line.
    const before = harness.logLines.filter((line) => line.includes(ANDROID_SHELL_ORIGIN)).length;
    expect(before).toBe(1);
    for (let i = 0; i < 3; i += 1) {
      await call(harness, "GET", "/v1/families/me", { headers: { origin: ANDROID_SHELL_ORIGIN } });
    }
    expect(harness.logLines.filter((line) => line.includes(ANDROID_SHELL_ORIGIN)).length).toBe(1);
  });

  test("a listed origin is echoed by name and an unlisted one gets nothing", async () => {
    harness = createHarness({ allowedOrigins: ["https://app.example.test"] });
    const allowed = await call(harness, "GET", "/v1/families/me", {
      headers: { origin: "https://app.example.test" },
    });
    expect(allowed.headers["access-control-allow-origin"]).toBe("https://app.example.test");
    expect(allowed.headers["vary"]).toBe("Origin");
    const refused = await call(harness, "GET", "/v1/families/me", {
      headers: { origin: "https://evil.example.test" },
    });
    expect(refused.headers["access-control-allow-origin"]).toBeUndefined();
  });

  test("no response ever carries a wildcard origin", async () => {
    harness = createHarness({ allowedOrigins: ["https://app.example.test"] });
    await harness.server.app.ready();
    for (const route of harness.server.routes.filter((r) => r.method !== "HEAD")) {
      const url = route.url.replaceAll(/:[A-Za-z]+/g, uuid()).replace("/*", "/anything");
      const response = await call(harness, route.method as "GET", url, {
        headers: { origin: "https://evil.example.test" },
        payload: route.method === "GET" ? undefined : {},
      });
      expect(response.headers["access-control-allow-origin"], route.url).not.toBe("*");
    }
  });
});

test("no source file serves a file, a page or a script", () => {
  const manifest = JSON.parse(readFileSync(fileURLToPath(new URL("../package.json", import.meta.url)), "utf8"));
  const dependencies = { ...manifest.dependencies, ...manifest.devDependencies } as Record<string, string>;
  for (const name of Object.keys(dependencies)) {
    expect(name).not.toMatch(/static|view|serve|html/i);
  }
  for (const file of sourceFiles()) {
    // `text/html` appears nowhere, and neither does any way of putting a file on the wire.
    expect(file.text, file.path).not.toMatch(/text\/html|application\/javascript|sendFile|fastify-static|@fastify\/view/);
  }
});
