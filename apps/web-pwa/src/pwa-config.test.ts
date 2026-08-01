import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import {
  HTTP_CSP,
  META_CSP,
  PWA_BUILD_ID,
  PWA_MANIFEST,
  SECURITY_HEADERS,
  resolvePwaBuildId,
} from "../vite.config";

const configSource = readFileSync(new URL("../vite.config.ts", import.meta.url), "utf8");

describe("PWA production configuration", () => {
  it("defines a standalone, route-safe manifest without a portrait lock", () => {
    expect(PWA_MANIFEST).toMatchObject({
      id: "/",
      start_url: "/",
      scope: "/",
      display: "standalone",
    });
    expect(PWA_MANIFEST).not.toHaveProperty("orientation");
    expect(PWA_MANIFEST.icons).toEqual([
      expect.objectContaining({ src: "/icon-192.png", sizes: "192x192", purpose: "any" }),
      expect.objectContaining({
        src: "/icon-512.png",
        sizes: "512x512",
        purpose: "any maskable",
      }),
    ]);
    expect(configSource).toContain('navigateFallback: "index.html"');
  });

  it("uses one icon discovery path and keeps development service workers disabled", () => {
    expect(configSource).not.toContain("includeAssets:");
    expect(configSource).toContain(
      'globIgnores: ["**/icon-192.png", "**/icon-512.png"]',
    );
    expect(configSource).toContain("enabled: false");
    expect(configSource).toContain("sourcemap: false");
  });

  it("stamps a validated, non-secret build id into build metadata and the SW revision", () => {
    expect(PWA_BUILD_ID).toBe(resolvePwaBuildId(process.env.PWA_BUILD_ID));
    expect(resolvePwaBuildId("release-2026.07.24_A")).toBe("release-2026.07.24_A");
    for (const invalid of [
      "",
      "../release",
      "contains space",
      "secret-release",
      "token_123",
      "x".repeat(65),
    ]) {
      expect(() => resolvePwaBuildId(invalid)).toThrow(/PWA_BUILD_ID/u);
    }
    expect(configSource).toContain('fileName: "build-meta.json"');
    expect(configSource).toContain("revision: PWA_BUILD_ID");
  });

  it("serves exact hardening headers from Vite preview as well as deploy config", () => {
    expect(META_CSP).not.toContain("frame-ancestors");
    expect(HTTP_CSP).toBe(`${META_CSP}; frame-ancestors 'none'`);
    expect(SECURITY_HEADERS).toMatchObject({
      "Content-Security-Policy": HTTP_CSP,
      "X-Frame-Options": "DENY",
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "no-referrer",
    });
    expect(configSource).toContain("headers: SECURITY_HEADERS");
  });
});

describe("service worker registration coverage", () => {
  const appSource = readFileSync(new URL("./App.tsx", import.meta.url), "utf8");

  it("registers the service worker on every route, including first-run onboarding", () => {
    const routeGuards = appSource
      .split("\n")
      .filter((line) => /^\s{2}if \((?:loadState === |!budget \|\|).*\) return </u.test(line));

    expect(routeGuards).toHaveLength(4);
    for (const guard of routeGuards) {
      expect(guard).toContain("<UpdatePrompt");
    }
    expect(appSource).toContain('hasUnsavedChanges={operationDraftDirty || planningDraftDirty}');
  });
});
