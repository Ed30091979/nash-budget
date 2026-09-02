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

import { budgetJournalDrafts } from "./journal";

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
