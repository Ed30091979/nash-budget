/// <reference types="node" />
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { renderToStaticMarkup } from "react-dom/server";
import type { BudgetState } from "@family-budget/domain";
import { describe, expect, it, vi } from "vitest";
import { protectUnsavedDraftOnUnload } from "./app/AppShell";
import { createAppBudgetSaveCoordinator } from "./app/budget-store";
import { readAppSource } from "./app/shell-source";
import { prepareBudgetState } from "./backup";
import { ConfirmDialog, draftLeaveQuestion } from "./components/ConfirmDialog";
import { makeG000State } from "./features/operations/test-fixture";
import { createOperationsSubmissionGate } from "./features/operations/form-state";
import { createDraftRegistry, createDraftSaving, type DraftEntry } from "./navigation/draft-guard";
import { createRouter, memoryRouterWindow } from "./navigation/router";
import { formatRoute, type Route } from "./navigation/routes";
import { activeTab } from "./components/BottomNav";
import { BudgetWriteRefusal, WRITE_REFUSAL_TEXT } from "./write-refusal";

/** Черновик экрана, которым проверка управляет руками. */
function draft(label: string, options: Partial<DraftEntry> = {}) {
  let dirty = false;
  const discard = vi.fn(() => { dirty = false; });
  const entry: { current: DraftEntry } = {
    current: { label, isDirty: () => dirty, discard, ...options },
  };
  return { entry, discard, setDirty: (value: boolean) => { dirty = value; } };
}

describe("реестр черновиков", () => {
  it("отвечает синхронно, в момент вопроса, — без эффекта и без отрисовки между", () => {
    const registry = createDraftRegistry();
    const form = draft("операция");
    registry.register(form.entry);
    expect(registry.hasUnsavedDrafts("navigation")).toBe(false);
    form.setDirty(true);
    // Ни `refresh`, ни перерисовки: вопрос читает черновик сейчас.
    expect(registry.hasUnsavedDrafts("navigation")).toBe(true);
    expect(registry.dirtyLabels("navigation")).toEqual(["операция"]);
  });

  it("экран, ушедший со страницы, больше ничего не держит", () => {
    const registry = createDraftRegistry();
    const form = draft("план");
    const unregister = registry.register(form.entry);
    form.setDirty(true);
    expect(registry.hasUnsavedDrafts()).toBe(true);
    unregister();
    expect(registry.hasUnsavedDrafts()).toBe(false);
  });

  it("начатый вход в «Семью» держит перезагрузку и обновление, но не переход внутри приложения", () => {
    const registry = createDraftRegistry();
    const signIn = draft("вход", { guardsNavigation: false });
    registry.register(signIn.entry);
    signIn.setDirty(true);
    expect(registry.hasUnsavedDrafts("navigation")).toBe(false);
    expect(registry.hasUnsavedDrafts("unload")).toBe(true);
    expect(registry.hasUnsavedDrafts()).toBe(true);
    // «Не сохранять» на переходе вход не трогает: он переживает переход.
    registry.discardAll("navigation");
    expect(signIn.discard).not.toHaveBeenCalled();
  });

  it("«Не сохранять» забывает грязные черновики перехода, и только их", () => {
    const registry = createDraftRegistry();
    const dirty = draft("операция");
    const clean = draft("план");
    registry.register(dirty.entry);
    registry.register(clean.entry);
    dirty.setDirty(true);
    registry.discardAll("navigation");
    expect(dirty.discard).toHaveBeenCalledOnce();
    expect(clean.discard).not.toHaveBeenCalled();
    expect(registry.hasUnsavedDrafts()).toBe(false);
  });

  it("сообщает подписчикам, только когда ответ для ухода со страницы изменился", () => {
    const registry = createDraftRegistry();
    const listener = vi.fn();
    registry.subscribe(listener);
    const form = draft("операция");
    registry.register(form.entry);
    expect(listener).not.toHaveBeenCalled();
    form.setDirty(true);
    registry.refresh();
    registry.refresh();
    expect(listener).toHaveBeenCalledOnce();
    expect(registry.snapshot()).toBe(true);
    form.setDirty(false);
    registry.refresh();
    expect(listener).toHaveBeenCalledTimes(2);
    expect(registry.snapshot()).toBe(false);
  });
});

