import {
  HOUSEHOLD_ID,
  isDisplayKey,
  isStorableLabel,
  isStorableNote,
  isSupportedCurrency,
  isUuid,
  MAX_LOCAL_DATE,
  MAX_MONEY_MINOR,
  MAX_SORT_ORDER,
  MAX_TAGS_PER_TRANSACTION,
  MIN_LOCAL_DATE,
  NOTE_MAX_LENGTH,
  RATE_PART_MAX,
  RATE_PART_MIN,
  TAG_NAME_MAX_LENGTH,
  type ExchangeRateValue,
} from "@family-budget/domain";

import type {
  AccountFields,
  AnnualCommitmentFields,
  BudgetFields,
  BudgetLineFields,
  CategoryFields,
  EntityKind,
  ExchangeRateFields,
  GoalFields,
  HouseholdFields,
  MemberFields,
  Operation,
  OperationHeader,
  ScheduledExpenseFields,
  TagFields,
  TransactionFields,
} from "./types.js";
import { ENTITY_KINDS, OPERATION_ACTIONS } from "./types.js";

/** Envelopes stay small so a single operation always fits one encrypted payload. */
export const MAX_OPERATION_BYTES = 8 * 1024;

/**
 * Absolute policy ceiling for a Lamport stamp, deliberately far below Number.MAX_SAFE_INTEGER.
 * It is what the codec accepts, and nothing more: a stamp is a number the writing device
 * chooses for itself, so the ceiling of the encoding cannot be the ceiling of the ordering.
 * See {@link HONEST_LAMPORT_CEILING} for the one that decides conflicts.
 */
export const MAX_LAMPORT = 2 ** 40;

/**
 * The highest stamp honest work can produce, and therefore the highest one that carries any
 * weight in the total order of the merge.
 *
 * 2^32 is 4 294 967 296. A family whose devices write ten thousand operations a day between
 * them — every member editing all day, every day — needs 429 497 days to reach it, which is
 * eleven hundred years. Twice that rate still leaves five centuries. So no honest history
 * arrives here, and a stamp above it is not a clock reading at all: it is a number a peer
 * wrote down to win with.
 *
 * The merge therefore ranks by the stamp only while the stamp stays below this line, and
 * treats everything above it as carrying no rank — see compareOperations in journal.ts. The
 * codec goes on accepting up to {@link MAX_LAMPORT}, because refusing the operation would make
 * the journal depend on which device received it first, and two devices would then disagree
 * about entities rather than about a number that decides nothing but ties.
 */
export const HONEST_LAMPORT_CEILING = 2 ** 32;

/**
 * The highest stamp a clock of this package will ever hold or write: one below the line.
 *
 * The line itself is not a value anybody may sit on. Ranking treats the ceiling and everything
 * above it alike — see `rankedLamport` in journal.ts — so a clock that saturated *at* the
 * ceiling would hand its own device the floor rank for the rest of its life, and a comparison
 * that spared the ceiling would hand whoever wrote exactly `2 ** 32` the highest rank the
 * protocol has. Both halves have to move together, and this is the value the clock half uses:
 * saturation strictly below the line, so an honest history that runs out of stamps keeps its
 * place in the order rather than losing every conflict it will ever have.
 */
export const MAX_HONEST_LAMPORT = HONEST_LAMPORT_CEILING - 1;

/**
 * Relative ceiling for a Lamport stamp: how far ahead of the receiving clock a stamp may
 * plausibly be. This one is a property of the receiver, not of the journal — two devices that
 * received the same operations in a different order may hold different clocks, and that is
 * what a Lamport clock is. It therefore decides nothing about the state: it bounds how far one
 * delivery may move the clock a device stamps its own writes with, so that a single envelope
 * cannot push a family's clock to a place where stamps stop growing.
 */
export const MAX_LAMPORT_SKEW = 1_000_000;

/**
 * Upper bound for every money field, and the calendar window every date must fall into: defined
 * once, in the domain (`limits.ts`, `calendar.ts`), and re-exported here for the callers that have
 * always found them in this package. A bound the codec kept for itself let the domain and the backup
 * gate accept a value the codec then refused — a goal deadline in 2200 stranded on the device that
 * wrote it — so the codec owns none of them any more.
 *
 * The money ceiling is 10^10 minor units, a hundred million roubles for a single amount. The
 * previous 10^13 did not protect the domain at all — 901 amounts at that ceiling add up to
 * 9.01·10^15, past Number.MAX_SAFE_INTEGER, and every device in the family loses its calculations
 * at once. It is a field bound only; sums are bounded separately by the integrity gate, because no
 * per-field ceiling can bound a sum. Outside the date window the domain's month arithmetic breaks.
 */
export { MAX_LOCAL_DATE, MAX_MONEY_MINOR, MIN_LOCAL_DATE };

const DANGEROUS_KEYS = new Set(["__proto__", "constructor", "prototype"]);
const MAX_ID_LENGTH = 128;
const MAX_TEXT_LENGTH = 200;
const MAX_DEPTH = 8;
const MAX_NODES = 2_000;
const MAX_MONTHS = 12;
/** Untrusted text is echoed back into an error message only in this quantity. */
const MAX_ECHO_LENGTH = 32;
const LOCAL_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const CURRENCY_PATTERN = /^[A-Z]{3}$/;
/**
 * The only shape a deviceId or an opId may take. Both of them break ties in the total order
 * of the merge, and a tiebreaker is only fair when every participant draws from the same
 * space: an unconstrained string lets one peer pick the lexicographically largest value
 * there is and never lose a conflict again.
 */
