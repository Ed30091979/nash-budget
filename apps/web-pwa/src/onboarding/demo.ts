import {
  DEFAULT_CATEGORIES,
  categoryNameKey,
  convertMinor,
  HOUSEHOLD_ID,
  makePlanningSeed,
  monthIndex,
  monthOfDate,
  monthEndDate,
  monthStartDate,
  normalizeCategoryName,
  PLANNING_IDS,
  SEED_IDS,
  shiftDate,
  shiftMonth,
  type Account,
  type BudgetState,
  type Category,
  type Debt,
  type ExchangeRate,
  type Goal,
  type RecurringRule,
  type Tag,
  type Transaction,
} from "@family-budget/domain";

import { localToday } from "../reach";

/**
 * Демонстрационный бюджет: канонический G-002 на стартовом наборе категорий.
 *
 * Числа берутся из `makePlanningSeed()` и не пересчитываются здесь ни одного: демо построено на
 * каноническом наборе, его первый месяц — резерв `19 809 ₽` и «свободно» `44 191 ₽`, дно
 * горизонта `13 191 ₽`, «Можно на повседневные» `27 000 ₽` — названы поимённо в приёмке. Меняются
 * словарь категорий, календарь сцены, история доходов и — по данным макетов v5 (DIRECTION, «Данные в
 * макетах») — раскладка счетов, разбиение трат по дням, курс доллара, метки, долг и цель.
 *
 * Зачем менять словарь. Семь категорий сида носили имена, которых нет ни в стартовом наборе
 * домена (`DEFAULT_CATEGORIES`), ни в карте вида (`category-visual.ts`): «Досуг», «Дом и мелкие
 * покупки», «ЖКХ и связь». Такая строка получала запасной глиф-ярлык своей группы вместо своей
 * иконки, и человек, открывший демо, видел приложение беднее, чем оно есть. Здесь имена
 * приводятся к стартовому набору — один к одному, без слияний и без разбиения сумм, — а сам набор
 * доводится до полных двадцати трёх категорий, ровно как его получает семья после онбординга
 * (`buildOnboardingBudgetState`). Категория без плана и без операций не двигает ни одной суммы:
 * она просто есть в списке, как есть в настоящем хозяйстве.
 */
const DEMO_CATEGORY_RENAMES: Readonly<Record<string, string>> = {
  "ЖКХ и связь": "ЖКХ",
  "Досуг": "Развлечения и хобби",
  "Дом и мелкие покупки": "Дом и хозяйство",
};

/**
 * Идентификаторы семи категорий, на которые ссылаются суммы демо.
 *
 * Переименование обязано сохранить идентификатор: на него смотрят строки бюджета, расписания,
 * крупные платежи и операции. Новое имя — то же самое место в данных, а не вторая категория.
 */
const DEMO_CATEGORY_IDS: Readonly<Record<string, string>> = {
  "Жильё": PLANNING_IDS.categories.housing,
  "ЖКХ": PLANNING_IDS.categories.utilities,
  "Дети": PLANNING_IDS.categories.children,
  "Продукты": PLANNING_IDS.categories.food,
  "Транспорт": PLANNING_IDS.categories.transport,
  "Развлечения и хобби": PLANNING_IDS.categories.leisure,
  "Дом и хозяйство": PLANNING_IDS.categories.household,
};

/** Месяц, на котором собран канонический набор: от него считается перенос сцены. */
export const CANONICAL_DEMO_MONTH = "2026-07";

/**
 * Идентификатор для категории стартового набора, которой в сиде не было.
 *
 * Он обязан быть детерминированным: демо загружается в резервную копию и в журнал семьи, и два
 * запуска подряд не вправе дать разные идентификаторы одной и той же категории. Форма — UUID
 * версии 4 с вариантом `8`, как у остальных идентификаторов канонического набора; порядковый
 * номер шаблона занимает последние разряды и делает значение уникальным.
 */
function demoCategoryId(index: number): string {
  return `7a333333-3333-4333-8333-3333${String(index).padStart(8, "0")}`;
}

/** Идентификатор доходной операции истории — по тем же правилам, что и категории. */
function demoIncomeId(index: number): string {
  return `7b555555-5555-4555-8555-5555${String(index).padStart(8, "0")}`;
}

