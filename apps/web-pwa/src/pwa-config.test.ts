/// <reference types="node" />
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, describe, expect, it } from "vitest";

import {
  HTTP_CSP,
  META_CSP,
  PWA_BUILD_ID,
  PWA_MANIFEST,
  SECURITY_HEADERS,
  deployHeadersBody,
  resolvePwaBuildId,
  securityHeadersFor,
  withSyncServerOrigin,
} from "../vite.config";
import { SPLASH_DEVICES, SPLASH_DIRECTORY, SPLASH_ORIENTATIONS } from "./splash";

const configSource = readFileSync(new URL("../vite.config.ts", import.meta.url), "utf8");

const appDirectory = fileURLToPath(new URL("../", import.meta.url));
const indexHtmlSource = readFileSync(join(appDirectory, "index.html"), "utf8");
const publicHeadersSource = readFileSync(join(appDirectory, "public/_headers"), "utf8");
const securityHeadersJson = JSON.parse(
  readFileSync(join(appDirectory, "security-headers.json"), "utf8"),
) as Record<string, string>;

/** Политика из разметки — из атрибута `content`, а не из окружающего текста и комментариев. */
function metaPolicyOf(html: string): string {
  const content = html
    .match(/<meta\s+http-equiv="Content-Security-Policy"\s+content="([^"]*)"/iu)?.[1];
  if (content === undefined) throw new Error("index.html carries no CSP meta element");
  return content.replace(/\s+/gu, " ").trim();
}

/** Политика из файла `_headers` — из строки заголовка, а не из строк-комментариев рядом. */
function deployPolicyOf(headers: string): string {
  const value = headers.match(/^\s*Content-Security-Policy:[ \t]*(.+)$/mu)?.[1];
  if (value === undefined) throw new Error("_headers carries no Content-Security-Policy");
  return value.trim();
}

function sourcesOf(policy: string, directive: string): string[] {
  const found = policy
    .split(";")
    .map((entry) => entry.trim().split(/\s+/u))
    .find(([name]) => name === directive);
  if (found === undefined) throw new Error(`policy has no "${directive}" directive`);
  return found.slice(1);
}

function allSourcesOf(policy: string): string[] {
  return policy
    .split(";")
    .flatMap((entry) => entry.trim().split(/\s+/u).slice(1))
    .filter((source) => source.length > 0);
}

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
      'globIgnores: ["**/icon-192.png", "**/icon-512.png", "**/splash/**"]',
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
    // Заголовки preview собираются той же функцией, что и разворачиваемые: сборка без адреса
    // сервера даёт ровно прежний набор, а сборка с адресом — тот же набор с одной поправкой.
    expect(configSource).toContain("headers: securityHeadersFor(syncServerOrigin)");
    expect(securityHeadersFor(null)).toEqual({ ...SECURITY_HEADERS });
  });
});

