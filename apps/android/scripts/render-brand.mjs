// Рисует растры обёртки из того же знака и той же палитры, что значок и экран запуска iOS.
//
// Что рисуется (все пять плотностей: mdpi 1, hdpi 1.5, xhdpi 2, xxhdpi 3, xxxhdpi 4):
//   drawable-*/splash_logo.png       — знак 108 dp на прозрачном: слой поверх @color/canvas в splash.xml;
//   mipmap-*/ic_launcher_foreground  — знак на прозрачном 108 dp, целиком в безопасной зоне 66 dp
//                                      адаптивного значка (подложка — @color/canvas);
//   mipmap-*/ic_launcher(_round)     — значки для API 24–25: геометрия public/app-icon.svg на 48 dp,
//                                      со скруглением и кругом.
// Геометрия знака задана чётными dp, поэтому при ×1.5 и целых плотностях каждый край ложится на
// пиксель: цветов ровно три, без сглаживания. Значки 48 dp повторяют веб-значок и сглаживаются, как
// и он. Палитра читается из :root apps/web-pwa/src/styles.css в момент отрисовки.
//
// Playwright и кодек PNG берутся у веб-приложения (devDependencies и src/png.ts): внешних
// загрузок и библиотек нет. Запуск: pnpm --filter @family-budget/android render:brand
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { readWebPalette } from "./brand-palette.mjs";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const webRoot = resolve(packageRoot, "../web-pwa");
const resRoot = join(packageRoot, "android/app/src/main/res");

const requireFromWeb = createRequire(join(webRoot, "package.json"));
const playwright = await import(pathToFileURL(requireFromWeb.resolve("@playwright/test")).href);
const chromium = playwright.chromium ?? playwright.default?.chromium;
if (chromium === undefined) throw new Error("Playwright не найден в devDependencies веб-приложения");
const { countColors, decodePng, encodePng } = await import(pathToFileURL(join(webRoot, "src/png.ts")).href);

const palette = readWebPalette(join(webRoot, "src/styles.css"));

export const DENSITIES = [
  ["mdpi", 1],
  ["hdpi", 1.5],
  ["xhdpi", 2],
  ["xxhdpi", 3],
  ["xxxhdpi", 4],
];

/** Знак заставки: 108 dp, пропорции насечки значка, все координаты чётные. */
function splashLogoSvg() {
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="108" height="108" viewBox="0 0 108 108">` +
    `<g transform="translate(0 4)">` +
    `<rect x="0" y="36" width="72" height="28" fill="${palette.ink}"/>` +
    `<rect x="86" y="36" width="22" height="28" fill="${palette.ink}"/>` +
    `<rect x="76" y="0" width="6" height="100" fill="${palette.orange}"/>` +
    `</g></svg>`
  );
}

/** Передний план адаптивного значка: знак 56×52 dp по центру полотна 108 dp — дальний угол на 29,5 dp от центра. */
function launcherForegroundSvg() {
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="108" height="108" viewBox="0 0 108 108">` +
    `<g transform="translate(26 28)">` +
    `<rect x="0" y="18" width="36" height="14" fill="${palette.ink}"/>` +
    `<rect x="44" y="18" width="12" height="14" fill="${palette.ink}"/>` +
    `<rect x="38" y="0" width="4" height="52" fill="${palette.orange}"/>` +
    `</g></svg>`
  );
}

/** Значок API 24–25: веб-значок (public/app-icon.svg) на 48 dp, форма — скругление 112/512 или круг. */
function legacyLauncherSvg(round) {
  const shape = round
    ? `<circle cx="256" cy="256" r="256"/>`
    : `<rect width="512" height="512" rx="112"/>`;
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="48" height="48" viewBox="0 0 512 512">` +
    `<defs><clipPath id="shape">${shape}</clipPath></defs>` +
    `<g clip-path="url(#shape)">` +
    `<rect width="512" height="512" fill="${palette.canvas}"/>` +
    `<rect x="96" y="213" width="213" height="86" fill="${palette.ink}"/>` +
    `<rect x="352" y="213" width="64" height="86" fill="${palette.ink}"/>` +
    `<rect x="320" y="107" width="21" height="298" fill="${palette.orange}"/>` +
    `</g></svg>`
  );
}

const ASSETS = [
  { dir: "drawable", name: "splash_logo.png", dp: 108, svg: splashLogoSvg(), crisp: true },
  { dir: "mipmap", name: "ic_launcher_foreground.png", dp: 108, svg: launcherForegroundSvg(), crisp: true },
  { dir: "mipmap", name: "ic_launcher.png", dp: 48, svg: legacyLauncherSvg(false), crisp: false },
  { dir: "mipmap", name: "ic_launcher_round.png", dp: 48, svg: legacyLauncherSvg(true), crisp: false },
];

const browser = await chromium.launch();
const rows = [];
try {
  for (const asset of ASSETS) {
    for (const [qualifier, density] of DENSITIES) {
      const context = await browser.newContext({
        viewport: { width: asset.dp, height: asset.dp },
        deviceScaleFactor: density,
        colorScheme: "light",
      });
      const page = await context.newPage();
      await page.setContent(
        `<!doctype html><html><head><meta charset="utf-8"><style>html,body{margin:0;background:transparent}svg{display:block}</style></head>` +
          `<body>${asset.svg}</body></html>`,
      );
      const shot = await page.screenshot({ type: "png", omitBackground: true });
      await context.close();

      const image = decodePng(shot);
      const expected = asset.dp * density;
      if (image.width !== expected || image.height !== expected) {
        throw new Error(`${asset.name}@${qualifier}: снимок ${image.width}×${image.height}, ожидалось ${expected}`);
      }
      const colors = countColors(image);
      // Прозрачность, чернила и оранжевый — ровно три. Четвёртый цвет — сглаженный край, то есть
      // знак сошёл с пиксельной сетки; для значков 48 dp сглаживание ожидаемо.
      if (asset.crisp && colors !== 3) {
        throw new Error(`${asset.name}@${qualifier}: цветов ${colors}, ожидалось 3 (прозрачность, чернила, оранжевый)`);
      }
      const packed = encodePng(image);
      const directory = join(resRoot, `${asset.dir}-${qualifier}`);
      mkdirSync(directory, { recursive: true });
      writeFileSync(join(directory, asset.name), packed);
      rows.push({ file: `${asset.dir}-${qualifier}/${asset.name}`, size: `${image.width}×${image.height}`, raw: shot.length, packed: packed.length });
    }
  }
} finally {
  await browser.close();
}

const kb = (bytes) => `${(bytes / 1024).toFixed(1)} KB`;
for (const row of rows) {
  process.stdout.write(`${row.file.padEnd(44)} ${row.size.padEnd(10)} ${kb(row.raw).padStart(8)} → ${kb(row.packed).padStart(8)}\n`);
}
process.stdout.write(
  `\n${rows.length} растров, палитра ${palette.canvas} / ${palette.ink} / ${palette.orange} из ${readFileSync(join(webRoot, "src/styles.css"), "utf8").length} байт styles.css.\n`,
);
