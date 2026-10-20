import { readFileSync } from "node:fs";
import { materializeRecurring, type BudgetState } from "@family-budget/domain";

/**
 * Канонический G-003 для e2e «Отчётов» (план волны 2, §4 «2d»): август 2026 в рублях и долларах, с
 * возвратом, долгами, переводом, метками и правилом «Доставка воды», чьи вхождения уже записаны
 * (`materializeRecurring` по `materializeThrough` фикстуры) — ровно то состояние, по которому
 * посчитаны ожидаемые числа контракта. В приложение он приходит тем же путём, что у семьи, —
 * резервной копией (`restoreBudget` в `budgets.ts`).
 *
 * Фикстура читается из `contracts/fixtures/g-003.json` — той же, что отдаёт
 * `@family-budget/test-fixtures` (у G-003 его `toDomainBudgetState` — копия `state`). Сам пакет в
 * прогоне Playwright не грузится: он импортирует JSON без атрибута `type: "json"`, а Node этого не
 * принимает (так же устроен `canonical-budget.ts` для G-002).
 *
 * Числа проверки — из `expected` фикстуры, а не выписаны здесь руками: C1 и C2 — факт категорий
 * плана, T1–T3 — метки. Имена — из её состояния.
 */
interface LedgerFixtureFile {
  readonly fixtureId: string;
  readonly materializeThrough: string;
  readonly state: BudgetState;
  readonly expected: {
    readonly budget: {
      readonly expensesMinor: number;
      readonly incomeMinor: number;
      readonly categories: readonly { readonly categoryId: string; readonly actualMinor: number }[];
    };
    readonly tags: readonly { readonly tagId: string; readonly actualMinor: number; readonly incomeMinor: number }[];
  };
}

const fixture = JSON.parse(readFileSync(new URL("../../../contracts/fixtures/g-003.json", import.meta.url), "utf8")) as LedgerFixtureFile;
if (fixture.fixtureId !== "G-003") throw new Error("The canonical ledger of the reports E2E must be G-003.");

export const G003_LEDGER: BudgetState = materializeRecurring(structuredClone(fixture.state), fixture.materializeThrough).state;

/** Месяц G-003 — август 2026, первый день: опора «Отчётов» за этот месяц. */
export const G003_MONTH_FROM = fixture.state.budgets[0]!.startDate;

const categoryName = (id: string) => fixture.state.categories.find((category) => category.id === id)!.name;
const tagOf = (id: string) => (fixture.state.tags ?? []).find((tag) => tag.id === id)!;

/** C1 «Продукты», C2 «Путешествия»: факт месяца за вычетом возвратов. */
export const G003_CATEGORIES = fixture.expected.budget.categories.map((row) => ({ name: categoryName(row.categoryId), actualMinor: row.actualMinor }));
/** T1 «Отпуск», T2 «Дом», T3 «Старое» (в архиве, только доход). */
export const G003_TAGS = fixture.expected.tags.map((row) => ({
  name: tagOf(row.tagId).name,
  archived: tagOf(row.tagId).active === false,
  actualMinor: row.actualMinor,
  incomeMinor: row.incomeMinor,
}));
export const G003_EXPENSES_MINOR = fixture.expected.budget.expensesMinor;
export const G003_INCOME_MINOR = fixture.expected.budget.incomeMinor;
