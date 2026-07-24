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
    expect(rows[0]).toBe("Дата,Тип,Статус,\"Сумма, ₽\",Счёт,Категория или цель,Связь с исходной операцией");
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
