import { existsSync, readdirSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";

const excludedDirectoryNames = new Set([".gradle", "build"]);

export function listNativeBuildInputs(root) {
  if (!existsSync(root)) {
    return [];
  }

  const found = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (entry.isDirectory() && excludedDirectoryNames.has(entry.name)) {
      continue;
    }

    const path = join(root, entry.name);
    if (entry.isDirectory()) {
      found.push(...listNativeBuildInputs(path));
    } else if (entry.isFile() && entry.name !== "local.properties") {
      found.push(path);
    }
  }
  return found.sort();
}

export function collectArtifactInputs({ packageRoot, androidRoot }) {
  const appRoot = join(androidRoot, "app");
  const recursiveInputs = listNativeBuildInputs(androidRoot);
  const generatedWebAssets = join(appRoot, "src/main/assets/public");
  const byteVerifiedConfigAssets = new Set([
    join(appRoot, "src/main/assets/capacitor.config.json"),
    join(appRoot, "src/main/assets/capacitor.plugins.json"),
  ]);

  return [
    ...new Set([join(packageRoot, "capacitor.config.ts"), ...recursiveInputs]),
  ]
    .filter(
      (path) =>
        existsSync(path) &&
        !byteVerifiedConfigAssets.has(path) &&
        !path.startsWith(`${generatedWebAssets}${sep}`),
    )
    .sort();
}

export function assertArtifactIsCurrent(artifact, inputs, baseRoot) {
  const artifactTime = statSync(artifact).mtimeMs;
  const newerInputs = inputs
    .filter((input) => statSync(input).mtimeMs > artifactTime)
    .map((input) => relative(baseRoot, input));

  if (newerInputs.length > 0) {
    throw new Error(
      `Android artifact scan failed: ${relative(baseRoot, artifact)} is stale; newer inputs: ${newerInputs.join(", ")}`,
    );
  }
}
