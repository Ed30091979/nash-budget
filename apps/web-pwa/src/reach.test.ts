/// <reference types="node" />
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  PERCENT_STEPS,
  REACH_MARK_PERCENT,
  daysBetween,
  daysElapsed,
  localToday,
  nextPayday,
  percentStep,
  reach,
  reachWord,
  runsOutOn,
} from "./reach";

const styles = readFileSync(new URL("./styles.css", import.meta.url), "utf8");
const design = readFileSync(new URL("../../../DESIGN.md", import.meta.url), "utf8");

/** Месяц из образца: сегодня 9 июля, выплата 20-го, до неё 11 дней. */
const TODAY = "2026-07-09";
const PERIOD_START = "2026-07-01";
const PERIOD_END = "2026-07-31";

describe("дата следующей выплаты выводится, а не хранится", () => {
  it("берёт число месяца из дат уже записанных доходов", () => {
    // Расписаний дохода в домене нет и не будет: это миграция хранилища, смена формата копии и
    // новая операция журнала. Дата живёт в слое представления — как иконки и тона категорий.
    const horizon = nextPayday(["2026-05-20", "2026-06-20"], TODAY, PERIOD_END);

    expect(horizon).toEqual({ date: "2026-07-20", source: "income", daysAhead: 11 });
  });

  it("прощает сдвиг на выходные: 18-е и 20-е — одна выплата, а не две разные", () => {
    expect(nextPayday(["2026-05-18", "2026-06-20"], TODAY, PERIOD_END).date).toBe("2026-07-20");
  });

  it("находит ближайшую из двух выплат месяца, когда семья получает аванс и зарплату", () => {
    const horizon = nextPayday(
      ["2026-05-05", "2026-05-20", "2026-06-05", "2026-06-20"],
      "2026-07-01",
      PERIOD_END,
    );

    expect(horizon).toEqual({ date: "2026-07-05", source: "income", daysAhead: 4 });
  });

  it("честно откатывается к календарному месяцу, когда выводить не из чего", () => {
    // Это обязательный путь, а не запасной: у нового пользователя истории доходов нет вовсе.
    // Экран тогда говорит про месяц и ни слова про аванс, которого он не знает.
    expect(nextPayday([], TODAY, PERIOD_END))
      .toEqual({ date: PERIOD_END, source: "month", daysAhead: 22 });
    expect(nextPayday(["2026-06-20"], TODAY, PERIOD_END).source).toBe("month");
  });

  it("не выдаёт нерегулярные даты за расписание", () => {
    // Подработка приходит когда придётся. Двадцатого числа приложение её не назначит.
    expect(nextPayday(["2026-05-03", "2026-06-17", "2026-06-28"], TODAY, PERIOD_END).source).toBe("month");
  });

  it("не считает две выплаты одного месяца повторяющимся числом", () => {
    expect(nextPayday(["2026-06-04", "2026-06-06"], TODAY, PERIOD_END).source).toBe("month");
  });

  it("подрезает число месяца там, где его нет: 31-е февраля не бывает", () => {
    expect(nextPayday(["2025-12-31", "2026-01-31"], "2026-02-05", "2026-02-28").date).toBe("2026-02-28");
  });

  it("переносит календарную насечку на конец следующего месяца в последний день текущего", () => {
    const horizon = nextPayday([], PERIOD_END, PERIOD_END);

    expect(horizon.source).toBe("month");
    expect(horizon.daysAhead).toBeGreaterThanOrEqual(1);
    expect(horizon.date).toBe("2026-08-31");
  });

  it("берёт сегодняшний день по календарю семьи, а не по UTC", () => {
    // 31 декабря 23:30 по местному времени в UTC уже первое января: насечка обязана стоять там,
    // где стоит календарь на стене, иначе в последний день месяца она прыгает в начало полосы.
    expect(localToday(new Date(2026, 11, 31, 23, 30))).toBe("2026-12-31");
    expect(localToday(new Date(2026, 0, 5, 0, 15))).toBe("2026-01-05");
  });
});

