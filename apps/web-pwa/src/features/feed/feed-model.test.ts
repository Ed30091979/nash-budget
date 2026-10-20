import { readFileSync } from "node:fs";
import { G003, toDomainBudgetState } from "@family-budget/test-fixtures";
import { addDays, materializeRecurring, type BudgetState, type Transaction } from "@family-budget/domain";
import { describe, expect, it } from "vitest";
import {
  dayHeading,
  feedIndex,
  feedIndexBuilds,
  feedRowView,
  filterFeed,
  filtersOfRoute,
  groupByDay,
  listedAccounts,
  matchesSearch,
  normalizeSearchText,
  parseSearch,
  periodLabel,
  routeOfFilters,
  type FeedFilters,
} from "./feed-model";

/** G-003 после регулярного правила: август 2026 в рублях и долларах, возврат, долги, метки, перевод. */
function ledger(): BudgetState {
  return materializeRecurring(toDomainBudgetState(G003), G003.materializeThrough).state;
}

const [card, dollars] = G003.state.accounts;
const [food, travel] = G003.state.categories;
const [vacation, home] = G003.state.tags!;
const ids = (state: BudgetState, query: string, filters: FeedFilters = {}) =>
  filterFeed(feedIndex(state), filters, parseSearch(query)).entries.map((entry) => entry.transaction.id);
const tail = (id: string) => id.slice(-2);
const noAuthors = { show: false, label: () => "" };

describe("лента: индекс и порядок", () => {
  it("сначала новые: по дню операции, внутри дня — позже записанная выше; индекс один на бюджет", () => {
    const state = ledger();
    const index = feedIndex(state);
    const dates = index.entries.map((entry) => entry.transaction.occurredOn);
    expect([...dates].sort().reverse()).toEqual(dates);
    expect(index.entries).toHaveLength(state.transactions.length);
    // Тот же бюджет — тот же индекс; новый бюджет — новый.
    expect(feedIndex(state)).toBe(index);
    expect(feedIndex({ ...state })).not.toBe(index);
    // Две операции одного дня: позже записанная — выше.
    const sameDay: BudgetState = {
      ...state,
      transactions: [
        ...state.transactions,
        { id: "85555555-5555-4555-8555-555555555580", occurredOn: "2026-08-31", status: "posted", kind: "expense", amountMinor: 100, accountId: card!.id, categoryId: food!.id },
        { id: "85555555-5555-4555-8555-555555555581", occurredOn: "2026-08-31", status: "posted", kind: "expense", amountMinor: 200, accountId: card!.id, categoryId: food!.id },
      ],
    };
    expect(feedIndex(sameDay).entries.slice(0, 2).map((entry) => tail(entry.transaction.id))).toEqual(["81", "80"]);
  });
});

