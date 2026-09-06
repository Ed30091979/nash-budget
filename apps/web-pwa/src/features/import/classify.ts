import { categoryNameKey, type BudgetState, type Category, type CategoryType } from "@family-budget/domain";
import type { StatementDirection, StatementOperation } from "./statement";

/**
 * Три ступени классификации, в этом порядке: собственная категория банка, словарь продавцов,
 * список на подтверждение. Перед ними — то, что человек уже назначал сам: его слово старше
 * слова банка. Ещё раньше — перевод между своими счетами: это не трата и не доход, и в
 * категории ему нечего делать.
 *
 * Словарь живёт в слое представления, как иконки и тона категорий (решение 45): соответствие
 * выводится из названия и не требует ни поля в сущности, ни миграции. Сопоставление идёт с
 * **названиями** категорий семьи, а не с идентификаторами: у каждой семьи свои идентификаторы,
 * а «Продукты» — одни на всех. Названия, которых у семьи нет, не создаются молча: строка идёт в
 * список на подтверждение.
 *
 * В «Прочее» без спроса не попадает ничего: молчаливая свалка показала бы человеку неверную
 * картину его же трат.
 */
export type ClassificationTier = "memory" | "bank" | "merchant";

export type Placement =
  | { readonly kind: "expense"; readonly categoryId: string; readonly via: ClassificationTier }
  | { readonly kind: "income"; readonly categoryId: string | null; readonly via: ClassificationTier }
  | { readonly kind: "self-transfer" }
  | { readonly kind: "unknown" };

export interface ClassifiedOperation {
  readonly operation: StatementOperation;
  /** Ключ продавца: по нему назначение запоминается и применяется ко всем строкам того же продавца. */
  readonly merchantKey: string;
  readonly placement: Placement;
}

export interface ClassificationSummary {
  readonly total: number;
  readonly selfTransfer: number;
  readonly memory: number;
  readonly bank: number;
  readonly merchant: number;
  readonly unknown: number;
}

export interface MerchantMemoryEntry {
  readonly key: string;
  /** `null` — доход без категории: тоже решение человека, и его тоже помнят. */
  readonly categoryName: string | null;
  readonly type: CategoryType;
  readonly updatedAt: string;
}

/**
 * Ключ продавца: регистр, «ё», цифры и знаки препинания не в счёт. Цифры убраны нарочно — номер
 * заказа, чека или карты в описании делает каждую покупку в одном и том же магазине уникальной.
 */
