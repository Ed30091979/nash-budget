import type { SVGProps } from "react";

/**
 * Дом и телефон с галочкой: данные остаются на этом телефоне.
 *
 * Иллюстрация v5 (DIRECTION §f): контур тёплыми чернилами 2,5, пастель палитры, ровно одна
 * коралловая деталь. Декоративна — смысл несёт текст рядом, — поэтому скрыта от читающих с экрана.
 * Источник: `design-v5/illustrations/onb-3-private.svg`; цвета — значения §f, без внешних ресурсов.
 */
export function PrivateIllustration(props: SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 280 240" width="280" height="240" aria-hidden="true" focusable="false" {...props}>
      <g fill="none" stroke="#3A332B" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
      <rect x="12" y="10" width="256" height="220" rx="64" fill="#EFE8DC" stroke="none" />
      <path d="M58 106 L140 42 L222 106 Z" fill="#F5EBCF" stroke="none" />
      <rect x="70" y="98" width="140" height="116" rx="16" fill="#E3EBDD" />
      <path d="M50 112 L140 40 L230 112" />
      <rect x="174" y="52" width="16" height="30" rx="5" fill="#FFFFFF" />
      <path d="M40 214 H240" />
      <rect x="111" y="108" width="58" height="98" rx="13" fill="#FFFFFF" />
      <rect x="121" y="122" width="16" height="16" rx="5" fill="#DDEFE5" stroke="none" />
      <rect x="143" y="122" width="16" height="16" rx="5" fill="#ECE6F7" stroke="none" />
      <rect x="121" y="144" width="16" height="16" rx="5" fill="#FBE3D3" stroke="none" />
      <rect x="143" y="144" width="16" height="16" rx="5" fill="#F8E1E4" stroke="none" />
      <rect x="121" y="170" width="38" height="7" rx="3.5" fill="#3A332B" stroke="none" />
      <path d="M133 194 H147" />
      <rect x="158" y="96" width="32" height="32" rx="10" fill="#FFFFFF" />
      <path d="M166 112 l5 5 l10 -10" stroke="#C4421A" strokeWidth="3" />
      <rect x="36" y="60" width="12" height="12" rx="3.6" fill="#ECE6F7" transform="rotate(16 42.0 66.0)" />
      <rect x="232" y="150" width="10" height="10" rx="3.0" fill="#DDEFE5" transform="rotate(-12 237.0 155.0)" />
      </g>
    </svg>
  );
}
