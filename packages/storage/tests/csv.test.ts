import { describe, expect, it } from "vitest";
import {
  MAX_CSV_FIELD_LENGTH,
  MAX_CSV_ROWS,
  serializeHumanReadableCsv,
} from "../src";

describe("human-readable CSV export", () => {
  it("добавляет UTF-8 BOM, RFC4180 quoting и нейтрализует формулы", () => {
    const csv = serializeHumanReadableCsv(
      ["name", "note"],
      [
        ["=1+1", "comma, quote \" and newline\n"],
        ["+SUM(A1:A2)", "-1"],
        ["@cmd", "\tformula"],
        ["\rformula", "обычный текст"],
      ],
    );

    expect(csv.startsWith("\uFEFF")).toBe(true);
    expect(csv).toContain("'=1+1");
    expect(csv).toContain("'+SUM(A1:A2)");
    expect(csv).toContain("'@cmd");
    expect(csv).toContain("'-1");
    expect(csv).toContain("'\tformula");
    expect(csv).toContain("'\rformula");
    expect(csv).toContain('"comma, quote "" and newline\n"');
    expect(csv.split("\r\n").length).toBe(6);
  });

  it("отклоняет чрезмерные rows и fields", () => {
    expect(() => serializeHumanReadableCsv(["value"], Array.from({ length: MAX_CSV_ROWS + 1 }, () => ["x"]))).toThrow(/слишком много строк/);
    expect(() => serializeHumanReadableCsv(["value"], [["x".repeat(MAX_CSV_FIELD_LENGTH + 1)]])).toThrow(/длину/);
    const wideRows = Array.from({ length: 600 }, () => Array.from({ length: 100 }, () => "x".repeat(100)));
    expect(() => serializeHumanReadableCsv(Array.from({ length: 100 }, (_, index) => `h${index}`), wideRows)).toThrow(/5 МБ/);
  });

  it("оставляет безопасное отрицательное число числом, но защищает строку с минусом", () => {
    const csv = serializeHumanReadableCsv(["value"], [[-12345], ["-12345"]]);
    expect(csv).toContain("\r\n-12345\r\n'-12345\r\n");
  });

  it("обнаруживает формулу после bounded whitespace, controls и invisible Unicode", () => {
    const csv = serializeHumanReadableCsv(
      ["value"],
      [[" =1"], ["\n+1"], ["\0-1"], ["\u200b@cmd"], ["\ufeff=2"]],
    );
    expect(csv).toContain("' =1");
    expect(csv).toContain('"\'\n+1"');
    expect(csv).toContain("'\0-1");
    expect(csv).toContain("'\u200b@cmd");
    expect(csv).toContain("'\ufeff=2");
  });

  it("защищает формулы после bidi controls U+061C и U+2066–U+2069", () => {
    const csv = serializeHumanReadableCsv(
      ["value"],
      [["\u2066=4"], ["\u2067+4"], ["\u2068-4"], ["\u2069@4"], ["\u061c=5"]],
    );
    expect(csv).toContain("'\u2066=4");
    expect(csv).toContain("'\u2067+4");
    expect(csv).toContain("'\u2068-4");
    expect(csv).toContain("'\u2069@4");
    expect(csv).toContain("'\u061c=5");
  });
});
