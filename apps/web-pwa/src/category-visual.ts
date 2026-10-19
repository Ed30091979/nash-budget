import {
  categoryNameKey,
  resolveCategoryGroup,
  type AccountType,
  type CategoryGroup,
  type CategoryType,
  type DisplayKey,
  type StoredCategoryGroup,
} from "@family-budget/domain";
import { ICON_NAMES, type IconName } from "./components/Icon";

/**
 * Иконка и тон категории (DESIGN §3 «Тона сущностей», §6 «Плитка категории»).
 *
 * С D-036 у категории есть поля `icon` и `color` — синхронизируемые ключи оформления, которые
 * выбирает семья (экраны выбора — подволна 2c). Они читаются первыми; без них — или с ключом,
 * которого эта сборка не знает, — вид выводится, как прежде, по имени (`categoryNameKey`, та же
 * нормализация, что у поиска дубликатов) и по группе (`resolveCategoryGroup`).
 *
 * Ключ оформления — данные чужого устройства (SECURITY §7.2). Поэтому таблицы здесь — `Map`, а не
 * обычные объекты: имя категории «constructor» или «__proto__» и ключ «toString» не находят в них
 * ничего унаследованного, и неизвестный ключ даёт запасной вид, а не исключение.
 *
 * Тон кодирует категорию, а не величину: NN/g прямо предупреждает, что цветом нельзя передавать
 * количество. Поэтому «Продукты» окрашены одинаково и в перерасходе, и в норме, а состояние
 * лимита говорит словами статус-чипа.
 *
 * Категория, которой в карте нет — своя, придуманная семьёй, — получает тон своей группы и
 * нейтральный глиф-ярлык. Пустой плитки не бывает: пустая плитка читается как незагрузившаяся
 * картинка.
 */
export type CategoryTone = "mint" | "lilac" | "peach" | "amber" | "sage" | "coral" | "neutral";

export interface CategoryVisual {
  readonly icon: IconName;
  readonly tone: CategoryTone;
}

/** То немногое от категории, что нужно для её вида. Больше запрашивать не с чего. */
export interface CategoryLike {
  readonly name: string;
  readonly type: CategoryType;
  readonly group: StoredCategoryGroup;
  /** Ключ глифа из спрайта, выбранный семьёй (D-036); необязателен. */
  readonly icon?: DisplayKey;
  /** Ключ тона, выбранный семьёй (D-036); необязателен. */
  readonly color?: DisplayKey;
}

const BY_NAME: ReadonlyMap<string, CategoryVisual> = new Map(Object.entries({
  // Обязательные платежи
  "жильё": { icon: "house", tone: "sage" },
  "жкх": { icon: "zap", tone: "amber" },
  "связь и подписки": { icon: "wifi", tone: "lilac" },
  "кредиты и рассрочки": { icon: "credit-card", tone: "coral" },
  "налоги и госпошлины": { icon: "landmark", tone: "coral" },
  "страхование": { icon: "shield", tone: "lilac" },
  // Каждый день
  "продукты": { icon: "shopping-basket", tone: "mint" },
  "транспорт": { icon: "bus", tone: "lilac" },
  "дом и хозяйство": { icon: "lamp", tone: "amber" },
  "здоровье и аптека": { icon: "pill", tone: "coral" },
  "дети": { icon: "backpack", tone: "peach" },
  "автомобиль": { icon: "car", tone: "sage" },
  "такси": { icon: "car", tone: "mint" },
  "питомцы": { icon: "paw-print", tone: "peach" },
  "образование": { icon: "graduation-cap", tone: "mint" },
  "дача и участок": { icon: "sprout", tone: "sage" },
  "ремонт и техника": { icon: "wrench", tone: "amber" },
  // Личное и досуг
  "кафе и доставка": { icon: "cup", tone: "peach" },
  "одежда и обувь": { icon: "shirt", tone: "lilac" },
  "красота и уход": { icon: "sparkles", tone: "coral" },
  "развлечения и хобби": { icon: "ticket", tone: "mint" },
  "подарки и праздники": { icon: "gift", tone: "amber" },
  "отпуск и поездки": { icon: "plane", tone: "lilac" },
  "спорт и абонементы": { icon: "dumbbell", tone: "mint" },
  "электроника и гаджеты": { icon: "smartphone", tone: "lilac" },
  "алкоголь и табак": { icon: "wine", tone: "coral" },
  // Прочее
  "прочее": { icon: "tag", tone: "neutral" },
  "помощь родным": { icon: "heart", tone: "coral" },
  "благотворительность": { icon: "heart", tone: "mint" },
  // Доходы
  "зарплата": { icon: "banknote", tone: "sage" },
  "премия и бонусы": { icon: "award", tone: "amber" },
  "подработка и самозанятость": { icon: "briefcase", tone: "lilac" },
  "пособия и выплаты": { icon: "landmark", tone: "mint" },
  "пенсия": { icon: "landmark", tone: "sage" },
  "кешбэк и проценты": { icon: "percent", tone: "peach" },
  "подарки и помощь": { icon: "gift", tone: "coral" },
  "прочие доходы": { icon: "tag", tone: "neutral" },
  "аренда": { icon: "house", tone: "peach" },
  "дивиденды и купоны": { icon: "trending-up", tone: "sage" },
  "продажа вещей": { icon: "tag", tone: "mint" },
  "возврат налога": { icon: "landmark", tone: "peach" },
  "алименты": { icon: "users", tone: "sage" },
  "стипендия": { icon: "graduation-cap", tone: "lilac" },
  "возврат долга": { icon: "arrow-down-left", tone: "mint" },
  "компенсации": { icon: "rotate-ccw", tone: "sage" },
  "выигрыш": { icon: "award", tone: "peach" },
} satisfies Record<string, CategoryVisual>));

