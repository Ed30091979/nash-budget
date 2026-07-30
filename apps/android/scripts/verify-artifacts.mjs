import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  readdirSync,
  readFileSync,
  statSync,
} from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

import {
  assertArtifactIsCurrent,
  collectArtifactInputs,
} from "./artifact-staleness.mjs";
import { verifyDebugApkSigner } from "./apk-signer-policy.mjs";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const androidRoot = join(packageRoot, "android");
const appRoot = join(androidRoot, "app");
const webDist = resolve(packageRoot, "../web-pwa/dist");
const syncedWebAssets = join(appRoot, "src/main/assets/public");
const debugApk = join(appRoot, "build/outputs/apk/debug/app-debug.apk");
const releaseAab = join(
  appRoot,
  "build/outputs/bundle/release/app-release.aab",
);

function fail(message) {
  throw new Error(`Android artifact scan failed: ${message}`);
}

function assert(condition, message) {
  if (!condition) {
    fail(message);
  }
}

function read(path) {
  return readFileSync(path, "utf8");
}

function listZip(path) {
  return execFileSync("unzip", ["-Z1", path], { encoding: "utf8" })
    .split(/\r?\n/u)
    .filter(Boolean);
}

function readZipEntry(path, entry) {
  return execFileSync("unzip", ["-p", path, entry], {
    encoding: "utf8",
    maxBuffer: 20 * 1024 * 1024,
  });
}

function readZipEntryBytes(path, entry) {
  return execFileSync("unzip", ["-p", path, entry], {
    maxBuffer: 20 * 1024 * 1024,
  });
}

function findFiles(root, expectedName) {
  if (!existsSync(root)) {
    return [];
  }

  const found = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) {
      found.push(...findFiles(path, expectedName));
    } else if (entry.name === expectedName) {
      found.push(path);
    }
  }
  return found;
}

function listFiles(root) {
  if (!existsSync(root)) {
    return [];
  }

  const found = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) {
      found.push(...listFiles(path));
    } else if (entry.isFile()) {
      found.push(path);
    }
  }
  return found;
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function zipPath(path) {
  return path.split(sep).join("/");
}

function assertSameEntries(actual, expected, artifact) {
  const actualSorted = [...actual].sort();
  const expectedSorted = [...expected].sort();
  assert(
    JSON.stringify(actualSorted) === JSON.stringify(expectedSorted),
    `${artifact}: packaged web assets differ from the current production dist`,
  );
}

function assertLocalConfig(config, source) {
  assert(config.appId === "ru.nashbudget.app", `${source}: unexpected appId`);
  assert(
    config.webDir === "../web-pwa/dist",
    `${source}: webDir must reference the local production build`,
  );
  assert(
    !Object.hasOwn(config, "server"),
    `${source}: server/live-reload configuration is forbidden`,
  );
  assert(
    config.android?.allowMixedContent === false,
    `${source}: mixed WebView content must be disabled`,
  );
  assert(
    config.android?.webContentsDebuggingEnabled === false,
    `${source}: WebView debugging must be disabled`,
  );
  assert(
    config.android?.loggingBehavior === "none",
    `${source}: native logging must be disabled`,
  );
}

function assertPackagedWebAssets(entries, prefix, artifact) {
  const requiredEntries = [
    `${prefix}index.html`,
    `${prefix}manifest.webmanifest`,
    `${prefix}sw.js`,
  ];
  for (const entry of requiredEntries) {
    assert(entries.includes(entry), `${artifact}: missing ${entry}`);
  }
  assert(
    entries.some(
      (entry) => entry.startsWith(`${prefix}assets/`) && entry.endsWith(".js"),
    ),
    `${artifact}: production JavaScript bundle is missing`,
  );
  assert(
    entries.some(
      (entry) => entry.startsWith(`${prefix}assets/`) && entry.endsWith(".css"),
    ),
    `${artifact}: production stylesheet is missing`,
  );
}

