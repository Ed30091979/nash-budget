import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import { describe, expect, it, vi } from "vitest";
import backupSchema from "../../../contracts/schemas/storage-backup.schema.json";
import {
  MAX_BACKUP_BYTES,
  ValidatedBackupCodec,
  parseBackup,
  serializeBackup,
} from "../src";

interface LinkedPayload {
  readonly id: string;
  readonly amountMinor: number;
  readonly accountId: string;
  readonly accounts: readonly { readonly id: string }[];
}

const UUID = "018f4b42-7c2e-7b85-a471-7d8c87b3e5c1";

function validateLinkedPayload(value: unknown): LinkedPayload {
  if (typeof value !== "object" || value === null) throw new Error("Некорректные данные бюджета.");
  const payload = value as Partial<LinkedPayload>;
  if (typeof payload.id !== "string" || !/^[0-9a-f]{8}-[0-9a-f-]{27}$/i.test(payload.id)) {
    throw new Error("Некорректный идентификатор бюджета.");
  }
  if (!Number.isSafeInteger(payload.amountMinor) || payload.amountMinor! < 0) {
    throw new Error("Некорректная сумма бюджета.");
  }
  if (!Array.isArray(payload.accounts) || !payload.accounts.some((account) => account.id === payload.accountId)) {
    throw new Error("Некорректная связь счёта.");
  }
  return payload as LinkedPayload;
}

describe("резервная копия v2", () => {
  it("сохраняет точное время, SHA-256 checksum и восстанавливает payload", () => {
    const payload = { name: "Моя семья", amountMinor: 12345 };
    const text = serializeBackup(payload, { createdAt: "2026-07-17T12:00:00.000Z" });
    const envelope = JSON.parse(text) as {
      createdAt: string;
      formatVersion: number;
      integrity: { algorithm: string; checksum: string };
    };

    expect(envelope.createdAt).toBe("2026-07-17T12:00:00.000Z");
    expect(envelope.formatVersion).toBe(2);
    expect(envelope.integrity).toEqual({
      algorithm: "sha256",
      checksum: "e5f7dc62c59db380c10aed1f744e9b089f666ffee65415ebaeb4b84292aa84b7",
    });
    expect(parseBackup<typeof payload>(text)).toEqual(payload);

    const ajv = new Ajv2020({ strict: true });
    addFormats(ajv);
    expect(ajv.validate(backupSchema, envelope), JSON.stringify(ajv.errors)).toBe(true);
  });

  it("мигрирует точный Phase0 legacy envelope только в памяти и применяет explicit validator", () => {
    const payload: LinkedPayload = {
      id: UUID,
      amountMinor: 12345,
      accountId: "account-1",
      accounts: [{ id: "account-1" }],
    };
    const legacy = JSON.stringify({
      backupVersion: 1,
      createdAt: "2026-07-17T12:00:00.000Z",
      app: "family-budget",
      payload,
    });
    const codec = new ValidatedBackupCodec(validateLinkedPayload);
    expect(codec.parse(legacy)).toEqual(payload);
    expect(JSON.parse(legacy)).not.toHaveProperty("integrity");
  });

  it.each([
    ["повреждённый JSON", "{"],
    ["чужое приложение", JSON.stringify({ app: "other" })],
    ["legacy без createdAt", JSON.stringify({ backupVersion: 1, app: "family-budget", payload: {} })],
    ["legacy с новой версией", JSON.stringify({ backupVersion: 99, createdAt: "2026-07-17T12:00:00.000Z", app: "family-budget", payload: {} })],
    ["legacy другого app", JSON.stringify({ backupVersion: 1, createdAt: "2026-07-17T12:00:00.000Z", app: "other", payload: {} })],
  ])("отклоняет %s без раскрытия payload в ошибке", (_name, text) => {
    expect(() => parseBackup(text)).toThrow();
    try {
      parseBackup(`${text}SUPER_SECRET_FINANCE_VALUE`);
    } catch (error) {
      expect(String(error)).not.toContain("SUPER_SECRET_FINANCE_VALUE");
    }
  });

  it("отклоняет новую версию и повреждение checksum", () => {
    const source = JSON.parse(serializeBackup({ amountMinor: 12345 })) as Record<string, unknown>;
    expect(() => parseBackup(JSON.stringify({ ...source, formatVersion: 99 }))).toThrow(/новее/);

    const payload = source.payload as Record<string, unknown>;
    payload.amountMinor = 12346;
    expect(() => parseBackup(JSON.stringify(source))).toThrow(/целостности/);
  });

  it("ограничивает импорт 5 MiB до JSON.parse", () => {
    const parse = vi.spyOn(JSON, "parse");
    expect(() => parseBackup(`{"x":"${"a".repeat(MAX_BACKUP_BYTES)}"}`)).toThrow(/5 МБ/);
    expect(parse).not.toHaveBeenCalled();
    parse.mockRestore();
  });

  it.each([
    ["unsafe number", { amountMinor: Number.MAX_SAFE_INTEGER + 1 }],
    ["dangerous key", JSON.parse('{"__proto__":{"polluted":true}}')],
  ])("отклоняет generic payload при serialize: %s", (_name, payload) => {
    expect(() => serializeBackup(payload)).toThrow();
    expect(({} as { polluted?: boolean }).polluted).toBeUndefined();
  });

  it("отклоняет duplicate id при import", () => {
    const text = serializeBackup({ left: { id: UUID }, right: { id: UUID } });
    const codec = new ValidatedBackupCodec((value) => value);
    expect(() => codec.parse(text)).toThrow(/повторяющийся идентификатор/);
    expect(() => codec.serialize({ left: { id: UUID }, right: { id: UUID } })).toThrow(/повторяющийся идентификатор/);
  });

  it("вызывает explicit validator для UUID и связей", () => {
    const codec = new ValidatedBackupCodec(validateLinkedPayload);
    const valid: LinkedPayload = {
      id: UUID,
      amountMinor: 12345,
      accountId: "account-1",
      accounts: [{ id: "account-1" }],
    };
    expect(codec.parse(codec.serialize(valid))).toEqual(valid);

    expect(() => codec.parse(serializeBackup({ ...valid, id: "broken-uuid" }))).toThrow(/идентификатор/);
    expect(() => codec.parse(serializeBackup({ ...valid, accountId: "missing" }))).toThrow(/связь/);
  });
});
