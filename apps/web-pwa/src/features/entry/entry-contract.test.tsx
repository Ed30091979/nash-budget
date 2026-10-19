/// <reference types="node" />
import { readFileSync } from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";
import {
  calculateAnnualPlan,
  makeSeedBudget,
  SEED_IDS,
  type BudgetState,
} from "@family-budget/domain";
import { describe, expect, it, vi } from "vitest";
import { createEntryController, entryErrorText } from "../../app/entry-controller";
import { createEntryDraftStore } from "../../app/entry-draft-store";
import { routeKey, type Route } from "../../navigation/routes";
import type { BudgetWriter } from "../../write/useBudgetWrite";
import { createOperationsSubmissionGate } from "../operations/form-state";
import { archiveCategory } from "../operations/model";
import { OverviewScreen } from "../overview/OverviewScreen";
import { periodClock } from "../../reach";
import { EntrySheet, RefusedEntrySheet, type EntrySheetProps } from "./EntrySheet";
import { blankEntryDraft, draftFromTransaction, newEntryDraft, refundDraftFor, type EntryDraft } from "./entry-model";
import { pickOptions } from "./TargetPicker";

/**
 * Договор листа ввода — то, что держал прежний экран «Записать» (`OperationsScreen`, удалён в 2b), в
 * его новом доме: лист поверх экрана, плитки «Обзора» и хранилище черновика вне листа.
 */

const TODAY = "2026-07-13";
const MAIN = SEED_IDS.accounts.main;
const FOOD = SEED_IDS.categories.food;

const read = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");
const plain = (markup: string) => markup.replace(/<[^>]+>/gu, " ").replace(/[\u00a0\u202f]/gu, " ").replace(/\s+/gu, " ").trim();

function sheet(budget: BudgetState, draft: EntryDraft, overrides: Partial<EntrySheetProps> = {}): string {
  return renderToStaticMarkup(
    <EntrySheet
      budget={budget}
      draft={draft}
      today={TODAY}
      balances={{}}
      modeSwitch={false}
      failure={null}
      writeRefusal={null}
      editing={null}
      onChange={vi.fn()}
      onRefund={vi.fn()}
      onClose={vi.fn()}
      onSubmit={vi.fn(() => null)}
      onDelete={vi.fn(async () => null)}
      onSaveRate={vi.fn(async () => null)}
      onCategoryChange={vi.fn(async () => undefined)}
      isDirty={() => false}
      onDiscard={vi.fn()}
      fallbackFocus={vi.fn()}
      {...overrides}
    />,
  );
}

function overview(budget: BudgetState): string {
  const plan = calculateAnnualPlan(budget, "2026-07", 24);
  return renderToStaticMarkup(
    <OverviewScreen
      budget={budget}
      today={TODAY}
      month="2026-07"
      onMonth={vi.fn()}
      clock={periodClock({ startDate: "2026-07-01", endDate: "2026-07-31" }, [], TODAY)}
      flexiblePlanMinor={plan.currentMonth.flexiblePlanMinor}
      familyNews={[]}
      monthToOpen={null}
      openingMonth={false}
      onOpenMonth={vi.fn()}
      onOpenSheet={vi.fn()}
      onAddCategory={vi.fn()}
      onPlan={vi.fn()}
      onReports={vi.fn()}
      onEdit={vi.fn()}
    />,
  );
}

const food = (amount = "1250"): EntryDraft => ({ ...newEntryDraft(makeSeedBudget(), { kind: "expense", accountId: MAIN, categoryId: FOOD }, TODAY), amount });

