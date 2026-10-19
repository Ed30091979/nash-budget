import {
  ACCOUNT_NAME_MAX_LENGTH,
  accountReferences,
  accountReferenceWords,
  accountsInOrder,
  AccountValidationError,
  baseCurrencyOf,
  calculateHoldings,
  convertMinor,
  createAccount,
  currencyExponent,
  findRate,
  isSupportedCurrency,
  MAX_MONEY_MINOR,
  updateAccount,
  type Account,
  type AccountPatch,
  type AccountType,
  type BudgetState,
  type CurrencyCode,
  type ExchangeRate,
} from "@family-budget/domain";
import { accountIcon, accountTone, iconOfKey, toneOfKey, type CategoryTone } from "../../category-visual";
import { currencyShortName } from "../../components/CurrencyPicker";
import type { IconName } from "../../components/Icon";
import { formatDay } from "../../date-words";
import { formatMoney, parseMoney } from "../../money";
import { writeFailureText } from "../../write/useBudgetWrite";
import { currencySign } from "../rates/RateQuickSheet";
import { formatRateValue, ratePer } from "../rates/rate-input";

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

/**
 * Форма счёта так, как её набирают: остаток — текстом, знак — отдельной отметкой.
 *
 * Дизайн 5.0 (макет 12): поле — «Сколько сейчас на счёте». У нового счёта это и есть начальный
 * остаток; у записанного — остаток на сегодня, и его правка сдвигает начальный остаток на ту же
 * разницу (`AccountTarget.offsetMinor`): остатки всех прошлых дней сдвигаются вместе с ним, и форма
 * говорит это суммой, как в 2c.
 */