const UUID_V4_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

const ACCOUNT_TYPES = ["current", "cash", "savings", "reserve"] as const;
const CATEGORY_TYPES = ["income", "expense"] as const;
const BUDGET_STATUSES = ["draft", "open", "closed"] as const;
const GOAL_STATUSES = ["active", "completed", "cancelled"] as const;
const COMMITMENT_RECURRENCES = ["annual", "one_time"] as const;
const SCHEDULE_MODES = ["monthly", "selected_months"] as const;
const TRANSACTION_STATUSES = ["posted", "pending", "draft"] as const;
const TRANSACTION_KINDS = ["income", "expense", "refund", "transfer", "goal_contribution"] as const;
const MEMBER_ROLES = ["owner", "member"] as const;

/** Every rejection raised by the protocol, so callers can tell a bad envelope from a bug. */
export class SyncProtocolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SyncProtocolError";
  }
}

/**
 * Text that no name may contain: C0 and C1 controls, DEL, the line and paragraph
 * separators, the zero-width and byte-order marks, every bidirectional override or
 * isolate, the interlinear annotation marks, and unpaired surrogates. A bidirectional
 * override in a member name would let one participant impersonate another in the history,
 * and a lone surrogate breaks any consumer that re-encodes the journal.
 */
const UNSAFE_TEXT =
  /[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028\u2029\u202a-\u202e\u2066-\u2069\ufeff\ufff9-\ufffb]|[\ud800-\udfff]/u;

function hasUnsafeCharacter(value: string): boolean {
  return UNSAFE_TEXT.test(value);
}

/**
 * Untrusted text is never echoed verbatim: an unknown key may carry terminal escapes or a
 * megabyte of padding, and the message ends up in logs and in a quarantine report.
 */
function echo(value: unknown): string {
  const text =
    typeof value === "string" || typeof value === "number" || typeof value === "boolean" || value === null
      ? String(value)
      : typeof value === "undefined"
        ? "undefined"
        : "value";
  const safe = text.replace(/[^A-Za-z0-9_-]/gu, "");
  return safe.length > MAX_ECHO_LENGTH ? `${safe.slice(0, MAX_ECHO_LENGTH)}...` : safe;
}

function fail(message: string): never {
  throw new SyncProtocolError(message);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

/** Rejects prototype-polluting field names and unsupported values before anything is read. */
function assertSafeShape(value: unknown): void {
  const stack: Array<{ readonly value: unknown; readonly depth: number }> = [{ value, depth: 0 }];
  let nodes = 0;

  while (stack.length > 0) {
    const current = stack.pop()!;
    nodes += 1;
    if (nodes > MAX_NODES) fail("operation contains too many values");
    if (current.depth > MAX_DEPTH) fail("operation is nested too deeply");

    const item = current.value;
    if (item === null || item === undefined || typeof item === "string" || typeof item === "boolean") continue;
    if (typeof item === "number") {
      if (!Number.isFinite(item)) fail("operation contains a non-finite number");
      continue;
    }
    if (Array.isArray(item)) {
      for (const child of item) stack.push({ value: child, depth: current.depth + 1 });
      continue;
    }
    if (!isRecord(item)) fail("operation contains an unsupported value type");
    for (const key of Object.keys(item)) {
      if (DANGEROUS_KEYS.has(key)) fail(`operation contains the forbidden field name ${echo(key)}`);
      stack.push({ value: item[key], depth: current.depth + 1 });
    }
  }
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (!isRecord(value)) fail(`${label} must be an object`);
  return value;
}

function requireFieldNames(
  record: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[],
  label: string,
): void {
  for (const key of Object.keys(record)) {
    if (!required.includes(key) && !optional.includes(key)) {
      fail(`${label} contains unknown field ${echo(key)}`);
    }
  }
  for (const key of required) {
    if (record[key] === undefined) fail(`${label} is missing field ${key}`);
  }
}

function readString(record: Record<string, unknown>, key: string, label: string, allowEmpty = false): string {
  const value = record[key];
  if (typeof value !== "string") fail(`${label} must be a string`);
  if (!allowEmpty && value.trim().length === 0) fail(`${label} must not be empty`);
  if (value.length > MAX_TEXT_LENGTH) fail(`${label} must be at most ${MAX_TEXT_LENGTH} characters`);
  if (hasUnsafeCharacter(value)) fail(`${label} must not contain control or formatting characters`);
  return value;
}

/**
 * Reads an identifier. Everything {@link UNSAFE_TEXT} covers is refused, U+0000 among it, and
 * the merge relies on exactly that when it builds a composite key out of two identifiers: a
 * separator an identifier cannot contain is what keeps ("fam 1", "cat") and ("fam", "1 cat")
 * from naming one and the same budget line. A space would not — see journal.ts.
 */
function readId(record: Record<string, unknown>, key: string, label: string): string {
  return parseId(record[key], label);
}

/** The rule of {@link readId}, for an identifier that is not a field of a record: a list entry. */
function parseId(value: unknown, label: string): string {
  if (typeof value !== "string") fail(`${label} must be a string`);
  // The domain rejects a blank stable id, so whitespace alone never counts as an identifier.
  if (value.trim().length === 0) fail(`${label} must not be empty`);
  if (value.length > MAX_ID_LENGTH) fail(`${label} must be at most ${MAX_ID_LENGTH} characters`);
  if (hasUnsafeCharacter(value)) fail(`${label} must not contain control or formatting characters`);
  return value;
}

/**
 * Validates a device or operation identifier. Exported so the clock refuses exactly what the
 * codec refuses: a device that names itself something else would author operations no peer
 * accepts, and would discover it only after its work was lost.
 */
export function parseUuid(value: unknown, label: string): string {
  if (typeof value !== "string") fail(`${label} must be a string`);
  if (value.length !== 36 || !UUID_V4_PATTERN.test(value)) {
    fail(`${label} must be a lowercase UUID version 4`);
  }
  return value;
}

function readUuid(record: Record<string, unknown>, key: string, label: string): string {
  return parseUuid(record[key], label);
}

function readBoolean(record: Record<string, unknown>, key: string, label: string): boolean {
  const value = record[key];
  if (typeof value !== "boolean") fail(`${label} must be a boolean`);
  return value;
}

function readEnum<T extends string>(
  record: Record<string, unknown>,
  key: string,
  allowed: readonly T[],
  label: string,
): T {
  const value = record[key];
  if (typeof value !== "string" || !allowed.includes(value as T)) {
    fail(`${label} has unknown value ${echo(value)}`);
  }
  return value as T;
}

/**
 * Money never leaves the wire as anything but an integer count of minor units, and never
 * larger than MAX_MONEY_MINOR: an amount close to the safe integer range would make the
 * domain throw on the first addition and would take every device down with it.
 */
function readMinor(record: Record<string, unknown>, key: string, label: string, minimum = -MAX_MONEY_MINOR): number {
  const value = record[key];
  if (typeof value !== "number" || !Number.isSafeInteger(value)) {
    fail(`${label} must be an integer minor-unit amount`);
  }
  if (value < minimum) fail(`${label} must be at least ${minimum}`);
  if (value > MAX_MONEY_MINOR) fail(`${label} must be at most ${MAX_MONEY_MINOR}`);
  return value;
}

function readInteger(record: Record<string, unknown>, key: string, label: string, minimum: number, maximum: number): number {
  const value = record[key];
  if (typeof value !== "number" || !Number.isSafeInteger(value)) fail(`${label} must be an integer`);
  if (value < minimum || value > maximum) fail(`${label} must be from ${minimum} to ${maximum}`);
  return value;
}

function readRatio(record: Record<string, unknown>, key: string, label: string): number {
  const value = record[key];
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value >= 1) {
    fail(`${label} must be in [0, 1)`);
  }
  return value;
}

