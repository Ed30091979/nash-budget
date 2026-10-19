/// <reference types="node" />
import { readFileSync } from "node:fs";
import type { BudgetState, Transaction } from "@family-budget/domain";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { buildDemoBudgetState } from "../../onboarding/demo";
import { buildOnboardingBudgetState } from "../../onboarding/model";
import { COACH_TEXT, CoachMark } from "./CoachMark";
import { HintCards, HINT_WORDS } from "./HintCards";
import {
  BACKUP_AFTER_DAYS,
  BACKUP_AFTER_RECORDS,
  closeHint,
  coachCategoryId,
  coachDone,
  coachVisible,
  finishCoach,
  MAX_HINTS,
  visibleHints,
  type HintInput,
} from "./hints-model";
import { createFirstRunStore, EMPTY_FIRST_RUN, type FirstRunMemory, type FirstRunState } from "./memory";
import { beginFirstRun } from "./questions-model";

const TODAY = "2026-10-19";

function preset(): BudgetState {
  let next = 0;
  return buildOnboardingBudgetState({ today: TODAY, makeId: () => `00000000-0000-4000-8000-${String(++next).padStart(12, "0")}` });
}

/** `count` расходов в «Продуктах» с карты набора. */
function withRecords(state: BudgetState, count: number, on = TODAY): BudgetState {
  const food = state.categories.find((item) => item.name === "Продукты")!.id;
  const transactions: Transaction[] = Array.from({ length: count }, (_unused, index) => ({
    id: `00000000-0000-4000-8000-1${String(index).padStart(11, "0")}`,
    kind: "expense", status: "posted", occurredOn: on, amountMinor: 10_000, accountId: state.accounts[0]!.id, categoryId: food,
  }));
  return { ...state, transactions };
}

function input(patch: Partial<HintInput> & { readonly budget: BudgetState }): HintInput {
  return { state: beginFirstRun(TODAY), today: TODAY, totalInBaseMinor: 0, lastSuccessfulBackup: null, inFamily: false, ...patch };
}

describe("подсказка на первую трату (05)", () => {
  it("смотрит на «Продукты», а без них — на первую плитку расходов", () => {
    const state = preset();
    expect(state.categories.find((item) => item.id === coachCategoryId(state))?.name).toBe("Продукты");
    const without = { ...state, categories: state.categories.map((item) => (item.name === "Продукты" ? { ...item, active: false } : item)) };
    expect(without.categories.find((item) => item.id === coachCategoryId(without))?.name).toBe("Жильё");
  });

  it("стоит, пока нет ни одной записи и ни одного вопроса; первая запись или «Понятно» снимают её навсегда", () => {
    const state = preset();
    const run = beginFirstRun(TODAY);
    expect(coachVisible(run, state, false)).toBe(true);
    expect(coachVisible(run, state, true)).toBe(false);
    expect(coachVisible(null, state, false)).toBe(false);
    expect(coachVisible(EMPTY_FIRST_RUN, state, false)).toBe(false);
    const recorded = withRecords(state, 1);
    expect(coachVisible(run, recorded, false)).toBe(false);
    expect(coachDone(run, recorded)).toBe(true);
    const done = finishCoach(run);
    expect(done.coach).toBe("done");
    expect(coachVisible(done, state, false)).toBe(false);
    expect(finishCoach(done)).toBe(done);
  });

  it("не пропадает по времени и не держит фокус: ни таймера, ни ловушки Tab, текст — вежливо", () => {
    const source = readFileSync(new URL("./CoachMark.tsx", import.meta.url), "utf8");
    expect(source).not.toMatch(/setTimeout|setInterval|handleDialogKeyboard|aria-modal|role="dialog"/u);
    expect(source).toContain('role="status"');
    const markup = renderToStaticMarkup(<CoachMark target="category:x" onDismiss={() => undefined} />);
    expect(markup).toContain('<p class="coach-text" role="status"></p>');
    expect(markup).toContain(">Понятно</button>");
    expect(markup).toContain('<span class="coach-ring" aria-hidden="true"></span>');
    expect(COACH_TEXT).toBe("Коснитесь категории, чтобы записать расход");
    // Координаты — через CSSOM (`style.setProperty`), атрибута style в разметке нет: CSP.
    expect(markup).not.toMatch(/\sstyle=/u);
    expect(source).toContain("layer.style.setProperty(name,");
  });
});