describe("лента: поиск", () => {
  it("сумма в любом виде, как её набирают: «12500», «12 500», «12500,00», «12 500.00» — одна покупка в «Пятёрочке»", () => {
    const state = ledger();
    for (const query of ["12500", "12 500", "12500,00", "12 500.00", "12\u00a0500", "12 500 ₽", "−12 500"]) {
      expect(ids(state, query), query).toEqual(["85555555-5555-4555-8555-555555555502"]);
    }
    // Число ищется целиком, а не кусочком другой суммы: «1250» и «500» — не 12 500.
    expect(ids(state, "1250")).not.toContain("85555555-5555-4555-8555-555555555502");
    expect(ids(state, "500")).not.toContain("85555555-5555-4555-8555-555555555502");
  });

  it("у долларовой операции — и доллары счёта, и рубли снимка: «40», «25,55», «3600», «2363,38»", () => {
    const state = ledger();
    expect(ids(state, "40").map(tail)).toEqual(["03"]);
    expect(ids(state, "25,55").map(tail)).toEqual(["05"]);
    expect(ids(state, "25,5").map(tail)).toEqual([]);
    expect(ids(state, "3600").map(tail)).toEqual(["03"]);
    expect(ids(state, "2363,38").map(tail)).toEqual(["05"]);
    // 900 ₽ — снимок возврата 10 $; 9 000 ₽ — нет такой суммы.
    expect(ids(state, "900").map(tail)).toEqual(["04"]);
  });

  it("заметка, метка, категория, счёт, контрагент — без учёта регистра и «ё»; «#метка» — по началу имени метки", () => {
    const state = ledger();
    expect(ids(state, "пятерочка").map(tail)).toEqual(["02"]);
    expect(ids(state, "ПЯТЁРОЧКА").map(tail)).toEqual(["02"]);
    // Заметка регулярного правила — у обоих вхождений.
    expect(ids(state, "доставка воды")).toHaveLength(2);
    expect(ids(state, "петя").map(tail).sort()).toEqual(["07", "08"]);
    expect(ids(state, "путешествия").map(tail).sort()).toEqual(["03", "04", "05"]);
    // «#дом» — метка «Дом»: покупка и две доставки воды; «дом» без решётки найдёт ещё и «у дома».
    expect(ids(state, "#дом")).toHaveLength(3);
    expect(ids(state, "#до")).toHaveLength(3);
    expect(ids(state, "#отп").map(tail).sort()).toEqual(["03", "04", "05"]);
    expect(ids(state, "#ом")).toEqual([]);
    expect(ids(state, "#")).toHaveLength(state.transactions.filter((item) => (item.tagIds ?? []).length > 0).length);
    expect(ids(state, "зарплата").map(tail)).toEqual(["01"]);
  });

  it("пустой запрос — всё; невидимые знаки и мягкие переносы запросу не мешают", () => {
    const state = ledger();
    expect(ids(state, "   ")).toHaveLength(state.transactions.length);
    expect(ids(state, "пя\u00adтё\u200bрочка").map(tail)).toEqual(["02"]);
    expect(normalizeSearchText("  Ёлка\u00a0\u00a0 и\tПАЛКИ ")).toBe("елка и палки");
    expect(parseSearch("1 250,5")).toEqual({ kind: "text", text: "1 250,5", amount: { whole: "1250", fraction: "5" } });
    expect(parseSearch("кофе 2")).toEqual({ kind: "text", text: "кофе 2", amount: null });
    expect(parseSearch("#Дача ")).toEqual({ kind: "tag", prefix: "дача" });
  });
});

describe("лента: фильтры", () => {
  it("период, счёт (перевод — у обоих счетов), категория, метка, вид — и вместе с поиском", () => {
    const state = ledger();
    expect(ids(state, "", { from: "2026-08-10", to: "2026-08-12" }).map(tail)).toEqual(["04", "03"]);
    const dollarIds = ids(state, "", { accountIds: [dollars!.id] }).map(tail).sort();
    expect(dollarIds).toEqual(["03", "04", "05", "06", "09"]);
    expect(ids(state, "", { categoryIds: [travel!.id] }).map(tail).sort()).toEqual(["03", "04", "05"]);
    expect(ids(state, "", { tagIds: [home!.id] })).toHaveLength(3);
    expect(ids(state, "", { kind: "refund" }).map(tail)).toEqual(["04"]);
    expect(ids(state, "40", { categoryIds: [food!.id] })).toEqual([]);
    expect(ids(state, "40", { categoryIds: [travel!.id], tagIds: [vacation!.id] }).map(tail)).toEqual(["03"]);
    // Адрес пишет UUID строчными, бюджет хранит как пришло: сравнение без регистра.
    expect(ids(state, "", { categoryIds: [travel!.id.toUpperCase()] })).toHaveLength(3);
  });

  it("участник: только его операции; фильтры адреса — туда и обратно, строки поиска среди них нет", () => {
    const state = ledger();
    const masha = "c6666666-6666-4666-8666-666666666601";
    const signed: BudgetState = {
      ...state,
      members: [{ id: masha, name: "Маша", role: "member", active: true }],
      transactions: state.transactions.map((item) => (item.kind === "income" ? { ...item, memberId: masha } : item)),
    };
    expect(ids(signed, "", { memberId: masha }).map(tail)).toEqual(["01"]);
    const route = { from: "2026-08-01", to: "2026-08-31", acc: card!.id, cat: food!.id, tag: home!.id, member: masha, kind: "expense" } as const;
    expect(routeOfFilters(filtersOfRoute(route))).toEqual(route);
    expect(Object.keys(routeOfFilters({ ...filtersOfRoute(route), query: "кофе" } as FeedFilters)).sort()).toEqual(["acc", "cat", "from", "kind", "member", "tag", "to"]);
    expect(routeOfFilters({})).toEqual({});
  });

  it("итоги найденного: расходы за вычетом возвратов и доходы, в рублях, без переводов и долгов", () => {
    const result = filterFeed(feedIndex(ledger()), {}, parseSearch(""));
    expect(result.totals).toEqual({ expenseMinor: 2_056_338, incomeMinor: 12_000_000 });
    expect(filterFeed(feedIndex(ledger()), { accountIds: [dollars!.id] }, parseSearch("")).totals).toEqual({ expenseMinor: 506_338, incomeMinor: 0 });
  });
});