describe("черновик, отправленный в запись", () => {
  it("«записывается» с того же касания и снова несохранённый, если запись не прошла", () => {
    const registry = createDraftRegistry();
    const saving = createDraftSaving();
    let dirty = true;
    registry.register({ current: { label: "операция", isDirty: () => dirty && !saving.saving } });
    expect(registry.hasUnsavedDrafts("navigation")).toBe(true);
    const ticket = saving.begin();
    // Касание вкладки сразу после «Записать» — без вопроса: черновик уже уходит в запись.
    expect(registry.hasUnsavedDrafts("navigation")).toBe(false);
    saving.fail(ticket);
    expect(registry.hasUnsavedDrafts("navigation")).toBe(true);
    dirty = false;
    expect(registry.hasUnsavedDrafts("navigation")).toBe(false);
  });

  it("удача держит «записывается», пока сброшенная форма не нарисована, и ни отрисовкой дольше", () => {
    const saving = createDraftSaving();
    const ticket = saving.begin();
    // Отрисовка до ответа координатора — старая, грязная форма: защёлка держит.
    saving.settle(true);
    expect(saving.saving).toBe(true);
    saving.succeed(ticket);
    // Ответ пришёл, а сброс ещё не нарисован: отрисовка со старой формой защёлку не снимает.
    saving.settle(true);
    expect(saving.saving).toBe(true);
    // Нарисована сброшенная форма — защёлка снята, и следующий набранный черновик снова несохранённый.
    saving.settle(false);
    expect(saving.saving).toBe(false);
    saving.settle(true);
    expect(saving.saving).toBe(false);
  });

  it("билет берётся внутри шлюза записи: запись, которую шлюз не пустил, защёлку не оставляет висеть", async () => {
    // Ревью 2a, круг 2, п. 5: билет брали до шлюза, и второе касание, которое шлюз отклонял
    // (`ignored`), оставляло последним билет, на который никто не ответит.
    const gate = createOperationsSubmissionGate();
    const saving = createDraftSaving();
    let finish: () => void = () => undefined;
    const write = () => new Promise<void>((resolve) => { finish = resolve; });
    const run = (submitsDraft: boolean) => gate.run(async () => {
      const ticket = submitsDraft ? saving.begin() : null;
      await write();
      if (ticket !== null) saving.succeed(ticket);
    });
    const first = run(true);
    expect(saving.saving).toBe(true);
    const second = run(true);
    await expect(second).resolves.toEqual({ status: "ignored" });
    finish();
    await first;
    saving.settle(false);
    expect(saving.saving).toBe(false);

    // Так было: билет второго касания взят до шлюза — последним, и первая запись его уже не снимет.
    const before = createDraftSaving();
    const firstTicket = before.begin();
    before.begin();
    before.succeed(firstTicket);
    before.settle(false);
    expect(before.saving).toBe(true);
  });

  it("отвечает только последняя запись: опоздавший ответ прежней ничего не снимает и не возвращает", () => {
    const saving = createDraftSaving();
    const first = saving.begin();
    const second = saving.begin();
    saving.fail(first);
    expect(saving.saving).toBe(true);
    saving.succeed(first);
    saving.settle(false);
    expect(saving.saving).toBe(true);
    saving.succeed(second);
    saving.settle(false);
    expect(saving.saving).toBe(false);
    // Неудача после того, как защёлка уже снята, — тоже не её дело.
    saving.fail(second);
    expect(saving.saving).toBe(false);
    // Без записи отрисовки ничего не делают.
    saving.settle(false);
    expect(saving.saving).toBe(false);
  });

  it("отказ записи при задержке документа семьи не трогает бюджет и возвращает черновик", async () => {
    const state = prepareBudgetState(makeG000State());
    const publish = vi.fn();
    const saveIfRevision = vi.fn();
    const coordinator = createAppBudgetSaveCoordinator({
      repository: { loadVersioned: async () => ({ value: state, revision: "r1" }), saveIfRevision },
      getCurrent: () => state,
      getRevision: () => "r1",
      setRevision: () => undefined,
      publish,
      // Документ задержан: журнал семьи отказывает раньше, чем что-либо ляжет в очередь.
      journalWrite: () => async () => { throw new BudgetWriteRefusal("held"); },
    });
    const registry = createDraftRegistry();
    const saving = createDraftSaving();
    const amount: string = "1250";
    registry.register({ current: { label: "операция", isDirty: () => amount !== "" && !saving.saving } });

    const ticket = saving.begin();
    expect(registry.hasUnsavedDrafts("navigation")).toBe(false);
    const write = coordinator.apply((current: BudgetState) => ({ ...current }));
    await expect(write).rejects.toBeInstanceOf(BudgetWriteRefusal);
    await expect(write).rejects.toMatchObject({ userMessage: WRITE_REFUSAL_TEXT.held });
    saving.fail(ticket);

    expect(publish).not.toHaveBeenCalled();
    expect(saveIfRevision).not.toHaveBeenCalled();
    expect(coordinator.locked).toBe(false);
    // Черновик на месте и снова держит переход.
    expect(registry.hasUnsavedDrafts("navigation")).toBe(true);
  });
});

