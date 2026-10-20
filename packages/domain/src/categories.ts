import type {
  BudgetState,
  Category,
  CategoryGroup,
  CategoryGroupDefinition,
  CategoryId,
  CategoryTemplate,
  CategoryType,
  DisplayKey,
  StoredCategoryGroup,
} from "./types.js";
import { MAX_SORT_ORDER } from "./limits.js";
import { isDisplayKey, labelKey, normalizeLabel, TextValidationError, type TextErrorCode } from "./text.js";

/**
 * Groups are a closed set, not free text: the interface prints these titles as headings and
 * sorts by {@link CategoryGroupDefinition.order}, so a new group has to be added here to exist.
 *
 * Display order: everyday spending first — it is what a family taps many times a day, so «Продукты»
 * opens «Обзор», the entry picker and the categories screen — then mandatory payments, then
 * personal, then «Прочее» (D-041). One order everywhere, as before; only the order changed.
 */
export const CATEGORY_GROUPS: readonly CategoryGroupDefinition[] = [
  { key: "everyday", title: "Каждый день", type: "expense", order: 10 },
  { key: "mandatory", title: "Обязательные платежи", type: "expense", order: 20 },
  { key: "personal", title: "Личное и досуг", type: "expense", order: 30 },
  { key: "other", title: "Прочее", type: "expense", order: 40 },
  { key: "income", title: "Доходы", type: "income", order: 50 },
] as const;

const GROUPS_BY_KEY = new Map<string, CategoryGroupDefinition>(
  CATEGORY_GROUPS.map((group) => [group.key, group]),
);

/** The one group income may use, and the fallback for an expense whose group is unreadable. */
const INCOME_GROUP: CategoryGroup = "income";
const FALLBACK_EXPENSE_GROUP: CategoryGroup = "other";

/**
 * Free-form group labels written before the closed set existed. Restoring such a backup must
 * never lose a category, so every label that ever shipped is mapped and anything unknown falls
 * back to "Прочее" instead of throwing.
 */
const LEGACY_GROUP_LABELS: Readonly<Record<string, CategoryGroup>> = {
  "обязательные": "mandatory",
  "обязательные расходы": "mandatory",
  "обязательные платежи": "mandatory",
  "жильё и счета": "mandatory",
  "жилье и счета": "mandatory",
  "повседневные": "everyday",
  "повседневные расходы": "everyday",
  "необходимые переменные": "everyday",
  "каждый день": "everyday",
  "семья": "everyday",
  "дети": "everyday",
  "дом": "everyday",
  "личное и досуг": "personal",
  "досуг": "personal",
  "необязательные": "personal",
  "прочее": "other",
  "прочие": "other",
  "доходы": "income",
  "доход": "income",
};

export function isCategoryGroup(value: string): value is CategoryGroup {
  return GROUPS_BY_KEY.has(value);
}

export function categoryGroupDefinition(group: CategoryGroup): CategoryGroupDefinition {
  const definition = GROUPS_BY_KEY.get(group);
  if (!definition) throw new Error(`unknown category group ${group}`);
  return definition;
}

/**
 * The group a category belongs to, whatever its document wrote there. Income always resolves to
 * the income group; an expense resolves to its key, then to a known legacy label, then to
 * "Прочее". Never throws: a category is not worth losing over an unrecognised label.
 */
export function resolveCategoryGroup(
  category: { readonly type: CategoryType; readonly group: StoredCategoryGroup },
): CategoryGroup {
  if (category.type === "income") return INCOME_GROUP;
  const raw = String(category.group ?? "");
  if (isCategoryGroup(raw) && categoryGroupDefinition(raw).type === "expense") return raw;
  // An own key or nothing: a group written as "constructor" or "__proto__" would otherwise find
  // Object or Object.prototype in the plain table, and the definition lookup below would throw.
  const key = raw.normalize("NFKC").trim().toLocaleLowerCase("ru-RU");
  const legacy = Object.hasOwn(LEGACY_GROUP_LABELS, key) ? LEGACY_GROUP_LABELS[key] : undefined;
  if (legacy !== undefined && categoryGroupDefinition(legacy).type === "expense") return legacy;
  return FALLBACK_EXPENSE_GROUP;
}

/**
 * Fifteen expense categories a Russian household actually pays. "Жильё" and "ЖКХ" stay apart on
 * purpose: the Rosstat housing article excludes rent and mortgage, so one line would mix a
 * payment the family can move house to change with one it cannot. "Кредиты и рассрочки" is here
 * because a quarter of households service a loan (Банк России) with a median near a sixth of
 * income, while the consumption classifications carry no such article at all.
 */
