import type { ReactNode, Ref } from "react";
import { Icon } from "./Icon";

/**
 * «Назад» строки заголовка: видимая подпись — родитель экрана («Ещё», «Счета»), шеврон — украшение.
 *
 * Доступное имя по умолчанию — «Назад: {подпись}»: видимое слово стоит в нём целиком (WCAG 2.5.3), а
 * от вкладки «Ещё» нижней навигации кнопка отличается и на слух. `name` — для «назад», который ведёт
 * не к родителю, а к шагу самого экрана («Другой файл» в выписке): тогда имя — ровно подпись.
 */
export interface TitleBarBack {
  readonly label: string;
  readonly onClick: () => void;
  readonly name?: string;
}

export interface TitleBarProps {
  readonly back: TitleBarBack;
  /** Заголовок экрана — `h1` маршрута: на него оболочка ставит фокус после перехода (DESIGN §9). */
  readonly title: ReactNode;
  readonly titleId?: string;
  readonly titleRef?: Ref<HTMLHeadingElement>;
  /** Экран сам переводит фокус на заголовок (смена стадии выписки): `tabIndex=-1` сразу в разметке. */
  readonly titleFocusable?: boolean;
  /** Одно действие справа: кнопка-иконка 48 с доступным именем (`TitleBarAction`). */
  readonly action?: ReactNode;
}

/**
 * Строка заголовка подэкрана (DESIGN 5.0 §6, макеты v5 §d): «‹ Родитель · Заголовок · действие».
 * Заменяет кнопку-рамку «К разделу «Ещё»» со стрелкой и шапку «Наш бюджет»: одна строка 52 вместо двух.
 * В iOS-standalone другой кнопки «назад» нет, поэтому она есть на каждом подэкране.
 */
export function TitleBar({ back, title, titleId, titleRef, titleFocusable, action }: TitleBarProps) {
  return (
    <header className="title-bar">
      <button className="title-bar-back" type="button" aria-label={back.name} onClick={back.onClick}>
        <Icon name="chevron-left" size={24} />
        {back.name === undefined ? <span><span className="visually-hidden">Назад: </span>{back.label}</span> : <span>{back.label}</span>}
      </button>
      <h1 id={titleId} ref={titleRef} tabIndex={titleFocusable ? -1 : undefined}>{title}</h1>
      <div className="title-bar-action">{action ?? null}</div>
    </header>
  );
}

/** Действие строки заголовка: глиф 24 в цели 48, имя — словами (иконка не бывает единственным носителем смысла). */
export function TitleBarAction({ icon, label, onClick, disabled, id }: {
  readonly icon: "plus" | "pencil";
  readonly label: string;
  readonly onClick: () => void;
  readonly disabled?: boolean;
  /** Куда вернуть фокус, когда то, что действие открыло, закрылось («+» курсов, R3). */
  readonly id?: string;
}) {
  return (
    <button id={id} className="icon-button" type="button" aria-label={label} disabled={disabled} onClick={onClick}>
      <Icon name={icon} size={24} />
    </button>
  );
}
