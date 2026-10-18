import { HOUSEHOLD_ID } from "@family-budget/domain";

import type { EntityFieldsByKind, EntityKind } from "../src/index.js";
import { ENTITY_KINDS } from "../src/index.js";

/**
 * A UUID v4 built from two numbers, so a test can say which identifier must win a tie:
 * the leading block orders devices, the trailing block orders operations, and both are
 * compared exactly the way the merge compares them.
 */
export function testUuid(lead: number, tail = 0): string {
  return `${lead.toString(16).padStart(8, "0")}-0000-4000-8000-${tail.toString(16).padStart(12, "0")}`;
}

export const DEVICE_A = testUuid(0xa);
export const DEVICE_B = testUuid(0xb);
export const DEVICE_C = testUuid(0xc);
export const DEVICE_D = testUuid(0xd);
export const DEVICE_E = testUuid(0xe);

/** Operation identifiers, ordered by the number given to them. */
export function opUuid(index: number): string {
  return testUuid(1, index);
}

/**
 * A device identifier nobody confirmed: one more identity a peer drew for itself.
 *
 * The codec checks the shape of a UUID and nothing else, and the sync architecture forbids the
 * server to compare the field with the device that uploaded the envelope, so a peer can write a
 * different one on every operation it sends. Any limit measured per device has to survive that.
 */
export function mintedDevice(index: number): string {
  return testUuid(0x1000 + index, 0xdead0000 + index);
}

export type FieldsSample = { readonly [K in EntityKind]: EntityFieldsByKind[K] };

/** One valid field set per entity kind, so every mutation of BudgetState is exercised. */
export const SAMPLE_FIELDS: FieldsSample = {
  account: { name: "Основной", type: "current", currency: "RUB", openingBalanceMinor: 0, active: true },
  category: { name: "Продукты", type: "expense", group: "Повседневные", active: true, sortOrder: 40 },
  budget: {
    startDate: "2026-07-01",
    endDate: "2026-07-31",
    status: "open",
    plannedIncomeMinor: 18_000_000,
    warningThreshold: 0.8,
  },
  budgetLine: { budgetId: "sample-budget", categoryId: "sample-category", plannedMinor: 3_000_000 },
  goal: {
    name: "Финансовая подушка",
    linkedAccountId: "sample-account",
    targetMinor: 60_000_000,
    openingContributedMinor: 1_500_000,
    plannedContributionMinor: 1_000_000,
    status: "active",
  },
  annualCommitment: {
    name: "Страхование автомобиля",
    categoryId: "sample-category",
    accountId: "sample-account",
    dueDate: "2027-01-15",
    amountMinor: 7_200_000,
    reservedMinor: 0,
    recurrence: "annual",
    active: true,
  },
  scheduledExpense: {
    name: "Обучение детей",
    categoryId: "sample-category",
    accountId: "sample-account",
    amountMinor: 2_500_000,
    dueDay: 10,
    mode: "selected_months",
    months: [1, 2, 3, 4, 5, 9, 10, 11, 12],
    active: true,
  },
  transaction: {
    kind: "expense",
    occurredOn: "2026-07-08",
    status: "posted",
    amountMinor: 2_200_000,
    accountId: "sample-account",
    categoryId: "sample-category",
  },
  member: { name: "Мария", role: "owner", active: true },
  tag: { name: "Отпуск", active: true },
  exchangeRate: { currency: "USD", baseCurrency: "RUB", date: "2026-07-31", rate: { baseMinor: 9_000, quoteMinor: 100 } },
  household: { baseCurrency: "RUB" },
};

/** The same entities after one edit each, used to prove that update replaces the winner. */
export const UPDATED_FIELDS: FieldsSample = {
  account: { ...SAMPLE_FIELDS.account, name: "Резерв платежей", type: "reserve", openingBalanceMinor: 1_500_000 },
  category: { ...SAMPLE_FIELDS.category, name: "Продукты и быт", sortOrder: 45 },
  budget: { ...SAMPLE_FIELDS.budget, plannedIncomeMinor: 19_000_000 },
  budgetLine: { ...SAMPLE_FIELDS.budgetLine, plannedMinor: 3_500_000 },
  goal: { ...SAMPLE_FIELDS.goal, plannedContributionMinor: 1_200_000 },
  annualCommitment: { ...SAMPLE_FIELDS.annualCommitment, reservedMinor: 1_500_000 },
  scheduledExpense: { ...SAMPLE_FIELDS.scheduledExpense, amountMinor: 2_600_000 },
  transaction: { ...SAMPLE_FIELDS.transaction, amountMinor: 2_400_000 },
  member: { ...SAMPLE_FIELDS.member, active: false },
  tag: { ...SAMPLE_FIELDS.tag, name: "Отпуск 2027", active: false },
  exchangeRate: { ...SAMPLE_FIELDS.exchangeRate, rate: { baseMinor: 9_250, quoteMinor: 100 } },
  household: { baseCurrency: "EUR" },
};

/**
 * Kinds whose identifiers the codec demands as UUIDs: the kinds of wave 1, which have no history of
 * readable names. The older kinds keep the readable identifiers their tests always used.
 */
const UUID_KINDS: readonly EntityKind[] = ["tag", "exchangeRate"];

/**
 * A target identifier for `entity`, readable where the codec allows it: `${entity}-${name}` for the
 * older kinds, a UUID derived from the kind and the name for the kinds of wave 1, so a test can still
 * name its targets and get the same identifier for the same name, and `HOUSEHOLD_ID` for the
 * household whatever the name.
 */
export function sampleTargetId(entity: EntityKind, name = "1"): string {
  // One household per family, always under the identifier every device derives.
  if (entity === "household") return HOUSEHOLD_ID;
  if (!UUID_KINDS.includes(entity)) return `${entity}-${name}`;
  let hash = 0;
  for (const character of name) hash = (Math.imul(hash, 31) + character.charCodeAt(0)) >>> 0;
  return testUuid(0x7e000 + ENTITY_KINDS.indexOf(entity), hash);
}

/** One target identifier per kind, the one every closed-set test writes under. */
export const SAMPLE_TARGET_IDS: { readonly [K in EntityKind]: string } = Object.fromEntries(
  ENTITY_KINDS.map((entity) => [entity, sampleTargetId(entity)]),
) as { readonly [K in EntityKind]: string };

/** Tag identifiers for tests that put tags on operations. */
export function tagUuid(index: number): string {
  return testUuid(0x7a6, index);
}
