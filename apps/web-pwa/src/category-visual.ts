import { categoryNameKey, resolveCategoryGroup, type CategoryGroup, type CategoryType, type StoredCategoryGroup } from "@family-budget/domain";
import type { IconName } from "./components/Icon";

/**
 * Иконка и тон категории (DESIGN §3 «Тона категорий», §6 «Плитка категории»).
 *
 * Карта живёт в слое представления и только в нём. У сущности `Category` нет полей иконки и
 * цвета и не будет: они превратили бы вид в данные — миграцию хранилища, новое поле в формате
 * резервной копии и запись в семейном журнале ради того, что рисуется на экране. Домен здесь
 * читается и не меняется: имя приводится к ключу через `categoryNameKey` (та же нормализация,
 * что у поиска дубликатов), группа — через `resolveCategoryGroup`.
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
}

const BY_NAME: Readonly<Record<string, CategoryVisual>> = {
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
};

/** Запасной вариант по группе: своя категория семьи опознаётся хотя бы группой. */
const BY_GROUP: Readonly<Record<CategoryGroup, CategoryVisual>> = {
  mandatory: { icon: "tag", tone: "sage" },
  everyday: { icon: "tag", tone: "mint" },
  personal: { icon: "tag", tone: "lilac" },
  other: { icon: "tag", tone: "neutral" },
  income: { icon: "tag", tone: "peach" },
};

export function categoryVisual(category: CategoryLike): CategoryVisual {
  return BY_NAME[categoryNameKey(category.name)] ?? BY_GROUP[resolveCategoryGroup(category)];
}

/** Имена глифов, которые карта обещает интерфейсу. Спрайт обязан содержать каждое. */
export const CATEGORY_ICON_NAMES: readonly IconName[] = [
  ...new Set([
    ...Object.values(BY_NAME).map((visual) => visual.icon),
    ...Object.values(BY_GROUP).map((visual) => visual.icon),
  ]),
];

/** Сколько категорий названы поимённо — число для отчёта и для проверки полноты. */
export const NAMED_CATEGORY_COUNT = Object.keys(BY_NAME).length;
