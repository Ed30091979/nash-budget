import type { SVGProps } from "react";

/**
 * Календарь с днём выплаты и полоса, которая дотягивает до него.
 *
 * Иллюстрация v5 (DIRECTION §f): контур тёплыми чернилами 2,5, пастель палитры, ровно одна
 * коралловая деталь. Декоративна — смысл несёт текст рядом, — поэтому скрыта от читающих с экрана.
 * Источник: `design-v5/illustrations/onb-2-reach.svg`; цвета — значения §f, без внешних ресурсов.
 */
export function ReachIllustration(props: SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 280 240" width="280" height="240" aria-hidden="true" focusable="false" {...props}>
      <g fill="none" stroke="#3A332B" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
      <rect x="12" y="10" width="256" height="220" rx="64" fill="#EFE8DC" stroke="none" />
      <rect x="62" y="34" width="132" height="118" rx="20" fill="#FFFFFF" />
      <path d="M62 64 V54 a20 20 0 0 1 20 -20 H174 a20 20 0 0 1 20 20 V64 Z" fill="#FBE3D3" />
      <rect x="88" y="24" width="9" height="20" rx="4.5" fill="#FFFFFF" />
      <rect x="159" y="24" width="9" height="20" rx="4.5" fill="#FFFFFF" />
      <rect x="76" y="76" width="14" height="14" rx="4" fill="#EEE9E1" stroke="none" />
      <rect x="98" y="76" width="14" height="14" rx="4" fill="#EEE9E1" stroke="none" />
      <rect x="120" y="76" width="14" height="14" rx="4" fill="#EEE9E1" stroke="none" />
      <rect x="142" y="76" width="14" height="14" rx="4" fill="#EEE9E1" stroke="none" />
      <rect x="164" y="76" width="14" height="14" rx="4" fill="#EEE9E1" stroke="none" />
      <rect x="76" y="98" width="14" height="14" rx="4" fill="#EEE9E1" stroke="none" />
      <rect x="98" y="98" width="14" height="14" rx="4" fill="#EEE9E1" stroke="none" />
      <rect x="120" y="98" width="14" height="14" rx="4" fill="#EEE9E1" stroke="none" />
      <rect x="140" y="96" width="18" height="18" rx="5.5" fill="#C4421A" stroke="none" />
      <rect x="164" y="98" width="14" height="14" rx="4" fill="#EEE9E1" stroke="none" />
      <rect x="76" y="120" width="14" height="14" rx="4" fill="#EEE9E1" stroke="none" />
      <rect x="98" y="120" width="14" height="14" rx="4" fill="#EEE9E1" stroke="none" />
      <rect x="120" y="120" width="14" height="14" rx="4" fill="#EEE9E1" stroke="none" />
      <rect x="142" y="120" width="14" height="14" rx="4" fill="#EEE9E1" stroke="none" />
      <rect x="164" y="120" width="14" height="14" rx="4" fill="#EEE9E1" stroke="none" />
      <path d="M149 118 C 150 140, 176 150, 188 164" strokeDasharray="2 7" strokeWidth="3" />
      <rect x="40" y="180" width="200" height="18" rx="9" fill="#E4DED3" stroke="none" />
      <rect x="40" y="180" width="168" height="18" rx="9" fill="#3A332B" stroke="none" />
      <rect x="186" y="176" width="8" height="26" fill="#EFE8DC" stroke="none" />
      <path d="M190 166 V212" stroke="#C4421A" strokeWidth="3.5" />
      <rect x="52" y="140" width="32" height="32" rx="10" fill="#DDEFE5" />
      <g transform="translate(60.32 148.32) scale(0.64)" stroke="#3A332B" strokeWidth="3.12">
      <path d="m5 11 3-7" />
      <path d="m19 11-3-7" />
      <path d="M2 11h20" />
      <path d="m4 11 1.5 8a2 2 0 0 0 2 1.6h9a2 2 0 0 0 2-1.6L20 11" />
      <path d="M10 15v3" />
      <path d="M14 15v3" />
      </g>
      <rect x="22" y="152" width="26" height="26" rx="8" fill="#ECE6F7" />
      <g transform="translate(28.76 158.76) scale(0.52)" stroke="#3A332B" strokeWidth="3.85">
      <path d="M4 17V8a2 2 0 0 1 2-2h12a2 2 0 0 1 1.94 1.5l1 4A2 2 0 0 1 21 12v5a1 1 0 0 1-1 1h-1" />
      <path d="M5 18H4a1 1 0 0 1-1-1v-5" />
      <path d="M3 12h18" />
      <path d="M8 6v6" />
      <path d="M15 6v6" />
      <circle cx="7" cy="18" r="2" />
      <circle cx="17" cy="18" r="2" />
      <path d="M9 18h6" />
      </g>
      <rect x="222" y="42" width="12" height="12" rx="3.6" fill="#DDEFE5" transform="rotate(12 228.0 48.0)" />
      <rect x="232" y="132" width="8" height="8" rx="2.4" fill="#F5EBCF" transform="rotate(-14 236.0 136.0)" />
      </g>
    </svg>
  );
}