describe("лента: дни", () => {
  it("итог дня — доходы и возвраты минус расходы в рублях; день одних переводов или долгов итога не имеет", () => {
    const days = groupByDay(filterFeed(feedIndex(ledger()), {}, parseSearch("")).entries, 1_000);
    const byDate = new Map(days.map((day) => [day.date, day]));
    expect(byDate.get("2026-08-01")?.totalMinor).toBe(12_000_000);
    expect(byDate.get("2026-08-03")?.totalMinor).toBe(-1_250_000);
    // Перевод 5-го и долги 7, 8, 25, 28-го — ни дохода, ни расхода.
    for (const date of ["2026-08-05", "2026-08-07", "2026-08-08", "2026-08-25", "2026-08-28"]) expect(byDate.get(date)?.totalMinor, date).toBeNull();
    // Возврат 12-го — плюсом: деньги вернулись.
    expect(byDate.get("2026-08-12")?.totalMinor).toBe(90_000);
    expect(byDate.get("2026-08-10")?.totalMinor).toBe(-360_000);
    expect(days.map((day) => day.date)).toEqual([...new Set(days.map((day) => day.date))]);
  });

  it("итог дня — по всем найденным операциям дня, даже когда страница показала их не все; ожидаемые — «ожидается»", () => {
    const state = ledger();
    const day = "2026-08-31";
    const many: Transaction[] = Array.from({ length: 4 }, (_, index) => ({
      id: `85555555-5555-4555-8555-5555555556${String(index).padStart(2, "0")}`,
      occurredOn: day, status: "posted", kind: "expense", amountMinor: 10_000, accountId: card!.id, categoryId: food!.id,
    }));
    const pending: Transaction = { id: "85555555-5555-4555-8555-555555555699", occurredOn: "2026-09-05", status: "pending", kind: "income", amountMinor: 5_000_000, accountId: card!.id };
    const entries = filterFeed(feedIndex({ ...state, transactions: [...state.transactions, ...many, pending] }), {}, parseSearch("")).entries;
    const [future, last] = groupByDay(entries, 3);
    expect(future).toMatchObject({ date: "2026-09-05", totalMinor: null, pendingOnly: true });
    expect(last?.entries).toHaveLength(2);
    expect(last).toMatchObject({ date: day, totalMinor: -40_000, pendingOnly: false });
    expect(filterFeed(feedIndex({ ...state, transactions: [...state.transactions, pending] }), {}, parseSearch("")).totals.incomeMinor).toBe(12_000_000);
  });

  it("заголовок дня и подпись периода — словами, с неразрывным пробелом", () => {
    const today = "2026-10-19";
    expect(dayHeading("2026-10-19", today)).toBe("Сегодня, 19\u00a0октября");
    expect(dayHeading("2026-10-18", today)).toBe("Вчера, 18\u00a0октября");
    expect(dayHeading("2026-10-20", today)).toBe("Завтра, 20\u00a0октября");
    expect(dayHeading("2026-10-16", today)).toBe("16\u00a0октября, пятница");
    expect(dayHeading("2025-12-31", today)).toBe("31\u00a0декабря\u00a02025, среда");
    expect(periodLabel(undefined, undefined, today)).toBe("Весь период");
    expect(periodLabel("2026-10-01", "2026-10-31", today)).toBe("Октябрь");
    expect(periodLabel("2025-02-01", "2025-02-28", today)).toBe("Февраль 2025");
    expect(periodLabel("2026-01-01", "2026-12-31", today)).toBe("2026 год");
    expect(periodLabel("2026-10-01", "2026-10-15", today)).toBe("1–15\u00a0октября");
    expect(periodLabel("2026-09-28", "2026-10-03", today)).toBe("28\u00a0сентября – 3\u00a0октября");
    expect(periodLabel("2026-10-05", undefined, today)).toBe("С 5\u00a0октября");
    expect(periodLabel(undefined, "2026-10-05", today)).toBe("По 5\u00a0октября");
  });
});

