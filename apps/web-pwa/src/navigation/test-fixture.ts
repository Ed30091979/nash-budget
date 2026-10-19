import { expect } from "vitest";
import { createRouter, type NavigationGuard, type RouterOptions, type RouterWindow } from "./router";
import { formatRoute, parseRoute, type Route, type RouteName } from "./routes";

/**
 * Test support for the router: a browser-like history and the facts every history entry must keep.
 * Imported by tests only — never by the app (`address-privacy.test.ts` checks it).
 */

export const OPERATION = "7f1d2c3b-4a5e-4f60-8a7b-9c0d1e2f3a4b";

/**
 * Every address form, per route. The type makes a route without fixtures a compile error; the
 * privacy test makes a query key without a fixture a test failure.
 */
export const ROUTE_FIXTURES = {
  overview: [{ name: "overview" }, { name: "overview", sheet: "entry" }],
  operations: [{ name: "operations" }, { name: "operations", sheet: "entry" }],
  reports: [{ name: "reports" }, { name: "reports", sheet: "entry" }],
  more: [{ name: "more" }, { name: "more", sheet: "entry" }],
  entry: [
    { name: "entry" },
    { name: "entry", edit: OPERATION },
    { name: "entry", sheet: "entry" },
    { name: "entry", edit: OPERATION, sheet: "entry" },
  ],
  "plan-month": [{ name: "plan-month" }, { name: "plan-month", sheet: "entry" }],
  "plan-year": [{ name: "plan-year" }, { name: "plan-year", sheet: "entry" }],
  family: [{ name: "family" }, { name: "family", sheet: "entry" }],
  import: [{ name: "import" }, { name: "import", sheet: "entry" }],
} as const satisfies { readonly [N in RouteName]: readonly Extract<Route, { readonly name: N }>[] };

export const ALL_ROUTE_FIXTURES: readonly Route[] = Object.values(ROUTE_FIXTURES).flat();

const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}";
const SHEET = "sheet=entry";

/**
 * The whole address language, written out by hand rather than derived from the grammar it checks:
 * a path, then only closed-type values — a lowercase UUID, a sheet name. No free text fits. A new
 * query key is a deliberate edit here.
 */
export const ROUTE_FRAGMENT = new RegExp(
  `^#/(?:(?:|operations|reports|more|more/(?:plan-month|plan-year|family|import))(?:\\?${SHEET})?` +
    `|new(?:\\?(?:edit=${UUID}(?:&${SHEET})?|${SHEET}))?)$`,
  "u",
);

/**
 * A browser history in miniature: entries, a position, and `go` that arrives later as `popstate`,
 * as in a browser, where `pushState`/`replaceState` fire no events.
 */
export class FakeBrowser implements RouterWindow {
  entries: { state: unknown; hash: string }[];
  index = 0;
  readonly history: RouterWindow["history"] & { scrollRestoration: ScrollRestoration };
  readonly location: RouterWindow["location"];
  private readonly listeners = new Set<() => void>();
  private readonly hashListeners = new Set<() => void>();

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

  addEventListener(type: "popstate" | "hashchange", listener: () => void) { this.listenersOf(type).add(listener); }
  removeEventListener(type: "popstate" | "hashchange", listener: () => void) { this.listenersOf(type).delete(listener); }
  private listenersOf(type: "popstate" | "hashchange") { return type === "popstate" ? this.listeners : this.hashListeners; }
  fire() { for (const listener of [...this.listeners]) listener(); }
  /** A browser that announced an anchor navigation with `hashchange` only. */
  fireHashOnly() { for (const listener of [...this.hashListeners]) listener(); }

  /** System Back or Forward: the browser moves the position itself and fires `popstate`. */
  async press(delta: number) {
    this.history.go(delta);
    await settle();
  }

  /** An address typed by hand: a new entry without `state`, then `popstate`. */
  async type(hash: string) {
    this.entries = this.entries.slice(0, this.index + 1);
    this.entries.push({ state: null, hash });
    this.index += 1;
    this.fire();
    await settle();
  }
}

export const settle = () => new Promise<void>((resolve) => { setTimeout(resolve, 5); });

/** A draft that can be made dirty, and the person's answers to the question about it. */
export function draftGuard() {
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

export function started(hash = "", state: unknown = null, extra: Partial<Omit<RouterOptions, "window">> = {}) {
  const frame = new FakeBrowser(hash, state);
  const router = createRouter({ window: frame, ...extra });
  const stop = router.start();
  return { frame, router, stop };
}

export const go = async (router: ReturnType<typeof createRouter>, route: Route, replace = false) => {
  router.navigate(route, { replace });
  await settle();
};

/** A key the router may write: a canonical route address in the address language, nothing else. */
export function isCanonicalKey(key: string): boolean {
  const parsed = parseRoute(key);
  return ROUTE_FRAGMENT.test(key) && !parsed.notFound && formatRoute(parsed.route) === key;
}

/**
 * Every entry the router wrote holds its `{ mark, stack }` and nothing else, every key is a
 * canonical route address, and the stack is exactly the addresses of the entries from the root up
 * to it — including the entries ahead of the current one, which Forward will reach.
 */
export function expectHonestHistory(frame: FakeBrowser): void {
  frame.entries.forEach((entry, index) => {
    const where = `entry ${index} (${entry.hash})`;
    expect(isCanonicalKey(entry.hash), where).toBe(true);
    expect(typeof entry.state === "object" && entry.state !== null, where).toBe(true);
    const state = entry.state as { readonly mark?: unknown; readonly stack?: unknown };
    expect(Object.keys(state).sort(), where).toEqual(["mark", "stack"]);
    expect(state.mark, where).toBe("nash-budget/route");
    expect(state.stack, where).toEqual(frame.entries.slice(0, index + 1).map((below) => below.hash));
  });
}
