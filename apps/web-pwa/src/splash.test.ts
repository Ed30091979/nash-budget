/// <reference types="node" />
import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { PWA_MANIFEST } from "../vite.config";
import { countColors, decodePng, encodePng, pixelAt, pngHeader, type PngImage, type Rgba } from "./png";
import {
  SPLASH_DEVICES,
  SPLASH_DIRECTORY,
  SPLASH_LINKS_END,
  SPLASH_LINKS_START,
  SPLASH_MARK,
  SPLASH_MARK_PROBES,
  SPLASH_ORIENTATIONS,
  splashFileName,
  splashHref,
  splashLinksBlock,
  splashMarkOrigin,
  splashMedia,
  splashPaletteFromStyles,
  splashPixels,
  splashPoints,
  type SplashDevice,
  type SplashOrientation,
} from "./splash";

/**
 * Экран запуска iOS живёт в трёх местах — таблица экранов, картинки в `public/splash/` и ссылки
 * в `index.html`, — и система читает только последние два. Разойдясь, они не падают: iOS молча
 * показывает белый экран, то есть ровно тот дефект, ради которого набор появился. Здесь все три
 * сверяются друг с другом и с `--canvas`: картинка, оставшаяся в прежней палитре после смены
 * палитры экранов, — это то, что уже случилось со значком.
 */
const html = readFileSync(new URL("../index.html", import.meta.url), "utf8");
const configSource = readFileSync(new URL("../vite.config.ts", import.meta.url), "utf8");
const palette = splashPaletteFromStyles(readFileSync(new URL("./styles.css", import.meta.url), "utf8"));
const splashDirectory = new URL(`../public/${SPLASH_DIRECTORY}/`, import.meta.url);

function rgb(hex: string): readonly [number, number, number, number] {
  return [1, 3, 5].map((at) => Number.parseInt(hex.slice(at, at + 2), 16)).concat(255) as unknown as readonly [
    number,
    number,
    number,
    number,
  ];
}

/** Ссылки запуска из разметки — из атрибутов, а не из текста комментариев рядом. */
function startupLinks(markup: string): { readonly media: string; readonly href: string }[] {
  return [...markup.matchAll(/<link\s+rel="apple-touch-startup-image"\s+media="([^"]*)"\s+href="([^"]*)"\s*\/>/gu)].map(
    (match) => ({ media: match[1] ?? "", href: match[2] ?? "" }),
  );
}

const cases: readonly (readonly [string, SplashDevice, SplashOrientation])[] = SPLASH_DEVICES.flatMap((device) =>
  SPLASH_ORIENTATIONS.map((orientation) => [splashFileName(device, orientation), device, orientation] as const),
);

describe("экран запуска iOS: разметка", () => {
  it("объявляет в index.html ровно тот блок, который следует из таблицы экранов, и ничего сверх него", () => {
    expect(html).toContain(splashLinksBlock());
    expect(html.indexOf(SPLASH_LINKS_START)).toBe(html.lastIndexOf(SPLASH_LINKS_START));
    expect(html.indexOf(SPLASH_LINKS_END)).toBe(html.lastIndexOf(SPLASH_LINKS_END));
    // Ссылки только внутри блока: ссылка снаружи пережила бы перезапись блока генератором.
    expect(startupLinks(html)).toHaveLength(SPLASH_DEVICES.length * SPLASH_ORIENTATIONS.length);
    expect(startupLinks(splashLinksBlock())).toHaveLength(SPLASH_DEVICES.length * SPLASH_ORIENTATIONS.length);
  });

  it("не повторяет ни одного экрана, и у каждого есть обе ориентации", () => {
    const keys = SPLASH_DEVICES.map((device) => `${device.width}x${device.height}@${device.scale}`);
    expect(new Set(keys).size).toBe(keys.length);
    const medias = startupLinks(html).map((link) => link.media);
    expect(new Set(medias).size).toBe(medias.length);
    for (const device of SPLASH_DEVICES) {
      for (const orientation of SPLASH_ORIENTATIONS) expect(medias).toContain(splashMedia(device, orientation));
    }
  });

  it("в альбомной ссылке оставляет портретные ширину и высоту экрана — так их ищет iOS", () => {
    for (const device of SPLASH_DEVICES) {
      const media = splashMedia(device, "landscape");
      expect(media).toContain(`(device-width: ${device.width}px) and (device-height: ${device.height}px)`);
      expect(media).toContain(`(-webkit-device-pixel-ratio: ${device.scale})`);
      expect(media).toContain("(orientation: landscape)");
      expect(device.width).toBeLessThan(device.height);
    }
  });

  it("каждая ссылка ведёт на файл в каталоге, и лишних файлов там нет", () => {
    const hrefs = startupLinks(html).map((link) => link.href);
    for (const href of hrefs) expect(href.startsWith(`/${SPLASH_DIRECTORY}/`)).toBe(true);
    const files = readdirSync(splashDirectory).sort();
    expect(files).toEqual(hrefs.map((href) => href.slice(href.lastIndexOf("/") + 1)).sort());
  });

  it("не отдаёт картинки в предзагрузку сервис-воркера", () => {
    // Их читает система при добавлении на экран «Домой», а не приложение: каждая установка
    // скачивала бы весь набор ради одной картинки, которую устройство уже получило.
    expect(configSource).toContain(`"**/${SPLASH_DIRECTORY}/**"`);
  });

  it("держит цвет заставки, theme-color и background_color манифеста одним `--canvas`", () => {
    const themeColor = html.match(/<meta name="theme-color" content="([^"]+)"/u)?.[1]?.toLowerCase();
    expect(themeColor).toBe(palette.canvas);
    expect(PWA_MANIFEST.background_color.toLowerCase()).toBe(palette.canvas);
    expect(PWA_MANIFEST.theme_color.toLowerCase()).toBe(palette.canvas);
  });
});