export const DEFAULT_EXPENSE_CATEGORIES: readonly CategoryTemplate[] = [
  { name: "Жильё", type: "expense", group: "mandatory" },
  { name: "ЖКХ", type: "expense", group: "mandatory" },
  { name: "Связь и подписки", type: "expense", group: "mandatory" },
  { name: "Кредиты и рассрочки", type: "expense", group: "mandatory" },
  { name: "Продукты", type: "expense", group: "everyday" },
  { name: "Транспорт", type: "expense", group: "everyday" },
  { name: "Дом и хозяйство", type: "expense", group: "everyday" },
  { name: "Здоровье и аптека", type: "expense", group: "everyday" },
  { name: "Дети", type: "expense", group: "everyday" },
  { name: "Кафе и доставка", type: "expense", group: "personal" },
  { name: "Одежда и обувь", type: "expense", group: "personal" },
  { name: "Красота и уход", type: "expense", group: "personal" },
  { name: "Развлечения и хобби", type: "expense", group: "personal" },
  { name: "Подарки и праздники", type: "expense", group: "personal" },
  { name: "Прочее", type: "expense", group: "other" },
] as const;

/** Eight income categories: without them the income side has no vocabulary at all. */
export const DEFAULT_INCOME_CATEGORIES: readonly CategoryTemplate[] = [
  { name: "Зарплата", type: "income", group: "income" },
  { name: "Премия и бонусы", type: "income", group: "income" },
  { name: "Подработка и самозанятость", type: "income", group: "income" },
  { name: "Пособия и выплаты", type: "income", group: "income" },
  { name: "Пенсия", type: "income", group: "income" },
  { name: "Кешбэк и проценты", type: "income", group: "income" },
  { name: "Подарки и помощь", type: "income", group: "income" },
  { name: "Прочие доходы", type: "income", group: "income" },
] as const;

/** Everything a fresh household starts with, expenses first, in display order. */
export const DEFAULT_CATEGORIES: readonly CategoryTemplate[] = [
  ...DEFAULT_EXPENSE_CATEGORIES,
  ...DEFAULT_INCOME_CATEGORIES,
] as const;

/**
 * Second tier: data, not categories. Nothing here is created for anyone; the interface offers
 * these as ready-made names when a family adds its own category, so the common ones are spelled
 * consistently instead of appearing as "такси", "Такси " and "Такси/каршеринг" in three budgets.
 */
export const CATEGORY_SUGGESTIONS: readonly CategoryTemplate[] = [
  { name: "Автомобиль", type: "expense", group: "everyday" },
  { name: "Такси", type: "expense", group: "everyday" },
  { name: "Питомцы", type: "expense", group: "everyday" },
  { name: "Отпуск и поездки", type: "expense", group: "personal" },
  { name: "Образование", type: "expense", group: "everyday" },
  { name: "Дача и участок", type: "expense", group: "everyday" },
  { name: "Ремонт и техника", type: "expense", group: "everyday" },
  { name: "Спорт и абонементы", type: "expense", group: "personal" },
  { name: "Налоги и госпошлины", type: "expense", group: "mandatory" },
  { name: "Страхование", type: "expense", group: "mandatory" },
  { name: "Помощь родным", type: "expense", group: "other" },
  { name: "Благотворительность", type: "expense", group: "other" },
  { name: "Электроника и гаджеты", type: "expense", group: "personal" },
  { name: "Алкоголь и табак", type: "expense", group: "personal" },
  { name: "Аренда", type: "income", group: "income" },
  { name: "Дивиденды и купоны", type: "income", group: "income" },
  { name: "Продажа вещей", type: "income", group: "income" },
  { name: "Возврат налога", type: "income", group: "income" },
  { name: "Алименты", type: "income", group: "income" },
  { name: "Стипендия", type: "income", group: "income" },
  { name: "Возврат долга", type: "income", group: "income" },
  { name: "Компенсации", type: "income", group: "income" },
  { name: "Выигрыш", type: "income", group: "income" },
] as const;

export const CATEGORY_NAME_MAX_LENGTH = 80;

export type CategoryErrorCode =
  | "name_required"
  | "name_too_long"
  | "name_forbidden_characters"
  | "name_mixed_scripts"
  | "duplicate_name"
  | "unknown_type"
  | "unknown_group"
  | "group_type_mismatch"
  | "id_required"
  | "duplicate_id"
  | "sort_order_overflow"
  | "unknown_category"
  | "invalid_icon"
  | "invalid_color";

