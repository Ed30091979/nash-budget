import * as domain from "@family-budget/domain";
import { isNormalizedLabel, normalizeNote } from "@family-budget/domain";
import { describe, expect, it } from "vitest";

import {
  compareOperations,
  decodeOperation,
  encodeOperation,
  ENTITY_KINDS,
  MAX_LAMPORT,
  MAX_LOCAL_DATE,
  MAX_MONEY_MINOR,
  MAX_OPERATION_BYTES,
  MIN_LOCAL_DATE,
  parseOperation,
  parseUuid,
  SyncProtocolError,
  type Operation,
  type TransactionFields,
} from "../src/index.js";
import { DEVICE_A, opUuid, SAMPLE_FIELDS } from "./samples.js";

const ACCOUNT_OPERATION = {
  opId: opUuid(1),
  deviceId: DEVICE_A,
  lamport: 1,
  entity: "account",
  action: "create",
  targetId: "account-1",
  fields: SAMPLE_FIELDS.account,
} satisfies Record<string, unknown>;

const ACCOUNT_TEXT = JSON.stringify(ACCOUNT_OPERATION);

function accountOperationText(patch: string): string {
  return `${ACCOUNT_TEXT.slice(0, -2)},${patch}}}`;
}

function accountOperationWithField(patch: string): string {
  return `${ACCOUNT_TEXT.slice(0, -1)},${patch}}`;
}

const UNLABELLED_EXPENSE = {
  kind: "expense",
  occurredOn: "2026-07-08",
  status: "posted",
  amountMinor: 2_200_000,
  accountId: "account-1",
  categoryId: "category-1",
} satisfies TransactionFields;

/** The same expense, attributed to the participant who made it. */
const LABELLED_EXPENSE = { ...UNLABELLED_EXPENSE, memberId: "member-petr" } satisfies TransactionFields;

const UNCATEGORISED_INCOME = {
  kind: "income",
  occurredOn: "2026-07-01",
  status: "posted",
  amountMinor: 18_000_000,
  accountId: "account-1",
} satisfies TransactionFields;

/** The same income, filed under the category the family earns it in. */
const CATEGORISED_INCOME = { ...UNCATEGORISED_INCOME, categoryId: "category-salary" } satisfies TransactionFields;

function transactionFieldsOf(operation: Operation): TransactionFields | null {
  return operation.action === "create" && operation.entity === "transaction" ? operation.fields : null;
}

/** The category of an income, narrowed: the other kinds answer a different question with it. */
function incomeCategoryOf(operation: Operation): string | null {
  const fields = transactionFieldsOf(operation);
  return fields !== null && fields.kind === "income" ? (fields.categoryId ?? null) : null;
}

