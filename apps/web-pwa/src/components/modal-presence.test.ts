/// <reference types="node" />
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { MODAL_DIALOG_SELECTOR, modalDialogOpen } from "./modal-presence";

const root = fileURLToPath(new URL("..", import.meta.url));

function sourceFiles(): readonly string[] {
  const walk = (directory: string): string[] =>
    readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
      const path = join(directory, entry.name);
      return entry.isDirectory() ? walk(path) : [path];
    });
  return walk(root).filter((path) => /\.tsx$/u.test(path) && !/\.test\.tsx$/u.test(path));
}

/** Открывающий тег JSX, в котором стоит `at`: от `<` до `>` вне фигурных скобок и кавычек. */
function openingTag(source: string, at: number): string {
  const start = source.lastIndexOf("<", at);
  let depth = 0;
  let quote: string | null = null;
  for (let index = start; index < source.length; index += 1) {
    const char = source[index]!;
    if (quote !== null) {
      if (char === quote) quote = null;
    } else if (char === '"' || char === "'" || char === "`") quote = char;
    else if (char === "{") depth += 1;
    else if (char === "}") depth -= 1;
    else if (char === ">" && depth === 0) return source.slice(start, index + 1);
  }
  return source.slice(start);
}

describe("вопрос приложения поверх тоста (ревью 2b, раунд 3, NEW-4)", () => {
  it("открыт, когда в документе есть модальный диалог, — и только тогда", () => {
    const asked: string[] = [];
    const root = (found: unknown) => ({ querySelector: (selector: string) => { asked.push(selector); return found; } });
    expect(modalDialogOpen(root({}))).toBe(true);
    expect(modalDialogOpen(root(null))).toBe(false);
    expect(asked).toEqual([MODAL_DIALOG_SELECTOR, MODAL_DIALOG_SELECTOR]);
  });

  it("каждый диалог приложения объявлен модальным — и потому сам ставит тост на паузу", () => {
    // Тост не держит списка вопросов: он спрашивает документ про `aria-modal="true"`. Диалог без него
    // не остановил бы время «Отменить» — и не сказал бы диктору, что всё вокруг выключено.
    const dialogs: string[] = [];
    for (const file of sourceFiles()) {
      const source = readFileSync(file, "utf8");
      for (const match of source.matchAll(/role="(?:alert)?dialog"/gu)) {
        const tag = openingTag(source, match.index);
        dialogs.push(`${relative(root, file)}: ${tag.includes('aria-modal="true"') ? "modal" : tag}`);
      }
    }
    expect(dialogs.length).toBeGreaterThanOrEqual(6);
    expect(dialogs.filter((line) => !line.endsWith(": modal"))).toEqual([]);
  });
});