/**
 * A currency of the domain's table (`SUPPORTED_CURRENCIES`). An unknown code is refused rather than
 * carried: an account in a currency this build cannot count is an operation it cannot apply, and the
 * sync client answers that with «update the application», which for a code added in a later version
 * is the truth.
 */
function readCurrency(record: Record<string, unknown>, key: string, label: string): string {
  const value = readString(record, key, label);
  if (!CURRENCY_PATTERN.test(value)) fail(`${label} must be a three-letter currency code`);
  if (!isSupportedCurrency(value)) fail(`${label} must be a supported currency, not ${echo(value)}`);
  return value;
}

/** A rate as the domain stores one: two integers from one minor unit to a trillion, nothing else. */
function readRate(record: Record<string, unknown>, key: string, label: string): ExchangeRateValue {
  const rate = requireRecord(record[key], label);
  requireFieldNames(rate, ["baseMinor", "quoteMinor"], [], label);
  return {
    baseMinor: readInteger(rate, "baseMinor", `${label} baseMinor`, RATE_PART_MIN, RATE_PART_MAX),
    quoteMinor: readInteger(rate, "quoteMinor", `${label} quoteMinor`, RATE_PART_MIN, RATE_PART_MAX),
  };
}

/**
 * The base-currency snapshot of an income, an expense or a refund: all three fields or none, as the
 * domain demands. Whether the account needs one is the integrity gate's question — the account may
 * be in another entry, or change its currency on another device — so the codec only refuses a
 * snapshot that is not one.
 */
function readSnapshot(record: Record<string, unknown>): {
  baseAmountMinor?: number;
  baseCurrency?: string;
  rate?: ExchangeRateValue;
} {
  const present = ["baseAmountMinor", "baseCurrency", "rate"].filter((key) => record[key] !== undefined);
  if (present.length === 0) return {};
  if (present.length < 3) fail("transaction baseAmountMinor, baseCurrency and rate must come together");
  return {
    baseAmountMinor: readMinor(record, "baseAmountMinor", "transaction baseAmountMinor", 1),
    baseCurrency: readCurrency(record, "baseCurrency", "transaction baseCurrency"),
    rate: readRate(record, "rate", "transaction rate"),
  };
}

/**
 * A date outside the supported window is not a typo, it is a weapon: an active budget dated
 * 9999-12-01 makes the annual plan walk past the end of the supported calendar and throw on
 * every device in the family, and it takes two operations to place one.
 */