describe("лист ввода: одно дело и все виды", () => {
  // Ревью 2b, LOW-8: прежнее имя обещало «каждый вид достижим», а взнос в цель по плану — 2e; здесь
  // проверено ровно то, что сказано в имени. Отказ правке долга — в «лист ввода: разметка» (entry-ui).
  it("расход, доход и перевод выбираются с «+», возврат — из правки расхода, правку взноса в цель лист отвергает словами (взносы — подволна 2e)", () => {
    const budget = makeSeedBudget();
    const plus = sheet(budget, blankEntryDraft(budget, "expense", TODAY), { modeSwitch: true });
    const modes = [...plus.matchAll(/<button class="chip" type="button" aria-pressed="(?:true|false)"><span class="chip-face">([^<]+)<\/span><\/button>/gu)].map((match) => match[1]);
    expect(modes.slice(0, 3)).toEqual(["Расход", "Доход", "Перевод"]);
    const expense = budget.transactions.find((item) => item.kind === "expense")!;
    const opening = draftFromTransaction(budget, expense);
    if (opening.kind !== "draft") throw new Error("expense must open as a draft");
    expect(plain(sheet(budget, opening.draft, { editing: expense }))).toContain("Оформить возврат");
    if (expense.kind !== "expense") throw new Error("expense expected");
    expect(plain(sheet(budget, refundDraftFor(expense, budget, TODAY)))).toContain("Возврат");
    const goal = { id: "8d100000-0000-4000-8000-0000000000a7", kind: "goal_contribution" as const, status: "posted" as const, occurredOn: TODAY, amountMinor: 100, fromAccountId: MAIN, toAccountId: SEED_IDS.accounts.savings, goalId: "8d100000-0000-4000-8000-0000000000a8" };
    const refused = draftFromTransaction(budget, goal);
    expect(refused).toMatchObject({ kind: "refused", message: "Взнос в цель этот лист пока не изменяет." });
  });

  it("лист отвечает на «можем ли мы себе это позволить» и только на него: ни истории, ни итогов в нём", () => {
    const text = plain(sheet(makeSeedBudget(), food()));
    expect(text).not.toContain("Итоги и остатки");
    expect(text).not.toContain("Вся история");
    expect(text).not.toContain("Капитал");
    const markup = sheet(makeSeedBudget(), food());
    expect(markup).not.toContain("transaction-list");
    expect(markup).not.toContain("operation-history-search");
    // Записывает не касание плитки, а кнопка, которая называет действие и сумму словами.
    expect(markup).toMatch(/<button class="primary-button wide entry-submit" type="submit"[^>]*>Записать 1[\u00a0 ]250[\u00a0 ]₽<\/button>/u);
    expect(markup).not.toContain("dangerouslySetInnerHTML");
  });

  it("с «+» вид выбирают только из тех, что лист записывает, даже когда в бюджете есть долги", () => {
    const seed = makeSeedBudget();
    const debtId = "8f100000-0000-4000-8000-0000000000d1";
    const debt = { id: "8d100000-0000-4000-8000-000000000007", kind: "debt_out" as const, status: "posted" as const, occurredOn: "2026-07-09", amountMinor: 500_000, accountId: MAIN, debtId };
    const state: BudgetState = {
      ...seed,
      debts: [{ id: debtId, counterparty: "Петя", direction: "owed_to_me", currency: "RUB", openingMinor: 0, active: true }],
      transactions: [...seed.transactions, debt],
    };
    const html = sheet(state, blankEntryDraft(state, "expense", TODAY), { modeSwitch: true });
    const group = html.slice(html.indexOf('aria-label="Вид операции"'), html.indexOf("</div>", html.indexOf('aria-label="Вид операции"')));
    expect([...group.matchAll(/<span class="chip-face">([^<]+)<\/span>/gu)].map((match) => match[1])).toEqual(["Расход", "Доход", "Перевод"]);
    // Операцию по долгу лист не правит: отказ словами и только «Удалить».
    const refused = draftFromTransaction(state, debt);
    if (refused.kind !== "refused") throw new Error("debt must be refused");
    const markup = renderToStaticMarkup(<RefusedEntrySheet budget={state} transaction={debt} message={refused.message} onClose={vi.fn()} onDelete={vi.fn(async () => null)} fallbackFocus={vi.fn()} />);
    expect(plain(markup)).toContain("Операцию по долгу этот лист пока не изменяет.");
    expect(markup).not.toContain('id="entry-amount"');
  });
});

describe("лист ввода: «останется» — до записи", () => {
  it("строка под суммой считает от разобранного выражения, а при правке молчит: сумма уже в остатках", () => {
    const budget = makeSeedBudget();
    const before = plain(sheet(budget, food("")));
    const after = plain(sheet(budget, food("1200+50")));
    expect(before).toMatch(/В категории «Продукты» (?:останется|будет перелимит)/u);
    expect(after).toMatch(/В категории «Продукты» (?:останется|будет перелимит)/u);
    expect(after).not.toBe(before);
    expect(read("./entry-model.ts")).toContain("if (draft.editId !== null) return null;");
    const expense = budget.transactions.find((item) => item.kind === "expense")!;
    const opening = draftFromTransaction(budget, expense);
    if (opening.kind !== "draft") throw new Error("expense must open as a draft");
    expect(plain(sheet(budget, opening.draft, { editing: expense }))).not.toMatch(/останется|будет перелимит/u);
  });
});

