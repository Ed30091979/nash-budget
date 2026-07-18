import { calculateAnnualPlan } from "@family-budget/domain";
import { describe, expect, it } from "vitest";
import {
  archiveFlexibleLine,
  createCommitment,
  createFlexibleLine,
  createSchedule,
  editCommitment,
  editFlexibleLine,
  editSchedule,
  planningError,
  PlanningValidationError,
  reactivateFlexibleLine,
  setCommitmentActive,
  setScheduleActive,
} from "./model";
import { deterministicIds, makeCanonicalPlanningState, makePlanningTestState, TEST_IDS } from "./test-fixture";

describe("planning CRUD", () => {
  it("creates and edits commitments without replacing IDs or changing counts", () => {
    const makeId = deterministicIds();
    const created = createCommitment(makePlanningTestState(), {
      name: "Страхование автомобиля", categoryId: TEST_IDS.categories.transport, accountId: TEST_IDS.account,
      dueDate: "2027-01-15", amount: "72000", reserved: "0", recurrence: "annual",
    }, makeId);
    const id = created.annualCommitments[0]!.id;
    const edited = editCommitment(created, id, {
      name: "Страхование авто", categoryId: TEST_IDS.categories.transport, accountId: TEST_IDS.account,
      dueDate: "2027-02-15", amount: "73000.50", reserved: "1000", recurrence: "annual",
    });
    expect(edited.annualCommitments).toHaveLength(1);
    expect(edited.annualCommitments[0]).toMatchObject({ id, name: "Страхование авто", dueDate: "2027-02-15", amountMinor: 7_300_050, reservedMinor: 100_000 });
    expect(setCommitmentActive(edited, id, false).annualCommitments[0]?.active).toBe(false);
    expect(setCommitmentActive(setCommitmentActive(edited, id, false), id, true).annualCommitments[0]?.id).toBe(id);
  });

  it("creates monthly/selected schedules, normalizes month set and archives instead of deleting", () => {
    const makeId = deterministicIds();
    const created = createSchedule(makePlanningTestState(), {
      name: "Обучение детей", categoryId: TEST_IDS.categories.children, accountId: TEST_IDS.account,
      amount: "25000", dueDay: "31", mode: "selected_months", months: [12, 9, 1, 2, 3, 4, 5, 9],
    }, makeId);
    expect(created.scheduledExpenses[1]).toMatchObject({ dueDay: 31, mode: "selected_months", months: [1, 2, 3, 4, 5, 9, 12] });
    const id = created.scheduledExpenses[1]!.id;
    const edited = editSchedule(created, id, { name: "Секции", categoryId: TEST_IDS.categories.children, accountId: TEST_IDS.account, amount: "6000", dueDay: "12", mode: "monthly", months: [9] });
    expect(edited.scheduledExpenses).toHaveLength(2);
    expect(edited.scheduledExpenses[1]).toMatchObject({ id, mode: "monthly", months: undefined, amountMinor: 600_000 });
    const archived = setScheduleActive(edited, id, false);
    expect(archived.scheduledExpenses).toHaveLength(2);
    expect(archived.scheduledExpenses[1]?.active).toBe(false);
  });

  it("soft-archives a flexible line without changing its identity, count or amount", () => {
    const original = makePlanningTestState();
    const lineId = TEST_IDS.lines[0];
    const edited = editFlexibleLine(original, lineId, { name: "Детские покупки", amount: "12500" });
    expect(edited.budgets[0]?.lines).toHaveLength(3);
    expect(edited.budgets[0]?.lines[0]).toMatchObject({ id: lineId, categoryId: TEST_IDS.categories.children, plannedMinor: 1_250_000 });
    expect(edited.categories.find((item) => item.id === TEST_IDS.categories.children)?.name).toBe("Детские покупки");
    const archived = archiveFlexibleLine(edited, lineId);
    expect(archived.budgets[0]?.lines).toHaveLength(3);
    expect(archived.categories).toHaveLength(4);
    expect(archived.categories.find((item) => item.id === TEST_IDS.categories.children)?.active).toBe(true);
    expect(archived.budgets[0]?.lines.find((item) => item.id === lineId)).toEqual({ ...edited.budgets[0]?.lines.find((item) => item.id === lineId), active: false });
    expect(calculateAnnualPlan(archived, "2026-07", 12).currentMonth.flexiblePlanMinor).toBe(4_300_000);
    const restored = reactivateFlexibleLine(archived, lineId);
    expect(restored.categories).toHaveLength(4);
    expect(restored.budgets[0]?.lines).toHaveLength(3);
    expect(restored.budgets[0]?.lines.find((item) => item.id === lineId)).toMatchObject({ id: lineId, categoryId: TEST_IDS.categories.children, plannedMinor: 1_250_000, active: true });
    expect(calculateAnnualPlan(restored, "2026-07", 12).currentMonth.flexiblePlanMinor).toBe(5_550_000);

    const editedWhileArchived = editFlexibleLine(archived, lineId, { name: "Детские покупки", amount: "13000" });
    expect(editedWhileArchived.budgets[0]?.lines.find((item) => item.id === lineId)).toMatchObject({ id: lineId, plannedMinor: 1_300_000, active: false });
    const restoredAfterExplicitEdit = reactivateFlexibleLine(editedWhileArchived, lineId);
    expect(restoredAfterExplicitEdit.budgets[0]?.lines).toHaveLength(3);
    expect(restoredAfterExplicitEdit.budgets[0]?.lines.find((item) => item.id === lineId)).toMatchObject({ id: lineId, plannedMinor: 1_300_000, active: true });
  });

  it("archives the shared Children flexible line without affecting camp or seasonal schedules", () => {
    const original = makeCanonicalPlanningState();
    const childrenLine = original.budgets[0]!.lines.find((line) => line.categoryId === TEST_IDS.categories.children)!;
    const commitmentsBefore = JSON.stringify(original.annualCommitments);
    const schedulesBefore = JSON.stringify(original.scheduledExpenses);
    const archived = archiveFlexibleLine(original, childrenLine.id);
    const archivedLine = archived.budgets[0]!.lines.find((line) => line.id === childrenLine.id);

    expect(archived.categories.find((item) => item.id === TEST_IDS.categories.children)?.active).toBe(true);
    expect(archivedLine).toEqual({ ...childrenLine, active: false });
    expect(archived.budgets[0]?.lines).toHaveLength(3);
    expect(JSON.stringify(archived.annualCommitments)).toBe(commitmentsBefore);
    expect(JSON.stringify(archived.scheduledExpenses)).toBe(schedulesBefore);
    expect(archived.annualCommitments.find((item) => item.name === "Летний лагерь")).toMatchObject({ active: true, categoryId: TEST_IDS.categories.children, amountMinor: 9_000_000 });
    expect(archived.scheduledExpenses.filter((item) => item.categoryId === TEST_IDS.categories.children)).toEqual([
      expect.objectContaining({ name: "Обучение детей", active: true, amountMinor: 2_500_000 }),
      expect.objectContaining({ name: "Секции", active: true, amountMinor: 600_000 }),
    ]);

    const camp = archived.annualCommitments.find((item) => item.name === "Летний лагерь")!;
    const editedCamp = editCommitment(archived, camp.id, {
      name: "Летний лагерь 2027", categoryId: camp.categoryId, accountId: camp.accountId,
      dueDate: camp.dueDate, amount: "90000", reserved: "15000", recurrence: camp.recurrence,
    });
    expect(editedCamp.annualCommitments).toHaveLength(3);
    expect(editedCamp.annualCommitments.find((item) => item.id === camp.id)?.name).toBe("Летний лагерь 2027");
    const education = archived.scheduledExpenses.find((item) => item.name === "Обучение детей")!;
    const editedEducation = editSchedule(archived, education.id, {
      name: "Обучение детей", categoryId: education.categoryId, accountId: education.accountId,
      amount: "25000", dueDay: "11", mode: "selected_months", months: education.months ?? [],
    });
    expect(editedEducation.scheduledExpenses).toHaveLength(3);
    expect(editedEducation.scheduledExpenses.find((item) => item.id === education.id)?.dueDay).toBe(11);

    const july = calculateAnnualPlan(archived, "2026-07", 24);
    expect(july.currentMonth).toMatchObject({ flexiblePlanMinor: 4_300_000, scheduledExpenseMinor: 5_300_000, annualReserveMinor: 1_980_900 });
    expect(july.months[2]).toMatchObject({ seasonalExpenseMinor: 3_100_000, scheduledExpenseMinor: 8_400_000 });
    expect(july.months.find((month) => month.month === "2027-06")?.annualDueMinor).toBe(9_000_000);

    const restored = reactivateFlexibleLine(archived, childrenLine.id);
    expect(restored.categories.find((item) => item.id === TEST_IDS.categories.children)?.active).toBe(true);
    expect(restored.budgets[0]?.lines.find((line) => line.id === childrenLine.id)).toEqual({ ...childrenLine, active: true });
    expect(calculateAnnualPlan(restored, "2026-07", 24).currentMonth.flexiblePlanMinor).toBe(5_300_000);
  });

  it("restores an archived same-name line instead of duplicating its category or UUID", () => {
    const original = makePlanningTestState();
    const archived = archiveFlexibleLine(original, TEST_IDS.lines[0]);
    let generated = 0;
    const restored = createFlexibleLine(archived, { name: "  Дети  ", amount: "14000" }, () => {
      generated += 1;
      return deterministicIds()();
    });
    expect(generated).toBe(0);
    expect(restored.categories).toHaveLength(4);
    expect(restored.budgets[0]?.lines).toHaveLength(3);
    expect(restored.budgets[0]?.lines.find((line) => line.id === TEST_IDS.lines[0])).toMatchObject({
      id: TEST_IDS.lines[0], categoryId: TEST_IDS.categories.children, plannedMinor: 1_400_000, active: true,
    });
    expect(() => createFlexibleLine(restored, { name: "Дети", amount: "15000" }, deterministicIds())).toThrow(/Активная категория/);
  });

  it("creates a new flexible category with globally unique IDs", () => {
    const created = createFlexibleLine(makePlanningTestState(), { name: "Дом и мелочи", amount: "5000" }, deterministicIds());
    expect(created.categories).toHaveLength(5);
    expect(created.budgets[0]?.lines).toHaveLength(4);
    expect(created.categories.at(-1)).toMatchObject({ name: "Дом и мелочи", active: true, type: "expense" });
    expect(created.budgets[0]?.lines.at(-1)?.categoryId).toBe(created.categories.at(-1)?.id);
  });
});

