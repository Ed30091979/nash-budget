import {
  calculateAnnualPlan,
  calculateBudget,
  calculateDebts,
  calculateMemberExpenses,
  COLLECTION_LIMITS,
  HOUSEHOLD_ID,
  materializeRecurring,
  recurringOccurrenceId,
  type Transaction,
} from "@family-budget/domain";
import { G002, toDomainBudgetState, type DomainBudgetState } from "@family-budget/test-fixtures";
import { describe, expect, it } from "vitest";

import { sha256Hex } from "../src/digest.js";
import {
  applyJournal,
  applyOperations,
  compareOperations,
  createClock,
  createEmptyJournal,
  createLocalOperation,
  encodeOperation,
  ENTITY_KINDS,
  HONEST_LAMPORT_CEILING,
  MAX_AGGREGATE_MINOR,
  MAX_APPLIED_OP_IDS,
  MAX_BATCH_OPERATIONS,
  MAX_HONEST_LAMPORT,
  MAX_JOURNAL_ENTRIES,
  MAX_LAMPORT,
  MAX_LAMPORT_SKEW,
  MAX_MONEY_MINOR,
  MAX_TOMBSTONES_PER_DEVICE,
  MAX_UNDO_STEPS,
  parseOperation,
  receiveClock,
  receiveLamport,
  receiveOperations,
  restoreJournal,
  SATURATION_MINOR,
  SyncProtocolError,
  tickClock,
  WITHHOLDING_REASONS,
  type EntityKind,
  type JournalProblem,
  type JournalSnapshot,
  type Operation,
  type OperationDraft,
  type SyncedBudgetState,
  type TransactionFields,
} from "../src/index.js";
import {
  DEVICE_A,
  DEVICE_B,
  DEVICE_C,
  DEVICE_D,
  DEVICE_E,
  mintedDevice,
  opUuid,
  SAMPLE_FIELDS,
  sampleTargetId,
  tagUuid,
  testUuid,
  UPDATED_FIELDS,
} from "./samples.js";

const BUDGET_ID = "74444444-4444-4444-8444-444444444441";
const AUGUST_BUDGET_ID = "74444444-4444-4444-8444-444444444442";
const PRODUCTS_CATEGORY_ID = "73333333-3333-4333-8333-333333333335";
/** An income category the fixture does not have, and the fixture income to file under it. */
const SALARY_CATEGORY_ID = "73333333-3333-4333-8333-333333333338";
const SALARY_INCOME_ID = "75555555-5555-4555-8555-555555555551";
const PRODUCTS_LINE_ID = "74444444-4444-4444-8444-444444444451";
const PRODUCTS_EXPENSE_ID = "75555555-5555-4555-8555-555555555553";
const MAIN_ACCOUNT_ID = "22222222-2222-4222-8222-222222222221";
const RESERVE_ACCOUNT_ID = "22222222-2222-4222-8222-222222222222";
const GOAL_ID = "66666666-6666-4666-8666-666666666661";
const MEMBER_ANNA = "member-anna";
const MEMBER_PETR = "member-petr";
const GHOST_ID = "ghost-transaction";
const LABELLED_EXPENSE_ID = "expense-anna-wrote-down-for-petr";

// The state of G-002, named: the adapter's return type also covers G-003's ledger since step 15.
type FixtureState = DomainBudgetState;
type FixtureTransaction = FixtureState["transactions"][number];

function withoutId<T extends { readonly id: string }>(entity: T): Omit<T, "id"> {
  const { id: _id, ...fields } = entity;
  return fields;
}

function transactionFields(transaction: FixtureTransaction): TransactionFields {
  const base = {
    occurredOn: transaction.occurredOn,
    status: transaction.status,
    amountMinor: transaction.amountMinor,
  };
  switch (transaction.kind) {
    case "income":
      return {
        ...base,
        kind: "income",
        accountId: transaction.accountId,
        // Optional in the fixture as it is in the domain, and carried when it is there: a
        // helper that dropped it would hide the very loss these tests are here to catch.
        ...(transaction.categoryId === undefined ? {} : { categoryId: transaction.categoryId }),
      };
    case "expense":
      return { ...base, kind: "expense", accountId: transaction.accountId, categoryId: transaction.categoryId };
    case "refund":
      return {
        ...base,
        kind: "refund",
        accountId: transaction.accountId,
        categoryId: transaction.categoryId,
        originalTransactionId: transaction.originalTransactionId,
      };
    case "transfer":
      return {
        ...base,
        kind: "transfer",
        fromAccountId: transaction.fromAccountId,
        toAccountId: transaction.toAccountId,
      };
    case "goal_contribution":
      return {
        ...base,
        kind: "goal_contribution",
        fromAccountId: transaction.fromAccountId,
        toAccountId: transaction.toAccountId,
        goalId: transaction.goalId,
      };
  }
}

/** Rebuilds the canonical G-002 budget as an append-only journal written by one device. */
function buildFixtureJournal(): Operation[] {
  const state: FixtureState = toDomainBudgetState(G002);
  const operations: Operation[] = [];
  let clock = createClock(DEVICE_A);
  const push = (draft: OperationDraft): void => {
    const local = createLocalOperation(clock, { ...draft, opId: opUuid(operations.length + 1) });
    clock = local.clock;
    operations.push(local.operation);
  };

  push({ entity: "member", action: "create", targetId: MEMBER_ANNA, fields: { name: "Анна", role: "owner", active: true } });
  push({ entity: "member", action: "create", targetId: MEMBER_PETR, fields: { name: "Пётр", role: "member", active: true } });
  for (const account of state.accounts) {
    push({ memberId: MEMBER_ANNA, entity: "account", action: "create", targetId: account.id, fields: withoutId(account) });
  }
  for (const category of state.categories) {
    push({ memberId: MEMBER_ANNA, entity: "category", action: "create", targetId: category.id, fields: withoutId(category) });
  }
  for (const budget of state.budgets) {
    const { id, lines, ...fields } = budget;
    push({ memberId: MEMBER_ANNA, entity: "budget", action: "create", targetId: id, fields });
    for (const line of lines) {
      push({
        memberId: MEMBER_ANNA,
        entity: "budgetLine",
        action: "create",
        targetId: line.id,
        fields: { budgetId: id, ...withoutId(line) },
      });
    }
  }
  for (const goal of state.goals) {
    push({ entity: "goal", action: "create", targetId: goal.id, fields: withoutId(goal) });
  }
  for (const commitment of state.annualCommitments) {
    push({ entity: "annualCommitment", action: "create", targetId: commitment.id, fields: withoutId(commitment) });
  }
  for (const expense of state.scheduledExpenses) {
    push({ entity: "scheduledExpense", action: "create", targetId: expense.id, fields: withoutId(expense) });
  }
  for (const transaction of state.transactions) {
    push({
      memberId: MEMBER_PETR,
      entity: "transaction",
      action: "create",
      targetId: transaction.id,
      fields: transactionFields(transaction),
    });
  }
  push({ entity: "budget", action: "activate", targetId: state.activeBudgetId });
  return operations;
}

function productsLimitMinor(snapshot: JournalSnapshot): number {
  const metrics = calculateBudget(snapshot.state).categoryMetrics[PRODUCTS_CATEGORY_ID];
  if (!metrics) throw new Error("the Продукты category is missing from the state");
  return metrics.availableMinor;
}

function productsLineEdit(deviceId: string, opId: string, plannedMinor: number, lamport: number): Operation {
  return {
    opId,
    deviceId,
    lamport,
    memberId: MEMBER_ANNA,
    entity: "budgetLine",
    action: "update",
    targetId: PRODUCTS_LINE_ID,
    fields: { budgetId: BUDGET_ID, categoryId: PRODUCTS_CATEGORY_ID, plannedMinor },
  };
}

function ghostExpense(opId: string, lamport: number): Operation {
  return parseOperation({
    opId,
    deviceId: DEVICE_A,
    lamport,
    entity: "transaction",
    action: "create",
    targetId: GHOST_ID,
    fields: {
      kind: "expense",
      occurredOn: "2026-07-10",
      status: "posted",
      amountMinor: 100_000,
      accountId: MAIN_ACCOUNT_ID,
      categoryId: PRODUCTS_CATEGORY_ID,
    },
  });
}

function removal(deviceId: string, opId: string, targetId: string, lamport: number): Operation {
  return { opId, deviceId, lamport, entity: "transaction", action: "delete", targetId };
}

function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = Math.imul(state ^ (state >>> 15), state | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4_294_967_296;
  };
}

function shuffle<T>(items: readonly T[], random: () => number): T[] {
  const result = [...items];
  for (let index = result.length - 1; index > 0; index -= 1) {
    const swap = Math.floor(random() * (index + 1));
    const left = result[index]!;
    result[index] = result[swap]!;
    result[swap] = left;
  }
  return result;
}

function entityIds(state: SyncedBudgetState, entity: EntityKind): string[] {
  switch (entity) {
    case "account":
      return state.accounts.map((item) => item.id);
    case "category":
      return state.categories.map((item) => item.id);
    case "budget":
      return state.budgets.map((item) => item.id);
    case "budgetLine":
      return state.budgets.flatMap((budget) => budget.lines.map((line) => line.id));
    case "goal":
      return state.goals.map((item) => item.id);
    case "annualCommitment":
      return state.annualCommitments.map((item) => item.id);
    case "scheduledExpense":
      return state.scheduledExpenses.map((item) => item.id);
    case "transaction":
      return state.transactions.map((item) => item.id);
    case "member":
      return state.members.map((item) => item.id);
    case "tag":
      return state.tags.map((item) => item.id);
    case "exchangeRate":
      return state.exchangeRates.map((item) => item.id);
    case "household":
      return state.household === undefined ? [] : [state.household.id];
    case "debt":
      return state.debts.map((item) => item.id);
    case "recurringRule":
      return state.recurringRules.map((item) => item.id);
  }
}

function entityValue(state: SyncedBudgetState, entity: EntityKind, targetId: string): unknown {
  switch (entity) {
    case "budgetLine":
      return state.budgets.flatMap((budget) => budget.lines).find((line) => line.id === targetId);
    case "budget":
      return state.budgets.find((budget) => budget.id === targetId);
    case "household":
      return state.household?.id === targetId ? state.household : undefined;
    default: {
      const collections: readonly (readonly { readonly id: string }[])[] = [
        state.accounts,
        state.categories,
        state.goals,
        state.annualCommitments,
        state.scheduledExpenses,
        state.transactions,
        state.members,
        state.tags,
        state.exchangeRates,
        state.debts,
        state.recurringRules,
      ];
      return collections.flat().find((item) => item.id === targetId);
    }
  }
}

const SEED_ACCOUNT_ID = SAMPLE_FIELDS.goal.linkedAccountId;
const SEED_CATEGORY_ID = SAMPLE_FIELDS.budgetLine.categoryId;
const SEED_BUDGET_ID = SAMPLE_FIELDS.budgetLine.budgetId;

/** Parents each kind needs before the integrity gate lets it into the state. */
const SEED_PARENTS: { readonly [K in EntityKind]: readonly ("account" | "category" | "budget")[] } = {
  account: [],
  category: [],
  budget: [],
  budgetLine: ["budget", "category"],
  goal: ["account"],
  annualCommitment: ["account", "category"],
  scheduledExpense: ["account", "category"],
  transaction: ["account", "category"],
  member: [],
  tag: [],
  exchangeRate: [],
  household: [],
  debt: [],
  recurringRule: ["account", "category"],
};

const SEED_TARGET = { account: SEED_ACCOUNT_ID, category: SEED_CATEGORY_ID, budget: SEED_BUDGET_ID } as const;

function seedOperations(entity: EntityKind): Operation[] {
  return SEED_PARENTS[entity].map((parent, index) =>
    parseOperation({
      opId: opUuid(9_000 + index),
      deviceId: DEVICE_A,
      lamport: 1,
      entity: parent,
      action: "create",
      targetId: SEED_TARGET[parent],
      fields: SAMPLE_FIELDS[parent],
    }),
  );
}

/** Every referencing kind is withheld with the same code while its parent is missing. */
const REFERENCING_KINDS: readonly EntityKind[] = [
  "budgetLine",
  "goal",
  "annualCommitment",
  "scheduledExpense",
  "transaction",
  "recurringRule",
];

/** Every identifier the state exposes, in the one flat set a backup export builds. */
function allStateIds(state: SyncedBudgetState): string[] {
  return ENTITY_KINDS.flatMap((entity) => entityIds(state, entity));
}

function activation(deviceId: string, opId: string, targetId: string, lamport: number): Operation {
  return { opId, deviceId, lamport, entity: "budget", action: "activate", targetId };
}

/** A single-account, single-category budget used to push the domain's sums around. */
function moneyJournal(count: number, amountMinor: number): Operation[] {
  const operations: Operation[] = [
    parseOperation({
      opId: opUuid(1),
      deviceId: DEVICE_A,
      lamport: 1,
      entity: "account",
      action: "create",
      targetId: SEED_ACCOUNT_ID,
      fields: SAMPLE_FIELDS.account,
    }),
    parseOperation({
      opId: opUuid(2),
      deviceId: DEVICE_A,
      lamport: 2,
      entity: "category",
      action: "create",
      targetId: SEED_CATEGORY_ID,
      fields: SAMPLE_FIELDS.category,
    }),
    parseOperation({
      opId: opUuid(3),
      deviceId: DEVICE_A,
      lamport: 3,
      entity: "budget",
      action: "create",
      targetId: SEED_BUDGET_ID,
      fields: SAMPLE_FIELDS.budget,
    }),
    parseOperation({
      opId: opUuid(4),
      deviceId: DEVICE_A,
      lamport: 4,
      entity: "budget",
      action: "activate",
      targetId: SEED_BUDGET_ID,
    }),
  ];
  for (let index = 0; index < count; index += 1) {
    operations.push(
      parseOperation({
        opId: opUuid(100 + index),
        deviceId: DEVICE_A,
        lamport: 100 + index,
        entity: "transaction",
        action: "create",
        targetId: `tx-${String(index).padStart(5, "0")}`,
        fields: { ...SAMPLE_FIELDS.transaction, amountMinor, accountId: SEED_ACCOUNT_ID, categoryId: SEED_CATEGORY_ID },
      }),
    );
  }
  return operations;
}

describe("applyJournal", () => {
  it("rebuilds G-002 with the canonical July reserve and free amount", () => {
    const snapshot = applyJournal(buildFixtureJournal());

    expect(snapshot.state.activeBudgetId).toBe(BUDGET_ID);
    expect(snapshot.state.transactions).toHaveLength(4);
    expect(snapshot.state.members.map((member) => member.name)).toEqual(["Анна", "Пётр"]);
    // The gate found nothing to withhold, so the state is safe to hand to the domain.
    expect(snapshot.integrity).toEqual({ ready: true, problems: [], withheld: [] });
    // A backup export keeps one flat set of identifiers, so the state must never repeat one.
    expect(new Set(allStateIds(snapshot.state)).size).toBe(allStateIds(snapshot.state).length);

    const plan = calculateAnnualPlan(snapshot.state, G002.startMonth, 12);
    expect(plan.currentMonth.month).toBe("2026-07");
    expect(plan.currentMonth.annualReserveMinor).toBe(1_980_900);
    expect(plan.currentMonth.spendableAfterPlanMinor).toBe(4_419_100);
    expect(plan.currentMonth.annualReserveMinor / 100).toBe(19_809);
    expect(plan.currentMonth.spendableAfterPlanMinor / 100).toBe(44_191);
    expect(plan.currentMonth).toEqual(G002.expected.months[0]);
    expect(plan).toEqual(calculateAnnualPlan(toDomainBudgetState(G002), G002.startMonth, 12));
  });

  it("does not change a single value when the same journal is applied again", () => {
    const journal = buildFixtureJournal();
    const once = applyJournal(journal);
    const twice = applyOperations(once, journal);

    expect(twice).toBe(once);
    expect(applyJournal([...journal, ...journal])).toEqual(once);
    expect(calculateAnnualPlan(twice.state, G002.startMonth, 12)).toEqual(
      calculateAnnualPlan(once.state, G002.startMonth, 12),
    );
    expect(twice.appliedOpIds).toHaveLength(journal.length);
  });

  it("keeps a budget line out of the state until its budget arrives", () => {
    const line = productsLineEdit(DEVICE_B, opUuid(500), 3_000_000, 500);
    const orphan = applyJournal([line]);
    expect(orphan.state.budgets).toHaveLength(0);
    expect(orphan.entries).toHaveLength(1);
    expect(orphan.integrity.ready).toBe(false);

    const merged = applyOperations(orphan, buildFixtureJournal());
    expect(productsLimitMinor(merged)).toBe(3_000_000);
  });

  it("creates, updates and deletes every entity kind", () => {
    for (const entity of ENTITY_KINDS) {
      const targetId = sampleTargetId(entity, "under-test");
      const stamp = (opId: string, action: "create" | "update" | "delete", lamport: number, updated: boolean) =>
        parseOperation({
          opId,
          deviceId: DEVICE_A,
          lamport,
          entity,
          action,
          targetId,
          ...(action === "delete" ? {} : { fields: updated ? UPDATED_FIELDS[entity] : SAMPLE_FIELDS[entity] }),
        });

      const seed = seedOperations(entity);
      const created = applyJournal([...seed, stamp(opUuid(1), "create", 2, false)]);
      expect(entityIds(created.state, entity)).toEqual([targetId]);
      // With every parent present the integrity gate has nothing to say but the missing
      // activation, which no journal of a single entity can carry.
      expect(created.integrity.problems).toEqual([{ code: "no_active_budget", entity: "budget", id: "" }]);

      const updated = applyOperations(created, [stamp(opUuid(2), "update", 3, true)]);
      expect(entityValue(updated.state, entity, targetId)).toEqual(
        entity === "budgetLine"
          ? { id: targetId, categoryId: UPDATED_FIELDS.budgetLine.categoryId, plannedMinor: 3_500_000 }
          : entity === "budget"
            ? { id: targetId, ...UPDATED_FIELDS.budget, lines: [] }
            : { id: targetId, ...UPDATED_FIELDS[entity] },
      );

      // The household is never deleted: the codec refuses the operation (plan 4.2), so the
      // household stays what the update made it.
      if (entity === "household") {
        expect(() => stamp(opUuid(3), "delete", 4, false)).toThrow(/the household cannot be deleted/);
        continue;
      }
      const removed = applyOperations(updated, [stamp(opUuid(3), "delete", 4, false)]);
      expect(entityIds(removed.state, entity)).toEqual([]);
      expect(removed.entries).toHaveLength(seed.length + 1);
      expect(removed.entries.find((entry) => entry.targetId === targetId)?.action).toBe("delete");
    }
  });

  it("keeps an entity whose parents are missing in the journal but out of the state", () => {
    // Same operations as the test above, minus the parents. The domain throws on a dangling
    // reference and a tombstone is final, so the gate withholds the entity instead of
    // handing the domain a state it would refuse; the journal keeps it for when the parent lands.
    for (const entity of REFERENCING_KINDS) {
      const targetId = sampleTargetId(entity, "under-test");
      const orphan = applyJournal([
        parseOperation({
          opId: opUuid(1),
          deviceId: DEVICE_A,
          lamport: 2,
          entity,
          action: "create",
          targetId,
          fields: SAMPLE_FIELDS[entity],
        }),
      ]);

      expect(entityIds(orphan.state, entity)).toEqual([]);
      expect(orphan.entries).toHaveLength(1);
      expect(orphan.integrity.ready).toBe(false);
      expect(orphan.integrity.problems).toContainEqual({ code: "unknown_reference", entity, id: targetId });
    }
  });
});

