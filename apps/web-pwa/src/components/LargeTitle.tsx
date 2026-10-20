import type { ReactNode } from "react";

/**
 * Крупный заголовок вкладки (DESIGN 5.0 §6, макеты v5 §d): «Операции», «Отчёты», «Ещё» — 28/32 слева,
 * справа может стоять одно действие-иконка 48. Это `h1` маршрута: на него оболочка ставит фокус после
 * перехода. У «Обзора» заголовок — сам месяц со стрелками (`MonthSwitch`).
 */
export function LargeTitle({ title, id, action }: { readonly title: ReactNode; readonly id?: string; readonly action?: ReactNode }) {
  return (
    <header className="large-title">
      <h1 id={id}>{title}</h1>
      {action ?? null}
    </header>
  );
}
