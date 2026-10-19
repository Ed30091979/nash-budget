/**
 * Перевод изменения бюджета в операции журнала — и то, чего он делать не должен.
 *
 * Три свойства здесь важнее остальных: перестановка в списке не изменение; правка — это `update`,
 * а не второе `create`; и каждая операция несёт участника, иначе автор на чужом экране навсегда
 * остаётся «Без участника». Всё, что этот файл строит, проверяется настоящим кодеком протокола:
 * набросок, который кодек отвергнет, — это операция, которая никогда не дойдёт до семьи, и узнать
 * об этом на экране пользователя было бы поздно.
 */
import {
  addExchangeRate,
  calculateBudget,
  calculateHoldings,
  createAccount,
  HOUSEHOLD_ID,
  makePlanningSeed,
  makeSeedBudget,
  materializeRecurring,
  moveAccount,
  moveCategory,
  renameTag,
  SEED_IDS,
  setBaseCurrency,
  updateAccount,
  updateCategory,
  type BudgetState,
  type RecurringRule,
} from "@family-budget/domain";
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

describe("валюты как операции журнала", () => {
  const DOLLARS = "0000000a-0000-4000-8000-0000000000e1";
  const DOLLAR_EXPENSE = "0000000a-0000-4000-8000-0000000000e2";
  const TRANSFER = "0000000a-0000-4000-8000-0000000000e3";
  const RATE = "0000000a-0000-4000-8000-0000000000e4";

  /** Посевной бюджет с хозяйством, курсом, долларовым счётом, покупкой и переводом в доллары. */
  function dollars(): BudgetState {
    const state = makeSeedBudget();
    return {
      ...state,
      household: { id: HOUSEHOLD_ID, baseCurrency: "RUB" },
      exchangeRates: [{ id: RATE, currency: "USD", baseCurrency: "RUB", date: "2026-06-30", rate: { baseMinor: 9_000, quoteMinor: 100 } }],
      accounts: [...state.accounts, { id: DOLLARS, name: "Доллары", type: "savings", currency: "USD", openingBalanceMinor: 50_000, active: true }],
      transactions: [
        ...state.transactions,
        {
          id: DOLLAR_EXPENSE, occurredOn: "2026-07-10", status: "posted", kind: "expense", amountMinor: 4_000,
          accountId: DOLLARS, categoryId: SEED_IDS.categories.food,
          baseAmountMinor: 360_000, baseCurrency: "RUB", rate: { baseMinor: 9_000, quoteMinor: 100 },
        },
        {
          id: TRANSFER, occurredOn: "2026-07-05", status: "posted", kind: "transfer", amountMinor: 1_800_000,
          fromAccountId: SEED_IDS.accounts.main, toAccountId: DOLLARS, toAmountMinor: 20_000,
        },
      ],
    };
  }

  it("посев переносит хозяйство, курс, снимок и сумму зачисления, и журнал собирает то же состояние", () => {
    const state = dollars();
    const snapshot = applyJournal(stamp(state));

    expect(snapshot.integrity).toEqual({ ready: true, problems: [], withheld: [] });
    expect(snapshot.state.household).toEqual(state.household);
    expect(snapshot.state.exchangeRates).toEqual(state.exchangeRates);
    for (const id of [DOLLAR_EXPENSE, TRANSFER]) {
      expect(snapshot.state.transactions.find((entry) => entry.id === id)).toEqual(state.transactions.find((entry) => entry.id === id));
    }
    expect(calculateBudget(snapshot.state)).toEqual(calculateBudget(state));
  });

  it("порядок ключей вложенного курса — не изменение, а новый курс — update одной записи", () => {
    const state = dollars();
    const reordered: BudgetState = {
      ...state,
      exchangeRates: state.exchangeRates!.map((rate) => ({ ...rate, rate: { quoteMinor: rate.rate.quoteMinor, baseMinor: rate.rate.baseMinor } })),
      transactions: state.transactions.map((entry) =>
        entry.kind === "expense" && entry.rate !== undefined
          ? { ...entry, rate: { quoteMinor: entry.rate.quoteMinor, baseMinor: entry.rate.baseMinor } }
          : entry),
    };
    expect(budgetJournalDrafts(state, reordered, MEMBER)).toEqual([]);

    const revalued: BudgetState = {
      ...state,
      exchangeRates: state.exchangeRates!.map((rate) => ({ ...rate, rate: { baseMinor: 9_250, quoteMinor: 100 } })),
    };
    expect(budgetJournalDrafts(state, revalued, MEMBER)).toEqual([
      {
        memberId: MEMBER, entity: "exchangeRate", action: "update", targetId: RATE,
        fields: { currency: "USD", baseCurrency: "RUB", date: "2026-06-30", rate: { baseMinor: 9_250, quoteMinor: 100 } },
      },
    ]);
  });

  it("не удаляет хозяйство, даже если его нет в следующем состоянии", () => {
    const state = dollars();
    const { household: _household, ...without } = state;
    expect(budgetJournalDrafts(state, without, MEMBER)).toEqual([]);
  });
});

