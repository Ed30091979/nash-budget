import { existsSync, readFileSync, readdirSync } from "node:fs";
import { basename, dirname, extname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const appDirectory = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const defaultDistDirectory = join(appDirectory, "dist");
const defaultAndroidConfig = resolve(appDirectory, "../android/capacitor.config.ts");
const expectedHeaders = JSON.parse(
  readFileSync(join(appDirectory, "security-headers.json"), "utf8"),
);

function fail(message) {
  throw new Error(`Release scan failed: ${message}`);
}

function walk(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    return entry.isDirectory() ? walk(path) : [path];
  });
}

function readPathArgument(name, fallback) {
  const index = process.argv.indexOf(name);
  if (index === -1) return fallback;
  const value = process.argv[index + 1];
  if (!value || value.startsWith("--")) {
    fail(`${name} requires a path`);
  }
  return resolve(value);
}

const supportedArguments = new Set(["--dist", "--android-config"]);
for (let index = 2; index < process.argv.length; index += 1) {
  const argument = process.argv[index];
  if (!argument?.startsWith("--")) continue;
  if (!supportedArguments.has(argument)) {
    fail(`unsupported argument: ${argument}`);
  }
  index += 1;
}

const distDirectory = readPathArgument("--dist", defaultDistDirectory);
const androidConfig = readPathArgument("--android-config", defaultAndroidConfig);

if (!existsSync(distDirectory)) {
  fail("dist/ is missing; run the production build first");
}
if (!existsSync(androidConfig)) {
  fail("Capacitor config is missing");
}

const artifactFiles = walk(distDirectory);
const artifactNames = artifactFiles.map((path) => relative(distDirectory, path));
const forbiddenArtifactName =
  /(?:^|\/)(?:\.env(?:\.|$)|[^/]*(?:secret|credential)[^/]*)|(?:\.jks|\.keystore|\.p12|\.pfx|\.pem|\.key|\.mobileprovision)$/iu;

for (const name of artifactNames) {
  if (forbiddenArtifactName.test(name)) {
    fail(`secret- or signing-like artifact found: ${name}`);
  }
  if (extname(name) === ".map") {
    fail(`source map found: ${name}`);
  }
}

const textArtifacts = artifactFiles
  .filter((path) => /\.(?:html|js|css|json|webmanifest|svg)$/u.test(path))
  .map((path) => ({
    name: relative(distDirectory, path),
    text: readFileSync(path, "utf8"),
  }));

for (const { name, text } of textArtifacts) {
  if (/sourceMappingURL\s*=/u.test(text)) {
    fail(`source map reference found in ${name}`);
  }
  if (/\/@vite\/client|__vite_ping|vite-hmr|live[-_]?reload/iu.test(text)) {
    fail(`development or live-reload runtime found in ${name}`);
  }

  const sensitiveContentPatterns = [
    {
      label: "private key",
      pattern:
        /-----BEGIN (?:RSA |EC |DSA |OPENSSH |ENCRYPTED )?PRIVATE KEY-----/u,
    },
    {
      label: "AWS access key",
      pattern: /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/u,
    },
    {
      label: "GitHub token",
      pattern: /\b(?:gh[opsur]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{60,})\b/u,
    },
    {
      label: "Google API key",
      pattern: /\bAIza[A-Za-z0-9_-]{35}\b/u,
    },
    {
      label: "Slack token",
      pattern: /\bxox[baprs]-[A-Za-z0-9-]{20,}\b/u,
    },
    {
      label: "live Stripe key",
      pattern: /\b(?:sk|rk)_live_[A-Za-z0-9]{16,}\b/u,
    },
  ];
  const sensitiveContent = sensitiveContentPatterns.find(({ pattern }) =>
    pattern.test(text)
  );
  if (sensitiveContent) {
    fail(`${sensitiveContent.label} found in ${name}`);
  }

  if (
    /(?:^|[^A-Za-z0-9_])\/(?:Users|home)\/[A-Za-z0-9._-]+(?:\/|\\)/u.test(
      text,
    ) ||
    /(?:^|[^A-Za-z0-9_])\/(?:private\/)?var\/folders\/[A-Za-z0-9._-]+(?:\/|\\)/u.test(
      text,
    ) ||
    /\b[A-Za-z]:\\+(?:Users|Documents and Settings)\\+[A-Za-z0-9._-]+\\+/u.test(
      text,
    )
  ) {
    fail(`absolute local filesystem path found in ${name}`);
  }
}

