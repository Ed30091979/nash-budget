import type { SVGProps } from "react";

/**
 * Две метки и пустое место для новой.
 *
 * Иллюстрация v5 (DIRECTION §f): контур тёплыми чернилами 2,5, пастель палитры, ровно одна
 * коралловая деталь. Декоративна — смысл несёт текст рядом, — поэтому скрыта от читающих с экрана.
 * Источник: `design-v5/illustrations/empty-tags.svg`; цвета — значения §f, без внешних ресурсов.
 */
export function TagsIllustration(props: SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 200 160" width="200" height="160" aria-hidden="true" focusable="false" {...props}>
      <g fill="none" stroke="#3A332B" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
      <rect x="14" y="8" width="172" height="144" rx="48" fill="#EFE8DC" stroke="none" />
      <g transform="rotate(14 120 74)">
      <path d="M86 50 H146 a10 10 0 0 1 10 10 V88 a10 10 0 0 1 -10 10 H86 L68 74 Z" fill="#ECE6F7" />
      <rect x="80" y="70" width="8" height="8" rx="2.5" fill="#FFFFFF" />
      </g>
      <g transform="rotate(-10 92 92)">
      <path d="M58 66 H118 a10 10 0 0 1 10 10 V108 a10 10 0 0 1 -10 10 H58 L38 92 Z" fill="#FBE3D3" />
      <rect x="50" y="88" width="8" height="8" rx="2.5" fill="#FFFFFF" />
      <g transform="translate(78 79) scale(1.0)" stroke="#3A332B" strokeWidth="2.40">
      <path d="M4 9h16" />
      <path d="M4 15h16" />
      <path d="M10 3 8 21" />
      <path d="m16 3-2 18" />
      </g>
      </g>
      <path d="M46 98 C 30 112, 34 132, 52 134" />
      <rect x="138" y="104" width="34" height="34" rx="10" strokeDasharray="3 6" fill="#FFFFFF" />
      <path d="M155 113 V129 M147 121 H163" stroke="#C4421A" strokeWidth="3" />
      <rect x="150" y="22" width="10" height="10" rx="3.0" fill="#DDEFE5" transform="rotate(14 155.0 27.0)" />
      </g>
    </svg>
  );
}
