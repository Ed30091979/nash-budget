import assert from "node:assert/strict";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";

import {
  assertArtifactIsCurrent,
  collectArtifactInputs,
} from "./artifact-staleness.mjs";
import {
  parseAndAssertDebugApkSigner,
  resolveApkSigner,
  verifyDebugApkSigner,
} from "./apk-signer-policy.mjs";
import {
  INTERNET_PERMISSION,
  expectedManifestPermissions,
  resolveConfiguredSyncOrigin,
} from "./sync-network-policy.mjs";
import { backNavigationProblems } from "./native-source-policy.mjs";

const validSignerOutput = `Verifies
Verified using v1 scheme (JAR signing): false
Verified using v2 scheme (APK Signature Scheme v2): true
Verified using v3 scheme (APK Signature Scheme v3): false
Verified using v3.1 scheme (APK Signature Scheme v3.1): false
Verified using v4 scheme (APK Signature Scheme v4): false
Verified for SourceStamp: false
Number of signers: 1
Signer #1 certificate DN: C=US, O=Android, CN=Android Debug
Signer #1 certificate SHA-256 digest: 16775a00f42bf0d89e957a51ad19c0b55b5494a28934a27043eb52e7745bddc6
`;

function write(path, contents) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, contents);
}

function writeExecutable(path) {
  write(path, "#!/bin/sh\nexit 0\n");
  chmodSync(path, 0o755);
}

test("accepts exactly one canonical Android debug signer using v2+", () => {
  assert.deepEqual(parseAndAssertDebugApkSigner(validSignerOutput), {
    classification: "android-debug",
    certificateDn: "C=US, O=Android, CN=Android Debug",
    certificateSha256:
      "16775a00f42bf0d89e957a51ad19c0b55b5494a28934a27043eb52e7745bddc6",
    verifiedSchemes: ["v2"],
  });
});

test("rejects production or otherwise non-debug certificate DNs", () => {
  assert.throws(
    () =>
      parseAndAssertDebugApkSigner(
        validSignerOutput.replace(
          "C=US, O=Android, CN=Android Debug",
          "C=US, O=Example Corp, CN=Production Release",
        ),
      ),
    /canonical Android debug signer/u,
  );
});

test("rejects multiple signers even when signer one is canonical", () => {
  assert.throws(
    () =>
      parseAndAssertDebugApkSigner(
        validSignerOutput.replace(
          "Number of signers: 1",
          "Number of signers: 2",
        ),
      ),
    /exactly one signer/u,
  );
});

test("rejects an APK without a verified v2-or-stronger scheme", () => {
  assert.throws(
    () =>
      parseAndAssertDebugApkSigner(
        validSignerOutput.replace(
          "Verified using v2 scheme (APK Signature Scheme v2): true",
          "Verified using v2 scheme (APK Signature Scheme v2): false",
        ),
      ),
    /v2 or stronger/u,
  );
});

test("rejects malformed or incomplete apksigner output", () => {
  assert.throws(
    () => parseAndAssertDebugApkSigner("Verifies\nNumber of signers: 1\n"),
    /certificate DN/u,
  );
  assert.throws(
    () => parseAndAssertDebugApkSigner(""),
    /empty or malformed/u,
  );
});

