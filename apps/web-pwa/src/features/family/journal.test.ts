/**
 * Перевод изменения бюджета в операции журнала — и то, чего он делать не должен.
 *
 * Три свойства здесь важнее остальных: перестановка в списке не изменение; правка — это `update`,
 * а не второе `create`; и каждая операция несёт участника, иначе автор на чужом экране навсегда
 * остаётся «Без участника». Всё, что этот файл строит, проверяется настоящим кодеком протокола:
 * набросок, который кодек отвергнет, — это операция, которая никогда не дойдёт до семьи, и узнать
 * об этом на экране пользователя было бы поздно.
 */
import { makePlanningSeed, makeSeedBudget, SEED_IDS, type BudgetState } from "@family-budget/domain";
import { applyJournal, createClock, createLocalOperation, type Operation } from "@family-budget/sync-protocol";
import { describe, expect, it } from "vitest";

import { budgetJournalDrafts, canonical } from "./journal";

const DEVICE = "0000000a-0000-4000-8000-000000000001";
const MEMBER = "0000000a-0000-4000-8000-00000000aaaa";

/** Штампует наброски так же, как это делает движок, — через настоящий кодек. */
function stamp(state: BudgetState, previous: BudgetState | null = null, from = 0): Operation[] {
  let clock = createClock(DEVICE, from);
  const operations: Operation[] = [];
  for (const draft of budgetJournalDrafts(previous, state, MEMBER)) {
    const local = createLocalOperation(clock, draft);
    clock = local.clock;
    operations.push(local.operation);
  }
  return operations;
}

