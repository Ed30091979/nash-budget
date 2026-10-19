import type { Ref } from "react";
import { Icon, type IconName } from "./Icon";
import type { Route, TabName } from "../navigation/routes";

/**
 * Нижняя навигация: пять мест (план волны 2, §1, DESIGN.md §5).
 *
 * «Обзор», «Операции», «+», «Отчёты», «Ещё». «+» — не вкладка, а действие: запись поверх того
 * места, где стоишь; коралловый акцент, 56 pt, доступное имя «Записать». Глифы — из того же
 * спрайта, что и весь интерфейс; смысл несёт подпись, глиф декоративен. «Вы здесь» — точка акцента
 * под глифом и `aria-current`, подпись остаётся чернилами: акцент мелким текстом не бывает (§3).
 */
const TABS: readonly { readonly tab: TabName; readonly label: string; readonly icon: IconName }[] = [
  { tab: "overview", label: "Обзор", icon: "house" },
  { tab: "operations", label: "Операции", icon: "history" },
  { tab: "reports", label: "Отчёты", icon: "chart-pie" },
  { tab: "more", label: "Ещё", icon: "ellipsis" },
];

/** Какая вкладка подсвечена на маршруте: подэкраны «Ещё» живут под «Ещё», лист — под своим экраном. */
export function activeTab(route: Route): TabName | null {
  switch (route.name) {
    case "overview":
    case "operations":
    case "reports":
    case "more":
      return route.name;
    case "plan-month":
    case "plan-year":
    case "family":
    case "import":
    case "accounts":
    case "account":
    case "account-new":
    case "rates":
    case "categories":
    case "category":
    case "tags":
      return "more";
  }
}

export interface BottomNavProps {
  readonly route: Route;
  readonly onTab: (tab: TabName) => void;
  readonly onAdd: () => void;
  readonly navRef?: Ref<HTMLElement>;
}

export function BottomNav({ route, onTab, onAdd, navRef }: BottomNavProps) {
  // «+» открыл лист ввода без вида: лист стоит поверх вкладки, и «вы здесь» — «+», а не она.
  const adding = route.sheet === "entry" && route.op === undefined && route.edit === undefined;
  const active = adding ? null : activeTab(route);
  const tab = ({ tab: name, label, icon }: (typeof TABS)[number]) => (
    <button key={name} className={`nav-button${active === name ? " active" : ""}`} type="button" onClick={() => onTab(name)} aria-current={active === name ? "page" : undefined}>
      <span className="nav-icon"><Icon name={icon} size={24} /></span><span>{label}</span>
    </button>
  );
  return (
    <nav ref={navRef} className="bottom-nav" aria-label="Основные разделы">
      {TABS.slice(0, 2).map(tab)}
      <button className={`nav-fab${adding ? " active" : ""}`} type="button" aria-label="Записать" onClick={onAdd} aria-current={adding ? "page" : undefined}>
        <Icon name="plus" size={24} />
      </button>
      {TABS.slice(2).map(tab)}
    </nav>
  );
}
