import {
  canBeBaseCurrency,
  categoryNameKey,
  DEFAULT_BASE_CURRENCY,
  DEFAULT_EXPENSE_CATEGORIES,
  makeDefaultCategories,
  monthEndDate,
  monthOfDate,
  monthStartDate,
  setBaseCurrency,
  type Account,
  type BudgetState,
  type Category,
  type CurrencyCode,
} from "@family-budget/domain";
import { type CreateIfAbsentResult } from "@family-budget/storage";

/*
 * Первый запуск без анкеты (дизайн v5, DIRECTION §e).
 *
 * Три слайда — и сразу «Обзор» с готовым набором, который создаётся молча: два счёта, доход
 * «Зарплата», двенадцать частых категорий, валюта по языку устройства и месяц плана. Ни одного
 * поля: «Для себя / пары / семьи» убран — этот выбор не менял ни одного числа, синхронизация в
 * сборках выключена, а семья живёт в «Ещё». Остальное спрашивают по одному вопросу поверх «Обзора»
 * (`features/onboarding-questions/`), и каждый вопрос можно пропустить.
 *
 * Названия плана в модели нет: прежний онбординг вклеивал его в имя счёта («Для семьи · Наш
 * бюджет · Основной счёт»). Набор этого больше не делает, и «Наш бюджет» остаётся маркой
 * приложения на слайдах и значке.
 */

export type IdFactory = () => string;

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** Счета набора, в порядке плиток: карта — основной счёт, с неё записывается расход. */
export const PRESET_ACCOUNTS: readonly { readonly name: string; readonly type: Account["type"] }[] = [
  { name: "Карта", type: "current" },
  { name: "Наличные", type: "cash" },
];

/** Единственный активный источник дохода набора; остальные стартовые — в архиве до выбора. */
export const PRESET_INCOME = "Зарплата";

/**
 * Двенадцать категорий набора (§e), в порядке листа «На что вы тратите?». Остальные три стартовые
 * — «Кредиты и рассрочки», «Дети», «Красота и уход» — заводятся в архиве: лист чипов предлагает их
 * вернуть одним касанием, и ни один выбор не плодит тёзку.
 */
export const PRESET_EXPENSES: readonly string[] = [
  "Продукты",
  "Кафе и доставка",
  "Транспорт",
  "Дом и хозяйство",
  "Жильё",
  "ЖКХ",
  "Связь и подписки",
  "Здоровье и аптека",
  "Одежда и обувь",
  "Развлечения и хобби",
  "Подарки и праздники",
  "Прочее",
];

/** Категория, которая есть всегда: чипы её не показывают и в архив не убирают. */
export const ALWAYS_ACTIVE_EXPENSE = "Прочее";

/** Стартовые расходные категории, которых нет в наборе: они лежат в архиве до выбора. */
export const ARCHIVED_STARTERS: readonly string[] = DEFAULT_EXPENSE_CATEGORIES
  .map((template) => template.name)
  .filter((name) => !PRESET_EXPENSES.some((preset) => categoryNameKey(preset) === categoryNameKey(name)));

/*
 * Валюта набора (§e; решение ревью R2, L-3). Аудитория — Россия: по умолчанию рубль, и русский с
 * английским телефоном молча долларов не получает. Другая валюта — только по явному признаку:
 * регион в теге языка, у которого своя валюта с двумя знаками после запятой (`ru-KZ`, `en-US`,
 * `de-DE`), или язык, который сам говорит о стране, — казахский (тенге) и белорусский (белорусский
 * рубль). Тег без региона (`en`, `de`, `zh`, `es`, `pt`) — рубль: страну по языку не угадать.
 * Базовой бывает только валюта с двумя знаками (D-031, `canBeBaseCurrency`): иена, вона, донг и
 * исландская крона дают рубль. Выбрать свою валюту можно на первом листе вопросов, пока бюджет пуст.
 */