describe("карточки-подсказки в конце «Обзора» (06b)", () => {
  it("«Укажите, сколько сейчас на карте» — пока «На счетах» ноль", () => {
    const state = preset();
    expect(visibleHints(input({ budget: state }))).toEqual(["opening-balance"]);
    expect(visibleHints(input({ budget: state, totalInBaseMinor: 100 }))).toEqual([]);
  });

  it("«Сделайте копию данных» — после десяти записей или недели с начала, и только если копии ещё не было", () => {
    const state = preset();
    expect([BACKUP_AFTER_RECORDS, BACKUP_AFTER_DAYS]).toEqual([10, 7]);
    const nine = withRecords(state, 9);
    expect(visibleHints(input({ budget: nine, totalInBaseMinor: 1 }))).toEqual(["import"]);
    expect(visibleHints(input({ budget: withRecords(state, 10), totalInBaseMinor: 1 }))).toEqual(["backup", "import"]);
    expect(visibleHints(input({ budget: nine, totalInBaseMinor: 1, today: "2026-10-26" }))).toEqual(["backup", "import"]);
    expect(visibleHints(input({ budget: withRecords(state, 10), totalInBaseMinor: 1, lastSuccessfulBackup: "2026-10-18T10:00:00.000Z" }))).toEqual(["import", "goal"]);
  });

  it("не больше двух сразу, по важности; закрытая — навсегда, и на её место встаёт следующая", () => {
    const busy = withRecords(preset(), 40);
    const all = input({ budget: busy, today: "2026-11-30" });
    expect(MAX_HINTS).toBe(2);
    expect(visibleHints(all)).toEqual(["opening-balance", "backup"]);
    let state: FirstRunState = closeHint(all.state, "opening-balance");
    expect(visibleHints({ ...all, state })).toEqual(["backup", "import"]);
    state = closeHint(closeHint(state, "backup"), "import");
    expect(visibleHints({ ...all, state })).toEqual(["goal", "family"]);
    expect(closeHint(state, "import")).toBe(state);
    // «Ведёте бюджет вдвоём?» — поздняя и только вне семьи.
    expect(visibleHints({ ...all, state, inFamily: true })).toEqual(["goal"]);
    expect(visibleHints({ ...all, state, budget: withRecords(preset(), 12), today: TODAY })).toEqual(["goal"]);
  });

  it("на демо — копия и выписка, как в макете 06b; у бюджета без набора неделя считается от первой записи", () => {
    const demo = buildDemoBudgetState(TODAY);
    expect(visibleHints({ state: EMPTY_FIRST_RUN, budget: demo, today: TODAY, totalInBaseMinor: 55_400_000, lastSuccessfulBackup: null, inFamily: false })).toEqual(["backup", "import"]);
  });

  it("разметка: заголовок, строка, действие и крестик «Скрыть подсказку «…»» у каждой; без снимка — ничего", async () => {
    const memory: FirstRunMemory = { load: async () => EMPTY_FIRST_RUN, save: async () => undefined, clear: async () => undefined };
    const store = createFirstRunStore(memory);
    const demo = buildDemoBudgetState(TODAY);
    const render = () => renderToStaticMarkup(<HintCards budget={demo} today={TODAY} lastSuccessfulBackup={null} inFamily={false} onAction={() => undefined} store={store} />);
    expect(render()).toBe("");
    await store.replace(EMPTY_FIRST_RUN);
    const markup = render();
    expect(markup.match(/<li class="hint card">/gu)).toHaveLength(2);
    expect(markup).toContain(`aria-label="Скрыть подсказку «${HINT_WORDS.backup.title}»"`);
    expect(markup).toContain(">Сделать копию</button>");
    expect(markup).toContain(">Загрузить выписку</button>");
    expect(markup).not.toMatch(/\sstyle=/u);
  });
});
