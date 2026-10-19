import { describe, expect, it } from "vitest";
import { DEFAULT_CATEGORIES } from "@family-budget/domain";
import { buildDemoBudgetState } from "./onboarding/demo";
import { breakPoints, LONGEST_UNBROKEN, PREFIXES, softHyphenate } from "./hyphenation";

const shown = (text: string) => softHyphenate(text).replace(/\u00ad/gu, "-");

/** Куски слова между местами переноса — то, что браузер не разорвёт, не нарушив правил. */
function pieces(word: string): readonly string[] {
  const letters = [...word];
  const edges = [0, ...breakPoints(word), letters.length];
  return edges.slice(1).map((end, index) => letters.slice(edges[index], end).join(""));
}

describe("мягкие переносы в именах плиток (ревью 2b, LOW-9)", () => {
  it("ставит перенос по школьным правилам: гласная в каждой части, две буквы с краю, согласная — со своей гласной", () => {
    expect(shown("Продукты")).toBe("Про-ду-к-ты");
    expect(shown("Транспорт")).toBe("Тра-н-с-порт");
    expect(shown("Здоровье")).toBe("Здо-ро-вье");
    expect(shown("Жильё")).toBe("Жи-льё");
  });

  it("«й», «ь», «ъ» остаются с буквой перед ними; слова без гласных, числа и знаки — как были", () => {
    for (const word of ["Подъезд", "Здоровье", "Майка", "Объявление"]) expect(shown(word), word).not.toMatch(/-[йьъ]/u);
    expect(shown("Майка")).toBe("Май-ка");
    expect(shown("ЖКХ")).toBe("ЖКХ");
    expect(shown("Кафе и доставка")).toBe("Ка-фе и до-с-та-в-ка");
    expect(shown("Онлайн-кино 2026")).toBe("Он-лайн-ки-но 2026");
  });

  it("убери мягкие переносы — и имя то же: в тексте ничего, кроме них, не меняется", () => {
    for (const template of DEFAULT_CATEGORIES) {
      expect(softHyphenate(template.name).replace(/\u00ad/gu, ""), template.name).toBe(template.name);
    }
  });
});

describe("приставка не делится (ревью 2b, раунд 3, NEW-5б)", () => {
  // Слева — как переносили раньше, справа — как теперь: внутри приставки места нет; от корня
  // после приставки на согласную его начальная согласная не отрывается («Разв-лечения»).
  const table: readonly (readonly [string, string, string])[] = [
    ["Подработка", "По-д-ра-бо-т-ка", "Под-ра-бо-т-ка"],
    ["Подписки", "По-д-пи-с-ки", "Под-пи-с-ки"],
    ["Развлечения", "Ра-з-в-ле-че-ния", "Раз-вле-че-ния"],
    ["Бездельник", "Бе-з-де-ль-ник", "Без-де-ль-ник"],
    ["Разыграть", "Ра-зы-г-рать", "Разы-г-рать"],
    ["Предыстория", "Пре-ды-с-то-рия", "Преды-с-то-рия"],
    // Цена правил по буквам: «По-дар-ки» верно, но «под» в начале слова — приставка для них.
    ["Подарки", "По-да-р-ки", "Пода-р-ки"],
    ["Подъезд", "По-дъ-езд", "Подъ-езд"],
    ["Объявление", "Объ-я-в-ле-ние", "Объ-я-в-ле-ние"],
    ["Расходы", "Ра-с-хо-ды", "Рас-хо-ды"],
    ["Рассрочка", "Ра-с-с-ро-ч-ка", "Рас-сро-ч-ка"],
    ["Возврат", "Во-з-в-рат", "Воз-врат"],
    ["Бесплатно", "Бе-с-п-ла-т-но", "Бес-пла-т-но"],
    ["Распродажа", "Ра-с-п-ро-да-жа", "Рас-про-да-жа"],
    ["Пересадка", "Пе-ре-са-д-ка", "Пере-са-д-ка"],
    ["Обезболивающее", "Обе-з-бо-ли-ва-ю-щее", "Обез-бо-ли-ва-ю-щее"],
    ["Наибольший", "На-и-бо-ль-ший", "Наи-бо-ль-ший"],
    ["Отпуск", "От-пуск", "От-пуск"],
  ];

  it.each(table)("%s: было «%s», стало «%s»", (word, _before, after) => {
    expect(shown(word)).toBe(after);
  });

  it("ни в одном слове перенос не падает внутрь приставки, с которой оно начинается", () => {
    for (const [word] of table) {
      const prefix = PREFIXES.find((candidate) => word.toLowerCase().startsWith(candidate))!;
      expect(prefix, word).toBeDefined();
      expect(breakPoints(word).filter((at) => at < prefix.length), word).toEqual([]);
    }
  });

  it("двойная согласная делится пополам: «Кас-са», «хоб-би», а не «Ка-сса»", () => {
    expect(shown("Касса")).toBe("Кас-са");
    expect(shown("Развлечения и хобби")).toBe("Раз-вле-че-ния и хоб-би");
    expect(shown("Классный")).toBe("Клас-с-ный");
  });
});

