import { describe, expect, it } from "vitest";
import { formatMoney, MINUS_SIGN, moneyParts, parseMoney } from "./money";

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
    expect(formatMoney(-1)).toBe("\u22120,01\u00a0₽");
  });

  it("точно форматирует большие и отрицательные safe integer суммы", () => {
    expect(formatMoney(Number.MAX_SAFE_INTEGER)).toBe(
      "90\u00a0071\u00a0992\u00a0547\u00a0409,91\u00a0₽",
    );
    expect(formatMoney(9_007_199_254_730_993)).toBe(
      "90\u00a0071\u00a0992\u00a0547\u00a0309,93\u00a0₽",
    );
    expect(formatMoney(-Number.MAX_SAFE_INTEGER)).toBe(
      "\u221290\u00a0071\u00a0992\u00a0547\u00a0409,91\u00a0₽",
    );
  });

  it("минус в сумме — типографский U+2212, а не дефис: он равен ширине цифры", () => {
    expect(MINUS_SIGN).toBe("\u2212");
    for (const minor of [-1, -150_000, -Number.MAX_SAFE_INTEGER]) {
      expect(formatMoney(minor).startsWith(MINUS_SIGN)).toBe(true);
      expect(formatMoney(minor)).not.toContain("-");
    }
    expect(formatMoney(0).startsWith(MINUS_SIGN)).toBe(false);
  });

  it("разбирает сумму на знак, число и знак валюты с его отбивкой", () => {
    expect(moneyParts(150_001)).toEqual({ sign: "", value: "1\u00a0500,01", currency: "\u00a0₽" });
    expect(moneyParts(-150_000)).toEqual({ sign: MINUS_SIGN, value: "1\u00a0500", currency: "\u00a0₽" });
    expect(moneyParts(0)).toEqual({ sign: "", value: "0", currency: "\u00a0₽" });
    for (const minor of [0, 1, -1, 150_001, Number.MAX_SAFE_INTEGER, -Number.MAX_SAFE_INTEGER]) {
      const parts = moneyParts(minor);
      expect(`${parts.sign}${parts.value}${parts.currency}`).toBe(formatMoney(minor));
    }
    expect(() => moneyParts(1.5)).toThrow();
  });

  it("набирает любую валюту теми же правилами: точность валюты, неразрывные пробелы, U+2212, знак после числа", () => {
    expect(formatMoney(4_050, "USD")).toBe("40,50\u00a0$");
    expect(formatMoney(4_000, "USD")).toBe("40\u00a0$");
    expect(formatMoney(-123_456_789, "EUR")).toBe("\u22121\u00a0234\u00a0567,89\u00a0€");
    // Иена без дробной части, динар — с тремя знаками.
    expect(formatMoney(150_000, "JPY")).toBe("150\u00a0000\u00a0¥");
    expect(formatMoney(1_234_567, "BHD")).toBe("1\u00a0234,567\u00a0BHD");
    expect(formatMoney(1_234_000, "BHD")).toBe("1\u00a0234\u00a0BHD");
    // Тенге платформа называет кодом — он и стоит знаком валюты.
    expect(moneyParts(1_840, "KZT")).toEqual({ sign: "", value: "18,40", currency: "\u00a0KZT" });
    // Рубли по умолчанию — те же, что прежде.
    expect(formatMoney(150_000)).toBe(formatMoney(150_000, "RUB"));
    for (const currency of ["RUB", "USD", "EUR", "JPY", "BHD", "KZT", "CNY"]) {
      for (const minor of [0, 1, -1, 99, 100, 150_001, Number.MAX_SAFE_INTEGER, -Number.MAX_SAFE_INTEGER]) {
        const parts = moneyParts(minor, currency);
        expect(`${parts.sign}${parts.value}${parts.currency}`).toBe(formatMoney(minor, currency));
        expect(parts.currency.startsWith("\u00a0"), `${currency}: отбивка перед знаком неразрывная`).toBe(true);
        expect(parts.value, `${currency}: дефиса в сумме нет`).not.toContain("-");
      }
    }
  });

  it("разбирает сумму с точностью её валюты", () => {
    expect(parseMoney("1 500", 0)).toBe(1_500);
    expect(() => parseMoney("15,5", 0)).toThrow("целым числом");
    expect(parseMoney("1,234", 3)).toBe(1_234);
    expect(parseMoney("1,2", 3)).toBe(1_200);
    expect(() => parseMoney("1,2345", 3)).toThrow();
    expect(parseMoney("40,5")).toBe(4_050);
  });
});