/** Стартовые двадцать три категории, семь из которых уже носят суммы канонического набора. */
function demoCategories(): readonly Category[] {
  return DEFAULT_CATEGORIES.map((template, index) => {
    const name = normalizeCategoryName(template.name);
    return {
      id: DEMO_CATEGORY_IDS[name] ?? demoCategoryId(index),
      name,
      type: template.type,
      group: template.group ?? (template.type === "income" ? "income" : "other"),
      active: true,
      sortOrder: (index + 1) * 10,
    };
  });
}

/**
 * Перенос сцены в текущий месяц.
 *
 * Демо было привязано к июлю 2026 намертво, и всякий, кто открывал приложение после июля, видел
 * закрытый месяц: ни линейки до выплаты, ни предпросмотра покупки в конвертах — то есть ровно то,
 * ради чего демо и существует, не показывалось. Сцена переносится целиком и на целое число
 * месяцев: даты операций, сроки крупных платежей и сам период плана едут вместе, а календарные
 * месяцы сезонных расписаний поворачиваются на тот же шаг. Все расстояния между событиями при
 * этом сохраняются — а раз так, каждая величина годового плана остаётся ровно той же, что в
 * каноническом наборе, и проверяется это сравнением месяц в месяц (`demo.test.ts`).
 *
 * Переносится сцена, а не числа: ни одна сумма здесь не пересчитывается.
 */
function transposeMonths(state: BudgetState, offset: number): BudgetState {
  if (offset === 0) return state;
  const month = (value: string) => shiftMonth(value, offset);
  return {
    ...state,
    budgets: state.budgets.map((budget) => {
      const target = month(monthOfDate(budget.startDate));
      return { ...budget, startDate: monthStartDate(target), endDate: monthEndDate(target) };
    }),
    annualCommitments: state.annualCommitments.map((item) => ({
      ...item,
      dueDate: shiftDate(item.dueDate, offset),
    })),
    scheduledExpenses: state.scheduledExpenses.map((item) => (item.mode === "selected_months"
      // Сезон едет вместе со сценой: расписание «сентябрь — май» относительно первого месяца
      // плана обязано остаться тем же самым расписанием, иначе первый месяц демо получил бы
      // чужой сезонный платёж и «свободно» первого месяца перестало бы быть каноническим.
      ? { ...item, months: (item.months ?? []).map((value) => ((value - 1 + offset) % 12 + 12) % 12 + 1) }
      : item)),
    transactions: state.transactions.map((item) => ({ ...item, occurredOn: shiftDate(item.occurredOn, offset) })),
  };
}

/** Число месяца, на которое приходится аванс, и число получки. */
export const PAYDAY_ADVANCE = 5;
export const PAYDAY_SALARY = 20;
/** Аванс и получка в сумме дают канонические 180 000 ₽ планового дохода месяца. */
const ADVANCE_MINOR = 7_000_000;
const SALARY_MINOR = 11_000_000;
/**
 * Сколько прошлых месяцев демо помнит.
 *
 * Дни выплат демо называет сам (`household.paydays`, D-039), но история остаётся: из неё выводит
 * даты тот, у кого дни не названы, и ось «Года» показывает прошлые выплаты. Трёх прошлых месяцев
 * хватает на любой день календаря: расписанием число становится с двух повторений в разные месяцы.
 * Пять — столько же, сколько месяцев истории трат (`demoHistory`): «По месяцам» в «Отчётах» —
 * полгода, и у каждого прошлого месяца есть и доход, и расходы.
 */
const HISTORY_MONTHS = 5;

/** Выплаты одного месяца: число и сумма. */
const DEMO_PAYDAYS: readonly (readonly [day: number, amountMinor: number])[] = [
  [PAYDAY_ADVANCE, ADVANCE_MINOR],
  [PAYDAY_SALARY, SALARY_MINOR],
];

/** Идентификаторы того, что макеты v5 добавили к каноническому набору. */
export const DEMO_IDS = {
  accounts: {
    card: SEED_IDS.accounts.main,
    reserve: SEED_IDS.accounts.savings,
    cash: "7c666666-6666-4666-8666-666666666661",
    dollars: "7c666666-6666-4666-8666-666666666662",
  },
  rates: ["7d777777-7777-4777-8777-777777777771", "7d777777-7777-4777-8777-777777777772", "7d777777-7777-4777-8777-777777777773", "7d777777-7777-4777-8777-777777777774"],
  tags: { vacation: "7e888888-8888-4888-8888-888888888881", dacha: "7e888888-8888-4888-8888-888888888882" },
  debt: "7f999999-9999-4999-8999-999999999991",
  rules: { salary: "7faaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1", rent: "7faaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2" },
} as const;

