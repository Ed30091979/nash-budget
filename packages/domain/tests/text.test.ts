import { describe, expect, it } from "vitest";

import { normalizeCategoryName, normalizeLabel, TextValidationError, type TextErrorCode } from "../src/index.js";

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
