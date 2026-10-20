import { Component, type ErrorInfo, type ReactNode } from "react";
import { EmptyState } from "../components/EmptyState";

/** Заголовок экрана, который не открылся: `h1` маршрута, на него оболочка ставит фокус. */
export const ROUTE_FAILURE_TITLE = "Экран не открылся";

export interface RouteErrorBoundaryProps {
  /** Ключ маршрута: другой маршрут — граница сбрасывается и рисует его заново. */
  readonly routeKey: string;
  /** «На «Обзор»» — корень приложения, откуда открывается всё остальное. */
  readonly onHome: () => void;
  readonly children: ReactNode;
}

interface RouteErrorBoundaryState {
  readonly failed: boolean;
  readonly routeKey: string;
}

/**
 * Граница ошибок экрана маршрута (ревью 2d, HIGH-1). Экран, который бросил при отрисовке, без неё
 * снимал всё приложение — оставалась белая страница, и выйти из неё можно было только
 * перезагрузкой, которая открывала тот же адрес. С ней — спокойный экран: заголовок, слова о том,
 * что записи целы (упала отрисовка, а не бюджет), и «На «Обзор»». Шапка, нижняя навигация и лист
 * ввода живут в оболочке вне границы и работают как прежде.
 *
 * Граница сбрасывается, когда меняется маршрут: «На «Обзор»», вкладка или «Назад» рисуют новый экран
 * заново. Ключ маршрута, а не `key` у потомка: смена фильтра «Операций» — тот же экран, и строка
 * поиска в его памяти не должна пропадать от перерисовки.
 *
 * Текст ошибки на экран не выводится: в нём бывают суммы, имена и заметки (SECURITY §7.2).
 */
export class RouteErrorBoundary extends Component<RouteErrorBoundaryProps, RouteErrorBoundaryState> {
  override state: RouteErrorBoundaryState;

  constructor(props: RouteErrorBoundaryProps) {
    super(props);
    this.state = { failed: false, routeKey: props.routeKey };
  }

  static getDerivedStateFromError(_error: unknown): Partial<RouteErrorBoundaryState> {
    return { failed: true };
  }

  static getDerivedStateFromProps(props: RouteErrorBoundaryProps, state: RouteErrorBoundaryState): RouteErrorBoundaryState | null {
    return props.routeKey === state.routeKey ? null : { failed: false, routeKey: props.routeKey };
  }

  override componentDidCatch(_error: unknown, _info: ErrorInfo): void {
    // Ничего не отправляется и не пишется: приложение не ходит в сеть без семьи, а текст ошибки
    // может нести данные бюджета. Экран выше говорит человеку всё, что ему нужно.
  }

  override render(): ReactNode {
    if (!this.state.failed) return this.props.children;
    return (
      <div className="route-failure">
        <header className="large-title">
          <h1 tabIndex={-1}>{ROUTE_FAILURE_TITLE}</h1>
        </header>
        <EmptyState
          glyph="triangle-alert"
          title="Записи целы"
          text="Ошибка — в показе этого экрана, а не в бюджете. Вернитесь на «Обзор» и откройте экран снова."
          action={{ label: "На «Обзор»", onClick: this.props.onHome }}
        />
      </div>
    );
  }
}
