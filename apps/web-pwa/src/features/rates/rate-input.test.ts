import { convertMinor } from "@family-budget/domain";
import { describe, expect, it } from "vitest";
import { parseRateInput, ratePer } from "./rate-input";

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
