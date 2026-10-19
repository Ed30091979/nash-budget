import { useCallback, useEffect, useReducer, useRef } from "react";

/**
 * Фокус после действия на месте — туда, где действие продолжается (ревью 2c, MEDIUM-3). Нажатая
 * кнопка часто исчезает вместе с тем, что она сделала: «Убрать в архив» сменяется «Вернуть из
 * архива», строка метки — полем переименования, панель курса закрывается. Без этого фокус падает
 * на `<body>`: читалка экрана теряет место, а клавиатура начинает со шапки страницы.
 *
 * `focusAfterRender(id)` запоминает цель — `id` элемента или селектор (`{ selector }`: плитка
 * называется своим `data-tile`) — и ставит на неё фокус после ближайшей отрисовки, в которой она
 * есть: запись бюджета приходит отрисовкой позже, чем кончился её `await`, и цель может появиться
 * не сразу. Заголовок получает `tabindex="-1"` — фокус на нём программный, в обход клавиатурного
 * порядка.
 */
export type FocusTarget = string | { readonly selector: string };

export function useFocusAfterRender(): (target: FocusTarget) => void {
  const pending = useRef<FocusTarget | null>(null);
  const [, rerender] = useReducer((count: number) => count + 1, 0);
  useEffect(() => {
    const wanted = pending.current;
    if (wanted === null) return;
    const target = typeof wanted === "string" ? document.getElementById(wanted) : document.querySelector<HTMLElement>(wanted.selector);
    if (target === null) return;
    pending.current = null;
    focusElement(target);
  });
  return useCallback((target: FocusTarget) => {
    pending.current = target;
    rerender();
  }, []);
}

/** Фокус на элемент; у того, что фокуса сам не принимает (заголовок), — программный. */
export function focusElement(target: HTMLElement): void {
  if (target.tabIndex < 0 && !target.hasAttribute("tabindex")) target.setAttribute("tabindex", "-1");
  target.focus({ preventScroll: false });
}