/** Операция сцены макетов: день текущего месяца и что за ней. */
function sceneId(index: number): string {
  return `7b555555-5555-4555-8555-6666${String(index).padStart(8, "0")}`;
}

/**
 * Регулярные доходы: аванс 5-го и получка 20-го, в этом месяце и в трёх предыдущих.
 *
 * Выплата, день которой ещё не наступил, — не записанный доход с будущей датой, а ожидаемый:
 * `pending` (макеты v5: «110 000, 20-го, ожидается»). Такой доход не входит в доходы месяца, пока не
 * пришёл, — 19-го «Доходы октября» честно говорят 70 000, — а сумма месяца по плану остаётся
 * канонической: `7 000 000 + 11 000 000` — те же 180 000 ₽ планового дохода. Доходы прошлых месяцев
 * лежат вне периода плана и не двигают ни одного показателя бюджета.
 */
function demoIncomes(month: string, today: string, salaryCategoryId: string, accountId: string): readonly Transaction[] {
  const incomes: Transaction[] = [];
  for (let back = HISTORY_MONTHS; back >= 0; back -= 1) {
    const paid = shiftMonth(month, -back);
    DEMO_PAYDAYS.forEach(([day, amountMinor], index) => {
      const occurredOn = `${paid}-${String(day).padStart(2, "0")}`;
      incomes.push({
        id: demoIncomeId(back * DEMO_PAYDAYS.length + index),
        occurredOn,
        status: occurredOn > today ? "pending" : "posted",
        kind: "income",
        amountMinor,
        accountId,
        categoryId: salaryCategoryId,
      });
    });
  }
  return incomes;
}

/**
 * Курс доллара (макеты v5): 93,10 ₽ с 15-го прошлого месяца, 91,80 ₽ с 1-го и 92,50 ₽ с 15-го. Ещё
 * раньше — 89,60 ₽ на 14-е три месяца назад: курс дня покупки в долларах из истории (`demoHistory`).
 */
function demoRates(month: string): readonly ExchangeRate[] {
  const rate = (index: number, date: string, baseMinor: number): ExchangeRate => ({
    id: DEMO_IDS.rates[index]!,
    currency: "USD",
    baseCurrency: "RUB",
    date,
    rate: { baseMinor, quoteMinor: 100 },
  });
  return [
    rate(3, `${shiftMonth(month, -HISTORY_USD_BACK)}-${String(HISTORY_USD_DAY).padStart(2, "0")}`, HISTORY_USD_RATE.baseMinor),
    rate(0, `${shiftMonth(month, -1)}-15`, 9_310),
    rate(1, `${month}-01`, 9_180),
    rate(2, `${month}-15`, 9_250),
  ];
}

/**
 * Траты месяца по дням — разбиение макетов v5. Суммы по категориям — канонические: «Продукты»
 * 22 000, «Транспорт» 4 000, «Жильё» 45 000; разбиты они на покупки, а не изменены. Две покупки
 * 18-го несут метку «дача», 12-го — «Дал в долг: Саша», 10-го — перевод с карты в наличные.
 *
 * Сцена — прошлое: записанной операции с датой позже сегодняшней не бывает (ревью R2, L-10). День
 * сцены, который ещё не наступил, становится сегодняшним, — покупки те же, суммы те же, порядок тот
 * же, поэтому «Расходы» месяца и «Можно на повседневные» (27 000 ₽ канонического набора) одинаковы в
 * любой день месяца. Будущими бывают только выплаты — и они «ожидаются» (`demoIncomes`).
 */
