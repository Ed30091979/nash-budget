import {
  DEFAULT_CATEGORIES,
  categoryNameKey,
  makePlanningSeed,
  monthIndex,
  monthOfDate,
  monthEndDate,
  monthStartDate,
  normalizeCategoryName,
  PLANNING_IDS,
  shiftDate,
  shiftMonth,
  type BudgetState,
  type Category,
  type Transaction,
} from "@family-budget/domain";

import { localToday } from "../reach";

/**
 * Демонстрационный бюджет: канонический G-002 на стартовом наборе категорий.
 *
 * Числа берутся из `makePlanningSeed()` и не пересчитываются здесь ни одного: демо построено на
 * каноническом наборе, его первый месяц — резерв `19 809 ₽` и «свободно» `44 191 ₽`, дно
 * горизонта `13 191 ₽` — названы поимённо в приёмке. Меняются три вещи: словарь категорий,
 * календарь сцены и история доходов.
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

/** Число месяца, на которое приходится аванс, и число получки — из них выводится линейка. */
const PAYDAY_ADVANCE = 5;
const PAYDAY_SALARY = 20;
/** Аванс и получка в сумме дают канонические 180 000 ₽ планового дохода месяца. */
const ADVANCE_MINOR = 7_000_000;
const SALARY_MINOR = 11_000_000;
/**
 * Сколько прошлых месяцев демо помнит.
 *
 * Расписанием число месяца становится с двух повторений в разные месяцы (`paydayDays`), но
 * выплаты, которые ещё не наступили, в вывод не идут: первого числа месяца обе сегодняшние
 * выплаты впереди. Трёх прошлых месяцев хватает на любой день календаря.
 */
const HISTORY_MONTHS = 3;

/** Выплаты одного месяца: число и сумма. */
const DEMO_PAYDAYS: readonly (readonly [day: number, amountMinor: number])[] = [
  [PAYDAY_ADVANCE, ADVANCE_MINOR],
  [PAYDAY_SALARY, SALARY_MINOR],
];

/**
 * Регулярные доходы: аванс 5-го и получка 20-го, в этом месяце и в трёх предыдущих.
 *
 * Дат выплат в домене нет, и заводить их нельзя — это миграция хранилища и новая операция
 * журнала. Приложение выводит их из дат уже записанных доходов (`reach.ts`), и потому демо без
 * истории доходов не показывало ни аванса на оси года, ни насечки выплаты на линейке: витрина
 * молчала как раз о том, ради чего всё делалось. Одна операция «18 000 000 первого числа»
 * расписанием не является — расписание начинается там, где число повторилось в разные месяцы.
 *
 * Сумма месяца остаётся канонической: `7 000 000 + 11 000 000` — это те же 180 000 ₽, и ни
 * одной суммы бюджета это не двигает. Доходы прошлых месяцев лежат вне периода плана, а домен
 * считает бюджет только по операциям своего периода — они не двигают ни остатка, ни капитала.
 */
function demoIncomes(month: string, salaryCategoryId: string, accountId: string): readonly Transaction[] {
  const incomes: Transaction[] = [];
  for (let back = HISTORY_MONTHS; back >= 0; back -= 1) {
    const paid = shiftMonth(month, -back);
    DEMO_PAYDAYS.forEach(([day, amountMinor], index) => {
      incomes.push({
        id: demoIncomeId(back * DEMO_PAYDAYS.length + index),
        occurredOn: `${paid}-${String(day).padStart(2, "0")}`,
        status: "posted",
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
 * Канонический демо-бюджет: сцена в текущем месяце, суммы канонического набора.
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
  const accountId = scene.transactions.find((item) => item.kind === "income")?.accountId
    ?? scene.accounts[0]!.id;

  return {
    ...scene,
    transactions: [
      ...demoIncomes(month, salary.id, accountId),
      ...scene.transactions.filter((item) => item.kind !== "income"),
    ],
  };
}