function readLocalDate(record: Record<string, unknown>, key: string, label: string): string {
  const value = readString(record, key, label);
  if (!LOCAL_DATE_PATTERN.test(value)) fail(`${label} must use YYYY-MM-DD`);
  const parsed = new Date(`${value}T00:00:00.000Z`);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) {
    fail(`${label} must be a valid calendar date`);
  }
  if (value < MIN_LOCAL_DATE || value > MAX_LOCAL_DATE) {
    fail(`${label} must be from ${MIN_LOCAL_DATE} to ${MAX_LOCAL_DATE}`);
  }
  return value;
}

/**
 * A label the domain may store (`isStorableLabel`): trimmed, without a control or a hidden
 * character, at most `maxLength`.
 *
 * Held to the domain's own stored-text predicate rather than to {@link readString} alone, because the
 * domain checks a tag's name on every calculation, and a journal that accepted a name the domain
 * refuses would hand every device of the family a state whose every calculation throws. And to the
 * stored-text rule, not to the rule a person's typing is held to: that one asks the engine about
 * Unicode, and an entry it accepted on one engine would stop decoding after a browser update — on
 * every device, for good, because `restoreJournal` refuses a journal with an entry it cannot read.
 */
function readLabel(record: Record<string, unknown>, key: string, label: string, maxLength: number): string {
  const value = readString(record, key, label);
  if (value.length > maxLength) fail(`${label} must be at most ${maxLength} characters`);
  if (!isStorableLabel(value, maxLength)) fail(`${label} must be trimmed text without hidden characters`);
  return value;
}

/**
 * A note on an operation: one line of up to {@link NOTE_MAX_LENGTH} characters, held to the
 * domain's `isStorableNote` for the reason {@link readLabel} gives.
 *
 * Longer than any other text the codec carries ({@link MAX_TEXT_LENGTH} is for names). The
 * stored-text rule refuses everything {@link UNSAFE_TEXT} refuses and a little more, and accepts
 * everything `normalizeNote` produces, so whatever a device stored, every other device accepts.
 */
function readNote(record: Record<string, unknown>, key: string, label: string): string {
  const value = record[key];
  if (typeof value !== "string") fail(`${label} must be a string`);
  if (value.length > NOTE_MAX_LENGTH) fail(`${label} must be at most ${NOTE_MAX_LENGTH} characters`);
  if (!isStorableNote(value)) fail(`${label} must be one trimmed line without hidden characters`);
  return value;
}

/**
 * An identifier of an entity kind added in wave 1, or a reference to one: a UUID, as the backup gate
 * and the domain's census demand of every identifier (`isUuid` in the domain).
 *
 * The kinds that existed before carry whatever identifier `readId` accepts, and the gate demands a
 * UUID of them too; that older gap is not closed here, because the journals of their tests name
 * entities "account-1". For the new kinds there is no such history, and a journal that accepted a
 * tag called "x" handed the family a state the app refused on every write.
 */
function parseEntityUuid(value: unknown, label: string): string {
  const id = parseId(value, label);
  if (!isUuid(id)) fail(`${label} must be a UUID`);
  return id;
}

/** Entity kinds whose identifiers are UUIDs on the wire. See {@link parseEntityUuid}. */
const UUID_KINDS: ReadonlySet<EntityKind> = new Set<EntityKind>(["tag", "exchangeRate"]);

/**
 * The tags on an operation: from one to {@link MAX_TAGS_PER_TRANSACTION} identifiers, none twice,
 * each a UUID. An empty list is refused rather than read as "no tags", because no tags is no field;
 * whether each tag exists is the integrity gate's question, not the codec's.
 */
function readTagIds(record: Record<string, unknown>, key: string, label: string): string[] {
  const value = record[key];
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_TAGS_PER_TRANSACTION) {
    fail(`${label} must list from 1 to ${MAX_TAGS_PER_TRANSACTION} tags`);
  }
  const ids: string[] = [];
  for (let index = 0; index < value.length; index += 1) {
    ids.push(parseEntityUuid(value[index], `${label}[${index}]`));
  }
  if (new Set(ids).size !== ids.length) fail(`${label} must not repeat a tag`);
  return ids;
}

/** The key of a design token, never a colour or a file name — see `DisplayKey` in the domain. */
function readDisplayKey(record: Record<string, unknown>, key: string, label: string): string {
  const value = record[key];
  if (!isDisplayKey(value)) fail(`${label} must be a design-token key`);
  return value;
}

function readMonths(record: Record<string, unknown>, key: string, label: string): number[] {
  const value = record[key];
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_MONTHS) {
    fail(`${label} must list from 1 to ${MAX_MONTHS} calendar months`);
  }
  const months = value.map((month, index) => {
    if (typeof month !== "number" || !Number.isSafeInteger(month) || month < 1 || month > MAX_MONTHS) {
      fail(`${label}[${index}] must be a calendar month from 1 to 12`);
    }
    return month;
  });
  if (new Set(months).size !== months.length) fail(`${label} must not repeat a calendar month`);
  return months;
}

/**
 * Display fields: optional everywhere, and absent stays absent, exactly as the participant's label
 * on a transaction. An entity written before they existed carries none, and a trip through the
 * codec must not hand it an empty one. Named one by one in each strict list, never opened up.
 */