describe("архивное и выключенное — не для новой покупки", () => {
  it("выключенная строка плана — плитка без лимита; архивная категория — ни плитки, ни выбора", () => {
    const source = makeSeedBudget();
    const withoutActiveLine: BudgetState = {
      ...source,
      budgets: source.budgets.map((budget) => ({
        ...budget,
        lines: budget.lines.map((line) => line.categoryId === FOOD ? { ...line, active: false } : line),
      })),
    };
    const inactive = overview(withoutActiveLine);
    expect(inactive).toMatch(/aria-label="Продукты: потрачено [^"]*\. Записать расход"/u);
    expect(inactive).not.toMatch(/aria-label="Продукты: потрачено [^"]* из /u);
    const archived = archiveCategory(withoutActiveLine, FOOD);
    expect(overview(archived)).not.toMatch(/aria-label="Продукты:/u);
    const options = pickOptions(archived, blankEntryDraft(archived, "expense", TODAY), "to", {});
    expect(options.map((option) => option.name)).not.toContain("Продукты");
    // Правка старой покупки в архивной категории называет её и подписывает.
    const expense = archived.transactions.find((item) => item.kind === "expense" && item.categoryId === FOOD)!;
    const opening = draftFromTransaction(archived, expense);
    if (opening.kind !== "draft") throw new Error("expense must open as a draft");
    expect(plain(sheet(archived, opening.draft, { editing: expense }))).toContain("Продукты (в архиве)");
  });
});

describe("запись и её неудача", () => {
  it("одно касание — одна запись: шлюз запирается до первого ожидания", async () => {
    let release!: () => void;
    const pending = new Promise<void>((resolve) => { release = resolve; });
    const onChange = vi.fn(async () => pending);
    const gate = createOperationsSubmissionGate();

    const first = gate.run(onChange);
    const second = await gate.run(onChange);
    expect(gate.locked).toBe(true);
    expect(second).toEqual({ status: "ignored" });
    expect(onChange).toHaveBeenCalledTimes(1);
    release();
    await expect(first).resolves.toMatchObject({ status: "completed" });
    expect(gate.locked).toBe(false);
  });

  it("черновик, ушедший в запись, перестаёт быть несохранённым до первого ожидания, а неудача возвращает его", async () => {
    // Третье ревью (e2e b1): после «Записать» касание вкладки спрашивало «Несохранённый черновик
    // будет удалён». Ревью 2b: прежде здесь сверялся только исходник; теперь — поведение настоящих
    // контроллера и хранилища, с записью, которая отвечает, когда ей велят.
    const budget = makeSeedBudget();
    let fail: (error: unknown) => void = () => undefined;
    const write: BudgetWriter = { run: () => new Promise((_resolve, reject) => { fail = reject; }) };
    const sheet: Route = { name: "overview", sheet: "entry", op: "expense", dst: FOOD };
    let route: Route = sheet;
    const store = createEntryDraftStore();
    const controller = createEntryController({
      store, write, current: () => budget, route: () => route, today: () => TODAY,
      redirect: (next) => { route = next; }, navigate: (next) => { route = next; }, showToast: () => undefined,
    });
    store.openEntry(routeKey(sheet), () => food(""));
    store.update((draft) => ({ ...draft, amount: "1250" }));
    expect(store.isDirty()).toBe(true);
    // Синхронно с касанием: лист ушёл с адреса, черновик «записывается» и вопроса не вызовет.
    expect(controller.submit(store.current()!.draft)).toBeNull();
    expect(route).toEqual({ name: "overview" });
    expect(store.current()?.status).toBe("saving");
    expect(store.isDirty()).toBe(false);
    // Запись не прошла — черновик снова несохранённый, с тем же содержимым.
    fail(new Error("disk full"));
    await new Promise<void>((resolve) => { setTimeout(resolve, 0); });
    expect(store.failed()).toMatchObject({ key: routeKey(sheet), status: "failed", draft: { amount: "1250" } });
    expect(store.openEntry(routeKey(sheet), () => food("")).draft.amount).toBe("1250");
    expect(store.isDirty()).toBe(true);
  });

  it("сверка исходника: реестр читает `isDirty` хранилища в момент нажатия, пассивного флага у листа нет", () => {
    expect(read("./EntrySheetHost.tsx")).toContain("isDirty={store.isDirty}");
    expect(read("./EntrySheet.tsx")).not.toContain("onDirtyChange");
  });

  it("неудача говорит только публичными словами, а черновик остаётся", () => {
    expect(entryErrorText(new Error("IDBDatabase: secret stack"))).toBe("Изменение не сохранилось. Повторите его.");
    expect(entryErrorText("oops")).toBe("Изменение не сохранилось. Повторите его.");
    const sheetSource = read("./EntrySheet.tsx");
    expect(sheetSource).toContain("maxLength={24}");
    expect(sheetSource).toContain("aria-busy={busy}");
    expect(sheetSource).toContain('title="Удалить операцию?"');
    for (const file of ["./EntrySheet.tsx", "./EntrySheetHost.tsx", "../../app/entry-controller.tsx", "../../app/entry-draft-store.ts"]) {
      expect(read(file), file).not.toMatch(/console\.|localStorage|sessionStorage|dangerouslySetInnerHTML|innerHTML/u);
    }
  });
});
