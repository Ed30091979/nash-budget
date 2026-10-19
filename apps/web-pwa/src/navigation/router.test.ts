import { describe, expect, it, vi } from "vitest";
import { createRouter, type NavigationGuard, type RouterWindow } from "./router";
import { formatRoute, type Route } from "./routes";

const OPERATION = "7f1d2c3b-4a5e-4f60-8a7b-9c0d1e2f3a4b";

/**
 * История браузера в миниатюре: записи, позиция, `go` асинхронно с `popstate` — как в браузере,
 * где переход по истории приходит событием, а `pushState`/`replaceState` событий не шлют.
 */
class FakeBrowser implements RouterWindow {
  entries: { state: unknown; hash: string }[];
  index = 0;
  readonly history: RouterWindow["history"] & { scrollRestoration: ScrollRestoration };
  readonly location: RouterWindow["location"];
  private readonly listeners = new Set<() => void>();

  constructor(hash = "", state: unknown = null) {
    this.entries = [{ state, hash }];
    const entry = () => this.entries[this.index];
    this.location = { get hash() { return entry()?.hash ?? ""; } };
    const push = (state: unknown, url?: string | null) => {
      this.entries = this.entries.slice(0, this.index + 1);
      this.entries.push({ state: structuredClone(state), hash: url ?? this.hash });
      this.index += 1;
    };
    const replace = (state: unknown, url?: string | null) => {
      this.entries[this.index] = { state: structuredClone(state), hash: url ?? this.hash };
    };
    const go = (delta: number) => {
      const target = this.index + delta;
      if (target < 0 || target >= this.entries.length) return;
      setTimeout(() => { this.index = target; this.fire(); }, 0);
    };
    this.history = {
      scrollRestoration: "auto",
      get state() { return entry()?.state ?? null; },
      pushState: (state, _unused, url) => push(state, url),
      replaceState: (state, _unused, url) => replace(state, url),
      go,
    };
  }

  get hash(): string { return this.entries[this.index]?.hash ?? ""; }
  get hashes(): string[] { return this.entries.map((entry) => entry.hash); }

  addEventListener(_type: "popstate", listener: () => void) { this.listeners.add(listener); }
  removeEventListener(_type: "popstate", listener: () => void) { this.listeners.delete(listener); }
  fire() { for (const listener of [...this.listeners]) listener(); }

  /** Системное «Назад» или «Вперёд»: браузер сам меняет позицию и шлёт `popstate`. */
  async press(delta: number) {
    this.history.go(delta);
    await settle();
  }
  /** Адрес, набранный руками: новая запись без `state` и `popstate`. */
  async type(hash: string) {
    this.entries = this.entries.slice(0, this.index + 1);
    this.entries.push({ state: null, hash });
    this.index += 1;
    this.fire();
    await settle();
  }
}

const settle = () => new Promise<void>((resolve) => { setTimeout(resolve, 5); });

/** Черновик, который можно сделать грязным, и ответ человека на вопрос о нём. */
function draftGuard() {
  const asked: (() => void)[] = [];
  let dirty = false;
  const guard: NavigationGuard = {
    blocks: () => dirty,
    confirm: (proceed) => { asked.push(proceed); },
  };
  return {
    guard,
    asked,
    setDirty: (value: boolean) => { dirty = value; },
  };
}

function started(hash = "", state: unknown = null, extra: Partial<Parameters<typeof createRouter>[0]> = {}) {
  const frame = new FakeBrowser(hash, state);
  const router = createRouter({ window: frame, ...extra });
  const stop = router.start();
  return { frame, router, stop };
}

const go = async (router: ReturnType<typeof createRouter>, route: Route, replace = false) => {
  router.navigate(route, { replace });
  await settle();
};

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

  it("«+» кладётся поверх вкладки, с которой его нажали, и «Назад» возвращает на неё", async () => {
    const { frame, router } = started();
    await go(router, { name: "operations" });
    await go(router, { name: "entry" });
    expect(frame.hashes).toEqual(["#/", "#/operations", "#/new"]);
    await go(router, { name: "entry" });
    expect(frame.hashes).toEqual(["#/", "#/operations", "#/new"]);
    await frame.press(-1);
    expect(router.current()).toEqual({ name: "operations" });
  });

  it("правка операции — над «Операциями»; «назад» экрана закрывает её без лишней записи", async () => {
    const { frame, router } = started();
    await go(router, { name: "operations" });
    await go(router, { name: "entry", edit: OPERATION });
    expect(frame.hashes).toEqual(["#/", "#/operations", `#/new?edit=${OPERATION}`]);
    router.back();
    await settle();
    expect(router.current()).toEqual({ name: "operations" });
    expect(frame.index).toBe(1);
  });

  it("замена по просьбе меняет текущую запись и не трогает ту, что под ней", async () => {
    const { frame, router } = started();
    await go(router, { name: "more" });
    await go(router, { name: "family" });
    await go(router, { name: "import" }, true);
    expect(frame.hashes).toEqual(["#/", "#/more", "#/more/import"]);
  });

  it("перед сменой маршрута называет ключ того, с которого уходят — для прокрутки", async () => {
    const onLeave = vi.fn();
    const { frame, router } = started("", null, { onLeave });
    await go(router, { name: "operations" });
    expect(onLeave).toHaveBeenLastCalledWith("#/");
    await frame.press(-1);
    expect(onLeave).toHaveBeenLastCalledWith("#/operations");
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

describe("черновик и переходы", () => {
  it("с грязным черновиком переход спрашивает и ничего не меняет до ответа", async () => {
    const drafts = draftGuard();
    const { frame, router } = started("", null, { guard: drafts.guard });
    await go(router, { name: "entry" });
    drafts.setDirty(true);
    await go(router, { name: "more" });
    expect(drafts.asked).toHaveLength(1);
    expect(router.current()).toEqual({ name: "entry" });
    expect(frame.hashes).toEqual(["#/", "#/new"]);
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
    await go(router, { name: "entry" });
    drafts.setDirty(true);
    await frame.press(-1);
    expect(drafts.asked).toHaveLength(1);
    expect(router.current()).toEqual({ name: "entry" });
    expect(frame.hash).toBe("#/new");
    expect(frame.hashes).toEqual(["#/", "#/operations", "#/new"]);
    // «Продолжить ввод»: ничего не происходит, и следующее «Назад» снова спрашивает.
    await frame.press(-1);
    expect(drafts.asked).toHaveLength(2);
    expect(frame.hash).toBe("#/new");
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
    await go(router, { name: "entry", edit: OPERATION });
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
    await go(router, { name: "entry", edit: OPERATION });
    const states = frame.entries.map((entry) => entry.state as { stack: string[] });
    expect(states.map((state) => state.stack)).toEqual([
      ["#/"],
      ["#/", "#/operations"],
      ["#/", "#/operations", formatRoute({ name: "entry", edit: OPERATION })],
    ]);
  });
});
