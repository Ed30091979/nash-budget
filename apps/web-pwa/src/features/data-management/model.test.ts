import { type BudgetState } from "@family-budget/domain";
import { describe, expect, it, vi } from "vitest";
import { makeG000State, OPERATIONS_TEST_IDS } from "../operations/test-fixture";
import {
  CSV_EXPORT_MEDIA_TYPE,
  DataManagementError,
  HUMAN_READABLE_CSV_NOTICE,
  JSON_EXPORT_MEDIA_TYPE,
  MAX_RECOVERY_FILE_BYTES,
  createOperationsCsv,
  formatLastBackupDate,
  prepareJsonDownload,
  prepareOperationsCsvDownload,
  validateRecoveryFile,
} from "./model";

const refundId = "88000000-0000-4000-8000-000000000001";
const transferId = "88000000-0000-4000-8000-000000000002";

function sixOperationState(): BudgetState {
  const state = makeG000State();
  return {
    ...state,
    transactions: [
      ...state.transactions,
      {
        id: refundId,
        kind: "refund",
        status: "posted",
        occurredOn: "2026-07-07",
        amountMinor: 150_000,
        accountId: OPERATIONS_TEST_IDS.accounts.main,
        categoryId: OPERATIONS_TEST_IDS.categories.products,
        originalTransactionId: OPERATIONS_TEST_IDS.transactions.products,
      },
      {
        id: transferId,
        kind: "transfer",
        status: "posted",
        occurredOn: "2026-07-08",
        amountMinor: 500_000,
        fromAccountId: OPERATIONS_TEST_IDS.accounts.main,
        toAccountId: OPERATIONS_TEST_IDS.accounts.savings,
      },
    ],
  };
}

describe("data-management exports", () => {
  it("uses fixed local-date filenames and exact media types", () => {
    const now = new Date(2026, 6, 17, 23, 55);
    const json = prepareJsonDownload('{"ok":true}', now);
    const csv = prepareOperationsCsvDownload(sixOperationState(), now);

    expect(json).toEqual({
      filename: "family-budget-backup-2026-07-17.json",
      mediaType: JSON_EXPORT_MEDIA_TYPE,
      text: '{"ok":true}',
    });
    expect(json.mediaType).toBe("application/json;charset=utf-8");
    expect(csv.filename).toBe("family-budget-operations-2026-07-17.csv");
    expect(csv.mediaType).toBe(CSV_EXPORT_MEDIA_TYPE);
    expect(csv.mediaType).toBe("text/csv;charset=utf-8");
  });

  it("creates Excel UTF-8 CSV with a header and exactly six data rows", () => {
    const csv = createOperationsCsv(sixOperationState());
    const rows = csv.slice(1).trimEnd().split("\r\n");

    expect(csv.startsWith("\uFEFFДата,")).toBe(true);
    expect(rows).toHaveLength(7);
    // Plan 6: the seven columns of 1.0.0 stay first and unchanged; wave 1 appends its own after them.
    expect(rows[0]!.startsWith("Дата,Тип,Статус,\"Сумма, ₽\",Счёт,Категория или цель,Связь с исходной операцией,")).toBe(true);
    expect(rows.filter((row) => row.includes("Продукты"))).toHaveLength(2);
    expect(rows.some((row) => row.includes("Возврат") && row.includes(refundId))).toBe(false);
    expect(rows.some((row) => row.includes(OPERATIONS_TEST_IDS.transactions.products))).toBe(true);
    expect(HUMAN_READABLE_CSV_NOTICE).toContain("not a full backup");
  });

  it("delegates formula neutralization and RFC escaping to the shared serializer", () => {
    const source = sixOperationState();
    const malicious: BudgetState = {
      ...source,
      accounts: source.accounts.map((item, index) => index === 0
        ? { ...item, name: "\u200B=HYPERLINK(\"https://invalid\")\nОсновной" }
        : item),
      categories: source.categories.map((item, index) => index === 0
        ? { ...item, name: "+SUM(1,1)" }
        : item),
    };

    const csv = createOperationsCsv(malicious);

    expect(csv).toContain("'\u200B=HYPERLINK");
    expect(csv).toContain("'+SUM(1,1)");
    expect(csv).toContain('""https://invalid""');
    expect(csv).not.toMatch(/(?:^|,)[=+@]/m);
  });
});