function demoScene(month: string, today: string): readonly Transaction[] {
  const todayDay = monthOfDate(today) === month ? Number(today.slice(8, 10)) : 31;
  const day = (value: number) => `${month}-${String(Math.min(value, todayDay)).padStart(2, "0")}`;
  const { card, cash, dollars } = DEMO_IDS.accounts;
  const { food, transport, housing } = PLANNING_IDS.categories;
  const expense = (index: number, on: number, categoryId: string, amountMinor: number, tagIds?: readonly string[]): Transaction => ({
    id: sceneId(index),
    occurredOn: day(on),
    status: "posted",
    kind: "expense",
    amountMinor,
    accountId: card,
    categoryId,
    ...(tagIds === undefined ? {} : { tagIds }),
  });
  return [
    expense(1, PAYDAY_ADVANCE, housing, 4_500_000),
    expense(2, 6, food, 440_000),
    expense(3, 9, food, 385_000),
    { id: sceneId(4), occurredOn: day(10), status: "posted", kind: "transfer", amountMinor: 1_000_000, fromAccountId: card, toAccountId: cash },
    expense(5, 11, transport, 90_000),
    expense(6, 12, food, 390_000),
    { id: sceneId(7), occurredOn: day(12), status: "posted", kind: "debt_out", amountMinor: 500_000, accountId: card, debtId: DEMO_IDS.debt },
    expense(8, 14, food, 430_000),
    expense(9, 16, food, 215_000),
    expense(10, 18, food, 340_000, [DEMO_IDS.tags.dacha]),
    expense(11, 18, transport, 250_000, [DEMO_IDS.tags.dacha]),
    expense(12, 19, transport, 60_000),
    // Доллары куплены в прошлом месяце: 111 000 ₽ с карты — 1 200 $ на счёт «Доллары». Перевод
    // между валютами несёт сумму зачисления; ни расходом, ни доходом он не считается.
    { id: sceneId(13), occurredOn: `${shiftMonth(month, -1)}-22`, status: "posted", kind: "transfer", amountMinor: 11_100_000, fromAccountId: card, toAccountId: dollars, toAmountMinor: 120_000 },
  ];
}

/**
 * Пять прошлых месяцев трат — история «Отчётов» (макет 09: «По месяцам» 76 · 82 · 74 · 89 · 79 тыс.).
 *
 * Генерация детерминированная и считается от сегодняшнего месяца, как сцена: `back` = 1 — прошлый
 * месяц. Расходы месяца — ровно числа макета: для октября май 76 200, июнь 81 500, июль 74 300,
 * август 88 900, сентябрь 79 400 ₽. Каждый месяц — аренда 5-го, ЖКХ 10-го, продукты шесть раз,
 * транспорт три раза, кафе дважды, иногда подарок и хозяйство; последняя покупка продуктов
 * добирает месяц до его числа. Метки: «отпуск» — три месяца назад (летом для октября), с покупкой в
 * долларах по курсу её дня; «дача» — два и четыре месяца назад. Все дни — с 2-го по 28-е: такие есть
 * в любом месяце, и вся история — прошлое при любом сегодняшнем дне. Планов у прошлых месяцев нет:
 * их «Обзор» показывает траты без лимитов, а «Открыть …» относится только к месяцу плана.
 */
const HISTORY_TOTALS_MINOR: readonly number[] = [7_940_000, 8_890_000, 7_430_000, 8_150_000, 7_620_000];
/** Покупка в долларах: 50 $ три месяца назад, 14-го, по 89,60 ₽ — снимок 4 480 ₽. */
const HISTORY_USD_BACK = 3;
const HISTORY_USD_DAY = 14;
const HISTORY_USD_MINOR = 5_000;
const HISTORY_USD_RATE = { baseMinor: 8_960, quoteMinor: 100 } as const;

/** Операция истории: месяц назад `back`, порядковый номер в месяце. */
function historyId(back: number, index: number): string {
  return `7b555555-5555-4555-8555-7777${back}${String(index).padStart(7, "0")}`;
}

interface HistoryCategories {
  readonly cafe: string;
  readonly gifts: string;
}

/** Что повторяется по месяцам: [back − 1] — массив на месяц. */
const HISTORY_UTILITIES: readonly number[] = [580_000, 510_000, 460_000, 490_000, 540_000];
const HISTORY_TRANSPORT: readonly (readonly [number, number, number])[] = [
  [60_000, 250_000, 90_000], [90_000, 60_000, 180_000], [120_000, 60_000, 60_000], [250_000, 90_000, 60_000], [60_000, 180_000, 90_000],
];
const HISTORY_CAFE: readonly (readonly [number, number])[] = [[120_000, 85_000], [64_000, 150_000], [210_000, 98_000], [76_000, 132_000], [110_000, 90_000]];
const HISTORY_FOOD: readonly (readonly [number, number, number, number, number])[] = [
  [420_000, 315_000, 398_000, 362_000, 241_000], [520_000, 415_000, 610_000, 384_000, 455_000], [310_000, 260_000, 295_000, 228_000, 190_000],
  [380_000, 340_000, 410_000, 295_000, 330_000], [440_000, 365_000, 402_000, 318_000, 260_000],
];
const FOOD_DAYS = [2, 7, 12, 17, 23, 28] as const;
const FOOD_NOTES = ["рынок", undefined, "у дома", undefined, "рынок", undefined] as const;

