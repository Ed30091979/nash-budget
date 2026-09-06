import "fake-indexeddb/auto";
import { describe, expect, it } from "vitest";
import { createImportMemory } from "./memory";

function entry(key: string, categoryName: string | null, updatedAt: string) {
  return { key, categoryName, type: "expense" as const, updatedAt };
}

describe("память назначений", () => {
  it("помнит назначение между сессиями и стирается по просьбе", async () => {
    const databaseName = `import-memory-${crypto.randomUUID()}`;
    const memory = createImportMemory({ databaseName });
    await memory.remember([entry("ооо ромашка", "Дом и хозяйство", "2026-08-01T00:00:00.000Z")]);
    // Новый экземпляр — та же база: память живёт в IndexedDB, а не в переменной.
    const reopened = createImportMemory({ databaseName });
    expect(await reopened.load()).toEqual([entry("ооо ромашка", "Дом и хозяйство", "2026-08-01T00:00:00.000Z")]);
    await reopened.remember([entry("ооо ромашка", "Подарки и праздники", "2026-09-01T00:00:00.000Z")]);
    expect(await memory.load()).toEqual([entry("ооо ромашка", "Подарки и праздники", "2026-09-01T00:00:00.000Z")]);
    await memory.clear();
    expect(await reopened.load()).toEqual([]);
  });

  it("забывает самых давних продавцов сверх ёмкости и не хранит мусор", async () => {
    const databaseName = `import-memory-${crypto.randomUUID()}`;
    const memory = createImportMemory({ databaseName, capacity: 2 });
    await memory.remember([
      entry("а", "Продукты", "2026-01-01T00:00:00.000Z"),
      entry("б", "Продукты", "2026-02-01T00:00:00.000Z"),
      entry("в", null, "2026-03-01T00:00:00.000Z"),
      { key: "", categoryName: "Продукты", type: "expense", updatedAt: "2026-04-01T00:00:00.000Z" },
    ]);
    expect((await memory.load()).map((item) => item.key).sort()).toEqual(["б", "в"]);
  });
});
