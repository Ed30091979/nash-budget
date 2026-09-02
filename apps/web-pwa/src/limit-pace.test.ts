/// <reference types="node" />
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  AHEAD_OF_PACE_NOTE,
  PERCENT_STEPS,
  limitBar,
  localToday,
  percentStep,
  periodProgress,
} from "./limit-pace";

const styles = readFileSync(new URL("./styles.css", import.meta.url), "utf8");

describe("темп месяца в строке лимита", () => {
  it("считает прошедшую долю периода по календарным дням включительно", () => {
    expect(periodProgress("2026-07-01", "2026-07-31", "2026-07-01")).toBeCloseTo(1 / 31, 6);
    expect(periodProgress("2026-07-01", "2026-07-31", "2026-07-16")).toBeCloseTo(16 / 31, 6);
    expect(periodProgress("2026-07-01", "2026-07-31", "2026-07-31")).toBe(1);
  });

  it("за пределами периода не спрашивает про темп: до начала — ноль, после конца — всё", () => {
    expect(periodProgress("2026-07-01", "2026-07-31", "2026-06-30")).toBe(0);
    expect(periodProgress("2026-07-01", "2026-07-31", "2026-09-02")).toBe(1);
    expect(periodProgress("не дата", "2026-07-31", "2026-07-16")).toBe(1);
  });

  it("берёт сегодняшний день по календарю семьи, а не по UTC", () => {
    // 31 декабря 23:30 по местному времени в UTC уже первое января: маркер обязан стоять там,
    // где стоит календарь на стене, иначе в последний день месяца он прыгает в начало полосы.
    expect(localToday(new Date(2026, 11, 31, 23, 30))).toBe("2026-12-31");
    expect(localToday(new Date(2026, 0, 5, 0, 15))).toBe("2026-01-05");
  });

  it("квантует долю шагом шкалы и не выходит за её края", () => {
    expect(percentStep(0.733)).toBe(75);
    expect(percentStep(0.71)).toBe(70);
    expect(percentStep(-3)).toBe(0);
    expect(percentStep(4)).toBe(100);
    expect(percentStep(Number.NaN)).toBe(0);
  });

  it("объявляет в таблице стилей ровно ту шкалу, которой пользуется разметка", () => {
    // Квантование существует потому, что CSP запрещает инлайновые стили. Значит шкала живёт в
    // двух местах сразу, и разъехаться им нельзя: полоса без своего правила осталась бы пустой.
    for (const step of PERCENT_STEPS) {
      expect(styles, `заливка ${step} %`).toContain(`.limit-bar[data-spent="${step}"] { --limit-fill: ${step}%; }`);
      expect(styles, `темп ${step} %`).toContain(`.category-list[data-pace="${step}"] { --limit-pace: ${step}%; }`);
    }
  });

  it("красит красным только факт превышения лимита, а опережение темпа — янтарным", () => {
    const over = limitBar({ name: "Продукты", execution: 1.2, overLimit: true, pace: 0.5 });
    const ahead = limitBar({ name: "Продукты", execution: 0.73, overLimit: false, pace: 0.5 });
    const within = limitBar({ name: "Транспорт", execution: 0.4, overLimit: false, pace: 0.5 });

    expect(over.className).toContain("over");
    expect(ahead.className).toContain("ahead");
    expect(within.className).toContain("within");
    expect(styles).toContain(".limit-bar.over { --limit-ink: var(--red-ink); }");
    expect(styles).toContain(".limit-bar.ahead { --limit-ink: var(--amber-ink); }");
  });

  it("не оставляет состояние одному цвету: маркер, подпись и объявление говорят то же самое", () => {
    const ahead = limitBar({ name: "Продукты", execution: 0.73, overLimit: false, pace: 0.5 });
    const within = limitBar({ name: "Транспорт", execution: 0.4, overLimit: false, pace: 0.5 });

    expect(ahead.note).toBe(AHEAD_OF_PACE_NOTE);
    expect(within.note).toBeNull();
    expect(ahead.label).toBe("Продукты: потрачено 73 % лимита, прошло 50 % месяца — тратите быстрее, чем идёт месяц");
    expect(within.label).toContain("тратите не быстрее, чем идёт месяц");
    expect(limitBar({ name: "Дом", execution: 1.2, overLimit: true, pace: 0.5 }).label).toContain("лимит превышен");
  });

  it("ставит маркер темпа на ту подложку, на которой он читается", () => {
    // Одним цветом обе подложки не покрыть: контрастная к светлому треку метка темнее любой
    // заливки. Поэтому метка переезжает вместе с границей заливки — это и есть «порядок стопов
    // меняется» из §4 исследования.
    expect(limitBar({ name: "Продукты", execution: 0.73, overLimit: false, pace: 0.5 }).className)
      .toContain("marker-on-fill");
    expect(limitBar({ name: "Транспорт", execution: 0.4, overLimit: false, pace: 0.5 }).className)
      .toContain("marker-on-track");
    expect(styles).toContain(".limit-bar.marker-on-fill { --limit-marker: var(--surface); }");
  });

  it("строка без лимита показывает пустую полосу, а трата сверх нулевого плана — полную", () => {
    expect(limitBar({ name: "Досуг", execution: null, overLimit: false, pace: 0.5 }).spent).toBe(0);
    expect(limitBar({ name: "Досуг", execution: null, overLimit: true, pace: 0.5 }).spent).toBe(100);
  });
});