describe("recovery file boundary", () => {
  const file = (overrides: Partial<{ name: string; size: number; type: string }> = {}) => ({
    name: "family-budget-backup-2026-07-17.json",
    size: 42,
    type: "application/json",
    text: vi.fn(async () => "{}"),
    ...overrides,
  });

  it("accepts application/json and empty iOS MIME without reading contents", () => {
    const json = file();
    const ios = file({ type: "" });
    validateRecoveryFile(json);
    validateRecoveryFile(ios);
    expect(json.text).not.toHaveBeenCalled();
    expect(ios.text).not.toHaveBeenCalled();
  });

  it("rejects oversized, non-JSON-name and non-JSON-MIME files generically before text", () => {
    const cases = [
      file({ size: MAX_RECOVERY_FILE_BYTES + 1 }),
      file({ name: "copy.txt" }),
      file({ type: "text/plain" }),
    ];
    for (const candidate of cases) {
      expect(() => validateRecoveryFile(candidate)).toThrow(DataManagementError);
      expect(candidate.text).not.toHaveBeenCalled();
    }
  });

  it("formats stored success metadata without exposing invalid values", () => {
    expect(formatLastBackupDate(null)).toBe("резервная копия ещё не создавалась");
    expect(formatLastBackupDate("2026-07-17T09:30:00.000Z")).toContain("17 июл. 2026");
    expect(formatLastBackupDate("not-a-date")).toBe("дата недоступна");
  });
});

describe("операции по долгу в CSV", () => {
  it("называет каждое движение одним из четырёх глаголов по направлению долга", () => {
    const state = makeG000State();
    const main = OPERATIONS_TEST_IDS.accounts.main;
    const lent = "88000000-0000-4000-8000-0000000000d1";
    const owed = "88000000-0000-4000-8000-0000000000d2";
    const movement = (id: string, kind: "debt_out" | "debt_in", debtId: string) =>
      ({ id, kind, status: "posted" as const, occurredOn: "2026-07-09", amountMinor: 100_000, accountId: main, debtId });
    const csv = createOperationsCsv({
      ...state,
      debts: [
        { id: lent, counterparty: "Петя", direction: "owed_to_me", currency: "RUB", openingMinor: 0, active: true },
        { id: owed, counterparty: "Сергей", direction: "i_owe", currency: "RUB", openingMinor: 0, active: true },
      ],
      transactions: [
        movement("88000000-0000-4000-8000-0000000000e1", "debt_out", lent),
        movement("88000000-0000-4000-8000-0000000000e2", "debt_in", lent),
        movement("88000000-0000-4000-8000-0000000000e3", "debt_in", owed),
        movement("88000000-0000-4000-8000-0000000000e4", "debt_out", owed),
      ],
    });
    const rows = csv.slice(1).trimEnd().split("\r\n").slice(1);
    expect(rows.map((row) => row.split(",")[1])).toEqual(["Дал в долг", "Мне вернули долг", "Взял в долг", "Вернул долг"]);
    expect(rows[0]).toContain("Петя");
    expect(rows[2]).toContain("Сергей");
  });
});

