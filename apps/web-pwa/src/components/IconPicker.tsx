import { useId } from "react";
import type { CategoryTone } from "../category-visual";
import { Icon, type IconName } from "./Icon";

/**
 * Выбор иконки счёта или категории (D-036): радиогруппа из глифов спрайта, первым — «Авто».
 *
 * Иконка — ключ оформления в данных семьи, а не картинка: выбирается только то, что в спрайте есть,
 * и «Авто» снимает выбор — вид снова выводится по имени, группе или виду счёта (`category-visual.ts`).
 * Группа — настоящие радиокнопки: стрелки переходят между вариантами, Tab входит в группу один раз,
 * читающий с экрана слышит слово глифа («Корзина, 3 из 20, выбрано»). Выбор — не цвет: кольцо
 * акцента, галочка и полужирное слово (§9).
 *
 * Дизайн 5.0 (макет 13): сетка квадратов 48 тона, выбранного рядом, по шесть в ряд (на 320 — по
 * четыре); слово глифа — доступное имя варианта, а видна только подпись «Авто» у первого: его глиф
 * выведен по имени или виду, а не выбран. Выбор — кольцо акцента вокруг квадрата и галочка в углу.
 */

/** Слово глифа — доступное имя варианта. Только для глифов, которые предлагаются. */
export const ICON_WORDS: ReadonlyMap<IconName, string> = new Map<IconName, string>([
  ["credit-card", "Карта"],
  ["banknote", "Купюра"],
  ["wallet", "Кошелёк"],
  ["piggy-bank", "Копилка"],
  ["shield", "Щит"],
  ["landmark", "Банк"],
  ["dollar-sign", "Доллар"],
  ["euro", "Евро"],
  ["briefcase", "Портфель"],
  ["house", "Дом"],
  ["car", "Машина"],
  ["gift", "Подарок"],
  ["plane", "Самолёт"],
  ["graduation-cap", "Учёба"],
  ["heart", "Сердце"],
  ["target", "Цель"],
  ["smartphone", "Телефон"],
  ["shopping-basket", "Корзина"],
  ["bus", "Автобус"],
  ["zap", "Молния"],
  ["wifi", "Связь"],
  ["lamp", "Лампа"],
  ["pill", "Таблетка"],
  ["backpack", "Рюкзак"],
  ["paw-print", "Лапа"],
  ["sprout", "Росток"],
  ["wrench", "Ключ"],
  ["cup", "Чашка"],
  ["shirt", "Одежда"],
  ["sparkles", "Блеск"],
  ["ticket", "Билет"],
  ["dumbbell", "Гантели"],
  ["wine", "Бокал"],
  ["award", "Награда"],
  ["percent", "Процент"],
  ["trending-up", "Рост"],
  ["users", "Люди"],
  ["tag", "Ярлык"],
]);

/** Иконки счёта: деньги и места, где они лежат, — сначала то, чем счёт чаще всего бывает. */
export const ACCOUNT_ICON_CHOICES: readonly IconName[] = [
  "credit-card", "banknote", "wallet", "piggy-bank", "shield", "landmark", "dollar-sign", "euro",
  "briefcase", "house", "car", "plane", "graduation-cap", "gift", "heart", "target",
];

/** Иконки категории и источника дохода: глифы карты категорий и то, чем семьи их обычно метят. */
export const CATEGORY_ICON_CHOICES: readonly IconName[] = [
  "shopping-basket", "bus", "car", "house", "zap", "wifi", "credit-card", "landmark", "shield", "lamp",
  "pill", "backpack", "paw-print", "graduation-cap", "sprout", "wrench", "cup", "shirt", "sparkles",
  "ticket", "gift", "plane", "dumbbell", "smartphone", "wine", "heart", "banknote", "award", "briefcase",
  "percent", "trending-up", "users", "piggy-bank", "target", "tag",
];

export function iconWord(icon: IconName): string {
  return ICON_WORDS.get(icon) ?? "Иконка";
}

export interface IconPickerProps {
  readonly legend: string;
  readonly icons: readonly IconName[];
  /** Выбранная иконка; `null` — «Авто». */
  readonly value: IconName | null;
  /** Как выглядит «Авто»: глиф, выведенный без выбора. */
  readonly fallback: IconName;
  /** Тон образцов — тот, что выбран рядом, чтобы иконка была видна в своём цвете. */
  readonly tone: CategoryTone;
  readonly disabled?: boolean;
  readonly onChange: (icon: IconName | null) => void;
}

export function IconPicker({ legend, icons, value, fallback, tone, disabled, onChange }: IconPickerProps) {
  const name = useId();
  const options: readonly { readonly key: string; readonly icon: IconName; readonly word: string; readonly choice: IconName | null }[] = [
    { key: "auto", icon: fallback, word: "Авто", choice: null },
    ...icons.map((icon) => ({ key: icon, icon, word: iconWord(icon), choice: icon })),
  ];
  return (
    <fieldset className="picker icon-picker" disabled={disabled}>
      <legend className="dir-label">{legend}</legend>
      <div className="picker-grid">
        {options.map((option) => {
          const checked = option.choice === value;
          const auto = option.choice === null;
          return (
            <label key={option.key} className={auto ? "picker-option picker-auto" : "picker-option"}>
              <input type="radio" name={name} value={option.key} checked={checked} onChange={() => onChange(option.choice)} />
              <span className={`icon-plate tone-${tone}${auto ? " auto" : ""}`} aria-hidden="true"><Icon name={option.icon} size={24} /></span>
              {/* Слово глифа — для слуха; на глаз глиф и есть слово. «Авто» видно: его глиф выведен, а не выбран. */}
              <span className={auto ? "picker-word" : "sr-only"}>{option.word}</span>
              {checked ? <span className="picker-check" aria-hidden="true"><Icon name="check" size={20} /></span> : null}
            </label>
          );
        })}
      </div>
    </fieldset>
  );
}