/** Запасной вариант по группе: своя категория семьи опознаётся хотя бы группой. */
const BY_GROUP: ReadonlyMap<CategoryGroup, CategoryVisual> = new Map<CategoryGroup, CategoryVisual>([
  ["mandatory", { icon: "tag", tone: "sage" }],
  ["everyday", { icon: "tag", tone: "mint" }],
  ["personal", { icon: "tag", tone: "lilac" }],
  ["other", { icon: "tag", tone: "neutral" }],
  ["income", { icon: "tag", tone: "peach" }],
]);

const NEUTRAL: CategoryVisual = { icon: "tag", tone: "neutral" };

/**
 * Ключи тона, которые читаются из данных. Ключи прежние — G-003 пишет `"sage"` и `"mint"`; имена
 * макета `sand` и `rose` — это наши `amber` и `coral` (DESIGN §3).
 */
const TONE_KEYS: ReadonlyMap<string, CategoryTone> = new Map<string, CategoryTone>([
  ["mint", "mint"],
  ["lilac", "lilac"],
  ["peach", "peach"],
  ["amber", "amber"],
  ["sage", "sage"],
  ["coral", "coral"],
  ["neutral", "neutral"],
  ["sand", "amber"],
  ["rose", "coral"],
]);

/** Глифы спрайта по ключу: ключ из данных находит только то, что в спрайте действительно есть. */
const ICON_KEYS: ReadonlyMap<string, IconName> = new Map(ICON_NAMES.map((name) => [name, name]));

/** Тон по ключу из данных, или `null`: чужой и незнакомый ключ — не тон. */
export function toneOfKey(key: unknown): CategoryTone | null {
  return typeof key === "string" ? TONE_KEYS.get(key) ?? null : null;
}

/** Глиф по ключу из данных, или `null`. */
export function iconOfKey(key: unknown): IconName | null {
  return typeof key === "string" ? ICON_KEYS.get(key) ?? null : null;
}

/** Поле сущности, только если оно её собственное: унаследованное `toString` полем не бывает. */
function ownField(entity: object, field: "icon" | "color"): unknown {
  return Object.hasOwn(entity, field) ? (entity as Readonly<Record<string, unknown>>)[field] : undefined;
}

/**
 * Вид категории: выбранное семьёй — если эта сборка знает такой ключ, иначе — по имени, по группе
 * и, наконец, нейтральный. Пустой плитки не бывает, исключения — тоже.
 */
export function categoryVisual(category: CategoryLike): CategoryVisual {
  let derived: CategoryVisual = NEUTRAL;
  try {
    derived = BY_NAME.get(categoryNameKey(category.name)) ?? BY_GROUP.get(resolveCategoryGroup(category)) ?? NEUTRAL;
  } catch {
    // Имя или группа, которые домен не смог разобрать, — тоже не повод оставить плитку пустой.
    derived = NEUTRAL;
  }
  return {
    icon: iconOfKey(ownField(category, "icon")) ?? derived.icon,
    tone: toneOfKey(ownField(category, "color")) ?? derived.tone,
  };
}

/** То немногое от счёта, что нужно для его вида. */
export interface AccountLike {
  readonly type: AccountType;
  readonly currency: string;
  readonly icon?: DisplayKey;
  /** Ключ тона, выбранный семьёй (D-036): у счёта им окрашена подложка глифа на тёмной плитке. */
  readonly color?: DisplayKey;
}

/**
 * Тон счёта — только выбранный семьёй: без него плитка счёта тёмная целиком, как в §3, и тона по
 * имени у счёта нет — «Карта» и «Наличные» не категории. Неизвестный ключ — тоже без тона.
 */
export function accountTone(account: AccountLike): CategoryTone | null {
  return toneOfKey(ownField(account, "color"));
}

/** Глиф счёта по его виду: карта, наличные, копилка, резерв. Ключ семьи (D-036) — первым. */
const ACCOUNT_ICONS: ReadonlyMap<string, IconName> = new Map<string, IconName>([
  ["current", "credit-card"],
  ["cash", "banknote"],
  ["savings", "piggy-bank"],
  ["reserve", "shield"],
]);

export function accountIcon(account: AccountLike): IconName {
  return iconOfKey(ownField(account, "icon")) ?? ACCOUNT_ICONS.get(account.type) ?? "wallet";
}

/** Имена глифов, которые карта обещает интерфейсу. Спрайт обязан содержать каждое. */
export const CATEGORY_ICON_NAMES: readonly IconName[] = [
  ...new Set([
    ...[...BY_NAME.values()].map((visual) => visual.icon),
    ...[...BY_GROUP.values()].map((visual) => visual.icon),
    ...ACCOUNT_ICONS.values(),
  ]),
];

/** Сколько категорий названы поимённо — число для отчёта и для проверки полноты. */
export const NAMED_CATEGORY_COUNT = BY_NAME.size;
