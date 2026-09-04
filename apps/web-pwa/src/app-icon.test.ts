/// <reference types="node" />
import { readFileSync } from "node:fs";
import { inflateSync } from "node:zlib";
import { describe, expect, it } from "vitest";

/**
 * Значок приложения — первое, что человек видит на рабочем столе, и он обязан быть из того же
 * мира, что и экраны. После перехода на бумажную палитру значок остался мятным: на столе —
 * зелёный квадрат, в приложении — бумага. Эти проверки не дают палитре значка отстать от
 * `:root` ещё раз и держат растровые файлы манифеста согласованными с исходником.
 */
const svg = readFileSync(new URL("../public/app-icon.svg", import.meta.url), "utf8");
const styles = readFileSync(new URL("./styles.css", import.meta.url), "utf8").replace(/\/\*[\s\S]*?\*\//gu, "");

function rootToken(name: string): string {
  const value = styles.match(new RegExp(`\\n\\s*${name}:\\s*(#[0-9a-f]{6});`, "iu"))?.[1];
  expect(value, `токен ${name} не объявлен в :root`).toBeDefined();
  return (value ?? "").toLowerCase();
}

function hexes(text: string): string[] {
  return [...text.matchAll(/#[0-9a-f]{6}\b/giu)].map((match) => match[0].toLowerCase());
}

/** Прямоугольники значка: всё нарисовано ими, и геометрию можно проверить без отрисовки. */
function rects(): { x: number; y: number; width: number; height: number }[] {
  return [...svg.matchAll(/<rect\b([^>]*)\/>/gu)].map((match) => {
    const attribute = (name: string): number => Number((match[1] ?? "").match(new RegExp(`\\b${name}="([\\d.]+)"`, "u"))?.[1] ?? 0);
    return { x: attribute("x"), y: attribute("y"), width: attribute("width"), height: attribute("height") };
  });
}

/** Ширина, высота и первый пиксель PNG — без библиотек: заголовок IHDR и первая строка IDAT. */
function png(name: string): { width: number; height: number; corner: readonly [number, number, number, number] } {
  const bytes = readFileSync(new URL(`../public/${name}`, import.meta.url));
  expect(bytes.subarray(0, 8).toString("hex"), `${name} — не PNG`).toBe("89504e470d0a1a0a");
  const width = bytes.readUInt32BE(16);
  const height = bytes.readUInt32BE(20);
  expect(bytes[24], `${name}: глубина цвета`).toBe(8);
  expect(bytes[25], `${name}: ожидается RGBA`).toBe(6);
  const idat: Buffer[] = [];
  for (let offset = 8; offset < bytes.length;) {
    const length = bytes.readUInt32BE(offset);
    const type = bytes.subarray(offset + 4, offset + 8).toString("latin1");
    if (type === "IDAT") idat.push(bytes.subarray(offset + 8, offset + 8 + length));
    offset += 12 + length;
  }
  // Первый пиксель первой строки восстанавливается из сырых байтов при любом фильтре: слева и
  // сверху у него нули, и все пять фильтров возвращают исходное значение.
  const raw = inflateSync(Buffer.concat(idat));
  return { width, height, corner: [raw[1] ?? 0, raw[2] ?? 0, raw[3] ?? 0, raw[4] ?? 0] };
}

describe("значок приложения", () => {
  it("набран только цветами `:root` — палитрой приложения, а не прежней", () => {
    const rootBlock = styles.slice(styles.indexOf(":root {"), styles.indexOf("\n}", styles.indexOf(":root {")));
    const palette = new Set(hexes(rootBlock));
    const used = new Set(hexes(svg));
    expect(used.size).toBeGreaterThan(0);
    for (const hex of used) expect(palette, `${hex} в значке нет среди токенов :root`).toContain(hex);
    // Мир приложения: холст, чернила и единственный оранжевый.
    for (const name of ["--canvas", "--ink", "--orange"]) expect(used).toContain(rootToken(name));
  });

  it("держит всё значимое в безопасном круге маски — 80 % полотна", () => {
    // icon-512 объявлен `any maskable`: снаружи круга система обрежет. Круг радиуса 204,8 от
    // центра; запас 12 px — на сглаживание края и на тень, если она у фигуры появится.
    const shadowMargin = 12;
    const content = rects().filter((rect) => rect.width !== 512);
    // Полоса, её продолжение за разрывом и вертикаль — минимум три фигуры, иначе разбор SVG сломан.
    expect(content.length).toBeGreaterThanOrEqual(3);
    for (const rect of content) {
      const corners: readonly (readonly [number, number])[] = [[rect.x, rect.y], [rect.x + rect.width, rect.y], [rect.x, rect.y + rect.height], [rect.x + rect.width, rect.y + rect.height]];
      for (const [x, y] of corners) {
        expect(Math.hypot(x - 256, y - 256) + shadowMargin, `угол (${x}, ${y}) вне безопасного круга`).toBeLessThanOrEqual(512 * 0.4);
      }
    }
  });

  it("растры манифеста имеют объявленные размеры, и maskable залит до самого угла", () => {
    const canvas = rootToken("--canvas");
    const canvasRgb = [1, 3, 5].map((at) => Number.parseInt(canvas.slice(at, at + 2), 16));
    const maskable = png("icon-512.png");
    expect([maskable.width, maskable.height]).toEqual([512, 512]);
    // Во весь холст: под любой маской системы в углу — холст, а не прозрачность.
    expect(maskable.corner).toEqual([...canvasRgb, 255]);
    const apple = png("apple-touch-icon.png");
    expect([apple.width, apple.height]).toEqual([180, 180]);
    expect(apple.corner).toEqual([...canvasRgb, 255]);
    // `any` — со скруглением: угол прозрачен, форму даёт сам значок.
    const any = png("icon-192.png");
    expect([any.width, any.height]).toEqual([192, 192]);
    expect(any.corner[3]).toBe(0);
  });
});