describe("service worker registration coverage", () => {
  const appSource = readFileSync(new URL("./App.tsx", import.meta.url), "utf8");

  it("registers the service worker on every route, including first-run onboarding", () => {
    // Регистрация живёт в раме, которую отдаёт каждая ветка маршрута, — один экземпляр на всё
    // время жизни приложения, а не по экземпляру на ветку: так состояние плашки переживает
    // переход с онбординга в приложение.
    const routeGuards = appSource
      .split("\n")
      .filter((line) => /^\s{2}if \((?:loadState === |!budget \|\|).*\) return </u.test(line));

    expect(routeGuards).toHaveLength(4);
    for (const guard of routeGuards) {
      expect(guard).toContain("<AppFrame ");
    }
    expect(appSource).toContain('<AppFrame className="app-shell"');
    expect(appSource.match(/<UpdatePrompt /gu)).toHaveLength(1);
    expect(appSource).toMatch(/function AppFrame\([\s\S]*?<UpdatePrompt hasUnsavedChanges=\{hasUnsavedChanges\} suppressed=\{messageShown\} \/>/u);
    expect(appSource).toContain("const hasUnsavedDraft = operationDraftDirty || planningDraftDirty || importDraftDirty;");
    expect(appSource).toContain('<AppFrame className="app-shell" hasUnsavedChanges={hasUnsavedDraft} messageShown={message !== null}>');
  });
});

/**
 * Одно послабление политики — и ровно одно.
 *
 * Приглашение выводится Argon2id из `hash-wasm`, то есть WebAssembly, и `script-src 'self'`
 * отклонял его компиляцию: `sealInvite` бросал до первого запроса к серверу, а экран говорил
 * «Не удалось выполнить действие». Ни один модульный тест этого не видел — в Node политики нет,
 * — поэтому проверяется здесь и сразу во всех четырёх местах, где политика объявлена.
 *
 * `'wasm-unsafe-eval'` разрешает только компиляцию и создание модулей WebAssembly. Строковое
 * исполнение JavaScript — это отдельное `'unsafe-eval'`, и его отсутствие проверяется тем же
 * тестом: послабление не должно тихо разрастись до него при следующей правке.
 */
describe("политика и WebAssembly", () => {
  const declarations: ReadonlyArray<readonly [string, string]> = [
    ["META_CSP", META_CSP],
    ["HTTP_CSP", HTTP_CSP],
    ["index.html", metaPolicyOf(indexHtmlSource)],
    ["security-headers.json", securityHeadersJson["Content-Security-Policy"] ?? ""],
    ["public/_headers", deployPolicyOf(publicHeadersSource)],
  ];

  it.each(declarations)("%s разрешает WebAssembly ровно одним ключевым словом", (_label, policy) => {
    expect(sourcesOf(policy, "script-src")).toEqual(["'self'", "'wasm-unsafe-eval'"]);
  });

  it.each(declarations)("%s не открывает строковое исполнение JavaScript", (_label, policy) => {
    const sources = allSourcesOf(policy);
    expect(sources).not.toContain("'unsafe-eval'");
    expect(sources).not.toContain("'unsafe-inline'");
    expect(sources).not.toContain("'unsafe-hashes'");
    expect(sources).not.toContain("*");
  });

  it("объявляет во всех четырёх местах одну и ту же политику", () => {
    expect(metaPolicyOf(indexHtmlSource)).toBe(META_CSP);
    expect(securityHeadersJson["Content-Security-Policy"]).toBe(HTTP_CSP);
    expect(deployPolicyOf(publicHeadersSource)).toBe(HTTP_CSP);
  });

  it("держит статический `_headers` буква в букву тем, что пишет сборка", () => {
    // Сборка без адреса сервера этот файл не переписывает, а просто копирует из `public/`.
    // Разойдясь с `deployHeadersBody`, он дал бы развёрнутое приложение с одной политикой и
    // тесты — с другой.
    expect(publicHeadersSource).toBe(deployHeadersBody(null));
  });
});

/**
 * Сборка целиком: политика в разметке и политика в заголовке обязаны сойтись — и лечь туда,
 * куда собирают.
 *
 * Каталог сборки был константой `apps/web-pwa/dist`, а не тем каталогом, который назвали при
 * сборке. Сборка в любой другой каталог уезжала с разметкой, разрешающей сервер семьи, и с
 * заголовком, запрещающим к нему обращаться (политики пересекаются, поэтому разрешение в
 * `<meta>` не спасало), а исправленный файл при этом переписывал чужой `dist`. Проверяется
 * настоящей сборкой: подделать здесь нечего, дефект был именно в том, куда попадает файл.
 */
describe("сборка в каталог, отличный от dist", () => {
  const temporaryDirectories: string[] = [];
  const viteBin = join(appDirectory, "node_modules/vite/bin/vite.js");
  const distHeaders = join(appDirectory, "dist/_headers");

  afterAll(() => {
    for (const directory of temporaryDirectories.splice(0)) {
      rmSync(directory, { force: true, recursive: true });
    }
  });

  function outsideDist(): string {
    const directory = mkdtempSync(join(tmpdir(), "family-budget-build-outdir-"));
    temporaryDirectories.push(directory);
    return join(directory, "site");
  }

  function build(outDir: string, syncServerUrl: string | null) {
    const { VITE_SYNC_SERVER_URL: _ignored, ...environment } = process.env;
    return spawnSync(
      process.execPath,
      [viteBin, "build", "--outDir", outDir, "--emptyOutDir"],
      {
        cwd: appDirectory,
        encoding: "utf8",
        env:
          syncServerUrl === null
            ? environment
            : { ...environment, VITE_SYNC_SERVER_URL: syncServerUrl },
        timeout: 240_000,
      },
    );
  }

  it("даёт согласованные <meta> и _headers и не трогает dist", { timeout: 240_000 }, () => {
    expect(existsSync(viteBin), `vite CLI is missing at ${viteBin}`).toBe(true);
    const origin = "https://sync.example.org";
    const outDir = outsideDist();
    const distBefore = existsSync(distHeaders) ? readFileSync(distHeaders, "utf8") : null;

    const result = build(outDir, `${origin}/v1`);
    expect(result.status, result.stderr).toBe(0);

    const meta = metaPolicyOf(readFileSync(join(outDir, "index.html"), "utf8"));
    const deployed = readFileSync(join(outDir, "_headers"), "utf8");

    expect(meta).toBe(withSyncServerOrigin(META_CSP, origin));
    expect(deployPolicyOf(deployed)).toBe(withSyncServerOrigin(HTTP_CSP, origin));
    expect(deployed).toBe(deployHeadersBody(origin));
    // Один и тот же источник в обоих файлах — иначе приложение ходит на сервер на одной
    // поверхности и молча не ходит на другой.
    expect(sourcesOf(meta, "connect-src")).toEqual(["'self'", origin]);
    expect(sourcesOf(deployPolicyOf(deployed), "connect-src")).toEqual(["'self'", origin]);

    const distAfter = existsSync(distHeaders) ? readFileSync(distHeaders, "utf8") : null;
    expect(distAfter).toBe(distBefore);
  });

  it("без адреса сервера даёт прежнюю политику байт в байт", { timeout: 240_000 }, () => {
    const outDir = outsideDist();

    const result = build(outDir, null);
    expect(result.status, result.stderr).toBe(0);

    const builtIndex = readFileSync(join(outDir, "index.html"), "utf8");
    expect(metaPolicyOf(builtIndex)).toBe(META_CSP);
    expect(readFileSync(join(outDir, "_headers"), "utf8")).toBe(publicHeadersSource);

    // Картинки запуска iOS: ссылки доехали до сборки, ведут на файлы рядом и не легли в
    // предзагрузку сервис-воркера — их читает система, а не приложение (см. `src/splash.ts`).
    const startupHrefs = [
      ...builtIndex.matchAll(/<link rel="apple-touch-startup-image"[^>]*href="([^"]+)"/gu),
    ].map((match) => match[1] ?? "");
    expect(startupHrefs).toHaveLength(SPLASH_DEVICES.length * SPLASH_ORIENTATIONS.length);
    for (const href of startupHrefs) {
      expect(href.startsWith(`/${SPLASH_DIRECTORY}/`)).toBe(true);
      expect(existsSync(join(outDir, href)), `${href} отсутствует в сборке`).toBe(true);
    }
    expect(readFileSync(join(outDir, "sw.js"), "utf8")).not.toMatch(
      new RegExp(`url:"${SPLASH_DIRECTORY}/`, "u"),
    );
  });
});
