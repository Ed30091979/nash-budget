/**
 * Экран запуска iOS: набор картинок `apple-touch-startup-image` и всё, что обязано с ним сходиться.
 *
 * В автономном режиме (`display: standalone`) iOS показывает между нажатием на значок и первым
 * кадром страницы картинку запуска — и только её. Без картинки экран белый, и на бумажном
 * приложении это видно особенно: белая вспышка, потом тёплый холст. Картинку система выбирает по
 * атрибуту `media` ссылки, и подходит она только при точном совпадении — ширина и высота экрана
 * в пунктах, плотность и ориентация. Поэтому набор — это таблица экранов, а не одна картинка.
 *
 * Таблица собрана по «Human Interface Guidelines → Layout → iOS, iPadOS device screen dimensions»
 * (Apple, состояние на осень 2026): пункты и плотность берутся оттуда, а размер картинки в
 * пикселях считается как пункты × плотность. Столбец «px» таблицы для этого не годится: у Plus и
 * mini там физическая матрица (1080×1920, 1080×2340), а рисует iOS в логических пикселях
 * (1242×2208, 1125×2436) и картинку ищет под них. Модели, которые не дошли до iOS 16
 * (6s, 7, SE 4-дюймовый, iPod touch), в таблице отсутствуют: приложению нужны `dvh`,
 * контейнерные запросы и `:has`, и на их Safari оно не запускается — картинка была бы мёртвым
 * весом.
 *
 * Правило ориентации, которого нет в документации и которое сверено по двум независимым
 * реализациям: в `media` и для альбомной картинки стоят портретные ширина и высота экрана,
 * меняются местами только пиксели самой картинки.
 *
 * Тёмного набора нет — намеренно. Тема у приложения одна, светлая (`color-scheme: light`), и
 * первый кадр после запуска светлый при любой системной теме; тёмная картинка запуска дала бы
 * ровно ту вспышку, которую этот набор убирает. К тому же iOS выбирает картинку в момент
 * добавления на экран «Домой», а не при каждом запуске.
 *
 * Отсюда читают трое: `scripts/render-splash.mjs` рисует картинки и пишет блок ссылок в
 * `index.html`, `splash.test.ts` сверяет картинки, разметку и палитру, а человек — таблицу.
 */

export type SplashScale = 2 | 3;

export interface SplashDevice {
  /** Ширина экрана в пунктах — в портрете. */
  readonly width: number;
  /** Высота экрана в пунктах — в портрете. */
  readonly height: number;
  readonly scale: SplashScale;
  /** Модели с таким экраном — читателю; в разметку не попадает. */
  readonly models: string;
}

export const SPLASH_DEVICES: readonly SplashDevice[] = [
  { width: 440, height: 956, scale: 3, models: "iPhone 17 Pro Max, 16 Pro Max" },
  { width: 430, height: 932, scale: 3, models: "iPhone 16 Plus, 15 Pro Max, 15 Plus, 14 Pro Max" },
  { width: 428, height: 926, scale: 3, models: "iPhone 14 Plus, 13 Pro Max, 12 Pro Max" },
  { width: 420, height: 912, scale: 3, models: "iPhone Air" },
  { width: 414, height: 896, scale: 3, models: "iPhone 11 Pro Max, XS Max" },
  { width: 414, height: 896, scale: 2, models: "iPhone 11, XR" },
  { width: 414, height: 736, scale: 3, models: "iPhone 8 Plus" },
  { width: 402, height: 874, scale: 3, models: "iPhone 17 Pro, 17, 16 Pro" },
  { width: 393, height: 852, scale: 3, models: "iPhone 16, 15 Pro, 15, 14 Pro" },
  { width: 390, height: 844, scale: 3, models: "iPhone 17e, 16e, 14, 13 Pro, 13, 12 Pro, 12" },
  { width: 375, height: 812, scale: 3, models: "iPhone 13 mini, 12 mini, 11 Pro, XS, X" },
  { width: 375, height: 667, scale: 2, models: "iPhone SE (2-е и 3-е поколение), 8" },
  { width: 1032, height: 1376, scale: 2, models: "iPad Pro 13″" },
  { width: 1024, height: 1366, scale: 2, models: "iPad Pro 12,9″, iPad Air 13″" },
  { width: 834, height: 1210, scale: 2, models: "iPad Pro 11″ (5-е и 6-е поколение)" },
  { width: 834, height: 1194, scale: 2, models: "iPad Pro 11″ (1–4-е поколение)" },
  { width: 834, height: 1112, scale: 2, models: "iPad Pro 10,5″, iPad Air 10,5″" },
  { width: 820, height: 1180, scale: 2, models: "iPad Air 11″ и 10,9″, iPad 11″ и 10,9″" },
  { width: 810, height: 1080, scale: 2, models: "iPad 10,2″" },
  { width: 768, height: 1024, scale: 2, models: "iPad 9,7″, iPad mini 7,9″" },
  { width: 744, height: 1133, scale: 2, models: "iPad mini 8,3″" },
];