describe("слово, которому правила не дали мест, всё равно переносится с дефисом (ревью 2b, раунд 3, NEW-5а)", () => {
  it("«Strengths», «Всплеск», «Взгляд», «Монстр» получают запасные места, и ни один кусок не длиннее LONGEST_UNBROKEN", () => {
    expect(shown("Strengths")).toBe("St-re-n-g-t-hs");
    expect(shown("Всплеск")).toBe("Вс-пле-ск");
    expect(shown("Взгляд")).toBe("Вз-гляд");
    expect(shown("Монстр")).toBe("Мо-н-с-тр");
    // Пять букв — помещаются в самую узкую плитку; запасных мест там нет.
    expect(shown("Связь")).toBe("Связь");
    expect(shown("Обувь")).toBe("Обувь");
  });

  it("в любом слове из букв ни один кусок между местами переноса не длиннее LONGEST_UNBROKEN", () => {
    // Псевдослучайные слова из кириллицы и латиницы, с гласными и без, с приставками и «й/ь/ъ»:
    // какой бы ни была плитка, слово найдёт, где перенестись с дефисом.
    const alphabet = [..."бвгджзклмнпрстфхцчшщаеёиоуыэюяйьъbcdfghklmnpqrstvwxzaeiouy"];
    let seed = 20_261_019;
    const random = () => { seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648; return seed / 2_147_483_648; };
    for (let round = 0; round < 3_000; round += 1) {
      const length = 2 + Math.floor(random() * 22);
      const start = random() < 0.3 ? PREFIXES[Math.floor(random() * PREFIXES.length)]! : "";
      let word = start;
      while (word.length < length) word += alphabet[Math.floor(random() * alphabet.length)]!;
      // «й/ь/ъ» строку не начинают и потому липнут к куску перед ними — их в счёт не берём.
      const longest = Math.max(...pieces(word).map((piece) => piece.replace(/[йьъ]/gu, "").length));
      expect(longest, `${word}: ${pieces(word).join("-")}`).toBeLessThanOrEqual(LONGEST_UNBROKEN);
      for (const at of breakPoints(word)) {
        expect(at, word).toBeGreaterThanOrEqual(2);
        expect(word.length - at, word).toBeGreaterThanOrEqual(2);
        expect(word[at], word).not.toMatch(/[йьъ]/u);
      }
    }
  });
});

describe("все имена демо и шаблонов — точно те места, что разрешены (ревью 2b, раунд 3, NEW-5)", () => {
  // Таблица — ровно то, что увидит глаз, если перенос понадобится в каждом месте сразу. Ни одного
  // запасного места: в этих именах нет куска длиннее пяти букв без места по правилам.
  const expected: Readonly<Record<string, string>> = {
    "Жильё": "Жи-льё",
    "ЖКХ": "ЖКХ",
    "Связь и подписки": "Связь и под-пи-с-ки",
    "Кредиты и рассрочки": "Кре-ди-ты и рас-сро-ч-ки",
    "Продукты": "Про-ду-к-ты",
    "Транспорт": "Тра-н-с-порт",
    "Дом и хозяйство": "Дом и хо-зяй-с-т-во",
    "Здоровье и аптека": "Здо-ро-вье и ап-те-ка",
    "Дети": "Де-ти",
    "Кафе и доставка": "Ка-фе и до-с-та-в-ка",
    "Одежда и обувь": "Оде-ж-да и обувь",
    "Красота и уход": "Кра-со-та и уход",
    "Развлечения и хобби": "Раз-вле-че-ния и хоб-би",
    "Подарки и праздники": "Пода-р-ки и пра-з-д-ни-ки",
    "Прочее": "Про-чее",
    "Зарплата": "За-р-п-ла-та",
    "Премия и бонусы": "Пре-мия и бо-ну-сы",
    "Подработка и самозанятость": "Под-ра-бо-т-ка и са-мо-за-ня-тость",
    "Пособия и выплаты": "По-со-бия и вы-п-ла-ты",
    "Пенсия": "Пе-н-сия",
    "Кешбэк и проценты": "Ке-ш-бэк и про-це-н-ты",
    "Подарки и помощь": "Пода-р-ки и по-мощь",
    "Прочие доходы": "Про-чие до-хо-ды",
    "Основной": "Ос-но-в-ной",
    "Резерв платежей": "Ре-зерв пла-те-жей",
  };

  it("каждое имя категории, источника дохода и счёта демо и шаблонов", () => {
    const demo = buildDemoBudgetState();
    const names = new Set([...DEFAULT_CATEGORIES.map((item) => item.name), ...demo.categories.map((item) => item.name), ...demo.accounts.map((item) => item.name)]);
    expect([...names].sort()).toEqual(Object.keys(expected).sort());
    for (const name of names) expect(shown(name), name).toBe(expected[name]);
  });
});