export type CategoryField = "name" | "type" | "group" | "id" | "icon" | "color";

/** Refusal a person is meant to read: `code` for the caller, `message` for the screen. */
export class CategoryValidationError extends Error {
  readonly code: CategoryErrorCode;
  readonly field: CategoryField;

  constructor(code: CategoryErrorCode, field: CategoryField, message: string) {
    super(message);
    this.name = "CategoryValidationError";
    this.code = code;
    this.field = field;
  }
}

function fail(
  code: CategoryErrorCode,
  field: CategoryField,
  message: string,
): never {
  throw new CategoryValidationError(code, field, message);
}

/** The text rule's refusals, in the codes and words a category has always answered with. */
const NAME_REFUSALS: Readonly<Record<TextErrorCode, readonly [CategoryErrorCode, string]>> = {
  required: ["name_required", "Укажите название."],
  too_long: ["name_too_long", `Не более ${CATEGORY_NAME_MAX_LENGTH} символов.`],
  forbidden_characters: ["name_forbidden_characters", "Уберите скрытые или служебные символы."],
  mixed_scripts: ["name_mixed_scripts", "Не смешивайте похожие символы разных алфавитов."],
};

/** Trims and normalises a name the way it will be stored, or refuses it. See `normalizeLabel`. */
export function normalizeCategoryName(value: string): string {
  try {
    return normalizeLabel(value, CATEGORY_NAME_MAX_LENGTH);
  } catch (error) {
    if (!(error instanceof TextValidationError)) throw error;
    const [code, message] = NAME_REFUSALS[error.code];
    return fail(code, "name", message);
  }
}

/** Comparison key for duplicate detection: case- and width-insensitive, Russian locale. */
export function categoryNameKey(value: string): string {
  return labelKey(value);
}

/**
 * The category of that type carrying that name, archived ones included. The interface uses it to
 * offer restoring an archived category instead of creating a second one with the same name.
 */
export function findCategoryByName(
  state: Pick<BudgetState, "categories">,
  name: string,
  type: CategoryType,
): Category | undefined {
  const key = categoryNameKey(name);
  return state.categories.find((item) => item.type === type && categoryNameKey(item.name) === key);
}

function assertType(type: CategoryType): void {
  if (type !== "income" && type !== "expense") {
    fail("unknown_type", "type", "Категория бывает только доходной или расходной.");
  }
}

function groupFor(type: CategoryType, group: CategoryGroup | undefined): CategoryGroup {
  if (group === undefined) return type === "income" ? INCOME_GROUP : FALLBACK_EXPENSE_GROUP;
  if (!isCategoryGroup(group)) fail("unknown_group", "group", "Выберите группу из списка.");
  if (categoryGroupDefinition(group).type !== type) {
    fail("group_type_mismatch", "group", "Группа не подходит для этого вида категории.");
  }
  return group;
}

function nextSortOrder(categories: readonly Category[], group: CategoryGroup): number {
  const inGroup = categories.filter((item) => resolveCategoryGroup(item) === group);
  const pool = inGroup.length > 0 ? inGroup : categories;
  const highest = pool.reduce(
    (max, item) => (Number.isSafeInteger(item.sortOrder) && item.sortOrder > max ? item.sortOrder : max),
    0,
  );
  const next = highest + 10;
  if (!Number.isSafeInteger(next)) fail("sort_order_overflow", "group", "Порядок категорий слишком велик.");
  return next;
}

export interface CategoryDraft {
  readonly name: string;
  readonly type: CategoryType;
  /** Omitted means "Прочее" for an expense and the single income group for income. */
  readonly group?: CategoryGroup;
}

export interface CategoryCreation {
  readonly state: BudgetState;
  readonly category: Category;
}

/**
 * Creates a category on its own. Deliberately independent of budget lines: a category is needed
 * for a large payment, for a schedule and for income just as much as for an everyday limit, and
 * before this existed the only way to get one was to declare an everyday limit first.
 *
 * Refuses an empty name and a name an active category of the same type already carries; an
 * archived namesake is not a duplicate, and {@link findCategoryByName} lets the caller offer to
 * restore it instead. Nothing else in the state moves, and no figure changes: the new category
 * has no plan and no operations until someone gives it one.
 */
