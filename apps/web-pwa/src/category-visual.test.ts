/// <reference types="node" />
import { readFileSync } from "node:fs";
import {
  CATEGORY_SUGGESTIONS,
  DEFAULT_CATEGORIES,
  type CategoryTemplate,
} from "@family-budget/domain";
import { describe, expect, it } from "vitest";

import { ICON_NAMES } from "./components/Icon";
import {
  accountIcon,
  CATEGORY_ICON_NAMES,
  categoryVisual,
  iconOfKey,
  NAMED_CATEGORY_COUNT,
  toneOfKey,
  type CategoryTone,
} from "./category-visual";

const TONES: readonly CategoryTone[] = ["mint", "lilac", "peach", "amber", "sage", "coral", "neutral"];

describe("иконка и тон категории", () => {
  it("даёт каждой готовой категории собственный глиф, а не один общий на все расходы", () => {
    const expenses = DEFAULT_CATEGORIES.filter((item) => item.type === "expense");
    const icons = expenses.map((item) => categoryVisual(item).icon);

    expect(expenses).toHaveLength(15);
    // Смысл жалобы на дизайн: «Продукты», «Транспорт» и «Жильё» неразличимы при пролистывании.
    expect(new Set(icons).size).toBe(expenses.length);
    expect(categoryVisual({ name: "Продукты", type: "expense", group: "everyday" }).icon)
      .not.toBe(categoryVisual({ name: "Транспорт", type: "expense", group: "everyday" }).icon);
  });

  it("называет поимённо весь стартовый набор и весь каталог подсказок", () => {
    const known: readonly CategoryTemplate[] = [...DEFAULT_CATEGORIES, ...CATEGORY_SUGGESTIONS];
    const unnamed = known.filter((item) => categoryVisual(item).icon === "tag" && item.name !== "Прочее" && item.name !== "Прочие доходы" && item.name !== "Продажа вещей");

    expect(unnamed).toEqual([]);
    expect(NAMED_CATEGORY_COUNT).toBeGreaterThanOrEqual(known.length - 2);
  });

  it("держит каждый тон в объявленном наборе и красит категорию, а не её величину", () => {
    for (const template of [...DEFAULT_CATEGORIES, ...CATEGORY_SUGGESTIONS]) {
      expect(TONES).toContain(categoryVisual(template).tone);
    }
    // Один и тот же тон при любой сумме и любом состоянии лимита: тон — метка, не шкала.
    expect(categoryVisual({ name: "Продукты", type: "expense", group: "everyday" }))
      .toEqual(categoryVisual({ name: "продукты ", type: "expense", group: "everyday" }));
  });

  it("выдаёт своей категории запасной вариант по группе, а не пустую плитку", () => {
    const own = categoryVisual({ name: "Батут и качели", type: "expense", group: "personal" });
    expect(own).toEqual({ icon: "tag", tone: "lilac" });
    expect(categoryVisual({ name: "Батут и качели", type: "expense", group: "everyday" }).tone).toBe("mint");
    // Группа, которой в закрытом наборе нет, разрешается доменом в «Прочее» — плитка остаётся.
    const legacy = categoryVisual({ name: "Батут и качели", type: "expense", group: "выдуманная группа" });
    expect(legacy).toEqual({ icon: "tag", tone: "neutral" });
    // Доход всегда опознаётся как доход, что бы ни было записано в его группе.
    expect(categoryVisual({ name: "Гонорар", type: "income", group: "выдуманная группа" }).tone).toBe("peach");
  });

  it("держит каждый тон объявленным в стилях и в документе дизайна", () => {
    const styles = readFileSync(new URL("./styles.css", import.meta.url), "utf8");
    const design = readFileSync(new URL("../../../DESIGN.md", import.meta.url), "utf8");
    const used = new Set([...DEFAULT_CATEGORIES, ...CATEGORY_SUGGESTIONS].map((item) => categoryVisual(item).tone));

    for (const tone of TONES) {
      if (tone === "neutral") {
        // 5.0: у нейтрального тона свой токен — «Прочее» отличается от утопленных плашек; глиф — чернила.
        expect(styles).toMatch(/--tone-neutral: #[0-9a-f]{6};/u);
        expect(styles).toContain(".tone-neutral { color: var(--ink); background: var(--tone-neutral); }");
        expect(design).toContain("`--tone-neutral`");
        continue;
      }
      expect(styles).toMatch(new RegExp(`--tone-${tone}: #[0-9a-f]{6};`, "u"));
      expect(styles).toContain(`.tone-${tone} { background: var(--tone-${tone}); }`);
      // §3 документа дизайна: тон существует, только если он там записан вместе с контрастом.
      expect(design).toContain(`\`--tone-${tone}\``);
    }
    expect(used.size).toBeGreaterThanOrEqual(6);
  });

  it("обещает интерфейсу только те глифы, которые есть в спрайте", () => {
    for (const name of CATEGORY_ICON_NAMES) {
      expect(ICON_NAMES).toContain(name);
    }
  });

  it("читает выбор семьи — `icon` и `color` категории (D-036) — раньше вида по имени", () => {
    expect(categoryVisual({ name: "Продукты", type: "expense", group: "everyday", icon: "gift", color: "coral" }))
      .toEqual({ icon: "gift", tone: "coral" });
    // Одно поле — только оно: второе по-прежнему выводится по имени.
    expect(categoryVisual({ name: "Продукты", type: "expense", group: "everyday", color: "sage" }))
      .toEqual({ icon: "shopping-basket", tone: "sage" });
    // Имена макета `sand` и `rose` — наши `amber` и `coral`.
    expect(toneOfKey("sand")).toBe("amber");
    expect(toneOfKey("rose")).toBe("coral");
    // G-003 пишет `"sage"` и `"mint"`.
    expect(toneOfKey("sage")).toBe("sage");
    expect(toneOfKey("mint")).toBe("mint");
  });

  it("враждебное имя и чужой ключ не находят ничего унаследованного и не бросают — только запасной вид", () => {
    const hostileNames = ["constructor", "__proto__", "prototype", "toString", "hasOwnProperty", "valueOf", "__defineGetter__", "", " ", "\u202eПродукты", "Продукты\u0000"];
    for (const name of hostileNames) {
      const visual = categoryVisual({ name, type: "expense", group: "everyday" });
      expect(ICON_NAMES, name).toContain(visual.icon);
      expect(TONES, name).toContain(visual.tone);
    }
    expect(categoryVisual({ name: "constructor", type: "expense", group: "personal" })).toEqual({ icon: "tag", tone: "lilac" });
    const hostileKeys: unknown[] = ["constructor", "__proto__", "toString", "prototype", "valueOf", "#ff0000", "url(evil)", "../sprite.svg", "SAGE", "sage ", "", 42, null, {}, ["sage"]];
    for (const key of hostileKeys) {
      expect(toneOfKey(key), String(key)).toBeNull();
      expect(iconOfKey(key), String(key)).toBeNull();
      const visual = categoryVisual({ name: "Продукты", type: "expense", group: "everyday", icon: key as string, color: key as string });
      expect(visual, String(key)).toEqual({ icon: "shopping-basket", tone: "mint" });
    }
    // Унаследованное поле — не поле сущности: категория без своих `icon` и `color` с подменённым прототипом.
    const inherited = Object.create({ icon: "gift", color: "coral" }) as { icon?: string; color?: string };
    expect(categoryVisual(Object.assign(inherited, { name: "Продукты", type: "expense" as const, group: "everyday" })))
      .toEqual({ icon: "shopping-basket", tone: "mint" });
    // Группа, которую домен не разбирает, — тоже не исключение.
    expect(() => categoryVisual({ name: "Батут", type: "expense", group: "__proto__" })).not.toThrow();
  });

  it("даёт счёту глиф по виду, а ключ семьи — только из спрайта", () => {
    expect(accountIcon({ type: "cash", currency: "RUB" }, "RUB")).toBe("banknote");
    expect(accountIcon({ type: "savings", currency: "RUB" }, "RUB")).toBe("piggy-bank");
    expect(accountIcon({ type: "current", currency: "USD", icon: "wallet" }, "RUB")).toBe("wallet");
    expect(accountIcon({ type: "current", currency: "USD", icon: "constructor" }, "USD")).toBe("credit-card");
    // Чужой ключ у счёта в чужой валюте — знак валюты, а не пустая подложка.
    expect(accountIcon({ type: "current", currency: "USD", icon: "constructor" }, "RUB")).toBe("dollar-sign");
    expect(accountIcon({ type: "toString" as "cash", currency: "RUB" }, "RUB")).toBe("wallet");
  });
});
