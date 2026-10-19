import { accountsInOrder, type BudgetState } from "@family-budget/domain";
import { accountIcon } from "../../category-visual";
import { Icon } from "../../components/Icon";
import { QuestionSheet } from "./QuestionSheet";

export interface AccountsQuestionProps {
  readonly budget: BudgetState;
  /** «Нет, это всё»: нормальный ответ, вопрос больше не задаётся. */
  readonly onNo: () => void;
  /** «Да, добавить»: форма счёта с видом «Накопления». */
  readonly onYes: () => void;
  readonly onLater: () => void;
}

/** Сколько уже заведённых счетов лист называет: больше — это уже список, а не подсказка. */
const SHOWN_ACCOUNTS = 3;

/**
 * «Есть ещё места, где лежат деньги?» (03b). Ниже вопроса — счета, которые уже есть, чтобы ответ
 * был про недостающее. «Нет» — нормальный ответ, крестик значит «спросить позже». Лист ничего не
 * пишет и черновика не держит: «Да» открывает существующую форму счёта.
 */
export function AccountsQuestion({ budget, onNo, onYes, onLater }: AccountsQuestionProps) {
  const accounts = accountsInOrder(budget.accounts.filter((account) => account.active)).slice(0, SHOWN_ACCOUNTS);
  return (
    <QuestionSheet
      id="q-accounts"
      title="Есть ещё места, где лежат деньги?"
      subtitle="Например, вклад, копилка или карта другого банка."
      onLater={onLater}
      footer={
        <div className="q-actions">
          <button className="secondary-button" type="button" onClick={onNo}>Нет, это всё</button>
          <button className="primary-button" type="button" onClick={onYes}>Да, добавить</button>
        </div>
      }
    >
      {accounts.length === 0 ? null : (
        <div className="q-minis">
          <span className="q-minis-label" id="q-accounts-have">Уже есть:</span>
          <ul aria-labelledby="q-accounts-have">
            {accounts.map((account) => (
              <li key={account.id} className="q-mini">
                <span className="icon-plate q-mini-plate" aria-hidden="true"><Icon name={accountIcon(account)} size={24} /></span>
                <bdi dir="auto">{account.name}</bdi>
              </li>
            ))}
          </ul>
        </div>
      )}
    </QuestionSheet>
  );
}
