import { createContext, useContext, type ReactNode } from "react";
import { DEFAULT_BASE_CURRENCY, type CurrencyCode } from "@family-budget/domain";
import { moneyParts } from "../money";

/**
 * Базовая валюта семьи — та, в которой считаются бюджет, итоги и лимиты (D-031). Оболочка ставит её
 * из `household` один раз; сумма без своей валюты набирается в ней, а не в рублях по умолчанию.
 * Сумма операции и остаток счёта называют свою валюту сами (`currency`).
 */
const BaseCurrencyContext = createContext<CurrencyCode>(DEFAULT_BASE_CURRENCY);

export function BaseCurrencyProvider({ currency, children }: { readonly currency: CurrencyCode; readonly children: ReactNode }) {
  return <BaseCurrencyContext.Provider value={currency}>{children}</BaseCurrencyContext.Provider>;
}

/** Базовая валюта, в которой набираются итоги на этом экране. */
export function useBaseCurrency(): CurrencyCode {
  return useContext(BaseCurrencyContext);
}

/**
 * §7 документа дизайна: сумма набирается табличными цифрами, минус — знаком U+2212, а знак
 * валюты — светлее самих цифр.
 *
 * Компонент существует ровно ради последнего: приглушить знак валюты можно только отдельным элементом,
 * а вырезать его из готовой строки руками нельзя — разделитель разрядов и отбивка перед знаком
 * набраны неразрывным пробелом, и поиск по строке рано или поздно спутает их. Разбор делает
 * платформа (`money.ts`, `formatToParts`), компонент только расставляет части по местам.
 *
 * Текст элемента совпадает с `formatMoney` до символа: читающий с экрана и `textContent` видят
 * ту же сумму, что и глаз.
 */
export interface MoneyProps {
  /** Сумма в минимальных единицах своей валюты. */
  readonly value: number;
  /**
   * Валюта суммы: валюта счёта у операции и остатка, базовая — у итогов и лимитов. Без неё сумма
   * набирается в базовой валюте семьи (`BaseCurrencyProvider`).
   */
  readonly currency?: CurrencyCode;
  /**
   * Знак направления операции, когда он несёт смысл строки, а не самой суммы: «+» у прихода,
   * «−» у расхода. Сумма операции хранится положительной, направление задаёт строка. Минус
   * отрицательной суммы приходит из неё самой и здесь не дублируется.
   */
  readonly sign?: "+" | "−";
  /**
   * Разрешить перенос между группами разрядов.
   *
   * По умолчанию сумма не переносится нигде: §7.3 запрещает разрыв внутри числа, и в строке
   * списка он читался бы ошибкой набора. Исключение ровно одно — герой-число: при системном
   * увеличении шрифта втрое оно перестаёт помещаться в любую ширину, и выбор там не между
   * «переносить и не переносить», а между переносом и обрезкой, которую запрещает §1.
   *
   * Разрыв ставится только между группами: внутри группы разрядов его нет, поэтому «128 450»
   * разойдётся как «128» и «450», а «12» и «8450» не получится никогда.
   */
  readonly breakDigits?: boolean;
  readonly className?: string;
}

/** Пробелы, которыми `Intl` отбивает разряды: обычный неразрывный и узкий неразрывный. */
const GROUP_SEPARATOR = /[    ]/u;

export function Money({ value, currency, sign, breakDigits, className }: MoneyProps) {
  const base = useBaseCurrency();
  const parts = moneyParts(value, currency ?? base);
  const separator = parts.value.match(GROUP_SEPARATOR)?.[0] ?? "";
  const groups = breakDigits && separator ? parts.value.split(GROUP_SEPARATOR) : [parts.value];
  return (
    <span className={className ? `money ${className}` : "money"}>
      {sign}{parts.sign}
      {/* Без разрешённых разрывов сумма остаётся одним текстовым узлом: лишняя обёртка не меняет
          строку, но меняет разметку, а разметку читают и проверки, и чужой код. */}
      {groups.length < 2 ? parts.value : groups.map((group, index) => (
        // Точка разрыва — пустой элемент: к строке она не добавляет ни знака, и `textContent`
        // остаётся ровно тем, что вернул бы `formatMoney`.
        <span key={index}>{index > 0 ? <><wbr />{separator}</> : null}{group}</span>
      ))}
      <span className="money-currency">{parts.currency}</span>
    </span>
  );
}
