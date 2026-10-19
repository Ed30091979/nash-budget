/// <reference types="node" />
import { readFileSync } from "node:fs";
import type { BudgetState } from "@family-budget/domain";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { buildDemoBudgetState } from "../../onboarding/demo";
import { buildOnboardingBudgetState } from "../../onboarding/model";
import type { BudgetWriter } from "../../write/useBudgetWrite";
import { coachVisible } from "./hints-model";
import { createFirstRunStore, EMPTY_FIRST_RUN, type FirstRunMemory, type FirstRunState } from "./memory";
import { QuestionHost } from "./QuestionHost";
import { beginFirstRun, finishFirstRun, firstRunBelongsTo, nextQuestion } from "./questions-model";

/*
 * Края первого запуска, найденные ревью R2: бюджет, заменённый копией или документом семьи (M-1),
 * взмах пальцем по слайду (M-3) и дни выплат, которые можно поменять и снять (M-4). Фокус после
 * «Своей категории» (M-2) проверяет настоящий браузер (`e2e/first-run-edges.spec.ts`).
 */

const TODAY = "2026-10-19";
const write: BudgetWriter = { run: async (change) => change({} as BudgetState) };

function preset(): BudgetState {
  let next = 0;
  return buildOnboardingBudgetState({ today: TODAY, makeId: () => `00000000-0000-4000-8000-${String(++next).padStart(12, "0")}` });
}

function silentStore() {
  const memory: FirstRunMemory = { load: async () => EMPTY_FIRST_RUN, save: async () => undefined, clear: async () => undefined };
  return createFirstRunStore(memory);
}

describe("M-1: первый запуск принадлежит бюджету, на котором начался", () => {
  it("набор помнит свой месяц плана; восстановленная копия или документ семьи — чужой бюджет", () => {
    const own = preset();
    const run = beginFirstRun(TODAY, own.activeBudgetId);
    expect(run.budgetId).toBe(own.activeBudgetId);
    expect(firstRunBelongsTo(run, own)).toBe(true);
    // Документ семьи, пришедший на устройство участника, и восстановленная копия — другие бюджеты.
    expect(firstRunBelongsTo(run, buildDemoBudgetState(TODAY))).toBe(false);
    // Память без привязки (демо, «Удалить данные») ни к чему не привязана и ничего не спрашивает.
    expect(firstRunBelongsTo(EMPTY_FIRST_RUN, own)).toBe(true);
  });

  it("законченный запуск: ни вопросов, ни подсказки на первую трату, а закрытые карточки — навсегда", () => {
    const own = preset();
    const run: FirstRunState = { ...beginFirstRun(TODAY, own.activeBudgetId), closedHints: ["import"] };
    const finished = finishFirstRun(run);
    expect(finished).toEqual({ ...EMPTY_FIRST_RUN, closedHints: ["import"] });
    expect(nextQuestion(finished, "2027-01-01")).toBeNull();
    expect(coachVisible(finished, own, false)).toBe(false);
  });

  it("хозяин вопросов над бюджетом семьи или копией молчит — даже если память ещё не дописана", async () => {
    const own = preset();
    const store = silentStore();
    await store.replace(beginFirstRun(TODAY, own.activeBudgetId));
    const render = (budget: BudgetState) => renderToStaticMarkup(
      <QuestionHost budget={budget} today={TODAY} write={write} blocked={false} onAddAccount={() => undefined} store={store} />,
    );
    expect(render(own)).toContain('aria-labelledby="q-categories-title"');
    expect(render(buildDemoBudgetState(TODAY))).toBe("");
  });

  it("восстановление копии заканчивает первый запуск явно — и в оболочке, а не только по привязке", () => {
    const routes = readFileSync(new URL("../../app/routes.tsx", import.meta.url), "utf8");
    const restore = routes.slice(routes.indexOf("onRestoreBackup="), routes.indexOf("onPersistClear="));
    expect(restore).toContain("firstRunStore().update(finishFirstRun)");
  });
});

describe("L-1: бюджет уже создан в другой вкладке", () => {
  it("набор не записан — память первого запуска обнулена; записан — привязана к его месяцу плана", async () => {
    const { startFirstRun } = await import("../../onboarding/Onboarding");
    const state = preset();
    const store = silentStore();
    await startFirstRun(state, TODAY, store, async () => "existing");
    expect(store.snapshot()).toEqual(EMPTY_FIRST_RUN);
    await startFirstRun(state, TODAY, store, async () => "created");
    expect(store.snapshot()).toMatchObject({ startedOn: TODAY, budgetId: state.activeBudgetId });
  });
});

describe("M-3: взмах пальцем по слайду", () => {
  it("горизонтальный жест слайда не забирает браузер, а отменённый указатель сбрасывает взмах", () => {
    const styles = readFileSync(new URL("../../styles.css", import.meta.url), "utf8");
    expect(styles).toMatch(/\.intro-slide \{[^}]*touch-action: pan-y;/u);
    const source = readFileSync(new URL("../../onboarding/Onboarding.tsx", import.meta.url), "utf8");
    expect(source).toContain("onPointerCancel={");
  });
});

