import type { ReactElement } from "react";

/**
 * §6 документа дизайна: иконки — только инлайн-SVG, контурные, штрих 1.75, скруглённые
 * концы, размер 20/24/32; текстовые глифы и эмодзи в роли иконок запрещены.
 *
 * Глифы перерисованы по набору Lucide (лицензия ISC, https://lucide.dev), канва 24×24.
 * Набор лежит внутри сборки спрайтом и не запрашивает ничего из сети: §1.5 требует работы
 * без сети, а CSP и релизный скан не пропустят внешний источник иконок.
 *
 * Спрайт — один `<svg>` со `<symbol>`, компонент — тонкий `<use>` по имени. Цвет, толщина
 * и скругления задаются на самом `<use>`-элементе, а не внутри спрайта: клон наследует
 * оформление от места вставки, а не от места объявления.
 */

const ICON_ID_PREFIX = "glyph-";

const GLYPHS = {
  "arrow-left": <><path d="M19 12H5" /><path d="m12 19-7-7 7-7" /></>,
  "arrow-left-right": <><path d="M8 3 4 7l4 4" /><path d="M4 7h16" /><path d="m16 21 4-4-4-4" /><path d="M20 17H4" /></>,
  "arrow-down-left": <><path d="M17 7 7 17" /><path d="M17 17H7V7" /></>,
  "arrow-up-right": <><path d="M7 7h10v10" /><path d="M7 17 17 7" /></>,
  calendar: <><rect x="3" y="4" width="18" height="18" rx="2" /><path d="M16 2v4" /><path d="M8 2v4" /><path d="M3 10h18" /></>,
  "calendar-clock": <><path d="M21 7.5V6a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h3.5" /><path d="M16 2v4" /><path d="M8 2v4" /><path d="M3 10h5" /><circle cx="16" cy="16" r="6" /><path d="M16 14v2l1 1" /></>,
  "chevron-right": <path d="m9 18 6-6-6-6" />,
  "circle-alert": <><circle cx="12" cy="12" r="10" /><path d="M12 8v4" /><path d="M12 16h.01" /></>,
  "circle-check": <><circle cx="12" cy="12" r="10" /><path d="m9 12 2 2 4-4" /></>,
  "circle-dashed": <><path d="M10.1 2.18a9.93 9.93 0 0 1 3.8 0" /><path d="M17.6 3.71a9.95 9.95 0 0 1 2.69 2.7" /><path d="M21.82 10.1a9.93 9.93 0 0 1 0 3.8" /><path d="M20.29 17.6a9.95 9.95 0 0 1-2.7 2.69" /><path d="M13.9 21.82a9.94 9.94 0 0 1-3.8 0" /><path d="M6.4 20.29a9.95 9.95 0 0 1-2.69-2.7" /><path d="M2.18 13.9a9.93 9.93 0 0 1 0-3.8" /><path d="M3.71 6.4a9.95 9.95 0 0 1 2.7-2.69" /></>,
  "circle-plus": <><circle cx="12" cy="12" r="10" /><path d="M8 12h8" /><path d="M12 8v8" /></>,
  download: <><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" /><path d="m7 10 5 5 5-5" /><path d="M12 15V3" /></>,
  ellipsis: <><circle cx="12" cy="12" r="1" /><circle cx="19" cy="12" r="1" /><circle cx="5" cy="12" r="1" /></>,
  "hard-drive": <><path d="M22 12H2" /><path d="M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z" /><path d="M6 16h.01" /><path d="M10 16h.01" /></>,
  house: <><path d="M15 21v-8a1 1 0 0 0-1-1h-4a1 1 0 0 0-1 1v8" /><path d="M3 10a2 2 0 0 1 .709-1.528l7-5.999a2 2 0 0 1 2.582 0l7 5.999A2 2 0 0 1 21 10v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" /></>,
  inbox: <><path d="M22 12h-6l-2 3h-4l-2-3H2" /><path d="M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z" /></>,
  "piggy-bank": <><path d="M11 17h3v2a1 1 0 0 0 1 1h2a1 1 0 0 0 1-1v-3a3.16 3.16 0 0 0 2-2h1a1 1 0 0 0 1-1v-2a1 1 0 0 0-1-1h-1a5 5 0 0 0-2-4V3a4 4 0 0 0-3.2 1.6l-.3.4H11a6 6 0 0 0-6 6v1a5 5 0 0 0 2 4v3a1 1 0 0 0 1 1h2a1 1 0 0 0 1-1z" /><path d="M16 10h.01" /><path d="M2 8v1a2 2 0 0 0 2 2h1" /></>,
  plus: <><path d="M5 12h14" /><path d="M12 5v14" /></>,
  repeat: <><path d="m17 2 4 4-4 4" /><path d="M3 11v-1a4 4 0 0 1 4-4h14" /><path d="m7 22-4-4 4-4" /><path d="M21 13v1a4 4 0 0 1-4 4H3" /></>,
  "rotate-ccw": <><path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8" /><path d="M3 3v5h5" /></>,
  shield: <path d="M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z" />,
  smartphone: <><rect x="5" y="2" width="14" height="20" rx="2" /><path d="M12 18h.01" /></>,
  table: <><path d="M12 3v18" /><path d="M3 12h18" /><rect x="3" y="3" width="18" height="18" rx="2" /></>,
  target: <><circle cx="12" cy="12" r="10" /><circle cx="12" cy="12" r="6" /><circle cx="12" cy="12" r="2" /></>,
  "trash-2": <><path d="M3 6h18" /><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6" /><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" /><path d="M10 11v6" /><path d="M14 11v6" /></>,
  "triangle-alert": <><path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3" /><path d="M12 9v4" /><path d="M12 17h.01" /></>,
  upload: <><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" /><path d="m17 8-5-5-5 5" /><path d="M12 3v12" /></>,
  users: <><path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" /><circle cx="9" cy="7" r="4" /><path d="M22 21v-2a4 4 0 0 0-3-3.87" /><path d="M16 3.13a4 4 0 0 1 0 7.75" /></>,
  wallet: <><path d="M21 12V7H5a2 2 0 0 1 0-4h14v4" /><path d="M3 5v14a2 2 0 0 0 2 2h16v-5" /><path d="M18 12a2 2 0 0 0 0 4h4v-4Z" /></>,
} satisfies Readonly<Record<string, ReactElement>>;

