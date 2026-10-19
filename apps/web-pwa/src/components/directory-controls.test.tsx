import { isDisplayKey, SUPPORTED_CURRENCIES, type CurrencyCode } from "@family-budget/domain";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { iconOfKey, toneOfKey } from "../category-visual";
import { CurrencySelect, currencyChoices, currencyLabel, currencyName, FREQUENT_CURRENCIES } from "./CurrencySelect";
import { ICON_NAMES } from "./Icon";
import { ACCOUNT_ICON_CHOICES, CATEGORY_ICON_CHOICES, ICON_WORDS, IconPicker } from "./IconPicker";
import { ReorderControls } from "./ReorderControls";
import { TONE_CHOICES, TonePicker } from "./TonePicker";

const plain = (markup: string) => markup.replace(/<[^>]+>/gu, " ").replace(/\s+/gu, " ").trim();
const radios = (markup: string) => [...markup.matchAll(/<label class="picker-option"><input type="radio" name="[^"]+"( checked="")? value="([^"]+)"/gu)]
  .map((match) => ({ value: match[2], checked: match[1] !== undefined }));

describe("выбор иконки", () => {
  it("радиогруппа под подписью: «Авто» первым, у каждого варианта слово, выбранный — с галочкой", () => {
    const markup = renderToStaticMarkup(
      <IconPicker legend="Иконка" icons={CATEGORY_ICON_CHOICES} value="bus" fallback="shopping-basket" tone="mint" onChange={vi.fn()} />,
    );
    expect(markup).toMatch(/^<fieldset class="picker"><legend>Иконка<\/legend>/u);
    const options = radios(markup);
    expect(options[0]).toEqual({ value: "auto", checked: false });
    expect(options.map((option) => option.value).slice(1)).toEqual([...CATEGORY_ICON_CHOICES]);
    expect(options.filter((option) => option.checked)).toEqual([{ value: "bus", checked: true }]);
    // «Авто» показывает выведенный глиф, а не пустое место.
    expect(markup).toMatch(/value="auto"[^]*?href="#glyph-shopping-basket"[^]*?Авто/u);
    // Доступное имя — слово под образцом; глиф декоративен.
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
    expect(markup).toContain('<fieldset class="picker" disabled="">');
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
    // «Авто» — образец выведенного тона; галочка — только у выбранного.
    expect(markup).toMatch(/value="auto"\/><span class="icon-plate tone-swatch tone-mint" aria-hidden="true"><\/span>/u);
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

  it("названия — по-русски с прописной и с кодом: «Доллар США — USD»", () => {
    expect(currencyLabel("USD")).toBe("Доллар США — USD");
    expect(currencyLabel("RUB")).toBe("Российский рубль — RUB");
    expect(currencyName("KZT")).toMatch(/^[А-Я][а-я]+ тенге$/u);
  });

  it("поле — список с группами: ваши валюты, частые, все; исключённой нет", () => {
    const markup = renderToStaticMarkup(<CurrencySelect id="currency" value="USD" exclude={["RUB"]} preferred={["KZT", "USD"]} onChange={vi.fn()} />);
    expect(markup).toMatch(/^<select id="currency"><optgroup label="Ваши валюты"><option value="KZT" selected="">|^<select id="currency"><optgroup label="Ваши валюты"><option value="KZT">/u);
    expect(markup.indexOf('label="Ваши валюты"')).toBeLessThan(markup.indexOf('label="Частые"'));
    expect(markup.indexOf('label="Частые"')).toBeLessThan(markup.indexOf('label="Все валюты"'));
    expect(markup).not.toContain('value="RUB"');
    expect(markup.match(/value="USD"/gu)).toHaveLength(1);
    expect(markup.match(/value="KZT"/gu)).toHaveLength(1);
    const codes = [...markup.matchAll(/<option value="([A-Z]{3})"/gu)].map((match) => match[1] as CurrencyCode);
    expect(codes.length).toBe(Object.keys(SUPPORTED_CURRENCIES).length - 1);
  });
});

describe("порядок «Выше / Ниже»", () => {
  const render = (position: number, count: number) =>
    renderToStaticMarkup(<ReorderControls id="row-a" name="Карта" position={position} count={count} onMove={vi.fn()} />);

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
});