describe("parseOperation", () => {
  it("accepts a create, an update and a delete for every entity kind", () => {
    for (const entity of ENTITY_KINDS) {
      for (const action of ["create", "update"] as const) {
        const operation = parseOperation({
          opId: opUuid(1),
          deviceId: DEVICE_A,
          lamport: 7,
          memberId: "member-1",
          entity,
          action,
          targetId: `${entity}-1`,
          fields: SAMPLE_FIELDS[entity],
        });
        expect(operation.action).toBe(action);
        expect(operation.entity).toBe(entity);
        expect(operation).toEqual({
          opId: opUuid(1),
          deviceId: DEVICE_A,
          lamport: 7,
          memberId: "member-1",
          entity,
          action,
          targetId: `${entity}-1`,
          fields: SAMPLE_FIELDS[entity],
        });
      }
      const removal = parseOperation({
        opId: opUuid(2),
        deviceId: DEVICE_A,
        lamport: 8,
        entity,
        action: "delete",
        targetId: `${entity}-1`,
      });
      expect(removal).toEqual({
        opId: opUuid(2),
        deviceId: DEVICE_A,
        lamport: 8,
        entity,
        action: "delete",
        targetId: `${entity}-1`,
      });
    }
  });

  it("accepts every transaction kind", () => {
    const base = { occurredOn: "2026-07-09", status: "posted", amountMinor: 400_000 };
    const variants = [
      { ...base, kind: "income", accountId: "account-1" },
      { ...base, kind: "expense", accountId: "account-1", categoryId: "category-1" },
      { ...base, kind: "refund", accountId: "account-1", categoryId: "category-1", originalTransactionId: "tx-1" },
      { ...base, kind: "transfer", fromAccountId: "account-1", toAccountId: "account-2" },
      { ...base, kind: "goal_contribution", fromAccountId: "account-1", toAccountId: "account-2", goalId: "goal-1" },
    ];
    for (const [index, fields] of variants.entries()) {
      const operation = parseOperation({
        opId: opUuid(index),
        deviceId: DEVICE_A,
        lamport: index + 1,
        entity: "transaction",
        action: "create",
        targetId: `tx-${index}`,
        fields,
      });
      expect(operation.action === "create" && operation.entity === "transaction" ? operation.fields : null).toEqual(fields);
    }
  });

  it("accepts the budget activation pointer only for a budget", () => {
    expect(
      parseOperation({
        opId: opUuid(1),
        deviceId: DEVICE_A,
        lamport: 1,
        entity: "budget",
        action: "activate",
        targetId: "budget-1",
      }).action,
    ).toBe("activate");
    expect(() =>
      parseOperation({
        opId: opUuid(1),
        deviceId: DEVICE_A,
        lamport: 1,
        entity: "account",
        action: "activate",
        targetId: "account-1",
      }),
    ).toThrow(/only a budget supports the activate action/);
  });

  it("rejects a payload that is not an object", () => {
    expect(() => parseOperation("операция")).toThrow(SyncProtocolError);
    expect(() => parseOperation(null)).toThrow(SyncProtocolError);
    expect(() => parseOperation([1, 2, 3])).toThrow(SyncProtocolError);
  });

  it("bounds the Lamport stamp to the policy ceiling of 2^40", () => {
    // The ceiling is policy, not the limit of the number type: one peer sending an absurd
    // stamp must not be able to push every clock in the family beyond its own reach.
    expect(MAX_LAMPORT).toBe(1_099_511_627_776);
    expect(MAX_LAMPORT).toBeLessThan(Number.MAX_SAFE_INTEGER);
    expect(parseOperation({ ...ACCOUNT_OPERATION, lamport: MAX_LAMPORT }).lamport).toBe(MAX_LAMPORT);
    expect(parseOperation({ ...ACCOUNT_OPERATION, lamport: 1 }).lamport).toBe(1);

    // Zero would mean an operation no clock ever produced, so the range starts at one.
    for (const lamport of [0, -1, MAX_LAMPORT + 1, MAX_LAMPORT * 2, Number.MAX_SAFE_INTEGER]) {
      expect(() => parseOperation({ ...ACCOUNT_OPERATION, lamport })).toThrow(
        /operation lamport must be from 1 to 1099511627776/,
      );
    }
    expect(() => parseOperation({ ...ACCOUNT_OPERATION, lamport: 1.5 })).toThrow(
      /operation lamport must be an integer/,
    );
    expect(() => decodeOperation(ACCOUNT_TEXT.replace('"lamport":1', '"lamport":1099511627777'))).toThrow(
      SyncProtocolError,
    );
  });

  it("requires a lowercase UUID version 4 for the identifiers that break ties", () => {
    // Both tiebreakers of the merge are compared as text. A tiebreaker is only fair when
    // every participant draws from the same space: an unconstrained identifier lets one peer
    // take the largest string there is and never lose a conflict again.
    const malformed = [
      "device-a",
      "",
      " ",
      "z".repeat(36),
      DEVICE_A.toUpperCase(),
      DEVICE_A.replace("-4", "-5"),
      `${DEVICE_A} `,
      DEVICE_A.slice(0, 35),
      `${DEVICE_A}0`,
      "00000000-0000-4000-c000-000000000000",
      "\u0000".repeat(36),
    ];
    for (const value of malformed) {
      expect(() => parseOperation({ ...ACCOUNT_OPERATION, deviceId: value })).toThrow(
        /operation deviceId must be a lowercase UUID version 4/,
      );
      expect(() => parseOperation({ ...ACCOUNT_OPERATION, opId: value })).toThrow(
        /operation opId must be a lowercase UUID version 4/,
      );
    }
    expect(() => parseOperation({ ...ACCOUNT_OPERATION, deviceId: 7 })).toThrow(
      /operation deviceId must be a string/,
    );
    // A member identifier is a stable id of the domain, not a device, so it keeps its shape.
    expect(parseOperation({ ...ACCOUNT_OPERATION, memberId: "member-anna" }).memberId).toBe("member-anna");
    expect(parseUuid(crypto.randomUUID(), "generated")).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("bounds every money field to a ceiling that keeps a thousand of them safe", () => {
    // The previous ceiling of 10^13 did not defend anything: 901 amounts at that ceiling add
    // up past Number.MAX_SAFE_INTEGER, and the domain throws on the first addition that goes
    // over, on every device in the family at once, while the merge reports itself ready.
    expect(MAX_MONEY_MINOR).toBe(10 ** 10);
    expect(10 ** 13 * 901).toBeGreaterThan(Number.MAX_SAFE_INTEGER);
    expect(MAX_MONEY_MINOR * 100_000).toBeLessThan(Number.MAX_SAFE_INTEGER);

    const withBalance = (openingBalanceMinor: number): unknown => ({
      ...ACCOUNT_OPERATION,
      fields: { ...SAMPLE_FIELDS.account, openingBalanceMinor },
    });
    expect(() => parseOperation(withBalance(MAX_MONEY_MINOR))).not.toThrow();
    expect(() => parseOperation(withBalance(-MAX_MONEY_MINOR))).not.toThrow();
    expect(() => parseOperation(withBalance(MAX_MONEY_MINOR + 1))).toThrow(
      /account openingBalanceMinor must be at most 10000000000/,
    );
    expect(() => parseOperation(withBalance(-MAX_MONEY_MINOR - 1))).toThrow(
      /account openingBalanceMinor must be at least -10000000000/,
    );
  });

  it("takes its bounds from the domain, so the two cannot disagree", () => {
    // A bound the codec kept for itself let the domain and the backup gate accept a value the codec
    // then refused, and the value was stranded on the device that wrote it.
    expect(MAX_MONEY_MINOR).toBe(domain.MAX_MONEY_MINOR);
    expect(MIN_LOCAL_DATE).toBe(domain.MIN_LOCAL_DATE);
    expect(MAX_LOCAL_DATE).toBe(domain.MAX_LOCAL_DATE);
    const sorted = (sortOrder: number): unknown => ({ ...ACCOUNT_OPERATION, fields: { ...SAMPLE_FIELDS.account, sortOrder } });
    expect(() => parseOperation(sorted(domain.MAX_SORT_ORDER))).not.toThrow();
    expect(() => parseOperation(sorted(-domain.MAX_SORT_ORDER))).not.toThrow();
    expect(() => parseOperation(sorted(domain.MAX_SORT_ORDER + 1))).toThrow(/account sortOrder must be from/);
  });

  it("keeps every date inside the calendar the domain can plan over", () => {
    // An active budget dated 9999-12-01 makes the annual plan walk past the end of the
    // supported calendar and throw on every device, and it takes two operations to place.
    expect([MIN_LOCAL_DATE, MAX_LOCAL_DATE]).toEqual(["1900-01-01", "2199-12-31"]);
    const withBudget = (startDate: string, endDate: string): unknown => ({
      ...ACCOUNT_OPERATION,
      entity: "budget",
      fields: { ...SAMPLE_FIELDS.budget, startDate, endDate },
    });
    expect(() => parseOperation(withBudget("9999-12-01", "9999-12-31"))).toThrow(
      /budget startDate must be from 1900-01-01 to 2199-12-31/,
    );
    expect(() => parseOperation(withBudget("2026-07-01", "9999-12-31"))).toThrow(
      /budget endDate must be from 1900-01-01 to 2199-12-31/,
    );
    expect(() => parseOperation(withBudget("1899-12-31", "2026-07-31"))).toThrow(
      /budget startDate must be from 1900-01-01 to 2199-12-31/,
    );
    expect(() => parseOperation(withBudget(MIN_LOCAL_DATE, MAX_LOCAL_DATE))).not.toThrow();

    for (const [entity, patch] of [
      ["transaction", { occurredOn: "9999-12-01" }],
      ["annualCommitment", { dueDate: "2200-01-01" }],
    ] as const) {
      expect(() =>
        parseOperation({ ...ACCOUNT_OPERATION, entity, fields: { ...SAMPLE_FIELDS[entity], ...patch } }),
      ).toThrow(/must be from 1900-01-01 to 2199-12-31/);
    }
  });

  it("rejects a payload nested too deeply or holding too many values", () => {
    // The shape walk runs before any field is read, so both limits speak before validation.
    let deep: unknown = "лист";
    for (let level = 0; level < 12; level += 1) deep = { nested: deep };
    expect(() => parseOperation({ ...ACCOUNT_OPERATION, fields: deep })).toThrow(
      /operation is nested too deeply/,
    );

    // Six levels below the fields object stay inside the depth limit, so the field check speaks.
    let shallow: unknown = "лист";
    for (let level = 0; level < 6; level += 1) shallow = { nested: shallow };
    expect(() => parseOperation({ ...ACCOUNT_OPERATION, fields: shallow })).toThrow(
      /account fields contains unknown field nested/,
    );

    const wide = (length: number): unknown => ({
      ...ACCOUNT_OPERATION,
      fields: { list: Array.from({ length }, () => 1) },
    });
    expect(() => parseOperation(wide(2_100))).toThrow(/operation contains too many values/);
    expect(() => parseOperation(wide(1_900))).toThrow(/account fields contains unknown field list/);
  });

  it("measures the envelope of what it rebuilt", () => {
    expect(MAX_OPERATION_BYTES).toBe(8 * 1024);
    // Every field is bounded, so a valid operation is far below the envelope; the check is
    // what keeps that a fact rather than an assumption about the field bounds.
    const encoded = encodeOperation(parseOperation(ACCOUNT_OPERATION));
    expect(new TextEncoder().encode(encoded).byteLength).toBeLessThan(MAX_OPERATION_BYTES);
    expect(() => parseOperation({ ...ACCOUNT_OPERATION, targetId: "т".repeat(129) })).toThrow(
      /operation targetId must be at most 128 characters/,
    );
  });
});

describe("compareOperations", () => {
  it("answers a value that never went through the codec with a rejection, not a stack overflow", () => {
    // The comparison is public and falls back to the canonical encoding, so it must not meet
    // a hand-built value with a RangeError a caller cannot tell apart from a bug.
    const cyclic = { ...ACCOUNT_OPERATION } as Record<string, unknown>;
    cyclic.fields = { ...SAMPLE_FIELDS.account, self: cyclic };
    const other = { ...ACCOUNT_OPERATION, fields: { ...SAMPLE_FIELDS.account } } as unknown as Operation;
    expect(() => compareOperations(cyclic as unknown as Operation, other)).toThrow(SyncProtocolError);

    let deep: unknown = "лист";
    for (let level = 0; level < 5_000; level += 1) deep = { nested: deep };
    expect(() =>
      compareOperations({ ...ACCOUNT_OPERATION, fields: deep } as unknown as Operation, other),
    ).toThrow(/nested too deeply/);

    // The header alone decides whenever it can, so validated operations never reach the text.
    const left = parseOperation(ACCOUNT_OPERATION);
    const right = parseOperation({ ...ACCOUNT_OPERATION, lamport: 2 });
    expect(compareOperations(left, right)).toBe(-1);
    expect(compareOperations(right, left)).toBe(1);
    expect(compareOperations(left, left)).toBe(0);
  });
});

describe("decodeOperation", () => {
  it("round-trips through a canonical encoding with sorted keys", () => {
    const operation = decodeOperation(ACCOUNT_TEXT);
    const encoded = encodeOperation(operation);
    expect(Object.keys(JSON.parse(encoded) as Record<string, unknown>)).toEqual([
      "action",
      "deviceId",
      "entity",
      "fields",
      "lamport",
      "opId",
      "targetId",
    ]);
    expect(decodeOperation(encoded)).toEqual(operation);
    expect(encodeOperation(decodeOperation(encoded))).toBe(encoded);
  });

  it("carries the participant who spent the money through a round trip, and invents none", () => {
    // Two participants travel with one operation and answer different questions. The header
    // says who *wrote* it down — a member correcting somebody else's expense writes their own
    // identifier there — and the transaction says whose spending it is, which is the one the
    // domain reads to split a budget by participant.
    //
    // The field list of a transaction is strict and had no place for the second. A labelled
    // expense was therefore rejected as an unknown field, so it could be entered on one device
    // and never reach another: attribution did not survive the journal at all.
    const labelled: Operation = {
      opId: opUuid(3),
      deviceId: DEVICE_A,
      lamport: 5,
      memberId: "member-anna",
      entity: "transaction",
      action: "create",
      targetId: "tx-1",
      fields: LABELLED_EXPENSE,
    };

    const encoded = encodeOperation(labelled);
    const decoded = decodeOperation(encoded);
    expect(decoded).toEqual(labelled);
    expect(encodeOperation(decoded)).toBe(encoded);
    expect(decoded.memberId).toBe("member-anna");
    expect(transactionFieldsOf(decoded)?.memberId).toBe("member-petr");

    // Every transaction written before participants existed carries no label, and a trip
    // through the codec must not hand it one: an absent label and an empty label are
    // different values to the domain, and only the first means "nobody in particular".
    const plain: Operation = { ...labelled, fields: UNLABELLED_EXPENSE };
    const restored = decodeOperation(encodeOperation(plain));
    expect(restored).toEqual(plain);
    const fields = transactionFieldsOf(restored);
    expect(fields).not.toBeNull();
    expect(fields !== null && "memberId" in fields).toBe(false);

    // The list stays strict: the label was added to it by name, not by opening it up.
    expect(() =>
      parseOperation({ ...labelled, fields: { ...UNLABELLED_EXPENSE, memberOf: "member-petr" } }),
    ).toThrow(/transaction fields contains unknown field memberOf/);
    // And the label is an identifier of the domain, held to the same shape as every other one.
    expect(() => parseOperation({ ...labelled, fields: { ...UNLABELLED_EXPENSE, memberId: "  " } })).toThrow(
      /transaction memberId must not be empty/,
    );
    expect(() => parseOperation({ ...labelled, fields: { ...UNLABELLED_EXPENSE, memberId: 7 } })).toThrow(
      /transaction memberId must be a string/,
    );
  });

  it("carries the category of an income through a round trip, and invents none", () => {
    // The same omission as the participant's, one field later. Income had no category at all
    // until the domain gained one; the strict list here did not follow, so a categorised income
    // was rejected as an unknown field and could be entered on one device and never reach
    // another. The category then lived only where it was typed.
    const filed: Operation = {
      opId: opUuid(4),
      deviceId: DEVICE_A,
      lamport: 6,
      entity: "transaction",
      action: "create",
      targetId: "tx-income-1",
      fields: CATEGORISED_INCOME,
    };

    const encoded = encodeOperation(filed);
    const decoded = decodeOperation(encoded);
    expect(decoded).toEqual(filed);
    expect(encodeOperation(decoded)).toBe(encoded);
    expect(incomeCategoryOf(decoded)).toBe("category-salary");

    // Every income written before income had categories carries none, and a trip through the
    // codec must not hand it one: `categoryId: undefined` is a different value to the domain
    // than no category at all, exactly as with the participant's label.
    const plain: Operation = { ...filed, fields: UNCATEGORISED_INCOME };
    const restored = decodeOperation(encodeOperation(plain));
    expect(restored).toEqual(plain);
    const fields = transactionFieldsOf(restored);
    expect(fields).not.toBeNull();
    expect(fields !== null && "categoryId" in fields).toBe(false);

    // The two labels are independent, and an income may carry both.
    const both = decodeOperation(
      encodeOperation({ ...filed, fields: { ...CATEGORISED_INCOME, memberId: "member-petr" } }),
    );
    expect(transactionFieldsOf(both)).toEqual({ ...CATEGORISED_INCOME, memberId: "member-petr" });

    // The list stays strict: the field was added to it by name, not by opening it up.
    expect(() =>
      parseOperation({ ...filed, fields: { ...UNCATEGORISED_INCOME, categoryOf: "category-salary" } }),
    ).toThrow(/transaction fields contains unknown field categoryOf/);
    // And it is an identifier of the domain, held to the same shape as every other one.
    expect(() => parseOperation({ ...filed, fields: { ...UNCATEGORISED_INCOME, categoryId: "  " } })).toThrow(
      /transaction categoryId must not be empty/,
    );
    expect(() => parseOperation({ ...filed, fields: { ...UNCATEGORISED_INCOME, categoryId: 7 } })).toThrow(
      /transaction categoryId must be a string/,
    );

    // Widened for the income alone. A transfer files nothing under a category, and an expense
    // may not go without one, so neither list moved a field.
    expect(() =>
      parseOperation({
        ...filed,
        fields: {
          kind: "transfer",
          occurredOn: "2026-07-01",
          status: "posted",
          amountMinor: 500_000,
          fromAccountId: "account-1",
          toAccountId: "account-2",
          categoryId: "category-salary",
        },
      }),
    ).toThrow(/transaction fields contains unknown field categoryId/);
    const { categoryId: _required, ...expenseWithoutCategory } = UNLABELLED_EXPENSE;
    expect(() => parseOperation({ ...filed, fields: expenseWithoutCategory })).toThrow(
      /transaction fields is missing field categoryId/,
    );
  });

  it("encodes equal operations to equal bytes regardless of key order", () => {
    const left: Operation = {
      opId: opUuid(1),
      deviceId: DEVICE_A,
      lamport: 4,
      entity: "member",
      action: "create",
      targetId: "member-1",
      fields: { name: "Мария", role: "owner", active: true },
    };
    const right: Operation = {
      targetId: "member-1",
      action: "create",
      entity: "member",
      fields: { active: true, role: "owner", name: "Мария" },
      lamport: 4,
      deviceId: DEVICE_A,
      opId: opUuid(1),
    };
    expect(encodeOperation(left)).toBe(encodeOperation(right));
  });

  it("rejects an unknown field", () => {
    expect(() => decodeOperation(accountOperationWithField('"shadow":1'))).toThrow(
      /operation contains unknown field shadow/,
    );
    expect(() => decodeOperation(accountOperationText('"unexpected":1'))).toThrow(
      /account fields contains unknown field unexpected/,
    );
  });

  it("rejects prototype-polluting field names", () => {
    const payloads = [
      accountOperationText('"__proto__":{"polluted":true}'),
      accountOperationText('"constructor":{"polluted":true}'),
      accountOperationText('"prototype":{"polluted":true}'),
      accountOperationWithField('"__proto__":{"polluted":true}'),
    ];
    for (const text of payloads) {
      expect(() => decodeOperation(text)).toThrow(/forbidden field name/);
    }
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    expect(Object.prototype.hasOwnProperty.call(Object.prototype, "polluted")).toBe(false);
  });

  it("rejects amounts that are not safe integers in minor units", () => {
    const unsafe = ["9007199254740993", "1234.5", "1e400", '"2200000"', "null"];
    for (const value of unsafe) {
      const text = ACCOUNT_TEXT.replace('"openingBalanceMinor":0', `"openingBalanceMinor":${value}`);
      expect(() => decodeOperation(text)).toThrow(SyncProtocolError);
    }
    // An account may legitimately open in the red, so a negative balance stays valid.
    expect(() => decodeOperation(ACCOUNT_TEXT.replace('"openingBalanceMinor":0', '"openingBalanceMinor":-1'))).not.toThrow();
    const negativeTransaction = {
      opId: opUuid(1),
      deviceId: DEVICE_A,
      lamport: 1,
      entity: "transaction",
      action: "create",
      targetId: "tx-1",
      fields: { ...SAMPLE_FIELDS.transaction, amountMinor: -2_200_000 },
    };
    expect(() => parseOperation(negativeTransaction)).toThrow(/transaction amountMinor must be at least 1/);
    expect(() => parseOperation({ ...negativeTransaction, fields: { ...SAMPLE_FIELDS.transaction, amountMinor: 2 ** 53 } })).toThrow(
      /must be an integer minor-unit amount/,
    );
  });

  it("rejects malformed headers, enums, dates and month lists", () => {
    const cases: ReadonlyArray<readonly [unknown, RegExp]> = [
      [{ ...ACCOUNT_OPERATION, lamport: -1 }, /operation lamport must be from 1 to 1099511627776/],
      [{ ...ACCOUNT_OPERATION, lamport: 1.5 }, /operation lamport must be an integer/],
      [{ ...ACCOUNT_OPERATION, opId: "" }, /operation opId must be a lowercase UUID version 4/],
      [{ ...ACCOUNT_OPERATION, deviceId: "d".repeat(129) }, /operation deviceId must be a lowercase UUID version 4/],
      [{ ...ACCOUNT_OPERATION, targetId: "" }, /operation targetId must not be empty/],
      [{ ...ACCOUNT_OPERATION, targetId: "т".repeat(129) }, /operation targetId must be at most/],
      [{ ...ACCOUNT_OPERATION, entity: "wallet" }, /operation entity has unknown value wallet/],
      [{ ...ACCOUNT_OPERATION, action: "merge" }, /operation action has unknown value merge/],
      [
        { ...ACCOUNT_OPERATION, fields: { ...SAMPLE_FIELDS.account, type: "crypto" } },
        /account type has unknown value crypto/,
      ],
      [
        { ...ACCOUNT_OPERATION, fields: { ...SAMPLE_FIELDS.account, currency: "руб" } },
        /account currency must be a three-letter currency code/,
      ],
      [
        { ...ACCOUNT_OPERATION, fields: { name: "Основной", type: "current", currency: "RUB", active: true } },
        /account fields is missing field openingBalanceMinor/,
      ],
      [
        {
          ...ACCOUNT_OPERATION,
          entity: "annualCommitment",
          fields: { ...SAMPLE_FIELDS.annualCommitment, dueDate: "2027-02-30" },
        },
        /annual commitment dueDate must be a valid calendar date/,
      ],
      [
        {
          ...ACCOUNT_OPERATION,
          entity: "scheduledExpense",
          fields: { ...SAMPLE_FIELDS.scheduledExpense, months: [1, 1, 3] },
        },
        /scheduled expense months must not repeat a calendar month/,
      ],
      [
        {
          ...ACCOUNT_OPERATION,
          entity: "scheduledExpense",
          fields: { ...SAMPLE_FIELDS.scheduledExpense, mode: "monthly" },
        },
        /scheduled expense months is only allowed for selected_months/,
      ],
      [
        { ...ACCOUNT_OPERATION, entity: "budget", fields: { ...SAMPLE_FIELDS.budget, warningThreshold: 1 } },
        /budget warningThreshold must be in \[0, 1\)/,
      ],
      [
        {
          ...ACCOUNT_OPERATION,
          entity: "budget",
          fields: { ...SAMPLE_FIELDS.budget, startDate: "2026-08-01" },
        },
        /budget startDate must not be after endDate/,
      ],
    ];
    for (const [value, message] of cases) {
      expect(() => parseOperation(value)).toThrow(message);
    }
  });

  it("rejects invalid JSON and oversized envelopes", () => {
    expect(() => decodeOperation("{")).toThrow(/operation is not valid JSON/);
    const huge = ACCOUNT_TEXT.replace("Основной", "О".repeat(MAX_OPERATION_BYTES));
    expect(() => decodeOperation(huge)).toThrow(/larger than the allowed envelope/);
    expect(() =>
      encodeOperation({
        opId: opUuid(1),
        deviceId: DEVICE_A,
        lamport: 1,
        entity: "account",
        action: "create",
        targetId: "account-1",
        fields: { ...SAMPLE_FIELDS.account, name: "О".repeat(201) },
      }),
    ).toThrow(/account name must be at most 200 characters/);
  });
});

describe("display fields, notes and tags", () => {
  const TAGGED_EXPENSE = {
    ...UNLABELLED_EXPENSE,
    note: "Пятёрочка у дома",
    tagIds: ["tag-home", "tag-holiday"],
  } satisfies TransactionFields;

  function write(entity: string, fields: unknown, lamport = 9): unknown {
    return { opId: opUuid(lamport), deviceId: DEVICE_A, lamport, entity, action: "create", targetId: `${entity}-1`, fields };
  }

  function fieldsOf(operation: Operation): unknown {
    return operation.action === "create" || operation.action === "update" ? operation.fields : null;
  }

  it("carries every new field through a round trip, and invents none", () => {
    const written: readonly (readonly [string, Record<string, unknown>])[] = [
      ["account", { ...SAMPLE_FIELDS.account, sortOrder: 20, icon: "banknote", color: "sage", includeInTotal: false }],
      ["category", { ...SAMPLE_FIELDS.category, icon: "shopping-basket", color: "mint" }],
      ["goal", { ...SAMPLE_FIELDS.goal, deadline: "2027-06-01", icon: "plane" }],
      ["transaction", { ...TAGGED_EXPENSE, recurringRuleId: "rule-water" }],
      ["transaction", { ...CATEGORISED_INCOME, memberId: "member-petr", note: "Аванс за август", tagIds: ["tag-old"] }],
      ["tag", { name: "Отпуск", active: false }],
    ];
    for (const [entity, fields] of written) {
      const operation = parseOperation(write(entity, fields));
      const decoded = decodeOperation(encodeOperation(operation));
      expect(fieldsOf(decoded), entity).toEqual(fields);
      expect(encodeOperation(decoded)).toBe(encodeOperation(operation));
    }

    // Everything written before these fields existed carries none, and keeps carrying none.
    const added = {
      account: ["sortOrder", "icon", "color", "includeInTotal"],
      category: ["icon", "color"],
      goal: ["deadline", "icon"],
      transaction: ["note", "tagIds", "recurringRuleId"],
    } as const;
    for (const entity of ["account", "category", "goal", "transaction"] as const) {
      const plain = fieldsOf(decodeOperation(encodeOperation(parseOperation(write(entity, SAMPLE_FIELDS[entity])))));
      expect(plain).toEqual(SAMPLE_FIELDS[entity]);
      for (const field of added[entity]) {
        expect(Object.hasOwn(plain as object, field), `${entity}.${field}`).toBe(false);
      }
    }
  });

  it("puts the labels on every kind of transaction and keeps the lists strict otherwise", () => {
    const base = { occurredOn: "2026-07-09", status: "posted", amountMinor: 400_000, note: "Заметка", tagIds: ["tag-1"], recurringRuleId: "rule-1" };
    const kinds = [
      { ...base, kind: "income", accountId: "account-1" },
      { ...base, kind: "expense", accountId: "account-1", categoryId: "category-1" },
      { ...base, kind: "refund", accountId: "account-1", categoryId: "category-1", originalTransactionId: "tx-1" },
      { ...base, kind: "transfer", fromAccountId: "account-1", toAccountId: "account-2" },
      { ...base, kind: "goal_contribution", fromAccountId: "account-1", toAccountId: "account-2", goalId: "goal-1" },
    ];
    for (const fields of kinds) expect(fieldsOf(parseOperation(write("transaction", fields)))).toEqual(fields);

    expect(() => parseOperation(write("transaction", { ...TAGGED_EXPENSE, notes: "x" })))
      .toThrow(/transaction fields contains unknown field notes/);
    expect(() => parseOperation(write("tag", { name: "Отпуск", active: true, color: "sage" })))
      .toThrow(/tag fields contains unknown field color/);
    expect(() => parseOperation(write("member", { ...SAMPLE_FIELDS.member, icon: "plane" })))
      .toThrow(/member fields contains unknown field icon/);
  });

  it.each([
    ["a note that is not a string", "transaction", { ...UNLABELLED_EXPENSE, note: 7 }, /transaction note must be a string/],
    ["an empty note", "transaction", { ...UNLABELLED_EXPENSE, note: "" }, /transaction note must be one trimmed line/],
    ["a note with a leading space", "transaction", { ...UNLABELLED_EXPENSE, note: " Пятёрочка" }, /transaction note must be one trimmed line/],
    ["a note of two lines", "transaction", { ...UNLABELLED_EXPENSE, note: "Пятёрочка\nу дома" }, /transaction note must be one trimmed line/],
    ["a note with a bidi override", "transaction", { ...UNLABELLED_EXPENSE, note: "Пятёрочка\u202e" }, /transaction note must be one trimmed line/],
    ["a note longer than 500", "transaction", { ...UNLABELLED_EXPENSE, note: "я".repeat(501) }, /transaction note must be at most 500 characters/],
    ["an empty list of tags", "transaction", { ...UNLABELLED_EXPENSE, tagIds: [] }, /transaction tagIds must list from 1 to 10 tags/],
    ["eleven tags", "transaction", { ...UNLABELLED_EXPENSE, tagIds: Array.from({ length: 11 }, (_, index) => `tag-${index}`) }, /transaction tagIds must list from 1 to 10 tags/],
    ["a repeated tag", "transaction", { ...UNLABELLED_EXPENSE, tagIds: ["tag-1", "tag-1"] }, /transaction tagIds must not repeat a tag/],
    ["a tag that is not a string", "transaction", { ...UNLABELLED_EXPENSE, tagIds: [7] }, /transaction tagIds\[0\] must be a string/],
    ["a blank tag", "transaction", { ...UNLABELLED_EXPENSE, tagIds: ["  "] }, /transaction tagIds\[0\] must not be empty/],
    ["tags that are not a list", "transaction", { ...UNLABELLED_EXPENSE, tagIds: "tag-1" }, /transaction tagIds must list from 1 to 10 tags/],
    ["a blank recurring rule", "transaction", { ...UNLABELLED_EXPENSE, recurringRuleId: " " }, /transaction recurringRuleId must not be empty/],
    ["a tag name with a trailing space", "tag", { name: "Отпуск ", active: true }, /tag name must be trimmed, normalized text/],
    ["a tag name in two alphabets", "tag", { name: "Отпуск Paris", active: true }, /tag name must be trimmed, normalized text/],
    ["a tag name longer than 40", "tag", { name: "я".repeat(41), active: true }, /tag name must be at most 40 characters/],
    ["a tag without a flag", "tag", { name: "Отпуск" }, /tag fields is missing field active/],
    ["a colour for an icon", "account", { ...SAMPLE_FIELDS.account, icon: "#00ff00" }, /account icon must be a design-token key/],
    ["a file name for a colour", "category", { ...SAMPLE_FIELDS.category, color: "mint.png" }, /category color must be a design-token key/],
    ["a fractional sort order", "account", { ...SAMPLE_FIELDS.account, sortOrder: 1.5 }, /account sortOrder must be an integer/],
    ["an unbounded sort order", "account", { ...SAMPLE_FIELDS.account, sortOrder: 1_000_001 }, /account sortOrder must be from -1000000 to 1000000/],
    ["a total flag that is a word", "account", { ...SAMPLE_FIELDS.account, includeInTotal: "yes" }, /account includeInTotal must be a boolean/],
    ["an impossible deadline", "goal", { ...SAMPLE_FIELDS.goal, deadline: "2027-02-29" }, /goal deadline must be a valid calendar date/],
    ["a deadline past the calendar", "goal", { ...SAMPLE_FIELDS.goal, deadline: "2200-01-01" }, /goal deadline must be from 1900-01-01 to 2199-12-31/],
    ["an icon that is a number", "goal", { ...SAMPLE_FIELDS.goal, icon: 7 }, /goal icon must be a design-token key/],
  ] as const)("refuses %s", (_name, entity, fields, message) => {
    expect(() => parseOperation(write(entity, fields))).toThrow(message);
  });

  it("accepts every note normalizeNote stores and every tag name normalizeLabel stores", () => {
    // The domain's text rule is the wider one, so a note one device stored is a note every
    // other device accepts. Walked over every character of the Basic Multilingual Plane outside
    // the surrogates, inside a note and inside a tag name, plus a few emoji.
    const characters: string[] = ["🌴", "👨\u200d👩", "❤\ufe0f"];
    // A presentation selector between a letter and a combining mark: normalizeNote must drop it
    // before it composes, or what it stores is a note this codec refuses as not normalised.
    for (const base of ["A", "e", "и", "\u2764"]) {
      for (const mark of ["\u0301", "\u0306", "\u030a", "\u0327"]) {
        characters.push(`${base}\ufe0f${mark}`, `${base}\ufe0e${mark}`, `\ufe0f${base}${mark}\ufe0f`);
      }
    }
    for (let code = 0; code <= 0xffff; code += 1) {
      if (code < 0xd800 || code > 0xdfff) characters.push(String.fromCharCode(code));
    }
    let notes = 0;
    let names = 0;
    for (const character of characters) {
      let note: string | undefined;
      try {
        note = normalizeNote(`Заметка ${character} конец`);
      } catch {
        note = undefined;
      }
      if (note !== undefined) {
        notes += 1;
        const decoded = parseOperation(write("transaction", { ...UNLABELLED_EXPENSE, note }));
        expect(fieldsOf(decoded)).toEqual({ ...UNLABELLED_EXPENSE, note });
      }
      const name = `Дача${character}`;
      if (isNormalizedLabel(name, 40)) {
        names += 1;
        expect(fieldsOf(parseOperation(write("tag", { name, active: true })))).toEqual({ name, active: true });
      }
    }
    // Most of the plane is ordinary text; the refusals are the hidden characters and no more.
    expect(notes).toBeGreaterThan(60_000);
    expect(names).toBeGreaterThan(40_000);
  });

  it("fits the largest transaction the new fields allow into one envelope", () => {
    const largest = {
      ...UNLABELLED_EXPENSE,
      accountId: "a".repeat(128),
      categoryId: "c".repeat(128),
      memberId: "m".repeat(128),
      recurringRuleId: "r".repeat(128),
      // Three UTF-8 bytes per character, the widest a character of the plane takes.
      note: "中".repeat(500),
      tagIds: Array.from({ length: 10 }, (_, index) => `${index}`.padEnd(128, "t")),
    };
    const operation = { ...(write("transaction", largest) as Record<string, unknown>), memberId: "w".repeat(128), targetId: "x".repeat(128) };
    const encoded = encodeOperation(parseOperation(operation));
    expect(new TextEncoder().encode(encoded).byteLength).toBeLessThan(MAX_OPERATION_BYTES);
  });
});
