import { makeDefaultCategories, type BudgetState, type Category } from "@family-budget/domain";
import { describe, expect, it } from "vitest";
import {
  BANK_CATEGORY_COUNT,
  classifyStatement,
  isSelfTransfer,
  MERCHANT_RULE_COUNT,
  merchantKey,
  type MerchantMemoryEntry,
} from "./classify";
import { parseStatement, type StatementOperation } from "./statement";
import { SAMPLE_EXPECTED, sampleStatementBytes } from "./test-fixture";

let counter = 0;
function nextId(): string {
  counter += 1;
  return `aaaaaaaa-0000-4000-8000-${String(counter).padStart(12, "0")}`;
}

/** Стартовый набор из 23 категорий — то, с чем семья выходит из онбординга. */
function defaults(): Pick<BudgetState, "categories"> {
  return { categories: makeDefaultCategories(nextId) };
}

function byId(state: Pick<BudgetState, "categories">): Map<string, Category> {
  return new Map(state.categories.map((category) => [category.id, category]));
}

function operation(overrides: Partial<StatementOperation>): StatementOperation {
  return { line: 1, occurredOn: "2026-08-01", amountMinor: 10_000, direction: "out", description: "", bankCategory: "", mcc: "", ...overrides };
}

describe("три ступени классификации", () => {
  it("раскладывает образец выписки: категория банка, словарь, список на подтверждение", () => {
    const state = defaults();
    const parsed = parseStatement(sampleStatementBytes());
    const { rows, summary } = classifyStatement(parsed.operations, state);
    const names = byId(state);
    const nameOf = (line: number): string | null => {
      const row = rows.find((item) => item.operation.line === line)!;
      return row.placement.kind === "expense" || row.placement.kind === "income"
        ? (row.placement.categoryId === null ? null : names.get(row.placement.categoryId)!.name)
        : row.placement.kind;
    };

    expect(summary).toEqual({ total: SAMPLE_EXPECTED.operations, selfTransfer: 2, memory: 0, bank: 6, merchant: 3, unknown: 3 });
    // Первая ступень — категория банка.
    expect(nameOf(2)).toBe("Продукты");
    expect(nameOf(3)).toBe("Продукты");
    expect(nameOf(4)).toBe("Транспорт");
    expect(nameOf(10)).toBe("Связь и подписки");
    expect(nameOf(14)).toBe("Здоровье и аптека");
    expect(nameOf(15)).toBe("ЖКХ");
    // Вторая — словарь продавцов, там где банк сказал «Другое» или «Пополнения».
    expect(nameOf(1)).toBe("Зарплата");
    expect(nameOf(8)).toBe("Связь и подписки");
    expect(nameOf(12)).toBe("Кешбэк и проценты");
    // Перевод себе — не трата и не доход.
    expect(nameOf(5)).toBe("self-transfer");
    expect(nameOf(13)).toBe("self-transfer");
    // Третья — незнакомое идёт в список, а не в «Прочее».
    expect(nameOf(6)).toBe("unknown");
    expect(nameOf(7)).toBe("unknown");
    expect(nameOf(11)).toBe("unknown");
    expect(rows.filter((row) => row.placement.kind === "expense" && names.get(row.placement.categoryId)?.name === "Прочее")).toEqual([]);
    expect([...new Set(rows.filter((row) => row.placement.kind === "unknown").map((row) => row.merchantKey))]).toEqual([...SAMPLE_EXPECTED.unknownMerchants]);
  });

  it("применяет запомненное назначение раньше категории банка и только к своему виду", () => {
    const state = defaults();
    const rent = state.categories.find((category) => category.name === "Жильё")!;
    const memory: MerchantMemoryEntry[] = [
      { key: merchantKey("Перевод по номеру телефона Мария П."), categoryName: "Жильё", type: "expense", updatedAt: "2026-08-01T00:00:00.000Z" },
      // Слово человека старше слова банка: «Пятёрочка» он положил в «Дом и хозяйство».
      { key: merchantKey("Пятёрочка"), categoryName: "Дом и хозяйство", type: "expense", updatedAt: "2026-08-01T00:00:00.000Z" },
      // Память про доход не трогает расход того же продавца.
      { key: merchantKey("Магнит"), categoryName: "Прочие доходы", type: "income", updatedAt: "2026-08-01T00:00:00.000Z" },
    ];
    const { rows, summary } = classifyStatement(parseStatement(sampleStatementBytes()).operations, state, memory);
    const names = byId(state);
    const row = (line: number) => rows.find((item) => item.operation.line === line)!;

    expect(row(11).placement).toEqual({ kind: "expense", categoryId: rent.id, via: "memory" });
    expect(row(2).placement).toMatchObject({ via: "memory" });
    expect(names.get((row(2).placement as { categoryId: string }).categoryId)?.name).toBe("Дом и хозяйство");
    expect(row(3).placement).toMatchObject({ via: "bank" });
    expect(summary.memory).toBe(2);
    expect(summary.unknown).toBe(2);
  });

  it("помнит и «доход без категории» — это тоже решение человека", () => {
    const state = defaults();
    const memory: MerchantMemoryEntry[] = [{ key: merchantKey("Перевод от Мамы"), categoryName: null, type: "income", updatedAt: "2026-08-01T00:00:00.000Z" }];
    const { rows } = classifyStatement([operation({ direction: "in", description: "Перевод от Мамы", bankCategory: "Пополнения" })], state, memory);
    expect(rows[0]?.placement).toEqual({ kind: "income", categoryId: null, via: "memory" });
  });

  it("не создаёт категорию, которой у семьи нет: строка идёт на подтверждение", () => {
    const state = defaults();
    // «Отели» ведут в «Отпуск и поездки»; в стартовом наборе её нет, и словарь ничего не знает.
    const { rows } = classifyStatement([operation({ description: "Hotel Astoria", bankCategory: "Отели" })], state);
    expect(rows[0]?.placement).toEqual({ kind: "unknown" });
    // А когда семья её завела — попадает туда, минуя «Транспорт».
    const withTrips: Pick<BudgetState, "categories"> = {
      categories: [...state.categories, { id: nextId(), name: "Отпуск и поездки", type: "expense", group: "personal", active: true, sortOrder: 900 }],
    };
    const placed = classifyStatement([operation({ description: "Аэрофлот", bankCategory: "Авиабилеты" })], withTrips).rows[0]?.placement;
    expect(placed).toMatchObject({ kind: "expense", via: "bank" });
    expect(byId(withTrips).get((placed as { categoryId: string }).categoryId)?.name).toBe("Отпуск и поездки");
  });

  it("не кладёт в архивную категорию и не путает доход с расходом", () => {
    const state = defaults();
    const archived: Pick<BudgetState, "categories"> = {
      categories: state.categories.map((category) => category.name === "Продукты" ? { ...category, active: false } : category),
    };
    expect(classifyStatement([operation({ description: "Пятёрочка", bankCategory: "Супермаркеты" })], archived).rows[0]?.placement).toEqual({ kind: "unknown" });
    // Приход с категорией «Супермаркеты» (возврат от магазина) — не расход на продукты.
    const refund = classifyStatement([operation({ direction: "in", description: "Пятёрочка", bankCategory: "Супермаркеты" })], state).rows[0]?.placement;
    expect(refund?.kind).not.toBe("expense");
  });

  it("узнаёт перевод между своими счетами по описанию, а чужой перевод — нет", () => {
    expect(isSelfTransfer(operation({ description: "Перевод между счетами", bankCategory: "Переводы" }))).toBe(true);
    expect(isSelfTransfer(operation({ description: "Внутренний перевод на договор 5012345678", bankCategory: "Переводы" }))).toBe(true);
    expect(isSelfTransfer(operation({ description: "Пополнение. Перевод с накопительного счёта", bankCategory: "Пополнения", direction: "in" }))).toBe(true);
    expect(isSelfTransfer(operation({ description: "Округление на Инвесткопилку", bankCategory: "Другое" }))).toBe(true);
    expect(isSelfTransfer(operation({ description: "Перевод по номеру телефона Мария П.", bankCategory: "Переводы" }))).toBe(false);
    expect(isSelfTransfer(operation({ description: "Перевод с карты", bankCategory: "Пополнения", direction: "in" }))).toBe(false);
    // Описание про «между счетами» у покупки в супермаркете — совпадение, а не перевод.
    expect(isSelfTransfer(operation({ description: "Магазин между счетами", bankCategory: "Супермаркеты" }))).toBe(false);
  });

  it("считает ключ продавца без регистра, «ё», цифр и знаков", () => {
    expect(merchantKey("ПЯТЁРОЧКА №1234")).toBe("пятерочка");
    expect(merchantKey('ООО "Ромашка"')).toBe("ооо ромашка");
    expect(merchantKey("  Яндекс.Такси  ")).toBe("яндекс такси");
  });

  it("словарь и карта категорий банка не пусты и знают ключевых продавцов", () => {
    expect(MERCHANT_RULE_COUNT).toBeGreaterThan(100);
    expect(BANK_CATEGORY_COUNT).toBeGreaterThan(60);
    const state = defaults();
    const names = byId(state);
    const expect_ = (description: string, direction: "in" | "out", name: string) => {
      const placement = classifyStatement([operation({ description, direction, bankCategory: "Другое" })], state).rows[0]?.placement;
      expect(placement, description).toMatchObject({ via: "merchant" });
      expect(names.get((placement as { categoryId: string }).categoryId)?.name, description).toBe(name);
    };
    expect_("ПЯТЕРОЧКА 1234", "out", "Продукты");
    expect_("Лента", "out", "Продукты");
    expect_("Яндекс.Такси", "out", "Транспорт");
    expect_("Магнит Косметик", "out", "Дом и хозяйство");
    expect_("Аптека Ригла", "out", "Здоровье и аптека");
    expect_("Билайн", "out", "Связь и подписки");
    expect_("Зарплата за август", "in", "Зарплата");
    expect_("Проценты по остатку", "in", "Кешбэк и проценты");
  });
});
