/**
 * Клавиатура суммы узнаёт о смене кегля по умолчанию, даже когда окно не меняет размер.
 *
 * Третье ревью, e2e: после возврата к обычному кеглю без `resize` клавиатура не возвращалась —
 * `matchMedia(...).change` о кегле не сообщает, а окно не двигалось. Здесь подписка проверяется с
 * поддельными `matchMedia`, `ResizeObserver` и документом: метка в `em` наблюдается, её изменение
 * зовёт пересчёт, снимок каждый раз заново спрашивает `matchMedia`, а отписка убирает всё.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

import { keypadFits, KEYPAD_HIDDEN_MEDIA, subscribeKeypadFit } from "./Keypad";

class FakeResizeObserver {
  static instances: FakeResizeObserver[] = [];
  readonly observed: unknown[] = [];
  disconnected = false;
  constructor(readonly callback: () => void) {
    FakeResizeObserver.instances.push(this);
  }
  observe(target: unknown): void {
    this.observed.push(target);
  }
  disconnect(): void {
    this.disconnected = true;
  }
}

interface FakeElement {
  readonly attributes: Map<string, string>;
  readonly style: Map<string, string>;
  removed: boolean;
}

/** A document that hands out elements whose attributes and inline style can be read back. */
function fakeDocument(): { readonly document: unknown; readonly created: FakeElement[] } {
  const created: FakeElement[] = [];
  const document = {
    body: { appendChild: (element: unknown) => element },
    createElement: () => {
      const element: FakeElement = { attributes: new Map(), style: new Map(), removed: false };
      created.push(element);
      return {
        dataset: {},
        setAttribute: (name: string, value: string) => element.attributes.set(name, value),
        style: { setProperty: (name: string, value: string) => element.style.set(name, value) },
        remove: () => {
          element.removed = true;
        },
      };
    },
  };
  return { document, created };
}

afterEach(() => {
  vi.unstubAllGlobals();
  FakeResizeObserver.instances = [];
});

describe("подписка клавиатуры суммы на кегль", () => {
  it("наблюдает метку в em и пересчитывает снимок по её изменению, а отписка убирает и метку, и наблюдателя", () => {
    let matches = true;
    const queries: string[] = [];
    const listeners = new Map<string, () => void>();
    const { document, created } = fakeDocument();
    vi.stubGlobal("ResizeObserver", FakeResizeObserver);
    vi.stubGlobal("window", {
      matchMedia: (query: string) => {
        queries.push(query);
        return { get matches() { return matches; }, addEventListener: vi.fn(), removeEventListener: vi.fn() };
      },
      addEventListener: (type: string, listener: () => void) => listeners.set(type, listener),
      removeEventListener: (type: string) => listeners.delete(type),
    });
    vi.stubGlobal("document", document);

    const onChange = vi.fn();
    const unsubscribe = subscribeKeypadFit(onChange);
    expect(queries).toEqual([KEYPAD_HIDDEN_MEDIA]);
    expect(listeners.has("resize")).toBe(true);
    // One sentinel, hidden from reading, sized in the default font size, and observed.
    expect(created).toHaveLength(1);
    const sentinel = created[0]!;
    expect(sentinel.attributes.get("aria-hidden")).toBe("true");
    expect(Object.fromEntries(sentinel.style)).toMatchObject({
      position: "fixed", width: "1em", height: "1em", "font-size": "medium", visibility: "hidden", "pointer-events": "none",
    });
    expect(FakeResizeObserver.instances).toHaveLength(1);
    expect(FakeResizeObserver.instances[0]!.observed).toHaveLength(1);

    // The default font size changes and nothing else does: the sentinel resizes, and that alone
    // asks for a fresh snapshot.
    expect(keypadFits()).toBe(false);
    matches = false;
    FakeResizeObserver.instances[0]!.callback();
    expect(onChange).toHaveBeenCalledTimes(1);
    // The snapshot asks matchMedia afresh rather than reading the list made at subscription.
    expect(keypadFits()).toBe(true);
    expect(queries).toEqual([KEYPAD_HIDDEN_MEDIA, KEYPAD_HIDDEN_MEDIA, KEYPAD_HIDDEN_MEDIA]);

    unsubscribe();
    expect(FakeResizeObserver.instances[0]!.disconnected).toBe(true);
    expect(sentinel.removed).toBe(true);
    expect(listeners.has("resize")).toBe(false);
  });

  it("без ResizeObserver подписка остаётся на resize и change, как прежде", () => {
    vi.stubGlobal("ResizeObserver", undefined);
    const listeners = new Map<string, () => void>();
    const query = { matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() };
    vi.stubGlobal("window", {
      matchMedia: () => query,
      addEventListener: (type: string, listener: () => void) => listeners.set(type, listener),
      removeEventListener: (type: string) => listeners.delete(type),
    });
    vi.stubGlobal("document", fakeDocument().document);
    const unsubscribe = subscribeKeypadFit(vi.fn());
    expect(query.addEventListener).toHaveBeenCalledWith("change", expect.any(Function));
    expect(listeners.has("resize")).toBe(true);
    unsubscribe();
    expect(query.removeEventListener).toHaveBeenCalledWith("change", expect.any(Function));
  });
});
