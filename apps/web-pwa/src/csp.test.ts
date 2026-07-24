import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

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
