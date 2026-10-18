/**
 * Отказ записи, пока документ семьи задержан или не пришёл, доходит до формы своими словами —
 * второе ревью: «every local write refused with an explicit, UI-visible error».
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { toOperationsErrorView } from "./features/operations/model";
import { planningError } from "./features/planning/model";
import { BudgetWriteRefusal, WRITE_REFUSAL_TEXT } from "./write-refusal";

describe("отказ записи бюджета", () => {
  it("каждая причина говорит человеку, что случилось и когда записи откроются", () => {
    expect(WRITE_REFUSAL_TEXT.held).toBe(
      "Записи временно недоступны: данные семьи не открываются этой версией приложения. Обновите приложение — записи откроются сами.",
    );
    expect(WRITE_REFUSAL_TEXT.pending).toContain("бюджет семьи ещё не пришёл");
    expect(WRITE_REFUSAL_TEXT.refused).toContain("Ничего не отправлено семье");
  });

  it("формы записи, плана, выписки и восстановления показывают эти слова, а не «не удалось»", () => {
    for (const reason of ["held", "pending", "refused"] as const) {
      const refusal = new BudgetWriteRefusal(reason);
      expect(refusal.userMessage).toBe(WRITE_REFUSAL_TEXT[reason]);
      expect(refusal.message).toBe(WRITE_REFUSAL_TEXT[reason]);
      expect(toOperationsErrorView(refusal)).toEqual({ field: "form", message: WRITE_REFUSAL_TEXT[reason] });
      expect(planningError(refusal)).toEqual({ field: "form", message: WRITE_REFUSAL_TEXT[reason] });
    }
    // Восстановление копии — тоже запись бюджета; экран «Данные» не прячет причину за общей фразой.
    const screen = readFileSync(new URL("./features/data-management/DataManagementScreen.tsx", import.meta.url), "utf8");
    expect(screen).toContain('message: error instanceof BudgetWriteRefusal ? error.userMessage : SAFE_ERRORS.restore');
    // Выписка пишет через ту же функцию, что и «Записать».
    const importScreen = readFileSync(new URL("./features/import/ImportScreen.tsx", import.meta.url), "utf8");
    expect(importScreen).toContain("setError(toOperationsErrorView(cause).message);");
  });
});