describe("planning input boundaries", () => {
  it("rejects inactive/spoofed references and UUID collisions", () => {
    const state = makePlanningTestState();
    const dto = { name: "Лагерь", categoryId: TEST_IDS.categories.children, accountId: TEST_IDS.account, dueDate: "2027-06-15", amount: "90000", reserved: "15000", recurrence: "one_time" as const };
    expect(() => createCommitment(state, { ...dto, categoryId: "90000000-0000-4000-8000-000000000999" }, deterministicIds())).toThrow(/активную категорию/);
    expect(() => createCommitment({ ...state, accounts: [{ ...state.accounts[0]!, active: false }] }, dto, deterministicIds())).toThrow(/активный счёт/);
    expect(() => createCommitment(state, dto, () => TEST_IDS.account)).toThrow(/уникальный идентификатор/);
  });

  it("rejects unsafe money, impossible dates, invalid reserved and unsafe labels", () => {
    const base = { name: "Лагерь", categoryId: TEST_IDS.categories.children, accountId: TEST_IDS.account, dueDate: "2027-06-15", amount: "90000", reserved: "15000", recurrence: "one_time" as const };
    expect(() => createCommitment(makePlanningTestState(), { ...base, amount: "90071992547409.92" }, deterministicIds())).toThrow(/сумму/);
    expect(() => createCommitment(makePlanningTestState(), { ...base, dueDate: "2027-02-29" }, deterministicIds())).toThrow(/существующую/);
    expect(() => createCommitment(makePlanningTestState(), { ...base, reserved: "90001" }, deterministicIds())).toThrow(/превышать/);
    expect(() => createCommitment(makePlanningTestState(), { ...base, name: "Camp Лагерь" }, deterministicIds())).toThrow(/алфавитов/);
    expect(() => createCommitment(makePlanningTestState(), { ...base, name: "Лагерь\u202E" }, deterministicIds())).toThrow(/служебные/);
  });

  it("shows only owned validation messages and hides unexpected/domain/repository details", () => {
    expect(planningError(new PlanningValidationError("amount", "Исправьте сумму."))).toEqual({ field: "amount", message: "Исправьте сумму." });
    expect(planningError(Object.assign(new Error("raw domain secret"), { field: "amount" }))).toEqual({ field: "form", message: "Не удалось сохранить изменение." });
    expect(planningError(new Error("IndexedDB internals"))).toEqual({ field: "form", message: "Не удалось сохранить изменение." });
    expect(planningError("unknown")).toEqual({ field: "form", message: "Не удалось сохранить изменение." });
  });
});