export function createCategory(
  state: BudgetState,
  draft: CategoryDraft,
  makeId: () => CategoryId = () => crypto.randomUUID(),
): CategoryCreation {
  assertType(draft.type);
  const group = groupFor(draft.type, draft.group);
  const name = normalizeCategoryName(draft.name);
  const key = categoryNameKey(name);
  const clash = state.categories.some(
    (item) => item.active && item.type === draft.type && categoryNameKey(item.name) === key,
  );
  if (clash) {
    fail("duplicate_name", "name", "Активная категория с таким названием уже существует.");
  }

  const id = makeId();
  if (typeof id !== "string" || id.trim().length === 0) {
    fail("id_required", "id", "Не удалось создать идентификатор категории.");
  }
  if (state.categories.some((item) => item.id === id)) {
    fail("duplicate_id", "id", "Не удалось создать уникальный идентификатор категории.");
  }

  const category: Category = {
    id,
    name,
    type: draft.type,
    group,
    active: true,
    sortOrder: nextSortOrder(state.categories, group),
  };
  return { state: { ...state, categories: [...state.categories, category] }, category };
}

/**
 * Turns a catalogue into categories. Used for the starting set; the same call builds any subset,
 * so the interface can offer the second tier through exactly this path.
 */
export function makeCategoriesFromTemplates(
  templates: readonly CategoryTemplate[],
  makeId: () => CategoryId = () => crypto.randomUUID(),
): readonly Category[] {
  const ids = new Set<CategoryId>();
  return templates.map((template, index) => {
    const id = makeId();
    if (typeof id !== "string" || id.trim().length === 0) {
      fail("id_required", "id", "Не удалось создать идентификатор категории.");
    }
    if (ids.has(id)) fail("duplicate_id", "id", "Не удалось создать уникальный идентификатор категории.");
    ids.add(id);
    return {
      id,
      name: normalizeCategoryName(template.name),
      type: template.type,
      group: groupFor(template.type, template.group),
      active: true,
      sortOrder: (index + 1) * 10,
    };
  });
}

/** The fifteen expense and eight income categories a new household starts with. */
export function makeDefaultCategories(
  makeId: () => CategoryId = () => crypto.randomUUID(),
): readonly Category[] {
  return makeCategoriesFromTemplates(DEFAULT_CATEGORIES, makeId);
}

/**
 * Catalogue entries not yet present as an active category of the same type, in catalogue order.
 * What the interface shows as suggestions when a family adds a category of its own.
 */
export function suggestedCategories(
  state: Pick<BudgetState, "categories">,
  type?: CategoryType,
): readonly CategoryTemplate[] {
  const taken = new Set(
    state.categories
      .filter((item) => item.active)
      .map((item) => `${item.type}\u0000${categoryNameKey(item.name)}`),
  );
  return CATEGORY_SUGGESTIONS.filter(
    (template) =>
      (type === undefined || template.type === type) &&
      !taken.has(`${template.type}\u0000${categoryNameKey(template.name)}`),
  );
}

/** A change to a category; a field left out stays as it is. `null` clears a display key. */
export interface CategoryPatch {
  readonly name?: string;
  readonly icon?: DisplayKey | null;
  readonly color?: DisplayKey | null;
  /** Another group of the same type; income has the one group. */
  readonly group?: CategoryGroup;
}

function requireCategory(state: Pick<BudgetState, "categories">, id: CategoryId): Category {
  const category = state.categories.find((item) => item.id === id);
  if (category === undefined) fail("unknown_category", "id", "Категория не найдена.");
  return category;
}

function displayKeyOf(value: DisplayKey | null | undefined, field: "icon" | "color"): DisplayKey | null | undefined {
  if (value === undefined || value === null) return value;
  if (!isDisplayKey(value)) {
    fail(field === "icon" ? "invalid_icon" : "invalid_color", field, field === "icon" ? "Выберите иконку из списка." : "Выберите цвет из списка.");
  }
  return value;
}

/**
 * Renames a category, gives it an icon and a tone of the family's choice (D-036), or moves it to
 * another group of its type. Refuses what {@link createCategory} refuses for the same field — a
 * malformed name, a name another active category of the type carries, a group of the other type — and
 * a display key that is not one. A category moved to another group goes to the end of it, so it is
 * not wedged between two of the group's own in the middle of the list.
 *
 * Nothing the budget counts moves: operations, limits and plans name the category by identifier, so
 * a renamed «Продукты» keeps every kopeck it had. A patch that changes nothing returns the very same
 * state, so the journal sees no update.
 */