describe("экран запуска iOS: знак", () => {
  it("стоит на сетке целых пунктов и целиком помещается на самый маленький экран", () => {
    const numbers = [
      SPLASH_MARK.width,
      SPLASH_MARK.height,
      SPLASH_MARK.bar.y,
      SPLASH_MARK.bar.height,
      SPLASH_MARK.barLeft.x,
      SPLASH_MARK.barLeft.width,
      SPLASH_MARK.barRight.x,
      SPLASH_MARK.barRight.width,
      SPLASH_MARK.post.x,
      SPLASH_MARK.post.width,
    ];
    for (const value of numbers) expect(Number.isInteger(value)).toBe(true);
    expect(SPLASH_MARK.barRight.x + SPLASH_MARK.barRight.width).toBe(SPLASH_MARK.width);
    // Вертикаль — в разрыве полосы, не касаясь её краёв: иначе это снова «батарея».
    expect(SPLASH_MARK.post.x).toBeGreaterThan(SPLASH_MARK.barLeft.x + SPLASH_MARK.barLeft.width);
    expect(SPLASH_MARK.post.x + SPLASH_MARK.post.width).toBeLessThan(SPLASH_MARK.barRight.x);
    const smallest = SPLASH_DEVICES.reduce((a, b) => (a.width * a.height <= b.width * b.height ? a : b));
    const landscape = splashPoints(smallest, "landscape");
    expect(SPLASH_MARK.width).toBeLessThan(landscape.height / 2);
    expect(SPLASH_MARK.height).toBeLessThan(landscape.height / 2);
  });

  it.each(cases)("%s: размер по media, холст `--canvas` и знак на своём месте", (fileName, device, orientation) => {
    const bytes = readFileSync(new URL(fileName, splashDirectory));
    const image = decodePng(bytes);
    expect([image.width, image.height]).toEqual([splashPixels(device, orientation).width, splashPixels(device, orientation).height]);
    expect(splashHref(device, orientation)).toBe(`/${SPLASH_DIRECTORY}/${fileName}`);

    const canvas = rgb(palette.canvas);
    expect(pixelAt(image, 0, 0)).toEqual(canvas);
    expect(pixelAt(image, image.width - 1, 0)).toEqual(canvas);
    expect(pixelAt(image, 0, image.height - 1)).toEqual(canvas);
    expect(pixelAt(image, image.width - 1, image.height - 1)).toEqual(canvas);

    const points = splashPoints(device, orientation);
    const origin = splashMarkOrigin(points.width, points.height);
    const probe = (at: { readonly x: number; readonly y: number }) =>
      pixelAt(image, (origin.x + at.x) * device.scale, (origin.y + at.y) * device.scale);
    expect(probe(SPLASH_MARK_PROBES.ink)).toEqual(rgb(palette.ink));
    expect(probe(SPLASH_MARK_PROBES.orange)).toEqual(rgb(palette.orange));
    expect(probe(SPLASH_MARK_PROBES.gap)).toEqual(canvas);

    // Ровно три цвета: четвёртый — это сглаженный край, то есть знак сошёл с пиксельной сетки.
    expect(countColors(image)).toBe(3);
    // И записаны они палитрой в два бита: так набор весит впятеро меньше снимков Chromium.
    expect(pngHeader(bytes)).toEqual({ bitDepth: 2, colorType: 3 });
  });
});

describe("png без библиотек", () => {
  function image(width: number, height: number, at: (x: number, y: number) => Rgba): PngImage {
    const rgba = new Uint8Array(width * height * 4);
    for (let y = 0; y < height; y += 1) {
      for (let x = 0; x < width; x += 1) rgba.set(at(x, y), (y * width + x) * 4);
    }
    return { width, height, rgba };
  }

  const trio: readonly Rgba[] = [[1, 2, 3, 255], [4, 5, 6, 255], [7, 8, 9, 255]];
  const cases: readonly (readonly [string, number, number, (x: number, y: number) => Rgba])[] = [
    ["два цвета — 1 бит", 1, 3, (x, y) => (x === y ? [10, 20, 30, 255] : [200, 210, 220, 255])],
    ["три цвета — 2 бита", 2, 3, (x, y) => trio[(x + y) % 3] ?? [0, 0, 0, 255]],
    ["девять цветов — 4 бита", 4, 3, (x, y) => [(x % 3) * 30, (y % 3) * 40, 0, 255]],
    ["триста цветов — RGB", 8, 2, (x, y) => [x, (y * 37) & 255, (x * y) & 255, 255]],
  ];

  it.each(cases)("%s: восстанавливается пиксель в пиксель", (_label, bitDepth, colorType, at) => {
    const source = image(colorType === 2 ? 300 : 37, 5, at);
    const bytes = encodePng(source);
    expect(pngHeader(bytes)).toEqual({ bitDepth, colorType });
    const decoded = decodePng(bytes);
    expect([decoded.width, decoded.height]).toEqual([source.width, source.height]);
    expect(Buffer.from(decoded.rgba).equals(Buffer.from(source.rgba))).toBe(true);
  });

  it("прозрачность уходит в RGBA и возвращается", () => {
    const source = image(9, 4, (x, y) => [x * 20, y * 50, 7, x === 0 ? 0 : 255]);
    const bytes = encodePng(source);
    expect(pngHeader(bytes)).toEqual({ bitDepth: 8, colorType: 6 });
    expect(Buffer.from(decodePng(bytes).rgba).equals(Buffer.from(source.rgba))).toBe(true);
  });
});