describe("лента: строка операции", () => {
  it("название — категория или вид, подпись — счёт · комментарий · #метка, сумма — в валюте счёта со знаком", () => {
    const state = ledger();
    const index = feedIndex(state);
    const view = (suffix: string) => feedRowView(index.entries.find((entry) => entry.transaction.id.endsWith(suffix))!, state, noAuthors);
    const purchase = view("5502");
    expect(purchase).toMatchObject({ title: "Продукты", icon: "shopping-basket", tone: "mint", amountMinor: 1_250_000, currency: "RUB", sign: "−", baseMinor: null, pending: false });
    expect(purchase.meta.map((part) => part.text)).toEqual(["Карта", "Пятёрочка у дома", "#Дом"]);
    expect(purchase.label).toMatch(/^Изменить операцию «Расход 12\u00a0500\u00a0₽ от 2026-08-03»: Продукты, Карта · Пятёрочка у дома · #Дом$/u);
    // Доллары: сумма в долларах счёта, снимок в рублях — под ней.
    expect(view("5503")).toMatchObject({ title: "Путешествия", currency: "USD", amountMinor: 4_000, baseMinor: 360_000 });
    expect(view("5504").meta[0]?.text).toBe("возврат · Доллары");
    expect(view("5504").sign).toBe("+");
    expect(view("5506")).toMatchObject({ title: "Перевод", icon: "arrow-left-right", sign: undefined, tone: "neutral" });
    expect(view("5506").meta[0]?.text).toBe("Карта → Доллары");
    expect(view("5507").title).toBe("Дал в долг: Петя");
    expect(view("5509").title).toBe("Взял в долг: Сергей");
    expect(view("5510").title).toBe("Вернул долг: Сергей");
    expect(view("5508").title).toBe("Мне вернули долг: Петя");
    // Вхождение правила — «повторяется».
    const water = feedRowView(index.entries.find((entry) => entry.transaction.recurringRuleId !== undefined)!, state, noAuthors);
    expect(water.meta.map((part) => part.text)).toContain("повторяется");
    // В семье — автор последней частью подписи.
    expect(feedRowView(index.entries[0]!, state, { show: true, label: () => "Без участника" }).meta.at(-1)?.text).toBe("Без участника");
  });
});

describe("лист «Счёт»: архивный счёт с операциями — в списке (LOW-8)", () => {
  it("активные по порядку, за ними архивные с операциями и выбранный; одни и те же в «Операциях» и «Отчётах»", () => {
    const state = ledger();
    const savings = G003.state.accounts[2]!;
    const archived: BudgetState = { ...state, accounts: state.accounts.map((account) => (account.id === card!.id ? account : { ...account, active: false })) };
    // «Доллары» в архиве, но с операциями августа — в списке; у «Копилки» операций нет — её нет.
    expect(listedAccounts(archived, undefined).map((account) => account.name)).toEqual(["Карта", "Доллары"]);
    // Выбранный архивный счёт без операций — тоже в списке: выбор виден и снимается.
    // Порядок — порядок списка (`sortOrder`: у «Долларов» 20, у «Копилки» его нет).
    expect(listedAccounts(archived, savings.id.toUpperCase()).map((account) => account.name)).toEqual(["Карта", "Копилка", "Доллары"]);
    expect(listedAccounts(state, undefined).map((account) => account.name)).toEqual(["Карта", "Копилка", "Доллары"]);
    // Оба листа берут счета отсюда.
    for (const file of ["./FeedScreen.tsx", "../reports/ReportsScreen.tsx"]) {
      expect(readFileSync(new URL(file, import.meta.url), "utf8"), file).toMatch(/listedAccounts\(budget, (?:routed|fields)\.acc\)/u);
    }
  });
});

describe("лента: 50 000 операций", () => {
  it("индекс строится один раз на бюджет: поиск и фильтры идут по готовому, новый бюджет — новый индекс", () => {
    const base = ledger();
    const notes = ["Пятёрочка у дома", "рынок", "бензин", "кофе с собой", "аптека"];
    const transactions: Transaction[] = Array.from({ length: 50_000 }, (_, index) => ({
      id: `9${String(index).padStart(7, "0")}-0000-4000-8000-000000000000`,
      occurredOn: addDays("2020-01-01", index % 2_400),
      status: "posted",
      kind: "expense",
      amountMinor: 10_000 + (index % 997) * 100,
      accountId: card!.id,
      categoryId: index % 2 === 0 ? food!.id : travel!.id,
      ...(index % 3 === 0 ? { note: notes[index % notes.length]! } : {}),
      ...(index % 7 === 0 ? { tagIds: [home!.id] } : {}),
    }));
    const state: BudgetState = { ...base, transactions };
    const before = feedIndexBuilds();
    const started = performance.now();
    const index = feedIndex(state);
    const built = performance.now() - started;
    expect(index.entries).toHaveLength(50_000);
    expect(feedIndexBuilds()).toBe(before + 1);
    // Грубая граница — только от сборки, которая вдруг стала квадратичной: время на машине проверок
    // скачет, поэтому память индекса проверяет счёт сборок ниже, а не секундомер.
    expect(built, `индекс 50 000 операций: ${Math.round(built)} мс`).toBeLessThan(20_000);
    // Второй раз — та же ссылка, без сборки; поиск и фильтры на каждое нажатие — по готовому индексу.
    expect(feedIndex(state)).toBe(index);
    const found = filterFeed(feedIndex(state), { categoryIds: [food!.id] }, parseSearch("кофе"));
    const amount = filterFeed(feedIndex(state), {}, parseSearch("1 100"));
    const tagged = filterFeed(feedIndex(state), {}, parseSearch("#дом"));
    expect(feedIndexBuilds()).toBe(before + 1);
    // Новый бюджет — новая ссылка — новый индекс, ровно один.
    const next: BudgetState = { ...state };
    expect(feedIndex(next)).not.toBe(index);
    feedIndex(next);
    expect(feedIndexBuilds()).toBe(before + 2);
    expect(found.entries.length).toBeGreaterThan(0);
    expect(found.entries.every((entry) => entry.transaction.kind === "expense" && entry.categoryId === food!.id && matchesSearch(entry, parseSearch("кофе")))).toBe(true);
    expect(amount.entries.every((entry) => entry.transaction.amountMinor === 110_000)).toBe(true);
    expect(tagged.entries).toHaveLength(Math.ceil(50_000 / 7));
  });
});
