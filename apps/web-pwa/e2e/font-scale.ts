import { readFileSync } from "node:fs";
import { expect, type Page } from "@playwright/test";

/**
 * Системное увеличение шрифта в прогоне — одно на все проверки геометрии.
 *
 * `Page.setFontSizes` двигает размер по умолчанию — от него считаются `em` в медиазапросах, и
 * правила крупного шрифта (§5, `max-width: 18em`; полоса записи и тост на коротком экране)
 * срабатывают так же, как на устройстве. Ступени §4 умножаются на тот же множитель прямо на
 * `:root`; имена и базовые значения читаются из таблицы стилей, а не переписаны сюда.
 */
const STYLES = readFileSync(new URL("../src/styles.css", import.meta.url), "utf8");

/** Ступени §4 из `:root`. */
export const TYPE_SCALE_TOKENS = [...STYLES.matchAll(/\n\s*(--(?:size|lh)-[\w-]+):\s*(\d+)px;/gu)]
  .map((match) => [match[1] ?? "", Number(match[2])] as const);
export const ROOT_FONT_SIZE = Number(/\n\s*font-size:\s*(\d+)px;/u.exec(STYLES)?.[1]);
/** ×1 и штатный максимум доступности iOS. */
export const FONT_SCALES = [1, 2.7] as const;

/** Масштаб ×1 снимает всё, что поставил больший: одна страница может пройти обе ступени подряд. */
export async function applyFontScale(page: Page, scale: number): Promise<void> {
  expect(TYPE_SCALE_TOKENS.length, "ступени §4 не найдены в styles.css").toBeGreaterThan(0);
  expect(ROOT_FONT_SIZE, "кегль :root не найден в styles.css").toBeGreaterThan(0);
  const session = await page.context().newCDPSession(page);
  await session.send("Page.setFontSizes", {
    fontSizes: { standard: Math.round(16 * scale), fixed: Math.round(13 * scale) },
  });
  await session.detach();
  await page.evaluate(({ tokens, rootFontSize, factor }) => {
    const root = document.documentElement;
    if (factor === 1) {
      root.style.removeProperty("font-size");
      for (const [name] of tokens) root.style.removeProperty(name);
      return;
    }
    root.style.setProperty("font-size", `${Math.round(rootFontSize * factor)}px`);
    for (const [name, base] of tokens) {
      root.style.setProperty(name, `${Math.round(base * factor)}px`);
    }
  }, { tokens: TYPE_SCALE_TOKENS, rootFontSize: ROOT_FONT_SIZE, factor: scale });
}
