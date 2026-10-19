import { makePlanningSeed, type BudgetState } from "@family-budget/domain";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { accountsNote, categoriesNote, MoreScreen, tagsNote } from "./MoreScreen";

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
      onRates={vi.fn()}
      ratesNote="база RUB · курсов нет"
      familyNote="Без входа приложение работает как сейчас"
      monthNote="выплаты 5-го"
      syncIndicator={{ text: "", className: "sync-badge", ariaLabel: "" }}
    />,
  );
}

describe("«Ещё»: группа «Учёт» (план волны 2, §1.12)", () => {
  it("первая группа — «Учёт»: «Счета», «Категории и доходы», «Метки», «Курсы валют», у каждой — подпись", () => {
    const markup = render();
    const ledger = /<section class="list-group" aria-labelledby="more-ledger-title">([^]*?)<\/section>/u.exec(markup)?.[1] ?? "";
    expect(markup.indexOf("more-ledger-title")).toBeLessThan(markup.indexOf("more-family-title"));
    const rows = [...ledger.matchAll(/<strong>([^<]+)<\/strong><small>([^<]+)<\/small>/gu)].map((match) => [match[1], match[2]]);
    expect(rows).toEqual([
      ["Счета", "2 счёта"],
      ["Категории и доходы", "7 категорий расходов · 0 источников дохода"],
      ["Метки", "меток пока нет"],
      ["Курсы валют", "база RUB · курсов нет"],
    ]);
    // Долги, цели и регулярные придут с 2e — мёртвых ссылок на них нет.
    expect(markup).not.toMatch(/Долги|Цели|Регулярные/u);
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
  });
});