describe("столбцы волны 1 в CSV", () => {
  const DOLLARS = "88000000-0000-4000-8000-0000000000c1";
  const HOME = "88000000-0000-4000-8000-0000000000a1";
  const OLD = "88000000-0000-4000-8000-0000000000a2";
  const SERGEY = "88000000-0000-4000-8000-0000000000d1";

  function ledger(note = "Пятёрочка у дома", tag = "Дом", counterparty = "Сергей"): BudgetState {
    const state = makeG000State();
    const main = OPERATIONS_TEST_IDS.accounts.main;
    return {
      ...state,
      tags: [{ id: HOME, name: tag, active: true }, { id: OLD, name: "Старое", active: false }],
      accounts: [...state.accounts, { id: DOLLARS, name: "Доллары", type: "savings", currency: "USD", openingBalanceMinor: 50_000, active: true }],
      debts: [{ id: SERGEY, counterparty, direction: "i_owe", currency: "USD", openingMinor: 0, active: true }],
      transactions: [
        { id: "88000000-0000-4000-8000-0000000000e1", kind: "expense", status: "posted", occurredOn: "2026-07-03", amountMinor: 1_250_000, accountId: main, categoryId: OPERATIONS_TEST_IDS.categories.products, note, tagIds: [HOME, OLD] },
        { id: "88000000-0000-4000-8000-0000000000e2", kind: "expense", status: "posted", occurredOn: "2026-07-20", amountMinor: 2_555, accountId: DOLLARS, categoryId: OPERATIONS_TEST_IDS.categories.products, baseAmountMinor: 236_338, baseCurrency: "RUB", rate: { baseMinor: 9_250, quoteMinor: 100 } },
        { id: "88000000-0000-4000-8000-0000000000e3", kind: "transfer", status: "posted", occurredOn: "2026-07-05", amountMinor: 1_800_000, fromAccountId: main, toAccountId: DOLLARS, toAmountMinor: 20_000 },
        { id: "88000000-0000-4000-8000-0000000000e4", kind: "transfer", status: "posted", occurredOn: "2026-07-06", amountMinor: 1_000, fromAccountId: DOLLARS, toAccountId: main, toAmountMinor: 90_000 },
        { id: "88000000-0000-4000-8000-0000000000e5", kind: "debt_out", status: "posted", occurredOn: "2026-07-28", amountMinor: 462_500, accountId: main, debtId: SERGEY, debtAmountMinor: 5_000 },
      ],
    };
  }

  /** One RFC 4180 row, read back: quoted fields unquoted, doubled quotes single, every field kept. */
  function fields(row: string): string[] {
    const result: string[] = [];
    let index = 0;
    for (;;) {
      let value = "";
      if (row[index] === '"') {
        index += 1;
        while (index < row.length && !(row[index] === '"' && row[index + 1] !== '"')) {
          value += row[index];
          index += row[index] === '"' ? 2 : 1;
        }
        index += 1;
      } else {
        const end = row.indexOf(",", index);
        value = row.slice(index, end === -1 ? row.length : end);
        index = end === -1 ? row.length : end;
      }
      result.push(value);
      if (index >= row.length) return result;
      index += 1;
    }
  }

  function table(state: BudgetState): string[][] {
    // None of these rows holds a line break, so a row of the file is a line of it.
    return createOperationsCsv(state).slice(1).replace(/\r\n$/, "").split("\r\n").map(fields);
  }

  it("дописывает восемь столбцов в конец, не трогая первых семи", () => {
    const [header] = table(ledger());
    expect(header).toEqual([
      "Дата", "Тип", "Статус", "Сумма, ₽", "Счёт", "Категория или цель", "Связь с исходной операцией",
      "Валюта счёта", "Сумма в валюте счёта", "Курс", "Сумма зачисления", "Валюта зачисления", "Долг", "Комментарий", "Метки",
    ]);
  });

  it("пишет сумму в базовой валюте, сумму и валюту счёта, курс, зачисление, долг, комментарий и метки", () => {
    const [, rouble, dollar, toDollars, fromDollars, debt] = table(ledger());
    expect(rouble).toEqual(["2026-07-03", "Расход", "Проведена", "12500,00", "Основной", "Продукты", "", "RUB", "12500,00", "", "", "", "", "Пятёрочка у дома", "Дом, Старое"]);
    expect(dollar).toEqual(["2026-07-20", "Расход", "Проведена", "2363,38", "Доллары", "Продукты", "", "USD", "25,55", "92,5", "", "", "", "", ""]);
    expect(toDollars).toEqual(["2026-07-05", "Перевод", "Проведена", "18000,00", "Основной → Доллары", "", "", "RUB", "18000,00", "", "200,00", "USD", "", "", ""]);
    // Из долларов в рубли: суммы в базовой валюте у перевода нет, курс таблица не выдумывает.
    expect(fromDollars).toEqual(["2026-07-06", "Перевод", "Проведена", "", "Доллары → Основной", "", "", "USD", "10,00", "", "900,00", "RUB", "", "", ""]);
    expect(debt).toEqual(["2026-07-28", "Вернул долг", "Проведена", "4625,00", "Основной", "", "", "RUB", "4625,00", "", "50,00", "USD", "Сергей", "", ""]);
  });

  it("обезвреживает формулу в комментарии, метке и имени контрагента", () => {
    const csv = createOperationsCsv(ledger("=HYPERLINK(\"https://invalid\")", "@cmd", "+7 900 000-00-00"));
    expect(csv).toContain("\"'=HYPERLINK(\"\"https://invalid\"\")\"");
    expect(csv).toContain("'@cmd, Старое");
    expect(csv).toContain("'+7 900 000-00-00");
    const negative = createOperationsCsv(ledger("-5"));
    expect(negative).toContain(",'-5,");
    expect(csv).not.toMatch(/(?:^|,)[=+@]/m);
  });

  it("пишет сумму в валюте без копеек и с тремя знаками по её exponent", () => {
    const state = ledger();
    const yen: BudgetState = {
      ...state,
      accounts: state.accounts.map((item) => (item.id === DOLLARS ? { ...item, currency: "JPY" } : item)),
      debts: [],
      transactions: [{ ...state.transactions[1]!, amountMinor: 450, rate: { baseMinor: 6_000, quoteMinor: 1 }, baseAmountMinor: 2_700_000 } as BudgetState["transactions"][number]],
    };
    const [, row] = table(yen);
    expect(row!.slice(7, 10)).toEqual(["JPY", "450", "60"]);
    const dinar: BudgetState = { ...yen, accounts: yen.accounts.map((item) => (item.id === DOLLARS ? { ...item, currency: "KWD" } : item)), transactions: [{ ...yen.transactions[0]!, amountMinor: 1_250, rate: { baseMinor: 30_000, quoteMinor: 1_000 }, baseAmountMinor: 37_500 } as BudgetState["transactions"][number]] };
    expect(table(dinar)[1]!.slice(7, 10)).toEqual(["KWD", "1,250", "300"]);
  });
});
