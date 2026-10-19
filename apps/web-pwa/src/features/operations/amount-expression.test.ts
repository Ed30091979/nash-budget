import { describe, expect, it } from "vitest";
import { AMOUNT_MAX_LENGTH, amountText, editAmount, evaluateAmount, normalizeAmountText, settleAmount } from "./amount-expression";

/**
 * Сумма как выражение: то, что набирает клавиатура суммы, и то, что вставляют из буфера.
 *
 * Считается слева направо, как на простом калькуляторе; итог округляется до копейки; перед
 * записью выражение сворачивается в число. Разбор один на клавиши, физическую клавиатуру и
 * буфер, поэтому здесь проверяются все три входа.
 */
describe("выражение суммы", () => {
  it("читает число так же, как поле читало его до клавиатуры", () => {
    expect(evaluateAmount("1200")).toEqual({ kind: "value", minor: 120_000, compound: false });
    expect(evaluateAmount("1200,5")).toEqual({ kind: "value", minor: 120_050, compound: false });
    expect(evaluateAmount("1200.50")).toEqual({ kind: "value", minor: 120_050, compound: false });
    // Из буфера — «1 234,56» из банковской СМС, с обычным и неразрывным пробелом.
    expect(evaluateAmount("1 234,56")).toEqual({ kind: "value", minor: 123_456, compound: false });
    expect(evaluateAmount("1 234,56")).toEqual({ kind: "value", minor: 123_456, compound: false });
    expect(evaluateAmount("")).toEqual({ kind: "empty" });
    expect(evaluateAmount("   ")).toEqual({ kind: "empty" });
  });

  it("складывает два чека, делит счёт пополам и считает слева направо", () => {
    expect(evaluateAmount("1200+350")).toEqual({ kind: "value", minor: 155_000, compound: true });
    expect(evaluateAmount("3000÷2")).toEqual({ kind: "value", minor: 150_000, compound: true });
    // Слева направо: половина от суммы двух чеков, а не чек плюс половина второго.
    expect(evaluateAmount("1200+350÷2")).toEqual({ kind: "value", minor: 77_500, compound: true });
    expect(evaluateAmount("1500−300")).toEqual({ kind: "value", minor: 120_000, compound: true });
    // С физической клавиатуры: дефис, косая черта и звёздочка.
    expect(evaluateAmount("1500-300")).toEqual({ kind: "value", minor: 120_000, compound: true });
    expect(evaluateAmount("3000/2")).toEqual({ kind: "value", minor: 150_000, compound: true });
    expect(evaluateAmount("250*3")).toEqual({ kind: "value", minor: 75_000, compound: true });
  });

  it("округляет до копейки, половину — от нуля", () => {
    expect(evaluateAmount("100÷3")).toEqual({ kind: "value", minor: 3_333, compound: true });
    expect(evaluateAmount("200÷3")).toEqual({ kind: "value", minor: 6_667, compound: true });
    expect(evaluateAmount("0,01÷2")).toEqual({ kind: "value", minor: 1, compound: true });
    expect(evaluateAmount("10,05×1,5")).toEqual({ kind: "value", minor: 1_508, compound: true });
  });

  it("незавершённое выражение считает по тому, что уже есть: предпросмотр не гаснет", () => {
    expect(evaluateAmount("1200+")).toEqual({ kind: "value", minor: 120_000, compound: false });
    expect(evaluateAmount("1200,")).toEqual({ kind: "value", minor: 120_000, compound: false });
    expect(evaluateAmount("1200+350−")).toEqual({ kind: "value", minor: 155_000, compound: true });
  });

  it("называет ошибку словами домена и не пропускает ни нуля, ни деления на ноль", () => {
    expect(evaluateAmount("0")).toEqual({ kind: "error", message: "Сумма должна быть больше нуля." });
    expect(evaluateAmount("300−300")).toEqual({ kind: "error", message: "Сумма должна быть больше нуля." });
    expect(evaluateAmount("100−300")).toEqual({ kind: "error", message: "Сумма должна быть больше нуля." });
    expect(evaluateAmount("100÷0")).toEqual({ kind: "error", message: "На ноль делить нельзя." });
    expect(evaluateAmount("+100")).toEqual({ kind: "error", message: "Введите положительную сумму, не более двух знаков после запятой." });
    expect(evaluateAmount("1,234")).toEqual({ kind: "error", message: "Введите положительную сумму, не более двух знаков после запятой." });
    expect(evaluateAmount("12a")).toEqual({ kind: "error", message: "Введите положительную сумму, не более двух знаков после запятой." });
    expect(evaluateAmount("1".repeat(AMOUNT_MAX_LENGTH + 1))).toEqual({ kind: "error", message: "Сумма превышает максимально допустимое значение." });
    expect(evaluateAmount("99999999999999×99999999")).toEqual({ kind: "error", message: "Сумма превышает максимально допустимое значение." });
  });

  it("сворачивает выражение в число перед записью и оставляет неразобранное как есть", () => {
    expect(settleAmount("1200+350")).toBe("1550");
    expect(settleAmount("100÷3")).toBe("33,33");
    expect(settleAmount("1 234,56")).toBe("1234,56");
    expect(settleAmount("1200+")).toBe("1200");
    expect(settleAmount("12a")).toBe("12a");
    expect(settleAmount("")).toBe("");
    expect(amountText(120_050)).toBe("1200,50");
    expect(normalizeAmountText(" 1 200.50 - 3 / 2 * 4 ")).toBe("1200,50−3÷2×4");
  });
});