function parseAccountFields(value: unknown): AccountFields {
  const label = "account fields";
  const record = requireRecord(value, label);
  requireFieldNames(
    record,
    ["name", "type", "currency", "openingBalanceMinor", "active"],
    ["sortOrder", "icon", "color", "includeInTotal"],
    label,
  );
  return {
    name: readString(record, "name", "account name"),
    type: readEnum(record, "type", ACCOUNT_TYPES, "account type"),
    currency: readCurrency(record, "currency", "account currency"),
    openingBalanceMinor: readMinor(record, "openingBalanceMinor", "account openingBalanceMinor"),
    active: readBoolean(record, "active", "account active"),
    ...(record.sortOrder === undefined
      ? {}
      : { sortOrder: readInteger(record, "sortOrder", "account sortOrder", -MAX_SORT_ORDER, MAX_SORT_ORDER) }),
    ...(record.icon === undefined ? {} : { icon: readDisplayKey(record, "icon", "account icon") }),
    ...(record.color === undefined ? {} : { color: readDisplayKey(record, "color", "account color") }),
    ...(record.includeInTotal === undefined
      ? {}
      : { includeInTotal: readBoolean(record, "includeInTotal", "account includeInTotal") }),
  };
}

function parseCategoryFields(value: unknown): CategoryFields {
  const label = "category fields";
  const record = requireRecord(value, label);
  requireFieldNames(record, ["name", "type", "group", "active", "sortOrder"], ["icon", "color"], label);
  return {
    name: readString(record, "name", "category name"),
    type: readEnum(record, "type", CATEGORY_TYPES, "category type"),
    group: readString(record, "group", "category group", true),
    active: readBoolean(record, "active", "category active"),
    sortOrder: readInteger(record, "sortOrder", "category sortOrder", -MAX_SORT_ORDER, MAX_SORT_ORDER),
    ...(record.icon === undefined ? {} : { icon: readDisplayKey(record, "icon", "category icon") }),
    ...(record.color === undefined ? {} : { color: readDisplayKey(record, "color", "category color") }),
  };
}

function parseBudgetFields(value: unknown): BudgetFields {
  const label = "budget fields";
  const record = requireRecord(value, label);
  requireFieldNames(record, ["startDate", "endDate", "status", "plannedIncomeMinor", "warningThreshold"], [], label);
  const startDate = readLocalDate(record, "startDate", "budget startDate");
  const endDate = readLocalDate(record, "endDate", "budget endDate");
  if (startDate > endDate) fail("budget startDate must not be after endDate");
  return {
    startDate,
    endDate,
    status: readEnum(record, "status", BUDGET_STATUSES, "budget status"),
    plannedIncomeMinor: readMinor(record, "plannedIncomeMinor", "budget plannedIncomeMinor", 0),
    warningThreshold: readRatio(record, "warningThreshold", "budget warningThreshold"),
  };
}

function parseBudgetLineFields(value: unknown): BudgetLineFields {
  const label = "budget line fields";
  const record = requireRecord(value, label);
  requireFieldNames(
    record,
    ["budgetId", "categoryId", "plannedMinor"],
    ["active", "rolloverMinor", "adjustmentMinor"],
    label,
  );
  const fields: {
    budgetId: string;
    categoryId: string;
    plannedMinor: number;
    active?: boolean;
    rolloverMinor?: number;
    adjustmentMinor?: number;
  } = {
    budgetId: readId(record, "budgetId", "budget line budgetId"),
    categoryId: readId(record, "categoryId", "budget line categoryId"),
    plannedMinor: readMinor(record, "plannedMinor", "budget line plannedMinor", 0),
  };
  if (record.active !== undefined) fields.active = readBoolean(record, "active", "budget line active");
  if (record.rolloverMinor !== undefined) {
    fields.rolloverMinor = readMinor(record, "rolloverMinor", "budget line rolloverMinor", 0);
  }
  if (record.adjustmentMinor !== undefined) {
    fields.adjustmentMinor = readMinor(record, "adjustmentMinor", "budget line adjustmentMinor");
  }
  // The domain refuses a line whose available amount is negative, so it never reaches a journal.
  if (fields.plannedMinor + (fields.rolloverMinor ?? 0) + (fields.adjustmentMinor ?? 0) < 0) {
    fail("budget line availableMinor must not be negative");
  }
  return fields;
}

function parseGoalFields(value: unknown): GoalFields {
  const label = "goal fields";
  const record = requireRecord(value, label);
  requireFieldNames(
    record,
    ["name", "linkedAccountId", "targetMinor", "openingContributedMinor", "plannedContributionMinor", "status"],
    ["deadline", "icon"],
    label,
  );
  return {
    name: readString(record, "name", "goal name"),
    linkedAccountId: readId(record, "linkedAccountId", "goal linkedAccountId"),
    targetMinor: readMinor(record, "targetMinor", "goal targetMinor", 0),
    openingContributedMinor: readMinor(record, "openingContributedMinor", "goal openingContributedMinor", 0),
    plannedContributionMinor: readMinor(record, "plannedContributionMinor", "goal plannedContributionMinor", 0),
    status: readEnum(record, "status", GOAL_STATUSES, "goal status"),
    ...(record.deadline === undefined ? {} : { deadline: readLocalDate(record, "deadline", "goal deadline") }),
    ...(record.icon === undefined ? {} : { icon: readDisplayKey(record, "icon", "goal icon") }),
  };
}

