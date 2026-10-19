import { Money } from "../../components/Money";

/**
 * Сумма одной операции в валюте её счёта — так же, как в «Операциях»: число, знак направления и
 * приглушённый знак валюты, у каждой валюты — своя точность. «40 ₽» у покупки по счёту в долларах
 * было бы неправдой (второе ревью волны 1, LOW-7).
 */
export function OperationAmount({ value, currency, sign }: { readonly value: number; readonly currency: string; readonly sign?: "+" | "−" }) {
  return <Money value={value} currency={currency} {...(sign === undefined ? {} : { sign })} />;
}