describe("conflict resolution", () => {
  it("converges on one Продукты limit whatever the delivery order is", () => {
    const journal = buildFixtureJournal();
    // Identical Lamport values, and the operation identifiers deliberately contradict the
    // device order, so only the deviceId tiebreaker can pick the winner.
    const editThirty = productsLineEdit(DEVICE_A, opUuid(900), 3_000_000, 100);
    const editThirtyFive = productsLineEdit(DEVICE_B, opUuid(100), 3_500_000, 100);

    const clientA = applyJournal([...journal, editThirty, editThirtyFive]);
    const clientB = applyJournal([...journal, editThirtyFive, editThirty]);

    expect(productsLimitMinor(clientA)).toBe(3_500_000);
    expect(productsLimitMinor(clientB)).toBe(3_500_000);
    expect(clientA).toEqual(clientB);

    const remaining = calculateBudget(clientA.state).categoryMetrics[PRODUCTS_CATEGORY_ID]?.remainingMinor;
    expect(remaining).toBe(1_300_000);
  });

  it("prefers the higher Lamport value over the device tiebreaker", () => {
    const journal = buildFixtureJournal();
    const early = productsLineEdit(DEVICE_E, opUuid(901), 3_500_000, 100);
    const late = productsLineEdit(DEVICE_A, opUuid(902), 3_000_000, 101);

    expect(productsLimitMinor(applyJournal([...journal, early, late]))).toBe(3_000_000);
    expect(productsLimitMinor(applyJournal([...journal, late, early]))).toBe(3_000_000);
  });

  it("lets a delete beat a competing change of the same entity", () => {
    const journal = buildFixtureJournal();
    const drop = removal(DEVICE_B, opUuid(903), PRODUCTS_EXPENSE_ID, 50);
    const edit: Operation = {
      opId: opUuid(904),
      deviceId: DEVICE_C,
      lamport: 90,
      entity: "transaction",
      action: "update",
      targetId: PRODUCTS_EXPENSE_ID,
      fields: {
        kind: "expense",
        occurredOn: "2026-07-08",
        status: "posted",
        amountMinor: 9_999_900,
        accountId: MAIN_ACCOUNT_ID,
        categoryId: PRODUCTS_CATEGORY_ID,
      },
    };

    for (const order of [[drop, edit], [edit, drop]]) {
      const snapshot = applyJournal([...journal, ...order]);
      expect(snapshot.state.transactions.map((item) => item.id)).not.toContain(PRODUCTS_EXPENSE_ID);
      expect(calculateBudget(snapshot.state).categoryMetrics[PRODUCTS_CATEGORY_ID]?.expenseMinor).toBe(0);
    }
    expect(applyJournal([...journal, drop, edit])).toEqual(applyJournal([...journal, edit, drop]));
  });

  it("reaches the same state across 100 random delivery orders", () => {
    const journal = [
      ...buildFixtureJournal(),
      // Same device and same Lamport value: only the digest of the operation can decide.
      productsLineEdit(DEVICE_A, opUuid(910), 3_000_000, 100),
      productsLineEdit(DEVICE_A, opUuid(919), 3_500_000, 100),
      productsLineEdit(DEVICE_C, opUuid(912), 3_200_000, 99),
      {
        opId: opUuid(913),
        deviceId: DEVICE_B,
        lamport: 120,
        entity: "scheduledExpense",
        action: "delete",
        targetId: "79999999-9999-4999-8999-999999999994",
      },
      {
        opId: opUuid(914),
        deviceId: DEVICE_C,
        lamport: 130,
        entity: "member",
        action: "update",
        targetId: MEMBER_PETR,
        fields: { name: "Пётр Иванович", role: "member", active: true },
      },
      activation(DEVICE_B, opUuid(915), BUDGET_ID, 140),
    ] satisfies Operation[];

    const reference = applyJournal(journal);
    const random = mulberry32(20_260_802);
    let reordered = 0;
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const delivery = shuffle(journal, random);
      if (delivery.some((operation, index) => operation !== journal[index])) reordered += 1;
      expect(applyJournal(delivery)).toEqual(reference);
    }
    expect(reordered).toBe(100);
    expect(productsLimitMinor(reference)).toBe(3_500_000);
    expect(reference.state.members.map((member) => member.name)).toEqual(["Анна", "Пётр Иванович"]);
    expect(reference.state.scheduledExpenses).toHaveLength(3);
    expect(reference.lamport).toBe(140);
  });

  it("settles one entity contested across the whole range of stamps, in every delivery order", () => {
    // The fold used to keep one candidate per band of stamps — a million stamps wide — because
    // the line that settled conflicts was read off the converged journal and the fold only sees
    // a prefix of it. The line is the codec's constant again, so the fold settles a conflict the
    // moment it sees one and keeps a single entry per entity; this is what that has to be worth.
    // Stamps from a fresh clock to the absolute ceiling, contesting one budget line.
    const stamps = [
      1,
      MAX_LAMPORT_SKEW + 5,
      3 * MAX_LAMPORT_SKEW,
      MAX_HONEST_LAMPORT,
      HONEST_LAMPORT_CEILING,
      MAX_LAMPORT,
    ];
    const contested = stamps.map((lamport, index) =>
      productsLineEdit(DEVICE_A, opUuid(940 + index), 3_000_000 + index * 100_000, lamport),
    );
    const journal = [...buildFixtureJournal(), ...contested];

    // The highest stamp below the ceiling wins; the two at or above it carry no rank at all and
    // lose to every honest write, so neither the ceiling nor 2^40 takes the family's line.
    const reference = applyJournal(journal);
    expect(productsLimitMinor(reference)).toBe(3_300_000);
    expect(reference.entries.filter((entry) => entry.targetId === PRODUCTS_LINE_ID)).toHaveLength(1);

    // Every delivery order, one envelope at a time, and a restart in the middle: the server may
    // reorder, delay, duplicate and interrupt, and none of it moves the answer.
    const random = mulberry32(20_260_809);
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const delivery = shuffle(journal, random);
      expect(applyJournal(delivery)).toEqual(reference);

      let piecemeal = createEmptyJournal();
      for (const operation of delivery) piecemeal = applyOperations(piecemeal, [operation]);
      expect(piecemeal.state).toEqual(reference.state);
      expect(piecemeal.integrity).toEqual(reference.integrity);
    }

    const rebuilt = restoreJournal(JSON.parse(JSON.stringify(reference)) as unknown);
    expect(rebuilt.state).toEqual(reference.state);
    expect(rebuilt.integrity).toEqual(reference.integrity);
  });

  it("picks one active budget when two devices activate different ones", () => {
    const journal = buildFixtureJournal();
    const august = parseOperation({
      opId: opUuid(920),
      deviceId: DEVICE_A,
      lamport: 200,
      entity: "budget",
      action: "create",
      targetId: AUGUST_BUDGET_ID,
      fields: {
        startDate: "2026-08-01",
        endDate: "2026-08-31",
        status: "draft",
        plannedIncomeMinor: 18_000_000,
        warningThreshold: 0.8,
      },
    });

    // Equal Lamport values on two different budgets: only the digest tiebreaker decides, and
    // the loser must disappear from the pointer entirely rather than blend into it.
    const julyByA = activation(DEVICE_A, opUuid(921), BUDGET_ID, 300);
    const augustByB = activation(DEVICE_B, opUuid(933), AUGUST_BUDGET_ID, 300);
    const forward = applyJournal([...journal, august, julyByA, augustByB]);
    const backward = applyJournal([...journal, august, augustByB, julyByA]);
    expect(forward.state.activeBudgetId).toBe(AUGUST_BUDGET_ID);
    expect(backward.state.activeBudgetId).toBe(AUGUST_BUDGET_ID);
    expect(forward).toEqual(backward);
    expect(forward.integrity).toEqual({ ready: true, problems: [], withheld: [] });
    expect(forward.activeBudget?.opId).toBe(opUuid(933));

    // Swap which device names which budget and the winner swaps with it, so the assertion
    // above cannot be satisfied by a comparison that always prefers the same side — and, since
    // the tie is settled by a digest rather than by the identifiers, not by a comparison that
    // always prefers the same device either.
    const augustByA = activation(DEVICE_A, opUuid(933), AUGUST_BUDGET_ID, 300);
    const julyByB = activation(DEVICE_B, opUuid(921), BUDGET_ID, 300);
    const mirrored = applyJournal([...journal, august, augustByA, julyByB]);
    expect(mirrored.state.activeBudgetId).toBe(BUDGET_ID);
    expect(applyJournal([...journal, august, julyByB, augustByA])).toEqual(mirrored);

    // A higher stamp outranks the device tiebreaker even when it points at the other budget.
    const lateJuly = activation(DEVICE_A, opUuid(923), BUDGET_ID, 301);
    expect(applyJournal([...journal, august, augustByB, lateJuly]).state.activeBudgetId).toBe(BUDGET_ID);
    expect(applyJournal([...journal, august, lateJuly, augustByB]).state.activeBudgetId).toBe(BUDGET_ID);

    // The July numbers are untouched by the second budget while July stays the active one.
    expect(calculateAnnualPlan(mirrored.state, G002.startMonth, 12).currentMonth.annualReserveMinor).toBe(1_980_900);
  });

  it("keeps one deterministic tombstone when two devices delete the same entity", () => {
    const journal = buildFixtureJournal();
    // Equal stamps, so the tombstone that survives is chosen by the deviceId tiebreaker.
    const dropByA = removal(DEVICE_A, opUuid(930), PRODUCTS_EXPENSE_ID, 300);
    const dropByB = removal(DEVICE_B, opUuid(931), PRODUCTS_EXPENSE_ID, 300);

    const forward = applyJournal([...journal, dropByA, dropByB]);
    const backward = applyJournal([...journal, dropByB, dropByA]);
    expect(forward).toEqual(backward);

    const tombstone = forward.entries.find((entry) => entry.targetId === PRODUCTS_EXPENSE_ID);
    expect(tombstone?.action).toBe("delete");
    expect(tombstone?.opId).toBe(opUuid(931));
    expect(forward.state.transactions.map((item) => item.id)).not.toContain(PRODUCTS_EXPENSE_ID);
    expect(calculateBudget(forward.state).categoryMetrics[PRODUCTS_CATEGORY_ID]?.expenseMinor).toBe(0);
    // Both deletes are recorded even though only one owns the entity.
    expect(forward.appliedOpIds).toContain(opUuid(930));
    expect(forward.appliedOpIds).toContain(opUuid(931));

    // A third delete with a lower stamp arriving later never displaces the winner.
    const late = removal(DEVICE_C, opUuid(932), PRODUCTS_EXPENSE_ID, 299);
    const afterLate = applyOperations(forward, [late]);
    expect(afterLate.entries.find((entry) => entry.targetId === PRODUCTS_EXPENSE_ID)?.opId).toBe(opUuid(931));
    expect(applyJournal([...journal, late, dropByA, dropByB]).entries).toEqual(forward.entries);
  });

  it("converges when two devices reuse one opId for different content", () => {
    const journal = buildFixtureJournal();
    // Same identifier, same device, same stamp: only the digest of the operation can break the
    // tie. Skipping the second one as "already applied" would leave the two clients apart forever.
    const cheap = productsLineEdit(DEVICE_D, opUuid(946), 3_000_000, 100);
    const rich = productsLineEdit(DEVICE_D, opUuid(946), 3_500_000, 100);

    const forward = applyJournal([...journal, cheap, rich]);
    const backward = applyJournal([...journal, rich, cheap]);
    expect(forward).toEqual(backward);
    expect(productsLimitMinor(forward)).toBe(3_500_000);
    expect(productsLimitMinor(backward)).toBe(3_500_000);
    expect(forward.appliedOpIds.filter((opId) => opId === opUuid(946))).toHaveLength(1);

    // The same collision folded one operation at a time reaches the same snapshot.
    expect(applyOperations(applyOperations(applyJournal(journal), [cheap]), [rich])).toEqual(forward);
    expect(applyOperations(applyOperations(applyJournal(journal), [rich]), [cheap])).toEqual(forward);
  });

  it("splits a delivery in halves without changing the result", () => {
    const journal = buildFixtureJournal();
    const middle = Math.floor(journal.length / 2);
    const incremental = applyOperations(
      applyOperations(createEmptyJournal(), journal.slice(middle)),
      journal.slice(0, middle),
    );
    expect(incremental).toEqual(applyJournal(journal));
  });
});

describe("a stamp is a number the writer chose", () => {
  // Every tiebreaker below the stamp is a UUID, so the strongest hand one participant can
  // deal itself is the largest one there is on both of them, on top of the largest stamp the
  // codec accepts. Every scenario here was reproduced by a single envelope holding exactly
  // that, and every one of them was answered with `ready: true`.
  const DEVICE_MAX = "ffffffff-ffff-4fff-bfff-ffffffffffff";
  const opMax = (tail: string): string => `ffffffff-ffff-4fff-bfff-${tail.padStart(12, "f")}`;
  const SALARY_ID = "75555555-5555-4555-8555-555555555551";
  const HOSTILE_LINE_ID = "7aaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1";
  const PHANTOM_BUDGET_ID = "7bbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb1";

  it("does not let one envelope take the budget line a family planned", () => {
    const journal = buildFixtureJournal();
    const honest = applyJournal(journal);
    expect(productsLimitMinor(honest)).toBe(3_000_000);

    // One line, same budget and same category as the family's, planning nothing. The domain
    // allows one line per category, so one of the two has to go — and the loser used to be
    // whichever of them carried the smaller number the writer had chosen for itself.
    const hostile = parseOperation({
      opId: opMax("1"),
      deviceId: DEVICE_MAX,
      lamport: MAX_LAMPORT,
      entity: "budgetLine",
      action: "create",
      targetId: HOSTILE_LINE_ID,
      fields: { budgetId: BUDGET_ID, categoryId: PRODUCTS_CATEGORY_ID, plannedMinor: 0 },
    });

    const after = applyOperations(honest, [hostile]);
    expect(productsLimitMinor(after)).toBe(3_000_000);
    expect(after.state.budgets[0]?.lines.map((line) => line.id)).toContain(PRODUCTS_LINE_ID);
    expect(after.integrity.problems).toContainEqual({
      code: "duplicate_budget_line",
      entity: "budgetLine",
      id: HOSTILE_LINE_ID,
    });
    // Resolved, not frozen: the loser is out of the state and no later delivery revives it.
    expect(after.integrity.ready).toBe(true);
    expect(applyJournal([hostile, ...journal])).toEqual(after);

    // The family goes on editing its own line, and the honest edit lands.
    const edited = applyOperations(after, [productsLineEdit(DEVICE_B, opUuid(100), 3_500_000, 100)]);
    expect(productsLimitMinor(edited)).toBe(3_500_000);
  });

  it("does not let one envelope take a salary out of the state through an identifier collision", () => {
    const journal = buildFixtureJournal();
    const honest = applyJournal(journal);
    const salary = honest.state.transactions.find((transaction) => transaction.id === SALARY_ID);
    expect(salary?.amountMinor).toBe(18_000_000);

    // An identifier belongs to one entity kind for good, so claiming the identifier of the
    // family's salary for a category of one's own used to take the salary with it.
    const hostile = parseOperation({
      opId: opMax("2"),
      deviceId: DEVICE_MAX,
      lamport: MAX_LAMPORT,
      entity: "category",
      action: "create",
      targetId: SALARY_ID,
      fields: SAMPLE_FIELDS.category,
    });

    const after = applyOperations(honest, [hostile]);
    expect(after.state.transactions.find((transaction) => transaction.id === SALARY_ID)?.amountMinor).toBe(
      18_000_000,
    );
    expect(after.state.categories.some((category) => category.id === SALARY_ID)).toBe(false);
    expect(after.integrity.problems).toContainEqual({
      code: "identifier_claimed_twice",
      entity: "category",
      id: SALARY_ID,
    });
    expect(after.integrity.ready).toBe(true);
    expect(applyJournal([hostile, ...journal])).toEqual(after);
    // The canonical July numbers are untouched, which is the whole point of keeping the salary.
    const plan = calculateAnnualPlan(after.state, G002.startMonth, 12);
    expect(plan.currentMonth.annualReserveMinor).toBe(1_980_900);
    expect(plan.currentMonth.spendableAfterPlanMinor).toBe(4_419_100);
  });

  it("does not let one envelope rewrite the family's account", () => {
    const journal = buildFixtureJournal();
    const honest = applyJournal(journal);
    const before = honest.state.accounts.find((account) => account.id === MAIN_ACCOUNT_ID);
    expect(before?.openingBalanceMinor).toBe(0);

    // Last-write-wins per entity, and "last" was decided by the stamp, so this used to be the
    // family's main account from then on — with nothing at all in the problems to say so.
    const hostile = parseOperation({
      opId: opMax("3"),
      deviceId: DEVICE_MAX,
      lamport: MAX_LAMPORT,
      entity: "account",
      action: "update",
      targetId: MAIN_ACCOUNT_ID,
      fields: {
        name: "Основной",
        type: "current",
        currency: "RUB",
        openingBalanceMinor: MAX_MONEY_MINOR,
        active: true,
      },
    });

    const after = applyOperations(honest, [hostile]);
    expect(after.state.accounts.find((account) => account.id === MAIN_ACCOUNT_ID)).toEqual(before);
    // The stamp carries no rank, so the operation loses the entity it reached for and the
    // journal keeps the write the family made — one entry per entity, the loser of the total
    // order left behind like any other loser, in either delivery order.
    expect(after.entries.some((entry) => entry.opId === hostile.opId)).toBe(false);
    expect(after.integrity).toEqual({ ready: true, problems: [], withheld: [] });
    expect(applyJournal([hostile, ...journal])).toEqual(after);
    const plan = calculateAnnualPlan(after.state, G002.startMonth, 12);
    expect(plan.currentMonth.annualReserveMinor).toBe(1_980_900);
    expect(plan.currentMonth.spendableAfterPlanMinor).toBe(4_419_100);
  });

  it("does not let one activation of nothing freeze the family, restart included", () => {
    const journal = buildFixtureJournal();
    const honest = applyJournal(journal);
    expect(honest.state.activeBudgetId).toBe(BUDGET_ID);

    // The pointer used to be a register of its own, with no delete and nothing above the
    // ceiling to answer with: one activation of a budget that had never existed took it for
    // good, on every device, across every restart.
    const hostile = parseOperation({
      opId: opMax("4"),
      deviceId: DEVICE_MAX,
      lamport: MAX_LAMPORT,
      entity: "budget",
      action: "activate",
      targetId: PHANTOM_BUDGET_ID,
    });

    const after = applyOperations(honest, [hostile]);
    expect(after.state.activeBudgetId).toBe(BUDGET_ID);
    expect(after.activeBudget?.targetId).toBe(BUDGET_ID);
    // The activation is kept — the register is a function of the converged set — so the device
    // that wrote it is named, and the pointer nobody can see is listed as withheld. The family
    // sees its own budget all the same: the snapshot is ready.
    expect(after.integrity).toEqual({
      ready: true,
      problems: [{ code: "implausible_lamport", entity: null, id: DEVICE_MAX }],
      withheld: [{ entity: "budget", id: PHANTOM_BUDGET_ID, reason: "unknown_active_budget" }],
    });
    expect(applyJournal([hostile, ...journal])).toEqual(after);
    expect(calculateAnnualPlan(after.state, G002.startMonth, 12).currentMonth.annualReserveMinor).toBe(
      1_980_900,
    );

    // And it does not come back after a restart. The whole register is carried through the
    // restore, so the losing activation is still there and still loses.
    const rebuilt = restoreJournal(JSON.parse(JSON.stringify(after)) as unknown);
    expect(rebuilt.state.activeBudgetId).toBe(BUDGET_ID);
    expect(rebuilt.integrity).toEqual(after.integrity);
    expect(rebuilt.activations.map((entry) => entry.targetId).sort()).toEqual(
      [BUDGET_ID, PHANTOM_BUDGET_ID].sort(),
    );

    // A budget that genuinely has not been delivered yet is the honest case the verdict is
    // for, and it still says the delivery is incomplete rather than calling the state ready.
    const alone = applyJournal([hostile]);
    expect(alone.activeBudget?.targetId).toBe(PHANTOM_BUDGET_ID);
    expect(alone.integrity.problems).toContainEqual({
      code: "unknown_active_budget",
      entity: "budget",
      id: PHANTOM_BUDGET_ID,
    });
    expect(alone.integrity.ready).toBe(false);
  });

  it("hands the pointer back to a living budget when the active one is deleted", () => {
    // Keeping the whole register rather than the winner alone is what makes this the same on
    // a device that restarted and on one that did not.
    const journal = buildFixtureJournal();
    const august = parseOperation({
      opId: opUuid(940),
      deviceId: DEVICE_A,
      lamport: 200,
      entity: "budget",
      action: "create",
      targetId: AUGUST_BUDGET_ID,
      fields: {
        startDate: "2026-08-01",
        endDate: "2026-08-31",
        status: "draft",
        plannedIncomeMinor: 18_000_000,
        warningThreshold: 0.8,
      },
    });
    const augustActive = activation(DEVICE_A, opUuid(941), AUGUST_BUDGET_ID, 300);
    const opened = applyJournal([...journal, august, augustActive]);
    expect(opened.state.activeBudgetId).toBe(AUGUST_BUDGET_ID);

    const drop: Operation = {
      opId: opUuid(942),
      deviceId: DEVICE_A,
      lamport: 400,
      entity: "budget",
      action: "delete",
      targetId: AUGUST_BUDGET_ID,
    };
    const after = applyOperations(opened, [drop]);
    expect(after.state.activeBudgetId).toBe(BUDGET_ID);
    const restarted = restoreJournal(JSON.parse(JSON.stringify(after)) as unknown);
    expect(restarted.state.activeBudgetId).toBe(BUDGET_ID);
    expect(restarted.state).toEqual(after.state);
  });
});

describe("tombstones", () => {
  it("applies a delete that arrives before the create it ends, one envelope at a time", () => {
    // The server decides the order it hands envelopes over in. A delete that was dropped
    // because its create had not arrived yet left one device with the entity and the other
    // without it, for good, and silently: the identifier of the dropped delete still counted
    // as applied, so both checkpoints agreed while the two families differed.
    const journal = buildFixtureJournal();
    const base = applyJournal(journal);
    const create = ghostExpense(opUuid(950), 399);
    const drop = removal(DEVICE_B, opUuid(951), GHOST_ID, 400);

    const deleteFirst = applyOperations(applyOperations(base, [drop]), [create]);
    const createFirst = applyOperations(applyOperations(base, [create]), [drop]);
    expect(deleteFirst).toEqual(createFirst);
    expect(deleteFirst.entries.find((entry) => entry.targetId === GHOST_ID)?.action).toBe("delete");
    expect(deleteFirst.state.transactions.map((item) => item.id)).not.toContain(GHOST_ID);
    expect(deleteFirst.integrity).toEqual({ ready: true, problems: [], withheld: [] });

    // The same two envelopes in one batch, and the whole journal replayed around them,
    // reach the same snapshot as either single-envelope order.
    expect(applyJournal([...journal, drop, create])).toEqual(deleteFirst);
    expect(applyJournal([...journal, create, drop])).toEqual(deleteFirst);

    // And a delete of an entity nobody ever created is kept as a tombstone, so the create
    // that turns up later cannot revive it on one device and not on another.
    const alone = applyOperations(base, [drop]);
    expect(alone.entries.find((entry) => entry.targetId === GHOST_ID)?.opId).toBe(opUuid(951));
    expect(applyOperations(alone, [create])).toEqual(deleteFirst);
  });

  it("delivers a whole journal one envelope at a time in reverse without changing the result", () => {
    const journal = [...buildFixtureJournal(), removal(DEVICE_B, opUuid(952), PRODUCTS_EXPENSE_ID, 500)];
    let streamed = createEmptyJournal();
    for (const operation of [...journal].reverse()) streamed = applyOperations(streamed, [operation]);
    expect(streamed).toEqual(applyJournal(journal));
  });

  it("reports an author that owns more tombstones than any honest history explains", () => {
    const flood = (count: number, deviceId = DEVICE_B, seed = 20_000): Operation[] =>
      Array.from({ length: count }, (_unused, index) =>
        parseOperation({
          opId: opUuid(seed + index),
          deviceId,
          lamport: 1 + index,
          entity: "transaction",
          action: "delete",
          targetId: `minted-${deviceId}-${String(index).padStart(6, "0")}`,
        }),
      );

    const budgeted = applyJournal(flood(MAX_TOMBSTONES_PER_DEVICE));
    expect(budgeted.integrity.problems.some((value) => value.code === "tombstone_budget")).toBe(false);

    // An author the family has nothing to show for is counted in the shared bucket, under the
    // empty identifier: a device that only ever buried things is indistinguishable from an
    // identity minted for the purpose, and telling them apart by the identifier the operation
    // carries is what let one flood reset the count on every five thousandth delete.
    const over = applyJournal(flood(MAX_TOMBSTONES_PER_DEVICE + 1));
    expect(over.integrity.problems).toContainEqual({ code: "tombstone_budget", entity: null, id: "" });
    // Advisory only: nothing was withheld, so a family that deleted a great deal still sees
    // its budget instead of freezing on the last snapshot that was ready.
    expect(over.entries).toHaveLength(MAX_TOMBSTONES_PER_DEVICE + 1);
    expect(over.integrity.problems.filter((value) => value.code !== "tombstone_budget")).toEqual([
      { code: "no_active_budget", entity: "budget", id: "" },
    ]);

    // A device the family does have something to show for is named on its own, and its own
    // budget is its own: the shared bucket is for authors with no surviving writes at all.
    const known = applyJournal([
      ...buildFixtureJournal(),
      ...flood(MAX_TOMBSTONES_PER_DEVICE + 1, DEVICE_A, 40_000),
    ]);
    expect(known.integrity.problems).toContainEqual({
      code: "tombstone_budget",
      entity: null,
      id: DEVICE_A,
    });
    expect(known.integrity.ready).toBe(true);
    expect(calculateAnnualPlan(known.state, G002.startMonth, 12).currentMonth.annualReserveMinor).toBe(
      1_980_900,
    );
  });

  it("does not let a fresh identity per delete zero the tombstone budget", () => {
    // The budget used to be counted strictly per deviceId, and deviceId is a field of the
    // operation: the codec checks it has the shape of a UUID, and SYNC_ARCHITECTURE forbids the
    // server to compare it with the device that uploaded the envelope, because that comparison
    // would break key rotation. So a peer drew itself a new identity for every delete and the
    // one report that says a family is being emptied never fired at all.
    const flood = Array.from({ length: MAX_TOMBSTONES_PER_DEVICE + 1 }, (_unused, index) =>
      parseOperation({
        opId: opUuid(80_000 + index),
        deviceId: mintedDevice(index),
        lamport: 1 + index,
        entity: "transaction",
        action: "delete",
        targetId: `minted-${String(index).padStart(6, "0")}`,
      }),
    );

    const snapshot = applyJournal([...buildFixtureJournal(), ...flood]);
    expect(new Set(flood.map((operation) => operation.deviceId)).size).toBe(flood.length);
    expect(snapshot.integrity.problems).toContainEqual({ code: "tombstone_budget", entity: null, id: "" });
    // Advisory, so the family still sees every kopeck of its own budget while it looks.
    expect(snapshot.integrity.ready).toBe(true);
    expect(calculateAnnualPlan(snapshot.state, G002.startMonth, 12).currentMonth.annualReserveMinor).toBe(
      1_980_900,
    );
  }, 60_000);

  it("does not let a forged snapshot of nothing but tombstones pass unremarked", () => {
    // The old rule refused a tombstone for an unknown entity, and restoreJournal counted the
    // deletes themselves as the entities it knew, so a snapshot of pure tombstones minted
    // them all. They are kept now, and the budget is what answers a minting peer.
    const entries = Array.from({ length: MAX_TOMBSTONES_PER_DEVICE + 1 }, (_unused, index) => ({
      opId: opUuid(30_000 + index),
      deviceId: DEVICE_C,
      lamport: 1 + index,
      entity: "transaction",
      action: "delete",
      targetId: `forged-${String(index).padStart(6, "0")}`,
    }));

    const restored = restoreJournal({ entries, activeBudget: null });
    expect(restored.state.transactions).toEqual([]);
    expect(restored.integrity.problems).toContainEqual({ code: "tombstone_budget", entity: null, id: "" });
    expect(restored.entries).toHaveLength(MAX_TOMBSTONES_PER_DEVICE + 1);
  });
});