for (const artifact of [debugApk, releaseAab]) {
  assert(existsSync(artifact), `missing artifact ${relative(packageRoot, artifact)}`);
  assert(statSync(artifact).size > 0, `empty artifact ${relative(packageRoot, artifact)}`);
}

let debugApkSigner;
try {
  debugApkSigner = verifyDebugApkSigner({
    apkPath: debugApk,
    localPropertiesPath: join(androidRoot, "local.properties"),
  });
} catch (error) {
  fail(error instanceof Error ? error.message : "debug APK signer check failed");
}

const apkEntries = listZip(debugApk);
const aabEntries = listZip(releaseAab);
assertPackagedWebAssets(apkEntries, "assets/public/", "debug APK");
assertPackagedWebAssets(aabEntries, "base/assets/public/", "release AAB");

const productionFiles = listFiles(webDist);
assert(productionFiles.length > 0, "production web dist is empty");
const productionPaths = productionFiles.map((file) =>
  zipPath(relative(webDist, file)),
);
const syncedFiles = listFiles(syncedWebAssets);
const syncedPaths = syncedFiles.map((file) =>
  zipPath(relative(syncedWebAssets, file)),
);
assertSameEntries(
  syncedPaths,
  [...productionPaths, "cordova.js", "cordova_plugins.js"],
  "Capacitor synced assets",
);
assertSameEntries(
  apkEntries
    .filter(
      (entry) =>
        entry.startsWith("assets/public/") &&
        !entry.endsWith("/"),
    )
    .map((entry) => entry.slice("assets/public/".length)),
  syncedPaths,
  "debug APK",
);
assertSameEntries(
  aabEntries
    .filter(
      (entry) =>
        entry.startsWith("base/assets/public/") &&
        !entry.endsWith("/"),
    )
    .map((entry) => entry.slice("base/assets/public/".length)),
  syncedPaths,
  "release AAB",
);
for (const file of syncedFiles) {
  const syncedPath = zipPath(relative(syncedWebAssets, file));
  const sourceHash = sha256(readFileSync(file));
  for (const [artifact, zipPath, entries, path] of [
    ["debug APK", debugApk, apkEntries, `assets/public/${syncedPath}`],
    ["release AAB", releaseAab, aabEntries, `base/assets/public/${syncedPath}`],
  ]) {
    assert(entries.includes(path), `${artifact}: synced asset missing: ${path}`);
    assert(
      sha256(readZipEntryBytes(zipPath, path)) === sourceHash,
      `${artifact}: stale or modified synced asset: ${path}`,
    );
  }
}
for (const file of productionFiles) {
  const distPath = zipPath(relative(webDist, file));
  const sourceHash = sha256(readFileSync(file));
  for (const [artifact, zipPath, entries, path] of [
    ["debug APK", debugApk, apkEntries, `assets/public/${distPath}`],
    ["release AAB", releaseAab, aabEntries, `base/assets/public/${distPath}`],
  ]) {
    assert(entries.includes(path), `${artifact}: current dist file missing: ${path}`);
    assert(
      sha256(readZipEntryBytes(zipPath, path)) === sourceHash,
      `${artifact}: stale or modified local web asset: ${path}`,
    );
  }
}

