import { describe, expect, it } from "vitest";

import {
  createCategory,
  isDisplayKey,
  isNormalizedLabel,
  isNormalizedNote,
  makeSeedBudget,
  normalizeCategoryName,
  normalizeLabel,
  normalizeNote,
  TextValidationError,
  type TextErrorCode,
} from "../src/index.js";

function refusal(run: () => unknown): TextErrorCode | null {
  try {
    run();
    return null;
  } catch (error) {
    if (error instanceof TextValidationError) return error.code;
    throw error;
  }
}

describe("normalizeLabel", () => {
  it("stores a label in NFC without the surrounding whitespace", () => {
    expect(normalizeLabel("  Продукты  ", 40)).toBe("Продукты");
    // «й» typed as «и» plus a combining breve is the same label as the precomposed letter.
    expect(normalizeLabel("Чаи\u0306", 40)).toBe("Чай");
  });

  it("refuses an empty label, an overlong one and a megabyte before normalising it", () => {
    expect(refusal(() => normalizeLabel("   ", 40))).toBe("required");
    expect(refusal(() => normalizeLabel("я".repeat(41), 40))).toBe("too_long");
    expect(normalizeLabel("я".repeat(40), 40)).toHaveLength(40);
    expect(refusal(() => normalizeLabel(" ".repeat(161), 40))).toBe("too_long");
  });

  it("refuses hidden, control and bidirectional characters", () => {
    for (const hidden of ["\u0007", "\u007f", "\u0085", "\u200b", "\u202e", "\u2066", "\ufeff"]) {
      // Inside the label: at either end `trim` already removes the ones JavaScript counts as space.
      expect(refusal(() => normalizeLabel(`До${hidden}м`, 40)), JSON.stringify(hidden)).toBe("forbidden_characters");
    }
  });

  it("refuses look-alike alphabets in one label", () => {
    expect(refusal(() => normalizeLabel("Кафе Starbucks", 40))).toBe("mixed_scripts");
    expect(normalizeLabel("Starbucks", 40)).toBe("Starbucks");
  });

  it("is the rule a category name has always been held to", () => {
    for (const value of ["  Транспорт ", "Транспорт", "Чаи\u0306"]) {
      expect(normalizeCategoryName(value)).toBe(normalizeLabel(value, 80));
    }
    expect(() => normalizeCategoryName("Стра\u200bхование")).toThrow(/скрытые или служебные/);
    expect(() => normalizeCategoryName("")).toThrow(/Укажите название/);
  });
});

const LONE_HIGH_SURROGATE = String.fromCharCode(0xd800);
const LONE_LOW_SURROGATE = String.fromCharCode(0xdc00);

/**
 * The characters the journal codec refuses in any text, as code-point ranges: `UNSAFE_TEXT` in
 * `packages/sync-protocol/src/codec.ts`. The domain rule has to cover every one of them, or a
 * note the domain stored would be refused by every other device of the family.
 */
const CODEC_UNSAFE_RANGES: readonly (readonly [number, number])[] = [
  [0x0000, 0x001f],
  [0x007f, 0x009f],
  [0x200b, 0x200f],
  [0x2028, 0x2029],
  [0x202a, 0x202e],
  [0x2066, 0x2069],
  [0xfeff, 0xfeff],
  [0xfff9, 0xfffb],
  [0xd800, 0xdfff],
];

describe("one text rule, strictly wider than the journal's", () => {
  it("refuses every character the journal codec refuses, inside a label and inside a note", () => {
    for (const [first, last] of CODEC_UNSAFE_RANGES) {
      for (let code = first; code <= last; code += 1) {
        const character = String.fromCharCode(code);
        expect(refusal(() => normalizeNote(`Да${character}ча`)), code.toString(16)).toBe("forbidden_characters");
        expect(refusal(() => normalizeLabel(`Да${character}ча`, 40)), code.toString(16)).toBe("forbidden_characters");
      }
    }
  });

  it("refuses the line separator, the annotation marks and a lone surrogate in a name as well", () => {
    for (const hidden of ["\u2028", "\u2029", "\ufff9", "\ufffb", LONE_HIGH_SURROGATE, LONE_LOW_SURROGATE]) {
      expect(refusal(() => normalizeLabel(`До${hidden}м`, 40)), JSON.stringify(hidden)).toBe("forbidden_characters");
      expect(() => createCategory(makeSeedBudget(), { name: `До${hidden}м`, type: "expense" }))
        .toThrow(/скрытые или служебные/);
    }
    // A pair of surrogates is one character, an emoji, and stays.
    expect(normalizeNote("Отпуск \ud83c\udf34")).toBe("Отпуск \ud83c\udf34");
  });
});