export type SplashOrientation = "portrait" | "landscape";

export const SPLASH_ORIENTATIONS: readonly SplashOrientation[] = ["portrait", "landscape"];

/** Каталог картинок внутри `public/` — и единственный образец для `globIgnores` сервис-воркера. */
export const SPLASH_DIRECTORY = "splash";

/** Размер картинки в пикселях: пункты × плотность, в альбоме — наоборот. */
export function splashPixels(
  device: SplashDevice,
  orientation: SplashOrientation,
): { readonly width: number; readonly height: number } {
  const width = device.width * device.scale;
  const height = device.height * device.scale;
  return orientation === "portrait" ? { width, height } : { width: height, height: width };
}

/** Размер картинки в пунктах — то, в чём её рисует браузер при плотности `scale`. */
export function splashPoints(
  device: SplashDevice,
  orientation: SplashOrientation,
): { readonly width: number; readonly height: number } {
  return orientation === "portrait"
    ? { width: device.width, height: device.height }
    : { width: device.height, height: device.width };
}

export function splashFileName(device: SplashDevice, orientation: SplashOrientation): string {
  const { width, height } = splashPixels(device, orientation);
  return `${width}x${height}.png`;
}

/** Абсолютный путь от корня сайта; сборка подставляет `base` сама, как и остальным ссылкам. */
export function splashHref(device: SplashDevice, orientation: SplashOrientation): string {
  return `/${SPLASH_DIRECTORY}/${splashFileName(device, orientation)}`;
}

export function splashMedia(device: SplashDevice, orientation: SplashOrientation): string {
  return (
    `(device-width: ${device.width}px) and (device-height: ${device.height}px) ` +
    `and (-webkit-device-pixel-ratio: ${device.scale}) and (orientation: ${orientation})`
  );
}

export function splashLink(device: SplashDevice, orientation: SplashOrientation): string {
  return (
    `<link rel="apple-touch-startup-image" media="${splashMedia(device, orientation)}" ` +
    `href="${splashHref(device, orientation)}" />`
  );
}

export const SPLASH_LINKS_START =
  "<!-- Экран запуска iOS. Блок до закрывающей метки пишет scripts/render-splash.mjs из src/splash.ts; руками не править. -->";
export const SPLASH_LINKS_END = "<!-- /экран запуска iOS -->";

/** Блок ссылок целиком, с метками, — ровно то, что стоит в `index.html`. */
export function splashLinksBlock(indent = "    "): string {
  const lines: string[] = [`${indent}${SPLASH_LINKS_START}`];
  for (const device of SPLASH_DEVICES) {
    for (const orientation of SPLASH_ORIENTATIONS) {
      lines.push(`${indent}${splashLink(device, orientation)}`);
    }
  }
  lines.push(`${indent}${SPLASH_LINKS_END}`);
  return lines.join("\n");
}