function demoHistory(month: string, ids: HistoryCategories): readonly Transaction[] {
  const { card, dollars } = DEMO_IDS.accounts;
  const { food, transport, housing, utilities, household, leisure } = PLANNING_IDS.categories;
  const { vacation, dacha } = DEMO_IDS.tags;
  const operations: Transaction[] = [];
  for (let back = HISTORY_MONTHS; back >= 1; back -= 1) {
    const past = shiftMonth(month, -back);
    const at = (day: number) => `${past}-${String(day).padStart(2, "0")}`;
    const rows: { day: number; categoryId: string; amountMinor: number; note?: string; tagIds?: readonly string[]; usd?: boolean }[] = [];
    const i = back - 1;
    rows.push({ day: PAYDAY_ADVANCE, categoryId: housing, amountMinor: 4_500_000, note: "аренда" });
    rows.push({ day: 10, categoryId: utilities, amountMinor: HISTORY_UTILITIES[i]! });
    HISTORY_TRANSPORT[i]!.forEach((amountMinor, trip) => rows.push({
      day: [4, 15, 26][trip]!, categoryId: transport, amountMinor,
      ...(trip === 1 ? { note: "такси" } : {}),
      ...(back === 2 && trip === 2 ? { tagIds: [dacha] } : {}),
    }));
    HISTORY_CAFE[i]!.forEach((amountMinor, visit) => rows.push({
      day: [9, 21][visit]!, categoryId: ids.cafe, amountMinor, note: "кофе с собой",
      ...(back === HISTORY_USD_BACK && visit === 0 ? { tagIds: [vacation] } : {}),
    }));
    if (back === 1) rows.push({ day: 13, categoryId: ids.gifts, amountMinor: 200_000, note: "цветы" });
    if (back === 4) rows.push({ day: 24, categoryId: ids.gifts, amountMinor: 350_000, note: "день рождения" });
    if (back === 2) rows.push({ day: 8, categoryId: household, amountMinor: 260_000, note: "рассада", tagIds: [dacha] });
    if (back === 4) rows.push({ day: 11, categoryId: household, amountMinor: 180_000, tagIds: [dacha] });
    if (back === HISTORY_USD_BACK) rows.push({ day: HISTORY_USD_DAY, categoryId: leisure, amountMinor: HISTORY_USD_MINOR, note: "экскурсия", tagIds: [vacation], usd: true });
    const fixed = HISTORY_FOOD[i]!;
    fixed.forEach((amountMinor, purchase) => rows.push({ day: FOOD_DAYS[purchase]!, categoryId: food, amountMinor, ...(FOOD_NOTES[purchase] === undefined ? {} : { note: FOOD_NOTES[purchase] }) }));
    const spent = rows.reduce((sum, row) => sum + (row.usd ? convertMinor(row.amountMinor, HISTORY_USD_RATE) : row.amountMinor), 0);
    const last = HISTORY_TOTALS_MINOR[i]! - spent;
    // Последняя покупка добирает месяц до числа макета — и обязана остаться правдоподобной покупкой.
    if (last < 100_000 || last > 1_000_000) throw new Error(`История демо: последняя покупка продуктов ${back} мес. назад — ${last}.`);
    rows.push({ day: FOOD_DAYS[5], categoryId: food, amountMinor: last });
    rows
      .sort((left, right) => left.day - right.day)
      .forEach((row, index) => operations.push({
        id: historyId(back, index),
        occurredOn: at(row.day),
        status: "posted",
        kind: "expense",
        amountMinor: row.amountMinor,
        accountId: row.usd ? dollars : card,
        categoryId: row.categoryId,
        ...(row.note === undefined ? {} : { note: row.note }),
        ...(row.tagIds === undefined ? {} : { tagIds: row.tagIds }),
        ...(row.usd ? { baseAmountMinor: convertMinor(row.amountMinor, HISTORY_USD_RATE), baseCurrency: "RUB", rate: { ...HISTORY_USD_RATE } } : {}),
      }));
  }
  return operations;
}