describe("normalizeNote", () => {
  it("stores a note in NFC without the surrounding whitespace", () => {
    expect(normalizeNote("  Аванс за август ")).toBe("Аванс за август");
    expect(normalizeNote("Чаи\u0306 с мятой")).toBe("Чай с мятой");
  });

  it("has no empty note: an empty or blank one is no note at all", () => {
    expect(normalizeNote("")).toBeUndefined();
    expect(normalizeNote("   ")).toBeUndefined();
    expect(normalizeNote("\ufe0f")).toBeUndefined();
  });

  it("takes five hundred characters and refuses the five hundred and first", () => {
    expect(normalizeNote("я".repeat(500))).toHaveLength(500);
    expect(refusal(() => normalizeNote("я".repeat(501)))).toBe("too_long");
    expect(refusal(() => normalizeNote(" ".repeat(2_001)))).toBe("too_long");
  });

  it("is one line: a line feed, a tab and a carriage return are refused", () => {
    for (const control of ["\n", "\t", "\r", "\u0000", "\u0001", "\u007f", "\u0085"]) {
      expect(refusal(() => normalizeNote(`Пятёрочка${control}у дома`)), JSON.stringify(control)).toBe("forbidden_characters");
    }
  });

  it("refuses bidirectional controls, zero-width characters and the byte-order mark", () => {
    for (const hidden of ["\u202e", "\u2066", "\u200b", "\ufeff", "\u2028", "\ufff9"]) {
      expect(refusal(() => normalizeNote(`Пятёрочка${hidden} у дома`)), JSON.stringify(hidden)).toBe("forbidden_characters");
    }
  });

  it("drops emoji presentation selectors and keeps the emoji", () => {
    expect(normalizeNote("Цветы \u2764\ufe0f маме")).toBe("Цветы \u2764 маме");
    expect(normalizeNote("\u263a\ufe0e")).toBe("\u263a");
  });

  it("allows Latin and Cyrillic together in a note, and refuses them together in a label", () => {
    expect(normalizeNote("Кофе в Starbucks")).toBe("Кофе в Starbucks");
    expect(refusal(() => normalizeLabel("Кофе в Starbucks", 40))).toBe("mixed_scripts");
  });
});

describe("stored-text predicates", () => {
  it("accepts a note or a label exactly as it would be stored, and nothing else", () => {
    expect(isNormalizedNote("Доставка воды")).toBe(true);
    expect(isNormalizedNote(" Доставка воды")).toBe(false);
    expect(isNormalizedNote("")).toBe(false);
    expect(isNormalizedNote("Цветы \u2764\ufe0f")).toBe(false);
    expect(isNormalizedNote("я".repeat(501))).toBe(false);
    expect(isNormalizedNote(42)).toBe(false);
    expect(isNormalizedLabel("Отпуск", 40)).toBe(true);
    expect(isNormalizedLabel("Отпуск ", 40)).toBe(false);
    expect(isNormalizedLabel("я".repeat(41), 40)).toBe(false);
    expect(isNormalizedLabel(null, 40)).toBe(false);
  });

  it("knows a design-token key from a colour, a file name and everything else", () => {
    for (const key of ["sage", "shopping-basket", "plane", "a1", "x".repeat(40)]) {
      expect(isDisplayKey(key), key).toBe(true);
    }
    for (const value of ["", "#00ff00", "Sage", "icon.svg", "-sage", "sage-", "sage--mint", "1st", "x".repeat(41), 7]) {
      expect(isDisplayKey(value), String(value)).toBe(false);
    }
  });
});
