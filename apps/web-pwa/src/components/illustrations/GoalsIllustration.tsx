import type { SVGProps } from "react";

/**
 * Столбцы, растущие к флажку цели.
 *
 * Иллюстрация v5 (DIRECTION §f): контур тёплыми чернилами 2,5, пастель палитры, ровно одна
 * коралловая деталь. Декоративна — смысл несёт текст рядом, — поэтому скрыта от читающих с экрана.
 * Источник: `design-v5/illustrations/empty-goals.svg`; цвета — значения §f, без внешних ресурсов.
 */
export function GoalsIllustration(props: SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 200 160" width="200" height="160" aria-hidden="true" focusable="false" {...props}>
      <g fill="none" stroke="#3A332B" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
      <rect x="14" y="8" width="172" height="144" rx="48" fill="#EFE8DC" stroke="none" />
      <path d="M28 136 H176" />
      <rect x="44" y="100" width="34" height="36" rx="10" fill="#E3EBDD" />
      <rect x="84" y="80" width="34" height="56" rx="10" fill="#DDEFE5" />
      <rect x="124" y="58" width="34" height="78" rx="10" fill="#F5EBCF" />
      <path d="M141 58 V20" />
      <path d="M141 22 H166 l-6 8 l6 8 H141 Z" fill="#F8E1E4" />
      <path d="M26 118 C 40 96, 52 92, 61 92 S 92 70, 101 72 S 124 48, 134 44" stroke="#C4421A" strokeDasharray="2 7" strokeWidth="3" />
      <rect x="34" y="30" width="10" height="10" rx="3.0" fill="#ECE6F7" transform="rotate(16 39.0 35.0)" />
      <rect x="168" y="92" width="8" height="8" rx="2.4" fill="#FBE3D3" transform="rotate(-12 172.0 96.0)" />
      </g>
    </svg>
  );
}
