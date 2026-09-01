import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import {
  CONNECT_SRC_SELF,
  HTTP_CSP,
  META_CSP,
  resolveSyncServerOrigin,
  securityHeadersFor,
  withSyncServerOrigin,
} from "../vite.config";
import { resolveSyncServerUrl } from "./features/family/session";

const indexHtml = readFileSync(new URL("../index.html", import.meta.url), "utf8");
const deployHeaders = readFileSync(new URL("../public/_headers", import.meta.url), "utf8");
const securityHeaders = JSON.parse(
  readFileSync(new URL("../security-headers.json", import.meta.url), "utf8"),
) as Record<string, string>;

const metaCsp =
  "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; font-src 'self'; connect-src 'self'; worker-src 'self'; manifest-src 'self'; object-src 'none'; base-uri 'none'; form-action 'none'";
const httpCsp = `${metaCsp}; frame-ancestors 'none'`;

function readCspDirectives(): Map<string, string[]> {
  const meta = indexHtml.match(
    /<meta\s+[^>]*http-equiv=["']Content-Security-Policy["'][^>]*>/i,
  )?.[0];

  expect(meta, "index.html must define a CSP meta element").toBeDefined();

  const content = meta?.match(/content\s*=\s*"([^"]*)"/i)?.[1];
  expect(content, "the CSP meta element must have a content attribute").toBeDefined();

  const directives = new Map<string, string[]>();

  for (const directive of (content ?? "").split(";").map((value) => value.trim())) {
    if (!directive) continue;

    const [name, ...sources] = directive.split(/\s+/u);
    if (!name) throw new Error("CSP contains a directive without a name");
    directives.set(name, sources);
  }

  return directives;
}

