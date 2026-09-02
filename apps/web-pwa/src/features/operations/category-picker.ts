import {
  CATEGORY_GROUPS,
  categoryGroupDefinition,
  categoryNameKey,
  findCategoryByName,
  resolveCategoryGroup,
  suggestedCategories,
  type BudgetState,
  type Category,
  type CategoryGroup,
  type CategoryTemplate,
  type CategoryType,
} from "@family-budget/domain";

/** Значение, которым выбор категории говорит «ни одной»: доход без категории. */
export const NO_CATEGORY_VALUE = "";

/**
 * Значение последнего элемента списка. Не идентификатор — ни одна категория не может его носить,
 * потому что каждый идентификатор здесь UUID, а решётка в UUID не встречается.
 */
export const CUSTOM_CATEGORY_VALUE = "#custom";

export interface CategoryOption {
  readonly id: string;
  readonly name: string;
  readonly archived: boolean;
}

/** Группа с заголовком: порядок и подпись берутся из закрытого перечня домена. */
export interface CategoryOptionGroup {
  readonly key: CategoryGroup;
  readonly title: string;
  readonly options: readonly CategoryOption[];
}

/**
 * Ключ поиска: тот же NFKC + локальный нижний регистр, которым домен сверяет названия.
 *
 * Одно правило на сравнение и на поиск — иначе «ТАКСИ» нашло бы «Такси», а сохранение объявило бы
 * их разными категориями.
 */
export function categoryQueryKey(value: string): string {
  return categoryNameKey(value);
}

/** Подстрока, а не префикс: «аптек» обязано находить «Здоровье и аптека». */
export function matchesCategoryQuery(name: string, query: string): boolean {
  const needle = categoryQueryKey(query);
  return needle.length === 0 || categoryQueryKey(name).includes(needle);
}

function groupOrder(group: CategoryGroup): number {
  return categoryGroupDefinition(group).order;
}

/**
 * Категории одного вида, разложенные по группам домена и отфильтрованные строкой поиска.
 *
 * `selectedId` показывается всегда — и когда он в архиве, и когда не подходит под фильтр:
 * список, из которого пропало собственное значение, врёт о том, что выбрано.
 */
export function groupedCategoryOptions(
  state: Pick<BudgetState, "categories">,
  type: CategoryType,
  query = "",
  selectedId?: string,
): readonly CategoryOptionGroup[] {
  const visible = state.categories.filter(
    (item) =>
      item.type === type &&
      (item.active || item.id === selectedId) &&
      (item.id === selectedId || matchesCategoryQuery(item.name, query)),
  );
  const byGroup = new Map<CategoryGroup, { option: CategoryOption; order: number }[]>();
  for (const item of visible) {
    const group = resolveCategoryGroup(item);
    const options = byGroup.get(group) ?? [];
    options.push({
      option: { id: item.id, name: item.name, archived: !item.active },
      order: Number.isSafeInteger(item.sortOrder) ? item.sortOrder : 0,
    });
    byGroup.set(group, options);
  }
  return [...byGroup.entries()]
    .map(([key, entries]) => ({
      key,
      title: categoryGroupDefinition(key).title,
      options: entries
        .sort(
          (left, right) =>
            left.order - right.order ||
            left.option.name.localeCompare(right.option.name, "ru-RU"),
        )
        .map((entry) => entry.option),
    }))
    .sort((left, right) => groupOrder(left.key) - groupOrder(right.key));
}

/** Заголовки групп этого вида в порядке домена — то, из чего выбирают группу новой категории. */
export function groupChoicesFor(type: CategoryType): readonly { key: CategoryGroup; title: string }[] {
  return CATEGORY_GROUPS.filter((group) => group.type === type).map((group) => ({
    key: group.key,
    title: group.title,
  }));
}

export interface CategoryPickerView {
  readonly groups: readonly CategoryOptionGroup[];
  /** Совпадений нет: единственный результат — предложение создать введённое название. */
  readonly empty: boolean;
  /** Подпись последнего элемента списка. */
  readonly createLabel: string;
  /** Чем заполнить имя в листе создания, если пользователь выберет последний элемент. */
  readonly createName: string;
  /** Что объявить вслух после изменения фильтра. */
  readonly status: string;
}

