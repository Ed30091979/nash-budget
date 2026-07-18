import { describe, expect, it } from "vitest";
import { formatMoney, parseMoney } from "./money";

describe("денежный ввод", () => {
  it("переводит рубли и копейки в integer minor units", () => {
    expect(parseMoney("1 234,56")).toBe(123_456);
    expect(parseMoney("100")).toBe(10_000);
  });

  it("не принимает отрицательные суммы и лишнюю точность", () => {
    expect(() => parseMoney("-1")).toThrow();
    expect(() => parseMoney("10,001")).toThrow();
  });

  it("форматирует minor units без вычислений с плавающей точкой в модели", () => {
    expect(formatMoney(150_000)).toMatch(/1\s?500/);
  });
});
