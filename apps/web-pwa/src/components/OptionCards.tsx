import { useId } from "react";
import { softHyphenate } from "../hyphenation";
import { Icon, type IconName } from "./Icon";

export interface OptionCard<T extends string> {
  readonly value: T;
  readonly label: string;
  readonly icon?: IconName;
  /** `id` радиокнопки — туда уходит фокус с отказом поля и с клавиатуры. */
  readonly id?: string;
}

export interface OptionCardsProps<T extends string> {
  /** `id` группы — куда уходит фокус с отказом поля (программно: в порядок Tab группа не встаёт). */
  readonly id?: string;
  readonly legend: string;
  readonly options: readonly OptionCard<T>[];
  readonly value: T;
  readonly disabled?: boolean;
  readonly describedBy?: string;
  readonly onChange: (value: T) => void;
}

/**
 * Выбор из немногих карточками 2×2 (дизайн 5.0, макеты 12 и 13): вид счёта, группа категории.
 * Настоящие радиокнопки: Tab входит в группу один раз, стрелки выбирают соседнюю. Выбор — не цвет:
 * рамка акцента 2 pt, полужирное слово и галочка. Ниже 18em карточки встают в одну колонку.
 */
export function OptionCards<T extends string>({ id, legend, options, value, disabled, describedBy, onChange }: OptionCardsProps<T>) {
  const name = useId();
  return (
    <fieldset id={id} className="dir-options" disabled={disabled} aria-describedby={describedBy} tabIndex={id === undefined ? undefined : -1}>
      <legend className="dir-label">{legend}</legend>
      <div className="dir-options-grid">
        {options.map((option) => {
          const checked = option.value === value;
          return (
            <label key={option.value} className="dir-option">
              <input id={option.id} type="radio" name={name} value={option.value} checked={checked} onChange={() => onChange(option.value)} />
              {option.icon === undefined ? null : <Icon name={option.icon} size={24} />}
              {/* Слово переносится по слогам, а не рвётся посередине: карточка на 320 узкая. Слово с
                  мягкими переносами — для глаза, для слуха — целое: в доступном имени перенос — шум. */}
              <span className="dir-option-word" aria-hidden="true">{softHyphenate(option.label)}</span>
              <span className="sr-only">{option.label}</span>
              {checked ? <span className="dir-option-check" aria-hidden="true"><Icon name="check" size={24} /></span> : null}
            </label>
          );
        })}
      </div>
    </fieldset>
  );
}