describe("бюджет как операции журнала", () => {
  it("посев доходит до того же бюджета, с которого начался", () => {
    const state = makeSeedBudget();
    const materialized = applyJournal(stamp(state)).state;

    expect(materialized.activeBudgetId).toBe(state.activeBudgetId);
    expect([...materialized.accounts].sort()).toHaveLength(state.accounts.length);
    expect(materialized.categories).toHaveLength(state.categories.length);
    expect(materialized.transactions).toHaveLength(state.transactions.length);
    expect(materialized.budgets[0]?.lines).toHaveLength(state.budgets[0]!.lines.length);
    expect(materialized.goals).toHaveLength(state.goals.length);
    // До копейки: суммы — это то, ради чего всё остальное существует.
    for (const transaction of state.transactions) {
      const arrived = materialized.transactions.find((entry) => entry.id === transaction.id);
      expect(arrived?.amountMinor).toBe(transaction.amountMinor);
      expect(arrived?.occurredOn).toBe(transaction.occurredOn);
    }
  });

  it("посев планового бюджета переносит расписания и крупные платежи", () => {
    const state = makePlanningSeed();
    const materialized = applyJournal(stamp(state)).state;

    expect(materialized.scheduledExpenses).toHaveLength(state.scheduledExpenses.length);
    expect(materialized.annualCommitments).toHaveLength(state.annualCommitments.length);
    const selected = state.scheduledExpenses.find((expense) => expense.mode === "selected_months");
    if (selected !== undefined) {
      const arrived = materialized.scheduledExpenses.find((entry) => entry.id === selected.id);
      expect(arrived?.months).toEqual(selected.months);
    }
  });

  it("перестановка записей в списке — не изменение", () => {
    const state = makeSeedBudget();
    const shuffled: BudgetState = {
      ...state,
      accounts: [...state.accounts].reverse(),
      categories: [...state.categories].reverse(),
      transactions: [...state.transactions].reverse(),
    };
    expect(budgetJournalDrafts(state, shuffled, MEMBER)).toEqual([]);
    expect(budgetJournalDrafts(state, state, MEMBER)).toEqual([]);
  });

  it("перестановка ключей вложенного объекта — тоже не изменение, а порядок списка — изменение", () => {
    // Сортировка одного верхнего уровня пропустила бы вложенный курс или шаблон правила, собранный
    // в другом порядке ключей, и каждое открытие экрана рассылало бы семье «обновление».
    const one = { amountMinor: 1, rate: { baseMinor: 9_000, quoteMinor: 100 }, template: { kind: "expense", nested: { b: [1, { y: 2, x: 1 }], a: null } } };
    const two = { template: { nested: { a: null, b: [1, { x: 1, y: 2 }] }, kind: "expense" }, rate: { quoteMinor: 100, baseMinor: 9_000 }, amountMinor: 1 };
    expect(canonical(two)).toBe(canonical(one));
    expect(canonical({ tagIds: ["b", "a"] })).not.toBe(canonical({ tagIds: ["a", "b"] }));
    expect(canonical({ rate: { baseMinor: 9_000, quoteMinor: 100 } })).not.toBe(canonical({ rate: { baseMinor: 9_250, quoteMinor: 100 } }));
    // Имя поля — данные: «__proto__» во вложенном объекте не становится прототипом.
    expect(canonical(JSON.parse('{"a":{"__proto__":{"x":1}}}') as Record<string, unknown>)).toBe('{"a":{"__proto__":{"x":1}}}');
  });

  it("правка — это update той же записи, а не второе создание", () => {
    const state = makeSeedBudget();
    const edited: BudgetState = {
      ...state,
      transactions: state.transactions.map((entry) =>
        entry.id === SEED_IDS.transactions.food ? { ...entry, amountMinor: 111_100 } : entry,
      ),
    };
    const drafts = budgetJournalDrafts(state, edited, MEMBER);
    expect(drafts).toHaveLength(1);
    expect(drafts[0]).toMatchObject({
      entity: "transaction",
      action: "update",
      targetId: SEED_IDS.transactions.food,
      memberId: MEMBER,
    });
  });

  it("удаление — это delete, и оно одно", () => {
    const state = makeSeedBudget();
    const trimmed: BudgetState = {
      ...state,
      transactions: state.transactions.filter((entry) => entry.id !== SEED_IDS.transactions.food),
    };
    const drafts = budgetJournalDrafts(state, trimmed, MEMBER);
    expect(drafts).toEqual([
      {
        memberId: MEMBER,
        entity: "transaction",
        action: "delete",
        targetId: SEED_IDS.transactions.food,
      },
    ]);
  });

  it("смена активного бюджета доезжает отдельной активацией", () => {
    const state = makeSeedBudget();
    const second = {
      ...state.budgets[0]!,
      id: "44444444-4444-4444-8444-444444444442",
      lines: [],
    };
    const next: BudgetState = {
      ...state,
      budgets: [...state.budgets, second],
      activeBudgetId: second.id,
    };
    const drafts = budgetJournalDrafts(state, next, MEMBER);
    expect(drafts).toContainEqual({
      memberId: MEMBER,
      entity: "budget",
      action: "activate",
      targetId: second.id,
    });
    // Часы продолжаются, как у настоящего устройства: активация позже прежней и выигрывает её.
    const seeded = stamp(state);
    const changed = stamp(next, state, seeded.length);
    expect(applyJournal([...seeded, ...changed]).state.activeBudgetId).toBe(second.id);
  });

  it("участник этого устройства стоит на каждой операции", () => {
    const drafts = budgetJournalDrafts(null, makeSeedBudget(), MEMBER);
    expect(drafts.length).toBeGreaterThan(10);
    for (const draft of drafts) expect(draft.memberId).toBe(MEMBER);
    // И его отсутствие не превращается в пустую метку: поля просто нет.
    for (const draft of budgetJournalDrafts(null, makeSeedBudget())) {
      expect("memberId" in draft).toBe(false);
    }
  });

  it("метка участника на самой операции переживает дорогу", () => {
    const state = makeSeedBudget();
    const labelled: BudgetState = {
      ...state,
      members: [{ id: MEMBER, name: "Анна", role: "owner", active: true }],
      transactions: state.transactions.map((entry) =>
        entry.id === SEED_IDS.transactions.transport ? { ...entry, memberId: MEMBER } : entry,
      ),
    };
    const materialized = applyJournal(stamp(labelled)).state;
    const arrived = materialized.transactions.find(
      (entry) => entry.id === SEED_IDS.transactions.transport,
    );
    expect(arrived?.memberId).toBe(MEMBER);
    expect(materialized.members.map((member) => member.name)).toEqual(["Анна"]);
  });

  it("категория дохода доходит до семьи, а её отсутствие не превращается в поле", () => {
    const state = makeSeedBudget();
    const categoryId = "0000000a-0000-4000-8000-00000000c001";
    const income = state.transactions.find((entry) => entry.kind === "income");
    expect(income).toBeDefined();
    const labelled: BudgetState = {
      ...state,
      categories: [
        ...state.categories,
        { id: categoryId, name: "Зарплата", type: "income", group: "income", active: true, sortOrder: 900 },
      ],
      transactions: state.transactions.map((entry) =>
        entry.id === income!.id ? { ...entry, categoryId } : entry,
      ),
    };

    const arrived = applyJournal(stamp(labelled)).state.transactions.find(
      (entry) => entry.id === income!.id,
    );
    expect(arrived).toMatchObject({ kind: "income", categoryId });

    // Доход без категории остаётся доходом без категории — поля у него нет вовсе.
    const plain = applyJournal(stamp(state)).state.transactions.find((entry) => entry.id === income!.id);
    expect(Object.hasOwn(plain ?? {}, "categoryId")).toBe(false);
  });
});