describe("клавиша клавиатуры суммы", () => {
  it("набирает в конец, когда поле не в фокусе, и по каретке, когда в фокусе", () => {
    expect(editAmount("12", "0", null)).toEqual({ text: "120", caret: 3 });
    expect(editAmount("120", "5", { start: 1, end: 1 })).toEqual({ text: "1520", caret: 2 });
    // Выделенное заменяется, как с обычной клавиатуры.
    expect(editAmount("1200", "7", { start: 0, end: 4 })).toEqual({ text: "7", caret: 1 });
  });

  it("стирает символ перед кареткой или выделение", () => {
    expect(editAmount("1200", "backspace", null)).toEqual({ text: "120", caret: 3 });
    expect(editAmount("1200", "backspace", { start: 2, end: 2 })).toEqual({ text: "100", caret: 1 });
    expect(editAmount("1200", "backspace", { start: 1, end: 3 })).toEqual({ text: "10", caret: 1 });
    expect(editAmount("", "backspace", null)).toEqual({ text: "", caret: 0 });
  });

  it("не даёт набрать то, чего разбор не примет", () => {
    // Вторая запятая в одном числе, третья копейка.
    expect(editAmount("12,5", ",", null)).toEqual({ text: "12,5", caret: 4 });
    expect(editAmount("12,50", "1", null)).toEqual({ text: "12,50", caret: 5 });
    // Запятая в пустом числе — «0,»; после знака — новое число тоже с нуля.
    expect(editAmount("", ",", null)).toEqual({ text: "0,", caret: 2 });
    expect(editAmount("12+", ",", null)).toEqual({ text: "12+0,", caret: 5 });
    // Знак в пустое поле не встаёт; знак после знака заменяет его; после запятой — снимает её.
    expect(editAmount("", "+", null)).toEqual({ text: "", caret: 0 });
    expect(editAmount("12+", "−", null)).toEqual({ text: "12−", caret: 3 });
    expect(editAmount("12,", "÷", null)).toEqual({ text: "12÷", caret: 3 });
    // Предел поля общий с `maxLength`.
    const full = "1".repeat(AMOUNT_MAX_LENGTH);
    expect(editAmount(full, "2", null)).toEqual({ text: full, caret: AMOUNT_MAX_LENGTH });
  });

  it("после знака следующее число считается заново: копейки предыдущего его не держат", () => {
    expect(editAmount("12,50+", "1", null)).toEqual({ text: "12,50+1", caret: 7 });
    expect(editAmount("12,50+3", ",", null)).toEqual({ text: "12,50+3,", caret: 8 });
  });

  it("считает в точности валюты: иена без дробной части, динар — с тремя знаками", () => {
    expect(evaluateAmount("1500", 0)).toEqual({ kind: "value", minor: 1_500, compound: false });
    expect(evaluateAmount("1000÷3", 0)).toEqual({ kind: "value", minor: 333, compound: true });
    expect(evaluateAmount("15,5", 0)).toEqual({ kind: "error", message: "Введите положительную сумму целым числом." });
    expect(evaluateAmount("1,234+0,001", 3)).toEqual({ kind: "value", minor: 1_235, compound: true });
    expect(evaluateAmount("1,2345", 3).kind).toBe("error");
    expect(amountText(1_500, 0)).toBe("1500");
    expect(amountText(1_235, 3)).toBe("1,235");
    expect(amountText(1_200, 3)).toBe("1,200");
    expect(amountText(1_000, 3)).toBe("1");
    expect(settleAmount("1000÷3", 0)).toBe("333");
    // Клавиши: у иены запятая ничего не ставит, у динара — третий знак после запятой есть, четвёртого нет.
    expect(editAmount("15", ",", null, 0)).toEqual({ text: "15", caret: 2 });
    expect(editAmount("1,23", "4", null, 3)).toEqual({ text: "1,234", caret: 5 });
    expect(editAmount("1,234", "5", null, 3)).toEqual({ text: "1,234", caret: 5 });
    expect(editAmount("1,23", "4", null)).toEqual({ text: "1,23", caret: 4 });
  });
});
