import { Money } from "../../components/Money";
import { moneyIn } from "./transaction-words";

/**
 * Сумма одной операции в валюте её счёта — так же, как в «Вся история»: рубли набираются `Money`
 * с приглушённым знаком, другая валюта — своим знаком и своей точностью. «40 ₽» у покупки по счёту
 * в долларах было бы неправдой (второе ревью волны 1, LOW-7).
 */
export function OperationAmount({ value, currency, sign }: { readonly value: number; readonly currency: string; readonly sign?: "+" | "−" }) {
  return currency === "RUB"
    ? <Money value={value} {...(sign === undefined ? {} : { sign })} />
    : <span className="money">{sign}{moneyIn(value, currency)}</span>;
}