export type IconName = keyof typeof GLYPHS;

export const ICON_NAMES = Object.keys(GLYPHS) as readonly IconName[];

/**
 * Спрайт монтируется по одному разу на корень маршрута. Он ничего не рисует сам: нулевой
 * размер и `aria-hidden` держат его вне потока и вне дерева доступности.
 */
export function IconSprite() {
  return (
    <svg className="icon-sprite" aria-hidden="true" focusable="false" xmlns="http://www.w3.org/2000/svg">
      {ICON_NAMES.map((name) => (
        <symbol key={name} id={`${ICON_ID_PREFIX}${name}`} viewBox="0 0 24 24">{GLYPHS[name]}</symbol>
      ))}
    </svg>
  );
}

export interface IconProps {
  readonly name: IconName;
  /** §6: разрешённые размеры иконки. */
  readonly size?: 20 | 24 | 32;
  /**
   * Доступное имя. Без него иконка декоративная и скрыта от читающих с экрана — так и
   * должно быть везде, где рядом стоит текст. §9: иконка не бывает единственным носителем
   * смысла, поэтому имя нужно только там, где текста рядом нет.
   */
  readonly label?: string;
  readonly className?: string;
}

export function Icon({ name, size = 24, label, className }: IconProps) {
  const naming = label === undefined
    ? ({ "aria-hidden": true } as const)
    : ({ role: "img", "aria-label": label } as const);
  return (
    <svg
      className={className ? `icon ${className}` : "icon"}
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.75"
      strokeLinecap="round"
      strokeLinejoin="round"
      focusable="false"
      {...naming}
    >
      <use href={`#${ICON_ID_PREFIX}${name}`} />
    </svg>
  );
}