describe("долги как операции журнала", () => {
  const PETYA = "0000000a-0000-4000-8000-0000000000f1";
  const LENT = "0000000a-0000-4000-8000-0000000000f2";

  it("посев переносит долг и движение по нему, срок — только когда он есть", () => {
    const seed = makeSeedBudget();
    const state: BudgetState = {
      ...seed,
      debts: [{ id: PETYA, counterparty: "Петя", direction: "owed_to_me", currency: "RUB", openingMinor: 0, active: true }],
      transactions: [...seed.transactions, { id: LENT, kind: "debt_out", status: "posted", occurredOn: "2026-07-09", amountMinor: 500_000, accountId: SEED_IDS.accounts.main, debtId: PETYA }],
    };
    const snapshot = applyJournal(stamp(state));
    expect(snapshot.integrity).toEqual({ ready: true, problems: [], withheld: [] });
    expect(snapshot.state.debts).toEqual(state.debts);
    expect(snapshot.state.transactions.find((item) => item.id === LENT)).toEqual(state.transactions.at(-1));
    const debtDraft = budgetJournalDrafts(null, state).find((draft) => draft.entity === "debt");
    expect(debtDraft !== undefined && "fields" in debtDraft && Object.hasOwn(debtDraft.fields, "dueDate")).toBe(false);
  });
});

describe("регулярные операции как операции журнала", () => {
  const RULE = "0000000a-0000-4000-8000-0000000000e1";
  const TAG = "0000000a-0000-4000-8000-0000000000e2";
  const WATER: RecurringRule = {
    id: RULE,
    name: "Доставка воды",
    template: {
      kind: "expense", amountMinor: 150_000, accountId: SEED_IDS.accounts.main, categoryId: SEED_IDS.categories.food,
      note: "Доставка воды", tagIds: [TAG],
    },
    frequency: "weekly",
    interval: 2,
    startDate: "2026-07-07",
    active: true,
  };

  function withRule(): BudgetState {
    return { ...makeSeedBudget(), tags: [{ id: TAG, name: "Дом", active: true }], recurringRules: [WATER] };
  }

  it("посев переносит правило с шаблоном и его вхождения с меткой правила", () => {
    const state = materializeRecurring(withRule(), "2026-07-31").state;
    const snapshot = applyJournal(stamp(state));
    expect(snapshot.integrity).toEqual({ ready: true, problems: [], withheld: [] });
    expect(snapshot.state.recurringRules).toEqual(state.recurringRules);
    const occurrences = state.transactions.filter((entry) => entry.recurringRuleId === RULE);
    expect(occurrences.map((entry) => entry.occurredOn)).toEqual(["2026-07-07", "2026-07-21"]);
    for (const occurrence of occurrences) {
      expect(snapshot.state.transactions.find((entry) => entry.id === occurrence.id)).toEqual(occurrence);
    }
    expect(calculateBudget(snapshot.state)).toEqual(calculateBudget(state));
  });

  it("материализация — создания вхождений и одно обновление правила, а порядок ключей шаблона — не изменение", () => {
    const before = withRule();
    const after = materializeRecurring(before, "2026-07-31").state;
    const drafts = budgetJournalDrafts(before, after, MEMBER);
    expect(drafts.map((draft) => [draft.entity, draft.action])).toEqual([
      ["recurringRule", "update"],
      ["transaction", "create"],
      ["transaction", "create"],
    ]);
    expect(drafts[0]).toMatchObject({ targetId: RULE, fields: { materializedThrough: "2026-07-31" } });

    const reordered: BudgetState = {
      ...after,
      // The same fields in the opposite order of keys, the template's included.
      recurringRules: after.recurringRules!.map((rule) => Object.fromEntries(Object.entries({
        ...rule,
        template: Object.fromEntries(Object.entries(rule.template).reverse()),
      }).reverse()) as unknown as RecurringRule),
    };
    expect(budgetJournalDrafts(after, reordered, MEMBER)).toEqual([]);
    const plain = budgetJournalDrafts(null, { ...makeSeedBudget(), recurringRules: [{ ...WATER, template: { kind: "income", amountMinor: 1, accountId: SEED_IDS.accounts.main } }] })
      .find((draft) => draft.entity === "recurringRule");
    expect(plain !== undefined && "fields" in plain ? plain.fields : null).toEqual({
      name: "Доставка воды", template: { kind: "income", amountMinor: 1, accountId: SEED_IDS.accounts.main },
      frequency: "weekly", interval: 2, startDate: "2026-07-07", active: true,
    });
  });
});

