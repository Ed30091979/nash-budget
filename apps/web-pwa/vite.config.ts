import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import type { Plugin } from "vite";
import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";
import { VitePWA, type ManifestOptions } from "vite-plugin-pwa";

export const META_CSP =
  "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; font-src 'self'; connect-src 'self'; worker-src 'self'; manifest-src 'self'; object-src 'none'; base-uri 'none'; form-action 'none'";

export const HTTP_CSP = `${META_CSP}; frame-ancestors 'none'`;

/** Единственная директива, которую адрес сервера семьи вправе изменить. */
export const CONNECT_SRC_SELF = "connect-src 'self'";

/**
 * Хост, состоящий из того, из чего состоит хост.
 *
 * Проверка стоит рядом с `new URL`, а не вместо неё: `new URL` примет `http://*.example.com` и
 * честно вернёт такой `origin`, а подстановка его в политику превратила бы «разрешён один адрес»
 * в «разрешён любой поддомен». Здесь допускаются буквы, цифры, дефис, точка и запись IPv6.
 */
const HOST_PATTERN = /^(?:[a-z0-9.-]+|\[[0-9a-f:.]+\])$/u;

/**
 * Источник сервера синхронизации для политики — из конфигурации сборки и только из неё.
 *
 * Берётся ровно тот же ключ, что читает приложение (`resolveSyncServerUrl` в `features/family`),
 * и сводится к источнику: схема, хост и порт. Путь, запрос и учётные данные отбрасываются —
 * `connect-src` их всё равно не различает, а адрес с путём в политике читается как разрешение,
 * которого нет. Всё, что не `http(s)` с внятным хостом, — это отсутствие адреса, а не ошибка:
 * сборка по умолчанию не знает никакого сервера.
 */
