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

const applicationBundles = javascriptArtifacts.filter(
  ({ name }) => !isGeneratedWorkboxBundle(name),
);
for (const { name, text } of applicationBundles) {
  if (/localStorage|sessionStorage/iu.test(text)) {
    fail(`browser key/value storage access found in ${name}`);
  }
  if (
    /URLSearchParams|location\.(?:search|hash)|history\.(?:pushState|replaceState)/u.test(text)
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

const deployHeaders = readFileSync(join(distDirectory, "_headers"), "utf8");
for (const [name, value] of Object.entries(expectedHeaders)) {
  if (!deployHeaders.includes(`${name}: ${value}`)) {
    fail(`deploy headers omit ${name}`);
  }
}

const capacitorSource = readFileSync(androidConfig, "utf8");
if (/\bserver\s*:/u.test(capacitorSource) || /\burl\s*:\s*["']https?:\/\//iu.test(capacitorSource)) {
  fail("Capacitor contains server.url or another remote app endpoint");
}

process.stdout.write(
  `Release scan passed: ${artifactFiles.length} artifacts, ${precacheUrls.length} unique precache URLs, build ${buildMetadata.buildId}.\n`,
);