describe("вопрос о черновике — диалог приложения, а не системное окно", () => {
  const question = draftLeaveQuestion(["операция, которую вы набирали"]);

  it("называет, что потеряется, и предлагает «Продолжить ввод» первым", () => {
    expect(question).toEqual({
      title: "Уйти без сохранения?",
      description: "Не записано: операция, которую вы набирали. Если уйти сейчас, введённое пропадёт.",
      cancelLabel: "Продолжить ввод",
      confirmLabel: "Не сохранять",
    });
    expect(draftLeaveQuestion([]).description).toBe("Не записано: введённое. Если уйти сейчас, введённое пропадёт.");
  });

  it("рисуется модальным alertdialog с именем и описанием, безопасная кнопка — первой", () => {
    const html = renderToStaticMarkup(<ConfirmDialog {...question} onCancel={vi.fn()} onConfirm={vi.fn()} />);
    expect(html).toMatch(/<section class="confirmation-dialog" role="alertdialog" tabindex="-1" aria-modal="true" aria-labelledby="([^"]+)" aria-describedby="([^"]+)"/u);
    const [, titleId, descriptionId] = /aria-labelledby="([^"]+)" aria-describedby="([^"]+)"/u.exec(html) ?? [];
    expect(html).toContain(`<h2 id="${titleId}">Уйти без сохранения?</h2>`);
    expect(html).toContain(`<p id="${descriptionId}">${question.description}</p>`);
    const cancel = html.indexOf(">Продолжить ввод</button>");
    const confirm = html.indexOf(">Не сохранять</button>");
    expect(cancel).toBeGreaterThan(-1);
    expect(cancel).toBeLessThan(confirm);
    expect(html).toContain('<button class="primary-button" type="button">Продолжить ввод</button>');
    expect(html).toContain('<button class="danger-button" type="button">Не сохранять</button>');
  });

  it("ловит фокус, отдаёт Esc безопасному ответу и возвращает фокус туда, откуда открыт", () => {
    const source = readFileSync(new URL("./components/ConfirmDialog.tsx", import.meta.url), "utf8");
    // Те же помощники доступности, что у диалога «Данные»: корень вне обхода, Tab по кругу.
    expect(source).toContain('import { activateDialogEnvironment, handleDialogKeyboard } from "../features/data-management/dialog-accessibility";');
    expect(source).toContain('return activateDialogEnvironment(document.getElementById("root"), cancelRef.current, opener);');
    expect(source).toContain("handleDialogKeyboard(event, dialogRef.current, true, onCancel);");
    expect(source).toContain("<button ref={cancelRef} className=\"primary-button\" type=\"button\" onClick={onCancel}>{cancelLabel}</button>");
    expect(source).toContain("createPortal(dialog, document.body)");
  });

  it("ни одного системного окна в приложении: ни `confirm`, ни `alert`, ни `prompt`", () => {
    const root = fileURLToPath(new URL(".", import.meta.url));
    const files: string[] = [];
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const path = join(dir, name);
        if (statSync(path).isDirectory()) walk(path);
        else if (/\.tsx?$/u.test(name) && !/\.test\.tsx?$/u.test(name)) files.push(path);
      }
    };
    walk(root);
    expect(files.length).toBeGreaterThan(50);
    for (const file of files) {
      const source = readFileSync(file, "utf8");
      expect(source, file).not.toMatch(/\bwindow\.(?:confirm|alert|prompt)\(|(?<![\w.])(?:confirm|alert|prompt)\(["'`]/u);
      expect(source, file).not.toContain("DISCARD_DRAFT_CONFIRMATION");
    }
  });
});

describe("оболочка спрашивает реестр", () => {
  const source = readAppSource();

  it("переход спрашивает реестр в момент нажатия и задаёт вопрос своим диалогом", () => {
    expect(source).toContain("const drafts = useMemo(() => createDraftRegistry(), []);");
    // Роутер спрашивает реестр и на нажатии, и на системном «Назад»; вопрос — диалог приложения.
    expect(source).toMatch(/guard: \{\s*blocks: \(\) => drafts\.hasUnsavedDrafts\("navigation"\),\s*confirm: \(proceed\) => setLeaveRequest\(\{ labels: drafts\.dirtyLabels\("navigation"\), proceed \}\),\s*\}/u);
    expect(source).toMatch(/onConfirm=\{\(\) => \{\s*setLeaveRequest\(null\);\s*drafts\.discardAll\("navigation"\);\s*leaveRequest\.proceed\(\);/u);
    expect(source).toContain("onCancel={() => setLeaveRequest(null)}");
    expect(source).not.toMatch(/onDirtyChange|DraftDirty|const hasUnsavedDraft\b/u);
  });

  it("перезагрузка и обновление версии читают тот же реестр — и незавершённый вход в «Семью»", () => {
    expect(source).toContain('const beforeUnload = (event: BeforeUnloadEvent) => protectUnsavedDraftOnUnload(event, drafts.hasUnsavedDrafts("unload"));');
    expect(source).toContain('window.addEventListener("beforeunload", beforeUnload)');
    expect(source).toContain('window.removeEventListener("beforeunload", beforeUnload)');
    expect(source).toContain("<UpdatePrompt drafts={drafts} suppressed={messageShown} />");
    expect(source).toContain('label: "вход в «Семью» по коду из письма", isDirty: () => false, guardsNavigation: false');
    expect(source).toContain("isDirty: () => awaitingLoginCode");
    const prompt = readFileSync(new URL("./components/UpdatePrompt.tsx", import.meta.url), "utf8");
    expect(prompt).toContain('hasUnsavedChanges: () => drafts.hasUnsavedDrafts("unload"),');
    expect(prompt).toContain("const hasUnsavedChanges = useUnsavedDrafts(drafts);");
  });

  it("каждый экран с черновиком регистрирует его, и только через реестр", () => {
    for (const file of [
      "./features/planning/PlanningScreen.tsx",
      "./features/import/ImportScreen.tsx",
    ]) {
      const screen = readFileSync(new URL(file, import.meta.url), "utf8");
      expect(screen, file).toContain("useDraftGuard(");
      expect(screen, file).toContain("createDraftSaving");
      expect(screen, file).not.toContain("onDirtyChange");
    }
    // Лист ввода регистрирует черновик, пока открыт; защёлка записи — у хранилища черновика,
    // которое переживает лист (`app/entry-draft-store.ts`).
    const sheet = readFileSync(new URL("./features/entry/EntrySheet.tsx", import.meta.url), "utf8");
    expect(sheet).toContain("useDraftGuard(");
    expect(sheet).not.toContain("onDirtyChange");
    expect(readFileSync(new URL("./app/entry-draft-store.ts", import.meta.url), "utf8")).toContain("createDraftSaving");
  });

  it("protects browser unload only while a draft is dirty", () => {
    const cleanEvent = {
      preventDefault: vi.fn(),
      returnValue: "unchanged",
    } as unknown as BeforeUnloadEvent;
    const dirtyEvent = {
      preventDefault: vi.fn(),
      returnValue: "unchanged",
    } as unknown as BeforeUnloadEvent;

    protectUnsavedDraftOnUnload(cleanEvent, false);
    expect(cleanEvent.preventDefault).not.toHaveBeenCalled();
    expect(cleanEvent.returnValue).toBe("unchanged");

    protectUnsavedDraftOnUnload(dirtyEvent, true);
    expect(dirtyEvent.preventDefault).toHaveBeenCalledOnce();
    expect(dirtyEvent.returnValue).toBe("");
  });

  it("оставляет дорогу домой одним нажатием с любого экрана", () => {
    const styles = readFileSync(new URL("./styles.css", import.meta.url), "utf8");
    // Панель разделов нарисована один раз на всю оболочку, до переключателя экранов, — поэтому
    // «Обзор» доступен и с плана, и с экрана семьи, куда ведёт только «назад» внутри них.
    const shell = source.slice(source.indexOf('<AppFrame className="app-shell"'));
    expect(shell.indexOf("<BottomNav ")).toBeGreaterThan(-1);
    expect(shell.indexOf("<BottomNav ")).toBeLessThan(shell.indexOf("<main id={MAIN_CONTENT_ID}"));
    expect(source).toContain('onTab={(tab) => navigate({ name: tab })}');
    expect(source).toMatch(/<nav ref=\{navRef\} className="bottom-nav" aria-label="Основные разделы">/u);
    // Каждый маршрут подсвечивает свою вкладку; лист — вкладку под собой (а лист «+» — сам «+», см. BottomNav.test).
    const routes: readonly Route[] = [
      { name: "overview" }, { name: "operations" }, { name: "reports" }, { name: "more" }, { name: "overview", sheet: "entry" },
      { name: "plan-month" }, { name: "plan-year" }, { name: "family" }, { name: "import" }, { name: "overview", month: "2026-08" },
    ];
    expect(routes.map((route) => activeTab(route))).toEqual([
      "overview", "operations", "reports", "more", "overview", "more", "more", "more", "more", "overview",
    ]);
    // И с любого маршрута одно нажатие на «Обзор» туда и ведёт — без вопроса, пока черновика нет.
    for (const route of routes) {
      const router = createRouter({ window: memoryRouterWindow(formatRoute(route)), guard: { blocks: () => false, confirm: () => undefined } });
      router.start();
      router.navigate({ name: "overview" });
      expect(router.current(), formatRoute(route)).toEqual({ name: "overview" });
    }

    // И ничто её не прячет: ни узкий экран, ни альбомная ориентация.
    const navRules = [...styles.matchAll(/([^{}]*\.bottom-nav[^{}]*)\{([^{}]*)\}/gu)];
    expect(navRules.length).toBeGreaterThan(0);
    for (const rule of navRules) {
      expect(rule[2]).not.toMatch(/display:\s*none|visibility:\s*hidden/u);
    }
  });

  it("routes every internal unmounting control through the shared guard", () => {
    // Каждая дверь между экранами — переход роутера, а значит, вопрос реестру; своего пути у неё нет.
    // «+» и строки «Операций» открывают лист ввода тем же переходом — `openSheet` зовёт `navigate`.
    expect(source).toContain("onAdd={() => openSheet({})}");
    expect(source).toContain("onEdit={openEdit}");
    expect(source).toContain('const destination = { ...withoutSheet(route), sheet: "entry", ...opening } as Route;');
    expect(source).toMatch(/setReplaceFailed\(\{ proceed: \(\) => \{ entryStore\.discardFailed\(\); navigate\(destination\); \} \}\);\s*return;\s*\}\s*navigate\(destination\);/u);
    // Не записанный черновик ждёт «Вернуться к черновику» и не держит переход; перезагрузку — держит.
    expect(source).toContain('const failedEntry = useRef<DraftEntry>({ label: "операция, которая не записалась", isDirty: () => entryStore.failed() !== null, guardsNavigation: false });');
    expect(source).toContain('onPlan={() => navigate({ name: "plan-month" })}');
    expect(source).toContain('onPlanYear={() => navigate({ name: "plan-year" })}');
    expect(source).toContain('onPlanning={() => navigate({ name: "plan-month" })}');
    expect(source).toContain('onFamily={() => navigate({ name: "family" })}');
    expect(source).toContain('onImportStatement={() => navigate({ name: "import" })}');
    expect(source).toContain("<MoreBackButton onBack={back} />");
    // Переход — через роутер; при задержке документа форма записи не открывается вовсе (ревью 2a, п. 6).
    expect(source).toMatch(/const navigate = \(destination: Route\) => \{\s*\/\/[^\n]*\n\s*const refusal = writeFormRefusal\(hold, destination\);\s*if \(refusal !== null\) \{\s*refuseWriteForm\(refusal\.message\);\s*return;\s*\}\s*router\.navigate\(destination\);\s*\};/u);
    expect(source).toContain("const back = () => router.back();");
    // Мимо роутера историю не трогает никто: ни `setScreen`, ни `history.back()`, ни запись в адрес.
    expect(source).not.toMatch(/setScreen\(|history\.(?:back|go|pushState|replaceState)\(|location\.hash\s*=/u);
  });
});