/**
 * Знак на картинке — та же насечка, что в значке (`public/app-icon.svg`): чернильная полоса
 * линейки, разрыв на три четверти и оранжевая вертикаль дня выплаты сквозь разрыв. Пропорции
 * значка сохранены, но координаты поставлены на сетку целых пунктов: при плотности 2 и 3 каждый
 * край тогда ложится на пиксель, и картинка состоит ровно из трёх цветов — без сглаживания, и
 * поэтому её можно упаковать палитрой и проверить по пикселям, а не «примерно».
 *
 * Размер один на все экраны, 107×100 pt: на телефоне это чуть больше четверти ширины, на
 * планшете — восьмая часть. Знак не масштабируется под экран намеренно: это не иллюстрация, а
 * тот же значок, который человек только что нажал.
 */
export const SPLASH_MARK = {
  width: 107,
  height: 100,
  bar: { y: 36, height: 28 },
  barLeft: { x: 0, width: 71 },
  barRight: { x: 85, width: 22 },
  post: { x: 75, width: 7 },
} as const;

/** Левый верхний угол знака в пунктах: по центру экрана, на целых пунктах. */
export function splashMarkOrigin(
  widthPt: number,
  heightPt: number,
): { readonly x: number; readonly y: number } {
  return {
    x: Math.floor((widthPt - SPLASH_MARK.width) / 2),
    y: Math.floor((heightPt - SPLASH_MARK.height) / 2),
  };
}

export interface SplashPalette {
  readonly canvas: string;
  readonly ink: string;
  readonly orange: string;
}

/** Пробы для проверки по пикселям — в пунктах от левого верхнего угла знака. */
export const SPLASH_MARK_PROBES = {
  /** Внутри левой полосы. */
  ink: { x: 35, y: 50 },
  /** Внутри вертикали, выше полосы. */
  orange: { x: 78, y: 10 },
  /** В разрыве полосы, слева от вертикали: там холст, а не чернила. */
  gap: { x: 72, y: 50 },
} as const;

/**
 * Картинка запуска как SVG в пунктах. Холст во весь экран и знак по центру — и ничего больше:
 * ни названия (оно только что было под значком, а текст на картинке запуска не переводится),
 * ни интерфейса, которого ещё нет.
 */
export function splashSvg(widthPt: number, heightPt: number, palette: SplashPalette): string {
  const origin = splashMarkOrigin(widthPt, heightPt);
  const mark = SPLASH_MARK;
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${widthPt}" height="${heightPt}" ` +
    `viewBox="0 0 ${widthPt} ${heightPt}" role="img" aria-label="Наш бюджет">` +
    `<rect width="${widthPt}" height="${heightPt}" fill="${palette.canvas}"/>` +
    `<g transform="translate(${origin.x} ${origin.y})">` +
    `<rect x="${mark.barLeft.x}" y="${mark.bar.y}" width="${mark.barLeft.width}" height="${mark.bar.height}" fill="${palette.ink}"/>` +
    `<rect x="${mark.barRight.x}" y="${mark.bar.y}" width="${mark.barRight.width}" height="${mark.bar.height}" fill="${palette.ink}"/>` +
    `<rect x="${mark.post.x}" y="0" width="${mark.post.width}" height="${mark.height}" fill="${palette.orange}"/>` +
    `</g></svg>`
  );
}

/** Значения `--canvas`, `--ink`, `--orange` из `:root` таблицы стилей — источник палитры. */
export function splashPaletteFromStyles(styles: string): SplashPalette {
  const source = styles.replace(/\/\*[\s\S]*?\*\//gu, "");
  const token = (name: string): string => {
    const value = source.match(new RegExp(`\\n\\s*${name}:\\s*(#[0-9a-f]{6});`, "iu"))?.[1];
    if (value === undefined) throw new Error(`токен ${name} не объявлен в :root`);
    return value.toLowerCase();
  };
  return { canvas: token("--canvas"), ink: token("--ink"), orange: token("--orange") };
}
