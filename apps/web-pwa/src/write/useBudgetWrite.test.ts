import type { BudgetState } from "@family-budget/domain";
import { describe, expect, it, vi } from "vitest";
import { BUDGET_WRITE_CONFLICT_MESSAGE, createAppBudgetSaveCoordinator } from "../app/budget-store";
import { prepareBudgetState } from "../backup";
import { makeG000State } from "../features/operations/test-fixture";
import { createDraftRegistry, createDraftSaving } from "../navigation/draft-guard";
import { BudgetWriteRefusal, WRITE_REFUSAL_TEXT } from "../write-refusal";
import { createBudgetWriter, writeFailureText, type UnseenWriteFailure } from "./useBudgetWrite";

const state = () => prepareBudgetState(makeG000State());

/** Писатель над координатором, который отвечает тем, что ему велели. */
function writer(apply: (change: (current: BudgetState) => BudgetState) => Promise<BudgetState>) {
  let place = "#/new#1";
  const unseen: UnseenWriteFailure[] = [];
  const write = createBudgetWriter({ coordinator: { apply }, place: () => place, onUnseenFailure: (failure) => unseen.push(failure) });
  return { write, unseen, moveTo: (next: string) => { place = next; } };
}

describe("единственный путь записи", () => {
  it("отдаёт правку координатору и возвращает то, что он записал", async () => {
    const saved = state();
    const apply = vi.fn(async () => saved);
    const { write, unseen } = writer(apply);
    const change = (current: BudgetState) => current;
    await expect(write.run(change)).resolves.toBe(saved);
    expect(apply).toHaveBeenCalledWith(change);
    expect(unseen).toEqual([]);
  });

  it("отказ на том же экране возвращается форме и не дублируется оболочкой", async () => {
    const { write, unseen } = writer(async () => { throw new BudgetWriteRefusal("held"); });
    await expect(write.run((current) => current)).rejects.toBeInstanceOf(BudgetWriteRefusal);
    expect(unseen).toEqual([]);
  });

  it("отказ после ухода с экрана говорит оболочка — словами отказа, а форма всё равно его получает", async () => {
    let fail!: (reason: unknown) => void;
    const { write, unseen, moveTo } = writer(() => new Promise<BudgetState>((_resolve, reject) => { fail = reject; }));
    const pending = write.run((current) => current);
    moveTo("#/operations#2");
    fail(new BudgetWriteRefusal("notReady"));
    await expect(pending).rejects.toBeInstanceOf(BudgetWriteRefusal);
    expect(unseen).toEqual([{ message: WRITE_REFUSAL_TEXT.notReady, refusal: true }]);
  });

  it("молчаливая запись не объявляет неудачу даже после ухода", async () => {
    let fail!: (reason: unknown) => void;
    const { write, unseen, moveTo } = writer(() => new Promise<BudgetState>((_resolve, reject) => { fail = reject; }));
    const pending = write.run((current) => current, { silent: true });
    moveTo("#/more#3");
    fail(new BudgetWriteRefusal("pending"));
    await expect(pending).rejects.toBeInstanceOf(BudgetWriteRefusal);
    expect(unseen).toEqual([]);
  });

  it("называет неудачу словами для человека: отказ, конфликт вкладок, всё прочее — общей фразой", () => {
    for (const reason of Object.keys(WRITE_REFUSAL_TEXT) as (keyof typeof WRITE_REFUSAL_TEXT)[]) {
      expect(writeFailureText(new BudgetWriteRefusal(reason))).toBe(WRITE_REFUSAL_TEXT[reason]);
    }
    expect(writeFailureText(new Error(BUDGET_WRITE_CONFLICT_MESSAGE))).toBe(BUDGET_WRITE_CONFLICT_MESSAGE);
    // Текст чужой ошибки на экран не попадает.
    expect(writeFailureText(new Error("IDBDatabase: secret stack"))).toBe("Изменение не сохранилось. Повторите его.");
    expect(writeFailureText("oops")).toBe("Изменение не сохранилось. Повторите его.");
  });

  it("с настоящим координатором: удержание семьи отказывает, бюджет не тронут, черновик держит переход", async () => {
    const current = state();
    const publish = vi.fn();
    const saveIfRevision = vi.fn();
    const coordinator = createAppBudgetSaveCoordinator({
      repository: { loadVersioned: async () => ({ value: current, revision: "r1" }), saveIfRevision },
      getCurrent: () => current,
      getRevision: () => "r1",
      setRevision: () => undefined,
      publish,
      journalWrite: () => async () => { throw new BudgetWriteRefusal("held"); },
    });
    const write = createBudgetWriter({ coordinator, place: () => "#/new#1", onUnseenFailure: () => undefined });
    const registry = createDraftRegistry();
    const saving = createDraftSaving();
    registry.register({ current: { label: "операция", isDirty: () => !saving.saving } });

    const ticket = saving.begin();
    await expect(write.run((budget) => ({ ...budget }))).rejects.toMatchObject({ reason: "held" });
    saving.fail(ticket);

    expect(publish).not.toHaveBeenCalled();
    expect(saveIfRevision).not.toHaveBeenCalled();
    expect(registry.hasUnsavedDrafts("navigation")).toBe(true);
  });
});
