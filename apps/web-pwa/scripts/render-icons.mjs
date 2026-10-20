// Рисует растры манифеста из public/app-icon.svg: icon-192 (any, со скруглением), icon-512 (maskable,
// во весь холст) и apple-touch-icon (во весь холст: форму даёт система).
//
// Источник один — public/app-icon.svg; его цвета — значения :root из styles.css, и src/app-icon.test.ts
// это сверяет. Каждый растр отрисовывается в Chromium (Playwright из devDependencies, без внешних
// загрузок и библиотек) при плотности 1 на прозрачном фоне и записывается RGBA 8 бит — манифест и
// проверка ждут один формат у всех трёх, даже у непрозрачных (Chromium сам пишет их RGB).
// У icon-512 и apple-touch-icon скругление снято: под любой маской системы в углу — холст, а не
// прозрачность.
//
// Запуск из каталога приложения: node scripts/render-icons.mjs
// Проверка того, что получилось, — src/app-icon.test.ts.
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { crc32, deflateSync } from "node:zlib";

import { chromium } from "@playwright/test";

import { decodePng } from "../src/png.ts";

/** PNG RGBA 8 бит без фильтров: тот же снимок, один формат у всех растров манифеста. */
function encodeRgba(image) {
  const stride = image.width * 4;
  const raw = Buffer.alloc((stride + 1) * image.height);
  for (let y = 0; y < image.height; y += 1) {
    raw[y * (stride + 1)] = 0;
    Buffer.from(image.rgba.buffer, image.rgba.byteOffset + y * stride, stride).copy(raw, y * (stride + 1) + 1);
  }
  const chunk = (type, data) => {
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, "latin1"), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body) >>> 0);
    return Buffer.concat([length, body, crc]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(image.width, 0);
  header.writeUInt32BE(image.height, 4);
  header[8] = 8;
  header[9] = 6;
  return Buffer.concat([
    Buffer.from("89504e470d0a1a0a", "hex"),
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

const appDirectory = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const publicDirectory = join(appDirectory, "public");
const source = readFileSync(join(publicDirectory, "app-icon.svg"), "utf8");

if (!source.includes('clip-path="url(#shape)"')) {
  throw new Error("app-icon.svg: не найдено скругление clip-path=\"url(#shape)\" — растры во весь холст рисовать не из чего");
}

/** Значок во весь холст: та же геометрия без скругления. */
const fullBleed = source.replace(' clip-path="url(#shape)"', "");

const ICONS = [
  { name: "icon-192.png", size: 192, svg: source },
  { name: "icon-512.png", size: 512, svg: fullBleed },
  { name: "apple-touch-icon.png", size: 180, svg: fullBleed },
];

const browser = await chromium.launch();
try {
  for (const icon of ICONS) {
    const context = await browser.newContext({
      viewport: { width: icon.size, height: icon.size },
      deviceScaleFactor: 1,
      colorScheme: "light",
    });
    const page = await context.newPage();
    const svg = icon.svg.replace("<svg ", `<svg width="${icon.size}" height="${icon.size}" `);
    await page.setContent(
      `<!doctype html><html><head><meta charset="utf-8"><style>html,body{margin:0;background:transparent}svg{display:block}</style></head>` +
        `<body>${svg}</body></html>`,
    );
    const shot = await page.screenshot({ type: "png", omitBackground: true });
    await context.close();
    const image = decodePng(shot);
    if (image.width !== icon.size || image.height !== icon.size) {
      throw new Error(`${icon.name}: снимок ${image.width}×${image.height}, ожидалось ${icon.size}×${icon.size}`);
    }
    const png = encodeRgba(image);
    writeFileSync(join(publicDirectory, icon.name), png);
    process.stdout.write(`${icon.name.padEnd(22)} ${String(icon.size).padStart(3)}×${icon.size}  ${(png.length / 1024).toFixed(1)} KB\n`);
  }
} finally {
  await browser.close();
}