const apkConfigEntry = "assets/capacitor.config.json";
const aabConfigEntry = "base/assets/capacitor.config.json";
assert(apkEntries.includes(apkConfigEntry), "debug APK: Capacitor config missing");
assert(aabEntries.includes(aabConfigEntry), "release AAB: Capacitor config missing");
for (const [localPath, apkEntry, aabEntry] of [
  [
    join(appRoot, "src/main/assets/capacitor.config.json"),
    apkConfigEntry,
    aabConfigEntry,
  ],
  [
    join(appRoot, "src/main/assets/capacitor.plugins.json"),
    "assets/capacitor.plugins.json",
    "base/assets/capacitor.plugins.json",
  ],
]) {
  assert(
    existsSync(localPath),
    `missing synced config asset ${relative(packageRoot, localPath)}`,
  );
  const localHash = sha256(readFileSync(localPath));
  for (const [artifact, zipPath, entries, entry] of [
    ["debug APK", debugApk, apkEntries, apkEntry],
    ["release AAB", releaseAab, aabEntries, aabEntry],
  ]) {
    assert(entries.includes(entry), `${artifact}: config asset missing: ${entry}`);
    assert(
      sha256(readZipEntryBytes(zipPath, entry)) === localHash,
      `${artifact}: stale or modified config asset: ${entry}`,
    );
  }
}
assertLocalConfig(
  JSON.parse(readZipEntry(debugApk, apkConfigEntry)),
  "debug APK config",
);
assertLocalConfig(
  JSON.parse(readZipEntry(releaseAab, aabConfigEntry)),
  "release AAB config",
);

for (const [artifact, entries, indexEntry] of [
  ["debug APK", apkEntries, "assets/public/index.html"],
  ["release AAB", aabEntries, "base/assets/public/index.html"],
]) {
  const index = readZipEntry(
    artifact === "debug APK" ? debugApk : releaseAab,
    indexEntry,
  );
  assert(
    !/(?:src|href)\s*=\s*["']https?:\/\//iu.test(index),
    `${artifact}: index.html references a remote UI asset`,
  );
  const forbiddenFiles = entries.filter((entry) =>
    /(?:^|\/)(?:google-services\.json|[^/]*\.(?:jks|keystore|p12|pfx))$/iu.test(
      entry,
    ),
  );
  assert(
    forbiddenFiles.length === 0,
    `${artifact}: signing/remote-service material packaged: ${forbiddenFiles.join(", ")}`,
  );
}

const releaseSignatures = aabEntries.filter((entry) =>
  /^META-INF\/.+\.(?:RSA|DSA|EC|SF)$/iu.test(entry),
);
assert(
  releaseSignatures.length === 0,
  `release AAB unexpectedly signed: ${releaseSignatures.join(", ")}`,
);

const mergedManifests = findFiles(
  join(appRoot, "build/intermediates/merged_manifests/release"),
  "AndroidManifest.xml",
);
assert(
  mergedManifests.length === 1,
  `expected one release merged manifest, found ${mergedManifests.length}`,
);
const mergedManifest = read(mergedManifests[0]);
const internalReceiverPermission =
  "ru.nashbudget.app.DYNAMIC_RECEIVER_NOT_EXPORTED_PERMISSION";
const requestedPermissions = [
  ...mergedManifest.matchAll(
    /<uses-permission\b[^>]*android:name="([^"]+)"[^>]*\/?>/gu,
  ),
].map((match) => match[1]);
assert(
  requestedPermissions.length === 1 &&
    requestedPermissions[0] === internalReceiverPermission,
  `release manifest requests unexpected permissions: ${requestedPermissions.join(", ") || "none"}`,
);
assert(
  new RegExp(
    `<permission\\b[^>]*android:name="${internalReceiverPermission.replaceAll(".", "\\.")}"[^>]*android:protectionLevel="signature"`,
    "u",
  ).test(mergedManifest),
  "AndroidX receiver permission must remain app-scoped and signature-protected",
);
assert(
  /android:allowBackup="false"/u.test(mergedManifest),
  "Android backup must be disabled",
);
assert(
  /android:fullBackupContent="false"/u.test(mergedManifest),
  "legacy Android backup must be disabled",
);
assert(
  /android:dataExtractionRules="@xml\/data_extraction_rules"/u.test(
    mergedManifest,
  ),
  "data extraction rules are missing",
);
assert(
  /android:usesCleartextTraffic="false"/u.test(mergedManifest),
  "cleartext traffic must be disabled",
);
assert(
  /android:networkSecurityConfig="@xml\/network_security_config"/u.test(
    mergedManifest,
  ),
  "network security config is missing",
);
assert(
  !/android:debuggable="true"/u.test(mergedManifest),
  "release application must not be debuggable",
);

