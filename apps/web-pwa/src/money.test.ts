import { describe, expect, it } from "vitest";
import { formatMoney, parseMoney } from "./money";

describe("денежный ввод", () => {
  it("переводит рубли и копейки в integer minor units", () => {
    expect(parseMoney("1 234,56")).toBe(123_456);
    expect(parseMoney("1\u00a0234\u202f567.8")).toBe(123_456_780);
    expect(parseMoney("100")).toBe(10_000);
  });

  it("не принимает отрицательные, нулевые и неточные суммы", () => {
    expect(() => parseMoney("-1")).toThrow();
    expect(() => parseMoney("0")).toThrow();
    expect(() => parseMoney("0,00")).toThrow();
    expect(() => parseMoney("10,001")).toThrow();
    expect(() => parseMoney("1e3")).toThrow();
  });

  it("точно разбирает крупные суммы без floating-point округления", () => {
    expect(parseMoney("90071992547309.93")).toBe(9_007_199_254_730_993);
    expect(parseMoney("90071992547409.91")).toBe(Number.MAX_SAFE_INTEGER);
    expect(() => parseMoney("90071992547409.92")).toThrow(
      "Сумма превышает максимально допустимое значение.",
    );
  });

  it("отклоняет огромную вставку до нормализации и преобразования в BigInt", () => {
    expect(() => parseMoney("9".repeat(100_000))).toThrow(
      "Сумма превышает максимально допустимое значение.",
    );
    expect(() => parseMoney(" ".repeat(100_000))).toThrow(
      "Сумма превышает максимально допустимое значение.",
    );
    expect(parseMoney(" 90 071 992 547 409,91 ")).toBe(Number.MAX_SAFE_INTEGER);
  });

  it("точно форматирует обычные рубли и копейки", () => {
    expect(formatMoney(150_000)).toBe("1\u00a0500\u00a0₽");
    expect(formatMoney(150_001)).toBe("1\u00a0500,01\u00a0₽");
    expect(formatMoney(-1)).toBe("-0,01\u00a0₽");
  });

  it("точно форматирует большие и отрицательные safe integer суммы", () => {
    expect(formatMoney(Number.MAX_SAFE_INTEGER)).toBe(
      "90\u00a0071\u00a0992\u00a0547\u00a0409,91\u00a0₽",
    );
    expect(formatMoney(9_007_199_254_730_993)).toBe(
      "90\u00a0071\u00a0992\u00a0547\u00a0309,93\u00a0₽",
    );
    expect(formatMoney(-Number.MAX_SAFE_INTEGER)).toBe(
      "-90\u00a0071\u00a0992\u00a0547\u00a0409,91\u00a0₽",
    );
  });
});
