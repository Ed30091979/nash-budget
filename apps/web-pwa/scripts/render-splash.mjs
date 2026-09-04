// Рисует картинки запуска iOS и вписывает ссылки на них в index.html.
//
// Источник один — src/splash.ts: таблица экранов, знак и правила именования. Каждая картинка
// отрисовывается в Chromium (Playwright из devDependencies, без внешних загрузок и библиотек) из
// SVG в пунктах при плотности экрана, как это сделано для значка. Пиксели снимка затем
// упаковываются палитрой (src/png.ts) — те же пиксели, вчетверо-впятеро меньше байт — и ложатся в
// public/splash/. Блок <link rel="apple-touch-startup-image"> в index.html переписывается между
// метками целиком. Палитра — значения :root из styles.css, прочитанные в момент отрисовки.
//
// Запуск из каталога приложения: node scripts/render-splash.mjs
// Проверка того, что получилось, — src/splash.test.ts.
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { chromium } from "@playwright/test";

import { countColors, decodePng, encodePng } from "../src/png.ts";
import {
  SPLASH_DEVICES,
  SPLASH_DIRECTORY,
  SPLASH_LINKS_END,
  SPLASH_LINKS_START,
  SPLASH_ORIENTATIONS,
  splashFileName,
  splashLinksBlock,
  splashPaletteFromStyles,
  splashPixels,
  splashPoints,
  splashSvg,
} from "../src/splash.ts";

const appDirectory = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const publicDirectory = join(appDirectory, "public");
const splashDirectory = join(publicDirectory, SPLASH_DIRECTORY);
const indexPath = join(appDirectory, "index.html");

const palette = splashPaletteFromStyles(readFileSync(join(appDirectory, "src/styles.css"), "utf8"));

// Каталог пересобирается с нуля: картинка экрана, выбывшего из таблицы, не должна пережить таблицу.
if (existsSync(splashDirectory)) rmSync(splashDirectory, { recursive: true, force: true });
mkdirSync(splashDirectory, { recursive: true });

const browser = await chromium.launch();
const rows = [];
let rawTotal = 0;
let packedTotal = 0;
try {
  for (const device of SPLASH_DEVICES) {
    for (const orientation of SPLASH_ORIENTATIONS) {
      const points = splashPoints(device, orientation);
      const pixels = splashPixels(device, orientation);
      const context = await browser.newContext({
        viewport: { width: points.width, height: points.height },
        deviceScaleFactor: device.scale,
        colorScheme: "light",
      });
      const page = await context.newPage();
      await page.setContent(
        `<!doctype html><html><head><meta charset="utf-8"><style>html,body{margin:0;height:100%;overflow:hidden;background:${palette.canvas}}svg{display:block}</style></head>` +
          `<body>${splashSvg(points.width, points.height, palette)}</body></html>`,
      );
      const shot = await page.screenshot({ type: "png", fullPage: false });
      await context.close();

      const image = decodePng(shot);
      if (image.width !== pixels.width || image.height !== pixels.height) {
        throw new Error(
          `${splashFileName(device, orientation)}: снимок ${image.width}×${image.height}, ожидалось ${pixels.width}×${pixels.height}`,
        );
      }
      const colors = countColors(image);
      if (colors !== 3) {
        // Три цвета — признак того, что все края легли на пиксели. Четвёртый цвет — это
        // сглаживание, то есть знак сошёл с сетки, и упаковка палитрой перестала бы быть честной.
        throw new Error(`${splashFileName(device, orientation)}: цветов ${colors}, ожидалось 3`);
      }
      const packed = encodePng(image);
      const fileName = splashFileName(device, orientation);
      writeFileSync(join(splashDirectory, fileName), packed);
      rows.push({ fileName, models: device.models, raw: shot.length, packed: packed.length });
      rawTotal += shot.length;
      packedTotal += packed.length;
    }
  }
} finally {
  await browser.close();
}

// Блок ссылок в index.html: между метками — заменить, без меток — поставить после apple-touch-icon.
const index = readFileSync(indexPath, "utf8");
const block = splashLinksBlock();
const start = index.indexOf(SPLASH_LINKS_START);
const end = index.indexOf(SPLASH_LINKS_END);
let next;
if (start >= 0 && end > start) {
  const lineStart = index.lastIndexOf("\n", start) + 1;
  const lineEnd = end + SPLASH_LINKS_END.length;
  next = `${index.slice(0, lineStart)}${block}${index.slice(lineEnd)}`;
} else {
  const anchor = index.match(/^[ \t]*<link rel="apple-touch-icon"[^\n]*\n/mu);
  if (anchor === null || anchor.index === undefined) {
    throw new Error("index.html: не найдена ни метка блока, ни ссылка apple-touch-icon, после которой его ставить");
  }
  const at = anchor.index + anchor[0].length;
  next = `${index.slice(0, at)}${block}\n${index.slice(at)}`;
}
if (next !== index) writeFileSync(indexPath, next, "utf8");

const leftovers = readdirSync(splashDirectory).filter((name) => !rows.some((row) => row.fileName === name));
if (leftovers.length > 0) throw new Error(`лишние файлы в ${SPLASH_DIRECTORY}/: ${leftovers.join(", ")}`);

const kb = (bytes) => `${(bytes / 1024).toFixed(1)} KB`;
for (const row of rows) {
  process.stdout.write(`${row.fileName.padEnd(14)} ${kb(row.raw).padStart(9)} → ${kb(row.packed).padStart(8)}   ${row.models}\n`);
}
process.stdout.write(
  `\n${rows.length} картинок: снимки Chromium ${kb(rawTotal)}, упаковано ${kb(packedTotal)}; ` +
  `ссылок в index.html: ${rows.length}.\n`,
);