const exportedTrueComponents = [
  ...mergedManifest.matchAll(
    /<(?:activity|activity-alias|service|receiver|provider)\b([^>]*)>/gu,
  ),
]
  .filter((match) => /android:exported="true"/u.test(match[1]))
  .map((match) => match[1].match(/android:name="([^"]+)"/u)?.[1])
  .filter(Boolean);
assert(
  exportedTrueComponents.length === 1 &&
    exportedTrueComponents[0].endsWith("MainActivity"),
  `unexpected exported components: ${exportedTrueComponents.join(", ") || "none"}`,
);
assert(
  /android:name="androidx\.core\.content\.FileProvider"[\s\S]*?android:exported="false"/u.test(
    mergedManifest,
  ),
  "FileProvider must remain non-exported",
);

const appBuild = read(join(appRoot, "build.gradle"));
const rootBuild = read(join(androidRoot, "build.gradle"));
const variablesBuild = read(join(androidRoot, "variables.gradle"));
assert(
  !/\bsigningConfig\b/u.test(appBuild),
  "release Gradle config must not reference a signing configuration",
);
assert(
  !/google-services|com\.google\.gms/iu.test(`${rootBuild}\n${appBuild}`),
  "Google Services/analytics Gradle integration must remain absent",
);
assert(
  /versionCode\s+1\b/u.test(appBuild) &&
    /versionName\s+"1\.0\.0"/u.test(appBuild),
  "local versionCode/versionName changed unexpectedly",
);
assert(
  /minSdkVersion\s*=\s*24\b/u.test(variablesBuild) &&
    /compileSdkVersion\s*=\s*36\b/u.test(variablesBuild) &&
    /targetSdkVersion\s*=\s*36\b/u.test(variablesBuild),
  "tested min/compile/target SDK policy changed unexpectedly",
);

const networkSecurity = read(
  join(appRoot, "src/main/res/xml/network_security_config.xml"),
);
assert(
  /<base-config\s+cleartextTrafficPermitted="false"\s*\/>/u.test(
    networkSecurity,
  ) && !/cleartextTrafficPermitted="true"/u.test(networkSecurity),
  "network security config must deny cleartext traffic",
);

const dataExtractionRules = read(
  join(appRoot, "src/main/res/xml/data_extraction_rules.xml"),
);
assert(
  /<cloud-backup\s+disableIfNoEncryptionCapabilities="true">/u.test(
    dataExtractionRules,
  ),
  "cloud backup must require encryption capabilities",
);
for (const sectionName of ["cloud-backup", "device-transfer"]) {
  const section = dataExtractionRules.match(
    new RegExp(`<${sectionName}[^>]*>([\\s\\S]*?)<\\/${sectionName}>`, "u"),
  )?.[1];
  assert(section, `data extraction section ${sectionName} is missing`);
  for (const domain of [
    "root",
    "file",
    "database",
    "sharedpref",
    "external",
    "device_root",
    "device_file",
    "device_database",
    "device_sharedpref",
  ]) {
    assert(
      new RegExp(
        `<exclude\\s+domain="${domain}"\\s+path="\\."\\s*\\/>`,
        "u",
      ).test(section),
      `${sectionName} does not exclude ${domain}`,
    );
  }
}

const filePaths = read(join(appRoot, "src/main/res/xml/file_paths.xml"));
assert(
  !/<external-path\b/u.test(filePaths) &&
    /<external-files-path\s+name="captured_images"\s+path="Pictures\/"\s*\/>/u.test(
      filePaths,
    ),
  "FileProvider must not grant access to the shared external-storage root",
);