function parseAnnualCommitmentFields(value: unknown): AnnualCommitmentFields {
  const label = "annual commitment fields";
  const record = requireRecord(value, label);
  requireFieldNames(
    record,
    ["name", "categoryId", "accountId", "dueDate", "amountMinor", "reservedMinor", "recurrence", "active"],
    [],
    label,
  );
  return {
    name: readString(record, "name", "annual commitment name"),
    categoryId: readId(record, "categoryId", "annual commitment categoryId"),
    accountId: readId(record, "accountId", "annual commitment accountId"),
    dueDate: readLocalDate(record, "dueDate", "annual commitment dueDate"),
    amountMinor: readMinor(record, "amountMinor", "annual commitment amountMinor", 1),
    reservedMinor: readMinor(record, "reservedMinor", "annual commitment reservedMinor", 0),
    recurrence: readEnum(record, "recurrence", COMMITMENT_RECURRENCES, "annual commitment recurrence"),
    active: readBoolean(record, "active", "annual commitment active"),
  };
}

function parseScheduledExpenseFields(value: unknown): ScheduledExpenseFields {
  const label = "scheduled expense fields";
  const record = requireRecord(value, label);
  requireFieldNames(
    record,
    ["name", "categoryId", "accountId", "amountMinor", "dueDay", "mode", "active"],
    ["months"],
    label,
  );
  const mode = readEnum(record, "mode", SCHEDULE_MODES, "scheduled expense mode");
  const fields: {
    name: string;
    categoryId: string;
    accountId: string;
    amountMinor: number;
    dueDay: number;
    mode: "monthly" | "selected_months";
    months?: readonly number[];
    active: boolean;
  } = {
    name: readString(record, "name", "scheduled expense name"),
    categoryId: readId(record, "categoryId", "scheduled expense categoryId"),
    accountId: readId(record, "accountId", "scheduled expense accountId"),
    amountMinor: readMinor(record, "amountMinor", "scheduled expense amountMinor", 1),
    dueDay: readInteger(record, "dueDay", "scheduled expense dueDay", 1, 31),
    mode,
    active: readBoolean(record, "active", "scheduled expense active"),
  };
  if (mode === "selected_months") {
    fields.months = readMonths(record, "months", "scheduled expense months");
  } else if (record.months !== undefined) {
    fail("scheduled expense months is only allowed for selected_months");
  }
  return fields;
}

function parseTransactionFields(value: unknown): TransactionFields {
  const label = "transaction fields";
  const record = requireRecord(value, label);
  const kind = readEnum(record, "kind", TRANSACTION_KINDS, "transaction kind");
  const shared = ["kind", "occurredOn", "status", "amountMinor"];
  /**
   * The participant credited with this operation, carried on the transaction itself.
   *
   * The header carries a member too, and the two answer different questions: the header says
   * who *wrote* the operation, and this says whose spending it is. Only the second survives
   * an edit — a member correcting somebody else's expense writes their own identifier into
   * the header and leaves this one alone — and only the second is what the domain reads to
   * split a budget by participant. A field list that omitted it rejected the whole operation
   * as unknown, so a labelled expense could be entered on one device and never reach another.
   *
   * Optional, and every list below keeps it optional rather than required: every operation
   * written before participants existed omits it, and such an operation stays valid for ever.
   */
  const attribution = ["memberId"];
  /**
   * The three labels every kind may carry besides the participant: a note, tags and the recurring
   * rule the operation is an occurrence of. Optional for the same reason, and absent stays absent
   * for the same reason. No figure reads any of them, so whether the tags and the rule exist is
   * left to the integrity gate, which takes off a label that names nothing and keeps the money.
   */
  const labels = ["note", "tagIds", "recurringRuleId"];
  const optional = [...attribution, ...labels];
  /** The snapshot of an operation on an account in another currency; see {@link readSnapshot}. */
  const snapshot = ["baseAmountMinor", "baseCurrency", "rate"];
  const base = {
    occurredOn: readLocalDate(record, "occurredOn", "transaction occurredOn"),
    status: readEnum(record, "status", TRANSACTION_STATUSES, "transaction status"),
    amountMinor: readMinor(record, "amountMinor", "transaction amountMinor", 1),
    // Absent stays absent: an unlabelled transaction must not gain an empty label by passing
    // through the codec, because `memberId: undefined` is a different value to the domain.
    ...(record.memberId === undefined ? {} : { memberId: readId(record, "memberId", "transaction memberId") }),
    ...(record.note === undefined ? {} : { note: readNote(record, "note", "transaction note") }),
    ...(record.tagIds === undefined ? {} : { tagIds: readTagIds(record, "tagIds", "transaction tagIds") }),
    ...(record.recurringRuleId === undefined
      ? {}
      : { recurringRuleId: parseEntityUuid(record.recurringRuleId, "transaction recurringRuleId") }),
  };

  switch (kind) {
    case "income": {
      /**
       * The category an income is filed under, the second optional label a transaction carries.
       *
       * The same omission as the participant's, and the same cost: the domain gained the field,
       * the field list here did not, and a categorised income was rejected as an unknown field —
       * so it could be entered on one device and never reach another. Named explicitly for the
       * same reason the label above is: the strict list is the defence, and it is widened one
       * field at a time rather than opened up.
       *
       * Optional here as it is in the domain: every income written before income had categories
       * omits it and stays valid for ever. Only an income carries it — the other kinds either
       * require a category or have none at all, and their lists are unchanged.
       */
      requireFieldNames(record, [...shared, "accountId"], [...optional, ...snapshot, "categoryId"], label);
      return {
        ...base,
        ...readSnapshot(record),
        kind,
        accountId: readId(record, "accountId", "transaction accountId"),
        // Absent stays absent, exactly as for the label above: `categoryId: undefined` is a
        // different value to the domain than no category at all.
        ...(record.categoryId === undefined
          ? {}
          : { categoryId: readId(record, "categoryId", "transaction categoryId") }),
      };
    }
    case "expense":
      requireFieldNames(record, [...shared, "accountId", "categoryId"], [...optional, ...snapshot], label);
      return {
        ...base,
        ...readSnapshot(record),
        kind,
        accountId: readId(record, "accountId", "transaction accountId"),
        categoryId: readId(record, "categoryId", "transaction categoryId"),
      };
    case "refund":
      requireFieldNames(
        record,
        [...shared, "accountId", "categoryId", "originalTransactionId"],
        [...optional, ...snapshot],
        label,
      );
      return {
        ...base,
        ...readSnapshot(record),
        kind,
        accountId: readId(record, "accountId", "transaction accountId"),
        categoryId: readId(record, "categoryId", "transaction categoryId"),
        originalTransactionId: readId(record, "originalTransactionId", "transaction originalTransactionId"),
      };
    case "transfer": {
      // What arrived, in the currency of the receiving account: there exactly when the currencies
      // differ, which is the integrity gate's question, not the codec's.
      requireFieldNames(record, [...shared, "fromAccountId", "toAccountId"], [...optional, "toAmountMinor"], label);
      const fromAccountId = readId(record, "fromAccountId", "transaction fromAccountId");
      const toAccountId = readId(record, "toAccountId", "transaction toAccountId");
      // The domain refuses a movement inside one account, so it never reaches a journal.
      if (fromAccountId === toAccountId) fail("transaction must use two different accounts");
      return {
        ...base,
        kind,
        fromAccountId,
        toAccountId,
        ...(record.toAmountMinor === undefined
          ? {}
          : { toAmountMinor: readMinor(record, "toAmountMinor", "transaction toAmountMinor", 1) }),
      };
    }
    case "goal_contribution": {
      requireFieldNames(record, [...shared, "fromAccountId", "toAccountId", "goalId"], optional, label);
      const fromAccountId = readId(record, "fromAccountId", "transaction fromAccountId");
      const toAccountId = readId(record, "toAccountId", "transaction toAccountId");
      if (fromAccountId === toAccountId) fail("transaction must use two different accounts");
      return { ...base, kind, fromAccountId, toAccountId, goalId: readId(record, "goalId", "transaction goalId") };
    }
  }
}