describe("integrity gate", () => {
  it("keeps 901 amounts at the money ceiling inside the safe integer range", () => {
    // 901 amounts at the previous ceiling of 10^13 add up to 9.01·10^15, past
    // Number.MAX_SAFE_INTEGER, and every device in the family lost every calculation while
    // the gate reported ready. The same 901 operations must now be ordinary traffic.
    expect(10 ** 13 * 901).toBeGreaterThan(Number.MAX_SAFE_INTEGER);
    expect(MAX_MONEY_MINOR * 901).toBeLessThan(Number.MAX_SAFE_INTEGER);

    const snapshot = applyJournal(moneyJournal(901, MAX_MONEY_MINOR));
    expect(snapshot.integrity).toEqual({ ready: true, problems: [], withheld: [] });
    expect(snapshot.state.transactions).toHaveLength(901);

    const metrics = calculateBudget(snapshot.state);
    expect(metrics.grossExpensesMinor).toBe(901 * MAX_MONEY_MINOR);
    expect(metrics.capitalMinor).toBe(-901 * MAX_MONEY_MINOR);
    expect(Number.isSafeInteger(metrics.grossExpensesMinor)).toBe(true);
    expect(() => calculateAnnualPlan(snapshot.state, "2026-07", 12)).not.toThrow();
  });

  it("reports a total past the aggregate ceiling without taking a single entity away", () => {
    // A field ceiling cannot bound a sum, so the gate adds the same totals the domain adds —
    // and then says so, rather than deciding whose records go. The state stays complete, so it
    // stays ready, and the domain still adds every one of these amounts up exactly.
    const count = MAX_AGGREGATE_MINOR / MAX_MONEY_MINOR + 1;
    const snapshot = applyJournal(moneyJournal(count, MAX_MONEY_MINOR));

    expect(snapshot.state.transactions).toHaveLength(count);
    expect(snapshot.integrity.problems).toContainEqual({
      code: "amount_out_of_range",
      entity: null,
      id: "",
    });
    // No victim is named because there is no victim: the code carries no entity and no id.
    const reported = snapshot.integrity.problems.filter((value) => value.code === "amount_out_of_range");
    expect(reported).toHaveLength(1);
    expect(calculateBudget(snapshot.state).grossExpensesMinor).toBe(count * MAX_MONEY_MINOR);
    expect(snapshot.integrity.ready).toBe(true);
  });

  it("does not let amounts written one kopeck apart choose whose records disappear", () => {
    // The seventh lever, and the last eviction in this package. The rule used to give up the
    // largest `amountMinor` until a total fitted, on the grounds that a size is a measure with a
    // meaning of its own rather than a name somebody picked. It is a name somebody picked: the
    // amount is a field of the operation. A peer that writes its own amounts one kopeck below
    // the family's salary sends the salary to the head of the queue, and the family's real
    // income was the first thing to leave the state — in every delivery order, permanently, with
    // `ready: false` on top of it. Both directions are tried, so no ordering passes by luck.
    for (const [gap, seed] of [
      [-1, 11],
      [1, 12],
    ] as const) {
      const salaryMinor = MAX_MONEY_MINOR - 1;
      const salaries = Array.from({ length: 12 }, (_unused, index) =>
        parseOperation({
          opId: opUuid(50_000 + index),
          deviceId: DEVICE_A,
          lamport: 10 + index,
          entity: "transaction",
          action: "create",
          targetId: `salary-${String(index).padStart(4, "0")}`,
          fields: {
            kind: "income",
            occurredOn: "2026-07-05",
            status: "posted",
            amountMinor: salaryMinor,
            accountId: SEED_ACCOUNT_ID,
          },
        }),
      );
      const hostileCount = MAX_AGGREGATE_MINOR / MAX_MONEY_MINOR;
      const hostile = Array.from({ length: hostileCount }, (_unused, index) =>
        parseOperation({
          opId: opUuid(60_000 + index),
          deviceId: DEVICE_B,
          lamport: 1_000 + index,
          entity: "transaction",
          action: "create",
          targetId: `hostile-${String(index).padStart(6, "0")}`,
          fields: {
            kind: "income",
            occurredOn: "2026-07-05",
            status: "posted",
            amountMinor: salaryMinor + gap,
            accountId: SEED_ACCOUNT_ID,
          },
        }),
      );

      const journal = [...moneyJournal(0, 0), ...salaries, ...hostile];
      const snapshot = applyJournal(journal);
      const shown = snapshot.state.transactions.map((item) => item.id);

      // Every salary is in the state, and so is every hostile income: the total is over the
      // ceiling and the gate says so instead of picking somebody's records.
      expect(shown.filter((id) => id.startsWith("salary-"))).toHaveLength(salaries.length);
      expect(shown.filter((id) => id.startsWith("hostile-"))).toHaveLength(hostileCount);
      expect(snapshot.integrity.problems).toContainEqual({
        code: "amount_out_of_range",
        entity: null,
        id: "",
      });
      // Nothing of the family's is missing, so the family goes on seeing its budget.
      expect(snapshot.integrity.ready).toBe(true);
      expect(calculateBudget(snapshot.state).incomeMinor).toBe(
        salaries.length * salaryMinor + hostileCount * (salaryMinor + gap),
      );

      // And the same set delivered in another order answers the same way.
      const shuffled = applyJournal(shuffle(journal, mulberry32(seed)));
      expect(shuffled.state.transactions.map((item) => item.id)).toEqual(shown);
      expect(shuffled.integrity).toEqual(snapshot.integrity);
    }
  });

  it("measures a journal whose amounts pass the safe integer range without ever leaving it", () => {
    // What the entry budget was really holding up, and the reason removing its enforcement was
    // not free. The old argument ran: at most MAX_JOURNAL_ENTRIES entities, at most three
    // amounts each, at most MAX_MONEY_MINOR per amount — so no total the gate builds can leave
    // the safe integer range. The budget stopped withholding anything in the sixth round and the
    // argument went with it: nothing bounds how many amounts a journal holds any more.
    //
    // So the accumulators carry the bound themselves. This flood is past the point where the
    // plain sum of its amounts stops being a safe integer — the exact case the count used to
    // rule out — and the merge still answers, without throwing and without losing an entity.
    const count = 950_000;
    const amountAt = (index: number): number => MAX_MONEY_MINOR - index;
    const plainSum = count * MAX_MONEY_MINOR - ((count - 1) * count) / 2;
    expect(plainSum).toBeGreaterThan(Number.MAX_SAFE_INTEGER);
    expect(count).toBeGreaterThan(MAX_JOURNAL_ENTRIES);

    const flood: Operation[] = Array.from({ length: count }, (_unused, index) => ({
      opId: opUuid(200_000 + index),
      deviceId: DEVICE_B,
      lamport: 100 + index,
      entity: "transaction",
      action: "create",
      targetId: `flood-${String(index).padStart(7, "0")}`,
      fields: {
        ...SAMPLE_FIELDS.transaction,
        amountMinor: amountAt(index),
        accountId: SEED_ACCOUNT_ID,
        categoryId: SEED_CATEGORY_ID,
      },
    }));

    let snapshot = applyJournal(moneyJournal(0, 0));
    for (let start = 0; start < flood.length; start += MAX_BATCH_OPERATIONS) {
      snapshot = applyOperations(snapshot, flood.slice(start, start + MAX_BATCH_OPERATIONS));
    }

    // The consumer of the protocol is not dropped by amounts it never wrote: every read answers,
    // the entries are all there, and the report says the totals are past the ceiling.
    expect(() => snapshot.state).not.toThrow();
    expect(() => snapshot.integrity).not.toThrow();
    expect(() => snapshot.entries).not.toThrow();
    expect(snapshot.entries.length).toBeGreaterThan(MAX_JOURNAL_ENTRIES);
    expect(snapshot.state.transactions).toHaveLength(count);
    expect(snapshot.integrity.problems).toContainEqual({ code: "journal_entry_budget", entity: null, id: "" });
    expect(snapshot.integrity.problems).toContainEqual({ code: "amount_out_of_range", entity: null, id: "" });
    // Nothing is missing from the state, so nothing waits for a delivery that will never come.
    expect(snapshot.integrity.ready).toBe(true);

    // The other half of the invariant is the consumer's own: the domain refuses a total it
    // cannot add rather than answering with a number that is not the sum of anything.
    expect(() => calculateBudget(snapshot.state)).toThrow();

    // And below the point where the domain refuses, a journal past the aggregate ceiling is
    // still added up exactly — the report is a report, never a reason to hide a family's money.
    const modest = applyJournal(moneyJournal(2_000, MAX_MONEY_MINOR));
    expect(modest.state.transactions).toHaveLength(2_000);
    expect(modest.integrity.problems).toContainEqual({ code: "amount_out_of_range", entity: null, id: "" });
    expect(modest.integrity.ready).toBe(true);
    const metrics = calculateBudget(modest.state);
    expect(metrics.grossExpensesMinor).toBe(2_000 * MAX_MONEY_MINOR);
    expect(Number.isSafeInteger(metrics.grossExpensesMinor)).toBe(true);
    expect(metrics.grossExpensesMinor).toBeGreaterThan(MAX_AGGREGATE_MINOR);
    expect(() => calculateAnnualPlan(modest.state, "2026-07", 12)).not.toThrow();
  }, 300_000);

  it("resolves an identifier claimed by two entity kinds instead of switching the family off", () => {
    const journal = buildFixtureJournal();
    const shared = "identifier-claimed-twice";
    const claim = (entity: "account" | "category", opId: string, lamport: number): Operation =>
      parseOperation({
        opId,
        deviceId: DEVICE_A,
        lamport,
        entity,
        action: "create",
        targetId: shared,
        fields: SAMPLE_FIELDS[entity],
      });

    const account = claim("account", opUuid(960), 500);
    const category = claim("category", opUuid(961), 501);
    const snapshot = applyJournal([...journal, account, category]);

    // The total order that decides every other conflict decides this one: the higher stamp
    // stays, only the loser is withheld, and one hostile envelope no longer costs the family
    // every later operation by holding the whole snapshot at ready: false.
    expect(snapshot.state.categories.map((item) => item.id)).toContain(shared);
    expect(snapshot.state.accounts.map((item) => item.id)).not.toContain(shared);
    expect(snapshot.integrity.problems).toContainEqual({
      code: "identifier_claimed_twice",
      entity: "account",
      id: shared,
    });
    expect(snapshot.integrity.ready).toBe(true);

    // The winner swaps with the stamps, so the assertion above cannot be satisfied by a
    // comparison that always prefers the same kind.
    const mirrored = applyJournal([...journal, claim("account", opUuid(960), 502), category]);
    expect(mirrored.state.accounts.map((item) => item.id)).toContain(shared);
    expect(mirrored.state.categories.map((item) => item.id)).not.toContain(shared);

    // Both writes stay in the journal, the export still holds one flat set of identifiers,
    // and everything that did not collide is untouched.
    expect(snapshot.entries.filter((entry) => entry.targetId === shared)).toHaveLength(2);
    const ids = allStateIds(snapshot.state);
    expect(new Set(ids).size).toBe(ids.length);
    expect(calculateAnnualPlan(snapshot.state, G002.startMonth, 12).currentMonth.annualReserveMinor).toBe(1_980_900);
    expect(applyJournal([...journal, category, account])).toEqual(snapshot);
  });

  it("shows every entry past the entry budget, in either order of the batches", () => {
    // The budget used to be counted inside the loop over the incoming operations and threw, so
    // which entities a device ended up with depended on the order the server chose to deliver
    // in: two devices given the same operations in a different order showed the family two
    // different budgets, and both called the snapshot ready with an empty problem list. Then it
    // was enforced on the converged journal instead, which fixed the divergence and left the
    // eviction — and every dimension to evict by is written by the peer being evicted.
    const overflow = 3;
    const operations = Array.from({ length: MAX_JOURNAL_ENTRIES + overflow }, (_unused, index) =>
      parseOperation({
        opId: opUuid(200_000 + index),
        deviceId: DEVICE_A,
        lamport: 1 + index,
        entity: "member",
        action: "create",
        targetId: `member-${String(index).padStart(7, "0")}`,
        fields: SAMPLE_FIELDS.member,
      }),
    );
    const half = Math.floor(operations.length / 2);
    const head = operations.slice(0, half);
    const tail = operations.slice(half);

    const forward = applyOperations(applyOperations(createEmptyJournal(), head), tail);
    const backward = applyOperations(applyOperations(createEmptyJournal(), tail), head);

    // The journal keeps everything and so does the state: nothing is evicted for a count any
    // more, so there is nothing for a delivery order to disagree about.
    expect(forward.entries).toHaveLength(operations.length);
    expect(forward.state.members).toHaveLength(operations.length);
    expect(backward.state.members.map((member) => member.id)).toEqual(
      forward.state.members.map((member) => member.id),
    );
    const shown = new Set(forward.state.members.map((member) => member.id));
    expect(operations.every((operation) => shown.has(operation.targetId))).toBe(true);
    expect(overflow).toBeGreaterThan(0);

    // Crossing the budget is said out loud, once for the journal rather than once per author:
    // naming an author would put a string of the flooder's choosing in the report for no
    // purpose, because nothing follows from it. It does not lower the verdict on its own —
    // this journal holds no budget at all, and that is what does.
    // A hundred thousand participants are also more than a document may hold, and that is said
    // against the kind, again without withholding anybody.
    expect(forward.integrity.problems).toEqual([
      { code: "collection_limit", entity: "member", id: "" },
      { code: "journal_entry_budget", entity: null, id: "" },
      { code: "no_active_budget", entity: "budget", id: "" },
    ]);
    expect(backward.integrity).toEqual(forward.integrity);

    // And a restore accepts the journal the fold built. It used to refuse anything past the
    // budget plus one batch quota, which is a ceiling below what the fold produces: a device
    // that folded envelope after envelope wrote a snapshot it could never read again.
    const rebuilt = restoreJournal(JSON.parse(JSON.stringify(forward)) as unknown);
    expect(rebuilt.entries).toHaveLength(operations.length);
    expect(rebuilt.state.members.map((member) => member.id)).toEqual(
      forward.state.members.map((member) => member.id),
    );
    expect(rebuilt.integrity).toEqual(forward.integrity);
  }, 120_000);

  it("keeps every entity a family owns while one peer floods the journal from a new identity per entry", () => {
    // The sixth round of review, reproduced. The entry budget was enforced with a dimension per
    // device so that a flooder would evict its own entries and nobody else's — and the dimension
    // was `deviceId`, a field of the operation. The codec checks it has the shape of a UUID; the
    // sync architecture forbids the server to compare it with the device that uploaded the
    // envelope, because that comparison breaks key rotation. So the peer wrote a fresh identity
    // on every entry, the per-device budget was a shared budget again, and the family lost every
    // account, every category, the budget and all five hundred of its transactions out of the
    // state — in both delivery orders, and permanently, because the journal never shrinks.
    const journal = buildFixtureJournal();
    const honest = Array.from({ length: 40 }, (_unused, index) =>
      parseOperation({
        opId: opUuid(300_000 + index),
        deviceId: DEVICE_B,
        lamport: 1 + index,
        entity: "member",
        action: "create",
        targetId: `honest-${String(index).padStart(7, "0")}`,
        fields: SAMPLE_FIELDS.member,
      }),
    );
    // Five hundred transactions of the family's own, counting the four the fixture carries: this
    // is the history the flood used to take away. A rouble each keeps every total the gate adds
    // up far inside its ceiling, so nothing but the flood is under test here.
    const spending = Array.from({ length: 496 }, (_unused, index) =>
      parseOperation({
        opId: opUuid(400_000 + index),
        deviceId: DEVICE_B,
        lamport: 41 + index,
        memberId: MEMBER_PETR,
        entity: "transaction",
        action: "create",
        targetId: `spend-${String(index).padStart(7, "0")}`,
        fields: {
          kind: "expense",
          occurredOn: "2026-07-11",
          status: "posted",
          amountMinor: 100,
          accountId: MAIN_ACCOUNT_ID,
          categoryId: PRODUCTS_CATEGORY_ID,
        },
      }),
    );
    const family = [...journal, ...honest, ...spending];
    // A new identity on every single entry, and stamped far above every honest write for good
    // measure: neither buys anything at all.
    const flood = Array.from({ length: MAX_JOURNAL_ENTRIES + 1 }, (_unused, index) =>
      parseOperation({
        opId: opUuid(500_000 + index),
        deviceId: mintedDevice(index),
        lamport: MAX_LAMPORT_SKEW + index,
        entity: "member",
        action: "create",
        targetId: `flood-${String(index).padStart(7, "0")}`,
        fields: SAMPLE_FIELDS.member,
      }),
    );
    expect(new Set(flood.map((operation) => operation.deviceId)).size).toBe(flood.length);

    // Folded in several deliveries, because one batch may not exceed the epoch quota — which is
    // also how a device gets a journal larger than any single batch in the first place.
    const half = Math.floor(flood.length / 2);
    const flooded = applyOperations(
      applyOperations(applyJournal(family), flood.slice(0, half)),
      flood.slice(half),
    );
    const shown = new Set(flooded.state.members.map((member) => member.id));
    expect(honest.every((operation) => shown.has(operation.targetId))).toBe(true);
    expect(flood.every((operation) => shown.has(operation.targetId))).toBe(true);
    expect(flooded.state.members.map((member) => member.name)).toContain("Анна");

    // Everything the family owns is still in the state, down to the last transaction, and the
    // verdict is still ready: a journal larger than any family fills is worth saying out loud
    // and is not worth throwing anybody's data away for.
    const untouched = applyJournal(family);
    expect([...allStateIds(flooded.state)].sort()).toEqual(
      [...allStateIds(untouched.state), ...flood.map((operation) => operation.targetId)].sort(),
    );
    expect(flooded.state.transactions).toHaveLength(untouched.state.transactions.length);
    expect(flooded.state.transactions).toHaveLength(500);
    expect(flooded.state.activeBudgetId).toBe(BUDGET_ID);
    expect(flooded.integrity).toEqual({
      ready: true,
      problems: [
        // More participants than a document may hold, said against the kind and nothing more.
        { code: "collection_limit", entity: "member", id: "" },
        { code: "journal_entry_budget", entity: null, id: "" },
      ],
      // Nothing is withheld for a flood: every entity of the family is on the screen.
      withheld: [],
    });
    const plan = calculateAnnualPlan(flooded.state, G002.startMonth, 12);
    expect(plan.currentMonth.annualReserveMinor).toBe(1_980_900);
    expect(plan.currentMonth.spendableAfterPlanMinor).toBe(4_419_100);
    expect(productsLimitMinor(flooded)).toBe(productsLimitMinor(untouched));
    // Same set whichever order the deliveries arrive in, and the same set after a restart.
    const reversed = applyOperations(
      applyOperations(applyJournal(flood.slice(half)), flood.slice(0, half)),
      [...spending, ...honest, ...journal],
    );
    expect(reversed.state.members.map((member) => member.id)).toEqual(
      flooded.state.members.map((member) => member.id),
    );
    expect(reversed.integrity).toEqual(flooded.integrity);
    const rebuilt = restoreJournal(JSON.parse(JSON.stringify(flooded)) as unknown);
    expect(rebuilt.integrity).toEqual(flooded.integrity);
    expect(rebuilt.state.transactions).toHaveLength(untouched.state.transactions.length);
  }, 120_000);

  it("does not freeze the family on a conflict the merge has already resolved", () => {
    // A refund dated before the expense it refunds, and a goal contribution that lands on an
    // account the goal is not linked to. The second is reachable by honest concurrent editing
    // — one device moves the goal to another account while a contribution is in flight — and
    // both used to hold every device in the family on its last snapshot for good.
    const journal = buildFixtureJournal();
    const earlyRefund = parseOperation({
      opId: opUuid(975),
      deviceId: DEVICE_B,
      lamport: 610,
      entity: "transaction",
      action: "create",
      targetId: "refund-before-the-expense",
      fields: {
        kind: "refund",
        occurredOn: "2026-07-01",
        status: "posted",
        amountMinor: 100_000,
        accountId: MAIN_ACCOUNT_ID,
        categoryId: PRODUCTS_CATEGORY_ID,
        originalTransactionId: PRODUCTS_EXPENSE_ID,
      },
    });
    const strayContribution = parseOperation({
      opId: opUuid(976),
      deviceId: DEVICE_B,
      lamport: 611,
      entity: "transaction",
      action: "create",
      targetId: "contribution-to-the-wrong-account",
      fields: {
        kind: "goal_contribution",
        occurredOn: "2026-07-11",
        status: "posted",
        amountMinor: 100_000,
        fromAccountId: RESERVE_ACCOUNT_ID,
        toAccountId: MAIN_ACCOUNT_ID,
        goalId: GOAL_ID,
      },
    });

    const snapshot = applyJournal([...journal, earlyRefund, strayContribution]);
    expect(snapshot.integrity.problems).toEqual([
      { code: "goal_account_mismatch", entity: "transaction", id: "contribution-to-the-wrong-account" },
      { code: "invalid_refund", entity: "transaction", id: "refund-before-the-expense" },
    ]);
    // Both entities are out of the state, so what is left is exactly what the family had and
    // is safe for the domain. Waiting for more operations cannot change either verdict, and a
    // consumer that froze on them would hand one envelope the power to stop the family.
    expect(snapshot.state.transactions.map((item) => item.id)).toEqual(
      applyJournal(journal).state.transactions.map((item) => item.id),
    );
    expect(snapshot.integrity.ready).toBe(true);
    // Ready is not "everything is in order": both transactions are listed as withheld, with the
    // kind, the identifier and the reason an interface has to put on the screen.
    expect(snapshot.integrity.withheld).toEqual([
      {
        entity: "transaction",
        id: "contribution-to-the-wrong-account",
        reason: "goal_account_mismatch",
      },
      { entity: "transaction", id: "refund-before-the-expense", reason: "invalid_refund" },
    ]);
    expect(calculateAnnualPlan(snapshot.state, G002.startMonth, 12).currentMonth.annualReserveMinor).toBe(1_980_900);

    // A reference that has simply not arrived is the other kind, and it is withheld the same
    // way. It is not a reason to hide the rest of the budget either: the state is renderable,
    // so the snapshot is ready, and the missing transaction comes back by itself when the
    // expense it refunds is delivered.
    const refundOfNothing = parseOperation({
      opId: opUuid(977),
      deviceId: DEVICE_B,
      lamport: 612,
      entity: "transaction",
      action: "create",
      targetId: "refund-of-an-expense-not-yet-delivered",
      fields: {
        kind: "refund",
        occurredOn: "2026-07-20",
        status: "posted",
        amountMinor: 100_000,
        accountId: MAIN_ACCOUNT_ID,
        categoryId: PRODUCTS_CATEGORY_ID,
        originalTransactionId: "expense-still-in-flight",
      },
    });
    const waiting = applyJournal([...journal, refundOfNothing]);
    expect(waiting.integrity.ready).toBe(true);
    expect(waiting.integrity.withheld).toEqual([
      {
        entity: "transaction",
        id: "refund-of-an-expense-not-yet-delivered",
        reason: "unknown_reference",
      },
    ]);
  });

  it("carries a participant on a transaction across devices, and never lets the label cost the money", () => {
    const journal = buildFixtureJournal();
    const attributed = (snapshot: JournalSnapshot): Transaction | undefined =>
      snapshot.state.transactions.find((item) => item.id === LABELLED_EXPENSE_ID);

    // Written down by Анна, spent by Пётр. The two identifiers answer different questions and
    // travel separately, and both have to survive a merge for the family to see whose spending
    // this was on any device but the one it was typed on.
    const labelled = parseOperation({
      opId: opUuid(981),
      deviceId: DEVICE_B,
      lamport: 700,
      memberId: MEMBER_ANNA,
      entity: "transaction",
      action: "create",
      targetId: LABELLED_EXPENSE_ID,
      fields: {
        kind: "expense",
        occurredOn: "2026-07-12",
        status: "posted",
        amountMinor: 150_000,
        accountId: MAIN_ACCOUNT_ID,
        categoryId: PRODUCTS_CATEGORY_ID,
        memberId: MEMBER_PETR,
      },
    });

    const shown = applyJournal([...journal, labelled]);
    expect(shown.integrity).toEqual({ ready: true, problems: [], withheld: [] });
    expect(attributed(shown)?.memberId).toBe(MEMBER_PETR);
    expect(labelled.memberId).toBe(MEMBER_ANNA);
    const split = calculateMemberExpenses(shown.state);
    expect(split.byMember[MEMBER_PETR]?.actualMinor).toBe(150_000);
    expect(split.byMember[MEMBER_ANNA]?.actualMinor).toBe(0);
    // And through storage: a snapshot recomputes its state from the entries it validated, so
    // a label that did not survive the entry would be lost on the next start of the device.
    expect(attributed(restoreJournal(JSON.parse(JSON.stringify(shown)) as unknown))?.memberId).toBe(MEMBER_PETR);

    // Now Пётр is deleted while that expense is in flight — ordinary concurrency in a family.
    // The domain refuses a label naming nobody, so the state may not keep it; but withholding
    // the transaction the way an unresolved account is withheld would take a real purchase out
    // of the budget, and one delete would then quietly move the totals everybody else reads.
    // The label goes, the money stays, and the family is told.
    const deleted = parseOperation({
      opId: opUuid(982),
      deviceId: DEVICE_C,
      lamport: 701,
      entity: "member",
      action: "delete",
      targetId: MEMBER_PETR,
    });
    const forgotten = applyJournal([...journal, labelled, deleted]);
    const kept = attributed(forgotten);
    expect(kept?.amountMinor).toBe(150_000);
    expect(kept !== undefined && "memberId" in kept).toBe(false);
    expect(forgotten.integrity.ready).toBe(true);
    expect(forgotten.integrity.withheld).toEqual([]);
    expect(forgotten.integrity.problems).toEqual([
      { code: "unknown_reference", entity: "transaction", id: LABELLED_EXPENSE_ID },
    ]);
    // To the kopeck what it was before the participant was deleted, and the split no longer
    // throws: the purchase is simply attributed to nobody.
    expect(calculateBudget(forgotten.state).expensesMinor).toBe(calculateBudget(shown.state).expensesMinor);
    expect(calculateMemberExpenses(forgotten.state).unattributed.actualMinor).toBe(
      split.unattributed.actualMinor + 150_000,
    );

    // A participant who has not arrived yet is the other half of the same case, and the gate
    // keeps nothing of its own between passes: the label comes back by itself on the pass
    // after the operation that creates them is delivered.
    const early = applyJournal([
      ...journal.filter((item) => item.targetId !== MEMBER_PETR),
      labelled,
    ]);
    expect(attributed(early) !== undefined && "memberId" in attributed(early)!).toBe(false);
    expect(early.integrity.problems).toEqual([
      { code: "unknown_reference", entity: "transaction", id: LABELLED_EXPENSE_ID },
    ]);
    const arrived = applyOperations(early, journal.filter((item) => item.targetId === MEMBER_PETR));
    expect(attributed(arrived)?.memberId).toBe(MEMBER_PETR);
    expect(arrived.integrity.problems).toEqual([]);
  });

  it("carries the category of an income on a transaction across devices, and never lets the label cost the money", () => {
    // The same round trip as the participant's, for the second label a transaction carries.
    // The codec listed the fields of an income exactly and had no place for a category, so a
    // categorised income was rejected outright: the category lived on the device it was typed
    // on and no other device in the family ever saw it.
    const journal = buildFixtureJournal();
    const income = (snapshot: JournalSnapshot): Transaction | undefined =>
      snapshot.state.transactions.find((item) => item.id === SALARY_INCOME_ID);
    const filedUnder = (snapshot: JournalSnapshot): string | undefined => {
      const found = income(snapshot);
      return found !== undefined && found.kind === "income" ? found.categoryId : undefined;
    };
    const incomeMinor = (snapshot: JournalSnapshot): number => calculateBudget(snapshot.state).incomeMinor;
    const plain = applyJournal(journal);

    // An income written before income had categories carries none, and no pass over the
    // journal may hand it one: an absent category and an empty one are different values.
    expect(income(plain) !== undefined && "categoryId" in income(plain)!).toBe(false);
    expect(plain.integrity).toEqual({ ready: true, problems: [], withheld: [] });

    const salary = parseOperation({
      opId: opUuid(991),
      deviceId: DEVICE_B,
      lamport: 800,
      memberId: MEMBER_ANNA,
      entity: "category",
      action: "create",
      targetId: SALARY_CATEGORY_ID,
      fields: { name: "Зарплата", type: "income", group: "income", active: true, sortOrder: 10 },
    });
    const filed = parseOperation({
      opId: opUuid(992),
      deviceId: DEVICE_B,
      lamport: 801,
      memberId: MEMBER_ANNA,
      entity: "transaction",
      action: "update",
      targetId: SALARY_INCOME_ID,
      fields: {
        kind: "income",
        occurredOn: "2026-07-01",
        status: "posted",
        amountMinor: 18_000_000,
        accountId: MAIN_ACCOUNT_ID,
        categoryId: SALARY_CATEGORY_ID,
      },
    });

    const shown = applyJournal([...journal, salary, filed]);
    expect(shown.integrity).toEqual({ ready: true, problems: [], withheld: [] });
    expect(filedUnder(shown)).toBe(SALARY_CATEGORY_ID);
    // A label, and labels do not move money: the family's income is what it was.
    expect(incomeMinor(shown)).toBe(incomeMinor(plain));
    // And through storage: a snapshot recomputes its state from the entries it validated, so
    // a category that did not survive the entry would be lost on the next start of the device.
    expect(filedUnder(restoreJournal(JSON.parse(JSON.stringify(shown)) as unknown))).toBe(SALARY_CATEGORY_ID);

    // Now the category is deleted while the income is in flight — ordinary concurrency, and
    // the same case as a deleted participant. The domain refuses an income filed under nothing,
    // so the state may not keep it; but withholding the income the way an unresolved account is
    // withheld would take the family's salary out of its own income figure, and one delete
    // would then quietly move the totals everybody else reads. The label goes, the money stays.
    const deleted = parseOperation({
      opId: opUuid(993),
      deviceId: DEVICE_C,
      lamport: 802,
      entity: "category",
      action: "delete",
      targetId: SALARY_CATEGORY_ID,
    });
    const forgotten = applyJournal([...journal, salary, filed, deleted]);
    const kept = income(forgotten);
    expect(kept?.amountMinor).toBe(18_000_000);
    expect(kept !== undefined && "categoryId" in kept).toBe(false);
    expect(forgotten.integrity.ready).toBe(true);
    expect(forgotten.integrity.withheld).toEqual([]);
    expect(forgotten.integrity.problems).toEqual([
      { code: "unknown_reference", entity: "transaction", id: SALARY_INCOME_ID },
    ]);
    expect(incomeMinor(forgotten)).toBe(incomeMinor(plain));

    // The other half of the same case: the category resolves and it is an expense category,
    // which one device can produce by retyping a category another device is filing income
    // under. Reported under the code the gate already uses for a category of the wrong side,
    // and answered the same way, because it is still a label.
    const retyped = parseOperation({
      opId: opUuid(994),
      deviceId: DEVICE_C,
      lamport: 803,
      entity: "category",
      action: "update",
      targetId: SALARY_CATEGORY_ID,
      fields: { name: "Зарплата", type: "expense", group: "everyday", active: true, sortOrder: 10 },
    });
    const mistyped = applyJournal([...journal, salary, filed, retyped]);
    expect(filedUnder(mistyped)).toBeUndefined();
    expect(income(mistyped)?.amountMinor).toBe(18_000_000);
    expect(mistyped.integrity.ready).toBe(true);
    expect(mistyped.integrity.withheld).toEqual([]);
    expect(mistyped.integrity.problems).toEqual([
      { code: "wrong_category_type", entity: "transaction", id: SALARY_INCOME_ID },
    ]);
    expect(incomeMinor(mistyped)).toBe(incomeMinor(plain));
    expect(calculateBudget(mistyped.state).expensesMinor).toBe(calculateBudget(plain.state).expensesMinor);

    // A category that has not arrived yet is the last half of it, and the gate keeps nothing
    // of its own between passes: the label comes back by itself on the pass after the
    // operation that creates the category is delivered.
    const early = applyJournal([...journal, filed]);
    expect(filedUnder(early)).toBeUndefined();
    expect(early.integrity.problems).toEqual([
      { code: "unknown_reference", entity: "transaction", id: SALARY_INCOME_ID },
    ]);
    const arrivedCategory = applyOperations(early, [salary]);
    expect(filedUnder(arrivedCategory)).toBe(SALARY_CATEGORY_ID);
    expect(arrivedCategory.integrity.problems).toEqual([]);
  });

  it("settles a category planned twice by the total order, not by the name of the line", () => {
    // The lowest identifier used to stay, and an identifier is whatever the writing device
    // chose to call the line: naming one `!` replaced the limit the family had planned for
    // that category however long ago they had planned it.
    const journal = buildFixtureJournal();
    const honest = productsLimitMinor(applyJournal(journal));
    const intruder = (opId: string, plannedMinor: number, lamport: number): Operation =>
      parseOperation({
        opId,
        deviceId: DEVICE_B,
        lamport,
        entity: "budgetLine",
        action: "create",
        targetId: "!products",
        fields: { budgetId: BUDGET_ID, categoryId: PRODUCTS_CATEGORY_ID, plannedMinor },
      });

    const early = applyJournal([...journal, intruder(opUuid(978), 100_000, 1)]);
    expect(productsLimitMinor(early)).toBe(honest);
    expect(early.integrity.problems).toEqual([
      { code: "duplicate_budget_line", entity: "budgetLine", id: "!products" },
    ]);
    // Already resolved, so the family goes on seeing its budget.
    expect(early.integrity.ready).toBe(true);
    expect(applyJournal([intruder(opUuid(978), 100_000, 1), ...journal])).toEqual(early);

    // A later write wins, exactly as it would if it had edited the line the family already
    // had: what changed is that the name of the line no longer decides anything.
    const late = applyJournal([...journal, intruder(opUuid(979), 100_000, 620)]);
    expect(productsLimitMinor(late)).toBe(100_000);
    expect(late.integrity.problems).toEqual([
      { code: "duplicate_budget_line", entity: "budgetLine", id: PRODUCTS_LINE_ID },
    ]);
    expect(applyJournal([intruder(opUuid(979), 100_000, 620), ...journal])).toEqual(late);
  });

  it("ties the money ceilings to each other rather than to a story about them", () => {
    // Two justifications have been wrong here in turn. The first: the gate's ceiling bounds the
    // domain's sums. It does not — the domain adds only posted transactions inside the window of
    // the active budget, the gate adds every live entity, and a subset of signed terms is not
    // bounded by the total of the superset it came from. The second: a count bounds them, at most
    // MAX_JOURNAL_ENTRIES entities carrying three amounts each. That was circular, because the
    // count could only be enforced by evicting somebody and every dimension to evict by was
    // written by the peer being evicted, and the count stopped being enforced in the sixth round.
    const moneyFieldsPerEntity = 3; // planned + rollover + adjustment, and a goal's three
    const combinedAggregates = 4; // scheduled + flexible + reserve + goal plan
    // So the count is worth nothing to this invariant, and the arithmetic says so out loud: a
    // journal is free to hold enough amounts to leave the safe range altogether.
    expect(MAX_JOURNAL_ENTRIES * moneyFieldsPerEntity * MAX_MONEY_MINOR).toBeLessThan(Number.MAX_SAFE_INTEGER);
    expect(Math.ceil(Number.MAX_SAFE_INTEGER / MAX_MONEY_MINOR)).toBeGreaterThan(MAX_JOURNAL_ENTRIES);

    // What holds it up instead is arithmetic between three constants. Every total the gate hands
    // the domain is inside the ceiling, and four of them added together are still safe.
    expect(combinedAggregates * MAX_AGGREGATE_MINOR).toBeLessThan(Number.MAX_SAFE_INTEGER);
    // One honest payment is never larger than the ceiling on sums of payments.
    expect(MAX_MONEY_MINOR).toBeLessThanOrEqual(MAX_AGGREGATE_MINOR);
    // A saturated accumulator always reads as out of range, so a total the gate could not
    // measure exactly is never mistaken for one that fits.
    expect(SATURATION_MINOR).toBeGreaterThan(MAX_AGGREGATE_MINOR);
    // And the widest single addition the gate performs — a saturated balance onto a saturated
    // running capital, plus one more amount — is a safe integer on its own.
    expect(2 * SATURATION_MINOR + MAX_MONEY_MINOR).toBeLessThan(Number.MAX_SAFE_INTEGER);
  });

  it("reports every problem as data, never as a sentence a stranger wrote", () => {
    const hostile = "identifier-with-a-message";
    const journal = [
      ...buildFixtureJournal(),
      parseOperation({
        opId: opUuid(970),
        deviceId: DEVICE_B,
        lamport: 600,
        entity: "goal",
        action: "create",
        targetId: hostile,
        fields: { ...SAMPLE_FIELDS.goal, linkedAccountId: "account-that-never-existed" },
      }),
    ];

    const problems: readonly JournalProblem[] = applyJournal(journal).integrity.problems;
    expect(problems).toEqual([{ code: "unknown_reference", entity: "goal", id: hostile }]);
    for (const problem of problems) {
      expect(Object.keys(problem).sort()).toEqual(["code", "entity", "id"]);
    }
  });
});