function countOptions(groups: readonly CategoryOptionGroup[]): number {
  return groups.reduce((sum, group) => sum + group.options.length, 0);
}

function foundMessage(count: number): string {
  const tail = count % 10;
  const teen = count % 100;
  if (tail === 1 && teen !== 11) return `Найдена ${count} категория`;
  if (tail >= 2 && tail <= 4 && (teen < 12 || teen > 14)) return `Найдено ${count} категории`;
  return `Найдено ${count} категорий`;
}

/**
 * Полный вид выбора категории: группы, счётчик для объявления и последний элемент.
 *
 * Последний элемент есть всегда — «Своя категория». Когда фильтр не нашёл ничего, он остаётся
 * единственным и называет то, что человек уже набрал: тупика «ничего не найдено» здесь нет.
 */
export function categoryPickerView(
  state: Pick<BudgetState, "categories">,
  type: CategoryType,
  query = "",
  selectedId?: string,
): CategoryPickerView {
  const groups = groupedCategoryOptions(state, type, query, selectedId);
  const count = countOptions(groups);
  const trimmed = query.trim();
  const empty = count === 0;
  return {
    groups: empty ? [] : groups,
    empty,
    createLabel: empty && trimmed.length > 0 ? `Создать «${trimmed}»` : "Своя категория",
    createName: trimmed,
    status: empty
      ? trimmed.length > 0
        ? `Ничего не найдено. Можно создать «${trimmed}».`
        : "Категорий пока нет. Можно создать свою."
      : foundMessage(count),
  };
}

export type CategoryNameOutcome =
  | { readonly kind: "free" }
  | { readonly kind: "restore"; readonly category: Category; readonly message: string }
  | { readonly kind: "duplicate"; readonly category: Category; readonly message: string }
  | { readonly kind: "similar"; readonly category: Category; readonly message: string };

const SIMILARITY_MIN_LENGTH = 3;

/**
 * Что делать с введённым названием: создать, вернуть из архива, выбрать существующую или просто
 * иметь в виду похожую.
 *
 * Точное совпадение с архивной категорией — не дубль, а забытая своя: домен разрешает завести
 * вторую, но два «Такси» в списке — это то, ради чего поиск и затевался, поэтому предлагается
 * вернуть первую. Точное совпадение с активной домен отвергает, и здесь оно превращается в
 * предложение выбрать её, а не в отказ. Похожая активная не мешает ничему: это подсказка, после
 * которой сохранение всё равно проходит.
 */
export function categoryNameOutcome(
  state: Pick<BudgetState, "categories">,
  name: string,
  type: CategoryType,
): CategoryNameOutcome {
  const trimmed = name.trim();
  if (trimmed.length === 0) return { kind: "free" };
  const exact = findCategoryByName(state, trimmed, type);
  if (exact && !exact.active) {
    return {
      kind: "restore",
      category: exact,
      message: `«${exact.name}» уже была — сейчас в архиве. Вернуть её, а не заводить вторую?`,
    };
  }
  if (exact) {
    return {
      kind: "duplicate",
      category: exact,
      message: `«${exact.name}» уже есть в списке. Выбрать её?`,
    };
  }
  const key = categoryQueryKey(trimmed);
  if (key.length < SIMILARITY_MIN_LENGTH) return { kind: "free" };
  const similar = state.categories.find((item) => {
    if (!item.active || item.type !== type) return false;
    const other = categoryQueryKey(item.name);
    if (other.length < SIMILARITY_MIN_LENGTH || other === key) return false;
    return other.includes(key) || key.includes(other);
  });
  if (!similar) return { kind: "free" };
  return {
    kind: "similar",
    category: similar,
    message: `Похоже на «${similar.name}». Если это то же самое — выберите её в списке.`,
  };
}

/**
 * Готовые названия для листа создания: каталог второго эшелона домена без того, что уже заведено.
 * Фильтр здесь тот же, что и в списке, — набранное имя сужает и подсказки.
 */
export function categorySuggestions(
  state: Pick<BudgetState, "categories">,
  type: CategoryType,
  query = "",
): readonly CategoryTemplate[] {
  return suggestedCategories(state, type).filter((template) =>
    matchesCategoryQuery(template.name, query),
  );
}