export interface AccountFormDraft {
  readonly name: string;
  readonly type: AccountType;
  readonly currency: CurrencyCode;
  /** Сколько на счёте сейчас, без знака, как набрано: «12 500», «1250,50». Пусто — ноль. */
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

/**
 * Сколько движений по счёту набралось к сегодняшнему дню: остаток сегодня минус начальный. Правка
 * «Сколько сейчас» пишет начальный остаток как набранное минус эта разница; без представимого
 * остатка разницы нет — поле правит сам начальный остаток.
 */
export function accountOffset(state: BudgetState, account: Account, today: string): number {
  const balance = calculateHoldings(state, today).accountBalancesMinor[account.id];
  return balance === undefined || balance === null ? 0 : balance - account.openingBalanceMinor;
}

/**
 * Форма записанного счёта: ключи оформления — только те, что эта сборка знает. `offsetMinor` —
 * движения к сегодняшнему дню (`accountOffset`): поле показывает остаток сегодня.
 */
export function accountDraftOf(account: Account, offsetMinor = 0): AccountFormDraft {
  const shown = account.openingBalanceMinor + offsetMinor;
  return {
    name: account.name,
    type: account.type,
    currency: account.currency,
    opening: shown === 0 ? "" : minorToInput(shown, account.currency),
    negative: shown < 0,
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
 * счёта побеждает, и лишнее поле в правке переписало бы чужое). `shownMinor` — набранное «Сколько
 * сейчас», `offsetMinor` — движения к сегодняшнему дню: начальный остаток пишется, только если
 * набранное изменилось, и равен набранному минус движения.
 */
export function accountPatch(draft: AccountFormDraft, pristine: AccountFormDraft, shownMinor: number, offsetMinor = 0): AccountPatch {
  const pristineShown = parseOpening(pristine);
  return {
    ...(draft.name.trim() !== pristine.name.trim() ? { name: draft.name } : {}),
    ...(draft.type !== pristine.type ? { type: draft.type } : {}),
    ...(draft.currency !== pristine.currency ? { currency: draft.currency } : {}),
    ...(pristineShown.kind !== "amount" || pristineShown.minor !== shownMinor ? { openingBalanceMinor: shownMinor - offsetMinor } : {}),
    ...(draft.icon !== pristine.icon ? { icon: draft.icon } : {}),
    ...(draft.tone !== pristine.tone ? { color: draft.tone } : {}),
    ...(draft.includeInTotal !== pristine.includeInTotal ? { includeInTotal: draft.includeInTotal } : {}),
  };
}

/** Записанный счёт, открытый в форме: снимок полей при открытии и движения к сегодняшнему дню. */
export interface AccountTarget {
  readonly account: Account;
  readonly pristine: AccountFormDraft;
  /** `accountOffset` при открытии; без него поле правит сам начальный остаток. */
  readonly offsetMinor?: number;
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
  target: AccountTarget | null,
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
  const patch = accountPatch(draft, target.pristine, opening.minor, target.offsetMinor ?? 0);
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
  /** Тот же остаток в базовой валюте — у счёта в другой валюте с курсом на сегодня; иначе `null`. */
  readonly baseMinor: number | null;
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
  const holdings = calculateHoldings(state, today);
  const balances = holdings.accountBalancesMinor;
  const base = baseCurrencyOf(state);
  // Остаток в базе — тот, которым его оценивает итог (`calculateHoldings`): у счёта вне итога тоже.
  const inBase = (account: Account): number | null => (account.currency === base ? null : holdings.accountBalancesInBaseMinor[account.id] ?? null);
  const row = (account: Account, position: number): AccountRow => ({
    account,
    icon: accountIcon(account),
    tone: accountTone(account),
    balanceMinor: balances[account.id] ?? null,
    baseMinor: inBase(account),
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

/** Курс, по которому «Всего на счетах» оценивает валюту: «доллары — по курсу 92,50 ₽ от 15 октября». */
export interface TotalRate {
  readonly currency: CurrencyCode;
  readonly rate: ExchangeRate;
}

/**
 * «Всего на счетах» над списком (макет 11): итог в базовой валюте — тот же, что у итога «Обзора»
 * (`calculateHoldings`, счета с `includeInTotal !== false`, архивные тоже), — курсы, по которым он
 * оценил чужие валюты, и счета, которые оценить не смог: их итог называет, а не выбрасывает молча.
 */
export interface AccountsTotal {
  readonly totalInBaseMinor: number;
  readonly base: CurrencyCode;
  readonly rates: readonly TotalRate[];
  readonly unvalued: readonly { readonly name: string; readonly currency: CurrencyCode }[];
}

export function accountsTotal(state: BudgetState, today: string): AccountsTotal {
  const holdings = calculateHoldings(state, today);
  const base = baseCurrencyOf(state);
  const unvalued = new Set(holdings.unvaluedAccountIds);
  const counted = accountsInOrder(state.accounts).filter((account) => account.includeInTotal !== false);
  const currencies = [...new Set(counted.filter((account) => account.currency !== base && !unvalued.has(account.id)).map((account) => account.currency))];
  return {
    totalInBaseMinor: holdings.totalInBaseMinor,
    base,
    rates: currencies.flatMap((currency) => {
      const rate = findRate(state.exchangeRates ?? [], currency, base, today);
      return rate === undefined ? [] : [{ currency, rate }];
    }),
    unvalued: counted.filter((account) => unvalued.has(account.id)).map((account) => ({ name: account.name, currency: account.currency })),
  };
}

/** «92,50 ₽» или «18,40 ₽ за 100» — курс так, как его набирают, со знаком базы. */
function rateValueWords(rate: ExchangeRate): string {
  const per = ratePer(rate.currency);
  const value = `${formatRateValue(rate.rate, rate.currency, rate.baseCurrency, per)}\u00a0${currencySign(rate.baseCurrency)}`;
  return per === 1 ? value : `${value} за\u00a0${per}`;
}

/** «доллар — по курсу 92,50 ₽ от 15 октября»: строка под «Всего на счетах». */
export function totalRateWords({ currency, rate }: TotalRate): string {
  return `${currencyShortName(currency).toLocaleLowerCase("ru-RU")} — по курсу ${rateValueWords(rate)} от ${formatDay(rate.date)}`;
}

/** Набранный остаток в базовой валюте и слова о нём. */
export interface AccountEstimate {
  readonly inBaseMinor: number;
  /** «≈ 111 000 ₽ по курсу 92,50 ₽ от 15 октября» */
  readonly words: string;
}

/**
 * Пересчёт набранного остатка в базу (макет 12): «≈ 111 000 ₽ по курсу 92,50 ₽ от 15 октября». У
 * счёта в базовой валюте пересчёта нет; без курса на сегодня — `null`, и форма говорит о курсе словами.
 */
export function accountEstimate(state: BudgetState, currency: CurrencyCode, minor: number, today: string): AccountEstimate | null {
  const base = baseCurrencyOf(state);
  if (currency === base) return null;
  const rate = findRate(state.exchangeRates ?? [], currency, base, today);
  if (rate === undefined) return null;
  let inBase: number;
  try {
    inBase = convertMinor(minor, rate.rate);
  } catch {
    return null;
  }
  return { inBaseMinor: inBase, words: `≈ ${formatMoney(inBase, base)} по курсу ${rateValueWords(rate)} от ${formatDay(rate.date)}` };
}