export function merchantKey(description: string): string {
  return description
    // «№» раньше NFKC: нормализация превращает его в латинское «No», и оно осталось бы словом.
    .replace(/№/gu, " ")
    .normalize("NFKC")
    .toLocaleLowerCase("ru-RU")
    .replace(/ё/gu, "е")
    .replace(/[^\p{L}\s]/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
}

const SELF_TRANSFER_MARKS: readonly string[] = [
  "между своими счетами",
  "между счетами",
  "между своими",
  "внутренний перевод",
  "перевод на договор",
  "перевод с договора",
  "на накопительный",
  "с накопительного",
  "на вклад",
  "с вклада",
  "закрытие вклада",
  "пополнение вклада",
  "инвесткопилк",
  "копилк",
  "на брокерский",
  "с брокерского",
  "инвестиции",
  "округление",
  "перевод на карту другого банка",
  "перевод на свою карту",
  "со своей карты",
].map(merchantKey);

const TRANSFER_BANK_CATEGORIES = new Set(["переводы", "пополнения", "перевод", "пополнение", "другое"].map(merchantKey));

/**
 * Перевод между своими счетами — по описанию, а не по категории банка: «Переводы» у банка
 * включают и перевод другому человеку, а он может быть чем угодно, от аренды до подарка.
 */
export function isSelfTransfer(operation: StatementOperation): boolean {
  const key = merchantKey(operation.description);
  const bank = merchantKey(operation.bankCategory);
  if (bank !== "" && !TRANSFER_BANK_CATEGORIES.has(bank)) return false;
  return SELF_TRANSFER_MARKS.some((mark) => key.includes(mark));
}

type Candidates = readonly string[];

/**
 * Категории Т-Банка → названия категорий семьи, первое существующее побеждает. Список в
 * порядке предпочтения: «Авиабилеты» лучше положить в «Отпуск и поездки», если семья её завела,
 * и лишь потом — в «Транспорт». Список пуст не бывает: чего нет у семьи — уходит на вторую
 * ступень, а с неё — в список на подтверждение.
 */
const BANK_EXPENSE_CATEGORIES: Readonly<Record<string, Candidates>> = Object.fromEntries((
  [
    ["Супермаркеты", ["Продукты"]],
    ["Продукты", ["Продукты"]],
    ["Фастфуд", ["Кафе и доставка"]],
    ["Рестораны", ["Кафе и доставка"]],
    ["Кафе", ["Кафе и доставка"]],
    ["Кафе и рестораны", ["Кафе и доставка"]],
    ["Бары", ["Кафе и доставка"]],
    ["Доставка еды", ["Кафе и доставка"]],
    ["Транспорт", ["Транспорт"]],
    ["Такси", ["Такси", "Транспорт"]],
    ["Каршеринг", ["Такси", "Транспорт"]],
    ["Топливо", ["Автомобиль", "Транспорт"]],
    ["Автозаправки", ["Автомобиль", "Транспорт"]],
    ["Автоуслуги", ["Автомобиль", "Транспорт"]],
    ["Парковки", ["Автомобиль", "Транспорт"]],
    ["Ж/д билеты", ["Отпуск и поездки", "Транспорт"]],
    ["Авиабилеты", ["Отпуск и поездки", "Транспорт"]],
    ["Отели", ["Отпуск и поездки"]],
    ["Турагентства", ["Отпуск и поездки"]],
    ["Путешествия", ["Отпуск и поездки"]],
    ["Аптеки", ["Здоровье и аптека"]],
    ["Медицина", ["Здоровье и аптека"]],
    ["Медицинские услуги", ["Здоровье и аптека"]],
    ["Оптика", ["Здоровье и аптека"]],
    ["Связь", ["Связь и подписки"]],
    ["Связь и телеком", ["Связь и подписки"]],
    ["Мобильная связь", ["Связь и подписки"]],
    ["Интернет", ["Связь и подписки"]],
    ["Цифровые товары", ["Связь и подписки"]],
    ["Подписки", ["Связь и подписки"]],
    ["ЖКХ", ["ЖКХ"]],
    ["Коммунальные услуги", ["ЖКХ"]],
    ["Коммунальные платежи", ["ЖКХ"]],
    ["Одежда и обувь", ["Одежда и обувь"]],
    ["Одежда", ["Одежда и обувь"]],
    ["Обувь", ["Одежда и обувь"]],
    ["Красота", ["Красота и уход"]],
    ["Салоны красоты", ["Красота и уход"]],
    ["Косметика", ["Красота и уход"]],
    ["Парфюмерия", ["Красота и уход"]],
    ["Развлечения", ["Развлечения и хобби"]],
    ["Кино", ["Развлечения и хобби"]],
    ["Театр", ["Развлечения и хобби"]],
    ["Музыка", ["Развлечения и хобби"]],
    ["Книги", ["Развлечения и хобби"]],
    ["Хобби", ["Развлечения и хобби"]],
    ["Игры", ["Развлечения и хобби"]],
    ["Искусство", ["Развлечения и хобби"]],
    ["Фото и видео", ["Развлечения и хобби"]],
    ["Спорттовары", ["Спорт и абонементы", "Развлечения и хобби"]],
    ["Спорт", ["Спорт и абонементы", "Развлечения и хобби"]],
    ["Фитнес", ["Спорт и абонементы", "Развлечения и хобби"]],
    ["Дом и ремонт", ["Дом и хозяйство"]],
    ["Дом, ремонт", ["Дом и хозяйство"]],
    ["Мебель", ["Дом и хозяйство"]],
    ["Товары для дома", ["Дом и хозяйство"]],
    ["Хозтовары", ["Дом и хозяйство"]],
    ["Электроника", ["Электроника и гаджеты", "Дом и хозяйство"]],
    ["Техника", ["Электроника и гаджеты", "Дом и хозяйство"]],
    ["Животные", ["Питомцы", "Дом и хозяйство"]],
    ["Зоотовары", ["Питомцы", "Дом и хозяйство"]],
    ["Детские товары", ["Дети"]],
    ["Детские товары и игрушки", ["Дети"]],
    ["Образование", ["Образование", "Дети"]],
    ["Сувениры", ["Подарки и праздники"]],
    ["Подарки", ["Подарки и праздники"]],
    ["Цветы", ["Подарки и праздники"]],
    ["Кредиты", ["Кредиты и рассрочки"]],
    ["Погашение кредита", ["Кредиты и рассрочки"]],
    ["Рассрочка", ["Кредиты и рассрочки"]],
    ["Страхование", ["Страхование"]],
    ["Госуслуги", ["Налоги и госпошлины"]],
    ["Налоги", ["Налоги и госпошлины"]],
    ["Штрафы", ["Налоги и госпошлины"]],
    ["Благотворительность", ["Благотворительность"]],
    ["Табак", ["Алкоголь и табак"]],
    ["Алкоголь", ["Алкоголь и табак"]],
    ["Аренда", ["Жильё"]],
    ["Недвижимость", ["Жильё"]],
  ] as const
).map(([bank, candidates]) => [merchantKey(bank), candidates]));

const BANK_INCOME_CATEGORIES: Readonly<Record<string, Candidates>> = Object.fromEntries((
  [
    ["Зарплата", ["Зарплата"]],
    ["Кэшбэк", ["Кешбэк и проценты"]],
    ["Кешбэк", ["Кешбэк и проценты"]],
    ["Бонусы", ["Кешбэк и проценты"]],
    ["Проценты", ["Кешбэк и проценты"]],
    ["Проценты по вкладу", ["Кешбэк и проценты"]],
    ["Пенсия", ["Пенсия"]],
    ["Пособия", ["Пособия и выплаты"]],
    ["Социальные выплаты", ["Пособия и выплаты"]],
    ["Стипендия", ["Стипендия", "Пособия и выплаты"]],
    ["Дивиденды", ["Дивиденды и купоны", "Кешбэк и проценты"]],
    ["Купоны", ["Дивиденды и купоны", "Кешбэк и проценты"]],
  ] as const
).map(([bank, candidates]) => [merchantKey(bank), candidates]));

interface MerchantRule {
  readonly token: string;
  readonly direction: StatementDirection;
  readonly candidates: Candidates;
}

/**
 * Словарь продавцов: подстрока ключа продавца → названия категорий семьи. Длинные ключи
 * проверяются раньше коротких, поэтому «магнит косметик» уходит в «Красоту» прежде, чем «магнит»
 * успеет отправить его в «Продукты».
 */
const MERCHANT_RULES: readonly MerchantRule[] = (
  [
    // Продукты
    ...["пятерочка", "пятёрочка", "магнит", "лента", "перекресток", "дикси", "ашан", "auchan", "вкусвилл", "vkusvill", "азбука вкуса", "spar", "окей", "metro", "самокат", "яндекс лавка", "купер", "сбермаркет", "верный", "монетка", "мария ра", "красное белое", "бристоль", "глобус", "billa", "чижик", "да ", "fix price", "фикс прайс"]
      .map((token) => ({ token, direction: "out" as const, candidates: ["Продукты"] })),
    // Кафе и доставка
    ...["яндекс еда", "delivery", "деливери", "kfc", "вкусно и точка", "бургер кинг", "burger king", "додо", "dodo", "шоколадница", "кофемания", "теремок", "starbucks", "cofix", "surf coffee", "one price coffee", "макдоналдс", "subway", "тануки", "якитория", "папа джонс", "domino", "ростикс", "rostics", "coffee", "кофе", "кафе", "ресторан", "пиццерия", "суши"]
      .map((token) => ({ token, direction: "out" as const, candidates: ["Кафе и доставка"] })),
    // Транспорт
    ...["яндекс такси", "yandex go", "yandex taxi", "uber", "ситимобил", "максим", "ситидрайв", "делимобил", "belkacar", "каршеринг"]
      .map((token) => ({ token, direction: "out" as const, candidates: ["Такси", "Транспорт"] })),
    ...["метрополитен", "тройка", "мосгортранс", "подорожник", "автобус", "троллейбус", "трамвай", "электричка", "цппк", "аэроэкспресс", "маршрутка"]
      .map((token) => ({ token, direction: "out" as const, candidates: ["Транспорт"] })),
    ...["ржд", "rzd", "аэрофлот", "aeroflot", "s7", "победа", "pobeda", "utair", "ural airlines", "уральские авиалинии"]
      .map((token) => ({ token, direction: "out" as const, candidates: ["Отпуск и поездки", "Транспорт"] })),
    ...["лукойл", "lukoil", "роснефть", "rosneft", "газпромнефть", "gazprom", "татнефть", "shell", "азс", "автомойка", "шиномонтаж", "автосервис", "парковка", "паркинг"]
      .map((token) => ({ token, direction: "out" as const, candidates: ["Автомобиль", "Транспорт"] })),
    // Здоровье
    ...["аптека", "apteka", "ригла", "апрель", "горздрав", "столички", "неофарм", "36 6", "здравсити", "еаптека", "озон аптека", "инвитро", "invitro", "гемотест", "kdl", "клиника", "стоматолог", "поликлиника", "медси", "helix"]
      .map((token) => ({ token, direction: "out" as const, candidates: ["Здоровье и аптека"] })),
    // Связь и подписки
    ...["мтс", "mts", "билайн", "beeline", "мегафон", "megafon", "теле2", "tele2", "t2 ", "ростелеком", "rostelecom", "yota", "йота", "дом ru", "домру", "яндекс плюс", "yandex plus", "кинопоиск", "kinopoisk", "иви", "ivi", "okko", "окко", "wink", "start ru", "premier", "apple com bill", "google play", "google one", "icloud", "spotify", "vk музыка", "звук", "netflix", "youtube", "литрес", "букмейт", "storytel"]
      .map((token) => ({ token, direction: "out" as const, candidates: ["Связь и подписки"] })),
    // ЖКХ
    ...["жкх", "мосэнергосбыт", "мособлеирц", "еирц", "квартплата", "капремонт", "водоканал", "теплосеть", "газпром межрегионгаз", "энергосбыт", "тсж", "ук ", "управляющая компания", "домофон", "жилищник"]
      .map((token) => ({ token, direction: "out" as const, candidates: ["ЖКХ"] })),
    // Дом и хозяйство
    ...["леруа", "leroy", "икеа", "ikea", "hoff", "хофф", "оби", "obi", "петрович", "максидом", "castorama", "ozon", "озон", "wildberries", "вайлдберриз", "aliexpress", "алиэкспресс", "яндекс маркет", "мегамаркет", "улыбка радуги", "магнит косметик", "хозтовары"]
      .map((token) => ({ token, direction: "out" as const, candidates: ["Дом и хозяйство"] })),
    ...["мвидео", "м видео", "mvideo", "эльдорадо", "eldorado", "dns", "днс", "ситилинк", "citilink", "re store", "самсунг", "samsung"]
      .map((token) => ({ token, direction: "out" as const, candidates: ["Электроника и гаджеты", "Дом и хозяйство"] })),
    ...["зоомагазин", "четыре лапы", "бетховен", "petshop", "зоозавр", "ветклиника", "ветеринар"]
      .map((token) => ({ token, direction: "out" as const, candidates: ["Питомцы", "Дом и хозяйство"] })),
    // Дети
    ...["детский мир", "detmir", "детский сад", "школа", "лицей", "гимназия", "кружок", "секция", "репетитор", "учи ру", "skysmart", "фоксфорд", "акварель", "кораблик"]
      .map((token) => ({ token, direction: "out" as const, candidates: ["Дети"] })),
    // Одежда и обувь
    ...["lamoda", "ламода", "zara", "h m", "uniqlo", "юникло", "gloria jeans", "глория джинс", "befree", "zolla", "o stin", "остин", "sela", "lime", "kari", "кари", "спортмастер", "sportmaster", "rendez vous", "экко", "ecco", "adidas", "nike", "reebok", "puma", "снежная королева", "familia", "фамилия"]
      .map((token) => ({ token, direction: "out" as const, candidates: ["Одежда и обувь"] })),
    // Красота и уход
    ...["летуаль", "l etoile", "золотое яблоко", "рив гош", "rive gauche", "парикмахер", "барбершоп", "салон красоты", "маникюр", "ногт", "косметолог", "спа "]
      .map((token) => ({ token, direction: "out" as const, candidates: ["Красота и уход"] })),
    // Развлечения и хобби
    ...["кинотеатр", "синема", "cinema", "каро", "театр", "музей", "концерт", "кассир ру", "яндекс афиша", "ticketland", "steam", "playstation", "xbox", "nintendo", "библиотека", "читай город", "буквоед", "леонардо", "боулинг", "квест"]
      .map((token) => ({ token, direction: "out" as const, candidates: ["Развлечения и хобби"] })),
    ...["world class", "фитнес", "fitness", "бассейн", "спортзал", "йога", "ddx", "spirit"]
      .map((token) => ({ token, direction: "out" as const, candidates: ["Спорт и абонементы", "Развлечения и хобби"] })),
    // Подарки и праздники
    ...["цветы", "flowers", "букет", "подарки", "подарок"]
      .map((token) => ({ token, direction: "out" as const, candidates: ["Подарки и праздники"] })),
    // Обязательные платежи
    ...["ипотека", "кредит", "рассрочка", "сбер кредит", "займ", "микрозайм"]
      .map((token) => ({ token, direction: "out" as const, candidates: ["Кредиты и рассрочки"] })),
    ...["страхов", "осаго", "каско", "ингосстрах", "ресо", "согаз", "альфастрахование", "росгосстрах"]
      .map((token) => ({ token, direction: "out" as const, candidates: ["Страхование"] })),
    ...["госуслуги", "налог", "фнс", "штраф", "гибдд", "госпошлина"]
      .map((token) => ({ token, direction: "out" as const, candidates: ["Налоги и госпошлины"] })),
    ...["аренда квартиры", "за квартиру", "аренда жилья", "найм жилья"]
      .map((token) => ({ token, direction: "out" as const, candidates: ["Жильё"] })),
    // Доходы
    ...["зарплат", "заработная плата", "аванс", "оплата труда", "расчет при увольнении", "отпускные", "больничн"]
      .map((token) => ({ token, direction: "in" as const, candidates: ["Зарплата"] })),
    ...["премия", "бонус за", "квартальная премия"]
      .map((token) => ({ token, direction: "in" as const, candidates: ["Премия и бонусы", "Зарплата"] })),
    ...["кэшбэк", "кешбэк", "cashback", "проценты по остатку", "проценты на остаток", "выплата процентов", "процент по вкладу", "проценты по вкладу", "бонусы"]
      .map((token) => ({ token, direction: "in" as const, candidates: ["Кешбэк и проценты"] })),
    ...["пенсия", "пенсионный фонд", "сфр", "пфр"]
      .map((token) => ({ token, direction: "in" as const, candidates: ["Пенсия"] })),
    ...["пособие", "социальная выплата", "соцзащит", "единое пособие", "материнский"]
      .map((token) => ({ token, direction: "in" as const, candidates: ["Пособия и выплаты"] })),
    ...["стипенди"]
      .map((token) => ({ token, direction: "in" as const, candidates: ["Стипендия", "Пособия и выплаты"] })),
    ...["возврат налога", "налоговый вычет"]
      .map((token) => ({ token, direction: "in" as const, candidates: ["Возврат налога", "Прочие доходы"] })),
    ...["дивиденд", "купон"]
      .map((token) => ({ token, direction: "in" as const, candidates: ["Дивиденды и купоны", "Кешбэк и проценты"] })),
    ...["самозанят", "подработк", "гонорар", "фриланс", "по договору гпх"]
      .map((token) => ({ token, direction: "in" as const, candidates: ["Подработка и самозанятость"] })),
  ] as const
)
  .map((rule) => ({ ...rule, token: merchantKey(rule.token) }))
  .filter((rule) => rule.token.length >= 2)
  .sort((left, right) => right.token.length - left.token.length);

/** Сколько правил знает словарь — число для отчёта и для проверки, что он не опустел. */
export const MERCHANT_RULE_COUNT = MERCHANT_RULES.length;
export const BANK_CATEGORY_COUNT = Object.keys(BANK_EXPENSE_CATEGORIES).length + Object.keys(BANK_INCOME_CATEGORIES).length;

function activeCategoriesByName(state: Pick<BudgetState, "categories">): Map<string, Category> {
  const byName = new Map<string, Category>();
  for (const category of state.categories) {
    if (!category.active) continue;
    byName.set(`${category.type} ${categoryNameKey(category.name)}`, category);
  }
  return byName;
}

function resolveCandidates(byName: ReadonlyMap<string, Category>, type: CategoryType, candidates: Candidates): Category | null {
  for (const candidate of candidates) {
    const found = byName.get(`${type} ${categoryNameKey(candidate)}`);
    if (found) return found;
  }
  return null;
}

/**
 * Короткий ключ совпадает только целым словом: «теле» (Теле2 без цифр) не должно ловить
 * «телефона», «да» — «ладу», «ук» — «укол». Длинному однословному ключу разрешена подстрока:
 * «пятерочка» обязана найтись и в «пятерочкамосква», как её иногда пишет эквайринг.
 */
function keyHas(key: string, token: string): boolean {
  if (` ${key} `.includes(` ${token} `)) return true;
  return !token.includes(" ") && token.length >= 5 && key.includes(token);
}

function byBankCategory(operation: StatementOperation, byName: ReadonlyMap<string, Category>): Category | null {
  const bank = merchantKey(operation.bankCategory);
  if (bank === "") return null;
  const table = operation.direction === "out" ? BANK_EXPENSE_CATEGORIES : BANK_INCOME_CATEGORIES;
  const candidates = table[bank];
  return candidates === undefined ? null : resolveCandidates(byName, operation.direction === "out" ? "expense" : "income", candidates);
}

function byMerchant(key: string, direction: StatementDirection, byName: ReadonlyMap<string, Category>): Category | null {
  if (key === "") return null;
  for (const rule of MERCHANT_RULES) {
    if (rule.direction !== direction || !keyHas(key, rule.token)) continue;
    const found = resolveCandidates(byName, direction === "out" ? "expense" : "income", rule.candidates);
    if (found) return found;
  }
  return null;
}

function byMemory(
  key: string,
  direction: StatementDirection,
  memory: ReadonlyMap<string, MerchantMemoryEntry>,
  byName: ReadonlyMap<string, Category>,
): Placement | null {
  const entry = memory.get(key);
  if (entry === undefined) return null;
  const type: CategoryType = direction === "out" ? "expense" : "income";
  if (entry.type !== type) return null;
  if (entry.categoryName === null) return type === "income" ? { kind: "income", categoryId: null, via: "memory" } : null;
  const found = byName.get(`${type} ${categoryNameKey(entry.categoryName)}`);
  if (!found) return null;
  return type === "expense"
    ? { kind: "expense", categoryId: found.id, via: "memory" }
    : { kind: "income", categoryId: found.id, via: "memory" };
}

function placed(category: Category, direction: StatementDirection, via: ClassificationTier): Placement {
  return direction === "out"
    ? { kind: "expense", categoryId: category.id, via }
    : { kind: "income", categoryId: category.id, via };
}

export interface ClassifiedStatement {
  readonly rows: readonly ClassifiedOperation[];
  readonly summary: ClassificationSummary;
}

/**
 * Раскладывает операции выписки по категориям семьи. Порядок ступеней — часть контракта:
 * перевод себе → память назначений → категория банка → словарь продавцов → на подтверждение.
 */
export function classifyStatement(
  operations: readonly StatementOperation[],
  state: Pick<BudgetState, "categories">,
  memoryEntries: readonly MerchantMemoryEntry[] = [],
): ClassifiedStatement {
  const byName = activeCategoriesByName(state);
  const memory = new Map(memoryEntries.map((entry) => [entry.key, entry]));
  const counts = { total: operations.length, selfTransfer: 0, memory: 0, bank: 0, merchant: 0, unknown: 0 };
  const rows = operations.map((operation): ClassifiedOperation => {
    const key = merchantKey(operation.description);
    if (isSelfTransfer(operation)) {
      counts.selfTransfer += 1;
      return { operation, merchantKey: key, placement: { kind: "self-transfer" } };
    }
    const remembered = byMemory(key, operation.direction, memory, byName);
    if (remembered !== null) {
      counts.memory += 1;
      return { operation, merchantKey: key, placement: remembered };
    }
    const bank = byBankCategory(operation, byName);
    if (bank !== null) {
      counts.bank += 1;
      return { operation, merchantKey: key, placement: placed(bank, operation.direction, "bank") };
    }
    const merchant = byMerchant(key, operation.direction, byName);
    if (merchant !== null) {
      counts.merchant += 1;
      return { operation, merchantKey: key, placement: placed(merchant, operation.direction, "merchant") };
    }
    counts.unknown += 1;
    return { operation, merchantKey: key, placement: { kind: "unknown" } };
  });
  return { rows, summary: counts };
}
