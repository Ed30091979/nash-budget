import { convertMinor, isExchangeRateValue, RATE_PART_MAX, RATE_PART_MIN } from "@family-budget/domain";
import { describe, expect, it } from "vitest";
import { formatRateValue, parseRateInput, ratePer } from "./rate-input";

describe("курс, набранный человеком", () => {
  it("«1 USD = 92,50 ₽» — точная пара, которая переводит центы в копейки без потерь", () => {
    const parsed = parseRateInput("92,50", "USD", "RUB");
    expect(parsed.kind).toBe("rate");
    if (parsed.kind !== "rate") return;
    expect(parsed.rate.baseMinor / parsed.rate.quoteMinor).toBe(92.5);
    expect(convertMinor(1_250, parsed.rate)).toBe(115_625);
    expect(parseRateInput("92.5", "USD", "RUB")).toEqual(parsed);
    expect(parseRateInput("92,123456", "USD", "RUB").kind).toBe("rate");
  });

  it("слабая валюта — за сотню: «100 KZT = 18,40 ₽»; иена без центов", () => {
    expect(ratePer("KZT")).toBe(100);
    expect(ratePer("USD")).toBe(1);
    const kzt = parseRateInput("18,40", "KZT", "RUB");
    expect(kzt.kind === "rate" ? convertMinor(10_000, kzt.rate) : null).toBe(1_840);
    const yen = parseRateInput("60", "JPY", "RUB");
    expect(yen.kind === "rate" ? convertMinor(100, yen.rate) : null).toBe(6_000);
  });

  it("отказывает словами: ноль, мусор, лишние знаки, выход за пределы модели", () => {
    for (const text of ["", "0", "0,000", "abc", "1,2345678", "-5", "1e3", "92,5,0"]) {
      expect(parseRateInput(text, "USD", "RUB").kind, text).toBe("error");
    }
    expect(parseRateInput("999999999999,999999", "USD", "RUB").kind).toBe("error");
  });
});

describe("курс, набранный человеком: края", () => {
  it("запятая и точка — одно и то же; пробелы между разрядами, в том числе неразрывные, не мешают", () => {
    const comma = parseRateInput("1 092,5", "USD", "RUB");
    expect(comma.kind).toBe("rate");
    for (const text of ["1092.5", "1092,50", "1 092,5", " 1092,500000 "]) expect(parseRateInput(text, "USD", "RUB"), text).toEqual(comma);
    for (const text of ["92,", ",5", "92,5.0", "1.000.5", "92;5", "٩٢"]) expect(parseRateInput(text, "USD", "RUB").kind, text).toBe("error");
  });

  it("до шести знаков после запятой — точно; седьмой — отказ, а не округление", () => {
    const six = parseRateInput("0,000001", "USD", "RUB", 1);
    expect(six.kind).toBe("rate");
    if (six.kind === "rate") expect(six.rate).toEqual({ baseMinor: 1, quoteMinor: 1_000_000 });
    expect(parseRateInput("0,0000001", "USD", "RUB").kind).toBe("error");
    const exact = parseRateInput("92,123456", "USD", "RUB");
    expect(exact.kind === "rate" ? exact.rate : null).toEqual({ baseMinor: 1_439_429, quoteMinor: 15_625 });
  });

  it("обе части пары — в пределах модели [1, 10¹²]: ни ноль, ни триллион с хвостом не проходят", () => {
    // Пара сокращается на общий делитель — граница проверяется после сокращения.
    expect(parseRateInput("999999999999", "USD", "RUB")).toEqual({ kind: "rate", rate: { baseMinor: 999_999_999_999, quoteMinor: 1 } });
    const huge = parseRateInput("999999999999,1", "USD", "RUB");
    expect(huge.kind).toBe("error");
    const largest = parseRateInput("9999999999", "USD", "RUB");
    expect(largest.kind === "rate" ? largest.rate : null).toEqual({ baseMinor: 9_999_999_999, quoteMinor: 1 });
    for (const part of largest.kind === "rate" ? [largest.rate.baseMinor, largest.rate.quoteMinor] : []) {
      expect(part).toBeGreaterThanOrEqual(RATE_PART_MIN);
      expect(part).toBeLessThanOrEqual(RATE_PART_MAX);
    }
    // Слабая валюта за сотню и шесть знаков: делитель вырос, но остался в пределах.
    const yen = parseRateInput("0,612345", "JPY", "RUB");
    expect(yen.kind === "rate" ? isExchangeRateValue(yen.rate) : false).toBe(true);
  });

  it("слабые валюты называют за сотню, крепкие — за единицу; динар с тремя знаками считается верно", () => {
    for (const currency of ["KZT", "AMD", "UZS", "KGS", "JPY", "KRW", "VND", "IDR", "HUF"]) expect(ratePer(currency), currency).toBe(100);
    for (const currency of ["USD", "EUR", "CNY", "GBP", "BYN", "KWD"]) expect(ratePer(currency), currency).toBe(1);
    const dinar = parseRateInput("300", "KWD", "RUB");
    expect(dinar.kind === "rate" ? convertMinor(1_000, dinar.rate) : null).toBe(30_000);
    const tenge = parseRateInput("18,4", "KZT", "RUB");
    expect(tenge.kind === "rate" ? convertMinor(1_000_000, tenge.rate) : null).toBe(184_000);
  });

  it("курс модели читается тем числом, которым его набрали, и набирается обратно тем же курсом", () => {
    for (const [text, quote, shown] of [
      ["92,5", "USD", "92,50"], ["92,123456", "USD", "92,123456"], ["18,40", "KZT", "18,40"], ["60", "JPY", "60,00"],
      ["1 234,5", "EUR", "1 234,50"], ["0,000001", "USD", "0,000001"], ["300", "KWD", "300,00"],
    ] as const) {
      const parsed = parseRateInput(text, quote, "RUB");
      expect(parsed.kind, text).toBe("rate");
      if (parsed.kind !== "rate") continue;
      const value = formatRateValue(parsed.rate, quote, "RUB");
      expect(value.replace(/\s/gu, " "), text).toBe(shown);
      expect(parseRateInput(value, quote, "RUB"), text).toEqual(parsed);
    }
    // Курс, которого человек не набирал (сумма за сумму), — шесть знаков, половина вверх.
    expect(formatRateValue({ baseMinor: 115_700, quoteMinor: 1_250 }, "USD", "RUB")).toBe("92,56");
    expect(formatRateValue({ baseMinor: 1, quoteMinor: 3 }, "USD", "RUB")).toBe("0,333333");
  });
});