describe("линейка до выплаты", () => {
  const untilPayday = { elapsedDays: 9, daysAhead: 11 };

  it("говорит «дотянет», когда денег хватает дальше насечки, и оставляет за ней запас", () => {
    const line = reach({ remainingMinor: 2_700_000, spentMinor: 1_800_000, ...untilPayday });

    expect(line.state).toBe("reaches");
    expect(line.perDayMinor).toBe(200_000);
    expect(Math.round(line.daysCovered ?? 0)).toBe(14);
    expect(line.surplusDays).toBe(2);
    expect(reachWord(line.state)).toBe("Дотянет");
  });

  it("говорит «не дотянет», когда денег не хватает до насечки", () => {
    const line = reach({ remainingMinor: 500_000, spentMinor: 2_700_000, ...untilPayday });

    expect(line.state).toBe("short");
    expect(line.surplusDays).toBe(0);
    expect(reachWord(line.state)).toBe("Не дотянет");
  });

  it("обрубает полосу в нуле, когда конверт исчерпан, — это факт, а не величина", () => {
    const empty = reach({ remainingMinor: 0, spentMinor: 500_000, ...untilPayday });
    const over = reach({ remainingMinor: 100_000, spentMinor: 500_000, overLimit: true, ...untilPayday });

    expect(empty.state).toBe("out");
    expect(empty.fill).toBe(0);
    // Перелимит — слово домена, а не вывод из остатка: строка без плана может уйти в минус
    // раньше, чем остаток станет отрицательным.
    expect(over.state).toBe("out");
    expect(reachWord(empty.state)).toBe("Конверт пуст");
  });

  it("не спорит с самой собой после квантования: слово и заливка говорят одно и то же", () => {
    // Округление к ближайшему шагу дотянуло бы заливку до насечки при 99 % пройденного пути, и
    // человек увидел бы «не дотянет» ровно на насечке. Шаг прижимается к нужной стороне.
    const almost = reach({ remainingMinor: 1_090_000, spentMinor: 900_000, ...untilPayday });
    const barely = reach({ remainingMinor: 1_101_000, spentMinor: 900_000, ...untilPayday });

    expect(almost.state).toBe("short");
    expect(almost.fill).toBeLessThan(REACH_MARK_PERCENT);
    expect(barely.state).toBe("reaches");
    expect(barely.fill).toBeGreaterThanOrEqual(REACH_MARK_PERCENT);
  });

  it("не делит на ноль, когда трат ещё не было: полоса полная, а темпа нет", () => {
    const line = reach({ remainingMinor: 2_700_000, spentMinor: 0, ...untilPayday });

    expect(line.state).toBe("reaches");
    expect(line.perDayMinor).toBeNull();
    expect(line.daysCovered).toBeNull();
    expect(line.fill).toBe(100);
    expect(runsOutOn(TODAY, line.daysCovered)).toBeNull();
  });

  it("называет день, в который деньги кончатся при нынешнем темпе", () => {
    const line = reach({ remainingMinor: 500_000, spentMinor: 2_700_000, ...untilPayday });

    expect(runsOutOn(TODAY, line.daysCovered)).toBe("2026-07-10");
  });

  it("считает прошедшие дни периода включительно и не растит их за его конец", () => {
    expect(daysElapsed(PERIOD_START, PERIOD_END, TODAY)).toBe(9);
    expect(daysElapsed(PERIOD_START, PERIOD_END, PERIOD_START)).toBe(1);
    expect(daysElapsed(PERIOD_START, PERIOD_END, "2026-09-02")).toBe(31);
    expect(daysElapsed("не дата", PERIOD_END, TODAY)).toBe(1);
  });

  it("квантует долю шагом шкалы и не выходит за её края", () => {
    expect(percentStep(0.733)).toBe(75);
    expect(percentStep(0.71)).toBe(70);
    expect(percentStep(-3)).toBe(0);
    expect(percentStep(4)).toBe(100);
    expect(percentStep(Number.NaN)).toBe(0);
    expect(daysBetween(TODAY, "2026-07-20")).toBe(11);
  });
});