export function updateCategory(state: BudgetState, id: CategoryId, patch: CategoryPatch): BudgetState {
  const current = requireCategory(state, id);
  const name = patch.name === undefined ? current.name : normalizeCategoryName(patch.name);
  if (current.active && categoryNameKey(name) !== categoryNameKey(current.name)) {
    const key = categoryNameKey(name);
    const clash = state.categories.some(
      (item) => item.id !== id && item.active && item.type === current.type && categoryNameKey(item.name) === key,
    );
    if (clash) fail("duplicate_name", "name", "Активная категория с таким названием уже существует.");
  }
  const icon = displayKeyOf(patch.icon, "icon");
  const color = displayKeyOf(patch.color, "color");
  let group: StoredCategoryGroup = current.group;
  let sortOrder = current.sortOrder;
  if (patch.group !== undefined && patch.group !== resolveCategoryGroup(current)) {
    const target = groupFor(current.type, patch.group);
    group = target;
    sortOrder = nextSortOrder(state.categories.filter((item) => item.id !== id), target);
    if (sortOrder > MAX_SORT_ORDER) fail("sort_order_overflow", "group", "Порядок категорий слишком велик.");
  }
  const { icon: _icon, color: _color, ...rest } = current;
  const nextIcon = icon === undefined ? current.icon : icon ?? undefined;
  const nextColor = color === undefined ? current.color : color ?? undefined;
  const next: Category = {
    ...rest,
    name,
    group,
    sortOrder,
    ...(nextIcon === undefined ? {} : { icon: nextIcon }),
    ...(nextColor === undefined ? {} : { color: nextColor }),
  };
  const keys = new Set([...Object.keys(current), ...Object.keys(next)]) as Set<keyof Category>;
  if ([...keys].every((key) => current[key] === next[key])) return state;
  return { ...state, categories: state.categories.map((item) => (item.id === id ? next : item)) };
}

/** The active categories of one type and group, in the order the interface lists them. */
export function categoriesInGroupOrder(
  categories: readonly Category[],
  type: CategoryType,
  group: CategoryGroup,
): readonly Category[] {
  return categories
    .map((category, index) => ({ category, index }))
    .filter(({ category }) => category.active && category.type === type && resolveCategoryGroup(category) === group)
    .sort((left, right) => left.category.sortOrder - right.category.sortOrder || left.index - right.index)
    .map(({ category }) => category);
}

/**
 * Active categories of one type in the order every list shows them: group after group in
 * {@link CATEGORY_GROUPS} order, and inside a group as {@link categoriesInGroupOrder} puts them. The
 * tiles of «Обзор», the entry picker and the categories screen read one order, so «Выше / Ниже»
 * moves a tile everywhere at once.
 */
export function categoriesInListOrder(categories: readonly Category[], type: CategoryType): readonly Category[] {
  return CATEGORY_GROUPS.filter((group) => group.type === type).flatMap((group) => categoriesInGroupOrder(categories, type, group.key));
}

/**
 * Moves an active category one place up or down inside its group. Two positions swap and only those
 * two categories change, for the reason `moveAccount` gives: every update is a whole entity in the
 * journal. Tied positions in the group are first spread apart in their current order. At either end,
 * or for an archived category, the state stays as it is.
 */
export function moveCategory(state: BudgetState, id: CategoryId, direction: "up" | "down"): BudgetState {
  const category = requireCategory(state, id);
  if (!category.active) return state;
  const group = resolveCategoryGroup(category);
  const members = categoriesInGroupOrder(state.categories, category.type, group);
  const at = members.findIndex((item) => item.id === id);
  const neighbour = members[direction === "up" ? at - 1 : at + 1];
  if (neighbour === undefined) return state;

  const positions = new Map(members.map((item) => [item.id, item.sortOrder]));
  if (new Set(positions.values()).size !== positions.size) {
    let previous = Number.NEGATIVE_INFINITY;
    for (const item of members) {
      const next = Math.max(item.sortOrder, previous + 1);
      if (!Number.isSafeInteger(next) || next > MAX_SORT_ORDER) fail("sort_order_overflow", "group", "Порядок категорий слишком велик.");
      positions.set(item.id, next);
      previous = next;
    }
  }
  const mine = positions.get(category.id) ?? category.sortOrder;
  positions.set(category.id, positions.get(neighbour.id) ?? neighbour.sortOrder);
  positions.set(neighbour.id, mine);
  return {
    ...state,
    categories: state.categories.map((item) => {
      const sortOrder = positions.get(item.id);
      return sortOrder === undefined || sortOrder === item.sortOrder ? item : { ...item, sortOrder };
    }),
  };
}