/**
 * Остатки на начало, при которых «На счетах» на 19-е — те же 554 000 ₽ макетов, сколько бы истории ни
 * лежало до сцены. Карта: 5 000 ₽ сцены (ровно ушедшие в долг Саше) плюс всё, что история потратила с
 * карты, минус выплаты месяцев старше трёх — прежнее демо помнило доходы трёх месяцев. Доллары: ровно
 * то, что история потратила в долларах, — к сцене на счёте снова ноль, и покупка 1 200 $ даёт 1 200 $.
 */
function demoOpenings(month: string, history: readonly Transaction[], incomes: readonly Transaction[]): { readonly card: number; readonly dollars: number } {
  const { card, dollars } = DEMO_IDS.accounts;
  const spentFrom = (accountId: string) => history.reduce((sum, item) => sum + (item.kind === "expense" && item.accountId === accountId ? item.amountMinor : 0), 0);
  const olderThanScene = monthStartDate(shiftMonth(month, -3));
  const olderIncome = incomes.reduce((sum, item) => sum + (item.occurredOn < olderThanScene ? item.amountMinor : 0), 0);
  return { card: 500_000 + spentFrom(card) - olderIncome, dollars: spentFrom(dollars) };
}

/**
 * Счета макетов v5 при той же сумме «На счетах» 554 000 ₽ (на 19-е число): карта 418 000, наличные
 * 10 000, резерв платежей 15 000 и доллары 1 200 $ — 111 000 ₽ по курсу 92,50. Карта — прежний
 * «Основной» с тем же идентификатором: на него ссылаются доходы, платежи плана и операции сцены.
 * Остатки на начало у карты и долларов — от истории (`demoOpenings`), и «На счетах» сходится.
 */
function demoAccounts(accounts: readonly Account[], openings: { readonly card: number; readonly dollars: number }): readonly Account[] {
  return [
    ...accounts.map((account) => account.id === DEMO_IDS.accounts.card
      ? { ...account, name: "Карта", openingBalanceMinor: openings.card, sortOrder: 10 }
      : { ...account, sortOrder: 30 }),
    { id: DEMO_IDS.accounts.cash, name: "Наличные", type: "cash", currency: "RUB", openingBalanceMinor: 0, active: true, sortOrder: 20 },
    { id: DEMO_IDS.accounts.dollars, name: "Доллары", type: "savings", currency: "USD", openingBalanceMinor: openings.dollars, active: true, sortOrder: 40 },
  ];
}

/**
 * Цель макетов: «Отпуск», 45 000 из 150 000 ₽. Это прежняя цель набора под новым именем и с новой
 * суммой: взнос по плану — те же 10 000 ₽ в месяц, поэтому «свободно» и дно горизонта не двигаются.
 */
function demoGoals(goals: readonly Goal[]): readonly Goal[] {
  return goals.map((goal) => ({ ...goal, name: "Отпуск", targetMinor: 15_000_000, openingContributedMinor: 4_500_000 }));
}

/** Метки: «дача» — на двух покупках 18-го и в истории, «отпуск» — в истории (три месяца назад). */
const DEMO_TAGS: readonly Tag[] = [
  { id: DEMO_IDS.tags.vacation, name: "отпуск", active: true },
  { id: DEMO_IDS.tags.dacha, name: "дача", active: true },
];

/** Долг: Саша должен 5 000 ₽ и вернёт до 1-го следующего месяца. */
function demoDebts(month: string): readonly Debt[] {
  return [{ id: DEMO_IDS.debt, counterparty: "Саша", direction: "owed_to_me", currency: "RUB", openingMinor: 0, dueDate: monthStartDate(shiftMonth(month, 1)), active: true }];
}

/**
 * Регулярные операции макетов: зарплата 110 000 ₽ 20-го и аренда 45 000 ₽ 5-го. Модель хранит их
 * без экрана 2e, и до 2e их никто не исполняет: водяной знак стоит на конце месяца сцены, поэтому
 * ни одно вхождение не повторит записанную аренду или ожидаемую получку этого месяца.
 */