export function resolveSyncServerOrigin(env: Readonly<Record<string, unknown>>): string | null {
  const raw = env.VITE_SYNC_SERVER_URL;
  if (typeof raw !== "string" || raw.trim().length === 0) return null;
  let parsed: URL;
  try {
    parsed = new URL(raw.trim());
  } catch {
    return null;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
  if (parsed.username.length > 0 || parsed.password.length > 0) return null;
  if (!HOST_PATTERN.test(parsed.hostname)) return null;
  return parsed.origin;
}

/**
 * Политика с добавленным источником сервера семьи — и ни с чем больше.
 *
 * Переписывается ровно одна директива, и только если она в точности `connect-src 'self'`:
 * подстановка регулярным выражением по «connect-src» согласилась бы дополнить и уже ослабленную
 * политику, а молчаливое несовпадение оставило бы сборку с адресом сервера и без права к нему
 * обращаться. Поэтому здесь — точное сравнение и явный отказ.
 */
export function withSyncServerOrigin(csp: string, origin: string | null): string {
  if (origin === null) return csp;
  const directives = csp.split(";").map((directive) => directive.trim());
  const index = directives.indexOf(CONNECT_SRC_SELF);
  if (index < 0) throw new Error(`CSP has no exact "${CONNECT_SRC_SELF}" directive to extend.`);
  directives[index] = `${CONNECT_SRC_SELF} ${origin}`;
  return directives.join("; ");
}

export function securityHeadersFor(origin: string | null): Record<string, string> {
  return {
    "Content-Security-Policy": withSyncServerOrigin(HTTP_CSP, origin),
    "X-Frame-Options": "DENY",
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer",
    "Permissions-Policy":
      "camera=(), microphone=(), geolocation=(), payment=(), usb=(), bluetooth=()",
    "Cross-Origin-Opener-Policy": "same-origin",
    "Cross-Origin-Resource-Policy": "same-origin",
  };
}

export const SECURITY_HEADERS = securityHeadersFor(null) as Readonly<Record<string, string>>;

export function resolvePwaBuildId(value: string | undefined): string {
  const buildId = value ?? "local";

  if (
    !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u.test(buildId) ||
    /(?:secret|token|password|private|credential)/iu.test(buildId)
  ) {
    throw new Error(
      "PWA_BUILD_ID must be a non-secret identifier of 1-64 ASCII letters, digits, dots, underscores, or hyphens.",
    );
  }

  return buildId;
}

export const PWA_BUILD_ID = resolvePwaBuildId(process.env.PWA_BUILD_ID);

// Базовый путь для хостинга под подкаталогом (GitHub Pages). По умолчанию "/".
export const PWA_BASE = process.env.PWA_BASE ?? "/";

export const PWA_MANIFEST = {
  id: PWA_BASE,
  name: "Наш бюджет",
  short_name: "Наш бюджет",
  description: "План, факт и контроль семейных лимитов — даже без интернета.",
  lang: "ru",
  start_url: PWA_BASE,
  scope: PWA_BASE,
  display: "standalone",
  background_color: "#F2F6F3",
  theme_color: "#F2F6F3",
  categories: ["finance", "productivity"],
  icons: [
    {
      src: `${PWA_BASE}icon-192.png`,
      sizes: "192x192",
      type: "image/png",
      purpose: "any",
    },
    {
      src: `${PWA_BASE}icon-512.png`,
      sizes: "512x512",
      type: "image/png",
      purpose: "any maskable",
    },
  ],
} satisfies Partial<ManifestOptions>;

/**
 * Проводит адрес сервера семьи в политику — в разметку и в разворачиваемые заголовки.
 *
 * Без него сборка с настроенным адресом собиралась молча и падала в браузере: `connect-src 'self'`
 * отклонял каждый запрос к серверу, а отклонение политикой не похоже на отказ сервера ничем, что
 * видно в приложении. С отсутствующим адресом плагин не делает ничего, и вывод сборки по
 * умолчанию не отличается от прежнего ни одним байтом.
 */
function syncServerCspPlugin(origin: string | null, outDir: string): Plugin {
  return {
    name: "family-budget-sync-csp",
    transformIndexHtml: {
      order: "post",
      handler(html) {
        if (origin === null) return html;
        if (!html.includes(META_CSP)) {
          throw new Error("index.html does not carry the expected CSP meta content.");
        }
        return html.replace(META_CSP, withSyncServerOrigin(META_CSP, origin));
      },
    },
    async closeBundle() {
      if (origin === null) return;
      // `_headers` кладётся в сборку из `public/` уже после генерации ассетов, поэтому он
      // переписывается здесь, а не эмитируется: иначе развёрнутое приложение получило бы
      // заголовок со старой политикой поверх исправленной разметки.
      const headers = securityHeadersFor(origin);
      const body = [
        "/*",
        ...Object.entries(headers).map(([name, value]) => `  ${name}: ${value}`),
        "",
      ].join("\n");
      await writeFile(resolve(outDir, "_headers"), body, "utf8");
    },
  };
}

function buildMetadataPlugin(): Plugin {
  return {
    name: "family-budget-build-metadata",
    generateBundle() {
      this.emitFile({
        type: "asset",
        fileName: "build-meta.json",
        source: `${JSON.stringify({ buildId: PWA_BUILD_ID })}\n`,
      });
    },
  };
}

const APP_ROOT = fileURLToPath(new URL(".", import.meta.url));
const OUT_DIR = resolve(APP_ROOT, "dist");

export default defineConfig(({ mode }) => {
  // Ровно тот же ключ и тот же приоритет, что у приложения: `loadEnv` читает `.env`-файлы
  // сборки, а `process.env` перекрывает их — иначе политика знала бы один адрес, а код,
  // собранный рядом с ней, обращался бы по другому.
  const env = { ...loadEnv(mode, APP_ROOT, "VITE_"), ...process.env };
  const syncServerOrigin = resolveSyncServerOrigin(env);
  return {
    base: PWA_BASE,
    plugins: [
      react(),
      buildMetadataPlugin(),
      syncServerCspPlugin(syncServerOrigin, OUT_DIR),
      VitePWA({
        registerType: "prompt",
        injectRegister: null,
        manifest: PWA_MANIFEST,
        workbox: {
          cleanupOutdatedCaches: true,
          clientsClaim: false,
          skipWaiting: false,
          navigateFallback: "index.html",
          globPatterns: ["**/*.{js,css,html,svg,png,woff2}"],
          globIgnores: ["**/icon-192.png", "**/icon-512.png"],
          additionalManifestEntries: [
            {
              url: "build-meta.json",
              revision: PWA_BUILD_ID,
            },
          ],
        },
        devOptions: {
          enabled: false,
        },
      }),
    ],
    build: {
      sourcemap: false,
    },
    server: {
      port: 4173,
      strictPort: true,
    },
    preview: {
      port: 4173,
      strictPort: true,
      headers: securityHeadersFor(syncServerOrigin),
    },
  };
});
