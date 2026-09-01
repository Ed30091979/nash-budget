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

describe("the browser allowlist is explicit", () => {
  test('"*" is refused at construction, not checked at request time', () => {
    expect(() =>
      resolveConfig({ allowedOrigins: ["*"], deliverLoginCode: () => undefined }),
    ).toThrow(/may not contain/);
    expect(() =>
      resolveConfig({ allowedOrigins: ["not-an-origin"], deliverLoginCode: () => undefined }),
    ).toThrow(/not an origin/);
  });

  test("an empty allowlist is a legitimate configuration and allows no browser", async () => {
    harness = createHarness({ allowedOrigins: [] });
    const response = await call(harness, "GET", "/", {
      headers: { origin: "https://app.example.test" },
    });
    expect(response.headers["access-control-allow-origin"]).toBeUndefined();
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
