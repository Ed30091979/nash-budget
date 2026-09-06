import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";

import { assertWrapperPalette, readWebPalette, readWrapperColors, wrapperPaletteProblems } from "./brand-palette.mjs";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const webRoot = resolve(packageRoot, "../web-pwa");
const androidRoot = join(packageRoot, "android");
const resRoot = join(androidRoot, "app/src/main/res");
const palette = readWebPalette(join(webRoot, "src/styles.css"));
const { decodePng, pixelAt } = await import(pathToFileURL(join(webRoot, "src/png.ts")).href);

const DENSITIES = [["mdpi", 1], ["hdpi", 1.5], ["xhdpi", 2], ["xxhdpi", 3], ["xxxhdpi", 4]];

function rgb(hex) {
  return [1, 3, 5].map((at) => Number.parseInt(hex.slice(at, at + 2), 16)).concat(255);
}

function write(path, contents) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, contents);
}

test("палитра приложения читается из :root, и это бумага, а не что-то по памяти", () => {
  assert.match(palette.canvas, /^#[0-9a-f]{6}$/u);
  assert.match(palette.ink, /^#[0-9a-f]{6}$/u);
  assert.match(palette.orange, /^#[0-9a-f]{6}$/u);
  assert.notEqual(palette.canvas, palette.ink);
});

test("обёртка целиком — фон WebView, colors.xml, заставка, значки, темы — сходится с :root", () => {
  assertWrapperPalette({
    palette,
    androidRoot,
    capacitorConfig: readFileSync(join(packageRoot, "capacitor.config.ts"), "utf8"),
  });
  assert.deepEqual(readWrapperColors(join(resRoot, "values/colors.xml")), palette);
});

test("тема не наследует DayNight и не красит строку состояния в тёмное", () => {
  const styles = readFileSync(join(resRoot, "values/styles.xml"), "utf8").replace(/<!--[\s\S]*?-->/gu, "");
  assert.doesNotMatch(styles, /DayNight/u);
  assert.match(styles, /parent="Theme\.AppCompat\.Light\.NoActionBar"/u);
  assert.match(styles, /<item name="android:windowLightStatusBar">true<\/item>/u);
  assert.match(styles, /<item name="android:windowBackground">@color\/canvas<\/item>/u);
  // Системная заставка Android 12+: фон и значок заданы явно, иначе библиотека подставит
  // тёмный фон и обобщённый значок Android.
  assert.match(styles, /<item name="windowSplashScreenBackground">@color\/canvas<\/item>/u);
  assert.match(styles, /<item name="windowSplashScreenAnimatedIcon">@mipmap\/ic_launcher<\/item>/u);
  const v27 = readFileSync(join(resRoot, "values-v27/styles.xml"), "utf8");
  assert.match(v27, /<item name="android:windowLightNavigationBar">true<\/item>/u);
});

test("расхождение ловится: тёмный фон WebView, чужой hex в теме, второй источник подложки", () => {
  const root = mkdtempSync(join(tmpdir(), "family-budget-brand-"));
  try {
    const res = join(root, "app/src/main/res");
    write(join(res, "values/colors.xml"), `<resources><color name="canvas">${palette.canvas}</color><color name="ink">${palette.ink}</color><color name="orange">${palette.orange}</color></resources>`);
    write(join(res, "values/styles.xml"), `<resources><style name="AppTheme" parent="Theme.AppCompat.DayNight.NoActionBar"><item name="android:windowBackground">#100904</item></style></resources>`);
    write(join(res, "drawable/splash.xml"), `<layer-list><item><color android:color="@color/canvas"/></item></layer-list>`);
    write(join(res, "mipmap-anydpi-v26/ic_launcher.xml"), `<adaptive-icon><background android:drawable="@color/canvas"/></adaptive-icon>`);
    write(join(res, "mipmap-anydpi-v26/ic_launcher_round.xml"), `<adaptive-icon><background android:drawable="@color/canvas"/></adaptive-icon>`);
    write(join(res, "values/ic_launcher_background.xml"), `<resources><color name="ic_launcher_background">#100904</color></resources>`);
    const problems = wrapperPaletteProblems({
      palette,
      androidRoot: root,
      capacitorConfig: { android: { backgroundColor: "#100904" } },
    });
    assert.ok(problems.some((p) => p.startsWith("capacitor backgroundColor #100904")), problems.join("\n"));
    assert.ok(problems.some((p) => p.includes("plugins.SystemBars.style не задан")), problems.join("\n"));
    assert.ok(problems.some((p) => p.includes("values/styles.xml задаёт цвет литералом: #100904")), problems.join("\n"));
    assert.ok(problems.some((p) => p.includes("values/styles.xml наследует тёмную")), problems.join("\n"));
    assert.ok(problems.some((p) => p.includes("ic_launcher_background.xml")), problems.join("\n"));
    assert.throws(() => assertWrapperPalette({ palette, androidRoot: root, capacitorConfig: "" }), /палитра обёртки разошлась/u);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

for (const [qualifier, density] of DENSITIES) {
  test(`растры ${qualifier}: размер по плотности, прозрачный фон, знак цветами :root`, () => {
    const px = (dp) => Math.round(dp * density);
    const read = (relative) => decodePng(readFileSync(join(resRoot, relative)));

    const splash = read(`drawable-${qualifier}/splash_logo.png`);
    assert.deepEqual([splash.width, splash.height], [px(108), px(108)]);
    assert.equal(pixelAt(splash, 0, 0)[3], 0, "угол заставки не прозрачен");
    assert.deepEqual(pixelAt(splash, px(36), px(54)), rgb(palette.ink));
    assert.deepEqual(pixelAt(splash, px(79), px(20)), rgb(palette.orange));
    assert.equal(pixelAt(splash, px(74), px(54))[3], 0, "разрыв полосы не прозрачен");

    const foreground = read(`mipmap-${qualifier}/ic_launcher_foreground.png`);
    assert.deepEqual([foreground.width, foreground.height], [px(108), px(108)]);
    assert.equal(pixelAt(foreground, 0, 0)[3], 0);
    // Безопасная зона адаптивного значка — круг 66 dp: всё за ним прозрачно.
    for (const [x, y] of [[px(20), px(20)], [px(88), px(88)], [px(54), px(16)], [px(54), px(92)]]) {
      assert.equal(pixelAt(foreground, x, y)[3], 0, `(${x}, ${y}) вне безопасной зоны непрозрачен`);
    }
    assert.deepEqual(pixelAt(foreground, px(26 + 18), px(28 + 25)), rgb(palette.ink));
    assert.deepEqual(pixelAt(foreground, px(26 + 40), px(28 + 4)), rgb(palette.orange));

    for (const name of ["ic_launcher.png", "ic_launcher_round.png"]) {
      const icon = read(`mipmap-${qualifier}/${name}`);
      assert.deepEqual([icon.width, icon.height], [px(48), px(48)]);
      assert.equal(pixelAt(icon, 0, 0)[3], 0, `${name}: угол не срезан`);
      assert.deepEqual(pixelAt(icon, px(24), px(4)), rgb(palette.canvas), `${name}: подложка не холст`);
      assert.deepEqual(pixelAt(icon, px(18), px(24)), rgb(palette.ink), `${name}: полосы нет`);
    }
  });
}