const indexHtml = readFileSync(join(distDirectory, "index.html"), "utf8");
const executableReferences = [
  ...indexHtml.matchAll(
    /<(?:script|link)\b[^>]*(?:src|href)=["']([^"']+)["'][^>]*>/giu,
  ),
].map((match) => match[1]);

for (const reference of executableReferences) {
  if (reference && /^(?:https?:)?\/\//iu.test(reference)) {
    fail(`remote executable reference found in index.html: ${reference}`);
  }
}

const javascriptArtifacts = textArtifacts.filter(({ name }) => name.endsWith(".js"));
for (const { name, text } of javascriptArtifacts) {
  if (
    /(?:importScripts\s*\(|import\s*\(|new\s+(?:Shared)?Worker\s*\()\s*["'`]https?:\/\//iu.test(
      text,
    ) ||
    /\bfetch\s*\(\s*["'`]https?:\/\//iu.test(text)
  ) {
    fail(`remote executable loading found in ${name}`);
  }
}

function isGeneratedWorkboxBundle(name) {
  const fileName = basename(name);
  return (
    name === "sw.js" ||
    /^workbox-[A-Za-z0-9_-]+\.js$/u.test(fileName) ||
    /^workbox-window(?:\.[A-Za-z0-9_-]+)*-[A-Za-z0-9_-]+\.js$/u.test(fileName)
  );
}

/**
 * Top-level arguments of the call whose argument list starts at `start`, split by
 * the commas that belong to the call itself — not to a nested call, array,
 * object or string. Minified code puts commas everywhere, so a regex cannot
 * tell the third argument of pushState from a comma inside its first one.
 */
function topLevelArguments(text, start) {
  const args = [];
  let current = "";
  let depth = 0;
  let quote = null;
  for (let index = start; index < text.length; index += 1) {
    const character = text[index];
    if (quote !== null) {
      current += character;
      if (character === "\\") {
        current += text[index + 1] ?? "";
        index += 1;
      } else if (character === quote) {
        quote = null;
      }
      continue;
    }
    if (character === '"' || character === "'" || character === "`") {
      quote = character;
      current += character;
      continue;
    }
    if (character === "(" || character === "[" || character === "{") depth += 1;
    if (character === ")" || character === "]" || character === "}") {
      if (depth === 0) {
        args.push(current);
        return args;
      }
      depth -= 1;
    }
    if (character === "," && depth === 0) {
      args.push(current);
      current = "";
      continue;
    }
    current += character;
  }
  return null;
}

/** Literal addresses (third argument) of every pushState/replaceState call. */
function historyLiteralAddresses(text) {
  const addresses = [];
  for (const match of text.matchAll(/history\.(?:pushState|replaceState)\(/gu)) {
    const address = topLevelArguments(text, match.index + match[0].length)?.[2]?.trim();
    if (address !== undefined && /^["'`]/u.test(address)) addresses.push(address);
  }
  return addresses;
}

const applicationBundles = javascriptArtifacts.filter(
  ({ name }) => !isGeneratedWorkboxBundle(name),
);
for (const { name, text } of applicationBundles) {
  if (/localStorage|sessionStorage/iu.test(text)) {
    fail(`browser key/value storage access found in ${name}`);
  }
  // The address bar is a leak channel: it is visible in browser history, it
  // travels in the referer header and into server logs, and it can be shared
  // by hand. Amounts, notes, names or a family's data reaching it would be a
  // defect.
  //
  // Wave 2 (plans/ui-wave2.md §2.1) gives the app one sanctioned use of it: the
  // hash router keeps the route in the fragment, and only opaque UUIDs and
  // filter keys may appear there. The fragment never reaches a server or a
  // referer. That address is written by one module, src/navigation/router.ts,
  // with keys made by formatRoute (which refuses anything but a UUID), and the
  // source test navigation/address-privacy.test.ts pins both. What stays
  // forbidden here, in the built code: the query string (location.search),
  // writing the fragment around the router (location.hash = …), and any
  // pushState/replaceState whose address is a literal other than a fragment —
  // path-shaped state like "/budget/january" or "/spent".
  //
  // Building a query string is deliberately NOT forbidden here. The sync
  // transport assembles `keyEpoch`/`after`/`limit` for its outgoing calls;
  // that is ordinary HTTP carrying values the server already knows, not a
  // channel that outlives the request. Banning `URLSearchParams` banned the
  // technique instead of the risk. Do not restore it as one rule.
  if (
    /location\.search/u.test(text) ||
    /location\.hash\s*=(?!=)/u.test(text) ||
    historyLiteralAddresses(text).some((address) => !/^["'`]#/u.test(address))
  ) {
    fail(`URL state channel found in ${name}`);
  }
  if (
    /\beval\s*\(/u.test(text) ||
    /\bnew\s+Function\s*\(/u.test(text) ||
    /\b(?:setTimeout|setInterval)\s*\(\s*["'`]/u.test(text)
  ) {
    fail(`dynamic string execution found in ${name}`);
  }
}

const serviceWorker = readFileSync(join(distDirectory, "sw.js"), "utf8");
if (!serviceWorker.includes("precacheAndRoute") || !serviceWorker.includes("NavigationRoute")) {
  fail("service worker lacks precache or nested-navigation fallback");
}
if (
  /(?:CacheFirst|NetworkFirst|NetworkOnly|StaleWhileRevalidate|ExpirationPlugin|BackgroundSyncPlugin|new\s+Queue)/u.test(
    serviceWorker,
  )
) {
  fail("service worker contains runtime caching or background-sync behavior");
}

const precacheUrls = [...serviceWorker.matchAll(/\burl:"([^"]+)"/gu)].map(
  (match) => match[1],
);
const duplicatePrecacheUrls = precacheUrls.filter(
  (url, index) => precacheUrls.indexOf(url) !== index,
);
if (duplicatePrecacheUrls.length > 0) {
  fail(`duplicate precache URLs: ${[...new Set(duplicatePrecacheUrls)].join(", ")}`);
}
if (!precacheUrls.includes("build-meta.json")) {
  fail("validated build metadata is not stamped into the service worker precache");
}

const buildMetadata = JSON.parse(
  readFileSync(join(distDirectory, "build-meta.json"), "utf8"),
);
if (
  typeof buildMetadata.buildId !== "string" ||
  !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u.test(buildMetadata.buildId) ||
  /(?:secret|token|password|private|credential)/iu.test(buildMetadata.buildId)
) {
  fail("build-meta.json contains an invalid or secret-like build id");
}

const manifest = JSON.parse(
  readFileSync(join(distDirectory, "manifest.webmanifest"), "utf8"),
);
const base = process.env.PWA_BASE ?? "/";
if (!/^\/(?:[A-Za-z0-9][A-Za-z0-9._-]*\/)*$/u.test(base)) {
  fail("PWA_BASE must be an absolute path with a trailing slash");
}
if (
  manifest.display !== "standalone" ||
  manifest.id !== base ||
  manifest.start_url !== base ||
  manifest.scope !== base ||
  "orientation" in manifest
) {
  fail("manifest identity, standalone mode, scope, start URL, or orientation is invalid");
}
const iconSizes = new Set(
  (manifest.icons ?? []).map((icon) => `${icon.src}|${icon.sizes}|${icon.purpose}`),
);
if (
  !iconSizes.has(`${base}icon-192.png|192x192|any`) ||
  !iconSizes.has(`${base}icon-512.png|512x512|any maskable`)
) {
  fail("manifest icons are incomplete");
}

const CONNECT_SRC_DIRECTIVE = "connect-src";

/**
 * Единственный источник, который сборке позволено добавить в политику: адрес сервера семьи.
 *
 * Только `https`, только схема-хост-порт и ничего больше. `http` отвергается здесь, а не только
 * в Android-обёртке: страница приложения отдаётся по `https` на обеих поверхностях, поэтому
 * незащищённый адрес — это не «менее строгая настройка», а адрес, по которому браузер не пойдёт.
 */
const SYNC_SERVER_ORIGIN = /^https:\/\/(?:[a-z0-9-]+(?:\.[a-z0-9-]+)*|\[[0-9a-f:.]+\])(?::\d{1,5})?$/iu;

function policyDirectives(policy) {
  return policy
    .split(";")
    .map((directive) => directive.trim())
    .filter((directive) => directive.length > 0);
}

/**
 * Сверяет политику с эталоном по директивам и возвращает адрес сервера, если он в ней есть.
 *
 * Сравнение по подстроке отвергало любую настроенную сборку целиком: расширенный `connect-src`
 * не совпадал с эталонной строкой, и релизный скан запрещал не адрес, а саму возможность
 * синхронизации. Обратное послабление — «политика содержит connect-src» — разрешило бы `*`.
 * Поэтому здесь: список директив совпадает по составу и порядку, каждая совпадает точно, и ровно
 * одной, `connect-src`, разрешено нести один дополнительный источник поверх `'self'`.
 */
function assertPolicyMatchesBaseline(policy, baseline, label) {
  const actual = policyDirectives(policy);
  const expected = policyDirectives(baseline);
  if (actual.length !== expected.length) {
    fail(`${label} does not carry the baseline security policy`);
  }
  let syncServerOrigin = null;
  for (const [index, directive] of expected.entries()) {
    const found = actual[index];
    if (found === directive) continue;
    if (!directive.startsWith(`${CONNECT_SRC_DIRECTIVE} `)) {
      fail(`${label} alters the "${directive}" directive`);
    }
    const added = found.startsWith(`${directive} `) ? found.slice(directive.length + 1) : null;
    if (added === null || !SYNC_SERVER_ORIGIN.test(added)) {
      fail(`${label} widens ${CONNECT_SRC_DIRECTIVE} beyond one https sync-server origin`);
    }
    syncServerOrigin = added;
  }
  return syncServerOrigin;
}

const deployHeaders = readFileSync(join(distDirectory, "_headers"), "utf8");
const baselineCsp = expectedHeaders["Content-Security-Policy"];
for (const [name, value] of Object.entries(expectedHeaders)) {
  if (name === "Content-Security-Policy") continue;
  if (!deployHeaders.includes(`${name}: ${value}`)) {
    fail(`deploy headers omit ${name}`);
  }
}

const deployedCsp = deployHeaders.match(/^\s*Content-Security-Policy:[ \t]*(.+)$/mu)?.[1]?.trim();
if (deployedCsp === undefined) {
  fail("deploy headers omit Content-Security-Policy");
}
const metaCsp = indexHtml
  .match(/<meta\s+http-equiv="Content-Security-Policy"\s+content="([^"]*)"/iu)?.[1]
  ?.replace(/\s+/gu, " ")
  .trim();

// `frame-ancestors` признаётся только в заголовке, поэтому разметка сверяется с эталоном без него.
const baselineMetaCsp = policyDirectives(baselineCsp)
  .filter((directive) => !directive.startsWith("frame-ancestors"))
  .join("; ");
// Разметка без политики не называет никакого сервера — и обязана сойтись с заголовком, который
// тоже не должен его называть. Это не пропуск проверки: сравнение ниже всё равно состоится, и
// сборка, где адрес есть в заголовке и отсутствует в странице, провалится именно на нём.
const metaSyncServer =
  metaCsp === undefined
    ? null
    : assertPolicyMatchesBaseline(metaCsp, baselineMetaCsp, "index.html meta CSP");
const deployedSyncServer = assertPolicyMatchesBaseline(deployedCsp, baselineCsp, "deploy headers CSP");
if (metaSyncServer !== deployedSyncServer) {
  // Разметка едет в APK, заголовок — только на хостинг. Разойдясь, они дали бы приложение,
  // которое ходит на сервер в браузере и молча не ходит в Android-обёртке, или наоборот.
  fail("index.html and deploy headers name different sync-server origins");
}

const capacitorSource = readFileSync(androidConfig, "utf8");
// Два разных запрета, которые легко перепутать.
//
// Первый — про то, откуда грузится САМО приложение: `server`/`server.url` в конфигурации
// Capacitor заставляет обёртку открывать страницу с удалённого адреса, и тогда весь
// проверенный локальный пакет перестаёт быть тем, что исполняется. Это запрещено всегда.
//
// Второй — про то, куда приложение ХОДИТ: адрес API семьи. Он тоже не может быть здесь, но по
// другой причине — он вообще не принадлежит этому файлу: §9 задаёт его конфигурацией веб-сборки
// (`VITE_SYNC_SERVER_URL`), откуда он попадает в бандл и в `connect-src` выше. Зашитый сюда
// адрес был бы вторым источником правды, который никакая сборка не перекрывает.
if (/\bserver\s*:/u.test(capacitorSource) || /\burl\s*:\s*["']https?:\/\//iu.test(capacitorSource)) {
  fail("Capacitor contains server.url or another remote app endpoint");
}
if (/["'`]https?:\/\//iu.test(capacitorSource)) {
  fail("Capacitor config hardcodes an absolute remote address");
}

process.stdout.write(
  `Release scan passed: ${artifactFiles.length} artifacts, ${precacheUrls.length} unique precache URLs, ` +
    `build ${buildMetadata.buildId}, sync server ${deployedSyncServer ?? "not configured (local-only build)"}.\n`,
);
