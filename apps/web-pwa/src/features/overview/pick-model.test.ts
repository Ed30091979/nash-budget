import { describe, expect, it } from "vitest";
import { isDragSource, isPicked, pick, pickHint, PICK_IDLE, type PickEvent, type PickState, type PickTile } from "./pick-model";

const CARD = "a0000000-0000-4000-8000-000000000001";
const CASH = "a0000000-0000-4000-8000-000000000002";
const FOOD = "b0000000-0000-4000-8000-000000000001";
const SALARY = "c0000000-0000-4000-8000-000000000001";
const context = { defaultAccountId: CARD };

const account = (id: string): PickTile => ({ kind: "account", id });
const category = (id: string): PickTile => ({ kind: "category", id });
const income = (id: string | null): PickTile => ({ kind: "income", id });
const tap = (tile: PickTile): PickEvent => ({ type: "tap", tile });

/** Последовательность событий с чистого листа: итоговое состояние и всё, что просили открыть. */
function run(...events: PickEvent[]) {
  let state: PickState = PICK_IDLE;
  const opened = [];
  for (const event of events) {
    const result = pick(state, event, context);
    state = result.state;
    if (result.open !== null) opened.push(result.open);
  }
  return { state, opened };
}

describe("автомат касаний «Обзора»", () => {
  it("категория — лист расхода с основного счёта, выбор не остаётся", () => {
    expect(run(tap(category(FOOD)))).toEqual({ state: PICK_IDLE, opened: [{ kind: "expense", accountId: CARD, categoryId: FOOD }] });
    // Основного счёта нет — лист всё равно открывается и попросит выбрать счёт.
    expect(pick(PICK_IDLE, tap(category(FOOD)), { defaultAccountId: null }).open).toEqual({ kind: "expense", accountId: null, categoryId: FOOD });
  });

  it("счёт, затем категория — расход с этого счёта", () => {
    const first = run(tap(account(CASH)));
    expect(first).toEqual({ state: { selected: { kind: "account", id: CASH } }, opened: [] });
    expect(run(tap(account(CASH)), tap(category(FOOD)))).toEqual({ state: PICK_IDLE, opened: [{ kind: "expense", accountId: CASH, categoryId: FOOD }] });
  });

  it("доход, затем счёт — лист дохода; доход без категории — тоже", () => {
    expect(run(tap(income(SALARY)), tap(account(CASH)))).toEqual({ state: PICK_IDLE, opened: [{ kind: "income", categoryId: SALARY, accountId: CASH }] });
    expect(run(tap(income(null)), tap(account(CARD))).opened).toEqual([{ kind: "income", categoryId: null, accountId: CARD }]);
  });

  it("счёт, затем другой счёт — перевод; тот же счёт — снять выбор", () => {
    expect(run(tap(account(CARD)), tap(account(CASH)))).toEqual({ state: PICK_IDLE, opened: [{ kind: "transfer", fromAccountId: CARD, toAccountId: CASH }] });
    expect(run(tap(account(CARD)), tap(account(CARD)))).toEqual({ state: PICK_IDLE, opened: [] });
  });

  it("второй выбор заменяет первый, тот же доход ещё раз — снимает его, а Esc сбрасывает всё", () => {
    expect(run(tap(account(CARD)), tap(income(SALARY))).state).toEqual({ selected: { kind: "income", id: SALARY } });
    expect(run(tap(income(SALARY)), tap(income(null))).state).toEqual({ selected: { kind: "income", id: null } });
    expect(run(tap(income(SALARY)), tap(income(SALARY))).state).toEqual(PICK_IDLE);
    expect(run(tap(account(CARD)), { type: "escape" })).toEqual({ state: PICK_IDLE, opened: [] });
    expect(run(tap(income(SALARY)), { type: "escape" }, tap(account(CASH)))).toEqual({ state: { selected: { kind: "account", id: CASH } }, opened: [] });
    // Доход, затем категория — это расход: категория всегда записывает расход, выбор дохода уходит.
    expect(run(tap(income(SALARY)), tap(category(FOOD)))).toEqual({ state: PICK_IDLE, opened: [{ kind: "expense", accountId: CARD, categoryId: FOOD }] });
  });

  it("перетаскивание — те же два касания с чистого листа, что бы ни было выбрано", () => {
    const drop = (source: PickTile, target: PickTile): PickEvent => ({ type: "drop", source, target });
    expect(run(drop(account(CASH), category(FOOD))).opened).toEqual([{ kind: "expense", accountId: CASH, categoryId: FOOD }]);
    expect(run(drop(income(SALARY), account(CARD))).opened).toEqual([{ kind: "income", categoryId: SALARY, accountId: CARD }]);
    expect(run(drop(account(CARD), account(CASH))).opened).toEqual([{ kind: "transfer", fromAccountId: CARD, toAccountId: CASH }]);
    // На саму себя — ничего не записывает и выбора не оставляет.
    expect(run(drop(account(CARD), account(CARD)))).toEqual({ state: PICK_IDLE, opened: [] });
    // Выбор, бывший до перетаскивания, ему не мешает.
    expect(run(tap(income(SALARY)), drop(account(CARD), category(FOOD))).opened).toEqual([{ kind: "expense", accountId: CARD, categoryId: FOOD }]);
    // Категорию не перетаскивают: она — «куда», а не «откуда».
    expect(isDragSource(category(FOOD))).toBe(false);
    expect(isDragSource(account(CARD))).toBe(true);
    expect(isDragSource(income(null))).toBe(true);
    expect(run(tap(account(CARD)), drop(category(FOOD), account(CASH))).state).toEqual({ selected: { kind: "account", id: CARD } });
  });

  it("подсказка называет выбранное и следующий шаг, а выбор виден на своей плитке", () => {
    const names = { account: (id: string) => (id === CARD ? "Карта" : "Наличные"), income: (id: string | null) => (id === null ? "Без категории" : "Зарплата") };
    expect(pickHint(PICK_IDLE, names)).toMatch(/^Коснитесь категории/u);
    const selected = run(tap(account(CARD))).state;
    expect(pickHint(selected, names)).toBe("Выбран счёт «Карта». Теперь категория — расход с него, другой счёт — перевод, этот же счёт — снять выбор.");
    expect(pickHint(run(tap(income(null))).state, names)).toBe("Выбран доход «Без категории». Теперь счёт, на который он пришёл.");
    expect(isPicked(selected, account(CARD))).toBe(true);
    expect(isPicked(selected, account(CASH))).toBe(false);
    expect(isPicked(selected, category(FOOD))).toBe(false);
    expect(isPicked(run(tap(income(null))).state, income(null))).toBe(true);
  });
});
