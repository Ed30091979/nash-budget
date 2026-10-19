import { describe, expect, it } from "vitest";
import { DEFAULT_CATEGORIES } from "@family-budget/domain";
import { softHyphenate } from "./hyphenation";

const shown = (text: string) => softHyphenate(text).replace(/\u00ad/gu, "-");

describe("мягкие переносы в именах плиток (ревью 2b, LOW-9)", () => {
  it("ставит перенос по школьным правилам: гласная в каждой части, две буквы с краю, согласная — со своей гласной", () => {
    expect(shown("Продукты")).toBe("Про-ду-к-ты");
    expect(shown("Транспорт")).toBe("Тра-н-с-порт");
    expect(shown("Здоровье")).toBe("Здо-ро-вье");
    expect(shown("Подработка")).toBe("По-д-ра-бо-т-ка");
    expect(shown("Жильё")).toBe("Жи-льё");
  });

  it("«й», «ь», «ъ» остаются с буквой перед ними; слова без гласных, числа и знаки — как были", () => {
    // Части слова по морфемам правила не знают: «по-дъ-езд» — но «ъ» строку не начинает.
    expect(shown("Подъезд")).toBe("По-дъ-езд");
    for (const word of ["Подъезд", "Здоровье", "Майка", "Объявление"]) expect(shown(word), word).not.toMatch(/-[йьъ]/u);
    expect(shown("Майка")).toBe("Май-ка");
    expect(shown("ЖКХ")).toBe("ЖКХ");
    expect(shown("Кафе и доставка")).toBe("Ка-фе и до-с-та-в-ка");
    expect(shown("Онлайн-кино 2026")).toBe("Он-лайн-ки-но 2026");
  });

  it("убери мягкие переносы — и имя то же: в тексте ничего, кроме них, не меняется", () => {
    for (const template of DEFAULT_CATEGORIES) {
      expect(softHyphenate(template.name).replace(/\u00ad/gu, ""), template.name).toBe(template.name);
    }
  });
});