describe("rejected operations", () => {
  it("leaves the state untouched when an operation is invalid", () => {
    const snapshot = applyJournal(buildFixtureJournal());
    const invalid: readonly unknown[] = [
      { ...SAMPLE_FIELDS.account, opId: opUuid(1) },
      {
        opId: opUuid(1),
        deviceId: DEVICE_B,
        lamport: 200,
        entity: "account",
        action: "update",
        targetId: MAIN_ACCOUNT_ID,
        fields: { ...SAMPLE_FIELDS.account, unexpected: 1 },
      },
      JSON.parse(
        `{"opId":"${opUuid(1)}","deviceId":"${DEVICE_B}","lamport":200,"entity":"member","action":"create","targetId":"m","fields":{"name":"Пётр","role":"member","active":true,"__proto__":{"polluted":true}}}`,
      ) as unknown,
      {
        opId: opUuid(1),
        deviceId: DEVICE_B,
        lamport: 200,
        entity: "transaction",
        action: "update",
        targetId: PRODUCTS_EXPENSE_ID,
        fields: { ...SAMPLE_FIELDS.transaction, amountMinor: 2 ** 53 },
      },
    ];

    for (const value of invalid) {
      expect(() => parseOperation(value)).toThrow(SyncProtocolError);
    }
    expect(applyOperations(snapshot, [])).toBe(snapshot);
    expect(applyJournal(buildFixtureJournal())).toEqual(snapshot);
    expect(calculateAnnualPlan(snapshot.state, G002.startMonth, 12).currentMonth.annualReserveMinor).toBe(1_980_900);
  });

  it("refuses a batch, a journal and a bookkeeping set larger than the protocol allows", () => {
    // The lengths are checked before a single element is read, so an oversized delivery
    // costs a rejection rather than the memory it asked for.
    expect(() => applyOperations(createEmptyJournal(), new Array(MAX_BATCH_OPERATIONS + 1))).toThrow(
      /batch must hold at most/,
    );
    expect(() => restoreJournal({ entries: [], appliedOpIds: new Array(MAX_APPLIED_OP_IDS + 1) })).toThrow(
      /must list at most/,
    );
    expect(() => restoreJournal({ entries: [], appliedOpIds: "не массив" })).toThrow(
      /appliedOpIds must be an array/,
    );
    // A sparse array is not a list of operations. Walking past its holes answered with a
    // TypeError, which a caller cannot tell apart from a bug in the protocol and so cannot
    // quarantine; every hole is a rejection of the protocol's own kind now.
    expect(() => applyOperations(createEmptyJournal(), new Array(3))).toThrow(SyncProtocolError);
    expect(() => restoreJournal({ entries: new Array(3) })).toThrow(SyncProtocolError);
    expect(() => restoreJournal({ entries: [], appliedOpIds: new Array(3) })).toThrow(SyncProtocolError);
  });
});