const LANGUAGE_CURRENCY: Readonly<Record<string, CurrencyCode>> = { kk: "KZT", be: "BYN" };

const EURO_REGIONS = ["AT", "BE", "BG", "CY", "DE", "EE", "ES", "FI", "FR", "GR", "HR", "IE", "IT", "LT", "LU", "LV", "MT", "NL", "PT", "SI", "SK"] as const;

/** Регион тега — валюта страны. Только явный регион: вероятный регион языка не угадывается. */
export const REGION_CURRENCY: Readonly<Record<string, CurrencyCode>> = {
  RU: "RUB", BY: "BYN", KZ: "KZT", UA: "UAH", UZ: "UZS", KG: "KGS", TJ: "TJS", TM: "TMT", AM: "AMD", AZ: "AZN", GE: "GEL", MD: "MDL",
  US: "USD", GB: "GBP", CA: "CAD", AU: "AUD", CH: "CHF", PL: "PLN", CZ: "CZK", SE: "SEK", NO: "NOK", DK: "DKK", HU: "HUF",
  RS: "RSD", RO: "RON", TR: "TRY", IL: "ILS", AE: "AED", CN: "CNY", IN: "INR", TH: "THB",
  JP: "JPY", KR: "KRW", VN: "VND", IS: "ISK",
  ...Object.fromEntries(EURO_REGIONS.map((region) => [region, "EUR"])),
};

/** Язык и явный регион тега BCP 47 (`ru-KZ` → ru, KZ; `en` → en, без региона). */
function localeParts(tag: string): { readonly language: string; readonly region: string | null } | null {
  try {
    const locale = new Intl.Locale(tag.replace(/_/gu, "-"));
    return { language: locale.language.toLowerCase(), region: locale.region?.toUpperCase() ?? null };
  } catch {
    return null;
  }
}

/** Базовая валюта набора по тегу языка устройства (`navigator.language`). */
export function currencyForLocale(tag: string | null | undefined): CurrencyCode {
  if (typeof tag !== "string" || tag.trim() === "") return DEFAULT_BASE_CURRENCY;
  const parts = localeParts(tag.trim());
  if (parts === null) return DEFAULT_BASE_CURRENCY;
  const byRegion = parts.region !== null && Object.hasOwn(REGION_CURRENCY, parts.region) ? REGION_CURRENCY[parts.region] : undefined;
  if (byRegion !== undefined && canBeBaseCurrency(byRegion)) return byRegion;
  const byLanguage = Object.hasOwn(LANGUAGE_CURRENCY, parts.language) ? LANGUAGE_CURRENCY[parts.language] : undefined;
  if (byLanguage !== undefined && canBeBaseCurrency(byLanguage)) return byLanguage;
  return DEFAULT_BASE_CURRENCY;
}

/** Язык этого устройства, если браузер его называет. */
export function deviceLanguage(): string | null {
  return typeof navigator === "undefined" ? null : navigator.language ?? null;
}

export interface PresetOptions {
  /** Сегодня по календарю семьи (`localToday`): месяц плана — этот. */
  readonly today: string;
  readonly currency?: CurrencyCode;
  readonly makeId?: IdFactory;
}

/**
 * Готовый набор первого запуска — тем же путём, каким бюджет создавал прежний онбординг: один
 * период на текущий месяц, открытый, с порогом «почти лимит» 80 %, — поэтому вся логика плана,
 * переноса месяца и «Года» работает как прежде. Лимитов и плана дохода нет: «Можно тратить» честно
 * говорит «лимитов нет», пока человек их не задаст. Стартовые категории домена заводятся все, а
 * лишние — сразу в архиве: выбор чипа возвращает ту же строку, а не создаёт вторую.
 */
