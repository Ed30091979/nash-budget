import { Icon } from "../../components/Icon";

export interface FilterChipModel {
  readonly key: string;
  /** Видимая подпись — она же выбранное: «Все счета» или «Карта». */
  readonly label: string;
  /**
   * Доступное имя — что чип фильтрует и что выбрано: «Счёт: Карта», «Категория: все категории»,
   * «Период: октябрь». Видимая подпись стоит в нём целиком (WCAG 2.5.3), а на слух чип «Карта» не
   * путается со строкой ленты «Карта» (ревью 2d, LOW-11).
   */
  readonly name: string;
  /** Фильтр задан: чип — чернильной пилюлей. */
  readonly set: boolean;
  readonly expanded: boolean;
  readonly onOpen: () => void;
}

/**
 * Чипы фильтров (макет 08): «Октябрь ▾ · Все счета ▾ · Все категории ▾ · Метки ▾», «Участник» — только
 * в семье. Каждый открывает лист выбора; заданный фильтр — чернильная пилюля, и подпись называет его
 * значение словами. Ряд листается вбок внутри себя, а при крупном шрифте чипы встают столбцом.
 */
export function FilterBar({ label, chips }: { readonly label: string; readonly chips: readonly FilterChipModel[] }) {
  return (
    <div className="filter-chips" role="group" aria-label={label}>
      {chips.map((chip) => (
        <button
          key={chip.key}
          className="chip filter-chip"
          type="button"
          aria-haspopup="dialog"
          aria-expanded={chip.expanded}
          aria-label={chip.name}
          data-set={chip.set ? "true" : undefined}
          onClick={chip.onOpen}
        >
          <span className="chip-face"><bdi dir="auto">{chip.label}</bdi><Icon name="chevron-down" size={20} /></span>
        </button>
      ))}
    </div>
  );
}