describe("untrusted input", () => {
  const POISONED_TEXT =
    `{"opId":"${opUuid(2)}","deviceId":"${DEVICE_B}","lamport":9,"entity":"member","action":"create",` +
    `"targetId":"member-poison","fields":{"name":"Пётр","role":"member","active":true,"__proto__":{"polluted":true}}}`;

  const REAL_ENTRY = parseOperation({
    opId: opUuid(3),
    deviceId: DEVICE_A,
    lamport: 12,
    entity: "account",
    action: "create",
    targetId: "account-1",
    fields: SAMPLE_FIELDS.account,
  });

  /** A snapshot shaped like one this module builds, but assembled by someone else. */
  function forgedSnapshot(overrides: Record<string, unknown> = {}): JournalSnapshot {
    return {
      state: {
        activeBudgetId: "budget-that-never-existed",
        accounts: [{ id: "ghost-account", name: "Призрак" }],
        categories: [],
        budgets: [],
        goals: [],
        annualCommitments: [],
        scheduledExpenses: [],
        transactions: [],
        members: [],
      },
      integrity: { ready: true, problems: [] },
      entries: [REAL_ENTRY],
      activeBudget: null,
      appliedOpIds: [opUuid(4)],
      lamport: 9_000_000,
      ...overrides,
    } as unknown as JournalSnapshot;
  }

  it("validates every incoming operation, including a prototype key nested in fields", () => {
    const poisoned = JSON.parse(POISONED_TEXT) as Operation;
    // Calling the merge directly must not be a way around the codec.
    expect(() => applyJournal([poisoned])).toThrow(/forbidden field name/);
    expect(() => applyOperations(createEmptyJournal(), [poisoned])).toThrow(SyncProtocolError);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    expect(Object.prototype.hasOwnProperty.call(Object.prototype, "polluted")).toBe(false);

    expect(() =>
      applyJournal([{ ...REAL_ENTRY, fields: { ...SAMPLE_FIELDS.account, unexpected: 1 } } as unknown as Operation]),
    ).toThrow(/account fields contains unknown field unexpected/);
    expect(() => applyJournal([{ ...REAL_ENTRY, lamport: MAX_LAMPORT + 1 }])).toThrow(
      /operation lamport must be from 1 to 1099511627776/,
    );
    expect(() => applyJournal([{ ...REAL_ENTRY, deviceId: "device-a" }])).toThrow(
      /operation deviceId must be a lowercase UUID version 4/,
    );
    expect(() => applyOperations(createEmptyJournal(), "не массив" as unknown as readonly Operation[])).toThrow(
      /operations must be an array/,
    );
    // Nothing of the rejected batch survives: a throw leaves the caller with its old snapshot.
    expect(applyJournal([REAL_ENTRY]).entries).toHaveLength(1);
  });

  it("rebuilds a snapshot it did not build instead of believing its state", () => {
    const rebuilt = applyOperations(forgedSnapshot(), []);
    expect(rebuilt.state.accounts).toEqual([{ id: "account-1", ...SAMPLE_FIELDS.account }]);
    expect(rebuilt.state.activeBudgetId).toBe("");
    // The entries are replayed and the state is recomputed. The bookkeeping and the clock are
    // validated and carried, not recomputed: an entry only holds the operation that still owns
    // its entity, so recomputing either of them would forget everything a later write replaced
    // and a device that restarted would write under stamps it had already used. The clock is
    // bounded by MAX_LAMPORT and decides nothing but tiebreaks, so carrying it is safe.
    expect(rebuilt.appliedOpIds).toEqual([opUuid(3), opUuid(4)].sort());
    expect(rebuilt.lamport).toBe(9_000_000);
    expect(restoreJournal({ entries: [REAL_ENTRY], activeBudget: null }).lamport).toBe(12);
    expect(rebuilt.integrity).toEqual({
      ready: false,
      problems: [{ code: "no_active_budget", entity: "budget", id: "" }],
      withheld: [],
    });
    expect(rebuilt).toEqual(restoreJournal(forgedSnapshot()));
  });

  it("refuses a forged snapshot whose entries never went through the codec", () => {
    const poisoned = JSON.parse(POISONED_TEXT) as unknown;
    expect(() => applyOperations(forgedSnapshot({ entries: [poisoned] }), [])).toThrow(/forbidden field name/);
    expect(() => applyOperations(forgedSnapshot({ entries: "не массив" }), [])).toThrow(
      /journal snapshot entries must be an array/,
    );
    expect(() => applyOperations(forgedSnapshot({ entries: [{ ...REAL_ENTRY, lamport: MAX_LAMPORT + 1 }] }), [])).toThrow(
      SyncProtocolError,
    );
    // An activation lives in the pointer alone, so an entry that carries one is a forgery.
    expect(() =>
      applyOperations(forgedSnapshot({ entries: [activation(DEVICE_A, opUuid(5), BUDGET_ID, 5)] }), []),
    ).toThrow(/must not hold a budget activation/);
    expect(() => applyOperations(forgedSnapshot({ activeBudget: REAL_ENTRY }), [])).toThrow(
      /must be a budget activation/,
    );
    // The activation register is restored as well, and is validated the same way.
    expect(() => applyOperations(forgedSnapshot({ activations: [REAL_ENTRY] }), [])).toThrow(
      /must be a budget activation/,
    );
    expect(() => applyOperations(forgedSnapshot({ activations: "не массив" }), [])).toThrow(
      /journal snapshot activations must be an array/,
    );
    expect(() => applyOperations(forgedSnapshot({ appliedOpIds: ["op-1"] }), [])).toThrow(
      /appliedOpId must be a lowercase UUID version 4/,
    );
    expect(() => restoreJournal("снимок")).toThrow(/journal snapshot must be an object/);
    expect(() => restoreJournal(null)).toThrow(SyncProtocolError);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  it("carries the identifiers of overridden operations through a restore", () => {
    // An entry only holds the operation that still owns its entity. Recomputing the applied
    // set from the entries would forget every operation a later write replaced, and a device
    // that restarted would acknowledge less than it had before the restart.
    const journal = buildFixtureJournal();
    const live = applyOperations(applyJournal(journal), [
      productsLineEdit(DEVICE_B, opUuid(980), 3_500_000, 700),
    ]);
    const persisted = JSON.parse(JSON.stringify(live)) as unknown;
    const restored = restoreJournal(persisted);

    expect(restored.appliedOpIds).toEqual(live.appliedOpIds);
    expect(restored.appliedOpIds).toContain(opUuid(980));
    expect(restored.state).toEqual(live.state);
    expect(restored.entries).toEqual(live.entries);
    expect(restored.activeBudget).toEqual(live.activeBudget);
    expect(restored.lamport).toBe(live.lamport);
  });

  it("trims its bookkeeping instead of locking the device out of its own journal", () => {
    // The ceiling on the applied set used to be a throw, and that handed a peer an off
    // switch: a forged snapshot listing a million identifiers locked the device out of its
    // own journal for good, because every later call threw before it applied anything —
    // including the operations the device wrote itself.
    const appliedOpIds = Array.from({ length: MAX_APPLIED_OP_IDS }, (_unused, index) =>
      opUuid(2_000_000 + index),
    );
    const full = restoreJournal({ entries: [], activeBudget: null, appliedOpIds });

    const write = (opId: string, targetId: string, name: string, lamport: number): Operation =>
      parseOperation({
        opId,
        deviceId: DEVICE_A,
        lamport,
        entity: "member",
        action: "create",
        targetId,
        fields: { name, role: "member", active: true },
      });

    const after = applyOperations(full, [write(opUuid(1_000_001), MEMBER_ANNA, "Анна", 5)]);
    expect(after.state.members.map((member) => member.id)).toEqual([MEMBER_ANNA]);
    expect(after.integrity.problems).toContainEqual({ code: "applied_id_budget", entity: null, id: "" });
    // Advisory: nothing depends on the set for correctness — it is never a reason to skip an
    // operation — so a forgotten identifier costs an extra fold, not a divergence, and the
    // family must not be frozen on an old snapshot over it.
    expect(after.integrity.problems.filter((value) => value.code !== "applied_id_budget")).toEqual([
      { code: "no_active_budget", entity: "budget", id: "" },
    ]);

    // The window slid rather than closed: the oldest identifiers are gone, the newest write is
    // remembered, and the device goes on writing.
    expect(after.appliedOpIds.length).toBeLessThan(MAX_APPLIED_OP_IDS);
    expect(after.appliedOpIds).toContain(opUuid(1_000_001));
    expect(after.appliedOpIds).not.toContain(opUuid(2_000_000));
    const later = applyOperations(after, [write(opUuid(1_000_002), MEMBER_PETR, "Пётр", 6)]);
    expect(later.state.members).toHaveLength(2);
    // A trim keeps an epoch of headroom, so the next write does not pay for another one.
    expect(later.integrity.problems.some((value) => value.code === "applied_id_budget")).toBe(false);
  }, 60_000);

  it("freezes what it hands back, so a merge cannot be rewritten behind a caller's back", () => {
    const snapshot = applyJournal(buildFixtureJournal());
    const entry = snapshot.entries[0]!;
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(Object.isFrozen(snapshot.entries)).toBe(true);
    expect(Object.isFrozen(snapshot.state)).toBe(true);
    expect(Object.isFrozen(snapshot.state.accounts)).toBe(true);
    expect(Object.isFrozen(snapshot.state.accounts[0])).toBe(true);
    expect(Object.isFrozen(snapshot.state.budgets[0]?.lines[0])).toBe(true);
    expect(Object.isFrozen(snapshot.integrity)).toBe(true);
    expect(Object.isFrozen(snapshot.appliedOpIds)).toBe(true);
    expect(Object.isFrozen(entry)).toBe(true);
    expect(() => {
      (entry as { lamport: number }).lamport = 1;
    }).toThrow(TypeError);
    expect(() => {
      (snapshot.state.accounts as { length: number }).length = 0;
    }).toThrow(TypeError);
    if (entry.action !== "delete") {
      expect(Object.isFrozen(entry.fields)).toBe(true);
    }
  });
});

describe("delivery in envelopes", () => {
  it("folds a stream of envelopes one at a time without rebuilding the journal each time", () => {
    // Measured before this was fixed: thirty-two thousand envelopes blocked the main thread
    // for seventeen seconds, because every envelope copied the bookkeeping set, sorted it and
    // materialised the whole state again. At the quota of one epoch that is minutes.
    const count = 8_000;
    const envelopes = Array.from({ length: count }, (_unused, index) =>
      parseOperation({
        opId: opUuid(40_000 + index),
        deviceId: DEVICE_A,
        lamport: 1 + index,
        entity: "member",
        action: "create",
        targetId: `member-${String(index).padStart(6, "0")}`,
        fields: SAMPLE_FIELDS.member,
      }),
    );

    const started = performance.now();
    let snapshot = createEmptyJournal();
    for (const envelope of envelopes) snapshot = applyOperations(snapshot, [envelope]);
    const folded = performance.now() - started;

    expect(snapshot.state.members).toHaveLength(count);
    expect(snapshot.appliedOpIds).toHaveLength(count);
    expect(snapshot.lamport).toBe(count);
    expect(folded).toBeLessThan(3_000);
    expect(snapshot.state).toEqual(applyJournal(envelopes).state);
  });

  it("costs one pass over the journal per delivery when the read contract is kept", () => {
    // The gate is a function of the whole converged journal, so reading the verdict costs a
    // pass over it. The contract JournalSnapshot documents is therefore: fold the whole
    // delivery, then read once. Reading after every envelope is the quadratic shape it
    // forbids — eighteen seconds for this many envelopes.
    const count = 4_000;
    const envelopes = Array.from({ length: count }, (_unused, index) =>
      parseOperation({
        opId: opUuid(80_000 + index),
        deviceId: DEVICE_A,
        lamport: 1 + index,
        entity: "member",
        action: "create",
        targetId: `member-${String(index).padStart(6, "0")}`,
        fields: SAMPLE_FIELDS.member,
      }),
    );

    const started = performance.now();
    let snapshot = createEmptyJournal();
    for (const envelope of envelopes) snapshot = applyOperations(snapshot, [envelope]);
    expect(snapshot.integrity.ready).toBe(false);
    expect(snapshot.state.members).toHaveLength(count);
    expect(performance.now() - started).toBeLessThan(3_000);

    // Once a snapshot has been read it answers from what it built, so a consumer that shows
    // the same delivery on several screens pays for it once.
    const reread = performance.now();
    for (let attempt = 0; attempt < 1_000; attempt += 1) {
      expect(snapshot.integrity.ready).toBe(false);
      expect(snapshot.entries).toHaveLength(count);
    }
    expect(performance.now() - reread).toBeLessThan(500);

    // A consumer that must show progress reads on a schedule, never once per envelope, and
    // the schedule is what keeps it linear.
    const scheduled = performance.now();
    let progressive = createEmptyJournal();
    for (const [index, envelope] of envelopes.entries()) {
      progressive = applyOperations(progressive, [envelope]);
      if (index % 500 === 499) expect(progressive.integrity.ready).toBe(false);
    }
    expect(performance.now() - scheduled).toBeLessThan(3_000);
    expect(progressive.state).toEqual(snapshot.state);
  }, 60_000);

  it("does not pay for a copy of the journal on every refused operation", () => {
    // A snapshot that lost the claim on the shared indexes copied the whole journal on every
    // later call, and an operation it refuses changes nothing, so the copy bought nothing:
    // 14.8 ms per refused operation, on every one of them.
    const journal = Array.from({ length: 8_000 }, (_unused, index) =>
      parseOperation({
        opId: opUuid(90_000 + index),
        deviceId: DEVICE_A,
        lamport: 1 + index,
        entity: "member",
        action: "create",
        targetId: `member-${String(index).padStart(6, "0")}`,
        fields: SAMPLE_FIELDS.member,
      }),
    );
    const base = applyJournal(journal);
    // Another branch takes the claim on the shared indexes away from `base`.
    const branch = applyOperations(base, [
      parseOperation({
        opId: opUuid(99_999),
        deviceId: DEVICE_B,
        lamport: 9_000,
        entity: "member",
        action: "delete",
        targetId: "member-000000",
      }),
    ]);
    expect(branch).not.toBe(base);

    const refused = journal[0]!;
    const started = performance.now();
    for (let attempt = 0; attempt < 2_000; attempt += 1) {
      expect(applyOperations(base, [refused])).toBe(base);
    }
    expect(performance.now() - started).toBeLessThan(2_000);

    // And the branch that owns the indexes is untouched by all of it.
    expect(branch.state.members).toHaveLength(journal.length - 1);
    expect(base.state.members).toHaveLength(journal.length);
  }, 60_000);

  it("still answers with the state a superseded snapshot had", () => {
    const journal = buildFixtureJournal();
    const before = applyJournal(journal);
    const after = applyOperations(before, [removal(DEVICE_B, opUuid(990), PRODUCTS_EXPENSE_ID, 900)]);

    expect(after.state.transactions.map((item) => item.id)).not.toContain(PRODUCTS_EXPENSE_ID);
    // The snapshot the caller still holds is the one it was handed, not a view of what
    // happened to the journal afterwards.
    expect(before.state.transactions.map((item) => item.id)).toContain(PRODUCTS_EXPENSE_ID);
    expect(before.entries).toEqual(applyJournal(journal).entries);
    expect(before.appliedOpIds).not.toContain(opUuid(990));
    expect(calculateAnnualPlan(before.state, G002.startMonth, 12).currentMonth.annualReserveMinor).toBe(1_980_900);
    // And it can still be merged onto, side by side with the branch that superseded it.
    expect(applyOperations(before, [])).toBe(before);
    expect(applyOperations(before, journal)).toBe(before);
  });

  it("bounds the rewind window instead of holding every write a device ever replaced", () => {
    // The undo log is what keeps a stream of envelopes linear, and left alone it was the one
    // structure here that grew with everything a device had ever written rather than with what
    // it currently held: every operation a later write replaced stayed reachable through it for
    // the life of the process.
    const steps = MAX_UNDO_STEPS + 10_001;
    const operations = Array.from({ length: steps }, (_unused, index) =>
      parseOperation({
        opId: opUuid(400_000 + index),
        deviceId: DEVICE_A,
        lamport: 1 + index,
        entity: "member",
        action: "create",
        targetId: `member-undo-${String(index).padStart(7, "0")}`,
        fields: SAMPLE_FIELDS.member,
      }),
    );

    const first = applyOperations(createEmptyJournal(), operations.slice(0, 1));
    let snapshot = first;
    for (let index = 1; index < steps; index += MAX_BATCH_OPERATIONS) {
      snapshot = applyOperations(snapshot, operations.slice(index, index + MAX_BATCH_OPERATIONS));
    }
    expect(snapshot.lamport).toBe(steps);

    // A snapshot older than the window answers with an error rather than with the state of a
    // journal it never saw: a caller can fold its delivery again, but a family shown a budget
    // that was never anybody's is a wrong answer nobody can detect.
    expect(() => first.entries).toThrow(/older than the undo window/);
    expect(() => applyOperations(first, [])).toThrow(SyncProtocolError);
    // The current snapshot is unaffected, and one still inside the window rewinds as before.
    const recent = applyOperations(snapshot, [
      parseOperation({
        opId: opUuid(399_999),
        deviceId: DEVICE_A,
        lamport: 1,
        entity: "member",
        action: "create",
        targetId: MEMBER_ANNA,
        fields: SAMPLE_FIELDS.member,
      }),
    ]);
    expect(recent.entries).toHaveLength(steps + 1);
    expect(snapshot.entries).toHaveLength(steps);
  });
});

describe("Lamport clock", () => {
  it("increments on a local change and pulls up on a received one", () => {
    const clock = createClock(DEVICE_A);
    expect(clock.lamport).toBe(0);
    expect(tickClock(clock).lamport).toBe(1);
    expect(receiveClock(clock, 41).lamport).toBe(41);
    expect(receiveClock(createClock(DEVICE_A, 50), 41).lamport).toBe(50);
    expect(tickClock(receiveClock(clock, 41)).lamport).toBe(42);
    expect(() => receiveClock(clock, -1)).toThrow(SyncProtocolError);
    // A device identifier is a UUID v4 by the codec, and the clock refuses what the codec
    // refuses rather than letting a device author operations no peer will accept.
    expect(() => createClock("")).toThrow(SyncProtocolError);
    expect(() => createClock("device-a")).toThrow(/clock deviceId must be a lowercase UUID version 4/);
    expect(() => createClock(DEVICE_A.toUpperCase())).toThrow(SyncProtocolError);
  });

  it("stamps a local operation with the next value and the device identity", () => {
    const local = createLocalOperation(createClock(DEVICE_A, 7), {
      opId: opUuid(1),
      entity: "member",
      action: "create",
      targetId: MEMBER_ANNA,
      fields: { name: "Анна", role: "owner", active: true },
    });
    expect(local.clock).toEqual({ deviceId: DEVICE_A, lamport: 8 });
    expect(local.operation.lamport).toBe(8);
    expect(local.operation.deviceId).toBe(DEVICE_A);

    const generated = createLocalOperation(local.clock, {
      entity: "member",
      action: "delete",
      targetId: MEMBER_ANNA,
    });
    expect(generated.operation.opId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });

  it("refuses a stamp no honest clock could have produced instead of clamping it", () => {
    const clock = createClock(DEVICE_A, 42);
    expect(receiveLamport(clock, 43)).toEqual({ clock: { deviceId: DEVICE_A, lamport: 43 }, verdict: "accepted" });
    expect(receiveLamport(clock, 42 + MAX_LAMPORT_SKEW).verdict).toBe("accepted");

    // Clamping adopted the stamp all the same: one operation at the ceiling put every clock
    // in the family at the top, and from then on the largest deviceId won every conflict.
    const far = receiveLamport(clock, 43 + MAX_LAMPORT_SKEW);
    expect(far.verdict).toBe("beyond_skew");
    expect(far.clock).toBe(clock);
    expect(receiveLamport(clock, MAX_LAMPORT).verdict).toBe("beyond_skew");
    expect(receiveLamport(clock, MAX_LAMPORT + 1).verdict).toBe("above_ceiling");
    expect(receiveLamport(clock, MAX_LAMPORT * 2).verdict).toBe("above_ceiling");
    expect(receiveLamport(clock, -1).verdict).toBe("not_a_stamp");
    expect(receiveLamport(clock, 1.5).verdict).toBe("not_a_stamp");
    expect(receiveLamport(clock, 7)).toEqual({ clock, verdict: "accepted" });

    expect(() => receiveClock(clock, MAX_LAMPORT)).toThrow(/must not be more than 1000000 ahead/);
    expect(() => receiveClock(clock, MAX_LAMPORT + 1)).toThrow(/must be at most 1099511627776/);
    // A hostile envelope cannot take a clock with it: the caller quarantines it and the
    // clock it keeps working from is the one it had.
    const hostile = parseOperation({
      opId: opUuid(2),
      deviceId: DEVICE_E,
      lamport: MAX_LAMPORT,
      entity: "member",
      action: "delete",
      targetId: MEMBER_ANNA,
    });
    expect(() => receiveOperations(clock, [hostile])).toThrow(SyncProtocolError);
    expect(clock.lamport).toBe(42);
  });

  it("keeps writing at the ceiling a long history reached honestly", () => {
    // The absolute ceiling of the codec is not the ceiling of the ordering. A clock that
    // somehow arrived on the honest line or above it comes back below it: from the line upwards
    // a stamp carries no rank at all, so writing from there would cost the device every conflict
    // it will ever have.
    expect(MAX_HONEST_LAMPORT).toBe(HONEST_LAMPORT_CEILING - 1);
    const pushed = createClock(DEVICE_A, MAX_LAMPORT);
    expect(tickClock(pushed).lamport).toBe(MAX_HONEST_LAMPORT);
    // Saturating one below the line rather than on it is the whole point. On the line the
    // device used to write at the highest rank the protocol had, quietly outranking its own
    // family; once the ranking stopped sparing its own ceiling, the same device would have
    // dropped to the floor rank instead. Reaching the end of the stamps must cost neither.
    expect(tickClock(createClock(DEVICE_A, HONEST_LAMPORT_CEILING)).lamport).toBe(MAX_HONEST_LAMPORT);
    expect(tickClock(createClock(DEVICE_A, MAX_HONEST_LAMPORT)).lamport).toBe(MAX_HONEST_LAMPORT);
    expect(tickClock(createClock(DEVICE_A, MAX_HONEST_LAMPORT - 1)).lamport).toBe(MAX_HONEST_LAMPORT);
    expect(() => createClock(DEVICE_A, MAX_LAMPORT + 1)).toThrow(SyncProtocolError);
    // Every other way a clock can take a stamp saturates in the same place.
    expect(receiveLamport(createClock(DEVICE_A, MAX_HONEST_LAMPORT - 1), HONEST_LAMPORT_CEILING)).toEqual({
      clock: { deviceId: DEVICE_A, lamport: MAX_HONEST_LAMPORT },
      verdict: "accepted",
    });
    expect(
      receiveOperations(createClock(DEVICE_A, MAX_HONEST_LAMPORT - 1), [
        parseOperation({
          opId: opUuid(3),
          deviceId: DEVICE_B,
          lamport: HONEST_LAMPORT_CEILING,
          entity: "member",
          action: "delete",
          targetId: MEMBER_ANNA,
        }),
      ]).lamport,
    ).toBe(MAX_HONEST_LAMPORT);

    const local = createLocalOperation(createClock(DEVICE_A, HONEST_LAMPORT_CEILING), {
      opId: opUuid(1),
      entity: "member",
      action: "update",
      targetId: MEMBER_ANNA,
      fields: { name: "Анна", role: "owner", active: false },
    });
    expect(local.operation.lamport).toBe(MAX_HONEST_LAMPORT);
    expect(local.clock).toEqual({ deviceId: DEVICE_A, lamport: MAX_HONEST_LAMPORT });

    // Once stamps stop growing the digest tiebreaker alone keeps the family converging.
    // A restored clock is carried below the honest line as well, and it is not carried there
    // silently: clamping alone laundered a forged 2^40 into what used to be the most powerful
    // stamp in the protocol, handed to the device that had just been attacked.
    const journal = buildFixtureJournal();
    const persisted = JSON.parse(JSON.stringify(applyJournal(journal))) as Record<string, unknown>;
    const atCeiling = restoreJournal({ ...persisted, lamport: MAX_LAMPORT });
    expect(atCeiling.lamport).toBe(MAX_HONEST_LAMPORT);
    // The empty identifier means this device's own clock rather than a peer, and it is advisory:
    // the family goes on seeing its budget.
    expect(atCeiling.integrity).toEqual({
      ready: true,
      problems: [{ code: "implausible_lamport", entity: null, id: "" }],
      withheld: [],
    });
    // Exactly on the line counts too — that is the value the whole defect lived on.
    expect(restoreJournal({ ...persisted, lamport: HONEST_LAMPORT_CEILING }).integrity.problems).toEqual(
      atCeiling.integrity.problems,
    );
    // One below it is an honest clock and says nothing.
    const honestClock = restoreJournal({ ...persisted, lamport: MAX_HONEST_LAMPORT });
    expect(honestClock.lamport).toBe(MAX_HONEST_LAMPORT);
    expect(honestClock.integrity).toEqual({ ready: true, problems: [], withheld: [] });

    const rename = (deviceId: string, opId: string, name: string): Operation => ({
      opId,
      deviceId,
      lamport: MAX_HONEST_LAMPORT,
      entity: "member",
      action: "update",
      targetId: MEMBER_PETR,
      fields: { name, role: "member", active: true },
    });
    const byA = rename(DEVICE_A, opUuid(996), "Пётр Первый");
    const byB = rename(DEVICE_B, opUuid(997), "Пётр Второй");
    const forward = applyOperations(honestClock, [byA, byB]);
    expect(applyOperations(honestClock, [byB, byA])).toEqual(forward);
    expect(forward.state.members).toHaveLength(2);
    expect(forward.lamport).toBe(MAX_HONEST_LAMPORT);
    // Both stamps stand one below the ceiling, so both rank by their stamps and both outrank the
    // create that named Пётр at a stamp of two. The digest — not the order of delivery — decides
    // which of the two keeps the entry, and it decides the same way on every replica.
    const kept = forward.entries.filter((entry) => entry.lamport === MAX_HONEST_LAMPORT);
    expect(kept).toHaveLength(1);
    expect([DEVICE_A, DEVICE_B]).toContain(kept[0]?.deviceId);
    expect(forward.state.members.map((member) => member.name)).toEqual([
      "Анна",
      kept[0]?.deviceId === DEVICE_A ? "Пётр Первый" : "Пётр Второй",
    ]);
    // And nothing is reported, because nothing here is out of range: MAX_HONEST_LAMPORT is a
    // stamp a clock reaches, so it is a stamp a peer may type. Decision 39 says so out loud —
    // the merge is not what stands between a family and one of its own members, and the sixth
    // round's attempt to make it so cost 4295 operations to walk around.
    expect(forward.integrity).toEqual({ ready: true, problems: [], withheld: [] });
  });

  it("leaves every stamp at or above the codec's ceiling nothing to win with, and says who wrote it", () => {
    // Round five made the comparison non-strict, which lowered the value of the ceiling along
    // with everything above it. Round six went further and derived the line from the journal, so
    // that outranking a family would cost the ladder that family had climbed — and a ladder to
    // the absolute ceiling cost 4295 operations, 4.3 % of one batch quota, while a young family
    // whose line sat at one skew lost any entity to a single stamp just below it. The line is
    // the codec's published ceiling again, and decision 39 says what that does and does not buy.
    const journal = buildFixtureJournal();
    const base = applyJournal(journal);
    const honestStamps = base.entries.map((entry) => entry.lamport);
    expect(Math.max(...honestStamps)).toBeLessThan(MAX_LAMPORT_SKEW);

    const seize = (lamport: number, opId: string): Operation =>
      parseOperation({
        opId,
        deviceId: DEVICE_E,
        lamport,
        entity: "member",
        action: "update",
        targetId: MEMBER_PETR,
        fields: { name: "Пётр Захваченный", role: "member", active: true },
      });

    // Every stamp at or above the ceiling: exactly on it, one past it, and the absolute ceiling
    // of the codec.
    for (const [index, lamport] of [
      HONEST_LAMPORT_CEILING,
      HONEST_LAMPORT_CEILING + 1,
      MAX_LAMPORT,
    ].entries()) {
      const seized = seize(lamport, opUuid(704 + index));
      const after = applyOperations(base, [seized]);
      // It takes nothing from a family whose own clock is in the hundreds...
      expect([lamport, after.state.members.map((member) => member.name)]).toEqual([
        lamport,
        ["Анна", "Пётр"],
      ]);
      // ...and having lost the entity it reached for, it leaves the journal the way every other
      // loser of the total order does. The report is a function of the entries a restore rebuilds
      // from, so what it names is every implausible stamp that actually owns something.
      expect([lamport, after.integrity]).toEqual([
        lamport,
        { ready: true, problems: [], withheld: [] },
      ]);
      expect(after.entries.some((entry) => entry.opId === seized.opId)).toBe(false);
      // The same on every replica, in either order, and after a restart.
      expect(applyJournal([seized, ...journal])).toEqual(after);
      expect(restoreJournal(JSON.parse(JSON.stringify(after)) as unknown).integrity).toEqual(
        after.integrity,
      );

      // What such a stamp can own is a write nobody competes for, and that is named.
      const minted = parseOperation({
        opId: opUuid(714 + index),
        deviceId: DEVICE_E,
        lamport,
        entity: "member",
        action: "create",
        targetId: `minted-${String(index)}`,
        fields: SAMPLE_FIELDS.member,
      });
      const owned = applyOperations(base, [minted]);
      expect([lamport, owned.integrity]).toEqual([
        lamport,
        {
          ready: true,
          problems: [{ code: "implausible_lamport", entity: null, id: DEVICE_E }],
          withheld: [],
        },
      ]);
      expect(restoreJournal(JSON.parse(JSON.stringify(owned)) as unknown).integrity).toEqual(
        owned.integrity,
      );
    }

    // And the boundary stated plainly rather than defended: one below the ceiling is a stamp a
    // clock reaches honestly, so it wins, quietly, and a member of the family may write it. That
    // is not a hole in the merge — a member can delete the whole budget through the front door,
    // and no threshold computed on this side survives being computed from what that member
    // writes. What anchors the order against a peer is the server's sequencing, in phase S4.
    const highest = seize(MAX_HONEST_LAMPORT, opUuid(709));
    const taken = applyOperations(base, [highest]);
    expect(taken.state.members.map((member) => member.name)).toEqual(["Анна", "Пётр Захваченный"]);
    expect(taken.integrity).toEqual({ ready: true, problems: [], withheld: [] });
    expect(applyJournal([highest, ...journal])).toEqual(taken);
  });

  it("ranks by the ceiling of the codec, the same way on every replica", () => {
    const rank = (lamport: number, deviceId: string, opId: string): Operation =>
      parseOperation({
        opId,
        deviceId,
        lamport,
        entity: "member",
        action: "update",
        targetId: MEMBER_PETR,
        fields: { name: `Пётр ${String(lamport)}`, role: "member", active: true },
      });

    const honest = rank(1000, DEVICE_A, opUuid(700));
    const onTheLine = rank(HONEST_LAMPORT_CEILING, DEVICE_B, opUuid(701));
    const aboveTheLine = rank(HONEST_LAMPORT_CEILING + 1, DEVICE_C, opUuid(702));
    const belowTheLine = rank(MAX_HONEST_LAMPORT, DEVICE_D, opUuid(703));

    // On the line and above it a stamp carries no rank, so both lose to an ordinary one and tie
    // with each other; below the line the stamp is the first key, so it wins.
    expect(compareOperations(honest, onTheLine)).toBeGreaterThan(0);
    expect(compareOperations(honest, aboveTheLine)).toBeGreaterThan(0);
    expect(compareOperations(honest, belowTheLine)).toBeLessThan(0);
    // Ties are settled by the digest, the same way whichever side is asked.
    expect(compareOperations(onTheLine, aboveTheLine)).toBe(
      -compareOperations(aboveTheLine, onTheLine),
    );
    // A comparison of two arguments and nothing else: no journal, no threshold, no state. That
    // is what makes a fold of one envelope at a time, a fold of a whole batch and a restore from
    // storage settle the same conflict the same way.
    expect(compareOperations(belowTheLine, onTheLine)).toBeGreaterThan(0);
    expect(compareOperations(onTheLine, belowTheLine)).toBeLessThan(0);

    // A tombstone is final whatever its stamp, so that is what such a stamp can still own.
    const journal = buildFixtureJournal();
    const base = applyJournal(journal);
    const minted = parseOperation({
      opId: opUuid(705),
      deviceId: DEVICE_E,
      lamport: HONEST_LAMPORT_CEILING,
      entity: "member",
      action: "delete",
      targetId: MEMBER_ANNA,
    });
    const owned = applyOperations(base, [minted]);
    expect(owned.integrity.problems).toContainEqual({
      code: "implausible_lamport",
      entity: null,
      id: DEVICE_E,
    });
    expect(owned.integrity.ready).toBe(true);
    expect(owned.state.members.map((member) => member.name)).toEqual(["Пётр"]);
  });

  it("does not hand the last word to whoever writes the largest identifier", () => {
    // The tie in the ranked stamp used to be settled by the raw deviceId and opId, compared as
    // text. A UUID v4 has a largest string and anybody can write it down, so a peer calling
    // itself ffffffff-ffff-4fff-bfff-ffffffffffff won every conflict at an equal stamp — which
    // is exactly the set of conflicts the order exists to settle.
    const LARGEST_DEVICE = "ffffffff-ffff-4fff-bfff-ffffffffffff";
    const LARGEST_OP = "ffffffff-ffff-4fff-bfff-ffffffffffff";
    const journal = buildFixtureJournal();
    const base = applyJournal(journal);
    const before = base.state.members.find((member) => member.id === MEMBER_PETR);

    const stamp = 4242;
    const largest = parseOperation({
      opId: LARGEST_OP,
      deviceId: LARGEST_DEVICE,
      lamport: stamp,
      entity: "member",
      action: "update",
      targetId: MEMBER_PETR,
      fields: { name: "Пётр Захваченный", role: "member", active: true },
    });
    const honest = parseOperation({
      opId: opUuid(710),
      deviceId: DEVICE_A,
      lamport: stamp,
      entity: "member",
      action: "update",
      targetId: MEMBER_PETR,
      fields: { name: "Пётр Честный", role: "member", active: true },
    });

    // Same stamp, so the tie is all there is — and the largest identifier there is loses it.
    expect(stamp).toBeLessThan(HONEST_LAMPORT_CEILING);
    expect(compareOperations(largest, honest)).toBeLessThan(0);
    const contested = applyOperations(base, [largest, honest]);
    expect(contested.state.members.find((member) => member.id === MEMBER_PETR)?.name).toBe(
      "Пётр Честный",
    );
    // Still one winner on every replica, whichever order the two arrive in and after a restart.
    expect(applyOperations(base, [honest, largest])).toEqual(contested);
    expect(applyJournal([...journal, honest, largest])).toEqual(contested);
    expect(restoreJournal(JSON.parse(JSON.stringify(contested)) as unknown).state.members).toEqual(
      contested.state.members,
    );
    expect(before?.name).toBe("Пётр");

    // Two devices that reused one identifier for different content still produce one winner,
    // which is the reason the tie has to be settled at all.
    const twin = parseOperation({
      ...honest,
      deviceId: DEVICE_B,
      fields: { name: "Пётр Двойник", role: "member", active: true },
    });
    expect(compareOperations(honest, twin)).not.toBe(0);
    expect(applyOperations(base, [honest, twin])).toEqual(applyOperations(base, [twin, honest]));
  });

  it("gives a stamp past the honest ceiling no rank at all, and says which device wrote it", () => {
    // The clock refused the stamp and the merge did not, so one operation stamped at the
    // absolute ceiling took whatever entity it named — the first key of the total order was
    // the number the writer had chosen for itself.
    const journal = buildFixtureJournal();
    const honest = applyJournal(journal);
    const hostile = parseOperation({
      opId: opUuid(998),
      deviceId: DEVICE_E,
      lamport: MAX_LAMPORT,
      entity: "member",
      action: "update",
      targetId: MEMBER_PETR,
      fields: { name: "Пётр Захваченный", role: "member", active: true },
    });

    const after = applyOperations(honest, [hostile]);
    // The clock is not moved by it either, and that is bookkeeping about this device alone.
    expect(after.lamport).toBe(honest.lamport);
    // It loses the entity it tried to take, and leaves the journal the way every other loser of
    // the total order does: one entry per entity, nothing withheld from the family.
    expect(after.state.members.map((member) => member.name)).toEqual(["Анна", "Пётр"]);
    expect(after.entries.some((entry) => entry.opId === hostile.opId)).toBe(false);
    expect(after.integrity).toEqual({ ready: true, problems: [], withheld: [] });
    expect(honest.integrity).toEqual({ ready: true, problems: [], withheld: [] });
    expect(applyJournal([...journal, hostile])).toEqual(after);
    expect(applyJournal([hostile, ...journal])).toEqual(after);

    // What such a stamp can still own is a write nobody competes for, or a tombstone, which is
    // final whatever its stamp. That is reported, as a property of the converged journal: it
    // names the device, it does not go missing when a later batch changes nothing, and a
    // restore from the same entries says the same thing.
    const minted = parseOperation({
      opId: opUuid(999),
      deviceId: DEVICE_E,
      lamport: MAX_LAMPORT,
      entity: "member",
      action: "delete",
      targetId: MEMBER_ANNA,
    });
    const owned = applyOperations(honest, [minted]);
    expect(owned.integrity.problems).toContainEqual({
      code: "implausible_lamport",
      entity: null,
      id: DEVICE_E,
    });
    // Advisory: the stamp already costs its writer every conflict it enters, so nothing is
    // withheld on top of that and the family goes on seeing its budget.
    expect(owned.integrity.ready).toBe(true);
    expect(owned.state.members.map((member) => member.name)).toEqual(["Пётр"]);
    const rebuilt = restoreJournal(JSON.parse(JSON.stringify(owned)) as unknown);
    expect(rebuilt.integrity).toEqual(owned.integrity);
  });

  it("does not let a batch climb the skew ladder one rung at a time", () => {
    // Every stamp used to be measured against a clock the stamps before it had already raised,
    // so a batch walked as far ahead as it liked as long as each step was small enough.
    const rungs = 20;
    const ladder = Array.from({ length: rungs }, (_unused, index) =>
      parseOperation({
        opId: opUuid(70_000 + index),
        deviceId: DEVICE_E,
        lamport: (index + 1) * MAX_LAMPORT_SKEW,
        entity: "member",
        action: "create",
        targetId: `member-rung-${String(index).padStart(3, "0")}`,
        fields: SAMPLE_FIELDS.member,
      }),
    );

    // The clock refuses the second rung, whatever order the batch is read in.
    expect(() => receiveOperations(createClock(DEVICE_A), ladder)).toThrow(
      /must not be more than 1000000 ahead/,
    );
    expect(() => receiveOperations(createClock(DEVICE_A), [...ladder].reverse())).toThrow(SyncProtocolError);
    expect(receiveOperations(createClock(DEVICE_A), [ladder[0]!]).lamport).toBe(MAX_LAMPORT_SKEW);

    // And the merge adopts the first rung only, however many rungs the batch holds and in
    // whatever order it delivers them.
    const climbed = applyJournal(ladder);
    expect(climbed.lamport).toBe(MAX_LAMPORT_SKEW);
    expect(climbed.state.members).toHaveLength(rungs);
    expect(applyJournal([...ladder].reverse())).toEqual(climbed);

    // One batch per rung walks the clock all the way up, because the horizon is fixed per call
    // and the standard contract is one operation per envelope. That is not a defect and it is
    // not reported as one: the clock decides what this device stamps its own writes with and
    // nothing about the state, so two devices that took the same ladder in different batches
    // hold different clocks and still agree about the family, entry for entry.
    let stepped = createEmptyJournal();
    for (const rung of ladder) stepped = applyOperations(stepped, [rung]);
    expect(stepped.lamport).toBe(rungs * MAX_LAMPORT_SKEW);
    expect(stepped.state).toEqual(climbed.state);
    expect(stepped.entries).toEqual(climbed.entries);
    expect(stepped.integrity).toEqual(climbed.integrity);
    expect(climbed.integrity.problems).toEqual([{ code: "no_active_budget", entity: "budget", id: "" }]);
  });

  it("pulls the clock past every received operation", () => {
    const journal = buildFixtureJournal();
    const clock = receiveOperations(createClock(DEVICE_B), journal);
    const highest = journal.reduce((total, operation) => Math.max(total, operation.lamport), 0);
    expect(clock.lamport).toBe(highest);
    expect(applyJournal(journal).lamport).toBe(highest);
    expect(tickClock(clock).lamport).toBe(highest + 1);
  });
});

describe("withheld entities", () => {
  // One journal that trips every rule the gate withholds for, so no source of a withholding
  // can be added or removed without this test noticing.
  const PHANTOM_BUDGET_ID = "7bbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb2";
  const INCOME_CATEGORY_ID = "73333333-3333-4333-8333-333333333339";
  const SHARED_ID = "claimed-by-two-kinds";
  const STRAY_LINE_ID = "!products";
  const ORPHAN_GOAL_ID = "goal-of-an-account-in-flight";
  const INCOME_EXPENSE_ID = "expense-planned-on-an-income-category";
  const EARLY_REFUND_ID = "refund-dated-before-its-expense";
  const STRAY_CONTRIBUTION_ID = "contribution-to-an-unlinked-account";
  const DOLLAR_ACCOUNT_ID = "account-kept-in-dollars";
  const UNVALUED_EXPENSE_ID = "dollar-expense-without-its-rouble-value";

  function journalWithEveryWithholding(): Operation[] {
    const write = (draft: Record<string, unknown>): Operation => parseOperation(draft);
    return [
      ...buildFixtureJournal(),
      // A dollar account, and a purchase on it that carries no value in roubles: the budget could
      // not count it, so it is withheld for its currencies (plan 4.5, currency_mismatch).
      write({
        opId: opUuid(978),
        deviceId: DEVICE_B,
        lamport: 698,
        entity: "account",
        action: "create",
        targetId: DOLLAR_ACCOUNT_ID,
        fields: { ...SAMPLE_FIELDS.account, name: "Доллары", currency: "USD" },
      }),
      write({
        opId: opUuid(979),
        deviceId: DEVICE_B,
        lamport: 699,
        entity: "transaction",
        action: "create",
        targetId: UNVALUED_EXPENSE_ID,
        fields: {
          kind: "expense",
          occurredOn: "2026-07-11",
          status: "posted",
          amountMinor: 4_000,
          accountId: DOLLAR_ACCOUNT_ID,
          categoryId: PRODUCTS_CATEGORY_ID,
        },
      }),
      // Two kinds claim one identifier: the category outranks the account, so the account goes.
      write({
        opId: opUuid(981),
        deviceId: DEVICE_B,
        lamport: 700,
        entity: "account",
        action: "create",
        targetId: SHARED_ID,
        fields: SAMPLE_FIELDS.account,
      }),
      write({
        opId: opUuid(982),
        deviceId: DEVICE_B,
        lamport: 701,
        entity: "category",
        action: "create",
        targetId: SHARED_ID,
        fields: SAMPLE_FIELDS.category,
      }),
      // One category of one budget planned twice, at a stamp that loses.
      write({
        opId: opUuid(983),
        deviceId: DEVICE_B,
        lamport: 1,
        entity: "budgetLine",
        action: "create",
        targetId: STRAY_LINE_ID,
        fields: { budgetId: BUDGET_ID, categoryId: PRODUCTS_CATEGORY_ID, plannedMinor: 100_000 },
      }),
      // A goal whose account has not been delivered.
      write({
        opId: opUuid(984),
        deviceId: DEVICE_B,
        lamport: 702,
        entity: "goal",
        action: "create",
        targetId: ORPHAN_GOAL_ID,
        fields: SAMPLE_FIELDS.goal,
      }),
      // A scheduled expense planned on a category the family earns from.
      write({
        opId: opUuid(985),
        deviceId: DEVICE_B,
        lamport: 703,
        entity: "category",
        action: "create",
        targetId: INCOME_CATEGORY_ID,
        fields: { name: "Зарплата", type: "income", group: "Доходы", active: true, sortOrder: 5 },
      }),
      write({
        opId: opUuid(986),
        deviceId: DEVICE_B,
        lamport: 704,
        entity: "scheduledExpense",
        action: "create",
        targetId: INCOME_EXPENSE_ID,
        fields: {
          ...SAMPLE_FIELDS.scheduledExpense,
          categoryId: INCOME_CATEGORY_ID,
          accountId: MAIN_ACCOUNT_ID,
        },
      }),
      // A refund dated before the expense it refunds.
      write({
        opId: opUuid(987),
        deviceId: DEVICE_B,
        lamport: 705,
        entity: "transaction",
        action: "create",
        targetId: EARLY_REFUND_ID,
        fields: {
          kind: "refund",
          occurredOn: "2026-07-01",
          status: "posted",
          amountMinor: 100_000,
          accountId: MAIN_ACCOUNT_ID,
          categoryId: PRODUCTS_CATEGORY_ID,
          originalTransactionId: PRODUCTS_EXPENSE_ID,
        },
      }),
      // A goal contribution that lands on an account the goal is not linked to.
      write({
        opId: opUuid(988),
        deviceId: DEVICE_B,
        lamport: 706,
        entity: "transaction",
        action: "create",
        targetId: STRAY_CONTRIBUTION_ID,
        fields: {
          kind: "goal_contribution",
          occurredOn: "2026-07-11",
          status: "posted",
          amountMinor: 100_000,
          fromAccountId: RESERVE_ACCOUNT_ID,
          toAccountId: MAIN_ACCOUNT_ID,
          goalId: GOAL_ID,
        },
      }),
      // An activation of a budget nobody has: the pointer stays on the budget the family sees.
      write({
        opId: opUuid(989),
        deviceId: DEVICE_B,
        lamport: 707,
        entity: "budget",
        action: "activate",
        targetId: PHANTOM_BUDGET_ID,
      }),
    ];
  }

  const EXPECTED_WITHHELD = [
    { entity: "account", id: SHARED_ID, reason: "identifier_claimed_twice" },
    { entity: "budget", id: PHANTOM_BUDGET_ID, reason: "unknown_active_budget" },
    { entity: "budgetLine", id: STRAY_LINE_ID, reason: "duplicate_budget_line" },
    { entity: "goal", id: ORPHAN_GOAL_ID, reason: "unknown_reference" },
    { entity: "scheduledExpense", id: INCOME_EXPENSE_ID, reason: "wrong_category_type" },
    { entity: "transaction", id: STRAY_CONTRIBUTION_ID, reason: "goal_account_mismatch" },
    { entity: "transaction", id: UNVALUED_EXPENSE_ID, reason: "currency_mismatch" },
    { entity: "transaction", id: EARLY_REFUND_ID, reason: "invalid_refund" },
  ];

  it("names the kind, the identifier and the reason of everything it left out of the state", () => {
    const snapshot = applyJournal(journalWithEveryWithholding());

    expect(snapshot.integrity.withheld).toEqual(EXPECTED_WITHHELD);
    // Every source the protocol has is exercised above, so a new one cannot be added in
    // silence and an existing one cannot stop filling the list.
    expect([...new Set(snapshot.integrity.withheld.map((entry) => entry.reason))].sort()).toEqual(
      [...WITHHOLDING_REASONS].sort(),
    );
    // Named because it is missing: nothing on this list is in the state a consumer renders.
    for (const entry of snapshot.integrity.withheld) {
      expect(entityIds(snapshot.state, entry.entity)).not.toContain(entry.id);
    }
    // And missing from the state is not gone: the journal still holds every one of them, and
    // the activation register still holds the pointer nobody can resolve.
    for (const entry of snapshot.integrity.withheld.filter((value) => value.entity !== "budget")) {
      expect(snapshot.entries.some((held) => held.targetId === entry.id)).toBe(true);
    }
    expect(snapshot.activations.map((entry) => entry.targetId)).toContain(PHANTOM_BUDGET_ID);
  });

  it("goes on showing the family its budget while it withholds", () => {
    const snapshot = applyJournal(journalWithEveryWithholding());

    // The point of decision 40: eight withheld entities, and the family still sees the budget
    // it planned, to the kopeck. A resolved conflict freezes nobody.
    expect(snapshot.integrity.ready).toBe(true);
    expect(snapshot.state.activeBudgetId).toBe(BUDGET_ID);
    // The line the intruder tried to replace is untouched, so Продукты is what it was planned at.
    expect(productsLimitMinor(snapshot)).toBe(productsLimitMinor(applyJournal(buildFixtureJournal())));
    const plan = calculateAnnualPlan(snapshot.state, G002.startMonth, 12);
    expect(plan.currentMonth.annualReserveMinor).toBe(1_980_900);
    expect(plan.currentMonth.spendableAfterPlanMinor).toBe(4_419_100);
  });

  it("hands every replica the same list whatever order the operations arrive in", () => {
    const journal = journalWithEveryWithholding();
    const reference = applyJournal(journal);
    const random = mulberry32(40);
    for (let attempt = 0; attempt < 100; attempt += 1) {
      expect(applyJournal(shuffle(journal, random)).integrity).toEqual(reference.integrity);
    }
    // Including the replica that restarted: the list is rebuilt from the entries and the
    // register, never carried, so a stored snapshot cannot smuggle a different one back.
    const rebuilt = restoreJournal(JSON.parse(JSON.stringify(reference)) as unknown);
    expect(rebuilt.integrity).toEqual(reference.integrity);
  });

  it("is false only when the state itself cannot be shown", () => {
    const journal = buildFixtureJournal();
    const withheld = journalWithEveryWithholding();

    // No budget was ever activated: activeBudgetId is empty and every calculation over it
    // throws, so there is nothing to show and nothing was withheld either.
    const unactivated = applyJournal(journal.filter((operation) => operation.action !== "activate"));
    expect(unactivated.integrity.ready).toBe(false);
    expect(unactivated.integrity.problems).toContainEqual({
      code: "no_active_budget",
      entity: "budget",
      id: "",
    });
    expect(unactivated.integrity.withheld).toEqual([]);

    // The pointer resolves to nothing, which is the same unshowable state by another road. The
    // activation this snapshot carries is the pointer, so it is a problem rather than a
    // withholding: there is no other budget for it to have been passed over in favour of.
    const phantomOnly = applyJournal(
      withheld.filter(
        (operation) => operation.action !== "activate" || operation.targetId === PHANTOM_BUDGET_ID,
      ),
    );
    expect(phantomOnly.integrity.ready).toBe(false);
    expect(phantomOnly.integrity.problems).toContainEqual({
      code: "unknown_active_budget",
      entity: "budget",
      id: PHANTOM_BUDGET_ID,
    });
    expect(phantomOnly.integrity.withheld).not.toContainEqual({
      entity: "budget",
      id: PHANTOM_BUDGET_ID,
      reason: "unknown_active_budget",
    });
    // The same journal with the family's own activation back in it is ready, and the phantom
    // is withheld instead. Nothing else changed.
    expect(applyJournal(withheld).integrity.ready).toBe(true);
  });
});

describe("tags and labels through the journal", () => {
  // UUIDs, as the codec demands of a tag (security review MEDIUM-1).
  const TAG_HOME = tagUuid(0x401);
  const TAG_HOLIDAY = tagUuid(0x402);
  const TAGGED_EXPENSE_ID = "expense-tagged-for-the-dacha";

  function tag(targetId: string, name: string, lamport: number, opIndex: number): Operation {
    return parseOperation({
      opId: opUuid(opIndex),
      deviceId: DEVICE_B,
      lamport,
      entity: "tag",
      action: "create",
      targetId,
      fields: { name, active: true },
    });
  }

  function taggedExpense(tagIds: readonly string[], extra: Record<string, unknown> = {}): Operation {
    return parseOperation({
      opId: opUuid(1_001),
      deviceId: DEVICE_B,
      lamport: 910,
      entity: "transaction",
      action: "create",
      targetId: TAGGED_EXPENSE_ID,
      fields: {
        kind: "expense",
        occurredOn: "2026-07-12",
        status: "posted",
        amountMinor: 150_000,
        accountId: MAIN_ACCOUNT_ID,
        categoryId: PRODUCTS_CATEGORY_ID,
        note: "Рассада на дачу",
        tagIds,
        ...extra,
      },
    });
  }

  const found = (snapshot: JournalSnapshot): Transaction | undefined =>
    snapshot.state.transactions.find((item) => item.id === TAGGED_EXPENSE_ID);

  it("leaves the canonical text of the G-002 journal exactly what it was", () => {
    // Pinned before the codec learned a single new field: the kinds are appended at the end of
    // ENTITY_KINDS, every new field is optional and absent stays absent, so a journal that uses
    // none of them encodes, orders and converges byte for byte as before.
    const snapshot = applyJournal(buildFixtureJournal());
    expect(snapshot.entries).toHaveLength(28);
    expect(sha256Hex(snapshot.entries.map((entry) => encodeOperation(entry)).join("\n")))
      .toBe("8518c76130c93fc5f0282edff1869076f57353ef0fcad8c6684fd866c8588423");
    expect(sha256Hex(snapshot.activations.map((entry) => encodeOperation(entry)).join("\n")))
      .toBe("9df5e0a45dec26f541167505314af91cd8796324281a839dff50ba62f768cb12");
    // And the state promises the new list the way it promises participants: empty, not absent.
    expect(snapshot.state.tags).toEqual([]);
    // The kinds of 1.0.0 in their order, and every later one after them (plan 4.1): the order
    // sorts the entries, so a kind inserted among them would reorder this very listing.
    expect(ENTITY_KINDS.slice(0, 9)).toEqual([
      "account", "category", "budget", "budgetLine", "goal", "annualCommitment", "scheduledExpense", "transaction", "member",
    ]);
    expect(ENTITY_KINDS.slice(9, 14)).toEqual(["tag", "exchangeRate", "household", "debt", "recurringRule"]);
  });

  it("carries tags and a note across devices and through storage, without moving the money", () => {
    const journal = buildFixtureJournal();
    const plain = applyJournal(journal);
    const shown = applyJournal([
      ...journal,
      tag(TAG_HOME, "Дом", 900, 1_002),
      tag(TAG_HOLIDAY, "Дача", 901, 1_003),
      taggedExpense([TAG_HOME, TAG_HOLIDAY]),
    ]);

    expect(shown.integrity).toEqual({ ready: true, problems: [], withheld: [] });
    expect(shown.state.tags.map((item) => item.name).sort()).toEqual(["Дача", "Дом"]);
    expect(found(shown)).toMatchObject({ note: "Рассада на дачу", tagIds: [TAG_HOME, TAG_HOLIDAY], amountMinor: 150_000 });
    expect(found(restoreJournal(JSON.parse(JSON.stringify(shown)) as unknown))?.tagIds).toEqual([TAG_HOME, TAG_HOLIDAY]);
    // The state is one the domain accepts whole, and labels decide nothing in it.
    expect(calculateBudget(shown.state).expensesMinor).toBe(calculateBudget(plain.state).expensesMinor + 150_000);
    expect(() => calculateMemberExpenses(shown.state)).not.toThrow();
    expect(() => calculateAnnualPlan(shown.state, G002.startMonth, 12)).not.toThrow();
  });

  it("takes off a tag that is gone or has not arrived, keeps the rest, and gives it back when it lands", () => {
    const journal = buildFixtureJournal();
    const home = tag(TAG_HOME, "Дом", 900, 1_002);
    const holiday = tag(TAG_HOLIDAY, "Дача", 901, 1_003);
    const expense = taggedExpense([TAG_HOME, TAG_HOLIDAY]);

    // Дача has not been delivered yet: the expense stays, to the kopeck, tagged with what resolves.
    const early = applyJournal([...journal, home, expense]);
    expect(found(early)?.tagIds).toEqual([TAG_HOME]);
    expect(found(early)?.amountMinor).toBe(150_000);
    expect(early.integrity.withheld).toEqual([]);
    expect(early.integrity.problems).toEqual([{ code: "unknown_reference", entity: "transaction", id: TAGGED_EXPENSE_ID }]);
    expect(() => calculateBudget(early.state)).not.toThrow();

    const arrived = applyOperations(early, [holiday]);
    expect(found(arrived)?.tagIds).toEqual([TAG_HOME, TAG_HOLIDAY]);
    expect(arrived.integrity.problems).toEqual([]);

    // Both deleted while the expense was in flight: the field goes, not to an empty list.
    const deletions = [TAG_HOME, TAG_HOLIDAY].map((targetId, index) => parseOperation({
      opId: opUuid(1_010 + index),
      deviceId: DEVICE_C,
      lamport: 920 + index,
      entity: "tag",
      action: "delete",
      targetId,
    }));
    const untagged = applyJournal([...journal, home, holiday, expense, ...deletions]);
    const kept = found(untagged);
    expect(kept?.amountMinor).toBe(150_000);
    expect(kept !== undefined && "tagIds" in kept).toBe(false);
    expect(kept?.note).toBe("Рассада на дачу");
    expect(untagged.state.tags).toEqual([]);
    expect(calculateBudget(untagged.state).expensesMinor).toBe(calculateBudget(arrived.state).expensesMinor);

    // Every replica, every delivery order, and a restart all say the same.
    const random = mulberry32(34);
    const reference = applyJournal([...journal, home, expense]);
    for (let attempt = 0; attempt < 20; attempt += 1) {
      const shuffled = applyJournal(shuffle([...journal, home, expense], random));
      expect(shuffled.state).toEqual(reference.state);
      expect(shuffled.integrity).toEqual(reference.integrity);
    }
    expect(restoreJournal(JSON.parse(JSON.stringify(reference)) as unknown).state).toEqual(reference.state);
  });

  // Orchestrator step 13: rules travel through the journal now, so the label goes only when it names
  // no rule the journal holds — as here; "recurring rules through the journal" keeps one that it does.
  it("takes off a recurring-rule label that names no rule the journal holds", () => {
    const journal = buildFixtureJournal();
    const snapshot = applyJournal([...journal, taggedExpense([tagUuid(0x4ff)], { recurringRuleId: testUuid(0x7b0, 0x4ff) })]);
    const kept = found(snapshot);

    expect(kept?.amountMinor).toBe(150_000);
    expect(kept !== undefined && ("recurringRuleId" in kept || "tagIds" in kept)).toBe(false);
    expect(snapshot.integrity.problems).toEqual([{ code: "unknown_reference", entity: "transaction", id: TAGGED_EXPENSE_ID }]);
    expect(() => calculateBudget(snapshot.state)).not.toThrow();
  });

  it("settles a tag and another entity claiming one identifier like any other pair, and the label follows", () => {
    const journal = buildFixtureJournal();
    // A tag written under the identifier of the family's main account, ranked lower: it loses.
    const intruder = parseOperation({
      opId: opUuid(1_020),
      deviceId: DEVICE_C,
      lamport: 1,
      entity: "tag",
      action: "create",
      targetId: MAIN_ACCOUNT_ID,
      fields: { name: "Захват", active: true },
    });
    const snapshot = applyJournal([...journal, intruder, taggedExpense([MAIN_ACCOUNT_ID])]);

    expect(snapshot.integrity.withheld).toContainEqual({ entity: "tag", id: MAIN_ACCOUNT_ID, reason: "identifier_claimed_twice" });
    expect(snapshot.state.tags).toEqual([]);
    expect(snapshot.state.accounts.map((item) => item.id)).toContain(MAIN_ACCOUNT_ID);
    expect(found(snapshot) !== undefined && "tagIds" in found(snapshot)!).toBe(false);
    expect(new Set(allStateIds(snapshot.state)).size).toBe(allStateIds(snapshot.state).length);
  });

  it("reports a state holding more tags than a document may, and still shows all of them", () => {
    // Several devices creating offline can pass the limit together, and none of them did anything
    // wrong: nothing is withheld, the family keeps seeing everything, and the count is reported.
    const journal = buildFixtureJournal();
    const tags = Array.from({ length: COLLECTION_LIMITS.tags + 1 }, (_, index) =>
      tag(testUuid(0x7a6, index), `Метка ${index}`, 1_000 + index, 20_000 + index));
    const atLimit = applyJournal([...journal, ...tags.slice(1)]);
    expect(atLimit.integrity.problems).toEqual([]);

    const over = applyJournal([...journal, ...tags]);
    expect(over.integrity.ready).toBe(true);
    expect(over.integrity.withheld).toEqual([]);
    expect(over.integrity.problems).toEqual([{ code: "collection_limit", entity: "tag", id: "" }]);
    expect(over.state.tags).toHaveLength(COLLECTION_LIMITS.tags + 1);
  });

  it("carries display fields of accounts, categories and goals into the state", () => {
    const journal = buildFixtureJournal();
    const account = journal.find((item) => item.action === "create" && item.entity === "account" && item.targetId === MAIN_ACCOUNT_ID);
    if (account === undefined || account.action !== "create" || account.entity !== "account") throw new Error("fixture account is missing");
    const decorated = parseOperation({
      ...account,
      opId: opUuid(1_030),
      lamport: 930,
      action: "update",
      fields: { ...account.fields, sortOrder: 20, icon: "banknote", color: "sage", includeInTotal: false },
    });
    const snapshot = applyJournal([...journal, decorated]);

    expect(snapshot.state.accounts.find((item) => item.id === MAIN_ACCOUNT_ID))
      .toMatchObject({ sortOrder: 20, icon: "banknote", color: "sage", includeInTotal: false });
    expect(calculateBudget(snapshot.state)).toEqual(calculateBudget(applyJournal(journal).state));
  });
});

describe("several currencies through the journal", () => {
  const DOLLARS = "7c000000-0000-4000-8000-0000000000d1";
  const DOLLAR_EXPENSE = "7c000000-0000-4000-8000-0000000000d2";
  const TRANSFER = "7c000000-0000-4000-8000-0000000000d3";
  const RATE_JULY = "7c000000-0000-4000-8000-0000000000e1";
  const RATE = { baseMinor: 9_000, quoteMinor: 100 };
  let nextOp = 30_000;

  function write(entity: string, targetId: string, fields: unknown, lamport = 950, action: "create" | "update" = "create"): Operation {
    nextOp += 1;
    return parseOperation({ opId: opUuid(nextOp), deviceId: DEVICE_B, lamport, entity, action, targetId, fields });
  }

  const dollarAccount = (lamport = 950, currency = "USD"): Operation =>
    write("account", DOLLARS, { name: "Доллары", type: "savings", currency, openingBalanceMinor: 50_000, active: true }, lamport, lamport === 950 ? "create" : "update");

  function expense(extra: Record<string, unknown> = {}, accountId = DOLLARS): Operation {
    return write("transaction", DOLLAR_EXPENSE, {
      kind: "expense",
      occurredOn: "2026-07-10",
      status: "posted",
      amountMinor: 4_000,
      accountId,
      categoryId: PRODUCTS_CATEGORY_ID,
      baseAmountMinor: 360_000,
      baseCurrency: "RUB",
      rate: RATE,
      ...extra,
    });
  }

  function withoutSnapshot(operation: Operation): Operation {
    if (operation.action !== "create" || operation.entity !== "transaction") throw new Error("not a transaction write");
    const { baseAmountMinor: _amount, baseCurrency: _currency, rate: _rate, ...plain } = operation.fields as Record<string, unknown>;
    return parseOperation({ ...operation, fields: plain });
  }

  function transfer(extra: Record<string, unknown> = {}, toAccountId = DOLLARS): Operation {
    return write("transaction", TRANSFER, {
      kind: "transfer",
      occurredOn: "2026-07-05",
      status: "posted",
      amountMinor: 1_800_000,
      fromAccountId: MAIN_ACCOUNT_ID,
      toAccountId,
      ...extra,
    });
  }

  const withheldOf = (snapshot: JournalSnapshot) => snapshot.integrity.withheld;

  it("shows a dollar account, its purchase at the rouble value it carries, and the rates", () => {
    const journal = buildFixtureJournal();
    const plain = applyJournal(journal);
    const snapshot = applyJournal([
      ...journal,
      dollarAccount(),
      expense(),
      transfer({ toAmountMinor: 20_000 }),
      write("exchangeRate", RATE_JULY, { currency: "USD", baseCurrency: "RUB", date: "2026-06-30", rate: RATE }),
    ]);

    expect(snapshot.integrity).toEqual({ ready: true, problems: [], withheld: [] });
    expect(snapshot.state.exchangeRates).toEqual([{ id: RATE_JULY, currency: "USD", baseCurrency: "RUB", date: "2026-06-30", rate: RATE }]);
    expect("household" in snapshot.state).toBe(false);
    const metrics = calculateBudget(snapshot.state);
    expect(metrics.grossExpensesMinor).toBe(calculateBudget(plain.state).grossExpensesMinor + 360_000);
    expect(metrics.accountBalancesMinor[DOLLARS]).toBe(50_000 - 4_000 + 20_000);
    // Capital stays the roubles: the dollars are not added to it as kopecks.
    expect(metrics.capitalMinor).toBe(calculateBudget(plain.state).capitalMinor - 1_800_000);
    expect(() => calculateAnnualPlan(snapshot.state, G002.startMonth, 12)).not.toThrow();
    expect(() => calculateMemberExpenses(snapshot.state)).not.toThrow();
  });

  it("withholds an operation whose currencies do not fit, and nothing else", () => {
    const journal = [...buildFixtureJournal(), dollarAccount()];
    const cases: readonly (readonly [string, Operation])[] = [
      ["a dollar purchase without its rouble value", withoutSnapshot(expense())],
      ["a rouble purchase with a snapshot", expense({}, MAIN_ACCOUNT_ID)],
      ["a snapshot in another base", expense({ baseCurrency: "EUR" })],
      ["a transfer between currencies without what arrived", transfer()],
      ["a transfer within roubles that names what arrived", transfer({ toAmountMinor: 100 }, RESERVE_ACCOUNT_ID)],
      ["a contribution from dollars to a rouble goal", write("transaction", TRANSFER, { kind: "goal_contribution", occurredOn: "2026-07-06", status: "posted", amountMinor: 100, fromAccountId: DOLLARS, toAccountId: RESERVE_ACCOUNT_ID, goalId: GOAL_ID })],
    ];
    for (const [label, operation] of cases) {
      const snapshot = applyJournal([...journal, operation]);
      expect(withheldOf(snapshot), label).toEqual([{ entity: "transaction", id: operation.targetId, reason: "currency_mismatch" }]);
      expect(snapshot.integrity.problems, label).toEqual([{ code: "currency_mismatch", entity: "transaction", id: operation.targetId }]);
      expect(snapshot.integrity.ready, label).toBe(true);
      expect(() => calculateBudget(snapshot.state), label).not.toThrow();
      expect(() => calculateMemberExpenses(snapshot.state), label).not.toThrow();
    }
  });

  it("withholds a plan on an account outside the base currency", () => {
    const journal = [...buildFixtureJournal(), dollarAccount()];
    const goal = write("goal", "7c000000-0000-4000-8000-0000000000f1", { ...SAMPLE_FIELDS.goal, linkedAccountId: DOLLARS });
    const commitment = write("annualCommitment", "7c000000-0000-4000-8000-0000000000f2", { ...SAMPLE_FIELDS.annualCommitment, accountId: DOLLARS, categoryId: PRODUCTS_CATEGORY_ID });
    const schedule = write("scheduledExpense", "7c000000-0000-4000-8000-0000000000f3", { ...SAMPLE_FIELDS.scheduledExpense, accountId: DOLLARS, categoryId: PRODUCTS_CATEGORY_ID });
    const snapshot = applyJournal([...journal, goal, commitment, schedule]);

    expect(withheldOf(snapshot)).toEqual([
      { entity: "goal", id: goal.targetId, reason: "currency_mismatch" },
      { entity: "annualCommitment", id: commitment.targetId, reason: "currency_mismatch" },
      { entity: "scheduledExpense", id: schedule.targetId, reason: "currency_mismatch" },
    ]);
    const plan = calculateAnnualPlan(snapshot.state, G002.startMonth, 12);
    expect(plan.currentMonth.annualReserveMinor).toBe(1_980_900);
    expect(plan.currentMonth.spendableAfterPlanMinor).toBe(4_419_100);
  });

  it("settles a change of currency made while another device wrote against the old one", () => {
    // Device B writes a rouble purchase on the account; device C turns the account into dollars at
    // the same time. Whatever the order, every replica withholds the purchase, and turning the
    // account back brings it back by itself.
    const journal = buildFixtureJournal();
    const roubles = dollarAccount(950, "RUB");
    const purchase = withoutSnapshot(expense());
    const toDollars = dollarAccount(960, "USD");
    const all = [...journal, roubles, purchase, toDollars];
    const reference = applyJournal(all);

    expect(withheldOf(reference)).toEqual([{ entity: "transaction", id: DOLLAR_EXPENSE, reason: "currency_mismatch" }]);
    const random = mulberry32(31);
    for (let attempt = 0; attempt < 20; attempt += 1) {
      const shuffled = applyJournal(shuffle(all, random));
      expect(shuffled.state).toEqual(reference.state);
      expect(shuffled.integrity).toEqual(reference.integrity);
    }
    expect(restoreJournal(JSON.parse(JSON.stringify(reference)) as unknown).integrity).toEqual(reference.integrity);
    const back = applyOperations(reference, [dollarAccount(970, "RUB")]);
    expect(withheldOf(back)).toEqual([]);
    expect(back.state.transactions.map((item) => item.id)).toContain(DOLLAR_EXPENSE);
  });

  it("counts in the household's base currency when the household names one", () => {
    const journal = buildFixtureJournal();
    const plain = applyJournal(journal);
    const roubles = applyJournal([...journal, write("household", HOUSEHOLD_ID, { baseCurrency: "RUB" })]);
    expect(roubles.state.household).toEqual({ id: HOUSEHOLD_ID, baseCurrency: "RUB" });
    expect(calculateBudget(roubles.state)).toEqual(calculateBudget(plain.state));

    // A base changed under operations already written is the case the plan does not support: the
    // rouble operations no longer fit, and they are withheld rather than counted as dollars.
    const dollars = applyJournal([...journal, write("household", HOUSEHOLD_ID, { baseCurrency: "USD" })]);
    expect(withheldOf(dollars).map((item) => item.reason)).toContain("currency_mismatch");
    expect(dollars.state.transactions).toEqual([]);
    expect(dollars.state.goals).toEqual([]);
    expect(dollars.integrity.ready).toBe(true);
    expect(() => calculateBudget(dollars.state)).not.toThrow();
  });

  it("measures the totals in the base currency, the way the domain adds them", () => {
    // A thousand and one purchases of one cent, each worth the field ceiling in roubles: the gross
    // expenses the domain builds pass the totals ceiling, although the amounts on the wire are tiny.
    const count = MAX_AGGREGATE_MINOR / MAX_MONEY_MINOR + 1;
    const purchases = Array.from({ length: count }, (_, index) => parseOperation({
      opId: opUuid(40_000 + index),
      deviceId: DEVICE_B,
      lamport: 2_000 + index,
      entity: "transaction",
      action: "create",
      targetId: `7c100000-0000-4000-8000-${String(index).padStart(12, "0")}`,
      fields: { kind: "expense", occurredOn: "2026-07-10", status: "posted", amountMinor: 1, accountId: DOLLARS, categoryId: PRODUCTS_CATEGORY_ID, baseAmountMinor: MAX_MONEY_MINOR, baseCurrency: "RUB", rate: { baseMinor: 10 ** 10, quoteMinor: 1 } },
    }));
    const snapshot = applyJournal([...buildFixtureJournal(), dollarAccount(), ...purchases]);
    expect(snapshot.integrity.problems).toEqual([{ code: "amount_out_of_range", entity: null, id: "" }]);
    // And dollar balances are not part of capital: a thousand and one of them at the ceiling pass
    // the totals ceiling together only if they are added to the roubles, which the domain never does.
    const accounts = (currency: string) => Array.from({ length: count }, (_, index) => parseOperation({
      opId: opUuid(50_000 + index),
      deviceId: DEVICE_B,
      lamport: 3_000 + index,
      entity: "account",
      action: "create",
      targetId: `7c200000-0000-4000-8000-${String(index).padStart(12, "0")}`,
      fields: { name: "Счёт", type: "savings", currency, openingBalanceMinor: MAX_MONEY_MINOR, active: true },
    }));
    // A thousand and one accounts are also more than a document may hold, which is said against the
    // kind (collection_limit) whatever their currency; only the roubles reach the totals ceiling.
    expect(applyJournal([...buildFixtureJournal(), ...accounts("USD")]).integrity.problems)
      .toEqual([{ code: "collection_limit", entity: "account", id: "" }]);
    expect(applyJournal([...buildFixtureJournal(), ...accounts("RUB")]).integrity.problems)
      .toEqual([{ code: "amount_out_of_range", entity: null, id: "" }, { code: "collection_limit", entity: "account", id: "" }]);
  });

  it("keeps a deleted rate harmless: nothing refers to one", () => {
    const journal = [...buildFixtureJournal(), dollarAccount(), expense(), write("exchangeRate", RATE_JULY, { currency: "USD", baseCurrency: "RUB", date: "2026-06-30", rate: RATE })];
    const deleted = applyOperations(applyJournal(journal), [parseOperation({ opId: opUuid(39_999), deviceId: DEVICE_C, lamport: 990, entity: "exchangeRate", action: "delete", targetId: RATE_JULY })]);
    expect(deleted.state.exchangeRates).toEqual([]);
    expect(deleted.integrity).toEqual({ ready: true, problems: [], withheld: [] });
    expect(calculateBudget(deleted.state)).toEqual(calculateBudget(applyJournal(journal).state));
  });
});

describe("debts through the journal", () => {
  const PETYA = "7d000000-0000-4000-8000-0000000000d1";

  function debt(lamport: number, fields: Record<string, unknown> = SAMPLE_FIELDS.debt, action: "create" | "update" = "create"): Operation {
    return parseOperation({ opId: opUuid(60_000 + lamport), deviceId: DEVICE_B, lamport, entity: "debt", action, targetId: PETYA, fields });
  }

  it("carries a debt into the state without moving a kopeck of the budget", () => {
    const journal = buildFixtureJournal();
    const snapshot = applyJournal([...journal, debt(950)]);
    expect(snapshot.integrity).toEqual({ ready: true, problems: [], withheld: [] });
    expect(snapshot.state.debts).toEqual([{ id: PETYA, ...SAMPLE_FIELDS.debt }]);
    expect(calculateBudget(snapshot.state)).toEqual(calculateBudget(applyJournal(journal).state));
    expect(calculateDebts(snapshot.state, "2026-07-31").receivableInBaseMinor).toBe(300_000);
    expect(restoreJournal(JSON.parse(JSON.stringify(snapshot)) as unknown).state.debts).toEqual(snapshot.state.debts);
  });

  function movement(id: string, lamport: number, fields: Record<string, unknown>): Operation {
    return parseOperation({
      opId: opUuid(62_000 + lamport), deviceId: DEVICE_B, lamport, entity: "transaction", action: "create", targetId: id,
      fields: { kind: "debt_out", occurredOn: "2026-07-07", status: "posted", amountMinor: 500_000, accountId: MAIN_ACCOUNT_ID, debtId: PETYA, ...fields },
    });
  }
  const LENT = "7d000000-0000-4000-8000-0000000000e1";
  const REPAID = "7d000000-0000-4000-8000-0000000000e2";

  it("moves the account and the debt, and no figure of the budget", () => {
    const journal = buildFixtureJournal();
    const plain = applyJournal(journal);
    const snapshot = applyJournal([...journal, debt(950, { ...SAMPLE_FIELDS.debt, openingMinor: 0 }), movement(LENT, 951, {}), movement(REPAID, 952, { kind: "debt_in", amountMinor: 200_000, occurredOn: "2026-07-25" })]);
    expect(snapshot.integrity).toEqual({ ready: true, problems: [], withheld: [] });
    const before = calculateBudget(plain.state);
    const after = calculateBudget(snapshot.state);
    expect(after.incomeMinor).toBe(before.incomeMinor);
    expect(after.expensesMinor).toBe(before.expensesMinor);
    expect(after.accountBalancesMinor[MAIN_ACCOUNT_ID]).toBe(before.accountBalancesMinor[MAIN_ACCOUNT_ID]! - 300_000);
    expect(calculateDebts(snapshot.state, "2026-07-31").byDebt[PETYA]?.balanceMinor).toBe(300_000);
  });

  it("withholds a movement whose debt is gone or has not arrived, and gives it back when it lands", () => {
    const journal = buildFixtureJournal();
    const early = applyJournal([...journal, movement(LENT, 951, {})]);
    expect(early.integrity.withheld).toEqual([{ entity: "transaction", id: LENT, reason: "unknown_reference" }]);
    expect(() => calculateBudget(early.state)).not.toThrow();
    const arrived = applyOperations(early, [debt(950)]);
    expect(arrived.integrity.withheld).toEqual([]);
    expect(arrived.state.transactions.map((item) => item.id)).toContain(LENT);
    // A deleted debt keeps it withheld for good: the money has nothing to be shown against.
    const deleted = applyOperations(arrived, [parseOperation({ opId: opUuid(62_999), deviceId: DEVICE_C, lamport: 990, entity: "debt", action: "delete", targetId: PETYA })]);
    expect(deleted.integrity.withheld).toEqual([{ entity: "transaction", id: LENT, reason: "unknown_reference" }]);
    expect(deleted.state.debts).toEqual([]);
  });

  it("withholds a movement whose amounts do not fit the currencies of the account and the debt", () => {
    const journal = [...buildFixtureJournal(), debt(950, { ...SAMPLE_FIELDS.debt, currency: "USD" })];
    const unconverted = applyJournal([...journal, movement(LENT, 951, {})]);
    expect(unconverted.integrity.withheld).toEqual([{ entity: "transaction", id: LENT, reason: "currency_mismatch" }]);
    const converted = applyJournal([...journal, movement(LENT, 951, { debtAmountMinor: 5_500 })]);
    expect(converted.integrity.withheld).toEqual([]);
    expect(calculateDebts(converted.state, "2026-07-31").byDebt[PETYA]?.outMinor).toBe(5_500);
    const extra = applyJournal([...buildFixtureJournal(), debt(950), movement(LENT, 951, { debtAmountMinor: 5_000 })]);
    expect(extra.integrity.withheld).toEqual([{ entity: "transaction", id: LENT, reason: "currency_mismatch" }]);
  });

  it("measures a debt's balance among the totals the domain must survive", () => {
    const count = MAX_AGGREGATE_MINOR / MAX_MONEY_MINOR + 1;
    const lending = Array.from({ length: count }, (_, index) => parseOperation({
      opId: opUuid(63_000 + index), deviceId: DEVICE_B, lamport: 3_000 + index, entity: "transaction", action: "create",
      targetId: `7d200000-0000-4000-8000-${String(index).padStart(12, "0")}`,
      fields: { kind: "debt_in", occurredOn: "2026-07-07", status: "posted", amountMinor: 1, accountId: MAIN_ACCOUNT_ID, debtId: PETYA, debtAmountMinor: MAX_MONEY_MINOR },
    }));
    const snapshot = applyJournal([...buildFixtureJournal(), debt(950, { ...SAMPLE_FIELDS.debt, currency: "USD" }), ...lending]);
    expect(snapshot.integrity.problems).toEqual([{ code: "amount_out_of_range", entity: null, id: "" }]);
  });

  it("reports more debts than a document may hold, and shows all of them", () => {
    const debts = Array.from({ length: COLLECTION_LIMITS.debts + 1 }, (_, index) => parseOperation({
      opId: opUuid(61_000 + index), deviceId: DEVICE_B, lamport: 1_000 + index, entity: "debt", action: "create",
      targetId: testUuid(0x7d1, index), fields: { ...SAMPLE_FIELDS.debt, counterparty: `Сосед ${index}` },
    }));
    const snapshot = applyJournal([...buildFixtureJournal(), ...debts]);
    expect(snapshot.integrity.ready).toBe(true);
    expect(snapshot.integrity.problems).toEqual([{ code: "collection_limit", entity: "debt", id: "" }]);
    expect(snapshot.state.debts).toHaveLength(COLLECTION_LIMITS.debts + 1);
  });
});

describe("counts of every kind", () => {
  it("reports more accounts and budget lines than a document may hold, withholds none, and stays ready", () => {
    // Two devices that each opened sixty accounts offline meet with a hundred and twenty: honest
    // work, and once a state the app refused, on every device, for a count.
    const accounts = Array.from({ length: COLLECTION_LIMITS.accounts + 1 }, (_, index) => parseOperation({
      opId: opUuid(64_000 + index), deviceId: index % 2 === 0 ? DEVICE_A : DEVICE_B, lamport: 1_000 + index,
      entity: "account", action: "create", targetId: testUuid(0x7a1, index),
      fields: { name: `Счёт ${index}`, type: "cash", currency: "RUB", openingBalanceMinor: 0, active: true },
    }));
    const categories = Array.from({ length: COLLECTION_LIMITS.linesPerBudget + 1 }, (_, index) => parseOperation({
      opId: opUuid(65_000 + index), deviceId: DEVICE_B, lamport: 2_000 + index, entity: "category", action: "create",
      targetId: testUuid(0x7c1, index),
      fields: { name: `Категория ${index}`, type: "expense", group: "everyday", active: true, sortOrder: 1_000 + index },
    }));
    const lines = categories.map((category, index) => parseOperation({
      opId: opUuid(66_000 + index), deviceId: DEVICE_B, lamport: 3_000 + index, entity: "budgetLine", action: "create",
      targetId: testUuid(0x7b1, index), fields: { budgetId: BUDGET_ID, categoryId: category.targetId, plannedMinor: 100 },
    }));
    const snapshot = applyJournal([...buildFixtureJournal(), ...accounts, ...categories, ...lines]);
    expect(snapshot.integrity.ready).toBe(true);
    expect(snapshot.integrity.withheld).toEqual([]);
    expect(snapshot.integrity.problems).toEqual([
      { code: "collection_limit", entity: "account", id: "" },
      { code: "collection_limit", entity: "budgetLine", id: "" },
      { code: "collection_limit", entity: "category", id: "" },
    ]);
    expect(snapshot.state.accounts.length).toBeGreaterThan(COLLECTION_LIMITS.accounts);
    expect(snapshot.state.budgets.find((budget) => budget.id === BUDGET_ID)!.lines.length).toBeGreaterThan(COLLECTION_LIMITS.linesPerBudget);
    expect(() => calculateBudget(snapshot.state)).not.toThrow();
  });
});

describe("recurring rules through the journal", () => {
  const RULE = "7f000000-0000-4000-8000-0000000000a1";
  const DOLLARS = "7f000000-0000-4000-8000-0000000000c1";
  const TAG = tagUuid(0x7f1);
  const WATER = { kind: "expense", amountMinor: 150_000, accountId: MAIN_ACCOUNT_ID, categoryId: PRODUCTS_CATEGORY_ID, note: "Доставка воды" };
  const RULE_FIELDS = { name: "Доставка воды", template: WATER, frequency: "weekly", interval: 2, startDate: "2026-07-07", active: true };
  const FIRST = recurringOccurrenceId(RULE, "2026-07-07");
  let nextOp = 70_000;

  function write(entity: EntityKind, targetId: string, fields: unknown, lamport = 950, device = DEVICE_B, action: "create" | "update" = "create"): Operation {
    nextOp += 1;
    return parseOperation({ opId: opUuid(nextOp), deviceId: device, lamport, entity, action, targetId, fields });
  }

  const rule = (template: unknown = WATER, lamport = 950, extra: Record<string, unknown> = {}): Operation =>
    write("recurringRule", RULE, { ...RULE_FIELDS, template, ...extra }, lamport);

  /** The occurrence of the water delivery on 7 July, as materializeRecurring writes it. */
  const occurrence = (lamport = 951, device = DEVICE_B): Operation => write("transaction", FIRST, {
    kind: "expense", occurredOn: "2026-07-07", status: "posted", amountMinor: 150_000,
    accountId: MAIN_ACCOUNT_ID, categoryId: PRODUCTS_CATEGORY_ID, note: "Доставка воды", recurringRuleId: RULE,
  }, lamport, device);

  const ruleOf = (snapshot: JournalSnapshot) => snapshot.state.recurringRules.find((item) => item.id === RULE);
  const firstOf = (snapshot: JournalSnapshot) => snapshot.state.transactions.find((item) => item.id === FIRST);

  it("carries a rule into the state, and its occurrence keeps its label", () => {
    const snapshot = applyJournal([...buildFixtureJournal(), rule(), occurrence()]);
    expect(snapshot.integrity).toEqual({ ready: true, problems: [], withheld: [] });
    expect(snapshot.state.recurringRules).toEqual([{ id: RULE, ...RULE_FIELDS }]);
    expect(firstOf(snapshot)?.recurringRuleId).toBe(RULE);
    // The domain accepts what the journal shows, and writes the rest of the month from it: the day
    // another device already wrote is passed over under its derived identifier.
    expect(materializeRecurring(snapshot.state, "2026-07-31").created.map((item) => item.occurredOn)).toEqual(["2026-07-21"]);
    expect(restoreJournal(JSON.parse(JSON.stringify(snapshot)) as unknown).state).toEqual(snapshot.state);
    // A journal without rules promises the list, empty.
    expect(applyJournal(buildFixtureJournal()).state.recurringRules).toEqual([]);
  });

  it("writes one operation for a day two devices materialised offline", () => {
    const journal = buildFixtureJournal();
    const watermark = (device: string, lamport: number) =>
      write("recurringRule", RULE, { ...RULE_FIELDS, materializedThrough: "2026-07-31" }, lamport, device, "update");
    const operations = [rule(), occurrence(960, DEVICE_B), occurrence(960, DEVICE_C), watermark(DEVICE_B, 961), watermark(DEVICE_C, 961)];
    const reference = applyJournal([...journal, ...operations]);
    expect(reference.state.transactions.filter((item) => item.id === FIRST)).toHaveLength(1);
    expect(ruleOf(reference)?.materializedThrough).toBe("2026-07-31");
    expect(reference.integrity.withheld).toEqual([]);
    const random = mulberry32(0x7f);
    for (let attempt = 0; attempt < 10; attempt += 1) {
      expect(applyJournal(shuffle([...journal, ...operations], random)).state).toEqual(reference.state);
    }
  });

  it("takes the label off the occurrences of a deleted rule, and keeps every kopeck", () => {
    const labelled = applyJournal([...buildFixtureJournal(), rule(), occurrence()]);
    const deleted = applyOperations(labelled, [parseOperation({ opId: opUuid(71_999), deviceId: DEVICE_C, lamport: 990, entity: "recurringRule", action: "delete", targetId: RULE })]);
    expect(deleted.state.recurringRules).toEqual([]);
    expect(firstOf(deleted)).toBeDefined();
    expect(firstOf(deleted) !== undefined && "recurringRuleId" in firstOf(deleted)!).toBe(false);
    expect(deleted.integrity.problems).toEqual([{ code: "unknown_reference", entity: "transaction", id: FIRST }]);
    expect(deleted.integrity.withheld).toEqual([]);
    expect(calculateBudget(deleted.state)).toEqual(calculateBudget(labelled.state));
  });

  it("withholds a rule whose template names an account or an expense category that is not there, and gives it back", () => {
    const journal = buildFixtureJournal();
    const early = applyJournal([...journal, rule({ ...WATER, accountId: "account-late" }), occurrence()]);
    expect(early.integrity.withheld).toEqual([{ entity: "recurringRule", id: RULE, reason: "unknown_reference" }]);
    // The occurrence is an ordinary operation: it stays, and only the label of a rule nobody sees goes.
    expect(firstOf(early)?.amountMinor).toBe(150_000);
    expect(firstOf(early) !== undefined && "recurringRuleId" in firstOf(early)!).toBe(false);
    expect(() => calculateBudget(early.state)).not.toThrow();
    const arrived = applyOperations(early, [write("account", "account-late", SAMPLE_FIELDS.account, 990)]);
    expect(arrived.integrity.withheld).toEqual([]);
    expect(firstOf(arrived)?.recurringRuleId).toBe(RULE);

    const salary = write("category", SALARY_CATEGORY_ID, { name: "Зарплата", type: "income", group: "Доходы", active: true, sortOrder: 90 }, 940);
    const wrongSide = applyJournal([...journal, salary, rule({ ...WATER, categoryId: SALARY_CATEGORY_ID })]);
    expect(wrongSide.integrity.withheld).toEqual([{ entity: "recurringRule", id: RULE, reason: "wrong_category_type" }]);
    const noCategory = applyJournal([...journal, rule({ ...WATER, categoryId: "category-late" })]);
    expect(noCategory.integrity.withheld).toEqual([{ entity: "recurringRule", id: RULE, reason: "unknown_reference" }]);
    const transferFrom = applyJournal([...journal, rule({ kind: "transfer", amountMinor: 100, fromAccountId: "account-late", toAccountId: MAIN_ACCOUNT_ID })]);
    expect(transferFrom.integrity.withheld).toEqual([{ entity: "recurringRule", id: RULE, reason: "unknown_reference" }]);
  });

  it("withholds a transfer rule whose currencies do not fit", () => {
    const journal = [...buildFixtureJournal(), write("account", DOLLARS, { ...SAMPLE_FIELDS.account, name: "Доллары", currency: "USD" }, 940)];
    const across = { kind: "transfer", amountMinor: 1_800_000, fromAccountId: MAIN_ACCOUNT_ID, toAccountId: DOLLARS };
    expect(applyJournal([...journal, rule(across)]).integrity.withheld)
      .toEqual([{ entity: "recurringRule", id: RULE, reason: "currency_mismatch" }]);
    const converted = applyJournal([...journal, rule({ ...across, toAmountMinor: 20_000 })]);
    expect(converted.integrity.withheld).toEqual([]);
    expect(() => calculateBudget(converted.state)).not.toThrow();
    const within = { kind: "transfer", amountMinor: 100, fromAccountId: MAIN_ACCOUNT_ID, toAccountId: RESERVE_ACCOUNT_ID, toAmountMinor: 100 };
    expect(applyJournal([...journal, rule(within)]).integrity.withheld)
      .toEqual([{ entity: "recurringRule", id: RULE, reason: "currency_mismatch" }]);
  });

  it("takes off the category of an income template and template tags that are not there, and keeps the rule", () => {
    const journal = buildFixtureJournal();
    const income = { kind: "income", amountMinor: 12_000_000, accountId: MAIN_ACCOUNT_ID, categoryId: SALARY_CATEGORY_ID, tagIds: [TAG] };
    const early = applyJournal([...journal, rule(income)]);
    expect(early.integrity.withheld).toEqual([]);
    expect(early.integrity.problems).toEqual([{ code: "unknown_reference", entity: "recurringRule", id: RULE }]);
    expect(ruleOf(early)?.template).toEqual({ kind: "income", amountMinor: 12_000_000, accountId: MAIN_ACCOUNT_ID });
    expect(() => calculateBudget(early.state)).not.toThrow();

    const arrived = applyOperations(early, [
      write("category", SALARY_CATEGORY_ID, { name: "Зарплата", type: "income", group: "Доходы", active: true, sortOrder: 90 }, 990),
      write("tag", TAG, { name: "Дом", active: true }, 991),
    ]);
    expect(arrived.integrity.problems).toEqual([]);
    expect(ruleOf(arrived)?.template).toEqual(income);

    const wrongSide = applyJournal([...journal, rule({ kind: "income", amountMinor: 1, accountId: MAIN_ACCOUNT_ID, categoryId: PRODUCTS_CATEGORY_ID })]);
    expect(wrongSide.integrity.problems).toEqual([{ code: "wrong_category_type", entity: "recurringRule", id: RULE }]);
    expect(ruleOf(wrongSide)?.template).toEqual({ kind: "income", amountMinor: 1, accountId: MAIN_ACCOUNT_ID });

    // An expense keeps the tags that resolve and loses only the others.
    const tagged = applyJournal([...journal, write("tag", TAG, { name: "Дом", active: true }, 940), rule({ ...WATER, tagIds: [TAG, tagUuid(0x7f2)] })]);
    expect(ruleOf(tagged)?.template).toEqual({ ...WATER, tagIds: [TAG] });
  });

  it("reports more rules than a document may hold, and shows all of them", () => {
    const rules = Array.from({ length: COLLECTION_LIMITS.recurringRules + 1 }, (_, index) => parseOperation({
      opId: opUuid(72_000 + index), deviceId: DEVICE_B, lamport: 1_000 + index, entity: "recurringRule", action: "create",
      targetId: testUuid(0x7f3, index), fields: RULE_FIELDS,
    }));
    const snapshot = applyJournal([...buildFixtureJournal(), ...rules]);
    expect(snapshot.integrity.ready).toBe(true);
    expect(snapshot.integrity.problems).toEqual([{ code: "collection_limit", entity: "recurringRule", id: "" }]);
    expect(snapshot.state.recurringRules).toHaveLength(COLLECTION_LIMITS.recurringRules + 1);
  });
});