const nativeSources = listFiles(join(appRoot, "src/main")).filter((source) =>
  /\.(?:java|kt)$/u.test(source),
);
for (const source of nativeSources) {
  assert(
    !/\b(?:Log\.[vdiew]|System\.out|System\.err)\b/u.test(read(source)),
    `${relative(packageRoot, source)} contains native logging`,
  );
}
const mainActivitySource = read(
  join(
    appRoot,
    "src/main/java/ru/nashbudget/app/MainActivity.java",
  ),
);
const exportPluginSource = read(
  join(
    appRoot,
    "src/main/java/ru/nashbudget/app/NativeFileExportPlugin.java",
  ),
);
const exportPolicySource = read(
  join(
    appRoot,
    "src/main/java/ru/nashbudget/app/NativeFileExportPolicy.java",
  ),
);
assert(
  /registerPlugin\(NativeFileExportPlugin\.class\)/u.test(mainActivitySource),
  "native file export plugin is not registered",
);
assert(
  /Intent\.ACTION_CREATE_DOCUMENT/u.test(exportPluginSource) &&
    /Intent\.CATEGORY_OPENABLE/u.test(exportPluginSource),
  "native exports must use the system document picker",
);
assert(
  !/(?:requestPermissions?|MANAGE_EXTERNAL_STORAGE|WRITE_EXTERNAL_STORAGE|READ_EXTERNAL_STORAGE)/u.test(
    exportPluginSource,
  ),
  "native export must not request broad storage access",
);
assert(
  /static\s+final\s+String\s+WRITE_TRUNCATE_MODE\s*=\s*"wt"\s*;/u.test(
    exportPolicySource,
  ),
  'native export policy must define WRITE_TRUNCATE_MODE as exactly "wt"',
);
assert(
  /\.openOutputStream\(\s*selectedUri\s*,\s*NativeFileExportPolicy\.WRITE_TRUNCATE_MODE\s*\)/u.test(
    exportPluginSource,
  ),
  "native export must open the selected document with the truncate-mode policy constant",
);
for (const [artifact, zipPath, entries, dexPattern] of [
  ["debug APK", debugApk, apkEntries, /^classes\d*\.dex$/u],
  ["release AAB", releaseAab, aabEntries, /^base\/dex\/classes\d*\.dex$/u],
]) {
  const dexEntries = entries.filter((entry) => dexPattern.test(entry));
  assert(dexEntries.length > 0, `${artifact}: DEX payload is missing`);
  const dexFiles = dexEntries.map((entry) => readZipEntryBytes(zipPath, entry));
  for (const marker of [
    "NativeFileExport",
    "android.intent.action.CREATE_DOCUMENT",
    "application/json",
    "text/csv",
  ]) {
    assert(
      dexFiles.some((dex) => dex.includes(Buffer.from(marker, "utf8"))),
      `${artifact}: native export marker is missing: ${marker}`,
    );
  }
}

const artifactInputs = collectArtifactInputs({ packageRoot, androidRoot });
assertArtifactIsCurrent(debugApk, artifactInputs, packageRoot);
assertArtifactIsCurrent(releaseAab, artifactInputs, packageRoot);

const apkAssetCount = syncedPaths.length;
const aabAssetCount = syncedPaths.length;

console.log("Android artifact scan passed.");
console.log(
  JSON.stringify(
    {
      appId: "ru.nashbudget.app",
      versionCode: 1,
      versionName: "1.0.0",
      systemPermissions: [],
      internalSignaturePermissions: requestedPermissions,
      exportedComponents: exportedTrueComponents,
      syncedProductionFiles: productionFiles.length,
      debugApk: {
        path: relative(packageRoot, debugApk),
        bytes: statSync(debugApk).size,
        localWebAssets: apkAssetCount,
        signer: debugApkSigner,
      },
      unsignedReleaseAab: {
        path: relative(packageRoot, releaseAab),
        bytes: statSync(releaseAab).size,
        localWebAssets: aabAssetCount,
      },
    },
    null,
    2,
  ),
);
