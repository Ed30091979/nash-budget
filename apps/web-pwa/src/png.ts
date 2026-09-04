/// <reference types="node" />
/**
 * PNG без библиотек: ровно столько, сколько нужно, чтобы прочитать пиксели отрисованной в
 * Chromium картинки и записать их обратно компактно.
 *
 * Снимок Chromium — это 32-битный RGBA с адаптивными фильтрами: честный, но для картинки из трёх
 * сплошных цветов избыточный в разы. Здесь те же пиксели укладываются в палитру самой узкой
 * глубины (три цвета — это два бита на пиксель, четыре пикселя в байте) и фильтр «Up», после
 * которого одинаковые строки превращаются в нули, — deflate такое сжимает почти до заголовка.
 * Пиксели при этом не меняются ни на единицу: это упаковка, а не перерисовка, и проверка по
 * пикселям читает именно этот файл.
 *
 * Читается: серый, серый с альфой, RGB и RGBA глубиной 8 бит; палитра глубиной 1, 2, 4 и 8 бит
 * (с `tRNS` и без). Чересстрочность не поддерживается. Этого хватает и на снимки Chromium, и на
 * то, что пишется отсюда.
 */
import { deflateSync, inflateSync } from "node:zlib";

export interface PngImage {
  readonly width: number;
  readonly height: number;
  /** RGBA, четыре байта на пиксель, строка за строкой. */
  readonly rgba: Uint8Array;
}

export type Rgba = readonly [number, number, number, number];

const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

const CRC_TABLE = new Uint32Array(256);
for (let n = 0; n < 256; n += 1) {
  let c = n;
  for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  CRC_TABLE[n] = c >>> 0;
}

