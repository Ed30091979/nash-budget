import { useSyncExternalStore } from "react";
import { Icon } from "../../components/Icon";
import type { KeypadKey } from "./amount-expression";

/**
 * Когда клавиатуры суммы на экране нет и поле зовёт системную.
 *
 * Одно условие на присутствие клавиш и на `inputmode` поля — иначе они разошлись бы: клавиши
 * спрятаны, а системная клавиатура не поднимается, и сумму набрать нечем.
 *
 * Крупный шрифт узнаётся в кеглях, как в §5 (`max-width: 18em`): при ×2.7 четыре ряда клавиш,
 * кнопка записи и навигация вместе выше любого телефона — 304 + 200 + 188 + 79 на 320×568 — и
 * своя клавиатура закрывала бы табло навсегда, а системная хотя бы уходит по «Готово». Короткий
 * экран (`max-height: 34em` — телефон в альбоме: 375 и 390 pt) — то же самое при обычном кегле.
 */
export const KEYPAD_HIDDEN_MEDIA = "(max-width: 18em), (max-height: 34em)";

/** Помещается ли клавиатура сейчас: снимок `useKeypadAvailable`. */
export function keypadFits(): boolean {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return true;
  // Считается заново на каждом снимке: список медиазапросов, заведённый раньше, после смены кегля
  // держит устаревшее `matches`.
  return !window.matchMedia(KEYPAD_HIDDEN_MEDIA).matches;
}

/**
 * Невидимая метка размером 1em × 1em в кегле по умолчанию (`font-size: medium`): от него считаются
 * `em` в {@link KEYPAD_HIDDEN_MEDIA}, и метка меняет размер ровно тогда, когда он меняется.
 */
function emSentinel(): HTMLElement {
  const sentinel = document.createElement("span");
  sentinel.setAttribute("aria-hidden", "true");
  sentinel.dataset.keypadSentinel = "";
  for (const [property, value] of [
    ["position", "fixed"],
    ["top", "0"],
    ["left", "0"],
    ["width", "1em"],
    ["height", "1em"],
    ["font-size", "medium"],
    ["visibility", "hidden"],
    ["pointer-events", "none"],
    ["overflow", "hidden"],
  ] as const) {
    sentinel.style.setProperty(property, value);
  }
  return sentinel;
}

/**
 * Когда пересчитать, помещается ли клавиатура.
 *
 * `change` у списка медиазапросов не приходит, когда меняется только кегль по умолчанию, — а от
 * него считаются `em`. Список тогда держит устаревшее `matches`, и следующий поворот экрана, «не
 * меняющий» его, тоже проходит молча. Окно слушается напрямую (`resize`), но смена кегля без смены
 * размера окна — системная настройка шрифта, вернувшаяся к обычной, — не двигает и его: клавиатура
 * не возвращалась (третье ревью, e2e). Поэтому кегль наблюдается сам — меткой в `em` под
 * `ResizeObserver`, — а снимок каждый раз заново спрашивает `matchMedia`.
 */
export function subscribeKeypadFit(onChange: () => void): () => void {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return () => undefined;
  const query = window.matchMedia(KEYPAD_HIDDEN_MEDIA);
  query.addEventListener("change", onChange);
  window.addEventListener("resize", onChange);
  let sentinel: HTMLElement | null = null;
  let observer: ResizeObserver | null = null;
  if (typeof ResizeObserver === "function" && typeof document !== "undefined" && document.body) {
    sentinel = emSentinel();
    document.body.appendChild(sentinel);
    observer = new ResizeObserver(() => onChange());
    observer.observe(sentinel);
  }
  return () => {
    query.removeEventListener("change", onChange);
    window.removeEventListener("resize", onChange);
    observer?.disconnect();
    sentinel?.remove();
  };
}

export function useKeypadAvailable(): boolean {
  return useSyncExternalStore(subscribeKeypadFit, keypadFits, () => true);
}

interface KeyDefinition {
  readonly key: KeypadKey;
  /** Имя для читающего с экрана там, где глиф или знак сам себя не называет. */
  readonly label?: string;
  readonly className?: string;
}

/** Как у калькулятора: цифры слева, знаки правым столбцом, ноль шире. «=» нет — это кнопка записи. */
const KEYS: readonly KeyDefinition[] = [
  { key: "1" }, { key: "2" }, { key: "3" }, { key: "backspace", label: "Стереть", className: "key-op" },
  { key: "4" }, { key: "5" }, { key: "6" }, { key: "+", label: "Плюс", className: "key-op" },
  { key: "7" }, { key: "8" }, { key: "9" }, { key: "−", label: "Минус", className: "key-op" },
  { key: "0", className: "key-wide" }, { key: ",", label: "Запятая" }, { key: "÷", label: "Разделить", className: "key-op" },
];

/**
 * Клавиатура суммы — часть экрана, а не панель системы поверх него (§6).
 *
 * Клавиша — обычная кнопка с именем; нажатие не уводит фокус из поля (`mousedown` без действия
 * по умолчанию), поэтому цифра встаёт в каретку, а физическая клавиатура после касания клавиши
 * продолжает набирать в то же поле.
 */
export function Keypad({ onKey, disabled = false }: { readonly onKey: (key: KeypadKey) => void; readonly disabled?: boolean }) {
  return <div className="keypad" role="group" aria-label="Клавиатура суммы">
    {KEYS.map(({ key, label, className }) => <button
      key={key}
      type="button"
      className={className}
      disabled={disabled}
      aria-label={label}
      onMouseDown={(event) => event.preventDefault()}
      onClick={() => onKey(key)}
    >{key === "backspace" ? <Icon name="delete" size={24} /> : key}</button>)}
  </div>;
}