describe("линейка и таблица стилей считают от одного числа", () => {
  it("объявляет ту же шкалу долей, которой пользуется разметка", () => {
    // Квантование существует потому, что CSP запрещает инлайновые стили. Значит шкала живёт в
    // двух местах сразу, и разъехаться им нельзя: полоса без своего правила осталась бы пустой.
    for (const step of PERCENT_STEPS) {
      expect(styles, `заливка ${step} %`).toContain(`.limit-bar[data-spent="${step}"] { --limit-fill: ${step}%; }`);
    }
  });

  it("ставит насечку на одну долю во всех полосах сразу — иначе вертикали не будет", () => {
    // Одна вертикаль сквозь экран — это и есть смысл линейки: видно, какие строки её не
    // пересекают. Держится она на том, что число одно, а не на глазомере. Строки лимитов «Сегодня»
    // и подписи героя ушли с ним (2b); насечку по-прежнему считают полоса и подпись лестницы «Года».
    expect(styles).toContain(`--reach-mark: ${REACH_MARK_PERCENT}%;`);
    expect(PERCENT_STEPS).toContain(REACH_MARK_PERCENT);
    for (const selector of [".limit-bar", ".ladder-at"]) {
      const rule = styles.match(new RegExp(`\\n\\${selector} \\{([^}]*)\\}`, "u"))?.[1] ?? "";
      expect(rule, `${selector} считает насечку своим числом`).toContain("var(--reach-mark)");
    }
  });

  it("рисует насечку разрывом полосы, а не цветной меткой поверх заливки", () => {
    const bar = styles.match(/\n\.limit-bar \{([^}]*)\}/u)?.[1] ?? "";

    // Метке пришлось бы выбирать подложку — трек или заливку, — и одним цветом обе не покрыть.
    // А ещё её срезало скруглением пилюли ровно на 100 %, то есть там, где она нужнее всего.
    expect(bar).not.toContain("--limit-marker");
    expect(bar).not.toContain("border-radius");
    // Стойки сверху и снизу и гнездо между ними цвета карточки — три слоя поверх заливки.
    expect(bar).toContain("var(--post-height)");
    expect(bar).toContain("var(--surface)");
    expect(bar.match(/linear-gradient/gu) ?? []).toHaveLength(4);
  });

  it("не даёт шкале долей стереть обрубок исчерпания: вес селекторов равный, решает порядок", () => {
    // Настоящий дефект, найденный на листе состояний: у «.limit-bar.out» и у
    // «.limit-bar[data-spent="0"]» одинаковый вес селектора, и пока правило состояния стояло
    // раньше шкалы, ноль побеждал — красный обрубок молча пропадал, и исчерпанный конверт
    // выглядел нетронутой строкой.
    const stub = styles.indexOf(".limit-bar.out {");
    const zero = styles.indexOf('.limit-bar[data-spent="0"]');

    expect(stub).toBeGreaterThan(-1);
    expect(zero).toBeGreaterThan(-1);
    expect(stub, "обрубок объявлен раньше шкалы и потому невидим").toBeGreaterThan(zero);
    expect(styles).toMatch(/\.limit-bar\.out \{[^}]*--limit-fill: \d+px/u);
  });

  it("держит три состояния тремя заливками, а слово — отдельно от цвета", () => {
    expect(styles).toContain(".limit-bar.short { --limit-ink: var(--amber-ink); }");
    expect(styles).toMatch(/\.limit-bar\.out \{[^}]*--limit-ink: var\(--red-ink\)/u);
    // Обычное состояние цвета не имеет: заливка чернильная, и это то самое «нормальное
    // состояние экрана теряет цвет», ради которого палитра и менялась.
    expect(styles).toMatch(/\n\.limit-bar \{[^}]*--limit-ink: var\(--ink\)/u);
  });

  it("называет ту же долю в документе дизайна, что и в коде", () => {
    expect(design, "§6 не называет долю, на которой стоит насечка")
      .toContain(`${REACH_MARK_PERCENT} %`);
  });
});
