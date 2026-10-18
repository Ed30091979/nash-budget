# План волны 1: модель данных v3 (паритет с CoinKeeper)

Статус: утверждён оркестратором 18.10.2026 как техническое задание волны 1. Базовый SHA: `2136fee` (ветка `fix/clean-install-and-deps`, PR #1). Номера строк — на этом SHA.
Волна 1 — только модель данных, хранилище, копия, журнал синхронизации, контракты и тесты. Интерфейс не меняется (кроме обязательных правок закрытых наборов `Record`/`satisfies` и сохранения полей при правке операции).

## 0. Находки в коде, которые меняют исходные решения

1. Схему состояния фактически проверяет `apps/web-pwa/src/backup.ts` → `prepareBudgetState` (390–411): вызывается при восстановлении копии, миграции v1 (`storage-repository.ts:16`) и при каждой загрузке/записи документа (`App.tsx:212, 222, 231, 237, 470`). «Старые данные открываются» = `prepareBudgetState` принимает каждое состояние эпохи 1.0.0 без правок. Сейчас пропускает только RUB (`requireEnum(account.currency, ["RUB"])`, :170).
2. `StoredDocument.schemaVersion` при загрузке не читается (`indexed-db.ts:390–517` проверяют только `revision`; номер сравнивается лишь в `migrateV1ToV2`, :186).
3. Балансы счетов и капитал в `BudgetMetrics` считаются только внутри окна бюджета (`calculate.ts:374` — `if (... !isWithinBudget(...)) continue;` до изменения балансов). Смысл `capitalMinor` не меняем; вводим отдельную накопительную метрику `calculateHoldings`. Какую цифру показывать в UI — решение владельца.
4. `editTransaction` пересобирает операцию из полей формы (`operations/model.ts:241–327, 413–444`) и уже сейчас теряет `memberId` (противоречит D-021 и `codec.ts:495–503`). После волны терялись бы `note`, `tagIds`, `recurringRuleId`, валютный снимок. Исправляется в волне 1 (сохранность данных).
5. Литеральные NUL-байты: `rollover.ts:80` (`KEY_SEPARATOR`), `categories.ts:368, 373`, `sync-protocol/tests/codec.test.ts:209`, `sync-crypto/tests/no-leak.test.ts` (1 шт.). Первый коммит заменяет их на `"\u0000"` без изменения смысла; вывод `carriedId` закрепляется тестом.
6. Решение «у категории нет иконки/цвета» записано в `apps/web-pwa/src/category-visual.ts:5–19`; волна его отменяет — запись в `DECISIONS.md`, карта по имени остаётся запасным видом.
7. Закрытые наборы держатся через `Record<…>`/`satisfies`; новое значение `TransactionKind`, `EntityKind`, причины удержания обязано в том же коммите попасть в: `data-management/model.ts:34`, `transaction-words.ts:12, 22, 58–67`, `OperationsScreen.tsx:115, 209–242`, `family/news.ts:106–120`, `family/model.ts:195–215`, `journal.ts:665–703, 864–898`.

### Отступления от решений по умолчанию

| По умолчанию | Принято | Основание |
|---|---|---|
| Долги: lend/borrow/repay ×2 | Два вида `debt_out` (ушло со счёта) и `debt_in` (пришло на счёт); смысл задаёт `debt.direction`; в UI четыре глагола | Нет нового несогласованного состояния при смене направления в пути |
| `Goal.targetDate` | `Goal.deadline` | Так поле названо в каноническом контракте (`budget-fixture.schema.json`, `contracts/README.md:13`) |
| Базовая валюта — скаляр | Сущность `Household { id, baseCurrency }` с выведенным `HOUSEHOLD_ID` | Журналу нужна сущность с id (`SYNC_ARCHITECTURE.md` §2.3); `household.baseCurrency` уже в контракте |
| Курсы с выведенными id | `randomUUID`, дубли «валюта+дата» допустимы, выбор детерминирован (max дата ≤ d, при равенстве max id) | Тумбстоун не отменяется (`journal.ts:1411–1418`) |
| Валюта не влияет на `capitalMinor` | `capitalMinor` = сумма балансов счетов в базовой валюте; `includeInTotal` его не трогает | Иначе складываются копейки с центами; для существующих документов (все RUB) значение то же |
| Планы в любой валюте | Цели, крупные платежи, расписания — только счета в базовой валюте | `calculateAnnualPlan` (708–841) суммирует без конвертации |

## 1. Домен

### 1.1 `packages/domain/src/types.ts`

```ts
export type TagId = StableId;
export type DebtId = StableId;
export type RecurringRuleId = StableId;
export type ExchangeRateId = StableId;
export type HouseholdId = StableId;
/** ISO 4217, только из SUPPORTED_CURRENCIES (currency.ts). */
export type CurrencyCode = string;
/** Ключ токена оформления: kebab-case, ≤ 40 символов. Не hex и не имя файла. */
export type DisplayKey = string;

export interface Household { readonly id: HouseholdId; readonly baseCurrency: CurrencyCode; } // id всегда HOUSEHOLD_ID

export interface Account {               // :65–72
  /* …как сейчас… */
  readonly sortOrder?: number;           // безопасное целое
  readonly icon?: DisplayKey;
  readonly color?: DisplayKey;
  /** Нет поля ⇒ true. Читает только calculateHoldings, capitalMinor — нет. */
  readonly includeInTotal?: boolean;
}
export interface Category { /* :74–82 */ readonly icon?: DisplayKey; readonly color?: DisplayKey; }
export interface Goal     { /* :121–129 */ readonly deadline?: LocalDate; readonly icon?: DisplayKey; }

export interface Tag { readonly id: TagId; readonly name: string; readonly active: boolean; }

export type DebtDirection = "i_owe" | "owed_to_me";
export interface Debt {
  readonly id: DebtId;
  readonly counterparty: string;
  readonly direction: DebtDirection;     // не меняется, пока есть операции
  readonly currency: CurrencyCode;
  readonly openingMinor: MinorUnits;     // ≥ 0, в валюте долга
  readonly dueDate?: LocalDate;
  readonly active: boolean;
}

/** quoteMinor минимальных единиц котируемой валюты стоят baseMinor минимальных единиц базовой. */
export interface ExchangeRateValue { readonly baseMinor: MinorUnits; readonly quoteMinor: MinorUnits; }
export interface ExchangeRate {
  readonly id: ExchangeRateId;
  readonly currency: CurrencyCode;       // ≠ baseCurrency
  readonly baseCurrency: CurrencyCode;
  readonly date: LocalDate;
  readonly rate: ExchangeRateValue;
}

export type TransactionKind = /* :47–52 */ … | "debt_out" | "debt_in";

interface BaseTransaction {              // :158–169
  /* …как сейчас… */
  readonly note?: string;                // normalizeNote; пустой заметки нет — есть отсутствие поля
  readonly tagIds?: readonly TagId[];    // уникальные, 1…10; пустого массива нет — есть отсутствие поля
  readonly recurringRuleId?: RecurringRuleId; // метка, её не читает ни один показатель
}
/** Снимок в базовой валюте. Три поля вместе или ни одного. */
interface BaseAmountSnapshot {
  readonly baseAmountMinor?: MinorUnits;
  readonly baseCurrency?: CurrencyCode;
  readonly rate?: ExchangeRateValue;
}
export interface IncomeTransaction  extends BaseTransaction, BaseAmountSnapshot { /* :171–182 */ }
export interface ExpenseTransaction extends BaseTransaction, BaseAmountSnapshot { /* :184–188 */ }
export interface RefundTransaction  extends BaseTransaction, BaseAmountSnapshot { /* :190–195 */ }
export interface TransferTransaction extends BaseTransaction {  /* :197–201 */
  /** Зачислено в валюте toAccount. Обязательно тогда и только тогда, когда валюты счетов различны. */
  readonly toAmountMinor?: MinorUnits;
}
interface DebtMovement extends BaseTransaction {
  readonly accountId: AccountId;
  readonly debtId: DebtId;
  /** В валюте долга. Обязательно тогда и только тогда, когда валюта счёта ≠ валюте долга. */
  readonly debtAmountMinor?: MinorUnits;
}
/** Ушло со счёта: «дал в долг» (owed_to_me) или «вернул долг» (i_owe). */
export interface DebtOutTransaction extends DebtMovement { readonly kind: "debt_out"; }
/** Пришло на счёт: «взял в долг» (i_owe) или «мне вернули» (owed_to_me). */
export interface DebtInTransaction  extends DebtMovement { readonly kind: "debt_in"; }
export type Transaction = /* :210–215 */ … | DebtOutTransaction | DebtInTransaction;

export type RecurrenceFrequency = "daily" | "weekly" | "monthly" | "yearly";
interface RecurringTemplateBase { readonly amountMinor: MinorUnits; readonly note?: string; readonly tagIds?: readonly TagId[]; }
export interface RecurringExpenseTemplate  extends RecurringTemplateBase { readonly kind: "expense"; readonly accountId: AccountId; readonly categoryId: CategoryId; }
export interface RecurringIncomeTemplate   extends RecurringTemplateBase { readonly kind: "income";  readonly accountId: AccountId; readonly categoryId?: CategoryId; }
export interface RecurringTransferTemplate extends RecurringTemplateBase { readonly kind: "transfer"; readonly fromAccountId: AccountId; readonly toAccountId: AccountId; readonly toAmountMinor?: MinorUnits; }
export type RecurringTemplate = RecurringExpenseTemplate | RecurringIncomeTemplate | RecurringTransferTemplate;
export interface RecurringRule {
  readonly id: RecurringRuleId;
  readonly name?: string;
  readonly template: RecurringTemplate;  // без ключа "id": общий guard копии ловит повтор "id" во всём payload
  readonly frequency: RecurrenceFrequency;
  readonly interval: number;             // целое 1…999
  readonly startDate: LocalDate;
  readonly endDate?: LocalDate;          // включительно, ≥ startDate
  /** Водяной знак: вхождения ≤ этой даты больше не создаются, даже удалённые. */
  readonly materializedThrough?: LocalDate;
  readonly active: boolean;
}

export interface BudgetState {           // :217–228; новые коллекции необязательны, как members
  /* …как сейчас… */
  readonly household?: Household;        // нет ⇒ база "RUB"
  readonly tags?: readonly Tag[];
  readonly debts?: readonly Debt[];
  readonly recurringRules?: readonly RecurringRule[];
  readonly exchangeRates?: readonly ExchangeRate[];
}
```

Новые коллекции **не нормализуются в `[]`** (как `members`, `backup.ts:154`): документ не получает новых ключей при первой записи. Форма `BudgetMetrics` (:249–262) не меняется.

Новые метрики:

```ts
export interface DebtBalanceMetrics {
  readonly debtId: DebtId; readonly direction: DebtDirection; readonly currency: CurrencyCode;
  readonly outMinor: MinorUnits; readonly inMinor: MinorUnits;
  /** owed_to_me: opening + out − in; i_owe: opening + in − out. Может быть < 0 (переплата). */
  readonly balanceMinor: MinorUnits;
  readonly balanceInBaseMinor: MinorUnits | null;   // null — нет курса или переполнение
  readonly overdue: boolean;                         // dueDate < asOf и balance > 0
}
export interface DebtMetrics {
  readonly asOf: LocalDate; readonly baseCurrency: CurrencyCode;
  readonly debts: readonly DebtBalanceMetrics[]; readonly byDebt: Readonly<Record<DebtId, DebtBalanceMetrics>>;
  readonly receivableInBaseMinor: MinorUnits; readonly payableInBaseMinor: MinorUnits;
  readonly netInBaseMinor: MinorUnits; readonly unvaluedDebtIds: readonly DebtId[];
}
export interface HoldingsMetrics {
  readonly asOf: LocalDate; readonly baseCurrency: CurrencyCode;
  readonly accountBalancesMinor: Readonly<Record<AccountId, MinorUnits>>;            // накопительно ≤ asOf, в валюте счёта
  readonly accountBalancesInBaseMinor: Readonly<Record<AccountId, MinorUnits | null>>;
  readonly totalInBaseMinor: MinorUnits;            // счета с includeInTotal !== false и известной оценкой
  readonly unvaluedAccountIds: readonly AccountId[];
  readonly debts: DebtMetrics;
  readonly netWorthInBaseMinor: MinorUnits;         // total + receivable − payable
}
export interface TagMetrics { readonly tagId: TagId; readonly incomeMinor: MinorUnits; readonly expenseMinor: MinorUnits; readonly refundMinor: MinorUnits; readonly actualMinor: MinorUnits; readonly transactionCount: number; }
export interface TagBreakdown { readonly budgetId: BudgetId; readonly tags: readonly TagMetrics[]; readonly byTag: Readonly<Record<TagId, TagMetrics>>; }
```

### 1.2 Новые модули домена

- **`identity.ts`.** Сюда переезжают `carriedId`, `fnv1a`, `avalanche` из `rollover.ts:80–130` (`rollover.ts` реэкспортирует) — иначе цикл currency → rollover → calculate → currency. Здесь же `documentIds(state)` (полная перепись id, включая новые коллекции; для `assertFreshIds` `rollover.ts:283–298`, материализации, копий в `operations/model.ts:102–120`, `planning/model.ts:129`), `HOUSEHOLD_ID = carriedId("household")`, `recurringOccurrenceId(ruleId, date) = carriedId("recurringOccurrence", ruleId, date)` (UUIDv8, проходит `UUID_PATTERN` `backup.ts:32`).
- **`text.ts`.** Одно правило текста вместо трёх копий (`categories.ts:161, 203–219`, `planning/model.ts:26`, `onboarding/model.ts:66`):
  - `normalizeLabel(value, max)` — правила `normalizeCategoryName` (NFC, trim, запрет `\p{Cc}\p{Bidi_Control}\p{Default_Ignorable_Code_Point}`, запрет смешения алфавитов) **плюс** запрет U+2028/2029, U+FFF9–FFFB и одиночных суррогатов, чтобы правило домена было строго шире `UNSAFE_TEXT` кодека (`codec.ts:125–126`).
  - `normalizeNote(value)` — то же без правила смешения алфавитов; удаляет U+FE0E/FE0F; пустая строка → `undefined`.
  - Предикаты `isNormalizedNote`, `isNormalizedLabel`, `isDisplayKey` (`/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/`, ≤ 40).
  - Константы: `NOTE_MAX_LENGTH = 500` (= `BACKUP_LIMITS.textLength`), `TAG_NAME_MAX_LENGTH = 40`, `COUNTERPARTY_MAX_LENGTH = 80`, `MAX_TAGS_PER_TRANSACTION = 10`.
  - `categories.ts` вызывает `normalizeLabel`, сохраняя свои коды и тексты ошибок.
- **`calendar.ts`.** `dayIndex(date)`, `dateFromDayIndex(n)`, `addDays(date, n)` — days-from-civil, без `Date` (в духе :3–14).
- **`currency.ts`.** `DEFAULT_BASE_CURRENCY = "RUB"`; `SUPPORTED_CURRENCIES` — замороженная таблица `код → exponent` по ISO 4217 без X-кодов и фондов (exponent не меняется никогда, тест фиксирует; разрешено только добавлять коды); `isSupportedCurrency`, `currencyExponent`, `baseCurrencyOf(state)`; `convertMinor(amount, rate)` в BigInt, half-up (как правило 9 `contracts/README.md:49`), небезопасный результат → ошибка; `findRate(rates, currency, base, onDate)` — max дата ≤ onDate, при равенстве max id, курсы с другой базой игнорируются; границы `1 ≤ baseMinor, quoteMinor ≤ 10^12`.
- **`tags.ts`.** `createTag`, `archiveTag`; `deleteTag(state, id)` удаляет id из `tagIds` операций и шаблонов одним переходом; `normalizeTagIds` — без дублей, сортировка.
- **`debts.ts`.** `calculateDebts(state, asOf)` — накопительно, только `posted` с `occurredOn ≤ asOf`; архивный долг входит в итоги; `deleteDebt` отказывает при ссылках (предлагается архив).
- **`recurring.ts`.**
  - `occurrenceDates(rule, after, through)`: monthly/yearly каждое вхождение от `startDate` — `shiftDate(startDate, k·interval[·12])` (`calendar.ts:83–87`): 31.01 → 28.02 → 31.03 без дрейфа, 29.02 в невисокосный → 28.02; daily/weekly — `addDays`.
  - `materializeRecurring(state, through, { maxPerRule = 400 })` → `{ state, created, skipped: {ruleId, date, reason}[] }`, причины `missing_rate | archived_account | archived_category | limit`. Только `active` правила; даты из `(materializedThrough ?? startDate−1, min(through, endDate)]`; существующий id пропускается; снимок для не-базового счёта по `findRate(…, date)`; создаётся `status: "posted"` с `recurringRuleId`; водяной знак = `through`, при `missing_rate` — день до первого пропуска; итог проверяется `indexState`, коллизия выведенного id → ошибка (как `assertFreshIds`).
  - `deleteRecurringRule` снимает `recurringRuleId` с операций.
- **`holdings.ts`.** `calculateHoldings(state, asOf)`; переполнение/нет курса → `null` + `unvalued…`, без исключений.
- **`calculate.ts`.** `calculateTagExpenses(state, budgetId)` по образцу `calculateMemberExpenses`; операция с двумя метками входит в обе.

### 1.3 Инварианты (`indexState`; домен строгий, как сейчас)

| Что | Правило |
|---|---|
| household | `id === HOUSEHOLD_ID`, `baseCurrency` поддерживается |
| account | `currency` поддерживается; `sortOrder` безопасное целое; `icon`/`color` — `isDisplayKey`; `includeInTotal` boolean |
| category | `icon`/`color` — `isDisplayKey` |
| goal | `deadline` — дата; `icon` — ключ; связанный счёт в базовой валюте |
| annualCommitment / scheduledExpense | счёт в базовой валюте (`validateAnnualCommitment :661`, `validateScheduledExpense :677`) |
| tag | `name` — `isNormalizedLabel(·, 40)`; `active` boolean; уникальность имён обеспечивает `createTag` |
| debt | `counterparty` — `isNormalizedLabel(·, 80)`; enum направления; валюта поддерживается; `openingMinor ≥ 0`; `dueDate` — дата |
| exchangeRate | обе валюты поддерживаются и различны; дата; части курса в `[1, 10^12]` |
| recurringRule | шаблон по правилам операции (ссылки, тип категории, метки, заметка, `amount > 0`, разные счета перевода, `toAmountMinor` ⇔ валюты различны); `interval` 1…999; `endDate ≥ startDate` |
| любая операция | `note` — `isNormalizedNote`, ≤ 500; `tagIds` уникальны, 1…10, существуют (архивный допустим); `recurringRuleId` существует |
| income/expense/refund | A — валюта счёта, B — база. `A === B` ⇒ снимка нет; `A ≠ B` ⇒ все три поля, `snapshot.baseCurrency === B`, `baseAmountMinor > 0` |
| transfer | `toAmountMinor` ⇔ валюты счетов различны |
| goal_contribution | валюты обоих счетов равны |
| debt_out/debt_in | счёт и долг существуют; `debtAmountMinor` ⇔ валюты различны; снимка нет |

`validateTransactionReferences` (`calculate.ts:241–321`) получает индекс целиком; `assertEnum` на :249 расширяется.

## 2. Расчёты (`calculate.ts`)

1. `indexState(state)` заменяет повторную индексацию (`:327–335`, `:536–547`, `:720–733`). Участники по-прежнему проверяются только в `calculateMemberExpenses`, планы — только в плане на год, чтобы набор ошибок каждой функции не изменился.
2. `calculateBudget`, цикл `:372–425`: income/expense/refund — в итоги и метрики категорий идёт `baseAmountOf(tx)` (`amountMinor` при `A === B`, иначе `baseAmountMinor`); таблица курсов **не читается**. Баланс счёта ± `amountMinor` в валюте счёта. transfer: с `from` −`amountMinor`, на `to` +(`toAmountMinor ?? amountMinor`). `debt_out`/`debt_in`: баланс ∓/± `amountMinor`; не доход и не расход (правило 4 `contracts/README.md:44`). `capitalMinor` (`:460–463`) — сумма балансов **счетов в базовой валюте**.
3. `calculateMemberExpenses` (`:576–596`): те же базовые суммы (инвариант `attributedMinor + unattributed.actualMinor === expensesMinor`).
4. `calculateAnnualPlan`: формулы не меняются, только проверка «планы в базе».
5. Новые функции отдельно от `BudgetMetrics` (прецедент D-021): `calculateDebts`, `calculateHoldings`, `calculateTagExpenses`.

**Байт-в-байт неизменны:** `g-000/1/2.json`, `budget-fixture.schema.json`, `planning-fixture.schema.json`, вывод `tools/build-family-budget.mjs`; G-001 (доход 10 000 000, расход 7 650 000, капитал 2 350 000, балансы 1 350 000 / 1 000 000, `aggregateExecution` 0.95625); G-002 (июль резерв 1 980 900, свободно 4 419 100, сентябрь 1 319 100, разбивка по участникам); `PlanningMonthMetrics` без новых полей; каноническое кодирование операций G-002 (`canonicalOperationText`); `budgetJournalDrafts(null, G-002)`; контрольная сумма копии G-002.

## 3. Хранилище

### 3.1 IndexedDB: версию базы и `DOCUMENT_SCHEMA_VERSION` не поднимать
По правилу `indexed-db.ts:11–23` номер описывает форму конверта; документы v2 остаются корректными v2 без преобразований. Тест `sync-client/tests/migration.test.ts` (документ v2, G-002) проходит без изменений.

### 3.2 Копия: `schemaVersion` 1 → 2
- `storage/src/backup.ts`: `:3` → `BACKUP_SCHEMA_VERSION = 2` + `SUPPORTED_BACKUP_SCHEMA_VERSIONS = [1, 2]`; `:24` → `1 | 2`; `:227–233` принимают 1 и 2, > 2 — «новее»; `:273` пишет 2. v1 → v2 тождественно.
- `contracts/schemas/storage-backup.schema.json:11`: `const 1` → `enum [1, 2]`.
- Документы: `ARCHITECTURE.md:113–128`, `QA_ACCEPTANCE.md:100, 104, 115–116`.

### 3.3 Шлюз `apps/web-pwa/src/backup.ts`
- `BACKUP_LIMITS` (`:14–29`): `tags 500`, `debts 500`, `recurringRules 1000`, `exchangeRates 10000`, `tagsPerTransaction 10`, `tagNameLength 40`.
- `requireBaseShape` (`:150–256`): валюта по `SUPPORTED_CURRENCIES` (`:170`); поля оформления; `debt_out`/`debt_in` с `debtId` (`:226`); `note`, `tagIds`, `recurringRuleId`; снимок тремя полями, `rate` = `{baseMinor, quoteMinor}`; `toAmountMinor`, `debtAmountMinor`; формы `household`, `tags`, `debts`, `recurringRules` (с `template`), `exchangeRates`.
- `validateBudgetStateUuids` (`:123–142`): новые id, `tagIds[]`, `recurringRuleId`, `debtId`, id в шаблонах.
- Ремонт по образцу `clearUnknownMemberAttribution` (`:369–382`): `BackupRepair.kind` (`:48–52`) + `"unknown_tag"`, `"unknown_recurring_rule"` (метки снимаются с сообщением). На `debtId` ремонт **не** распространяется — такая копия отвергается.
- `prepareBudgetState` (`:390–411`): дополнительно `calculateDebts`, `calculateHoldings`, `calculateTagExpenses` на конце активного бюджета.

### 3.4 Правка без потерь (`operations/model.ts:241–327`)
`makeTransaction(…, current)` переносит из `current` то, чего форма не знает: `memberId`, `note`, `tagIds`, `recurringRuleId`. Правка валютной операции и `debt_*` старой формой — отказ с понятной ошибкой до волны UI. Изменение поведения для `memberId` — отразить в commit message.

### 3.5 CSV (`data-management/model.ts`)
Первые семь заголовков (`:106–114`) неизменны; «Сумма, ₽» — в базовой валюте (income/expense/refund — `baseAmountOf`; перевод, взнос, долг — `amountMinor`, если счёт-источник в базе, иначе пусто). В конец: «Валюта счёта», «Сумма в валюте счёта» (`formatAmount(minor, exponent)`; сейчас `:66–70` знает только exponent 2), «Курс» (база за 1 единицу иностранной), «Сумма зачисления» (`toAmountMinor`/`debtAmountMinor`), «Валюта зачисления», «Долг» (`counterparty`), «Комментарий», «Метки» (имена через «, », архивные тоже). Подписи долгов (`:34–40`, `:72–104`) из пары «вид + направление»: «Дал в долг», «Вернул долг», «Взял в долг», «Мне вернули долг». Все новые текстовые поля — через `encodeField` (`storage/src/csv.ts:7–18`); тесты на `=HYPERLINK(...)`, `@x`, `+7 900 …`, `-5`. Расширить класс префикса `csv.ts:7` до `\p{Zs}`.

## 4. Протокол синхронизации

### 4.1 Типы (`sync-protocol/src/types.ts`)
- `ENTITY_KINDS` (`:83–93`): дописать **в конец** `"tag", "debt", "recurringRule", "exchangeRate", "household"`.
- `EntityFieldsByKind` (`:68–78`): `Omit<…, "id">` для каждого.
- `SyncedBudgetState` (`:47–49`): `tags`, `debts`, `recurringRules`, `exchangeRates` обязательны (как `members`), `household` необязателен.
- `JOURNAL_PROBLEM_CODES` (`:151–201`), `WITHHOLDING_REASONS` (`:224–232`): + `currency_mismatch`. `UNSHOWABLE_PROBLEM_CODES` без изменений.

### 4.2 Кодек (`codec.ts`) — значения импортируются из домена
- `parseAccountFields` (`:337–348`): `sortOrder` (±1e6), `icon`, `color`, `includeInTotal`; валюта через `isSupportedCurrency` (неизвестная — отказ, `sync-client/intake.ts:96–130` сообщает «обновите приложение»).
- `parseCategoryFields` (`:350–361`): `icon`, `color`. `parseGoalFields` (`:414–431`): `deadline`, `icon`.
- `parseTransactionFields` (`:490–583`): `note` (новый `readNote`: предикат домена, ≤ 500, а не `MAX_TEXT_LENGTH = 200` `:84`), `tagIds` (1…10, уникальные, `readId`), `recurringRuleId`; снимок три поля или ни одного, `baseAmountMinor ≥ 1`, части курса в `[1, 10^12]`; transfer `toAmountMinor ≥ 1`; `debt_out`/`debt_in`: обязательны `accountId`, `debtId`, необязателен `debtAmountMinor`; «отсутствующее остаётся отсутствующим» (`:513–515`).
- Новые парсеры: `parseTagFields`, `parseDebtFields`, `parseExchangeRateFields`, `parseHouseholdFields`, `parseRecurringRuleFields` (вложенный `template` со строгим списком полей по виду; разные счета перевода как `:571–572`; `interval` 1…999; `endDate ≥ startDate`).
- `parseOperation` (`:653–682`): для `household` требуется `targetId === HOUSEHOLD_ID`, `delete` отвергается.
- Размеры: глубина 4 (`MAX_DEPTH = 8`), самое большое правило ≈ 3 КБ (`MAX_OPERATION_BYTES = 8 КБ`).

### 4.3 Шлюз журнала (`journal.ts`)
- `LiveEntities`, `collectLiveEntities`, `entityIndexes` (`:477–552`) — новые коллекции; `buildView` (`:1182–1192`) кладёт их в состояние, `household` = `live.households.get(HOUSEHOLD_ID)`.
- Висячие ссылки: `tx.tagIds[i]` — снять (без остатка — поле целиком), `unknown_reference` про transaction, деньги остаются (`clearUnresolvedLabels :750–770`); `tx.recurringRuleId` — снять; `tx.debtId` — удержать операцию, `unknown_reference`; счета шаблона — удержать правило; категория шаблона-расхода — удержать (`unknown_reference`/`wrong_category_type`); категория шаблона-дохода и метки шаблона — снять; валютные правила §1.3 — удержать, `currency_mismatch` (в `transactionProblem :665–703`, `goalProblem`, `annualCommitmentProblem`, `scheduledExpenseProblem :645–663`).
- Тумбстоуны: `household` — удаление отвергает кодек; метка — метки снимаются; долг — его операции удерживаются (UI архивирует, не удаляет); правило — вхождения остаются, метка снимается; вхождение — окончательно; курс — безвредно.
- `reportAggregateBounds` (`:918–973`): в базовых суммах, учёт `toAmountMinor`, долговые виды в `transactionContributions` (`:864–898`), балансы по долгам.

### 4.4 Разница «состояние → операции»
`apps/web-pwa/src/features/family/journal.ts` — строки новых сущностей и поля в `accountFields`, `categoryFields`, `goalFields`, `transactionFields` (`:70–200`) через `defined`; `canonical` (`:58–64`) сделать рекурсивным (вложенные `rate`, `template`, `tagIds`). Рекомендуется перенос в `packages/sync-protocol/src/drafts.ts` с реэкспортом и свойством «журнал из `drafts(state)` даёт `state`».

### 4.5 Тесты закрытых наборов, обязательные к расширению
`sync-protocol/tests/samples.ts` (`SAMPLE_FIELDS`, `UPDATED_FIELDS`, + `SAMPLE_TARGET_IDS`); `codec.test.ts:75–118, 120–141, 498–505`; `journal.test.ts` (`entityIds`/`entityValue :243–285`, `SEED_PARENTS :292–302`, `REFERENCING_KINDS :320–326`, `:438–475`, `transactionFields :76–118`, покрытие удержаний `:2898–2917` + `currency_mismatch`); `web-pwa/src/features/family/model.ts:195–215`.

## 5. Контракты и G-003

### 5.1 Новая схема
`contracts/schemas/ledger-fixture.schema.json`, `$id urn:family-budget:contracts:ledger-fixture:1.0.0`, `fixtureId: const "G-003"` (планировочную не расширять — политика `README.md:57–65`). Поля: `asOf`, `materializeThrough`, `currencies: [{code, exponent}]`, `state` с новыми определениями, совместность снимка через `dependentRequired`, `expected`. `packages/test-fixtures/src/index.ts`: типы `:22–42` + `LedgerFixture`; `parseCanonicalFixture` (`:279–291`) знает G-003; проверка ссылок меток, долгов, правил; экспорт `G003`.

### 5.2 Сценарий G-003
База RUB, август 2026 (01–31), бюджет открыт, плановый доход 15 000 000, порог 0.8. Id читаемые с префиксом `8…` (как G-002); `HOUSEHOLD_ID` и id вхождений выводятся.

- Счета: A1 «Карта» RUB 5 000 000; A2 «Доллары» USD 50 000 (`sortOrder 20`, `icon "banknote"`, `color "sage"`); A3 «Копилка» RUB 2 000 000 (`includeInTotal: false`).
- Категории: C1 «Продукты» (расход, `icon "shopping-basket"`, `color "mint"`), C2 «Путешествия» (расход), C3 «Зарплата» (доход). Строки: C1 3 000 000, C2 600 000.
- Цель G1 «Отпуск» на A3, 30 000 000, `deadline 2027-06-01`, `icon "plane"`.
- Метки: T1 «Отпуск», T2 «Дом», T3 «Старое» (`active: false`).
- Курсы: R1 USD 2026-07-31 `{9000, 100}`; R2 USD 2026-08-15 `{9250, 100}`.
- Долги: D1 «Петя» `owed_to_me` RUB 0; D2 «Сергей» `i_owe` USD 0, `dueDate 2026-12-31`.
- Правило RR1: расход 150 000, A1, C1, `note "Доставка воды"`, `tagIds [T2]`, weekly, `interval 2`, старт 2026-08-04.

| # | Дата | Вид | Сумма | Прочее |
|---|---|---|---|---|
| t1 | 08-01 | income A1 | 12 000 000 | C3, `note "Аванс за август"`, `[T3]` |
| t2 | 08-03 | expense A1 | 1 250 000 | C1, `"Пятёрочка у дома"`, `[T2]` |
| t3 | 08-10 | expense A2 | 4 000 $¢ | C2, `[T1]`, снимок 360 000, R1 |
| t4 | 08-12 | refund A2 → t3 | 1 000 $¢ | C2, `[T1]`, снимок 90 000, R1 |
| t5 | 08-20 | expense A2 | 2 555 $¢ | C2, `[T1]`, снимок 236 338, R2 |
| t6 | 08-05 | transfer A1 → A2 | 1 800 000 | `toAmountMinor 20 000` |
| t7 | 08-07 | debt_out A1 → D1 | 500 000 | |
| t8 | 08-25 | debt_in D1 → A1 | 200 000 | |
| t9 | 08-08 | debt_in D2 → A2 | 10 000 $¢ | |
| t10 | 08-28 | debt_out A1 → D2 | 462 500 | `debtAmountMinor 5 000` |

Снимки: t3 4 000 × 9 000 / 100 = 360 000; t4 1 000 × 9 000 / 100 = 90 000; t5 2 555 × 9 250 / 100 = 236 337,5 → half-up 236 338.

**expected.materialization** (до 2026-08-31): вхождения 08-04 и 08-18; id `recurringOccurrenceId(RR1, date)`; `materializedThrough = 2026-08-31`; `skipped` пуст; повторный вызов ничего не создаёт.

**expected.budget** (после материализации):
- `incomeMinor` 12 000 000.
- C1: 1 250 000 + 2 × 150 000 = 1 550 000; остаток 1 450 000; 5 167 б. п.; `normal`.
- C2: 360 000 + 236 338 = 596 338; возврат 90 000; факт 506 338; остаток 93 662; 8 439 б. п. → `near_limit` (без конвертации было бы 5 555 и `normal`).
- `grossExpensesMinor` 2 146 338; `refundsMinor` 90 000; `expensesMinor` 2 056 338; `plannedExpenseMinor` 3 600 000; исполнение 5 712 б. п.
- A1: 5 000 000 + 12 000 000 − 1 250 000 − 1 800 000 − 500 000 + 200 000 − 462 500 − 150 000 − 150 000 = 12 887 500. A2: 50 000 − 4 000 + 1 000 − 2 555 + 20 000 + 10 000 = 74 445 (центы). A3: 2 000 000.
- `capitalMinor` = A1 + A3 = 14 887 500 (смешение валют дало бы 14 961 945).
- `goalContributionsMinor` {G1: 0}.

**expected.debts** (на 2026-08-31, R2): D1 300 000; D2 5 000 $¢ → 462 500, не просрочен; к получению 300 000, к оплате 462 500, итог −162 500.

**expected.holdings**: A2 в базе 74 445 × 9 250 / 100 = 6 886 162,5 → 6 886 163; `totalInBase` (A1 + A2) 19 773 663; `netWorthInBase` 19 773 663 + 300 000 − 462 500 = 19 611 163.

**expected.tags**: T1 расход 596 338, возврат 90 000, факт 506 338, 3 операции; T2 расход 1 550 000, 3 операции; T3 доход 12 000 000, 1 операция.

Отдельный тест «курсы не переоценивают прошлое»: замена R1 на `{9500, 100}` не меняет `expected.budget`; смена R2 меняет holdings и debts.

## 6. Тесты по пакетам

- **domain**: `text.test.ts` (NFC/trim; 500 проходит, 501 нет; запреты C0, C1, DEL, U+2028, U+202E, U+2066, ZWSP, BOM, U+FFF9, одиночный суррогат; VS16 удаляется; смешение алфавитов: заметка — можно, метка — нельзя); `calendar.test.ts` (`addDays`/`dayIndex` туда-обратно, високосные, 1900 и 2199); `currency.test.ts` (заморозка exponent; `convertMinor` 236 337,5 → 236 338, 6 886 162,5 → 6 886 163, ,25 вниз, переполнение; `findRate`); `calculate.test.ts` (G-000/1/2 не трогать; иностранный расход/возврат; снимок отсутствует/лишний/чужой — ошибка; `toAmountMinor` обязателен/запрещён; капитал без иностранных; `includeInTotal` не влияет на `capitalMinor`; планы в базе; инвариант участников с валютой; метки висячие/повтор/>10/архивная; ненормализованная заметка; плохой ключ оформления); `debts.test.ts`; `recurring.test.ts` (daily, weekly, monthly 31-го, yearly 29.02, interval, включительный endDate, id и идемпотентность, удалённое вхождение не возвращается, два «устройства» → равные состояния, `missing_rate` держит водяной знак, неактивное правило, архивный счёт, предел, коллизия id); `holdings.test.ts` (июльская операция есть в holdings августа и отсутствует в `BudgetMetrics` августа; нет курса; переполнение); `rollover.test.ts` (`assertFreshIds` видит метки; «не трогает…» `:154–164` на новые коллекции; литеральное значение `carriedBudgetId`); G-003.
- **storage**: запись 2, чтение 1 и 2, 3 — «новее»; конверт принимает 1 и 2; CSV `\p{Zs}`.
- **sync-protocol**: всё из §4.5; круговые проходы и «ничего не выдумывает» для новых полей; отказы (заметка, неизвестная валюта, частичный снимок, части курса, чужой `targetId` household, удаление household, шаблоны); свойство «что принял `normalizeNote`, принимает `readNote`»; хэш канонического текста журнала G-002 неизменен; снятие меток; `currency_mismatch` (включая одновременную правку валюты счёта); G-003 через журнал (перемешивание, `restoreJournal`, равенство расчётов).
- **test-fixtures**: G-003 проходит схему и проверку ссылок; G-000…G-002 как раньше.
- **web-pwa**: `backup.test.ts` — тест USD (`:181–233`) → три (XYZ отвергается; USD без снимка отвергается; USD со снимком принимается), пределы, UUID, ремонт меток с сообщением, запись версии 2; замороженные артефакты 1.0.0 (копия → байт-в-байт то же состояние с закреплённой контрольной суммой; документ IndexedDB открывается через `prepareBudgetState`); `family/journal.test.ts` (новые поля и сущности; разница G-002 закреплена; пустая разница при вложенных объектах); `data-management/model.test.ts:72` (старый заголовок — префикс; новые столбцы; формулы в заметке/метке/контрагенте); правка сохраняет `note`, `tagIds`, `memberId`; правка валютной и `debt_*` отвергается.

## 7. Порядок коммитов (каждый проходит `pnpm verify`)

1. `chore(domain,sync-protocol,sync-crypto): replace embedded NUL literals with \u0000` + тест литерального `carriedId`.
2. `test(web-pwa,test-fixtures): freeze what 1.0.0 wrote` — копия и документ IndexedDB из G-002 и `makePlanningSeed`; контрольная сумма и разница журнала.
3. `docs(decisions): wave-1 data model` — D-031 мультивалютность и Household (заменяет D-007, сужает D-011); D-032 планы в базовой валюте; D-033 долги двумя видами; D-034 метки и заметки справочные; D-035 материализация регулярных операций; D-036 оформление в данных (снимает `category-visual.ts:5–19`); D-037 версии: копия 2, IndexedDB без изменений. Этот план — `plans/model-v3-wave1.md`.
4. `refactor(domain)` — `identity.ts`, `text.ts`, `addDays`, `indexState`, `documentIds`; поведение не меняется.
5. `feat(domain): display fields, notes, tags`.
6. `feat(storage,web-pwa): notes/tags/display through the gate; backup schema 2` — шлюз, пределы, ремонт, сохранение полей при правке, контракт конверта, QA/ARCHITECTURE.
7. `feat(sync-protocol,web-pwa): notes/tags/display through the journal` — кодек, вид `tag`, снятие меток, samples, `family/journal.ts` (или `drafts.ts`), подписи.
8. `feat(domain): base currency, rates, snapshots, toAmountMinor`.
9. `feat(web-pwa,sync-protocol): multi-currency through backup and journal` — household, exchangeRate, `currency_mismatch`, агрегаты.
10. `feat(*): debt entity` — домен, шлюз, журнал; метрики по начальным остаткам.
11. `feat(*): debt_out/debt_in` — одним коммитом во всех пакетах.
12. `feat(domain): recurring rules and materialization`.
13. `feat(web-pwa,sync-protocol): recurring through backup and journal`.
14. `feat(domain): holdings and tag breakdown`.
15. `test(contracts): G-003 ledger fixture` — схема, фикстура, загрузчик, тесты домена и журнала.
16. `feat(web-pwa): CSV columns` + усиление защиты от формул.
17. `docs` — `contracts/README.md`, `SYNC_ARCHITECTURE.md` §2.3, `ARCHITECTURE.md`, `IMPLEMENTATION_STATUS.md`.

## 8. Решения оркестратора по открытым вопросам (по умолчанию, владелец может изменить)

- Округление конвертации: half-up до минимальной единицы.
- Вхождения регулярных операций создаются сразу `posted`; при архивном счёте/категории — пропуск с отчётом (`skipped`).
- Заметка: одна строка, ≤ 500; метки: ≤ 10 на операцию, ≤ 40 символов.
- Копия всегда пишется версии 2 (1.0.0 не опубликован).
- `includeInTotal` влияет только на holdings.
- Смена базовой валюты при наличии операций не поддерживается.
- Excel и `build-family-budget.mjs` G-003 не получают.

## 9. Вопросы к владельцу (не блокируют волну 1)
1. Что показывать как «Капитал» после переноса месяца: `capitalMinor` месяца или накопительный `HoldingsMetrics`.
2. Источник курсов: ручной или ЦБ (сеть, D-010, CSP).
3. Иностранные цели и планы — позже?
4. `RecurringRule` vs `ScheduledExpense`: как объединять, чтобы не считать аренду дважды.