test("resolves the highest installed executable apksigner", (t) => {
  const root = mkdtempSync(join(tmpdir(), "family-budget-sdk-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  writeExecutable(join(root, "build-tools/35.0.0/apksigner"));
  writeExecutable(join(root, "build-tools/36.0.0/apksigner"));
  write(join(root, "local.properties"), `sdk.dir=${root}\n`);

  const result = resolveApkSigner({
    env: {},
    localPropertiesPath: join(root, "local.properties"),
  });
  assert.equal(result.version, "36.0.0");
  assert.equal(result.source, "local.properties");
  assert.equal(
    result.path,
    realpathSync(join(root, "build-tools/36.0.0/apksigner")),
  );
});

test("fails closed when JAVA_HOME or the apksigner command is unavailable", (t) => {
  const root = mkdtempSync(join(tmpdir(), "family-budget-signer-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const sdkRoot = join(root, "sdk");
  const javaHome = join(root, "jdk");
  writeExecutable(join(sdkRoot, "build-tools/36.0.0/apksigner"));
  writeExecutable(join(javaHome, "bin/java"));

  assert.throws(
    () =>
      verifyDebugApkSigner({
        apkPath: join(root, "app-debug.apk"),
        env: { ANDROID_HOME: sdkRoot },
      }),
    /JAVA_HOME is required/u,
  );
  assert.throws(
    () =>
      resolveApkSigner({
        env: { ANDROID_HOME: join(root, "missing-sdk") },
      }),
    /no executable apksigner/u,
  );
  assert.throws(
    () =>
      verifyDebugApkSigner({
        apkPath: join(root, "app-debug.apk"),
        env: { ANDROID_HOME: sdkRoot, JAVA_HOME: javaHome },
        runner() {
          const error = new Error("private tool output must not leak");
          error.status = 23;
          throw error;
        },
      }),
    /command failed \(exit code 23\)/u,
  );
});

test("rejects artifacts older than authored and generated native build inputs", (t) => {
  const packageRoot = mkdtempSync(join(tmpdir(), "family-budget-android-"));
  t.after(() => rmSync(packageRoot, { recursive: true, force: true }));

  const androidRoot = join(packageRoot, "android");
  const artifact = join(androidRoot, "app/build/outputs/apk/debug/app-debug.apk");
  const inputs = [
    join(androidRoot, "app/src/main/res/values/strings.xml"),
    join(androidRoot, "app/src/main/res/layout/activity_main.xml"),
    join(androidRoot, "settings.gradle"),
    join(androidRoot, "capacitor.settings.gradle"),
    join(androidRoot, "app/capacitor.build.gradle"),
    join(androidRoot, "app/src/main/res/xml/config.xml"),
    join(androidRoot, "capacitor-cordova-android-plugins/build.gradle"),
    join(
      androidRoot,
      "capacitor-cordova-android-plugins/src/main/AndroidManifest.xml",
    ),
  ];

  write(join(packageRoot, "capacitor.config.ts"), "export default {};\n");
  write(artifact, "test artifact");
  write(inputs[0], "<resources />\n");
  write(inputs[1], "<LinearLayout />\n");
  write(inputs[2], 'rootProject.name = "test"\n');
  write(inputs[3], 'include ":app"\n');
  write(inputs[4], "android {}\n");
  write(inputs[5], "<widget />\n");
  write(inputs[6], "apply plugin: 'com.android.library'\n");
  write(inputs[7], "<manifest />\n");

  const originalContents = inputs.map((path) => readFileSync(path));
  const older = new Date(Date.now() - 60_000);
  const newer = new Date(Date.now());
  utimesSync(artifact, older, older);
  for (const input of inputs) {
    utimesSync(input, newer, newer);
  }

  const artifactInputs = collectArtifactInputs({ packageRoot, androidRoot });
  for (const input of inputs) {
    assert(artifactInputs.includes(input), `missing recursive input ${input}`);
  }

  assert.throws(
    () => assertArtifactIsCurrent(artifact, artifactInputs, packageRoot),
    (error) => {
      assert.match(error.message, /app\/src\/main\/res\/values\/strings\.xml/u);
      assert.match(error.message, /app\/src\/main\/res\/layout\/activity_main\.xml/u);
      assert.match(error.message, /android\/settings\.gradle/u);
      assert.match(error.message, /android\/capacitor\.settings\.gradle/u);
      assert.match(error.message, /android\/app\/capacitor\.build\.gradle/u);
      assert.match(error.message, /android\/app\/src\/main\/res\/xml\/config\.xml/u);
      assert.match(
        error.message,
        /android\/capacitor-cordova-android-plugins\/build\.gradle/u,
      );
      assert.match(
        error.message,
        /android\/capacitor-cordova-android-plugins\/src\/main\/AndroidManifest\.xml/u,
      );
      return true;
    },
  );

  assert.deepEqual(
    inputs.map((path) => readFileSync(path)),
    originalContents,
    "staleness validation must not modify build inputs",
  );
});

const BASE_POLICY =
  "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; " +
  "font-src 'self'; connect-src 'self'; worker-src 'self'; manifest-src 'self'; " +
  "object-src 'none'; base-uri 'none'; form-action 'none'";

function pageWithPolicy(policy) {
  return [
    "<!doctype html>",
    "<html lang=\"ru\">",
    "  <head>",
    "    <meta",
    "      http-equiv=\"Content-Security-Policy\"",
    `      content="${policy}"`,
    "    />",
    "  </head>",
    "  <body></body>",
    "</html>",
  ].join("\n");
}

const RECEIVER_PERMISSION =
  "com.edfurman.nashbudget.DYNAMIC_RECEIVER_NOT_EXPORTED_PERMISSION";

test("a page whose policy names no server is the default local-only build", () => {
  assert.equal(resolveConfiguredSyncOrigin(pageWithPolicy(BASE_POLICY)), null);
  assert.deepEqual(expectedManifestPermissions(RECEIVER_PERMISSION, null), [
    RECEIVER_PERMISSION,
  ]);
});

test("a page whose policy names one https origin is a configured build", () => {
  for (const origin of [
    "https://sync.example.org",
    "https://sync.example.org:8443",
    "https://[2001:db8::1]:8443",
  ]) {
    const page = pageWithPolicy(
      BASE_POLICY.replace("connect-src 'self'", `connect-src 'self' ${origin}`),
    );
    assert.equal(resolveConfiguredSyncOrigin(page), origin);
    assert.deepEqual(expectedManifestPermissions(RECEIVER_PERMISSION, origin), [
      RECEIVER_PERMISSION,
      INTERNET_PERMISSION,
    ]);
  }
});

test("an address this shell cannot reach is a build failure, not a local build", () => {
  // http is refused twice on the device — by the mixed-content rule of a page served over
  // https://localhost and by cleartextTrafficPermitted=false — so a build carrying one would
  // install and silently never sync. The scan has to say so before the artifact exists.
  for (const source of [
    "http://sync.example.org",
    "http://10.0.2.2:8787",
    "*",
    "https://*.example.org",
    "https://sync.example.org/v1",
    "ws://sync.example.org",
  ]) {
    const page = pageWithPolicy(
      BASE_POLICY.replace("connect-src 'self'", `connect-src 'self' ${source}`),
    );
    assert.throws(() => resolveConfiguredSyncOrigin(page), /cannot reach/u, source);
  }
});

test("more than one remote source is refused rather than reduced to the first", () => {
  const page = pageWithPolicy(
    BASE_POLICY.replace(
      "connect-src 'self'",
      "connect-src 'self' https://sync.example.org https://other.example.org",
    ),
  );
  assert.throws(() => resolveConfiguredSyncOrigin(page), /more than one source/u);
});

test("a page without a policy or without connect-src is refused", () => {
  assert.throws(
    () => resolveConfiguredSyncOrigin("<!doctype html><html><head></head></html>"),
    /no Content-Security-Policy meta tag/u,
  );
  assert.throws(
    () => resolveConfiguredSyncOrigin(pageWithPolicy("default-src 'none'; script-src 'self'")),
    /no connect-src directive/u,
  );
});

test("the packaged production page and the Gradle rule agree on both build modes", () => {
  // The two implementations that must not drift: this one, and the connect-src match in
  // apps/android/android/app/build.gradle that decides whether INTERNET is merged in.
  const gradle = readFileSync(
    join(import.meta.dirname, "../android/app/build.gradle"),
    "utf8",
  );
  const rule = gradle.match(/packagedConnectSrc = packagedIndexHtml =~ \/(.+?)\/\n/u)?.[1];
  assert.ok(rule, "the Gradle build no longer derives the network permission from connect-src");
  const gradleSaysConfigured = (page) => {
    const match = page.match(new RegExp(rule, "u"));
    return match !== null && /https?:\/\//u.test(match[1]);
  };
  const localPage = pageWithPolicy(BASE_POLICY);
  const configuredPage = pageWithPolicy(
    BASE_POLICY.replace("connect-src 'self'", "connect-src 'self' https://sync.example.org"),
  );
  assert.equal(gradleSaysConfigured(localPage), resolveConfiguredSyncOrigin(localPage) !== null);
  assert.equal(
    gradleSaysConfigured(configuredPage),
    resolveConfiguredSyncOrigin(configuredPage) !== null,
  );
});

test("system Back walks the web history and hands an exhausted one to the system", () => {
  const source = readFileSync(
    new URL("../android/app/src/main/java/com/edfurman/nashbudget/MainActivity.java", import.meta.url),
    "utf8",
  );
  assert.deepEqual(backNavigationProblems(source), []);
  // The rule catches the shapes it exists for: no callback, or a callback that closes the app.
  const before = `package x;\nimport com.getcapacitor.BridgeActivity;\npublic class MainActivity extends BridgeActivity {}\n`;
  assert.ok(backNavigationProblems(before).length >= 4);
  assert.ok(
    backNavigationProblems(source.replace("webView.goBack();", "finish();"))
      .some((problem) => problem.includes("finish")),
  );
});
