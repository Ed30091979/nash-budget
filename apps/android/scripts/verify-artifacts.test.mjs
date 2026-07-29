import assert from "node:assert/strict";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
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

function write(path, contents) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, contents);
}

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
