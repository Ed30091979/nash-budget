import {
  ACCOUNT_NAME_MAX_LENGTH,
  accountReferences,
  accountReferenceWords,
  accountsInOrder,
  AccountValidationError,
  baseCurrencyOf,
  calculateHoldings,
  createAccount,
  currencyExponent,
  isSupportedCurrency,
  MAX_MONEY_MINOR,
  updateAccount,
  type Account,
  type AccountPatch,
  type AccountType,
  type BudgetState,
  type CurrencyCode,
} from "@family-budget/domain";
import { accountIcon, accountTone, iconOfKey, toneOfKey, type CategoryTone } from "../../category-visual";
import type { IconName } from "../../components/Icon";
import { parseMoney } from "../../money";
import { writeFailureText } from "../../write/useBudgetWrite";

/**
 * Счета (план волны 2, §1.5): данные списка и формы, без React. Экран рисует то, что здесь
 * посчитано, и пишет то, что здесь собрано; правила — у домена (`packages/domain/src/accounts.ts`),
 * здесь только перевод между полями формы и его переходами.
 */

/** Слова вида счёта — в порядке, в каком их предлагает форма (`ACCOUNT_TYPES`). */
export const ACCOUNT_TYPE_WORDS: Readonly<Record<AccountType, string>> = {
  current: "Карта или счёт",
  cash: "Наличные",
  savings: "Накопления",
  reserve: "Резерв",
};

export { ACCOUNT_NAME_MAX_LENGTH };

/** Форма счёта так, как её набирают: остаток — текстом, знак — отдельной отметкой. */
export interface AccountFormDraft {
  readonly name: string;
  readonly type: AccountType;
  readonly currency: CurrencyCode;
  /** Начальный остаток без знака, как набран: «12 500», «1250,50». Пусто — ноль. */
  readonly opening: string;
  /** Остаток ниже нуля — долг по карте. */
  readonly negative: boolean;
  /** Иконка; `null` — «Авто», по виду счёта. */
  readonly icon: IconName | null;
  /** Тон; `null` — «Авто», тёмная плитка без тона. */
  readonly tone: CategoryTone | null;
  readonly includeInTotal: boolean;
}

export type AccountFormField = "name" | "type" | "currency" | "opening" | "icon" | "tone" | "includeInTotal" | "form";

export interface AccountFormError {
  readonly field: AccountFormField;
  readonly message: string;
}

function exponentOf(currency: CurrencyCode): number {
  return isSupportedCurrency(currency) ? currencyExponent(currency) : 2;
}

/** Сумма в минимальных единицах — текстом поля, без разрядов и знака: «1250,50», «0». */
export function minorToInput(minor: number, currency: CurrencyCode): string {
  const exponent = exponentOf(currency);
  const absolute = BigInt(Math.abs(minor));
  const scale = 10n ** BigInt(exponent);
  const whole = (absolute / scale).toString();
  if (exponent === 0) return whole;
  const fraction = (absolute % scale).toString().padStart(exponent, "0");
  return /^0+$/u.test(fraction) ? whole : `${whole},${fraction}`;
}

/** Новый счёт: в базовой валюте, карта, без остатка, в итоге. */
export function blankAccountDraft(state: Pick<BudgetState, "household">): AccountFormDraft {
  return { name: "", type: "current", currency: baseCurrencyOf(state), opening: "", negative: false, icon: null, tone: null, includeInTotal: true };
}

/** Форма записанного счёта: ключи оформления — только те, что эта сборка знает. */
export function accountDraftOf(account: Account): AccountFormDraft {
  return {
    name: account.name,
    type: account.type,
    currency: account.currency,
    opening: account.openingBalanceMinor === 0 ? "" : minorToInput(account.openingBalanceMinor, account.currency),
    negative: account.openingBalanceMinor < 0,
    icon: iconOfKey(Object.hasOwn(account, "icon") ? account.icon : undefined),
    tone: toneOfKey(Object.hasOwn(account, "color") ? account.color : undefined),
    includeInTotal: account.includeInTotal !== false,
  };
}

export type OpeningInput = { readonly kind: "amount"; readonly minor: number } | { readonly kind: "error"; readonly message: string };

/**
 * Начальный остаток из поля: пусто и ноль — ноль; иначе положительная сумма с не большим числом
 * знаков, чем у валюты счёта, и знак — из отметки «долг». Минус, набранный в поле, тоже понят.
 */
export function parseOpening(draft: Pick<AccountFormDraft, "opening" | "negative" | "currency">): OpeningInput {
  let text = draft.opening.trim();
  let negative = draft.negative;
  if (/^[-−]/u.test(text)) {
    negative = true;
    text = text.slice(1).trim();
  }
  if (text === "" || /^0+(?:[,.]0*)?$/u.test(text.replace(/\s/gu, ""))) return { kind: "amount", minor: 0 };
  let minor: number;
  try {
    minor = parseMoney(text, exponentOf(draft.currency));
  } catch (error) {
    return { kind: "error", message: error instanceof Error ? error.message : "Введите сумму числом." };
  }
  if (minor > MAX_MONEY_MINOR) return { kind: "error", message: "Начальный остаток — сумма не больше ста миллионов по модулю." };
  return { kind: "amount", minor: negative ? -minor : minor };
}

/** Отличается ли форма от снимка при открытии: остаток — по сумме, а не по написанию. */
export function accountDraftDiffers(left: AccountFormDraft, right: AccountFormDraft): boolean {
  if (left.name.trim() !== right.name.trim() || left.type !== right.type || left.currency !== right.currency
    || left.icon !== right.icon || left.tone !== right.tone || left.includeInTotal !== right.includeInTotal) return true;
  const a = parseOpening(left);
  const b = parseOpening(right);
  if (a.kind === "amount" && b.kind === "amount") return a.minor !== b.minor;
  return left.opening.trim() !== right.opening.trim() || left.negative !== right.negative;
}

