/// <reference types="node" />
import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { handlePlainCopy, plainInputValue, withoutSoftHyphens, type PlainInputTarget } from "./plain-text";

const SOFT = "\u00ad";

/** Поле в миниатюре: значение и каретка, как у настоящего. */
function field(value: string, caret: number | null): PlainInputTarget & { readonly moves: [number, number][] } {
  const moves: [number, number][] = [];
  return { value, selectionStart: caret, setSelectionRange: (start, end) => { moves.push([start, end]); }, moves };
}

describe("мягкие переносы не уходят из приложения (ревью 2b, раунд 3, NEW-3)", () => {
  it("снимается U+00AD — и ни один другой символ, даже невидимый", () => {
    expect(withoutSoftHyphens(`Тра${SOFT}н${SOFT}с${SOFT}порт`)).toBe("Транспорт");
    // Остальное — дело правила домена и его слов: пробелы, соединители, селекторы, BOM, неразрывный
    // дефис — как были.
    const others = "a\u00a0b\u202fc\u200bd\u200ce\u200df\u2060g\ufeffh\u034fi\u180ej\u2011k-l\ufe0fm\u202en\u00adо";
    expect(withoutSoftHyphens(others)).toBe(others.replace(SOFT, ""));
    expect([...withoutSoftHyphens(others)]).toHaveLength([...others].length - 1);
    const plain = "Пятёрочка у дома";
    expect(withoutSoftHyphens(plain)).toBe(plain);
  });

  it("поле: вставленное без мягких переносов, каретка — за тем же символом", () => {
    const pasted = field(`Чек: Тра${SOFT}н${SOFT}с${SOFT}порт!`, `Чек: Тра${SOFT}н${SOFT}с${SOFT}порт`.length);
    expect(plainInputValue(pasted)).toBe("Чек: Транспорт!");
    expect(pasted.value).toBe("Чек: Транспорт!");
    expect(pasted.moves).toEqual([["Чек: Транспорт".length, "Чек: Транспорт".length]]);
    // Без мягких переносов поле не трогается вовсе: ни значение, ни каретка.
    const typed = field("Чек", 1);
    expect(plainInputValue(typed)).toBe("Чек");
    expect(typed.moves).toEqual([]);
  });

  it("копирование: выделенное с U+00AD уходит в буфер без них; без них — копируется как всегда", () => {
    const copy = (selected: string, target: unknown = {}) => {
      const setData = vi.fn();
      const preventDefault = vi.fn();
      handlePlainCopy({ target, clipboardData: { setData }, preventDefault }, () => selected);
      return { setData, preventDefault };
    };
    const tile = copy(`Тра${SOFT}н${SOFT}с${SOFT}порт`);
    expect(tile.setData).toHaveBeenCalledWith("text/plain", "Транспорт");
    expect(tile.preventDefault).toHaveBeenCalledOnce();
    const ordinary = copy("Продукты 12 300 ₽");
    expect(ordinary.setData).not.toHaveBeenCalled();
    expect(ordinary.preventDefault).not.toHaveBeenCalled();
    // Из поля ввода копируется его выделение, а не выделение документа.
    const input = copy("", { value: `Да${SOFT}ча и сад`, selectionStart: 0, selectionEnd: 5 });
    expect(input.setData).toHaveBeenCalledWith("text/plain", "Дача");
  });

  it("поля имён и комментария снимают мягкие переносы — каждое", () => {
    // Имя категории, метки, обязательства, платежа, лимита, семьи, счёта и категорий первого запуска;
    // комментарий операции; поиск по операциям; справочники 2c — счёт, категория, новая метка и
    // переименование метки.
    const fields: readonly (readonly [string, string])[] = [
      ["features/entry/NoteField.tsx", 'id="entry-note"'],
      ["features/entry/TagChips.tsx", 'id="entry-new-tag"'],
      ["features/categories/CategorySheet.tsx", 'id="category-sheet-name"'],
      ["features/categories/CategoryScreen.tsx", 'id="category-name"'],
      ["features/accounts/AccountScreen.tsx", 'id="account-name"'],
      ["features/tags/TagsScreen.tsx", 'id="tag-new-name"'],
      ["features/tags/TagsScreen.tsx", "id={`tag-rename-${tag.id}`}"],
      ["features/operations/HistoryScreen.tsx", 'id="operation-history-search"'],
      ["features/planning/PlanningScreen.tsx", 'id="commitment-name"'],
      ["features/planning/PlanningScreen.tsx", 'id="schedule-name"'],
      ["features/planning/PlanningScreen.tsx", 'id="flexible-name"'],
      ["onboarding/Onboarding.tsx", 'id="householdLabel"'],
      ["onboarding/Onboarding.tsx", 'id="accountLabel"'],
      ["onboarding/Onboarding.tsx", 'id="mandatoryName"'],
      ["onboarding/Onboarding.tsx", "id={nameId}"],
    ];
    for (const [file, id] of fields) {
      const source = readFileSync(new URL(file, import.meta.url), "utf8");
      const at = source.indexOf(id);
      expect(at, `${file}: ${id}`).toBeGreaterThan(-1);
      const tag = source.slice(source.lastIndexOf("<input", at), source.indexOf("/>", at));
      expect(tag, `${file}: ${id}`).toContain("plainInputValue(event.currentTarget)");
    }
  });
});
