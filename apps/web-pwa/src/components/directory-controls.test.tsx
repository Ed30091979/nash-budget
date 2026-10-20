import { isDisplayKey, SUPPORTED_CURRENCIES, type CurrencyCode } from "@family-budget/domain";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { iconOfKey, toneOfKey } from "../category-visual";
import {
  CURRENCY_CHIP_COUNT,
  currencyChipName,
  currencyChips,
  currencyChoices,
  currencyLabel,
  currencyName,
  CurrencyPicker,
  currencyShortName,
  currencySymbol,
  FREQUENT_CURRENCIES,
  searchCurrencies,
} from "./CurrencyPicker";
import { FormSheet, isolateOutside } from "./FormSheet";
import { ICON_NAMES } from "./Icon";
import { ACCOUNT_ICON_CHOICES, CATEGORY_ICON_CHOICES, ICON_WORDS, IconPicker } from "./IconPicker";
import { OptionCards } from "./OptionCards";
import { dropIndex, ReorderControls, ReorderList, stepsBetween } from "./ReorderControls";
import { TONE_CHOICES, TonePicker } from "./TonePicker";

const plain = (markup: string) => markup.replace(/<[^>]+>/gu, " ").replace(/\s+/gu, " ").trim();
const radios = (markup: string) => [...markup.matchAll(/<label class="picker-option(?: picker-auto)?"><input type="radio" name="[^"]+"( checked="")? value="([^"]+)"/gu)]
  .map((match) => ({ value: match[2], checked: match[1] !== undefined }));

describe("выбор иконки", () => {
  it("радиогруппа под подписью: «Авто» первым, у каждого варианта слово, выбранный — с галочкой", () => {
    const markup = renderToStaticMarkup(
      <IconPicker legend="Значок" icons={CATEGORY_ICON_CHOICES} value="bus" fallback="shopping-basket" tone="mint" onChange={vi.fn()} />,
    );
    expect(markup).toMatch(/^<fieldset class="picker icon-picker"><legend class="dir-label">Значок<\/legend>/u);
    const options = radios(markup);
    expect(options[0]).toEqual({ value: "auto", checked: false });
    expect(options.map((option) => option.value).slice(1)).toEqual([...CATEGORY_ICON_CHOICES]);
    expect(options.filter((option) => option.checked)).toEqual([{ value: "bus", checked: true }]);
    // «Авто» показывает выведенный глиф, а не пустое место, — в пунктирной рамке и со словом на виду.
    expect(markup).toMatch(/<label class="picker-option picker-auto"><input type="radio"[^>]*value="auto"\/><span class="icon-plate tone-mint auto" aria-hidden="true">[^]*?href="#glyph-shopping-basket"[^]*?<span class="picker-word">Авто<\/span>/u);
    // Доступное имя — слово глифа (для слуха); на глаз глиф и есть слово (макет 13).
    expect(markup).toContain('<span class="sr-only">Автобус</span>');
    expect(plain(markup)).toContain("Автобус");
    expect(markup.match(/class="picker-check"/gu)).toHaveLength(1);
    expect(markup).not.toMatch(/<svg[^>]*role="img"/u);
    // Подложка окрашена выбранным рядом тоном.
    expect(markup).toContain('class="icon-plate tone-mint"');
  });

  it("«Авто» выбрано, когда ключа нет; выключенная группа выключает всё", () => {
    const markup = renderToStaticMarkup(
      <IconPicker legend="Иконка счёта" icons={ACCOUNT_ICON_CHOICES} value={null} fallback="credit-card" tone="neutral" disabled onChange={vi.fn()} />,
    );
    expect(radios(markup).filter((option) => option.checked)).toEqual([{ value: "auto", checked: true }]);
    expect(markup).toContain('<fieldset class="picker icon-picker" disabled="">');
  });

  it("предлагает только глифы спрайта, у каждого есть слово, и ключ из данных их находит; монет нет", () => {
    for (const icon of [...ACCOUNT_ICON_CHOICES, ...CATEGORY_ICON_CHOICES]) {
      expect(ICON_NAMES, icon).toContain(icon);
      expect(ICON_WORDS.get(icon), icon).toBeTruthy();
      expect(isDisplayKey(icon), icon).toBe(true);
      expect(iconOfKey(icon)).toBe(icon);
      expect(icon).not.toMatch(/coin/u);
    }
    expect(new Set(ACCOUNT_ICON_CHOICES).size).toBe(ACCOUNT_ICON_CHOICES.length);
    expect(new Set(CATEGORY_ICON_CHOICES).size).toBe(CATEGORY_ICON_CHOICES.length);
    expect(ICON_NAMES.filter((name) => /coin/u.test(name))).toEqual([]);
  });
});

describe("выбор тона", () => {
  it("радиогруппа со словами — «Мята», «Сирень», — «Авто» первым, выбранный образец с галочкой", () => {
    const markup = renderToStaticMarkup(<TonePicker legend="Цвет" value="lilac" fallback="mint" onChange={vi.fn()} />);
    const text = plain(markup);
    for (const word of ["Авто", "Мята", "Шалфей", "Персик", "Янтарь", "Коралл", "Сирень", "Без цвета"]) expect(text).toContain(word);
    const options = radios(markup);
    expect(options.map((option) => option.value)).toEqual(["auto", "mint", "sage", "peach", "amber", "coral", "lilac", "neutral"]);
    expect(options.filter((option) => option.checked)).toEqual([{ value: "lilac", checked: true }]);
    // «Авто» — образец выведенного тона в пунктирной рамке; галочка — только у выбранного.
    expect(markup).toMatch(/^<fieldset class="picker tone-picker"><legend class="dir-label">Цвет<\/legend>/u);
    expect(markup).toMatch(/value="auto"\/><span class="icon-plate tone-swatch tone-mint auto" aria-hidden="true"><\/span><span class="picker-word">Авто<\/span>/u);
    expect(markup.match(/href="#glyph-check"/gu)).toHaveLength(1);
  });

  it("ключи тонов — прежние ключи данных: их пишет G-003 и читает вид категории", () => {
    for (const { tone } of TONE_CHOICES) {
      expect(isDisplayKey(tone), tone).toBe(true);
      expect(toneOfKey(tone)).toBe(tone);
    }
  });
});

describe("выбор валюты", () => {
  it("частые — сверху в своём порядке, потом все прочие по русскому алфавиту; каждая валюта ровно раз", () => {
    const { frequent, others } = currencyChoices();
    expect(frequent).toEqual(FREQUENT_CURRENCIES);
    expect(frequent.slice(0, 3)).toEqual(["RUB", "USD", "EUR"]);
    const all = [...frequent, ...others];
    expect(new Set(all).size).toBe(all.length);
    expect([...all].sort()).toEqual(Object.keys(SUPPORTED_CURRENCIES).sort());
    const names = others.map((code) => currencyName(code));
    expect(names).toEqual([...names].sort((left, right) => left.localeCompare(right, "ru")));
  });

  it("названия — по-русски с прописной и с кодом: «Доллар США — USD»; на чипе — коротко, со знаком", () => {
    expect(currencyLabel("USD")).toBe("Доллар США — USD");
    expect(currencyLabel("RUB")).toBe("Российский рубль — RUB");
    expect(currencyName("KZT")).toMatch(/^[А-Я][а-я]+ тенге$/u);
    // Макет 12: «₽ Рубль», «$ Доллар», «€ Евро», «¥ Юань», «₸ Тенге».
    expect(["RUB", "USD", "EUR", "CNY", "KZT"].map((code) => `${currencySymbol(code)} ${currencyShortName(code)}`)).toEqual(["₽ Рубль", "$ Доллар", "€ Евро", "¥ Юань", "₸ Тенге"]);
    // Короткое имя — только однозначное: белорусский рубль не «Рубль», а сокращение «р.» — не знак.
    expect(currencyShortName("BYN")).toBe("Белорусский рубль");
    expect(currencySymbol("BYN")).toBeNull();
    expect(currencySymbol("UZS")).toBeNull();
    // Доступное имя чипа начинается видимым словом (WCAG 2.5.3) и несёт код.
    expect(currencyChipName("USD")).toBe("Доллар — USD");
  });

  it("чипы: валюты семьи, затем частые — не больше пяти; выбранная — всегда чипом; исключённой нет", () => {
    expect(currencyChips("RUB")).toEqual(["RUB", "USD", "EUR", "CNY", "KZT"]);
    expect(currencyChips("RUB")).toHaveLength(CURRENCY_CHIP_COUNT);
    expect(currencyChips("USD", ["GEL", "USD"])).toEqual(["GEL", "USD", "RUB", "EUR", "CNY"]);
    // Выбранная из поиска валюта встаёт шестым чипом, а не прячется за «Другая».
    expect(currencyChips("THB")).toEqual(["RUB", "USD", "EUR", "CNY", "KZT", "THB"]);
    expect(currencyChips("USD", [], ["RUB"])).toEqual(["USD", "EUR", "CNY", "KZT", "BYN"]);
    // Неизвестный код в выбор не попадает.
    expect(currencyChips("RUB", ["XXX" as CurrencyCode])).not.toContain("XXX");
  });

  it("поиск — по коду с начала и по русскому названию где угодно, «ё» как «е», без регистра; только разрешённые", () => {
    expect(searchCurrencies("тенге")).toEqual(["KZT"]);
    expect(searchCurrencies("kz")).toEqual(["KZT"]);
    expect(searchCurrencies("  KZT ")).toEqual(["KZT"]);
    expect(searchCurrencies("фунт")).toContain("GBP");
    expect(searchCurrencies("рубль")).toEqual(expect.arrayContaining(["RUB", "BYN"]));
    expect(searchCurrencies("рубль", ["RUB"])).not.toContain("RUB");
    expect(searchCurrencies("зззз")).toEqual([]);
    // Пустой запрос — весь список: частые первыми, каждая валюта ровно раз.
    const all = searchCurrencies("");
    expect(all.slice(0, FREQUENT_CURRENCIES.length)).toEqual(FREQUENT_CURRENCIES);
    expect(new Set(all).size).toBe(Object.keys(SUPPORTED_CURRENCIES).length);
  });

  it("радиогруппа чипов без <select>: Tab входит на выбранный, у чипа — имя и код; «Другая» раскрывает поиск", () => {
    const markup = renderToStaticMarkup(<CurrencyPicker id="currency" labelledBy="currency-label" value="USD" exclude={["RUB"]} preferred={["KZT", "USD"]} onChange={vi.fn()} />);
    expect(markup).not.toContain("<select");
    expect(markup).toMatch(/^<div class="cur-picker"><div id="currency" class="cur-chips" role="radiogroup" tabindex="-1" aria-labelledby="currency-label">/u);
    const chips = [...markup.matchAll(/id="currency-([A-Z]{3})" class="chip cur-chip" type="button" role="radio" aria-checked="(true|false)" aria-label="([^"]+)" tabindex="(-1|0)"/gu)]
      .map((match) => ({ code: match[1], checked: match[2], name: match[3], tab: match[4] }));
    expect(chips.map((chip) => chip.code)).toEqual(["KZT", "USD", "EUR", "CNY", "BYN"]);
    // Одна остановка Tab — выбранный чип; остальные — по стрелкам.
    expect(chips.filter((chip) => chip.tab === "0")).toEqual([{ code: "USD", checked: "true", name: "Доллар — USD", tab: "0" }]);
    expect(chips.filter((chip) => chip.checked === "true")).toHaveLength(1);
    expect(markup).toContain('<button id="currency-other" class="chip cur-other" type="button" aria-expanded="false">');
    expect(plain(markup)).toContain("Другая");
    // Список с поиском закрыт, пока «Другая» не нажата.
    expect(markup).not.toContain('role="listbox"');
  });

  it("запертая валюта: чипы говорят «нет», «Другой» нет, причина — в описании группы", () => {
    const markup = renderToStaticMarkup(<CurrencyPicker id="c" labelledBy="l" value="USD" locked describedBy="c-lock" onChange={vi.fn()} />);
    expect(markup).toContain('role="radiogroup" tabindex="-1" aria-labelledby="l" aria-describedby="c-lock" aria-disabled="true"');
    expect(markup.match(/role="radio" aria-checked="(?:true|false)" aria-label="[^"]+" aria-disabled="true"/gu)).toHaveLength(CURRENCY_CHIP_COUNT);
    expect(markup).not.toContain("Другая");
  });
});

describe("лист справочника", () => {
  it("модальный диалог: заголовок листа, «Закрыть» 48, форма с обработчиком и подвал", () => {
    const markup = renderToStaticMarkup(
      <FormSheet id="s" title="Новый счёт" titleLevel={1} onClose={vi.fn()} onSubmit={vi.fn()} footer={<button type="submit">Сохранить</button>}>
        <p>Тело</p>
      </FormSheet>,
    );
    expect(markup).toMatch(/^<div class="sheet-backdrop dir-backdrop" role="presentation"><section class="sheet dir-sheet" role="dialog" aria-modal="true" aria-labelledby="s-title" tabindex="-1">/u);
    expect(markup).toContain('<button class="icon-button" type="button" aria-label="Закрыть">');
    expect(markup).toContain('<h1 id="s-title" tabindex="-1">Новый счёт</h1>');
    expect(markup).toMatch(/<form class="dir-sheet-form" novalidate=""><div class="dir-sheet-body"><p>Тело<\/p><\/div><div class="dir-sheet-foot"><button type="submit">Сохранить<\/button><\/div><\/form>/iu);
    // Лист поверх экрана (метка) — h2 под h1 экрана; без формы подвал стоит прямо в листе.
    const local = renderToStaticMarkup(<FormSheet id="t" title="Метка" onClose={vi.fn()}><p>Тело</p></FormSheet>);
    expect(local).toContain('<h2 id="t-title" tabindex="-1">Метка</h2>');
    expect(local).not.toContain("<form");
  });

  it("выключает всё вокруг листа на каждом уровне до <body> — и возвращает атрибуты как были", () => {
    type Node = { tagName: string; parentElement: Node | null; children: Node[]; attrs: Map<string, string> };
    const make = (tagName: string, parent: Node | null, attrs: Record<string, string> = {}): Node => {
      const node: Node = { tagName, parentElement: parent, children: [], attrs: new Map(Object.entries(attrs)) };
      parent?.children.push(node);
      return node;
    };
    const body = make("BODY", null);
    const root = make("DIV", body);
    const portal = make("DIV", body, { "aria-hidden": "false" });
    const script = make("SCRIPT", body);
    const header = make("HEADER", root);
    const nav = make("NAV", root, { inert: "" });
    const main = make("MAIN", root);
    const under = make("DIV", main);
    const sheet = make("DIV", main);
    interface Handle {
      readonly tagName: string;
      readonly parentElement: Handle | null;
      readonly children: Handle[];
      getAttribute(name: string): string | null;
      hasAttribute(name: string): boolean;
      setAttribute(name: string, value: string): void;
      removeAttribute(name: string): void;
    }
    const cache = new Map<Node, Handle>();
    const wrap = (node: Node): Handle => {
      const known = cache.get(node);
      if (known !== undefined) return known;
      const handle: Handle = {
        get tagName() { return node.tagName; },
        get parentElement(): Handle | null { return node.parentElement === null ? null : wrap(node.parentElement); },
        get children(): Handle[] { return node.children.map(wrap); },
        getAttribute: (name) => node.attrs.get(name) ?? null,
        hasAttribute: (name) => node.attrs.has(name),
        setAttribute: (name, value) => { node.attrs.set(name, value); },
        removeAttribute: (name) => { node.attrs.delete(name); },
      };
      cache.set(node, handle);
      return handle;
    };
    const restore = isolateOutside(wrap(sheet));
    for (const node of [under, header, nav, portal]) {
      expect(node.attrs.has("inert"), node.tagName).toBe(true);
      expect(node.attrs.get("aria-hidden"), node.tagName).toBe("true");
    }
    for (const node of [sheet, main, root, body, script]) expect(node.attrs.has("inert"), node.tagName).toBe(false);
    restore();
    expect(under.attrs.size).toBe(0);
    expect(header.attrs.size).toBe(0);
    // Было выключено до листа — таким и осталось; чужое aria-hidden вернулось своим значением.
    expect([...nav.attrs]).toEqual([["inert", ""]]);
    expect([...portal.attrs]).toEqual([["aria-hidden", "false"]]);
  });
});

describe("выбор карточками 2×2", () => {
  it("настоящие радиокнопки под подписью; выбранная — с галочкой; слово переносится по слогам", () => {
    const markup = renderToStaticMarkup(
      <OptionCards id="kind" legend="Вид" value="savings" onChange={vi.fn()} options={[
        { value: "current", label: "Карта или счёт", icon: "credit-card", id: "kind-current" },
        { value: "savings", label: "Накопления", icon: "piggy-bank", id: "kind-savings" },
      ]} />,
    );
    expect(markup).toMatch(/^<fieldset id="kind" class="dir-options" tabindex="-1"><legend class="dir-label">Вид<\/legend>/u);
    expect(markup).toMatch(/<input id="kind-savings" type="radio" name="[^"]+" checked="" value="savings"\/>/u);
    expect(markup.match(/class="dir-option-check"/gu)).toHaveLength(1);
    expect(markup).toMatch(/<span class="dir-option-word" aria-hidden="true">[^<]*\u00ad[^<]*<\/span><span class="sr-only">Накопления<\/span>/u);
    // Доступное имя варианта — целое слово: копия с переносами скрыта от диктора.
    expect(markup.replace(/<span class="dir-option-word" aria-hidden="true">[^<]*<\/span>/gu, "")).not.toContain("\u00ad");
  });
});

describe("порядок «Выше / Ниже»", () => {
  const render = (position: number, count: number, compact = false) =>
    renderToStaticMarkup(<ReorderControls id="row-a" name="Карта" position={position} count={count} compact={compact} onMove={vi.fn()} />);

  it("две кнопки с доступным именем записи и направления, группа называет место", () => {
    const markup = render(2, 4);
    expect(markup).toContain('role="group" aria-label="Место в списке: 2 из 4"');
    expect(markup).toContain('id="row-a-up" class="secondary-button" type="button" aria-label="Карта — выше"');
    expect(markup).toContain('id="row-a-down" class="secondary-button" type="button" aria-label="Карта — ниже"');
    expect(markup).not.toContain("aria-disabled");
    expect(plain(markup)).toBe("Выше Ниже");
  });

  it("на краю кнопка говорит «нет», но не выключается — фокус остаётся на ней", () => {
    expect(render(1, 3)).toMatch(/aria-label="Карта — выше" aria-disabled="true"/u);
    expect(render(3, 3)).toMatch(/aria-label="Карта — ниже" aria-disabled="true"/u);
    expect(render(1, 1).match(/aria-disabled="true"/gu)).toHaveLength(2);
    expect(render(1, 3)).not.toContain("disabled=\"\"");
  });

  it("в режиме «Изменить порядок» — стрелки 48 с теми же именами, местом и краем", () => {
    const markup = render(1, 3, true);
    expect(markup).toContain('id="row-a-up" class="icon-button reorder-step" type="button" aria-label="Карта — выше" aria-disabled="true"');
    expect(markup).toContain('id="row-a-down" class="icon-button reorder-step" type="button" aria-label="Карта — ниже"');
    expect(markup).toContain('href="#glyph-arrow-up"');
    expect(markup).toContain('href="#glyph-arrow-down"');
    expect(plain(markup)).toBe("");
  });

  it("список режима: ручка (только для мыши, не для слуха), подложка, имя, подпись и стрелки у каждой строки", () => {
    const markup = renderToStaticMarkup(
      <ReorderList idPrefix="account" label="Порядок счетов" busy={false} onMove={vi.fn()} onMoveTo={vi.fn()} items={[
        { id: "a", name: "Карта", plate: <span className="icon-plate" />, caption: "Карта или счёт" },
        { id: "b", name: "Наличные", plate: <span className="icon-plate" /> },
      ]} />,
    );
    expect(markup).toMatch(/^<ol class="card dir-card reorder-list" aria-label="Порядок счетов">/u);
    expect(markup.match(/<span class="reorder-grip" aria-hidden="true">/gu)).toHaveLength(2);
    expect(markup).toContain('aria-label="Место в списке: 1 из 2"');
    expect(markup).toContain('id="account-a-up"');
    expect(markup).toContain('id="account-b-down"');
    expect(markup).toMatch(/aria-label="Карта — выше" aria-disabled="true"/u);
    expect(markup).toMatch(/aria-label="Наличные — ниже" aria-disabled="true"/u);
    // Имя для глаза — с мягкими переносами и скрыто от диктора; для слуха — целое.
    expect(markup).toMatch(/<strong aria-hidden="true"><bdi dir="auto">[^<]+<\/bdi><\/strong><span class="sr-only">Наличные<\/span>/u);
    expect(markup.replace(/<strong aria-hidden="true">[^]*?<\/strong>/gu, "")).not.toContain("\u00ad");
    expect(plain(markup.replace(/<strong aria-hidden="true">[^]*?<\/strong>/gu, ""))).toBe("Карта Карта или счёт Наличные");
  });

  it("перетаскивание: место — по серединам соседей, перестановка — шагами соседей, как кнопки", () => {
    const rows = [{ top: 0, height: 64 }, { top: 64, height: 64 }, { top: 128, height: 64 }, { top: 192, height: 64 }];
    expect(dropIndex(rows, 0, 10)).toBe(0);
    expect(dropIndex(rows, 0, 100)).toBe(1);
    expect(dropIndex(rows, 0, 250)).toBe(3);
    expect(dropIndex(rows, 3, 20)).toBe(0);
    expect(dropIndex(rows, 3, 150)).toBe(2);
    expect(dropIndex(rows, 3, 170)).toBe(3);
    expect(dropIndex(rows, 2, 150)).toBe(2);
    expect(stepsBetween(0, 3)).toEqual(["down", "down", "down"]);
    expect(stepsBetween(3, 1)).toEqual(["up", "up"]);
    expect(stepsBetween(2, 2)).toEqual([]);
  });
});