/**
 * Правка счёта — только то, что человек изменил против снимка: поле, которое за это время поменяло
 * другое устройство, а здесь не трогали, остаётся тем, что пришло (D-031: последняя запись целого
 * счёта побеждает, и лишнее поле в правке переписало бы чужое).
 */
export function accountPatch(draft: AccountFormDraft, pristine: AccountFormDraft, openingMinor: number): AccountPatch {
  const pristineOpening = parseOpening(pristine);
  return {
    ...(draft.name.trim() !== pristine.name.trim() ? { name: draft.name } : {}),
    ...(draft.type !== pristine.type ? { type: draft.type } : {}),
    ...(draft.currency !== pristine.currency ? { currency: draft.currency } : {}),
    ...(pristineOpening.kind !== "amount" || pristineOpening.minor !== openingMinor ? { openingBalanceMinor: openingMinor } : {}),
    ...(draft.icon !== pristine.icon ? { icon: draft.icon } : {}),
    ...(draft.tone !== pristine.tone ? { color: draft.tone } : {}),
    ...(draft.includeInTotal !== pristine.includeInTotal ? { includeInTotal: draft.includeInTotal } : {}),
  };
}

export type AccountSave =
  | { readonly kind: "change"; readonly change: (state: BudgetState) => BudgetState; readonly created: () => string | null }
  | { readonly kind: "error"; readonly error: AccountFormError };

/**
 * Что записать по форме: новый счёт или правку записанного. Ошибка поля, которую видно без записи
 * (остаток не число), — сразу; всё остальное решает домен на настоящем состоянии.
 */
export function accountSave(
  draft: AccountFormDraft,
  target: { readonly account: Account; readonly pristine: AccountFormDraft } | null,
  makeId: () => string = () => crypto.randomUUID(),
): AccountSave {
  const opening = parseOpening(draft);
  if (opening.kind === "error") return { kind: "error", error: { field: "opening", message: opening.message } };
  if (target === null) {
    let createdId: string | null = null;
    return {
      kind: "change",
      change: (state) => {
        const created = createAccount(state, {
          name: draft.name,
          type: draft.type,
          currency: draft.currency,
          openingBalanceMinor: opening.minor,
          ...(draft.icon === null ? {} : { icon: draft.icon }),
          ...(draft.tone === null ? {} : { color: draft.tone }),
          includeInTotal: draft.includeInTotal,
        }, makeId);
        createdId = created.account.id;
        return created.state;
      },
      created: () => createdId,
    };
  }
  const patch = accountPatch(draft, target.pristine, opening.minor);
  return { kind: "change", change: (state) => updateAccount(state, target.account.id, patch), created: () => null };
}

const FIELD_OF: Readonly<Record<AccountValidationError["field"], AccountFormField>> = {
  name: "name",
  type: "type",
  currency: "currency",
  openingBalanceMinor: "opening",
  icon: "icon",
  color: "tone",
  includeInTotal: "includeInTotal",
  sortOrder: "form",
  id: "form",
};

/** Отказ записи — словами поля: доменный — у своего поля, задержка, конфликт и сбой — у формы. */
export function accountFormError(error: unknown): AccountFormError {
  if (error instanceof AccountValidationError) return { field: FIELD_OF[error.field], message: error.message };
  return { field: "form", message: writeFailureText(error) };
}

/**
 * Почему валюту счёта не сменить, — или `null`, пока на счёт ничто не ссылается. Счёт цели или плана
 * держится в базовой валюте (D-032), прочий — в той, в которой записаны его суммы.
 */
export function currencyLock(state: BudgetState, account: Account | null): string | null {
  if (account === null) return null;
  const references = accountReferences(state, account.id);
  if (references.length === 0) return null;
  if (references.includes("goals") || references.includes("plans")) {
    return `Валюту не сменить: по счёту есть ${accountReferenceWords(references)}. Цели и планы ведутся только в базовой валюте ${baseCurrencyOf(state)}.`;
  }
  return `Валюту не сменить: по счёту есть ${accountReferenceWords(references)}. Суммы записаны в ${account.currency}.`;
}

/** Строка списка счетов: имя, вид, валюта, остаток на сегодня в валюте счёта. */
export interface AccountRow {
  readonly account: Account;
  readonly icon: IconName;
  readonly tone: CategoryTone | null;
  /** Остаток на сегодня в валюте счёта; `null` — не представим. */
  readonly balanceMinor: number | null;
  /** «Карта или счёт · USD · вне итога» */
  readonly meta: string;
  /** Место среди активных, с единицы; у архивного — 0. */
  readonly position: number;
}

export interface AccountsList {
  readonly active: readonly AccountRow[];
  readonly archived: readonly AccountRow[];
}

export function accountsList(state: BudgetState, today: string): AccountsList {
  const balances = calculateHoldings(state, today).accountBalancesMinor;
  const base = baseCurrencyOf(state);
  const row = (account: Account, position: number): AccountRow => ({
    account,
    icon: accountIcon(account),
    tone: accountTone(account),
    balanceMinor: balances[account.id] ?? null,
    meta: [ACCOUNT_TYPE_WORDS[account.type], account.currency === base ? null : account.currency, account.includeInTotal === false ? "вне итога" : null]
      .filter((part): part is string => part !== null)
      .join(" · "),
    position,
  });
  const ordered = accountsInOrder(state.accounts);
  return {
    active: ordered.filter((account) => account.active).map((account, index) => row(account, index + 1)),
    archived: ordered.filter((account) => !account.active).map((account) => row(account, 0)),
  };
}