function parseMemberFields(value: unknown): MemberFields {
  const label = "member fields";
  const record = requireRecord(value, label);
  requireFieldNames(record, ["name", "role", "active"], [], label);
  return {
    name: readString(record, "name", "member name"),
    role: readEnum(record, "role", MEMBER_ROLES, "member role"),
    active: readBoolean(record, "active", "member active"),
  };
}

function parseTagFields(value: unknown): TagFields {
  const label = "tag fields";
  const record = requireRecord(value, label);
  requireFieldNames(record, ["name", "active"], [], label);
  return {
    name: readLabel(record, "name", "tag name", TAG_NAME_MAX_LENGTH),
    active: readBoolean(record, "active", "tag active"),
  };
}

function parseExchangeRateFields(value: unknown): ExchangeRateFields {
  const label = "exchange rate fields";
  const record = requireRecord(value, label);
  requireFieldNames(record, ["currency", "baseCurrency", "date", "rate"], [], label);
  const currency = readCurrency(record, "currency", "exchange rate currency");
  const baseCurrency = readCurrency(record, "baseCurrency", "exchange rate baseCurrency");
  // The domain refuses a rate of a currency in itself, so it never reaches a journal.
  if (currency === baseCurrency) fail("exchange rate must value one currency in another");
  return {
    currency,
    baseCurrency,
    date: readLocalDate(record, "date", "exchange rate date"),
    rate: readRate(record, "rate", "exchange rate rate"),
  };
}

function parseHouseholdFields(value: unknown): HouseholdFields {
  const label = "household fields";
  const record = requireRecord(value, label);
  requireFieldNames(record, ["baseCurrency"], [], label);
  return { baseCurrency: readCurrency(record, "baseCurrency", "household baseCurrency") };
}

function parseWrite(
  entity: EntityKind,
  action: "create" | "update",
  targetId: string,
  header: OperationHeader,
  fields: unknown,
): Operation {
  switch (entity) {
    case "account":
      return { ...header, entity, action, targetId, fields: parseAccountFields(fields) };
    case "category":
      return { ...header, entity, action, targetId, fields: parseCategoryFields(fields) };
    case "budget":
      return { ...header, entity, action, targetId, fields: parseBudgetFields(fields) };
    case "budgetLine":
      return { ...header, entity, action, targetId, fields: parseBudgetLineFields(fields) };
    case "goal":
      return { ...header, entity, action, targetId, fields: parseGoalFields(fields) };
    case "annualCommitment":
      return { ...header, entity, action, targetId, fields: parseAnnualCommitmentFields(fields) };
    case "scheduledExpense":
      return { ...header, entity, action, targetId, fields: parseScheduledExpenseFields(fields) };
    case "transaction":
      return { ...header, entity, action, targetId, fields: parseTransactionFields(fields) };
    case "member":
      return { ...header, entity, action, targetId, fields: parseMemberFields(fields) };
    case "tag":
      return { ...header, entity, action, targetId, fields: parseTagFields(fields) };
    case "exchangeRate":
      return { ...header, entity, action, targetId, fields: parseExchangeRateFields(fields) };
    case "household":
      return { ...header, entity, action, targetId, fields: parseHouseholdFields(fields) };
  }
}

