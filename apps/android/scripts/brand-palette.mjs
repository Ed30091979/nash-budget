// Палитра обёртки обязана быть палитрой приложения — и это проверяется, а не помнится.
//
// Палитру меняли дважды, и оба раза обёртка отставала: после перехода на бумагу здесь оставались
// тёмный фон WebView, тёмная заставка и тёмная подложка значка из оформления 1.0.0. Источник
// правды один — `:root` в apps/web-pwa/src/styles.css; здесь он читается и сверяется с каждым
// местом обёртки, где цвет назван: capacitor.config.ts, colors.xml, splash.xml, адаптивные значки
// и темы. В темах и drawable hex запрещён вовсе: цвет там — только ссылка на colors.xml.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const HEX = /#[0-9a-f]{6}\b/giu;

/** `--canvas`, `--ink`, `--orange` из `:root` таблицы стилей, в нижнем регистре. */
export function readWebPalette(stylesPath) {
  const source = readFileSync(stylesPath, "utf8").replace(/\/\*[\s\S]*?\*\//gu, "");
  const token = (name) => {
    const value = source.match(new RegExp(`\\n\\s*${name}:\\s*(#[0-9a-f]{6});`, "iu"))?.[1];
    if (value === undefined) throw new Error(`токен ${name} не объявлен в :root ${stylesPath}`);
    return value.toLowerCase();
  };
  return { canvas: token("--canvas"), ink: token("--ink"), orange: token("--orange") };
}

/** Цвета colors.xml обёртки по имени. */
export function readWrapperColors(colorsXmlPath) {
  const xml = readFileSync(colorsXmlPath, "utf8").replace(/<!--[\s\S]*?-->/gu, "");
  const colors = {};
  for (const match of xml.matchAll(/<color\s+name="([^"]+)">\s*(#[0-9a-f]{6,8})\s*<\/color>/giu)) {
    colors[match[1]] = match[2].toLowerCase();
  }
  return colors;
}

function stripComments(xml) {
  return xml.replace(/<!--[\s\S]*?-->/gu, "");
}

function stylesFiles(resRoot) {
  return readdirSync(resRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && /^values(?:-.+)?$/u.test(entry.name))
    .map((entry) => join(resRoot, entry.name, "styles.xml"))
    .filter((path) => existsSync(path));
}

/**
 * Сверяет обёртку с палитрой приложения; возвращает список несоответствий (пустой — всё сходится).
 *
 * `capacitorConfig` — текст capacitor.config.ts или уже разобранный объект упакованного
 * capacitor.config.json: сканер артефактов передаёт то, что реально уехало в APK.
 */
export function wrapperPaletteProblems({ palette, androidRoot, capacitorConfig }) {
  const problems = [];
  const resRoot = join(androidRoot, "app/src/main/res");

  const backgroundColor =
    typeof capacitorConfig === "string"
      ? capacitorConfig.match(/backgroundColor:\s*"([^"]+)"/u)?.[1]
      : capacitorConfig?.android?.backgroundColor ?? capacitorConfig?.backgroundColor;
  if (backgroundColor?.toLowerCase() !== palette.canvas) {
    problems.push(`capacitor backgroundColor ${backgroundColor ?? "не задан"} ≠ --canvas ${palette.canvas}`);
  }
  // Глифы системных панелей: плагин SystemBars при DEFAULT берёт стиль из системной темы и в
  // тёмной теме делает их светлыми — на холсте они пропадают. LIGHT — панели светлые, глифы тёмные.
  const systemBarsStyle =
    typeof capacitorConfig === "string"
      ? capacitorConfig.match(/SystemBars:\s*\{[^}]*style:\s*"([^"]+)"/u)?.[1]
      : capacitorConfig?.plugins?.SystemBars?.style;
  if (systemBarsStyle?.toUpperCase() !== "LIGHT") {
    problems.push(`capacitor plugins.SystemBars.style ${systemBarsStyle ?? "не задан"} — нужен LIGHT: тёмные глифы на холсте при любой системной теме`);
  }

  const colorsPath = join(resRoot, "values/colors.xml");
  const colors = existsSync(colorsPath) ? readWrapperColors(colorsPath) : {};
  for (const name of ["canvas", "ink", "orange"]) {
    if (colors[name] !== palette[name]) {
      problems.push(`colors.xml ${name} ${colors[name] ?? "отсутствует"} ≠ --${name} ${palette[name]}`);
    }
  }
  const extraColors = Object.keys(colors).filter((name) => !["canvas", "ink", "orange"].includes(name));
  if (extraColors.length > 0) problems.push(`colors.xml объявляет цвета вне палитры: ${extraColors.join(", ")}`);

  for (const relative of [
    "drawable/splash.xml",
    "mipmap-anydpi-v26/ic_launcher.xml",
    "mipmap-anydpi-v26/ic_launcher_round.xml",
    ...stylesFiles(resRoot).map((path) => path.slice(resRoot.length + 1)),
  ]) {
    const path = join(resRoot, relative);
    if (!existsSync(path)) {
      problems.push(`${relative} отсутствует`);
      continue;
    }
    const xml = stripComments(readFileSync(path, "utf8"));
    const literals = [...xml.matchAll(HEX)].map((match) => match[0]);
    if (literals.length > 0) problems.push(`${relative} задаёт цвет литералом: ${literals.join(", ")}`);
    if (/DayNight|\.Dark\b|Theme\.AppCompat(?!\.Light)\b/u.test(xml)) {
      problems.push(`${relative} наследует тёмную или двухрежимную тему`);
    }
  }

  for (const relative of ["drawable/splash.xml", "mipmap-anydpi-v26/ic_launcher.xml", "mipmap-anydpi-v26/ic_launcher_round.xml"]) {
    const path = join(resRoot, relative);
    if (existsSync(path) && !/@color\/canvas/u.test(stripComments(readFileSync(path, "utf8")))) {
      problems.push(`${relative} не ссылается на @color/canvas`);
    }
  }

  const legacyBackground = join(resRoot, "values/ic_launcher_background.xml");
  if (existsSync(legacyBackground)) problems.push("values/ic_launcher_background.xml — второй источник цвета подложки значка");

  return problems;
}

export function assertWrapperPalette(options) {
  const problems = wrapperPaletteProblems(options);
  if (problems.length > 0) {
    throw new Error(`палитра обёртки разошлась с приложением:\n- ${problems.join("\n- ")}`);
  }
}
