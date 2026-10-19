import type { BudgetState } from "@family-budget/domain";
import type { StorageHealth } from "@family-budget/storage";
import { Icon } from "../../components/Icon";
import { DataManagementScreen } from "../data-management";
import { formatMoney } from "../../money";
import { plural } from "../../plural";

/** «5-го и 20-го» — даты выплат, выведенные из доходов, одной строкой; пусто — выводить не из чего. */
export function paydayWords(days: readonly number[]): string {
  if (days.length === 0) return "";
  const named = days.map((day) => `${day}-го`);
  return named.length === 1 ? named[0]! : `${named.slice(0, -1).join(", ")} и ${named[named.length - 1]}`;
}

function storageText(health: StorageHealth | null): string {
  if (!health) return "Проверяем локальное хранилище…";
  if (health.quota === null || health.usage === null) {
    return health.persisted ? "Постоянное локальное хранение разрешено." : "Хранилище браузера работает в обычном режиме.";
  }
  return `${(health.usage / 1024 / 1024).toFixed(1)} МБ из ${(health.quota / 1024 / 1024).toFixed(0)} МБ`;
}

/**
 * Строка «План месяца» на «Ещё»: строй месяца одной строкой — выплаты, конверты, платежи.
 *
 * Те же числа, на которых стоят «Сегодня» и «Год», названные коротко: не второй экран плана, а
 * дверь в него с табличкой, по которой видно, что за ней.
 */
export function monthNote(budget: BudgetState, paydays: readonly number[]): string {
  const active = budget.budgets.find((item) => item.id === budget.activeBudgetId);
  const lines = (active?.lines ?? []).filter((line) => line.active !== false);
  const envelopesMinor = lines.reduce((total, line) => total + line.plannedMinor, 0);
  const payments = budget.scheduledExpenses.filter((item) => item.active).length
    + budget.annualCommitments.filter((item) => item.active).length;
  const parts = [
    paydays.length ? `выплаты ${paydayWords(paydays)}` : "даты выплат — из доходов",
    lines.length ? `${plural(lines.length, ["конверт", "конверта", "конвертов"])} на ${formatMoney(envelopesMinor)}` : "конвертов нет",
    payments ? plural(payments, ["платёж", "платежа", "платежей"]) : "платежей нет",
  ];
  return parts.join(" · ");
}

/**
 * «Ещё» — список: семья, план, данные, приложение.
 *
 * План месяца и план на год — подэкраны «Ещё» (`#/more/plan-month`, `#/more/plan-year`): вкладки
 * «Год» в навигации из пяти мест нет. Записи и итоги — вкладки «Операции» и «Отчёты», поэтому
 * группы «Записи» здесь больше нет: два пути к одному экрану с разной историей «Назад» путали бы.
 *
 * Экран не упразднён нарочно. Приложение офлайн-первое, сервер копией не является, и при утрате
 * всех устройств данные не восстановить, — поэтому «Сделать копию» обязано находиться с одного
 * взгляда, а не за дверью. Юридические абзацы при этом свёрнуты в строку факта: их читают один
 * раз, а копию делают каждый месяц.
 */
export function MoreScreen(props: {
  budget: BudgetState;
  storageHealth: StorageHealth | null;
  showIosInstall: boolean;
  lastSuccessfulBackup: string | null;
  onCreateBackup: () => Promise<{ readonly text: string; readonly createdAt: string; readonly restoreWarning?: string | null }>;
  onRecordSuccessfulBackup: Parameters<typeof DataManagementScreen>[0]["onRecordSuccessfulBackup"];
  onRestoreBackup: Parameters<typeof DataManagementScreen>[0]["onRestoreBackup"];
  onPersistClear: () => Promise<void>;
  onPublishEmpty: () => void;
  onFamily: () => void;
  onPlanMonth: () => void;
  onPlanYear: () => void;
  onImportStatement: () => void;
  familyNote: string;
  monthNote: string;
  syncIndicator: { readonly text: string; readonly className: string; readonly ariaLabel: string };
}) {
  return <>
    <h1 className="visually-hidden">Ещё: семья, план и данные</h1>
    <section className="list-group" aria-labelledby="more-family-title">
      <h2 id="more-family-title" className="list-kicker">Семья</h2>
      <ul className="list-card">
        <li><button className="list-row" type="button" onClick={props.onFamily}><span className="list-icon"><Icon name="users" size={24} /></span><span className="list-copy"><strong>Семья и синхронизация</strong><small>{props.familyNote}</small><span className={props.syncIndicator.className} aria-label={props.syncIndicator.ariaLabel}>{props.syncIndicator.text}</span></span><Icon name="chevron-right" size={24} className="row-chevron" /></button></li>
      </ul>
    </section>

    <section className="list-group" aria-labelledby="more-plan-title">
      <h2 id="more-plan-title" className="list-kicker">План</h2>
      <ul className="list-card">
        {/* Строй месяца одной строкой: то, на чём стоят «Обзор» и план на год, и дверь туда, где это правят. */}
        <li><button className="list-row" type="button" onClick={props.onPlanMonth}><span className="list-icon"><Icon name="calendar" size={24} /></span><span className="list-copy"><strong>План месяца</strong><small>{props.monthNote}</small></span><Icon name="chevron-right" size={24} className="row-chevron" /></button></li>
        <li><button className="list-row" type="button" onClick={props.onPlanYear}><span className="list-icon"><Icon name="calendar-clock" size={24} /></span><span className="list-copy"><strong>План на год</strong><small>Горизонт 12–24 месяцев: сезонные расходы, обучение, страховка и дом</small></span><Icon name="chevron-right" size={24} className="row-chevron" /></button></li>
      </ul>
    </section>

    <DataManagementScreen
      budget={props.budget}
      lastSuccessfulBackup={props.lastSuccessfulBackup}
      showIosInstall={props.showIosInstall}
      onCreateBackup={props.onCreateBackup}
      onRecordSuccessfulBackup={props.onRecordSuccessfulBackup}
      onRestoreBackup={props.onRestoreBackup}
      onPersistClear={props.onPersistClear}
      onPublishEmpty={props.onPublishEmpty}
      onImportStatement={props.onImportStatement}
    />

    <section className="list-group" aria-labelledby="more-about-title">
      <h2 id="more-about-title" className="list-kicker">О приложении</h2>
      <ul className="list-card">
        <li><details className="list-fact">
          <summary><span className="list-icon"><Icon name="shield" size={24} /></span><span className="list-copy"><strong>Как хранятся данные</strong><small>На этом устройстве; в сеть — только после входа</small></span><Icon name="chevron-right" size={24} className="row-chevron" /></summary>
          <p>Нет рекламы и аналитики. Семейная синхронизация необязательна: пока вы не вошли, приложение не обращается к сети и ничего не отправляет. Сервер семьи не хранит имена и не является резервной копией — при утрате всех устройств данные не восстановить, поэтому копию делайте сами.</p>
        </details></li>
        <li><div className="list-row static" role="status"><span className="list-icon"><Icon name="hard-drive" size={24} /></span><span className="list-copy"><strong>Локальное хранилище</strong><small>{storageText(props.storageHealth)}</small></span></div></li>
      </ul>
    </section>
  </>;
}