export function buildOnboardingBudgetState({ today, currency = DEFAULT_BASE_CURRENCY, makeId = () => crypto.randomUUID() }: PresetOptions): BudgetState {
  if (!canBeBaseCurrency(currency)) throw new Error("Базовой может быть только валюта с двумя знаками после запятой.");
  const issued = new Set<string>();
  const id = (): string => {
    const next = makeId();
    if (!UUID_PATTERN.test(next) || issued.has(next)) throw new Error("Не удалось создать уникальные идентификаторы.");
    issued.add(next);
    return next;
  };

  const accounts: Account[] = PRESET_ACCOUNTS.map((account, index) => ({
    id: id(),
    name: account.name,
    type: account.type,
    currency: DEFAULT_BASE_CURRENCY,
    openingBalanceMinor: 0,
    active: true,
    sortOrder: (index + 1) * 10,
  }));
  const budgetId = id();
  const preset = new Set([...PRESET_EXPENSES, PRESET_INCOME].map(categoryNameKey));
  // Порядок внутри группы — порядок набора (D-041): «Продукты», «Кафе и доставка», «Транспорт»,
  // «Дом и хозяйство»… Стартовые в архиве встают следом: вернувшись, они не обгоняют выбранные.
  const presetOrder = (name: string) => PRESET_EXPENSES.findIndex((item) => categoryNameKey(item) === categoryNameKey(name));
  const categories: Category[] = makeDefaultCategories(id).map((category, index) => {
    const order = category.type === "expense" ? presetOrder(category.name) : -1;
    const sortOrder = category.type !== "expense" ? category.sortOrder : order === -1 ? (PRESET_EXPENSES.length + index + 1) * 10 : (order + 1) * 10;
    return preset.has(categoryNameKey(category.name)) ? { ...category, sortOrder } : { ...category, sortOrder, active: false };
  });
  const month = monthOfDate(today);

  const state: BudgetState = {
    activeBudgetId: budgetId,
    accounts,
    categories,
    budgets: [{
      id: budgetId,
      startDate: monthStartDate(month),
      endDate: monthEndDate(month),
      status: "open",
      plannedIncomeMinor: 0,
      warningThreshold: 0.8,
      lines: [],
    }],
    goals: [],
    annualCommitments: [],
    scheduledExpenses: [],
    transactions: [],
  };
  // Рубль — база по умолчанию и записи хозяйства не требует; другая валюта ставится доменом, пока
  // бюджет пуст, и счета набора переходят в неё вместе с ней.
  return currency === DEFAULT_BASE_CURRENCY ? state : setBaseCurrency(state, currency);
}

export interface OnboardingRepository {
  createIfAbsent(state: BudgetState): Promise<CreateIfAbsentResult<BudgetState>>;
}

/** Publishes the atomic winner only after create-if-empty has completed successfully. */
export async function persistCompletedOnboarding(
  repository: OnboardingRepository,
  state: BudgetState,
  prepare: (state: BudgetState) => BudgetState,
  publish: (state: BudgetState) => void,
): Promise<CreateIfAbsentResult<BudgetState>> {
  const result = await repository.createIfAbsent(state);
  const value = prepare(result.value);
  const preparedResult: CreateIfAbsentResult<BudgetState> = { status: result.status, value };
  publish(value);
  return preparedResult;
}

export interface AsyncOperationLock {
  readonly locked: boolean;
  run(operation: () => Promise<void>): Promise<boolean>;
}

export type OnboardingFailureKind = "save" | "demo";

/** User-facing failures never interpolate storage, browser, or validation exception details. */
export function onboardingFailureMessage(kind: OnboardingFailureKind): string {
  return kind === "save"
    ? "Не удалось сохранить бюджет."
    : "Не удалось загрузить пример.";
}

/** A synchronous acquire gate prevents two UI events from starting overlapping writes. */
export function createAsyncOperationLock(): AsyncOperationLock {
  let locked = false;
  return {
    get locked() {
      return locked;
    },
    async run(operation) {
      if (locked) return false;
      locked = true;
      try {
        await operation();
        return true;
      } finally {
        locked = false;
      }
    },
  };
}
