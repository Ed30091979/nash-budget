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
  /* Месяц назад на «Обзоре»: зеркальная пара шеврона «вперёд». */
  "chevron-left": <path d="m15 18-6-6 6-6" />,
  /* Выбранная плитка: галочка на кольце выбора — выбор виден не только цветом. */
  check: <path d="M20 6 9 17l-5-5" />,
  /* «Закрыть» листа ввода. */
  x: <><path d="M18 6 6 18" /><path d="m6 6 12 12" /></>,
  "circle-alert": <><circle cx="12" cy="12" r="10" /><path d="M12 8v4" /><path d="M12 16h.01" /></>,
  "circle-check": <><circle cx="12" cy="12" r="10" /><path d="m9 12 2 2 4-4" /></>,
  "circle-dashed": <><path d="M10.1 2.18a9.93 9.93 0 0 1 3.8 0" /><path d="M17.6 3.71a9.95 9.95 0 0 1 2.69 2.7" /><path d="M21.82 10.1a9.93 9.93 0 0 1 0 3.8" /><path d="M20.29 17.6a9.95 9.95 0 0 1-2.7 2.69" /><path d="M13.9 21.82a9.94 9.94 0 0 1-3.8 0" /><path d="M6.4 20.29a9.95 9.95 0 0 1-2.69-2.7" /><path d="M2.18 13.9a9.93 9.93 0 0 1 0-3.8" /><path d="M3.71 6.4a9.95 9.95 0 0 1 2.7-2.69" /></>,
  download: <><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" /><path d="m7 10 5 5 5-5" /><path d="M12 15V3" /></>,
  ellipsis: <><circle cx="12" cy="12" r="1" /><circle cx="19" cy="12" r="1" /><circle cx="5" cy="12" r="1" /></>,
  "hard-drive": <><path d="M22 12H2" /><path d="M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z" /><path d="M6 16h.01" /><path d="M10 16h.01" /></>,
  house: <><path d="M15 21v-8a1 1 0 0 0-1-1h-4a1 1 0 0 0-1 1v8" /><path d="M3 10a2 2 0 0 1 .709-1.528l7-5.999a2 2 0 0 1 2.582 0l7 5.999A2 2 0 0 1 21 10v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" /></>,
  inbox: <><path d="M22 12h-6l-2 3h-4l-2-3H2" /><path d="M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z" /></>,
  "piggy-bank": <><path d="M11 17h3v2a1 1 0 0 0 1 1h2a1 1 0 0 0 1-1v-3a3.16 3.16 0 0 0 2-2h1a1 1 0 0 0 1-1v-2a1 1 0 0 0-1-1h-1a5 5 0 0 0-2-4V3a4 4 0 0 0-3.2 1.6l-.3.4H11a6 6 0 0 0-6 6v1a5 5 0 0 0 2 4v3a1 1 0 0 0 1 1h2a1 1 0 0 0 1-1z" /><path d="M16 10h.01" /><path d="M2 8v1a2 2 0 0 0 2 2h1" /></>,
  plus: <><path d="M5 12h14" /><path d="M12 5v14" /></>,
  repeat: <><path d="m17 2 4 4-4 4" /><path d="M3 11v-1a4 4 0 0 1 4-4h14" /><path d="m7 22-4-4 4-4" /><path d="M21 13v1a4 4 0 0 1-4 4H3" /></>,
  "rotate-ccw": <><path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8" /><path d="M3 3v5h5" /></>,
  /* Вся история: часы со стрелкой назад — «что уже записано», а не «вернуть» (это `rotate-ccw`). */
  history: <><path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8" /><path d="M3 3v5h5" /><path d="M12 7v5l4 2" /></>,
  /* Клавиатура суммы: клавиша стирания — та же, что на системной клавиатуре. */
  delete: <><path d="M20 5H9.5a2 2 0 0 0-1.5.7L3 12l5 6.3a2 2 0 0 0 1.5.7H20a2 2 0 0 0 2-2V7a2 2 0 0 0-2-2z" /><path d="m18 9-6 6" /><path d="m12 9 6 6" /></>,
  /* Выписка банка: чек с строками текста — документ, который читают построчно. */
  "receipt-text": <><path d="M4 2v20l2-1 2 1 2-1 2 1 2-1 2 1 2-1 2 1V2l-2 1-2-1-2 1-2-1-2 1-2-1-2 1Z" /><path d="M14 8H8" /><path d="M16 12H8" /><path d="M13 16H8" /></>,
  shield: <path d="M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z" />,
  smartphone: <><rect x="5" y="2" width="14" height="20" rx="2" /><path d="M12 18h.01" /></>,
  table: <><path d="M12 3v18" /><path d="M3 12h18" /><rect x="3" y="3" width="18" height="18" rx="2" /></>,
  target: <><circle cx="12" cy="12" r="10" /><circle cx="12" cy="12" r="6" /><circle cx="12" cy="12" r="2" /></>,
  "trash-2": <><path d="M3 6h18" /><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6" /><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" /><path d="M10 11v6" /><path d="M14 11v6" /></>,
  "triangle-alert": <><path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3" /><path d="M12 9v4" /><path d="M12 17h.01" /></>,
  upload: <><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" /><path d="m17 8-5-5-5 5" /><path d="M12 3v12" /></>,
  users: <><path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" /><circle cx="9" cy="7" r="4" /><path d="M22 21v-2a4 4 0 0 0-3-3.87" /><path d="M16 3.13a4 4 0 0 1 0 7.75" /></>,
  wallet: <><path d="M21 12V7H5a2 2 0 0 1 0-4h14v4" /><path d="M3 5v14a2 2 0 0 0 2 2h16v-5" /><path d="M18 12a2 2 0 0 0 0 4h4v-4Z" /></>,

  /* Глифы категорий (§6, карта категорий). Тот же набор Lucide, та же канва и та же толщина:
     они отличают «Продукты» от «Транспорта» в списке, а не украшают строку. */
  award: <><circle cx="12" cy="8" r="6" /><path d="m15.5 12.9 1.5 8.6a.5.5 0 0 1-.8.5l-3.6-2.7a1 1 0 0 0-1.2 0l-3.6 2.7a.5.5 0 0 1-.8-.5l1.5-8.6" /></>,
  backpack: <><path d="M4 10a4 4 0 0 1 4-4h8a4 4 0 0 1 4 4v8a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2z" /><path d="M9 6V4a2 2 0 0 1 2-2h2a2 2 0 0 1 2 2v2" /><path d="M8 21v-5a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v5" /><path d="M8 10h8" /></>,
  banknote: <><rect x="2" y="6" width="20" height="12" rx="2" /><circle cx="12" cy="12" r="2" /><path d="M6 12h.01" /><path d="M18 12h.01" /></>,
  briefcase: <><rect x="2" y="7" width="20" height="14" rx="2" /><path d="M16 21V5a2 2 0 0 0-2-2h-4a2 2 0 0 0-2 2v16" /></>,
  bus: <><path d="M4 17V8a2 2 0 0 1 2-2h12a2 2 0 0 1 1.94 1.5l1 4A2 2 0 0 1 21 12v5a1 1 0 0 1-1 1h-1" /><path d="M5 18H4a1 1 0 0 1-1-1v-5" /><path d="M3 12h18" /><path d="M8 6v6" /><path d="M15 6v6" /><circle cx="7" cy="18" r="2" /><circle cx="17" cy="18" r="2" /><path d="M9 18h6" /></>,
  car: <><path d="M19 17h2a1 1 0 0 0 1-1v-3a2 2 0 0 0-1.5-1.9L16 10l-2.2-2.3a2.4 2.4 0 0 0-1.8-.7H5a1.6 1.6 0 0 0-1.4.9l-1.4 2.9A3.7 3.7 0 0 0 2 12v4a1 1 0 0 0 1 1h2" /><circle cx="7" cy="17" r="2" /><path d="M9 17h6" /><circle cx="17" cy="17" r="2" /></>,
  "credit-card": <><rect x="2" y="5" width="20" height="14" rx="2" /><path d="M2 10h20" /><path d="M6 15h3" /></>,
  cup: <><path d="M17 8h1a4 4 0 1 1 0 8h-1" /><path d="M3 8h14v9a4 4 0 0 1-4 4H7a4 4 0 0 1-4-4z" /><path d="M6 2v2" /><path d="M10 2v2" /><path d="M14 2v2" /></>,
  dumbbell: <><path d="M6.5 6.5 17.5 17.5" /><path d="m3 8 1.5-1.5a2.1 2.1 0 0 1 3 0l2 2a2.1 2.1 0 0 1 0 3L8 13" /><path d="M2 7.5 4.5 5" /><path d="m21 16-1.5 1.5a2.1 2.1 0 0 1-3 0l-2-2a2.1 2.1 0 0 1 0-3L16 11" /><path d="m19.5 19 2.5-2.5" /></>,
  gift: <><rect x="3" y="8" width="18" height="4" rx="1" /><path d="M12 8v13" /><path d="M19 12v7a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2v-7" /><path d="M7.5 8a2.5 2.5 0 0 1 0-5C10 3 12 5.5 12 8c0-2.5 2-5 4.5-5a2.5 2.5 0 0 1 0 5" /></>,
  "graduation-cap": <><path d="M21.4 10.9a1 1 0 0 0 0-1.8L12.8 5.2a2 2 0 0 0-1.6 0L2.6 9.1a1 1 0 0 0 0 1.8l8.6 3.9a2 2 0 0 0 1.6 0z" /><path d="M22 10v6" /><path d="M6 12.5V16a6 3 0 0 0 12 0v-3.5" /></>,
  heart: <><path d="M19 14c1.5-1.5 3-3.2 3-5.5A5.5 5.5 0 0 0 16.5 3c-1.8 0-3 .5-4.5 2-1.5-1.5-2.7-2-4.5-2A5.5 5.5 0 0 0 2 8.5c0 2.3 1.5 4 3 5.5l7 7z" /></>,
  lamp: <><path d="M8 2h8l4 10H4z" /><path d="M12 12v6" /><path d="M8 22v-2a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2z" /></>,
  landmark: <><path d="m12 3 8 5H4z" /><path d="M6 18v-7" /><path d="M10 18v-7" /><path d="M14 18v-7" /><path d="M18 18v-7" /><path d="M3 21h18" /></>,
  "paw-print": <><circle cx="11" cy="4" r="2" /><circle cx="18" cy="8" r="2" /><circle cx="20" cy="16" r="2" /><path d="M9 10a5 5 0 0 1 5 5v3.5a3.5 3.5 0 0 1-6.8 1Q6.5 17.5 4.5 16.8A3.5 3.5 0 0 1 5.5 10z" /></>,
  percent: <><path d="M19 5 5 19" /><circle cx="6.5" cy="6.5" r="2.5" /><circle cx="17.5" cy="17.5" r="2.5" /></>,
  pill: <><path d="m10.5 20.5 10-10a5 5 0 0 0-7-7l-10 10a5 5 0 0 0 7 7z" /><path d="m8.5 8.5 7 7" /></>,
  plane: <><path d="M17.8 19.2 16 11l3.5-3.5C21 6 21.5 4 21 3c-1-.5-3 0-4.5 1.5L13 8 4.8 6.2a1 1 0 0 0-1.1.5l-.3.5a1 1 0 0 0 .3 1.3L9 12l-2 3H4l-1 1 3 2 2 3 1-1v-3l3-2 3.5 5.3a1 1 0 0 0 1.3.3l.5-.2a1 1 0 0 0 .5-1.2z" /></>,
  shirt: <><path d="M20.4 3.5 16 2a4 4 0 0 1-8 0L3.6 3.5a2 2 0 0 0-1.3 2.2l.6 3.5a1 1 0 0 0 1 .8H6v10a2 2 0 0 0 2 2h8a2 2 0 0 0 2-2V10h2.1a1 1 0 0 0 1-.8l.6-3.5a2 2 0 0 0-1.3-2.2z" /></>,
  "shopping-basket": <><path d="m5 11 3-7" /><path d="m19 11-3-7" /><path d="M2 11h20" /><path d="m4 11 1.5 8a2 2 0 0 0 2 1.6h9a2 2 0 0 0 2-1.6L20 11" /><path d="M10 15v3" /><path d="M14 15v3" /></>,
  sparkles: <><path d="M9.9 15.5A2 2 0 0 0 8.5 14.1l-6.1-1.6a.5.5 0 0 1 0-1l6.1-1.6A2 2 0 0 0 9.9 8.5l1.6-6.1a.5.5 0 0 1 1 0l1.6 6.1a2 2 0 0 0 1.4 1.4l6.1 1.6a.5.5 0 0 1 0 1l-6.1 1.6a2 2 0 0 0-1.4 1.4l-1.6 6.1a.5.5 0 0 1-1 0z" /><path d="M20 3v4" /><path d="M22 5h-4" /><path d="M4 17v2" /><path d="M5 18H3" /></>,
  sprout: <><path d="M7 20h10" /><path d="M10 20c5.5-2.5.8-6.4 3-10" /><path d="M9.5 9.4c1.1.8 1.8 2.2 2.3 3.7-2.3.5-4.1.4-5.2-.4-1.1-.8-1.8-2.2-2.3-3.7 2.3-.5 4.1-.4 5.2.4" /><path d="M14.1 6a7 7 0 0 0-1.1 4c1.9-.1 3.3-.6 4.3-1.4 1-1 1.6-2.3 1.7-4.6-2.7.1-4 1-4.9 2" /></>,
  tag: <><path d="M12.6 2.6A2 2 0 0 0 11.2 2H4a2 2 0 0 0-2 2v7.2a2 2 0 0 0 .6 1.4l8.7 8.7a2.4 2.4 0 0 0 3.4 0l6.6-6.6a2.4 2.4 0 0 0 0-3.4z" /><path d="M7.5 7.5h.01" /></>,
  ticket: <><path d="M2 9a3 3 0 0 1 0 6v2a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-2a3 3 0 0 1 0-6V7a2 2 0 0 0-2-2H4a2 2 0 0 0-2 2z" /><path d="M13 5v2" /><path d="M13 11v2" /><path d="M13 17v2" /></>,
  "trending-up": <><path d="M16 7h6v6" /><path d="m22 7-8.5 8.5-5-5L2 17" /></>,
  wifi: <><path d="M12 20h.01" /><path d="M2 8.8a15 15 0 0 1 20 0" /><path d="M5 12.9a10 10 0 0 1 14 0" /><path d="M8.5 16.4a5 5 0 0 1 7 0" /></>,
  wine: <><path d="M8 22h8" /><path d="M12 15v7" /><path d="M6.4 3h11.2l-.9 6.3a5.4 5.4 0 0 1-10.7 0z" /><path d="M6 9h12" /></>,
  wrench: <><path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.8-3.8a6 6 0 0 1-7.9 7.9l-6.9 6.9a2.1 2.1 0 0 1-3-3l6.9-6.9a6 6 0 0 1 7.9-7.9z" /></>,
  zap: <><path d="M4 14a1 1 0 0 1-.8-1.6l9.9-10.2a.5.5 0 0 1 .9.5l-1.9 6a1 1 0 0 0 .9 1.3h7a1 1 0 0 1 .8 1.6l-9.9 10.2a.5.5 0 0 1-.9-.5l1.9-6a1 1 0 0 0-.9-1.3z" /></>,
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
