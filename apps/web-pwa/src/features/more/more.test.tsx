import { makePlanningSeed, type BudgetState } from "@family-budget/domain";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { accountsNote, categoriesNote, debtsNote, goalsNote, MoreScreen, recurringNote, tagsNote } from "./MoreScreen";

function render(budget: BudgetState = makePlanningSeed()): string {
  return renderToStaticMarkup(
    <MoreScreen
      budget={budget}
      storageHealth={null}
      showIosInstall={false}
      lastSuccessfulBackup={null}
      onCreateBackup={vi.fn()}
      onRecordSuccessfulBackup={vi.fn()}
      onRestoreBackup={vi.fn()}
      onPersistClear={vi.fn()}
      onPublishEmpty={vi.fn()}
      onFamily={vi.fn()}
      onPlanMonth={vi.fn()}
      onPlanYear={vi.fn()}
      onImportStatement={vi.fn()}
      onAccounts={vi.fn()}
      accountsNote={accountsNote(budget)}
      onCategories={vi.fn()}
      categoriesNote={categoriesNote(budget)}
      onTags={vi.fn()}
      tagsNote={tagsNote(budget)}
      onDebts={vi.fn()}
      debtsNote={debtsNote(budget)}
      onGoals={vi.fn()}
      goalsNote={goalsNote(budget)}
      onRecurring={vi.fn()}
      recurringNote={recurringNote(budget)}
      onRates={vi.fn()}
      ratesNote="база RUB · курсов нет"
      familyNote="Без входа приложение работает как сейчас"
      monthNote="выплаты 5-го"
      syncIndicator={{ text: "", className: "sync-badge", ariaLabel: "" }}
    />,
  );
}

describe("«Ещё»: группа «Деньги» — строки «Учёта» (план волны 2, §1.12; макет v5 10)", () => {
  it("первая группа — «Деньги»: «Счета», «Категории и доходы», «Метки», «Курсы валют», у каждой — подпись", () => {
    const markup = render();
    const ledger = /<section class="list-group" aria-labelledby="more-ledger-title">([^]*?)<\/section>/u.exec(markup)?.[1] ?? "";
    expect(markup.indexOf("more-ledger-title")).toBeLessThan(markup.indexOf("more-family-title"));
    const rows = [...ledger.matchAll(/<strong>([^<]+)<\/strong><small>([^<]+)<\/small>/gu)].map((match) => [match[1], match[2]]);
    expect(rows).toEqual([
      ["Счета", "2 счёта"],
      ["Категории и доходы", "7 расходов · 0 доходов"],
      ["Метки", "меток пока нет"],
      ["Курсы валют", "база RUB · курсов нет"],
    ]);
    expect(ledger.match(/<button class="list-row" type="button">/gu)).toHaveLength(4);
  });

  it("«Планы» — как в макете: «План месяца», заглушки 2e «Регулярные», «Цели», «Долги», затем «План на год»", () => {
    const markup = render();
    const plans = /<section class="list-group" aria-labelledby="more-plan-title">([^]*?)<\/section>/u.exec(markup)?.[1] ?? "";
    const rows = [...plans.matchAll(/<strong>([^<]+)<\/strong><small>([^<]+)<\/small>/gu)].map((match) => [match[1], match[2]]);
    // Заглушки до 2e (R2) — той же строкой, что и соседи: подпись говорит, сколько уже есть в бюджете.
    expect(rows).toEqual([
      ["План месяца", "выплаты 5-го"],
      ["Регулярные", "регулярных пока нет"],
      ["Цели", "1 цель"],
      ["Долги", "долгов нет"],
      ["План на год", "12–24 месяца вперёд: сезонные и годовые расходы"],
    ]);
    expect(plans.match(/<button class="list-row" type="button">/gu)).toHaveLength(5);
  });

  it("подписи заглушек — сколько уже есть в бюджете", () => {
    const seed = makePlanningSeed();
    expect(debtsNote(seed)).toBe("долгов нет");
    expect(goalsNote({ ...seed, goals: [] })).toBe("целей пока нет");
    expect(recurringNote(seed)).toBe("регулярных пока нет");
    const debt = { id: "e2c00000-0000-4000-8000-0000000000d1", counterparty: "Саша", direction: "owed_to_me" as const, currency: "RUB", openingMinor: 0, active: true };
    expect(debtsNote({ ...seed, debts: [debt, { ...debt, id: "e2c00000-0000-4000-8000-0000000000d2" }] })).toBe("2 долга");
  });

  it("группы — «Деньги», «Планы», «Данные», «Семья», «О приложении»; у строки — подложка тона сущности", () => {
    const markup = render();
    const kickers = [...markup.matchAll(/<h2 id="[^"]+" class="list-kicker">([^<]+)<\/h2>/gu)].map((match) => match[1]);
    expect(kickers).toEqual(["Деньги", "Планы", "Данные", "Семья", "О приложении"]);
    const plates = [...markup.matchAll(/<span class="list-icon([^"]*)"><svg[^>]*><use href="#glyph-([a-z-]+)"/gu)]
      .map((match) => `${match[2]}${match[1]}`);
    // Счёт — графит, как плитка счёта; справочники и планы — тоны макета, соседние — разные;
    // служебные строки — без тона.
    expect(plates.slice(0, 9)).toEqual([
      "wallet account", "layout-grid tone-mint", "hash tone-peach", "scale tone-amber",
      "calendar tone-lilac", "repeat tone-sage", "target tone-coral", "user-round tone-peach", "calendar-clock tone-amber",
    ]);
    expect(plates).toContain("users tone-coral");
    expect(plates).toContain("download");
  });

  it("подписи — числа словами: архив назван отдельно", () => {
    const seed = makePlanningSeed();
    const budget: BudgetState = {
      ...seed,
      accounts: [...seed.accounts, { ...seed.accounts[0]!, id: "e2c00000-0000-4000-8000-0000000000e9", name: "Старый", active: false }],
      tags: [{ id: "e2c00000-0000-4000-8000-0000000000e8", name: "Отпуск", active: true }, { id: "e2c00000-0000-4000-8000-0000000000e7", name: "Дача", active: false }],
    };
    expect(accountsNote(budget)).toBe("2 счёта · 1 в архиве");
    expect(tagsNote(budget)).toBe("1 метка · 1 в архиве");
    expect(accountsNote({ ...seed, accounts: [] })).toBe("активных счетов нет");
    expect(categoriesNote({ ...seed, categories: seed.categories.slice(0, 1) })).toBe("1 расход · 0 доходов");
  });
});