/**
 * Freezes a whole structure, so nothing this package hands back can be rewritten behind a
 * caller's back. Iterative and cycle-aware: a recursive walk over a value someone else built
 * would blow the stack, and a stack overflow is not a rejection a caller can act on. Accessor
 * properties are frozen without being read, so a lazily materialised snapshot stays lazy.
 */
export function deepFreeze<T>(value: T): T {
  const stack: unknown[] = [value];
  const seen = new Set<unknown>();

  while (stack.length > 0) {
    const current = stack.pop();
    if (current === null || typeof current !== "object" || seen.has(current)) continue;
    seen.add(current);
    for (const descriptor of Object.values(Object.getOwnPropertyDescriptors(current))) {
      if ("value" in descriptor) stack.push(descriptor.value);
    }
    Object.freeze(current);
  }

  return value;
}

/**
 * Validates an untrusted value and rebuilds it, so nothing unvalidated survives.
 * A stamp above MAX_LAMPORT is rejected outright, and the envelope is measured after the
 * rebuild, so an operation that no transport could carry never reaches a journal.
 */
export function parseOperation(value: unknown): Operation {
  assertSafeShape(value);
  const record = requireRecord(value, "operation");
  const entity = readEnum(record, "entity", ENTITY_KINDS, "operation entity");
  const action = readEnum(record, "action", OPERATION_ACTIONS, "operation action");
  const required = ["opId", "deviceId", "lamport", "entity", "action", "targetId"];
  requireFieldNames(
    record,
    action === "create" || action === "update" ? [...required, "fields"] : required,
    ["memberId"],
    "operation",
  );

  // A Lamport stamp starts at 1: zero would mean an operation that no clock ever produced.
  const lamport = readInteger(record, "lamport", "operation lamport", 1, MAX_LAMPORT);
  const header: OperationHeader = {
    opId: readUuid(record, "opId", "operation opId"),
    deviceId: readUuid(record, "deviceId", "operation deviceId"),
    lamport,
    ...(record.memberId === undefined ? {} : { memberId: readId(record, "memberId", "operation memberId") }),
  };
  const targetId = UUID_KINDS.has(entity)
    ? parseEntityUuid(record.targetId, "operation targetId")
    : readId(record, "targetId", "operation targetId");
  // One household per family, under the identifier every device derives, and never deleted: two
  // households would be two base currencies, and a deleted one could never be written again, because
  // a tombstone is final and the identifier cannot change.
  if (entity === "household") {
    if (targetId !== HOUSEHOLD_ID) fail("household targetId must be the household identifier");
    if (action === "delete") fail("the household cannot be deleted");
  }

  if (action === "delete") return sized({ ...header, entity, action, targetId });
  if (action === "activate") {
    if (entity !== "budget") fail("only a budget supports the activate action");
    return sized({ ...header, entity, action, targetId });
  }
  return sized(parseWrite(entity, action, targetId, header, record.fields));
}

/** Measures the canonical envelope and freezes what fits. */
function sized(operation: Operation): Operation {
  if (byteLength(stableJson(operation)) > MAX_OPERATION_BYTES) {
    fail("operation is larger than the allowed envelope");
  }
  return deepFreeze(operation);
}

/**
 * Canonical JSON with sorted keys. The depth counter is not a formality: this is reachable
 * from the public compareOperations with a value that never went through the codec, and an
 * unbounded walk answers a cyclic or deeply nested input with a RangeError, which no caller
 * can tell apart from a bug in the protocol.
 */
function stableJson(value: unknown, depth = 0): string {
  if (depth > MAX_DEPTH) fail("value is nested too deeply to encode");
  if (value === null || typeof value === "boolean" || typeof value === "number" || typeof value === "string") {
    return JSON.stringify(value);
  }
  if (value === undefined || typeof value === "function" || typeof value === "symbol") {
    fail("value cannot be encoded canonically");
  }
  if (Array.isArray(value)) return `[${value.map((item) => stableJson(item, depth + 1)).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .filter((key) => record[key] !== undefined)
    .map((key) => `${JSON.stringify(key)}:${stableJson(record[key], depth + 1)}`)
    .join(",")}}`;
}

const TEXT_ENCODER = new TextEncoder();

function byteLength(value: string): number {
  return TEXT_ENCODER.encode(value).byteLength;
}

/**
 * Canonical text of an operation that has already been validated. The merge uses it as the
 * final tiebreaker, so two devices that reused one identifier for different content still
 * pick the same winner instead of drifting apart forever.
 */
export function canonicalOperationText(operation: Operation): string {
  return stableJson(operation);
}

/** Canonical encoding: keys are sorted, so equal operations always produce equal bytes. */
export function encodeOperation(operation: Operation): string {
  return stableJson(parseOperation(operation));
}

export function decodeOperation(text: string): Operation {
  if (byteLength(text) > MAX_OPERATION_BYTES) fail("operation is larger than the allowed envelope");
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    fail("operation is not valid JSON");
  }
  return parseOperation(raw);
}