describe("web content security policy", () => {
  it("allows only the app's static and offline runtime resources", () => {
    const directives = readCspDirectives();

    expect(Object.fromEntries(directives)).toEqual({
      "default-src": ["'none'"],
      "script-src": ["'self'"],
      "style-src": ["'self'"],
      "img-src": ["'self'", "data:"],
      "font-src": ["'self'"],
      "connect-src": ["'self'"],
      "worker-src": ["'self'"],
      "manifest-src": ["'self'"],
      "object-src": ["'none'"],
      "base-uri": ["'none'"],
      "form-action": ["'none'"],
    });
  });

  it("keeps anti-framing in exact deployable HTTP headers rather than claiming meta CSP support", () => {
    expect(securityHeaders).toEqual({
      "Content-Security-Policy": httpCsp,
      "X-Frame-Options": "DENY",
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "no-referrer",
      "Permissions-Policy":
        "camera=(), microphone=(), geolocation=(), payment=(), usb=(), bluetooth=()",
      "Cross-Origin-Opener-Policy": "same-origin",
      "Cross-Origin-Resource-Policy": "same-origin",
    });

    expect(deployHeaders).toContain("/*");
    for (const [name, value] of Object.entries(securityHeaders)) {
      expect(deployHeaders).toContain(`${name}: ${value}`);
    }

    const metaDirectives = readCspDirectives();
    expect(metaDirectives.has("frame-ancestors")).toBe(false);
    expect(securityHeaders["Content-Security-Policy"]).toContain("frame-ancestors 'none'");
  });

  it("does not permit inline/eval execution, wildcard hosts, loopback endpoints, or web sockets", () => {
    const directives = readCspDirectives();
    const sources = [...directives.values()].flat();

    expect(sources).not.toContain("'unsafe-inline'");
    expect(sources).not.toContain("'unsafe-eval'");
    expect(sources).not.toContain("*");
    expect(sources).not.toContain("http:");
    expect(sources).not.toContain("https:");
    expect(sources).not.toContain("ws:");
    expect(sources).not.toContain("wss:");
    expect(sources.some((source) => /^https?:\/\//u.test(source))).toBe(false);
    expect(sources.some((source) => /^wss?:/iu.test(source))).toBe(false);
    expect(
      sources.some((source) => /^(?:https?:\/\/|wss?:\/\/)?(?:localhost|127(?:\.\d{1,3}){3}|\[::1\])(?::|\/|$)/iu.test(source)),
    ).toBe(false);
  });
});

/**
 * Адрес сервера синхронизации в политике.
 *
 * `connect-src 'self'` отклонял каждый запрос к серверу семьи, и отклонение политикой не похоже
 * в приложении ни на что: запрос не уходит, ответа нет, сервер «недоступен». Поэтому адрес
 * попадает в политику — и только он, и только в эту директиву.
 */
describe("источник сервера семьи в политике", () => {
  it("трогает ровно одну директиву и не ослабляет остальные", () => {
    const extended = withSyncServerOrigin(META_CSP, "https://sync.example.org");
    expect(extended).toContain("connect-src 'self' https://sync.example.org");
    expect(extended.replace(" https://sync.example.org", "")).toBe(META_CSP);

    // Остальные директивы — буква в букву прежние.
    const before = new Map(META_CSP.split(";").map((entry) => entry.trim().split(/\s+/u)[0]!).map((name, index) => [name, index]));
    for (const directive of extended.split(";").map((entry) => entry.trim())) {
      const [name] = directive.split(/\s+/u);
      expect(before.has(name!)).toBe(true);
      if (name !== "connect-src") expect(META_CSP).toContain(directive);
    }
  });

  it("без настроенного адреса политика не меняется вовсе", () => {
    expect(withSyncServerOrigin(META_CSP, null)).toBe(META_CSP);
    expect(withSyncServerOrigin(HTTP_CSP, null)).toBe(HTTP_CSP);
    expect(securityHeadersFor(null)["Content-Security-Policy"]).toBe(HTTP_CSP);
  });

  it("произвольный источник в политику не попадает", () => {
    expect(resolveSyncServerOrigin({})).toBeNull();
    expect(resolveSyncServerOrigin({ VITE_SYNC_SERVER_URL: "" })).toBeNull();
    expect(resolveSyncServerOrigin({ VITE_SYNC_SERVER_URL: "*" })).toBeNull();
    expect(resolveSyncServerOrigin({ VITE_SYNC_SERVER_URL: "https://*.example.org" })).toBeNull();
    expect(resolveSyncServerOrigin({ VITE_SYNC_SERVER_URL: "https:" })).toBeNull();
    expect(resolveSyncServerOrigin({ VITE_SYNC_SERVER_URL: "javascript:alert(1)" })).toBeNull();
    expect(resolveSyncServerOrigin({ VITE_SYNC_SERVER_URL: "ws://sync.example.org" })).toBeNull();
    expect(resolveSyncServerOrigin({ VITE_SYNC_SERVER_URL: "https://user:pass@sync.example.org" })).toBeNull();
    expect(resolveSyncServerOrigin({ VITE_SYNC_SERVER_URL: 42 })).toBeNull();
  });

  it("адрес сводится к источнику: путь и запрос в политику не едут", () => {
    expect(resolveSyncServerOrigin({ VITE_SYNC_SERVER_URL: "http://127.0.0.1:8787/" })).toBe(
      "http://127.0.0.1:8787",
    );
    expect(
      resolveSyncServerOrigin({ VITE_SYNC_SERVER_URL: "https://sync.example.org/v1?x=1" }),
    ).toBe("https://sync.example.org");
  });

  it("политика и приложение читают один и тот же ключ конфигурации", () => {
    for (const value of [
      "http://127.0.0.1:8787",
      "https://sync.example.org/v1",
      "нет",
      "",
    ]) {
      const url = resolveSyncServerUrl({ VITE_SYNC_SERVER_URL: value });
      const origin = resolveSyncServerOrigin({ VITE_SYNC_SERVER_URL: value });
      // Одно из двух: адреса нет у обоих, или запросы приложения укладываются в разрешённый источник.
      if (url === null) expect(origin).toBeNull();
      else expect(url.startsWith(`${origin}`)).toBe(true);
    }
  });

  it("политика без ровно этой директивы не дополняется молча", () => {
    expect(() => withSyncServerOrigin("connect-src 'self' https://other", "https://sync.example.org")).toThrow(
      /connect-src/u,
    );
    expect(META_CSP).toContain(CONNECT_SRC_SELF);
  });
});
