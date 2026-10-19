import { useId } from "react";
import type { CategoryTone } from "../category-visual";
import { Icon } from "./Icon";

/**
 * Выбор тона счёта или категории (D-036): радиогруппа со словами — «Мята», «Сирень», — первым «Авто».
 *
 * Тон метит сущность, а не величину (DESIGN §3), и выбор цвета не держится на одном цвете: у каждого
 * образца — слово, у выбранного — кольцо акцента, галочка и полужирное слово. Образец на белом
 * почти не виден краем (1.19–1.24:1) — его опознают словом, это записано в §3 «Запреты». Ключи —
 * прежние ключи данных (`mint`, `sage`…): их пишет G-003 и читает `category-visual.ts`.
 */
export const TONE_CHOICES: readonly { readonly tone: CategoryTone; readonly word: string }[] = [
  { tone: "mint", word: "Мята" },
  { tone: "sage", word: "Шалфей" },
  { tone: "peach", word: "Персик" },
  { tone: "amber", word: "Янтарь" },
  { tone: "coral", word: "Коралл" },
  { tone: "lilac", word: "Сирень" },
  { tone: "neutral", word: "Без цвета" },
];

export function toneWord(tone: CategoryTone): string {
  return TONE_CHOICES.find((choice) => choice.tone === tone)?.word ?? "Без цвета";
}

export interface TonePickerProps {
  readonly legend: string;
  /** Выбранный тон; `null` — «Авто». */
  readonly value: CategoryTone | null;
  /** Как выглядит «Авто»: тон, выведенный по имени или группе. */
  readonly fallback: CategoryTone;
  readonly disabled?: boolean;
  readonly onChange: (tone: CategoryTone | null) => void;
}

export function TonePicker({ legend, value, fallback, disabled, onChange }: TonePickerProps) {
  const name = useId();
  const options: readonly { readonly key: string; readonly tone: CategoryTone; readonly word: string; readonly choice: CategoryTone | null }[] = [
    { key: "auto", tone: fallback, word: "Авто", choice: null },
    ...TONE_CHOICES.map((choice) => ({ key: choice.tone, tone: choice.tone, word: choice.word, choice: choice.tone })),
  ];
  return (
    <fieldset className="picker" disabled={disabled}>
      <legend>{legend}</legend>
      <div className="picker-grid">
        {options.map((option) => {
          const checked = option.choice === value;
          return (
            <label key={option.key} className="picker-option">
              <input type="radio" name={name} value={option.key} checked={checked} onChange={() => onChange(option.choice)} />
              <span className={`icon-plate tone-swatch tone-${option.tone}`} aria-hidden="true">{checked ? <Icon name="check" size={24} /> : null}</span>
              <span className="picker-word">{option.word}</span>
            </label>
          );
        })}
      </div>
    </fieldset>
  );
}
