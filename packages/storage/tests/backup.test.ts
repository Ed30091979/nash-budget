import { describe, expect, it, vi } from "vitest";
import { parseBackup, serializeBackup } from "../src";

describe("резервная копия", () => {
  it("сохраняет и восстанавливает payload", () => {
    vi.setSystemTime(new Date("2026-07-17T12:00:00Z"));
    const payload = { name: "Моя семья", amountMinor: 12345 };
    expect(parseBackup<typeof payload>(serializeBackup(payload))).toEqual(payload);
    vi.useRealTimers();
  });

  it("отклоняет посторонний JSON", () => {
    expect(() => parseBackup('{"hello":"world"}')).toThrow(/не поддерживаемая/i);
  });
});