describe("правка справочников как операции журнала (подволна 2c)", () => {
  const DOLLARS = "0000000a-0000-4000-8000-0000000000c1";
  const RATE = "0000000a-0000-4000-8000-0000000000c2";
  const TAG = "0000000a-0000-4000-8000-0000000000c3";

  /** Применить к журналу изменение от `before` к `after` и вернуть собранное состояние. */
  function roundTrip(log: Operation[], before: BudgetState, after: BudgetState): { readonly log: Operation[]; readonly state: BudgetState } {
    const next = [...log, ...stamp(after, before, log.length)];
    const snapshot = applyJournal(next);
    expect(snapshot.integrity).toEqual({ ready: true, problems: [], withheld: [] });
    return { log: next, state: snapshot.state };
  }

  it("счёт в долларах заводится, правится целиком и очищается — журнал собирает ровно его", () => {
    const seed = makeSeedBudget();
    let log = stamp(seed);
    const created = createAccount(seed, { name: "Доллары", type: "cash", currency: "USD", openingBalanceMinor: 50_000 }, () => DOLLARS).state;
    const rated = addExchangeRate(created, { currency: "USD", date: "2026-07-01", rate: { baseMinor: 9_250, quoteMinor: 100 } }, () => RATE).state;
    ({ log } = roundTrip(log, seed, rated));

    // Правка — один update той же записи: имя, вид, иконка, тон, «вне итога», начальный остаток.
    const edited = updateAccount(rated, DOLLARS, { name: "Наличные доллары", type: "savings", icon: "banknote", color: "sage", includeInTotal: false, openingBalanceMinor: 60_000 });
    const drafts = budgetJournalDrafts(rated, edited, MEMBER);
    expect(drafts.map((draft) => [draft.entity, draft.action, draft.targetId])).toEqual([["account", "update", DOLLARS]]);
    const arrived = roundTrip(log, rated, edited);
    log = arrived.log;
    expect(arrived.state.accounts.find((item) => item.id === DOLLARS)).toEqual(edited.accounts.find((item) => item.id === DOLLARS));
    expect(calculateHoldings(arrived.state, "2026-07-31")).toEqual(calculateHoldings(edited, "2026-07-31"));

    // Снятые иконка и тон и «снова в итоге» — отсутствие поля, а не пустое значение, и после дороги тоже.
    const cleared = updateAccount(edited, DOLLARS, { icon: null, color: null, includeInTotal: true });
    const back = roundTrip(log, edited, cleared);
    const account = back.state.accounts.find((item) => item.id === DOLLARS)!;
    expect(account).toEqual(cleared.accounts.find((item) => item.id === DOLLARS));
    for (const field of ["icon", "color", "includeInTotal"]) expect(Object.hasOwn(account, field), field).toBe(false);
  });

  it("перестановка счетов — update ровно двух записей, а не всего списка", () => {
    const seed = makeSeedBudget();
    const spread = moveAccount(seed, SEED_IDS.accounts.savings, "up");
    const log = roundTrip(stamp(seed), seed, spread).log;
    const swapped = moveAccount(spread, SEED_IDS.accounts.savings, "down");
    const drafts = budgetJournalDrafts(spread, swapped, MEMBER);
    expect(drafts.map((draft) => [draft.entity, draft.action])).toEqual([["account", "update"], ["account", "update"]]);
    const arrived = roundTrip(log, spread, swapped).state;
    for (const account of swapped.accounts) expect(arrived.accounts.find((item) => item.id === account.id)).toEqual(account);
  });

  it("категория: новое имя, иконка, тон и место в группе доезжают как update, суммы не двигаются", () => {
    const seed = makeSeedBudget();
    const log = stamp(seed);
    const edited = moveCategory(updateCategory(seed, SEED_IDS.categories.food, { name: "Еда", icon: "shopping-basket", color: "lilac" }), SEED_IDS.categories.food, "up");
    const drafts = budgetJournalDrafts(seed, edited, MEMBER);
    expect(drafts.every((draft) => draft.entity === "category" && draft.action === "update")).toBe(true);
    const arrived = roundTrip(log, seed, edited).state;
    for (const category of edited.categories) expect(arrived.categories.find((item) => item.id === category.id)).toEqual(category);
    expect(calculateBudget(arrived)).toEqual(calculateBudget(edited));
  });

  it("переименование метки — update одной метки, операции с ней не пишутся", () => {
    const seed = makeSeedBudget();
    const tagged: BudgetState = {
      ...seed,
      tags: [{ id: TAG, name: "Дача", active: true }],
      transactions: seed.transactions.map((entry) => (entry.id === SEED_IDS.transactions.food ? { ...entry, tagIds: [TAG] } : entry)),
    };
    const log = stamp(tagged);
    const renamed = renameTag(tagged, TAG, "Огород");
    expect(budgetJournalDrafts(tagged, renamed, MEMBER).map((draft) => [draft.entity, draft.action, draft.targetId])).toEqual([["tag", "update", TAG]]);
    expect(roundTrip(log, tagged, renamed).state.tags).toEqual(renamed.tags);
  });

  it("базовая валюта пустого бюджета — запись хозяйства и счета в новой валюте", () => {
    const seed = makeSeedBudget();
    const empty: BudgetState = { ...seed, transactions: [], goals: [], budgets: seed.budgets.map((budget) => ({ ...budget, lines: [], plannedIncomeMinor: 0 })) };
    const log = stamp(empty);
    const euros = setBaseCurrency(empty, "EUR");
    const arrived = roundTrip(log, empty, euros).state;
    expect(arrived.household).toEqual({ id: HOUSEHOLD_ID, baseCurrency: "EUR" });
    expect(arrived.accounts.every((account) => account.currency === "EUR")).toBe(true);
  });
});
