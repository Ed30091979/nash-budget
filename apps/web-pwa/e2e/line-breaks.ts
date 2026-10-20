import type { Page } from "@playwright/test";

/**
 * Где ломаются имена плиток — для экранов вне «Обзора» (справочники 2c). То же правило, что у
 * `overview.spec.ts` (ревью 2b, раунд 3): перенос честный, если перед ним пробел, дефис или мягкий
 * перенос (он и рисуется дефисом); иначе слово разорвано посередине без знака переноса. Строки
 * находятся по прямоугольникам каждого символа (`Range.getClientRects`), а не по ширине.
 */
export async function nameSplits(page: Page, selector: string): Promise<readonly string[]> {
  return page.evaluate((names) => {
    const splits: string[] = [];
    for (const name of document.querySelectorAll<HTMLElement>(names)) {
      // Текст «только для слуха» (`.sr-only`, `.visually-hidden`) на экране не переносится — он
      // сжат в точку, и его символы стоят не на строках видимого текста (`Hyphenated`).
      const walker = document.createTreeWalker(name, NodeFilter.SHOW_TEXT, {
        acceptNode: (node) => (node.parentElement?.closest(".sr-only, .visually-hidden") ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT),
      });
      const chars: { readonly char: string; readonly top: number | null }[] = [];
      for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
        const text = node.textContent ?? "";
        for (let index = 0; index < text.length; index += 1) {
          const range = document.createRange();
          range.setStart(node, index);
          range.setEnd(node, index + 1);
          // The glyph's own box is the last one: at a taken soft hyphen the next character's
          // range also covers the drawn hyphen at the end of the line above.
          const rect = [...range.getClientRects()].filter((item) => item.width > 0).at(-1);
          chars.push({ char: text[index] ?? "", top: rect === undefined ? null : rect.top });
        }
      }
      let lastTop: number | null = null;
      for (let index = 0; index < chars.length; index += 1) {
        const { top } = chars[index]!;
        if (top === null) continue;
        if (lastTop !== null && top > lastTop + 1) {
          const before = chars[index - 1]?.char ?? "";
          if (!/[\s\u00ad-]/u.test(before)) {
            const text = chars.map((item) => item.char).join("").replace(/\u00ad/gu, "");
            splits.push(`${text}: «${chars.slice(0, index).map((item) => item.char).join("").replace(/\u00ad/gu, "")}|…»`);
          }
        }
        lastTop = top;
      }
    }
    return splits;
  }, selector);
}

/** Доступные имена с мягким переносом — по дереву доступности самого Chromium, а не по разметке. */
export async function softHyphenedNames(page: Page): Promise<readonly string[]> {
  const session = await page.context().newCDPSession(page);
  const tree = (await session.send("Accessibility.getFullAXTree")) as { readonly nodes: readonly { readonly name?: { readonly value?: unknown } }[] };
  await session.detach();
  return tree.nodes.map((node) => String(node.name?.value ?? "")).filter((name) => name.includes("\u00ad"));
}

/** Телефоны от 320 до 430 pt, ×1, ×2 и ×2.7 — те же, что у «Обзора». */
export const LINE_BREAK_LAYOUTS = [[320, 1], [390, 1], [430, 1], [320, 2], [390, 2], [430, 2], [320, 2.7], [390, 2.7], [430, 2.7]] as const;