function crc32(bytes: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = (CRC_TABLE[(crc ^ byte) & 0xff] ?? 0) ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Buffer): Buffer {
  const header = Buffer.alloc(4);
  header.writeUInt32BE(data.length, 0);
  const typed = Buffer.concat([Buffer.from(type, "latin1"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(typed), 0);
  return Buffer.concat([header, typed, crc]);
}

const PALETTE = 3;
const CHANNELS: Readonly<Record<number, number>> = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };

function paeth(a: number, b: number, c: number): number {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  return pb <= pc ? b : c;
}

/** Байт строки на пиксель для фильтров: при глубине меньше байта — единица, по спецификации. */
function bytesPerPixel(channels: number, bitDepth: number): number {
  return Math.max(1, (channels * bitDepth) >> 3);
}

function rowStride(width: number, channels: number, bitDepth: number): number {
  return Math.ceil((width * channels * bitDepth) / 8);
}

export function decodePng(bytes: Uint8Array): PngImage {
  const buffer = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (!buffer.subarray(0, 8).equals(SIGNATURE)) throw new Error("не PNG");
  let width = 0;
  let height = 0;
  let bitDepth = 0;
  let colorType = 0;
  let palette: Buffer | null = null;
  let transparency: Buffer | null = null;
  const idat: Buffer[] = [];
  for (let offset = 8; offset + 8 <= buffer.length;) {
    const length = buffer.readUInt32BE(offset);
    const type = buffer.subarray(offset + 4, offset + 8).toString("latin1");
    const data = buffer.subarray(offset + 8, offset + 8 + length);
    if (type === "IHDR") {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      bitDepth = data[8] ?? 0;
      colorType = data[9] ?? 0;
      if (data[12] !== 0) throw new Error("чересстрочный PNG не поддерживается");
    } else if (type === "PLTE") palette = Buffer.from(data);
    else if (type === "tRNS") transparency = Buffer.from(data);
    else if (type === "IDAT") idat.push(data);
    else if (type === "IEND") break;
    offset += 12 + length;
  }
  const channels = CHANNELS[colorType];
  if (channels === undefined) throw new Error(`тип цвета ${colorType} не поддерживается`);
  const subByte = colorType === PALETTE && (bitDepth === 1 || bitDepth === 2 || bitDepth === 4);
  if (bitDepth !== 8 && !subByte) {
    throw new Error(`глубина ${bitDepth} бит при типе цвета ${colorType} не поддерживается`);
  }
  const stride = rowStride(width, channels, bitDepth);
  const bpp = bytesPerPixel(channels, bitDepth);
  const raw = inflateSync(Buffer.concat(idat));
  if (raw.length !== (stride + 1) * height) throw new Error("длина данных не сходится с размером");

  // Снятие фильтров: a — байт слева, b — сверху, c — сверху слева; за краем — нули.
  const rows = Buffer.alloc(stride * height);
  for (let y = 0; y < height; y += 1) {
    const filter = raw[y * (stride + 1)] ?? 0;
    const inRow = y * (stride + 1) + 1;
    const outRow = y * stride;
    for (let i = 0; i < stride; i += 1) {
      const x = raw[inRow + i] ?? 0;
      const a = i >= bpp ? (rows[outRow + i - bpp] ?? 0) : 0;
      const b = y > 0 ? (rows[outRow - stride + i] ?? 0) : 0;
      const c = y > 0 && i >= bpp ? (rows[outRow - stride + i - bpp] ?? 0) : 0;
      let value: number;
      if (filter === 0) value = x;
      else if (filter === 1) value = x + a;
      else if (filter === 2) value = x + b;
      else if (filter === 3) value = x + ((a + b) >> 1);
      else if (filter === 4) value = x + paeth(a, b, c);
      else throw new Error(`неизвестный фильтр ${filter} в строке ${y}`);
      rows[outRow + i] = value & 0xff;
    }
  }

  const rgba = new Uint8Array(width * height * 4);
  const mask = (1 << bitDepth) - 1;
  for (let y = 0; y < height; y += 1) {
    const row = y * stride;
    for (let x = 0; x < width; x += 1) {
      const out = (y * width + x) * 4;
      let r: number;
      let g: number;
      let b: number;
      let a = 255;
      if (colorType === PALETTE) {
        if (palette === null) throw new Error("палитра без PLTE");
        const bit = x * bitDepth;
        const index = ((rows[row + (bit >> 3)] ?? 0) >> (8 - bitDepth - (bit & 7))) & mask;
        r = palette[index * 3] ?? 0;
        g = palette[index * 3 + 1] ?? 0;
        b = palette[index * 3 + 2] ?? 0;
        if (transparency !== null && index < transparency.length) a = transparency[index] ?? 255;
      } else {
        const at = row + x * channels;
        if (colorType === 0 || colorType === 4) {
          r = g = b = rows[at] ?? 0;
          if (colorType === 4) a = rows[at + 1] ?? 255;
        } else {
          r = rows[at] ?? 0;
          g = rows[at + 1] ?? 0;
          b = rows[at + 2] ?? 0;
          if (colorType === 6) a = rows[at + 3] ?? 255;
        }
      }
      rgba[out] = r;
      rgba[out + 1] = g;
      rgba[out + 2] = b;
      rgba[out + 3] = a;
    }
  }
  return { width, height, rgba };
}

export function pixelAt(image: PngImage, x: number, y: number): Rgba {
  if (x < 0 || y < 0 || x >= image.width || y >= image.height) {
    throw new Error(`пиксель (${x}, ${y}) вне картинки ${image.width}×${image.height}`);
  }
  const at = (y * image.width + x) * 4;
  return [
    image.rgba[at] ?? 0,
    image.rgba[at + 1] ?? 0,
    image.rgba[at + 2] ?? 0,
    image.rgba[at + 3] ?? 0,
  ];
}

/** Число цветов в картинке — по RGBA целиком, вместе с альфой. */
export function countColors(image: PngImage): number {
  const seen = new Set<number>();
  for (let p = 0; p < image.width * image.height; p += 1) {
    const at = p * 4;
    seen.add(
      ((image.rgba[at] ?? 0) << 24) |
        ((image.rgba[at + 1] ?? 0) << 16) |
        ((image.rgba[at + 2] ?? 0) << 8) |
        (image.rgba[at + 3] ?? 0),
    );
  }
  return seen.size;
}

/** Заголовок PNG — чтобы проверка могла назвать, как именно записана картинка. */
export function pngHeader(bytes: Uint8Array): { readonly bitDepth: number; readonly colorType: number } {
  const buffer = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (!buffer.subarray(0, 8).equals(SIGNATURE)) throw new Error("не PNG");
  return { bitDepth: buffer[24] ?? 0, colorType: buffer[25] ?? 0 };
}

/**
 * Пишет картинку самым узким из подходящих способов: палитра глубиной 1, 2, 4 или 8 бит, если
 * непрозрачных цветов не больше 256; RGB без альфы, если картинка непрозрачна; иначе RGBA.
 * Фильтр — «Up» у всех строк, кроме первой: одинаковые соседние строки становятся нулями, и на
 * сплошной заливке это почти всё.
 */
export function encodePng(image: PngImage): Uint8Array {
  const { width, height, rgba } = image;
  const total = width * height;
  let opaque = true;
  const colors = new Map<number, number>();
  for (let p = 0; p < total && (opaque || colors.size <= 256); p += 1) {
    const at = p * 4;
    if ((rgba[at + 3] ?? 0) !== 255) opaque = false;
    const key = ((rgba[at] ?? 0) << 16) | ((rgba[at + 1] ?? 0) << 8) | (rgba[at + 2] ?? 0);
    if (!colors.has(key)) colors.set(key, colors.size);
  }
  const usePalette = opaque && colors.size <= 256;
  const colorType = usePalette ? PALETTE : opaque ? 2 : 6;
  const channels = CHANNELS[colorType] ?? 4;
  const bitDepth = !usePalette ? 8 : colors.size <= 2 ? 1 : colors.size <= 4 ? 2 : colors.size <= 16 ? 4 : 8;
  const stride = rowStride(width, channels, bitDepth);

  const samples = Buffer.alloc(stride * height);
  for (let y = 0; y < height; y += 1) {
    const row = y * stride;
    for (let x = 0; x < width; x += 1) {
      const at = (y * width + x) * 4;
      if (usePalette) {
        const key = ((rgba[at] ?? 0) << 16) | ((rgba[at + 1] ?? 0) << 8) | (rgba[at + 2] ?? 0);
        const index = colors.get(key) ?? 0;
        const bit = x * bitDepth;
        const cell = row + (bit >> 3);
        samples[cell] = (samples[cell] ?? 0) | (index << (8 - bitDepth - (bit & 7)));
      } else {
        const out = row + x * channels;
        samples[out] = rgba[at] ?? 0;
        samples[out + 1] = rgba[at + 1] ?? 0;
        samples[out + 2] = rgba[at + 2] ?? 0;
        if (colorType === 6) samples[out + 3] = rgba[at + 3] ?? 0;
      }
    }
  }

  const filtered = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y += 1) {
    const inRow = y * stride;
    const outRow = y * (stride + 1);
    filtered[outRow] = y === 0 ? 0 : 2;
    for (let i = 0; i < stride; i += 1) {
      const current = samples[inRow + i] ?? 0;
      const above = y === 0 ? 0 : (samples[inRow - stride + i] ?? 0);
      filtered[outRow + 1 + i] = (current - above) & 0xff;
    }
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = bitDepth;
  ihdr[9] = colorType;
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;
  const chunks = [SIGNATURE, chunk("IHDR", ihdr)];
  if (usePalette) {
    const plte = Buffer.alloc(colors.size * 3);
    for (const [key, index] of colors) {
      plte[index * 3] = (key >> 16) & 0xff;
      plte[index * 3 + 1] = (key >> 8) & 0xff;
      plte[index * 3 + 2] = key & 0xff;
    }
    chunks.push(chunk("PLTE", plte));
  }
  chunks.push(chunk("IDAT", deflateSync(filtered, { level: 9 })), chunk("IEND", Buffer.alloc(0)));
  return new Uint8Array(Buffer.concat(chunks));
}