function demoRules(month: string, salaryCategoryId: string): readonly RecurringRule[] {
  const start = shiftMonth(month, -HISTORY_MONTHS);
  return [
    {
      id: DEMO_IDS.rules.salary,
      name: "Зарплата",
      template: { kind: "income", accountId: DEMO_IDS.accounts.card, categoryId: salaryCategoryId, amountMinor: SALARY_MINOR },
      frequency: "monthly",
      interval: 1,
      startDate: `${start}-${String(PAYDAY_SALARY).padStart(2, "0")}`,
      materializedThrough: monthEndDate(month),
      active: true,
    },
    {
      id: DEMO_IDS.rules.rent,
      name: "Аренда",
      template: { kind: "expense", accountId: DEMO_IDS.accounts.card, categoryId: PLANNING_IDS.categories.housing, amountMinor: 4_500_000 },
      frequency: "monthly",
      interval: 1,
      startDate: `${start}-${String(PAYDAY_ADVANCE).padStart(2, "0")}`,
      materializedThrough: monthEndDate(month),
      active: true,
    },
  ];
}

/**
 * Демо-бюджет: сцена в текущем месяце, суммы канонического набора, счета и операции макетов v5.
 *
 * Проверка на месте, а не в тесте: если сид когда-нибудь заведёт восьмую категорию или переименует
 * седьмую, молча уехать этому нельзя — суммы останутся, а имя, на которое они ссылаются, исчезнет
 * из набора и строка снова потеряет иконку.
 */
export function buildDemoBudgetState(today: string = localToday(new Date())): BudgetState {
  const seed = makePlanningSeed();
  const categories = demoCategories();
  const byId = new Map(categories.map((category) => [category.id, category]));

  for (const category of seed.categories) {
    const expected = DEMO_CATEGORY_RENAMES[category.name] ?? category.name;
    const replacement = byId.get(category.id);
    if (replacement === undefined || replacement.name !== expected) {
      throw new Error(`Демо-категория «${category.name}» не нашла себя в стартовом наборе.`);
    }
  }

  const salaryKey = categoryNameKey("Зарплата");
  const salary = categories.find((category) => categoryNameKey(category.name) === salaryKey);
  if (salary === undefined) throw new Error("В стартовом наборе нет категории «Зарплата».");

  const month = monthOfDate(today);
  const scene = transposeMonths(
    { ...seed, categories: [...categories] },
    monthIndex(month, "сегодняшний месяц") - monthIndex(CANONICAL_DEMO_MONTH),
  );

  const named = (name: string) => {
    const found = categories.find((category) => categoryNameKey(category.name) === categoryNameKey(name));
    if (found === undefined) throw new Error(`В стартовом наборе нет категории «${name}».`);
    return found.id;
  };
  const incomes = demoIncomes(month, today, salary.id, DEMO_IDS.accounts.card);
  const history = demoHistory(month, { cafe: named("Кафе и доставка"), gifts: named("Подарки и праздники") });
  const transactions: readonly Transaction[] = [...incomes, ...history, ...demoScene(month, today)];
  const recurringRules = demoRules(month, salary.id);
  return {
    ...scene,
    // Дни выплат названы (D-039): «хватает до 20-го» видно в любой день месяца, и с первого числа.
    household: { id: HOUSEHOLD_ID, baseCurrency: "RUB", paydays: [PAYDAY_ADVANCE, PAYDAY_SALARY] },
    categories: activeIncomeSources(scene.categories, transactions, recurringRules),
    accounts: demoAccounts(scene.accounts, demoOpenings(month, history, incomes)),
    goals: demoGoals(scene.goals),
    tags: DEMO_TAGS,
    exchangeRates: demoRates(month),
    debts: demoDebts(month),
    recurringRules,
    transactions,
  };
}

/**
 * Источники дохода демо — только те, по которым есть операции или регулярная запись: «Зарплата».
 * Остальные стартовые лежат в архиве, как у набора: восемь плиток по 0 ₽ в ряду «Доходы и счета»
 * выталкивали счета за край экрана, а макет 06 показывает «Зарплату» и сразу счета. Числа бюджета от
 * этого не меняются: у архивного источника нет ни одной операции.
 */
function activeIncomeSources(categories: readonly Category[], transactions: readonly Transaction[], rules: readonly RecurringRule[]): readonly Category[] {
  const used = new Set<string>();
  for (const item of transactions) if ("categoryId" in item && typeof item.categoryId === "string") used.add(item.categoryId);
  for (const rule of rules) if ("categoryId" in rule.template && typeof rule.template.categoryId === "string") used.add(rule.template.categoryId);
  return categories.map((category) => (category.type === "income" && !used.has(category.id) ? { ...category, active: false } : category));
}