describe("метки, заметки и оформление как операции журнала", () => {
  const TAG_HOME = "0000000a-0000-4000-8000-0000000000d1";
  const TAG_OLD = "0000000a-0000-4000-8000-0000000000d2";

  /** Посевной бюджет, в котором есть всё, что принесла волна 1. */
  function labelled(): BudgetState {
    const state = makeSeedBudget();
    return {
      ...state,
      tags: [
        { id: TAG_HOME, name: "Дом", active: true },
        { id: TAG_OLD, name: "Старое", active: false },
      ],
      accounts: state.accounts.map((account, index) => ({
        ...account,
        sortOrder: (index + 1) * 10,
        icon: "banknote",
        color: "sage",
        ...(index === 1 ? { includeInTotal: false } : {}),
      })),
      categories: state.categories.map((category) => ({ ...category, icon: "shopping-basket", color: "mint" })),
      goals: state.goals.map((goal) => ({ ...goal, deadline: "2027-06-01", icon: "plane" })),
      transactions: state.transactions.map((entry) =>
        entry.id === SEED_IDS.transactions.food
          ? { ...entry, note: "Пятёрочка у дома", tagIds: [TAG_HOME, TAG_OLD] }
          : entry,
      ),
    };
  }

  it("посев переносит метки, заметку и оформление так, что журнал собирает то же состояние", () => {
    const state = labelled();
    const materialized = applyJournal(stamp(state)).state;

    expect([...materialized.tags].sort((left, right) => left.id.localeCompare(right.id))).toEqual(state.tags);
    expect(materialized.transactions.find((entry) => entry.id === SEED_IDS.transactions.food))
      .toMatchObject({ note: "Пятёрочка у дома", tagIds: [TAG_HOME, TAG_OLD] });
    for (const account of state.accounts) {
      expect(materialized.accounts.find((entry) => entry.id === account.id)).toEqual(account);
    }
    for (const category of state.categories) {
      expect(materialized.categories.find((entry) => entry.id === category.id)).toEqual(category);
    }
    expect(materialized.goals).toEqual(state.goals);
  });

  it("бюджет без новых полей даёт ровно те поля, что давал всегда", () => {
    const drafts = budgetJournalDrafts(null, makeSeedBudget());
    for (const draft of drafts) {
      if (!("fields" in draft)) continue;
      for (const field of ["sortOrder", "icon", "color", "includeInTotal", "deadline", "note", "tagIds", "recurringRuleId"]) {
        // У категории порядок был всегда, у остальных этих полей нет вовсе.
        if (draft.entity === "category" && field === "sortOrder") continue;
        expect(Object.hasOwn(draft.fields, field), `${draft.entity}.${field}`).toBe(false);
      }
    }
    expect(drafts.some((draft) => draft.entity === "tag")).toBe(false);
  });

  it("перестановка ключей и записей — не изменение, а правка метки — update одной записи", () => {
    const state = labelled();
    const reordered: BudgetState = {
      ...state,
      tags: [...(state.tags ?? [])].reverse(),
      accounts: state.accounts.map((account) =>
        Object.fromEntries(Object.entries(account).reverse()) as unknown as typeof account),
      transactions: [...state.transactions].reverse().map((entry) =>
        Object.fromEntries(Object.entries(entry).reverse()) as unknown as typeof entry),
    };
    expect(budgetJournalDrafts(state, reordered, MEMBER)).toEqual([]);

    const renamed: BudgetState = {
      ...state,
      tags: (state.tags ?? []).map((tag) => (tag.id === TAG_HOME ? { ...tag, name: "Дача" } : tag)),
    };
    expect(budgetJournalDrafts(state, renamed, MEMBER)).toEqual([
      { memberId: MEMBER, entity: "tag", action: "update", targetId: TAG_HOME, fields: { name: "Дача", active: true } },
    ]);

    const untagged: BudgetState = {
      ...state,
      tags: (state.tags ?? []).filter((tag) => tag.id !== TAG_OLD),
      transactions: state.transactions.map((entry) =>
        entry.id === SEED_IDS.transactions.food ? { ...entry, tagIds: [TAG_HOME] } : entry),
    };
    const drafts = budgetJournalDrafts(state, untagged, MEMBER);
    expect(drafts.map((draft) => [draft.entity, draft.action, draft.targetId])).toEqual([
      ["transaction", "update", SEED_IDS.transactions.food],
      ["tag", "delete", TAG_OLD],
    ]);
    // И каждый набросок проходит настоящий кодек.
    expect(() => stamp(untagged, state)).not.toThrow();
  });
});
