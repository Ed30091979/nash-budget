import { useEffect, useState } from "react";

import { moneyParts } from "../money";

const DIGITS = ["0", "1", "2", "3", "4", "5", "6", "7", "8", "9"] as const;
const DIGIT_SET = new Set<string>(DIGITS);

/**
 * Уважает ли человек просьбу «поменьше движения». Читается на каждом монтировании, а не один раз
 * при загрузке модуля: настройку меняют, не перезапуская приложение.
 */
function prefersReducedMotion(): boolean {
  return typeof window !== "undefined"
    && typeof window.matchMedia === "function"
    && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

export interface MoneyOdometerProps {
  /** Значение до изменения, в минимальных единицах. */
  readonly from: number;
  /** Значение после изменения — оно и остаётся на экране. */
  readonly to: number;
}

/**
 * Одометр на денежной величине (§5 исследования, пункт 27).
 *
 * Движение здесь объясняет, а не развлекает (пункт 28): число проезжает от прежнего значения к
 * новому, чтобы стало видно, что оно изменилось, — иначе запись операции проходит молча и человек
 * не знает, записалось ли.
 *
 * Устройство ровно такое, как требует пункт 27. Каждая цифра — катушка из десяти цифр в слоте
 * шириной `1ch` с `overflow: hidden`; цифры табличные, иначе слоты разной ширины и число дрожит.
 * Смещение катушки задаётся не инлайновым стилем, а атрибутом `data-digit`: CSP запрещает
 * `style` (§11), и десять положений объявлены в таблице стилей.
 *
 * Читающему с экрана промежуточные цифры не нужны — ему нужен итог. Поэтому сама катушка
 * `aria-hidden`, а произносимую строку ставит рядом тот, кто одометр вставил: живая область у
 * него одна на всю карточку и объявляет сразу и что записано, и чем это кончилось.
 *
 * При `prefers-reduced-motion` кадра «до» не бывает вовсе: компонент монтируется сразу с итогом,
 * то есть движение выключено полностью, а не ослаблено.
 */
export function MoneyOdometer({ from, to }: MoneyOdometerProps) {
  const [shown, setShown] = useState(() => (prefersReducedMotion() ? to : from));

  useEffect(() => {
    if (prefersReducedMotion()) {
      setShown(to);
      return;
    }
    setShown(from);
    // Кадр «до» обязан попасть на экран раньше кадра «после»: переходу нужно, от чего ехать.
    const frame = requestAnimationFrame(() => setShown(to));
    return () => cancelAnimationFrame(frame);
  }, [from, to]);

  const parts = moneyParts(shown);
  const characters = [...`${parts.sign}${parts.value}`];

  return (
    <span className="money odometer" aria-hidden="true">
      {characters.map((character, index) => (DIGIT_SET.has(character)
        ? <span className="odometer-slot" data-digit={character} key={index}>
            <span className="odometer-reel">{DIGITS.map((digit) => <span key={digit}>{digit}</span>)}</span>
          </span>
        : <span className="odometer-fixed" key={index}>{character}</span>))}
      <span className="money-currency odometer-fixed">{parts.currency}</span>
    </span>
  );
}
