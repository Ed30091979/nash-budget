import { execFileSync } from "node:child_process";
import {
  accessSync,
  constants,
  existsSync,
  readFileSync,
  readdirSync,
  realpathSync,
  statSync,
} from "node:fs";
import { join, relative, resolve, sep } from "node:path";

const EXPECTED_DEBUG_DN = new Map([
  ["C", "US"],
  ["O", "Android"],
  ["CN", "Android Debug"],
]);

function fail(message) {
  throw new Error(`APK signer policy failed: ${message}`);
}

function isContainedBy(parent, child) {
  const path = relative(parent, child);
  return path === "" || (!path.startsWith(`..${sep}`) && path !== "..");
}

function isExecutableFile(path) {
  try {
    return statSync(path).isFile() && accessSync(path, constants.X_OK) === undefined;
  } catch {
    return false;
  }
}

function unescapeProperty(value) {
  return value.replace(/\\([\\:= ])/gu, "$1");
}

function readLocalSdkRoot(localPropertiesPath) {
  if (!localPropertiesPath || !existsSync(localPropertiesPath)) {
    return null;
  }
  const matches = readFileSync(localPropertiesPath, "utf8")
    .split(/\r?\n/gu)
    .filter((line) => !/^\s*[#!]/u.test(line))
    .map((line) => line.match(/^\s*sdk\.dir\s*[:=]\s*(.*?)\s*$/u))
    .filter(Boolean);
  if (matches.length > 1) {
    fail("android/local.properties defines sdk.dir more than once");
  }
  const value = matches[0]?.[1];
  return value ? unescapeProperty(value) : null;
}

function compareBuildToolsVersions(left, right) {
  const parse = (version) => {
    const [core, ...suffix] = version.split("-");
    return {
      numbers: core.split(".").map((part) => Number.parseInt(part, 10)),
      suffix: suffix.join("-"),
    };
  };
  const a = parse(left);
  const b = parse(right);
  const length = Math.max(a.numbers.length, b.numbers.length);
  for (let index = 0; index < length; index += 1) {
    const difference = (a.numbers[index] ?? 0) - (b.numbers[index] ?? 0);
    if (difference !== 0) {
      return difference;
    }
  }
  if (!a.suffix && b.suffix) {
    return 1;
  }
  if (a.suffix && !b.suffix) {
    return -1;
  }
  return a.suffix.localeCompare(b.suffix, "en");
}

export function resolveApkSigner({
  env = process.env,
  localPropertiesPath,
} = {}) {
  const roots = [
    ["ANDROID_HOME", env.ANDROID_HOME],
    ["ANDROID_SDK_ROOT", env.ANDROID_SDK_ROOT],
    ["local.properties", readLocalSdkRoot(localPropertiesPath)],
  ]
    .filter(([, value]) => typeof value === "string" && value.trim() !== "")
    .map(([source, value]) => [source, resolve(value)]);

  const uniqueRoots = new Map();
  for (const [source, root] of roots) {
    if (!uniqueRoots.has(root)) {
      uniqueRoots.set(root, source);
    }
  }

  const candidates = [];
  for (const [sdkRoot, source] of uniqueRoots) {
    const buildToolsPath = join(sdkRoot, "build-tools");
    if (!existsSync(buildToolsPath) || !statSync(buildToolsPath).isDirectory()) {
      continue;
    }
    const realBuildToolsPath = realpathSync(buildToolsPath);
    for (const entry of readdirSync(buildToolsPath, { withFileTypes: true })) {
      if (
        !entry.isDirectory() ||
        !/^\d+(?:\.\d+)*(?:-[0-9A-Za-z.-]+)?$/u.test(entry.name)
      ) {
        continue;
      }
      const path = join(buildToolsPath, entry.name, "apksigner");
      if (!isExecutableFile(path)) {
        continue;
      }
      const realPath = realpathSync(path);
      if (!isContainedBy(realBuildToolsPath, realPath)) {
        continue;
      }
      candidates.push({ path: realPath, source, version: entry.name });
    }
  }

  candidates.sort((left, right) =>
    compareBuildToolsVersions(right.version, left.version),
  );
  if (candidates.length === 0) {
    fail("no executable apksigner found in installed Android SDK build-tools");
  }
  return candidates[0];
}

function uniqueMatch(output, pattern, label) {
  const matches = [...output.matchAll(pattern)];
  if (matches.length !== 1) {
    fail(`expected exactly one ${label}`);
  }
  return matches[0][1];
}

function normalizeDebugDn(dn) {
  const attributes = new Map();
  for (const component of dn.split(",")) {
    const match = component.trim().match(/^([A-Za-z]+)\s*=\s*(.+)$/u);
    if (!match) {
      fail("debug certificate DN is malformed");
    }
    const key = match[1].toUpperCase();
    const value = match[2].trim();
    if (
      attributes.has(key) ||
      !EXPECTED_DEBUG_DN.has(key) ||
      value !== EXPECTED_DEBUG_DN.get(key)
    ) {
      fail("certificate is not the canonical Android debug signer");
    }
    attributes.set(key, value);
  }
  if (
    attributes.size !== EXPECTED_DEBUG_DN.size ||
    [...EXPECTED_DEBUG_DN.keys()].some((key) => !attributes.has(key))
  ) {
    fail("certificate is not the canonical Android debug signer");
  }
  return "C=US, O=Android, CN=Android Debug";
}

export function parseAndAssertDebugApkSigner(output) {
  if (typeof output !== "string" || output.trim() === "") {
    fail("apksigner returned empty or malformed output");
  }
  if ((output.match(/^Verifies\s*$/gmu) ?? []).length !== 1) {
    fail("apksigner did not report an unambiguous successful verification");
  }

  const signerCount = Number.parseInt(
    uniqueMatch(output, /^Number of signers:\s*(\d+)\s*$/gmu, "signer count"),
    10,
  );
  if (signerCount !== 1) {
    fail("debug APK must have exactly one signer");
  }

  const signerDnMatches = [
    ...output.matchAll(/^Signer #(\d+) certificate DN:\s*(.+?)\s*$/gmu),
  ];
  if (
    signerDnMatches.length !== 1 ||
    signerDnMatches[0][1] !== "1"
  ) {
    fail("expected exactly one signer certificate DN");
  }
  const certificateDn = normalizeDebugDn(signerDnMatches[0][2]);

  const digest = uniqueMatch(
    output,
    /^Signer #1 certificate SHA-256 digest:\s*([0-9A-Fa-f]{64})\s*$/gmu,
    "signer certificate SHA-256 digest",
  ).toLowerCase();

  const schemeMatches = [
    ...output.matchAll(
      /^Verified using v(\d+(?:\.\d+)?) scheme(?:\s*\([^)]*\))?:\s*(true|false)\s*$/gmu,
    ),
  ];
  if (schemeMatches.length === 0) {
    fail("no APK signature scheme results were reported");
  }
  const schemeVersions = new Set();
  const verifiedSchemes = [];
  for (const [, version, result] of schemeMatches) {
    if (schemeVersions.has(version)) {
      fail("duplicate APK signature scheme result");
    }
    schemeVersions.add(version);
    if (result === "true") {
      verifiedSchemes.push(`v${version}`);
    }
  }
  if (
    !verifiedSchemes.some(
      (scheme) => Number.parseFloat(scheme.slice(1)) >= 2,
    )
  ) {
    fail("debug APK must verify with APK Signature Scheme v2 or stronger");
  }

  return {
    classification: "android-debug",
    certificateDn,
    certificateSha256: digest,
    verifiedSchemes,
  };
}

export function verifyDebugApkSigner({
  apkPath,
  env = process.env,
  localPropertiesPath,
  runner = execFileSync,
}) {
  const javaHome = env.JAVA_HOME;
  if (typeof javaHome !== "string" || javaHome.trim() === "") {
    fail("JAVA_HOME is required to run apksigner");
  }
  const javaExecutable = join(resolve(javaHome), "bin", "java");
  if (!isExecutableFile(javaExecutable)) {
    fail("JAVA_HOME does not provide an executable bin/java");
  }

  const apksigner = resolveApkSigner({ env, localPropertiesPath });
  let output;
  try {
    output = runner(
      apksigner.path,
      ["verify", "--verbose", "--print-certs", apkPath],
      {
        encoding: "utf8",
        env,
        maxBuffer: 1024 * 1024,
      },
    );
  } catch (error) {
    const status = Number.isInteger(error?.status) ? ` (exit code ${error.status})` : "";
    fail(`apksigner verification command failed${status}`);
  }

  return {
    ...parseAndAssertDebugApkSigner(output),
    buildToolsVersion: apksigner.version,
  };
}
