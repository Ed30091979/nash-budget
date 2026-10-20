import { useLayoutEffect, useRef, type FormEvent, type KeyboardEvent, type ReactNode } from "react";
import { handleDialogKeyboard } from "../features/data-management/dialog-accessibility";
import { Icon } from "./Icon";

/**
 * Узел, который диалог выключает вокруг себя, — то, что `isolateOutside` трогает и возвращает.
 */
interface IsolationNode {
  readonly parentElement: IsolationNode | null;
  readonly children: ArrayLike<unknown>;
  readonly tagName?: string;
  getAttribute(name: string): string | null;
  hasAttribute(name: string): boolean;
  setAttribute(name: string, value: string): void;
  removeAttribute(name: string): void;
}

/**
 * Выключает всё вокруг листа, а не только соседей: шапку, нижнюю навигацию, экран под листом, тост.
 * Лист справочника рисуется внутри экрана маршрута, поэтому соседи берутся на каждом уровне — от
 * листа до `<body>`: каждый, кто не лежит на пути к листу, получает `inert` и `aria-hidden`.
 * Возвращает уборку: атрибуты встают такими, какими были.
 */
export function isolateOutside(element: IsolationNode): () => void {
  const changed: { readonly node: IsolationNode; readonly inert: boolean; readonly hidden: string | null }[] = [];
  let node: IsolationNode = element;
  while (node.parentElement !== null && node.tagName !== "BODY") {
    const holder: IsolationNode = node.parentElement;
    for (const sibling of Array.from(holder.children) as IsolationNode[]) {
      if (sibling === node || sibling.tagName === "SCRIPT" || sibling.tagName === "STYLE") continue;
      changed.push({ node: sibling, inert: sibling.hasAttribute("inert"), hidden: sibling.getAttribute("aria-hidden") });
      sibling.setAttribute("inert", "");
      sibling.setAttribute("aria-hidden", "true");
    }
    node = holder;
  }
  return () => {
    for (const { node: sibling, inert, hidden } of changed) {
      if (!inert) sibling.removeAttribute("inert");
      if (hidden === null) sibling.removeAttribute("aria-hidden");
      else sibling.setAttribute("aria-hidden", hidden);
    }
  };
}

export interface FormSheetProps {
  /** Основа идентификаторов: заголовок — `id-title`. */
  readonly id: string;
  readonly title: ReactNode;
  /**
   * Лист маршрута (`#/more/accounts/<id>`) называет экран — его заголовок `h1`, и оболочка ставит на
   * него фокус после перехода; лист поверх экрана (метка) — `h2` под `h1` экрана.
   */
  readonly titleLevel?: 1 | 2;
  /** Крестик и Esc. Набранное спрашивает тот, кто лист открыл: маршрут — реестр черновиков, экран — свой вопрос. */
  readonly onClose: () => void;
  readonly closeLabel?: string;
  /** Запись идёт: Esc молчит, крестик говорит «нет». */
  readonly busy?: boolean;
  /** Лист — форма: Enter в поле отправляет её, «Сохранить» в подвале — `type="submit"`. */
  readonly onSubmit?: () => void;
  /** Подвал, закреплённый внизу: «Сохранить» акцентом. */
  readonly footer?: ReactNode;
  /** Куда поставить фокус при открытии: `id` поля; без него — на заголовок. */
  readonly initialFocus?: string;
  readonly describedBy?: string;
  readonly className?: string;
  readonly children: ReactNode;
}

/**
 * Лист справочника с разделами (дизайн 5.0, макеты 12 и 13): во всю ширину телефона, скруглён
 * сверху, «Закрыть» 48 слева, заголовок по центру, тело прокручивается, подвал с «Сохранить»
 * закреплён внизу. Модальный диалог (`aria-modal`, контракт `modal-presence.ts`): всё вокруг
 * выключено (`isolateOutside`), Tab ходит по кругу внутри листа, Esc — то же, что крестик.
 * Разрушающее действие стоит последним в теле листа, а не в подвале.
 */
export function FormSheet({ id, title, titleLevel = 2, onClose, closeLabel = "Закрыть", busy = false, onSubmit, footer, initialFocus, describedBy, className, children }: FormSheetProps) {
  const backdropRef = useRef<HTMLDivElement>(null);
  const dialogRef = useRef<HTMLElement>(null);
  const headingRef = useRef<HTMLHeadingElement>(null);

  useLayoutEffect(() => {
    const backdrop = backdropRef.current;
    const restore = backdrop === null ? () => undefined : isolateOutside(backdrop);
    const first = initialFocus === undefined ? null : document.getElementById(initialFocus);
    (first ?? headingRef.current)?.focus({ preventScroll: true });
    return restore;
    // Once per opening: the focus target is the one the sheet opened with.
  }, []);

  const close = () => {
    if (!busy) onClose();
  };
  const Heading = titleLevel === 1 ? "h1" : "h2";
  const body = <>
    <div className="dir-sheet-body">{children}</div>
    {footer === undefined ? null : <div className="dir-sheet-foot">{footer}</div>}
  </>;
  return (
    <div ref={backdropRef} className="sheet-backdrop dir-backdrop" role="presentation">
      <section
        ref={dialogRef}
        className={className === undefined ? "sheet dir-sheet" : `sheet dir-sheet ${className}`}
        role="dialog"
        aria-modal="true"
        aria-labelledby={`${id}-title`}
        aria-describedby={describedBy}
        aria-busy={busy || undefined}
        tabIndex={-1}
        onKeyDown={(event: KeyboardEvent<HTMLElement>) => {
          const sheet = dialogRef.current;
          // События вопроса приложения (портал) всплывают по дереву React и сюда: его клавиши — его.
          if (sheet === null || !(event.target instanceof Node) || !sheet.contains(event.target)) return;
          handleDialogKeyboard(event, sheet, !busy, onClose);
        }}
      >
        <span className="q-grab" aria-hidden="true" />
        <header className="dir-sheet-head">
          <button className="icon-button" type="button" aria-label={closeLabel} aria-disabled={busy || undefined} onClick={close}>
            <Icon name="x" size={24} />
          </button>
          <Heading id={`${id}-title`} ref={headingRef} tabIndex={-1}>{title}</Heading>
          <span className="dir-sheet-end" aria-hidden="true" />
        </header>
        {onSubmit === undefined ? body : (
          <form className="dir-sheet-form" noValidate onSubmit={(event: FormEvent) => { event.preventDefault(); onSubmit(); }}>
            {body}
          </form>
        )}
      </section>
    </div>
  );
}
