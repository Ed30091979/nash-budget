import { renderToStaticMarkup } from "react-dom/server";
import { G003, toDomainBudgetState } from "@family-budget/test-fixtures";
import { materializeRecurring, type BudgetState, type Transaction } from "@family-budget/domain";
import { describe, expect, it, vi } from "vitest";
import { buildDemoBudgetState } from "../../onboarding/demo";
import { donutArcs } from "./Donut";
import {
  compactAmount,
  DONUT_TOP,
  percentText,
  reportModel,
  reportsFieldsForDays,
  reportsFieldsForMonth,
  reportsFieldsForPeriod,
  reportsFieldsWith,
  resolveReportPeriod,
  shareText,
  wholePercents,
} from "./report-model";
import { ReportsScreen } from "./ReportsScreen";

const TODAY = "2026-10-19";
const plain = (markup: string) => markup.replace(/<[^>]*>/gu, " ").replace(/&nbsp;/gu, " ").replace(/[\u00a0\u202f]/gu, " ").replace(/&quot;/gu, "\"").replace(/&#x27;/gu, "'").replace(/\s+/gu, " ").trim();
const nbsp = (text: string) => text.replace(/[\u00a0\u202f]/gu, " ");

function ledger(): BudgetState {
  return materializeRecurring(toDomainBudgetState(G003), G003.materializeThrough).state;
}

function screen(budget: BudgetState, fields: Record<string, string> = {}, today = TODAY): string {
  return renderToStaticMarkup(<ReportsScreen budget={budget} today={today} fields={fields} onFields={vi.fn()} onFeed={vi.fn()} onAdd={vi.fn()} />);
}

describe("«Отчёты»: период", () => {
  it("месяц, квартал, год и свой период — календарные, с прошлым периодом той же длины", () => {
    expect(resolveReportPeriod({}, TODAY)).toMatchObject({
      kind: "month", from: "2026-10-01", to: "2026-10-31", label: "Октябрь", forWords: "за октябрь", ongoing: true,
      previous: { from: "2026-09-01", to: "2026-09-30", inWords: "в сентябре" },
      months: ["2026-05", "2026-06", "2026-07", "2026-08", "2026-09", "2026-10"],
    });
    expect(resolveReportPeriod({ period: "month", from: "2026-01-01" }, TODAY)).toMatchObject({ label: "Январь", previous: { from: "2025-12-01", inWords: "в декабре 2025" } });
    expect(resolveReportPeriod({ period: "month", from: "2025-09-01" }, TODAY)).toMatchObject({ label: "Сентябрь 2025", forWords: "за сентябрь 2025", ongoing: false });
    expect(resolveReportPeriod({ period: "quarter" }, TODAY)).toMatchObject({
      from: "2026-10-01", to: "2026-12-31", label: "IV квартал", forWords: "за IV квартал",
      previous: { from: "2026-07-01", to: "2026-09-30", inWords: "в III квартале" },
    });
    expect(resolveReportPeriod({ period: "quarter", from: "2026-02-10" }, TODAY).previous?.inWords).toBe("в IV квартале 2025");
    expect(resolveReportPeriod({ period: "year" }, TODAY)).toMatchObject({ from: "2026-01-01", to: "2026-12-31", label: "2026 год", previous: { inWords: "в 2025 году" } });
    expect(resolveReportPeriod({ period: "year" }, TODAY).months).toHaveLength(12);
    expect(resolveReportPeriod({ period: "custom", from: "2026-10-01", to: "2026-10-15" }, TODAY)).toMatchObject({
      kind: "custom", label: "1–15\u00a0октября", forWords: "за 1–15\u00a0октября",
      previous: { from: "2026-09-16", to: "2026-09-30", inWords: "за предыдущие 15 дней" },
    });
    expect(resolveReportPeriod({ period: "custom", from: "2026-10-05", to: "2026-10-05" }, TODAY).previous).toMatchObject({ from: "2026-10-04", inWords: "за предыдущий день" });
    // Свой период без дней — тот же месяц, что без ключей.
    expect(resolveReportPeriod({ period: "custom" }, TODAY).kind).toBe("month");
  });

  it("чипы меняют вид периода с той же опорой; сегодняшняя опора в адрес не пишется", () => {
    expect(reportsFieldsForPeriod({}, "quarter", TODAY)).toEqual({ period: "quarter" });
    expect(reportsFieldsForPeriod({}, "year", TODAY)).toEqual({ period: "year" });
    // Из года, в котором сегодня, «месяц» — сегодняшний, а не январь; из прошлого года — его январь.
    expect(reportsFieldsForPeriod({ period: "year" }, "month", TODAY)).toEqual({});
    expect(reportsFieldsForPeriod({ period: "year", from: "2025-01-01" }, "month", TODAY)).toEqual({ period: "month", from: "2025-01-01" });
    expect(reportsFieldsForPeriod({ period: "year" }, "quarter", TODAY)).toEqual({ period: "quarter" });
    expect(reportsFieldsForPeriod({ period: "month", from: "2026-09-01", view: "income" }, "quarter", TODAY)).toEqual({ view: "income", period: "quarter", from: "2026-07-01" });
    expect(reportsFieldsForPeriod({ period: "quarter", acc: "x" }, "month", TODAY)).toEqual({ acc: "x" });
    expect(reportsFieldsForDays({ view: "tags" }, "2026-10-01", "2026-10-07")).toEqual({ view: "tags", period: "custom", from: "2026-10-01", to: "2026-10-07" });
    expect(reportsFieldsWith({ period: "year" }, { view: "expense" })).toEqual({ period: "year" });
    expect(reportsFieldsWith({ view: "income", acc: "a" }, { acc: null })).toEqual({ view: "income" });
    // «Расходы» на «Обзоре» ведут сюда за тот же месяц.
    expect(reportsFieldsForMonth("2026-10", TODAY)).toEqual({});
    expect(reportsFieldsForMonth("2026-08", TODAY)).toEqual({ period: "month", from: "2026-08-01" });
  });
});

describe("«Отчёты» на G-003: август 2026", () => {
  it("расходы: 2 056 338 с возвратом за вычетом; C1 «Продукты» 1 550 000, C2 «Путешествия» 506 338", () => {
    const model = reportModel(ledger(), {}, "2026-08-31");
    expect(model.totalMinor).toBe(2_056_338);
    expect(model.table.map((row) => [row.name, row.amountMinor])).toEqual([["Продукты", 1_550_000], ["Путешествия", 506_338]]);
    expect(model.segments.map((segment) => [segment.name, segment.amountMinor, Math.round(segment.share * 100)])).toEqual([["Продукты", 1_550_000, 75], ["Путешествия", 506_338, 25]]);
    expect(model.headline).toBe("Больше всего ушло на категорию «Продукты»");
    // Строка легенды ведёт в «Операции» с категорией и днями периода.
    expect(model.segments[1]?.feed).toEqual({ from: "2026-08-01", to: "2026-08-31", cat: G003.state.categories[1]!.id });
    // Июль пуст: сравнить не с чем — и это сказано, а не «на 2 056 338 больше».
    expect(model.comparison).toEqual({ kind: "nothing-before", inWords: "в июле" });
  });

  it("метки: T1 «Отпуск» 506 338, T2 «Дом» 1 550 000, T3 «Старое» — доход 12 000 000; две метки — в обеих, доли больше 100 %", () => {
    const state = ledger();
    const model = reportModel(state, { view: "tags" }, "2026-08-31");
    expect(model.tags.map((row) => [row.name, row.expenseMinor, row.incomeMinor])).toEqual([["Дом", 1_550_000, 0], ["Отпуск", 506_338, 0], ["Старое", 0, 12_000_000]]);
    expect(model.tags.find((row) => row.name === "Старое")).toMatchObject({ archived: true, share: null, bar: 0 });
    expect(model.headline).toBe("Больше всего потрачено с меткой «Дом»");
    expect(model.tags[0]?.feed).toEqual({ from: "2026-08-01", to: "2026-08-31", tag: G003.state.tags![1]!.id });
    const twice: BudgetState = {
      ...state,
      transactions: state.transactions.map((item) => (item.id.endsWith("5502") ? { ...item, tagIds: [G003.state.tags![1]!.id, G003.state.tags![0]!.id] } : item)),
    };
    const overlap = reportModel(twice, { view: "tags" }, "2026-08-31");
    const shares = overlap.tags.reduce((sum, row) => sum + (row.share ?? 0), 0);
    expect(shares).toBeGreaterThan(1);
    expect(overlap.tags.every((row) => row.bar <= 100)).toBe(true);
    expect(plain(screen(twice, { view: "tags" }, "2026-08-31"))).toContain("доли могут дать больше 100 %");
  });

  it("доходы: «Зарплата» 12 000 000; доход без категории — своя строка, ведёт к таблице, а не в ленту (LOW-1)", () => {
    const state = ledger();
    expect(reportModel(state, { view: "income" }, "2026-08-31").segments.map((segment) => [segment.name, segment.amountMinor])).toEqual([["Зарплата", 12_000_000]]);
    const loose: BudgetState = {
      ...state,
      transactions: [...state.transactions, { id: "85555555-5555-4555-8555-555555555570", occurredOn: "2026-08-15", status: "posted", kind: "income", amountMinor: 30_000_000, accountId: G003.state.accounts[0]!.id }],
    };
    const model = reportModel(loose, { view: "income" }, "2026-08-31");
    // Фильтра «без категории» у ленты нет, а «все доходы августа» — не то, что названо строкой: она,
    // как «Остальное», раскрывает таблицу всех источников.
    expect(model.segments[0]).toMatchObject({ name: "Без категории", categoryId: null, feed: null, rest: false });
    expect(model.segments[1]).toMatchObject({ name: "Зарплата", feed: { from: "2026-08-01", to: "2026-08-31", cat: G003.state.categories[2]!.id } });
    expect(model.headline).toBe("Больше всего пришло без категории");
    const markup = nbsp(screen(loose, { view: "income" }, "2026-08-31"));
    expect(markup).toContain('aria-label="Без категории: 300 000 ₽, 71 %. Показать все источники"');
    expect(markup).toContain('aria-label="Зарплата: 120 000 ₽, 29 %. Показать операции"');
  });

  it("счёт: только долларовый — «Путешествия» с возвратом", () => {
    const model = reportModel(ledger(), { acc: G003.state.accounts[1]!.id }, "2026-08-31");
    expect(model.totalMinor).toBe(506_338);
    expect(model.segments[0]?.feed).toMatchObject({ acc: G003.state.accounts[1]!.id });
  });
});

describe("«Отчёты»: кольцо — шесть секторов и «Остальное»", () => {
  it("восемь категорий: шесть крупных, «Остальное» — сумма двух мелких и ведёт к таблице", () => {
    const seed = buildDemoBudgetState(TODAY);
    const card = seed.accounts[0]!.id;
    const categories = seed.categories.filter((item) => item.type === "expense").slice(0, 8);
    const spends: Transaction[] = categories.map((category, index) => ({
      id: `85555555-5555-4555-8555-5555555557${String(index).padStart(2, "0")}`, occurredOn: "2026-03-10", status: "posted", kind: "expense", amountMinor: (index + 1) * 100_000, accountId: card, categoryId: category.id,
    }));
    // Март — до истории демо: в нём только эти восемь покупок.
    const model = reportModel({ ...seed, transactions: [...seed.transactions, ...spends] }, { period: "month", from: "2026-03-01" }, TODAY);
    expect(model.segments).toHaveLength(DONUT_TOP + 1);
    const rest = model.segments.at(-1)!;
    expect(rest).toMatchObject({ name: "Остальное", rest: true, feed: null, tone: null, amountMinor: 300_000 });
    expect(model.segments.reduce((sum, segment) => sum + segment.share, 0)).toBeCloseTo(1, 10);
    expect(model.table).toHaveLength(8);
  });

  it("дуги: доля — доля окружности, между секторами — разрыв 2 px; единственный сектор — полный круг", () => {
    const half = { key: "a", categoryId: "a", name: "A", amountMinor: 1, share: 0.5, percent: 50, tone: "mint" as const, rest: false, feed: null };
    const circumference = 2 * Math.PI * 54;
    const arcs = donutArcs([half, { ...half, key: "b", tone: "sage" }]);
    expect(arcs[0]?.length).toBeCloseTo(circumference / 2 - 2, 1);
    expect(arcs[1]?.offset).toBeCloseTo(-circumference / 2, 1);
    expect(arcs.map((arc) => arc.toneClass)).toEqual(["chart-tone-mint", "chart-tone-sage"]);
    expect(donutArcs([{ ...half, share: 1 }])[0]?.length).toBeCloseTo(circumference, 1);
    expect(donutArcs([{ ...half, rest: true, tone: null }])[0]?.toneClass).toBe("chart-rest");
  });

  it("подписи: «76 тыс.», «1,6 млн», минус — U+2212 (LOW-10); доля меньше процента — «меньше 1 %»", () => {
    expect(nbsp(compactAmount(7_620_000, "RUB"))).toBe("76 тыс.");
    expect(nbsp(compactAmount(155_000_000, "RUB"))).toBe("1,6 млн");
    // Месяц, в котором возвратов больше трат: столбец ниже нуля подписан минусом, а не дефисом.
    expect(nbsp(compactAmount(-500_000, "RUB"))).toBe("\u22125 тыс.");
    expect(compactAmount(-500_000, "RUB")).not.toContain("-");
    expect(nbsp(compactAmount(-155_000_000, "RUB"))).toBe("\u22121,6 млн");
    expect(nbsp(shareText(0.004))).toBe("меньше 1 %");
    expect(nbsp(shareText(0.63))).toBe("63 %");
    expect(shareText(null)).toBe("—");
    expect(nbsp(percentText(0, 1))).toBe("меньше 1 %");
    expect(nbsp(percentText(0, 0))).toBe("0 %");
    expect(nbsp(percentText(34, 1))).toBe("34 %");
    expect(percentText(null, -1)).toBe("—");
  });

  it("доли легенды и таблицы — целыми процентами, в сумме ровно 100 (LOW-3)", () => {
    expect(wholePercents([1, 1, 1])).toEqual([34, 33, 33]);
    expect(wholePercents([12.5, 12.5, 12.5, 12.5, 50])).toEqual([13, 13, 12, 12, 50]);
    expect(wholePercents([2, 1])).toEqual([67, 33]);
    expect(wholePercents([1, 0, -5])).toEqual([100, 0, 0]);
    expect(wholePercents([0, 0])).toEqual([0, 0]);
    expect(wholePercents([1_000_000, 1])).toEqual([100, 0]);
    // Три равные категории: подписи «34 · 33 · 33 %», а не трижды «33 %», которые дают 99.
    const seed = buildDemoBudgetState(TODAY);
    const card = seed.accounts[0]!.id;
    const three = seed.categories.filter((item) => item.type === "expense").slice(0, 3);
    const spends: Transaction[] = three.map((category, index) => ({
      id: `85555555-5555-4555-8555-5555555558${String(index).padStart(2, "0")}`, occurredOn: "2026-03-10", status: "posted", kind: "expense", amountMinor: 100_000, accountId: card, categoryId: category.id,
    }));
    const state = { ...seed, transactions: [...seed.transactions, ...spends] };
    const model = reportModel(state, { period: "month", from: "2026-03-01" }, TODAY);
    expect(model.segments.map((segment) => segment.percent)).toEqual([34, 33, 33]);
    expect(model.table.map((row) => row.percent)).toEqual([34, 33, 33]);
    const markup = nbsp(screen(state, { period: "month", from: "2026-03-01" }));
    expect(markup).toContain(`aria-label="Расходы за март, 3 000 ₽: ${three[0]!.name} 34 %, ${three[1]!.name} 33 %, ${three[2]!.name} 33 %"`);
    expect([...markup.matchAll(/<td>(\d+) %<\/td>/gu)].map((match) => Number(match[1]))).toEqual([34, 33, 33]);
  });

  it("в таблице доля — только у положительных сумм; их проценты дают 100, отрицательная — «—»", () => {
    const seed = buildDemoBudgetState(TODAY);
    const card = seed.accounts[0]!.id;
    const [first, second, third] = seed.categories.filter((item) => item.type === "expense");
    const operations: Transaction[] = [
      { id: "85555555-5555-4555-8555-555555555810", occurredOn: "2026-03-10", status: "posted", kind: "expense", amountMinor: 100_000, accountId: card, categoryId: first!.id },
      { id: "85555555-5555-4555-8555-555555555811", occurredOn: "2026-03-11", status: "posted", kind: "expense", amountMinor: 200_000, accountId: card, categoryId: second!.id },
      // Возврат в марте за февральскую покупку: у категории в марте — минус.
      { id: "85555555-5555-4555-8555-555555555813", occurredOn: "2026-02-20", status: "posted", kind: "expense", amountMinor: 100_000, accountId: card, categoryId: third!.id },
      { id: "85555555-5555-4555-8555-555555555812", occurredOn: "2026-03-12", status: "posted", kind: "refund", amountMinor: 50_000, accountId: card, categoryId: third!.id, originalTransactionId: "85555555-5555-4555-8555-555555555813" },
    ];
    const model = reportModel({ ...seed, transactions: [...seed.transactions, ...operations] }, { period: "month", from: "2026-03-01" }, TODAY);
    expect(model.table.map((row) => [row.amountMinor, row.percent])).toEqual([[200_000, 67], [100_000, 33], [-50_000, null]]);
  });
});

describe("«Отчёты» на демо: октябрь 2026, доступность графиков", () => {
  it("вывод заголовком, кольцо и столбцы — картинки с выводом словами, под ними таблицы; ни одного style=", () => {
    const demo = buildDemoBudgetState(TODAY);
    const markup = screen(demo);
    const text = plain(markup);
    expect(markup).toContain("<h1>Отчёты</h1>");
    expect(text).toContain("Больше всего ушло на категорию «Жильё»");
    // История демо (макет 09): сентябрь — 79 400 ₽, октябрь на 8 400 ₽ меньше.
    expect(text).toContain("71 000 ₽ за октябрь — на 8 400 ₽ меньше, чем в сентябре");
    // Кольцо — role="img" с выводом и долями; легенда — кнопки с суммой и долей.
    expect(nbsp(markup)).toContain('<div class="donut" role="img" aria-label="Расходы за октябрь, 71 000 ₽: Жильё 63 %, Продукты 31 %, Транспорт 6 %">');
    expect(nbsp(markup)).toContain('aria-label="Жильё: 45 000 ₽, 63 %. Показать операции"');
    expect(markup).toMatch(/<circle class="donut-seg chart-tone-[a-z]+"[^>]*stroke-dasharray="[\d.]+ [\d.]+"/u);
    // Таблица всех категорий — с подписью, заголовками столбцов и итогом.
    expect(markup).toContain("<summary>Все категории и таблица</summary>");
    expect(text).toContain("Расходы за октябрь по категориям, за вычетом возвратов");
    expect(markup).toMatch(/<th scope="col">Категория<\/th><th scope="col">Сумма<\/th><th scope="col">Доля<\/th>/u);
    expect(text).toContain("Всего 71 000 ₽");
    // «По месяцам» — картинка с суммами словами, октябрь — акцентом и в таблице.
    expect(nbsp(markup)).toContain('<div class="month-bars" role="img" aria-label="Расходы по месяцам: май 76 200 ₽, июнь 81 500 ₽, июль 74 300 ₽, август 88 900 ₽, сентябрь 79 400 ₽, октябрь 71 000 ₽">');
    // Подписи столбцов — коротко, как в макете: 76 · 82 · 74 · 89 · 79 · 71 тыс.
    expect([...markup.matchAll(/<span class="month-bar-value">([^<]+)<\/span>/gu)].map((match) => nbsp(match[1]!))).toEqual(["76 тыс.", "82 тыс.", "74 тыс.", "89 тыс.", "79 тыс.", "71 тыс."]);
    expect(markup).toContain('<div class="month-bar current" aria-hidden="true">');
    expect(text).toContain("Расходы за полгода, октябрь — пока неполный");
    expect(text).toContain("октябрь (идёт) 71 000 ₽");
    expect(markup).not.toMatch(/\sstyle=/u);
    // Сегмент вкладок и чипы периода — выбор словами и `aria-pressed`, а не только цветом.
    expect(markup).toMatch(/<button class="chip" type="button" aria-pressed="true"><span class="chip-face">Расходы<\/span><\/button>/u);
    expect(markup).toMatch(/<button class="chip" type="button" aria-pressed="true"><span class="chip-face">Октябрь<\/span><\/button>/u);
  });

  it("итог месяца — тот же, что «Расходы» на «Обзоре»: один источник (MEDIUM-8)", () => {
    const demo = buildDemoBudgetState(TODAY);
    expect(reportModel(demo, {}, TODAY).totalMinor).toBe(7_100_000);
  });

  it("пустой период говорит словами и ведёт к записи, кольца и нулей не рисует", () => {
    const demo = buildDemoBudgetState(TODAY);
    // Март — до истории демо.
    const markup = screen(demo, { period: "month", from: "2026-03-01" });
    const text = plain(markup);
    expect(text).toContain("В марте расходов нет");
    expect(text).toContain("Запишите трату — появится кольцо.");
    expect(markup).toMatch(/<button[^>]*class="primary-button[^"]*"[^>]*>Записать расход<\/button>/u);
    expect(markup).not.toContain('class="donut"');
    expect(plain(screen(demo, { view: "income", period: "quarter", from: "2026-01-01" }))).toContain("В I квартале доходов нет");
    expect(plain(screen(demo, { view: "tags", period: "custom", from: "2026-10-01", to: "2026-10-10" }))).toContain("За 1–10 октября трат с метками нет");
  });

  it("метки на демо: «дача» полосой, доля от расходов, таблица; кнопка ведёт в ленту", () => {
    const demo = buildDemoBudgetState(TODAY);
    const markup = screen(demo, { view: "tags" });
    expect(plain(markup)).toContain("Больше всего потрачено с меткой «дача»");
    expect(nbsp(markup)).toContain('aria-label="#дача: 5 900 ₽, 8 % расходов. Показать операции"');
    expect(markup).toMatch(/<rect class="tag-bar-fill" x="0" y="0" width="8%" height="6"><\/rect>/u);
    expect(markup).toContain("<summary>Все метки таблицей</summary>");
    expect(markup).not.toContain('class="donut"');
  });
});
