import {
  DEFAULT_CATEGORIES,
  makePlanningSeed,
  normalizeCategoryName,
  PLANNING_IDS,
  type BudgetState,
  type Category,
} from "@family-budget/domain";

/**
 * Демонстрационный бюджет: канонический G-002 на стартовом наборе категорий.
 *
 * Числа берутся из `makePlanningSeed()` и не пересчитываются здесь ни одного: демо построено на
 * каноническом наборе, его июльский резерв `19 809 ₽` и «свободно» `44 191 ₽` названы поимённо в
 * приёмке. Меняется только словарь категорий — то, чем демо описывает свои суммы.
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
 * Канонический демо-бюджет со стартовым набором категорий.
 *
 * Проверка на месте, а не в тесте: если сид когда-нибудь заведёт восьмую категорию или переименует
 * седьмую, молча уехать этому нельзя — суммы останутся, а имя, на которое они ссылаются, исчезнет
 * из набора и строка снова потеряет иконку.
 */
export function buildDemoBudgetState(): BudgetState {
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

  return { ...seed, categories: [...categories] };
}
