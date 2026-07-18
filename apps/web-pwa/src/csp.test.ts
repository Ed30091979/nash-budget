import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

const indexHtml = readFileSync(new URL("../index.html", import.meta.url), "utf8");

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
      "connect-src": ["'self'", "ws://localhost:*", "ws://127.0.0.1:*"],
      "worker-src": ["'self'"],
      "manifest-src": ["'self'"],
      "object-src": ["'none'"],
      "base-uri": ["'none'"],
      "form-action": ["'none'"],
    });
  });

  it("does not permit inline/eval execution, wildcard hosts, or external endpoints", () => {
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
    expect(sources.some((source) => /^wss?:\/\/(?!localhost:|127\.0\.0\.1:)/u.test(source))).toBe(
      false,
    );
  });
});
