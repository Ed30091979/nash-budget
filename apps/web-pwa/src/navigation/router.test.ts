import { describe, expect, it, vi } from "vitest";
import { createRouter } from "./router";
import { formatRoute, routeKey, type Route } from "./routes";
import { draftGuard, expectHonestHistory, FakeBrowser, go, settle, started } from "./test-fixture";

const OPERATION = "7f1d2c3b-4a5e-4f60-8a7b-9c0d1e2f3a4b";
const CATEGORY = "73333333-3333-4333-8333-333333333335";
/** Лист ввода с «+» поверх «Обзора» и поверх «Операций», и правка операции из «Операций». */
const ADD = { name: "overview", sheet: "entry" } as const;
const ADD_OVER_OPERATIONS = { name: "operations", sheet: "entry" } as const;
const EDIT = { name: "operations", sheet: "entry", edit: OPERATION } as const;

describe("история: «Обзор» — корень, вкладка на вкладку — замена", () => {
  it("первое открытие ставит «Обзор» в адрес и не плодит записей", () => {
    const { frame, router } = started();
    expect(router.current()).toEqual({ name: "overview" });
    expect(frame.hashes).toEqual(["#/"]);
    expect(frame.history.scrollRestoration).toBe("manual");
  });

  it("«Обзор» → вкладка кладёт запись; вкладка → вкладка заменяет; «Назад» с любой вкладки — «Обзор»", async () => {
    const { frame, router } = started();
    await go(router, { name: "operations" });
    expect(frame.hashes).toEqual(["#/", "#/operations"]);
    await go(router, { name: "reports" });
    await go(router, { name: "more" });
    expect(frame.hashes).toEqual(["#/", "#/more"]);
    expect(frame.index).toBe(1);
    await frame.press(-1);
    expect(router.current()).toEqual({ name: "overview" });
    expect(frame.hash).toBe("#/");
  });

  it("вкладка → «Обзор» возвращается по истории, а не кладёт вторую запись «Обзора»", async () => {
    const { frame, router } = started();
    await go(router, { name: "reports" });
    await go(router, { name: "overview" });
    expect(router.current()).toEqual({ name: "overview" });
    expect(frame.index).toBe(0);
    expect(frame.hash).toBe("#/");
  });

  it("подэкран кладёт запись, а «назад» экрана возвращает к родителю без дубля в истории", async () => {
    const { frame, router } = started();
    await go(router, { name: "more" });
    await go(router, { name: "plan-month" });
    expect(frame.hashes).toEqual(["#/", "#/more", "#/more/plan-month"]);
    router.back();
    await settle();
    expect(router.current()).toEqual({ name: "more" });
    expect(frame.index).toBe(1);
    await frame.press(-1);
    expect(router.current()).toEqual({ name: "overview" });
  });

  it("подэкран, открытый с соседнего подэкрана, кладётся поверх: системное «Назад» — к соседу, «назад» экрана — к родителю", async () => {
    const { frame, router } = started();
    await go(router, { name: "more" });
    await go(router, { name: "plan-year" });
    await go(router, { name: "plan-month" });
    expect(frame.hashes).toEqual(["#/", "#/more", "#/more/plan-year", "#/more/plan-month"]);
    await frame.press(-1);
    expect(router.current()).toEqual({ name: "plan-year" });
    await go(router, { name: "plan-month" });
    router.back();
    await settle();
    expect(router.current()).toEqual({ name: "more" });
    expect(frame.index).toBe(1);
  });

  it("маршрут, который уже лежит ниже, не кладётся второй раз — приложение возвращается к нему", async () => {
    const { frame, router } = started();
    await go(router, { name: "more" });
    await go(router, { name: "plan-year" });
    await go(router, { name: "plan-month" });
    await go(router, { name: "plan-year" });
    expect(router.current()).toEqual({ name: "plan-year" });
    expect(frame.index).toBe(2);
  });

  it("знает маршрут с первой отрисовки, ещё до того, как достроил историю", () => {
    const frame = new FakeBrowser("#/more/family");
    const router = createRouter({ window: frame });
    expect(router.current()).toEqual({ name: "family" });
    expect(frame.hashes).toEqual(["#/more/family"]);
  });

  it("подэкран, открытый не из «Ещё», получает родителя в истории: «Назад» ведёт в «Ещё»", async () => {
    const { frame, router } = started();
    await go(router, { name: "plan-month" });
    expect(frame.hashes).toEqual(["#/", "#/more", "#/more/plan-month"]);
    await frame.press(-1);
    expect(router.current()).toEqual({ name: "more" });
  });

  it("с подэкрана на другую вкладку — вкладка встаёт над «Обзором», а не над подэкраном", async () => {
    const { frame, router } = started();
    await go(router, { name: "plan-year" });
    await go(router, { name: "operations" });
    expect(router.current()).toEqual({ name: "operations" });
    expect(frame.hashes.slice(0, frame.index + 1)).toEqual(["#/", "#/operations"]);
    await frame.press(-1);
    expect(router.current()).toEqual({ name: "overview" });
  });

  it("лист «+» кладётся поверх вкладки, с которой его нажали, и «Назад» возвращает на неё", async () => {
    const { frame, router } = started();
    await go(router, { name: "operations" });
    await go(router, ADD_OVER_OPERATIONS);
    expect(frame.hashes).toEqual(["#/", "#/operations", "#/operations?sheet=entry"]);
    await go(router, ADD_OVER_OPERATIONS);
    expect(frame.hashes).toEqual(["#/", "#/operations", "#/operations?sheet=entry"]);
    await frame.press(-1);
    expect(router.current()).toEqual({ name: "operations" });
  });

  it("лист с плиток «Обзора» — поверх «Обзора»; «Закрыть» возвращает на него без лишней записи", async () => {
    const { frame, router } = started();
    await go(router, { name: "overview", sheet: "entry", op: "expense", dst: CATEGORY });
    expect(frame.hashes).toEqual(["#/", `#/?sheet=entry&op=expense&dst=${CATEGORY}`]);
    router.back();
    await settle();
    expect(router.current()).toEqual({ name: "overview" });
    expect(frame.index).toBe(0);
  });

  it("правка операции — лист над «Операциями»; «назад» экрана закрывает его без лишней записи", async () => {
    const { frame, router } = started();
    await go(router, { name: "operations" });
    await go(router, EDIT);
    expect(frame.hashes).toEqual(["#/", "#/operations", `#/operations?sheet=entry&edit=${OPERATION}`]);
    router.back();
    await settle();
    expect(router.current()).toEqual({ name: "operations" });
    expect(frame.index).toBe(1);
  });

  it("другой месяц «Обзора» — как вкладка: месяц на месяц не копит записи, «Назад» — к текущему месяцу", async () => {
    const { frame, router } = started();
    await go(router, { name: "overview", month: "2026-08" });
    expect(frame.hashes).toEqual(["#/", "#/?month=2026-08"]);
    await go(router, { name: "overview", month: "2026-09" });
    expect(frame.hashes).toEqual(["#/", "#/?month=2026-09"]);
    // Лист над другим месяцем закрывается на этот же месяц.
    await go(router, { name: "overview", month: "2026-09", sheet: "entry", op: "expense", dst: CATEGORY });
    router.back();
    await settle();
    expect(router.current()).toEqual({ name: "overview", month: "2026-09" });
    await frame.press(-1);
    expect(router.current()).toEqual({ name: "overview" });
    expect(frame.index).toBe(0);
    expectHonestHistory(frame);
  });

  it("замена по просьбе меняет текущую запись и не трогает ту, что под ней", async () => {
    const { frame, router } = started();
    await go(router, { name: "more" });
    await go(router, { name: "family" });
    await go(router, { name: "import" }, true);
    expect(frame.hashes).toEqual(["#/", "#/more", "#/more/import"]);
  });

  it("перед сменой маршрута называет ключ того, с которого уходят, и того, куда приходят", async () => {
    const onLeave = vi.fn();
    const { frame, router } = started("", null, { onLeave });
    await go(router, { name: "operations" });
    expect(onLeave).toHaveBeenLastCalledWith("#/", "#/operations");
    await frame.press(-1);
    expect(onLeave).toHaveBeenLastCalledWith("#/operations", "#/");
    // Лист поверх экрана — тоже смена маршрута: оболочка по двум ключам видит, что экран тот же.
    await go(router, ADD);
    expect(onLeave).toHaveBeenLastCalledWith("#/", "#/?sheet=entry");
  });

  it("подписчик узнаёт о каждом новом маршруте, и только о нём", async () => {
    const { router } = started();
    const listener = vi.fn();
    router.subscribe(listener);
    await go(router, { name: "operations" });
    await go(router, { name: "operations" });
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it("переход, попросивший дорогу, пока история ещё едет, выполняется после неё", async () => {
    const { frame, router } = started();
    await go(router, { name: "plan-month" });
    router.navigate({ name: "operations" });
    router.navigate({ name: "reports" });
    await settle();
    await settle();
    expect(router.current()).toEqual({ name: "reports" });
    expect(frame.hashes.slice(0, frame.index + 1)).toEqual(["#/", "#/reports"]);
  });
});

describe("адрес, открытый ссылкой или перезагрузкой", () => {
  it("ссылка на подэкран достраивает историю родителями: «Назад» идёт по ним, а не прочь", async () => {
    const { frame, router } = started("#/more/plan-month");
    expect(router.current()).toEqual({ name: "plan-month" });
    expect(frame.hashes).toEqual(["#/", "#/more", "#/more/plan-month"]);
    await frame.press(-1);
    expect(router.current()).toEqual({ name: "more" });
    await frame.press(-1);
    expect(router.current()).toEqual({ name: "overview" });
  });

  it("перезагрузка оставляет историю как была и не добавляет записей", async () => {
    const first = started();
    await go(first.router, { name: "more" });
    await go(first.router, { name: "family" });
    first.stop();
    const reloaded = createRouter({ window: first.frame });
    reloaded.start();
    expect(reloaded.current()).toEqual({ name: "family" });
    expect(first.frame.hashes).toEqual(["#/", "#/more", "#/more/family"]);
    await first.frame.press(-1);
    expect(reloaded.current()).toEqual({ name: "more" });
  });

  it("при перезагрузке лист закрыт: черновик никогда не попадает в адрес", async () => {
    const first = started();
    await go(first.router, { name: "operations" });
    await go(first.router, { name: "operations", sheet: "entry" });
    expect(first.frame.hash).toBe("#/operations?sheet=entry");
    first.stop();
    const reloaded = createRouter({ window: first.frame });
    reloaded.start();
    expect(reloaded.current()).toEqual({ name: "operations" });
    expect(first.frame.hash).toBe("#/operations");
    // Ссылка с листом без нашей истории — тоже без листа.
    const linked = started("#/?sheet=entry");
    expect(linked.router.current()).toEqual({ name: "overview" });
    expect(linked.frame.hashes).toEqual(["#/"]);
  });

  it("мусор в адресе ведёт к родителю и говорит «Запись не найдена» один раз", () => {
    const onNotFound = vi.fn();
    const { frame, router } = started("#/more/bogus", null, { onNotFound });
    expect(router.current()).toEqual({ name: "more" });
    expect(frame.hashes).toEqual(["#/", "#/more"]);
    expect(onNotFound).toHaveBeenCalledOnce();
  });

  it("адрес, набранный руками, встаёт поверх текущего, мусорный — к родителю с «не найдена»", async () => {
    const onNotFound = vi.fn();
    const { frame, router } = started("", null, { onNotFound });
    await frame.type("#/reports");
    expect(router.current()).toEqual({ name: "reports" });
    expect(frame.hash).toBe("#/reports");
    await frame.type("#/operations/oops");
    expect(router.current()).toEqual({ name: "operations" });
    expect(frame.hash).toBe("#/operations");
    expect(onNotFound).toHaveBeenCalledOnce();
  });
});

describe("переход по якорю", () => {
  it("адрес, о котором браузер сказал только `hashchange`, разбирается так же, как по `popstate`", async () => {
    const onNotFound = vi.fn();
    const { frame, router } = started("", null, { onNotFound });
    frame.entries.push({ state: null, hash: "#/more/bogus" });
    frame.index += 1;
    frame.fireHashOnly();
    expect(router.current()).toEqual({ name: "more" });
    expect(frame.hash).toBe("#/more");
    expect(onNotFound).toHaveBeenCalledOnce();
    // Повторное событие того же перехода уже ничего не меняет.
    frame.fireHashOnly();
    expect(onNotFound).toHaveBeenCalledOnce();
  });
});

describe("черновик и переходы", () => {
  it("защиту спрашивают, откуда и куда переход: нажатие, «Назад» листа и системное «Назад» (ревью 2b, MEDIUM-4)", async () => {
    const asked: string[] = [];
    const record = (from: Route, to: Route) => { asked.push(`${routeKey(from)} → ${routeKey(to)}`); };
    const { frame, router } = started("", null, { guard: { blocks: (from, to) => { record(from, to); return false; }, confirm: () => undefined } });
    await go(router, { name: "plan-month" });
    await go(router, { name: "plan-month", sheet: "entry" });
    router.back();
    await settle();
    await go(router, { name: "plan-month", sheet: "entry" });
    await frame.press(-1);
    expect(asked).toEqual([
      "#/ → #/more/plan-month",
      "#/more/plan-month → #/more/plan-month?sheet=entry",
      "#/more/plan-month?sheet=entry → #/more/plan-month",
      "#/more/plan-month → #/more/plan-month?sheet=entry",
      "#/more/plan-month?sheet=entry → #/more/plan-month",
    ]);
  });

  it("с грязным черновиком переход спрашивает и ничего не меняет до ответа", async () => {
    const drafts = draftGuard();
    const { frame, router } = started("", null, { guard: drafts.guard });
    await go(router, ADD);
    drafts.setDirty(true);
    await go(router, { name: "more" });
    expect(drafts.asked).toHaveLength(1);
    expect(router.current()).toEqual(ADD);
    expect(frame.hashes).toEqual(["#/", "#/?sheet=entry"]);
    // «Не сохранять»: переход идёт, и черновик, ещё не убранный с экрана, его не останавливает.
    drafts.asked[0]?.();
    await settle();
    expect(router.current()).toEqual({ name: "more" });
    expect(drafts.asked).toHaveLength(1);
  });

  it("системное «Назад» с грязным черновиком возвращает адрес на место и задаёт тот же вопрос", async () => {
    const drafts = draftGuard();
    const { frame, router } = started("", null, { guard: drafts.guard });
    await go(router, { name: "operations" });
    await go(router, ADD_OVER_OPERATIONS);
    drafts.setDirty(true);
    await frame.press(-1);
    expect(drafts.asked).toHaveLength(1);
    expect(router.current()).toEqual(ADD_OVER_OPERATIONS);
    expect(frame.hash).toBe("#/operations?sheet=entry");
    expect(frame.hashes).toEqual(["#/", "#/operations", "#/operations?sheet=entry"]);
    // «Продолжить ввод»: ничего не происходит, и следующее «Назад» снова спрашивает.
    await frame.press(-1);
    expect(drafts.asked).toHaveLength(2);
    expect(frame.hash).toBe("#/operations?sheet=entry");
    // «Не сохранять»: туда, куда человек шёл.
    drafts.asked[1]?.();
    await settle();
    expect(router.current()).toEqual({ name: "operations" });
    expect(frame.hash).toBe("#/operations");
    drafts.setDirty(false);
    await frame.press(-1);
    expect(router.current()).toEqual({ name: "overview" });
  });

  it("уход к родителю, потому что записи больше нет, не спрашивает о черновике", async () => {
    const drafts = draftGuard();
    const { router } = started("", null, { guard: drafts.guard });
    await go(router, { name: "operations" });
    await go(router, EDIT);
    drafts.setDirty(true);
    router.redirect({ name: "operations" });
    await settle();
    expect(router.current()).toEqual({ name: "operations" });
    expect(drafts.asked).toEqual([]);
  });

  it("нажатие на текущую вкладку — не переход и не вопрос", async () => {
    const drafts = draftGuard();
    const { router } = started("", null, { guard: drafts.guard });
    await go(router, { name: "operations" });
    drafts.setDirty(true);
    await go(router, { name: "operations" });
    expect(drafts.asked).toEqual([]);
  });
});

describe("ключи истории", () => {
  it("каждая запись истории несёт свою цепочку от корня — и только адреса маршрутов", async () => {
    const { frame, router } = started();
    await go(router, { name: "operations" });
    await go(router, EDIT);
    const states = frame.entries.map((entry) => entry.state as { stack: string[] });
    expect(states.map((state) => state.stack)).toEqual([
      ["#/"],
      ["#/", "#/operations"],
      ["#/", "#/operations", formatRoute(EDIT)],
    ]);
  });
});

describe("история остаётся правдой и впереди, и позади (ревью 2a, п. 5)", () => {
  it("«Ещё» → «План на год» → вкладка → «Вперёд»: впереди нет устаревших записей, «К разделу «Ещё»» — в «Ещё»", async () => {
    const { frame, router } = started();
    await go(router, { name: "more" });
    await go(router, { name: "plan-year" });
    await go(router, { name: "operations" });
    expectHonestHistory(frame);
    // Вкладка встала над «Обзором» наращиванием: записи «Ещё» и «Плана на год» впереди отрезаны,
    // и «Вперёд» не ведёт туда, где цепочка в записи — уже неправда.
    expect(frame.hashes).toEqual(["#/", "#/operations"]);
    await frame.press(1);
    expect(router.current()).toEqual({ name: "operations" });
    expect(frame.hash).toBe("#/operations");
    // «Вперёд», которому есть куда идти, приходит на запись с правдивой цепочкой, и «назад» экрана
    // ведёт к её родителю.
    await go(router, { name: "more" });
    await go(router, { name: "plan-year" });
    await frame.press(-1);
    expect(router.current()).toEqual({ name: "more" });
    await frame.press(1);
    expect(router.current()).toEqual({ name: "plan-year" });
    router.back();
    await settle();
    expect(router.current()).toEqual({ name: "more" });
    expect(frame.hash).toBe("#/more");
    expect(frame.index).toBe(1);
    expectHonestHistory(frame);
  });

  it("черновик в листе «+», адрес набран руками → «Продолжить ввод» → «Обзор» → «Не сохранять»: и экран, и адрес — «Обзор»", async () => {
    const drafts = draftGuard();
    const { frame, router, stop } = started("", null, { guard: drafts.guard });
    await go(router, ADD);
    drafts.setDirty(true);
    await frame.type("#/reports");
    // Набранная запись стала правдивой копией листа, и роутер вернулся на шаг — на сам лист: копия
    // лежит впереди, а не под экраном (ревью 2a, круг 2, LOW 2). Адрес — снова лист.
    expect(drafts.asked).toHaveLength(1);
    expect(router.current()).toEqual(ADD);
    expect(frame.hash).toBe("#/?sheet=entry");
    expect(frame.hashes).toEqual(["#/", "#/?sheet=entry", "#/?sheet=entry"]);
    expect(frame.index).toBe(1);
    expectHonestHistory(frame);
    // «Продолжить ввод» — ничего; затем «Обзор» и «Не сохранять».
    await go(router, { name: "overview" });
    expect(drafts.asked).toHaveLength(2);
    drafts.setDirty(false);
    drafts.asked[1]?.();
    await settle();
    await settle();
    expect(router.current()).toEqual({ name: "overview" });
    expect(frame.hash).toBe("#/");
    expectHonestHistory(frame);
    // Перезагрузка открывает то, что на экране, а не лист.
    stop();
    const reloaded = createRouter({ window: frame, guard: drafts.guard });
    reloaded.start();
    expect(reloaded.current()).toEqual({ name: "overview" });
  });

  it("адрес, набранный поверх черновика, → системное «Назад» → «Не сохранять» закрывает лист, а не оставляет на копии", async () => {
    // Ревью 2a, круг 2, LOW 2: история была [#/, #/new, #/new] с позицией на копии, и «Назад» с
    // «Не сохранять» стирал черновик, оставляя человека на «+». Теперь «+» — лист, правило то же.
    const drafts = draftGuard();
    const { frame, router } = started("", null, { guard: drafts.guard });
    await go(router, ADD);
    drafts.setDirty(true);
    await frame.type("#/reports");
    expect(drafts.asked).toHaveLength(1);
    await frame.press(-1);
    expect(drafts.asked).toHaveLength(2);
    expect(router.current()).toEqual(ADD);
    drafts.setDirty(false);
    drafts.asked[1]?.();
    await settle();
    await settle();
    expect(router.current()).toEqual({ name: "overview" });
    expect(frame.hash).toBe("#/");
    expect(frame.index).toBe(0);
    expectHonestHistory(frame);
  });

  it("адрес, поставленный на место текущей записи (`location.replace`), — переход, и счёт шагов не сбивается", async () => {
    // Ревью 2a, круг 2, LOW 3: замену принимали за новую запись, и следующий возврат по истории
    // уходил на запись дальше, чем нужно, — в Chromium до about:blank.
    const { frame, router } = started();
    await go(router, { name: "operations" });
    await frame.typeReplacing("#/reports");
    await settle();
    expect(router.current()).toEqual({ name: "reports" });
    expect(frame.hash).toBe("#/reports");
    expect(frame.hashes).toEqual(["#/", "#/reports"]);
    expectHonestHistory(frame);
    await go(router, { name: "more" });
    await go(router, { name: "plan-year" });
    await go(router, { name: "overview" });
    expect(router.current()).toEqual({ name: "overview" });
    expect(frame.index).toBe(0);
    expectHonestHistory(frame);

    // С черновиком замена возвращает запись на место и спрашивает.
    const drafts = draftGuard();
    const guarded = started("", null, { guard: drafts.guard });
    await go(guarded.router, { name: "operations" });
    await go(guarded.router, ADD_OVER_OPERATIONS);
    drafts.setDirty(true);
    await guarded.frame.typeReplacing("#/more/family");
    expect(drafts.asked).toHaveLength(1);
    expect(guarded.frame.hashes).toEqual(["#/", "#/operations", "#/operations?sheet=entry"]);
    expect(guarded.frame.index).toBe(2);
    expectHonestHistory(guarded.frame);
    drafts.setDirty(false);
    drafts.asked[0]?.();
    await settle();
    await settle();
    expect(guarded.router.current()).toEqual({ name: "family" });
    expect(guarded.frame.hashes.slice(0, guarded.frame.index + 1)).toEqual(["#/", "#/more", "#/more/family"]);
    expectHonestHistory(guarded.frame);
  });

  it("переход по истории, на который не пришёл `popstate`, не держит очередь вечно: маршрут встаёт сверху", async () => {
    // Ревью 2a, круг 2, LOW 3: в окне без записей ниже (автономное окно, WebView Android) `go()`
    // уходит за край, `popstate` не приходит, и каждое следующее касание ждало его вечно.
    const frame = new FakeBrowser("#/more/family", { mark: "nash-budget/route", stack: ["#/", "#/more", "#/more/family"] });
    const router = createRouter({ window: frame });
    router.start();
    expect(frame.hashes).toEqual(["#/more/family"]);
    router.back();
    await settle();
    // Записи «Ещё» ниже нет: ждём сторож и смотрим, что маршрут всё же открылся.
    expect(router.current()).toEqual({ name: "family" });
    await new Promise<void>((resolve) => { setTimeout(resolve, 600); });
    expect(router.current()).toEqual({ name: "more" });
    expect(frame.hash).toBe("#/more");
    // Следующий переход не стоит в очереди за пропавшим `popstate`.
    router.navigate({ name: "reports" });
    await new Promise<void>((resolve) => { setTimeout(resolve, 600); });
    expect(router.current()).toEqual({ name: "reports" });
    expect(frame.hash).toBe("#/reports");
  });

  it("набранный адрес с черновиком и «Не сохранять» ведёт туда, куда его набрали", async () => {
    const drafts = draftGuard();
    const { frame, router } = started("", null, { guard: drafts.guard });
    await go(router, { name: "operations" });
    await go(router, ADD_OVER_OPERATIONS);
    drafts.setDirty(true);
    await frame.type("#/more/family");
    expect(frame.hash).toBe("#/operations?sheet=entry");
    // «Не сохранять» убирает черновик.
    drafts.setDirty(false);
    drafts.asked[0]?.();
    await settle();
    await settle();
    expect(router.current()).toEqual({ name: "family" });
    expect(frame.hash).toBe("#/more/family");
    expectHonestHistory(frame);
    await frame.press(-1);
    expect(router.current()).toEqual({ name: "more" });
  });

  it("сотня случайных шагов — история правдива, адрес совпадает с экраном", async () => {
    const routes = [
      { name: "overview" }, { name: "operations" }, { name: "reports" }, { name: "more" },
      ADD, EDIT, { name: "plan-month" }, { name: "plan-year" },
      { name: "family" }, { name: "import" }, ADD_OVER_OPERATIONS,
      { name: "overview", month: "2026-08" }, { name: "overview", month: "2026-08", sheet: "entry", op: "expense", dst: CATEGORY },
    ] as const;
    const typed = ["#/reports", "#/more/family", "#/bogus", "#/operations?sheet=entry&edit=1200", "#/?month=2026-09", "#/new", "#/more", "#/"] as const;
    for (const seed of [1, 7, 42]) {
      let value = seed;
      const random = (limit: number) => {
        value = (value * 1103515245 + 12345) % 2147483648;
        return value % limit;
      };
      const drafts = draftGuard();
      const { frame, router } = started("", null, { guard: drafts.guard });
      for (let step = 0; step < 60; step += 1) {
        const pick = random(10);
        const asked = drafts.asked.length;
        if (pick < 4) await go(router, routes[random(routes.length)] ?? { name: "overview" }, random(5) === 0);
        else if (pick < 5) { router.back(); await settle(); }
        else if (pick < 7) await frame.press(random(2) === 0 ? -1 : 1);
        else if (pick < 8) await frame.type(typed[random(typed.length)] ?? "#/");
        else drafts.setDirty(random(2) === 0);
        // Вопрос задан — человек отвечает сразу: «Не сохранять» или «Продолжить ввод».
        if (drafts.asked.length > asked && random(2) === 0) {
          drafts.setDirty(false);
          drafts.asked[drafts.asked.length - 1]?.();
          await settle();
        }
        await settle();
        expectHonestHistory(frame);
        expect(frame.hash, `seed ${seed}, step ${step}`).toBe(formatRoute(router.current()));
      }
    }
  }, 20_000);
});

describe("роутер 2d: «Операции» с фильтром и «Отчёты»", () => {
  const CATEGORY = "73333333-3333-4333-8333-333333333335";
  const OPERATION = "7f1d2c3b-4a5e-4f60-8a7b-9c0d1e2f3a4b";

  it("строка легенды кладёт ленту поверх «Отчётов», и «Назад» возвращает «Отчёты» с их периодом", async () => {
    const { frame, router } = started();
    await go(router, { name: "reports", period: "quarter", view: "income" });
    await go(router, { name: "operations", cat: CATEGORY, from: "2026-10-01", to: "2026-12-31" });
    expect(frame.hashes).toEqual(["#/", "#/reports?view=income&period=quarter", `#/operations?from=2026-10-01&to=2026-12-31&cat=${CATEGORY}`]);
    expectHonestHistory(frame);
    await frame.press(-1);
    expect(formatRoute(router.current())).toBe("#/reports?view=income&period=quarter");
    // Вкладка «Операции» без фильтра — снова вкладка: «Назад» с неё — на «Обзор».
    await go(router, { name: "operations" });
    expect(frame.hashes.slice(0, frame.index + 1)).toEqual(["#/", "#/operations"]);
  });

  it("«‹ Отчёты» ленты из легенды: запись под ней — «Отчёты», переход к ней — назад по истории, без новой записи (LOW-6)", async () => {
    const { frame, router } = started();
    expect(router.beneath()).toBeNull();
    await go(router, { name: "reports", period: "year" });
    expect(router.beneath()).toEqual({ name: "overview" });
    await go(router, { name: "operations", cat: CATEGORY, from: "2026-01-01", to: "2026-12-31" });
    const beneath = router.beneath();
    expect(beneath).toEqual({ name: "reports", period: "year" });
    // Смена фильтра ленты заменяет её запись — «Отчёты» под ней остаются.
    await go(router, { name: "operations", cat: CATEGORY, from: "2026-01-01", to: "2026-12-31", kind: "expense" }, true);
    expect(router.beneath()).toEqual({ name: "reports", period: "year" });
    // Лист правки поверх ленты — тот же экран: под ним по-прежнему «Отчёты», и строка «‹ Отчёты» не пропадает.
    await go(router, { name: "operations", cat: CATEGORY, from: "2026-01-01", to: "2026-12-31", kind: "expense", sheet: "entry", edit: OPERATION });
    expect(router.beneath()).toEqual({ name: "reports", period: "year" });
    router.back();
    await settle();
    expect(router.current()).toEqual({ name: "operations", cat: CATEGORY, from: "2026-01-01", to: "2026-12-31", kind: "expense" });
    // «‹ Отчёты» — переход к записи под лентой: история едет назад, ленты впереди не прибавляется.
    await go(router, beneath!);
    expect(formatRoute(router.current())).toBe("#/reports?period=year");
    expect(frame.index).toBe(1);
    expectHonestHistory(frame);
    await frame.press(-1);
    expect(routeKey(router.current())).toBe("#/");
    // Вкладка «Операции» — над «Обзором»: «‹ Отчёты» у неё нет.
    await go(router, { name: "operations" });
    expect(router.beneath()).toEqual({ name: "overview" });
  });

  it("смена фильтра заменяет запись, лист правки — поверх, его закрытие возвращает фильтр", async () => {
    const { frame, router } = started();
    await go(router, { name: "operations" });
    await go(router, { name: "operations", cat: CATEGORY }, true);
    await go(router, { name: "operations", cat: CATEGORY, kind: "expense" }, true);
    expect(frame.hashes.slice(0, frame.index + 1)).toEqual(["#/", `#/operations?cat=${CATEGORY}&kind=expense`]);
    await go(router, { name: "operations", cat: CATEGORY, kind: "expense", sheet: "entry", edit: OPERATION });
    router.back();
    await settle();
    expect(router.current()).toEqual({ name: "operations", cat: CATEGORY, kind: "expense" });
    expectHonestHistory(frame);
    await frame.press(-1);
    expect(routeKey(router.current())).toBe("#/");
  });
});
