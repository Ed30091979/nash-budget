/// <reference types="node" />
import { readFileSync } from "node:fs";
import { makeDefaultCategories, type BudgetState } from "@family-budget/domain";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { designTouchTargetMinimum } from "../../design-contract";
import { classifyStatement } from "./classify";
import { IMPORT_PRIVACY_TEXT, IMPORT_PRIVACY_TITLE, ImportScreen, periodWords, type ImportStage } from "./ImportScreen";
import { parseStatement } from "./statement";
import { sampleStatementBytes } from "./test-fixture";

const ids = {
  accounts: { main: "11000000-0000-4000-8000-000000000001", savings: "11000000-0000-4000-8000-000000000002" },
  budget: "33000000-0000-4000-8000-000000000001",
} as const;

let counter = 0;
function nextId(): string {
  counter += 1;
  return `cccccccc-0000-4000-8000-${String(counter).padStart(12, "0")}`;
}

function household(): BudgetState {
  return {
    activeBudgetId: ids.budget,
    accounts: [
      { id: ids.accounts.main, name: "Основной", type: "current", currency: "RUB", openingBalanceMinor: 0, active: true },
      { id: ids.accounts.savings, name: "Накопительный", type: "savings", currency: "RUB", openingBalanceMinor: 0, active: true },
    ],
    categories: makeDefaultCategories(nextId),
    budgets: [{ id: ids.budget, startDate: "2026-08-01", endDate: "2026-08-31", status: "open", plannedIncomeMinor: 0, warningThreshold: 0.8, lines: [] }],
    goals: [],
    annualCommitments: [],
    scheduledExpenses: [],
    transactions: [],
  };
}

function reviewStage(budget: BudgetState): ImportStage {
  const parsed = parseStatement(sampleStatementBytes());
  return {
    kind: "review",
    parsed,
    classified: classifyStatement(parsed.operations, budget),
    choices: { accountId: ids.accounts.main, transferAccountId: null, assignments: {}, includeDuplicates: false },
  };
}

function plainText(markup: string): string {
  return markup.replaceAll("&nbsp;", " ").replaceAll("&#xA0;", " ").replaceAll("\u00a0", " ").replaceAll("&quot;", '"').replaceAll("&#x27;", "'").replace(/<[^>]*>/gu, " ").replace(/\s+/gu, " ").trim();
}

const silentMemory = { async load() { return []; }, async remember() { return undefined; }, async clear() { return undefined; } };

describe("экран выписки", () => {
  it("обещает приватность там, где выбирают файл, и принимает только файл", () => {
    const html = renderToStaticMarkup(<ImportScreen budget={household()} onChange={vi.fn(async () => undefined)} onBack={vi.fn()} memory={silentMemory} />);
    const text = plainText(html);

    expect(html).toContain('<h1 id="import-title"');
    expect(text).toContain("Выписка банка");
    // Обещание — плашкой рядом с кнопкой, а не строкой в свёрнутой политике.
    expect(html).toMatch(/<div class="import-privacy" role="note">[\s\S]*Файл читается на этом устройстве/u);
    expect(text).toContain(IMPORT_PRIVACY_TITLE);
    expect(text).toContain(IMPORT_PRIVACY_TEXT);
    expect(html.indexOf("import-privacy")).toBeLessThan(html.indexOf('id="statement-file"'));
    // Файл выбирают той же строкой-кнопкой, что и копию: поле спрятано, кольцо фокуса рисует строка.
    expect(html).toMatch(/<label class="file-button primary-button wide" for="statement-file">/u);
    expect(html).toMatch(/<input id="statement-file" type="file" accept="\.csv,text\/csv,text\/plain"/u);
    expect(text).toContain("Выбрать файл выписки");
    expect(text).toContain("Как выгрузить из Т-Банка");
    // Ничего сетевого и ничего из хранилищ, которые запрещает политика.
    const source = readFileSync(new URL("./ImportScreen.tsx", import.meta.url), "utf8");
    expect(source).not.toMatch(/fetch\(|XMLHttpRequest|localStorage|sessionStorage|navigator\.sendBeacon/u);
    // Файл не хранится: ссылка на него не попадает в состояние, поле очищается в обработчике.
    expect(source).toContain('event.target.value = "";');
    expect(source).not.toMatch(/useState<File/u);
  });

  it("показывает предпросмотр: числа, переводы себе отдельно, незнакомое списком с выбором категории", () => {
    const budget = household();
    const html = renderToStaticMarkup(<ImportScreen budget={budget} initialStage={reviewStage(budget)} onChange={vi.fn(async () => undefined)} onBack={vi.fn()} memory={silentMemory} />);
    const text = plainText(html);

    expect(text).toContain("Разобрано: 14 операций");
    expect(text).toContain("с 1 по 25 августа");
    expect(text).toContain("Покупки 7 операций · 15 293,56 ₽");
    expect(text).toContain("Приходы 2 операции · 120 350,25 ₽");
    // Перевод себе назван отдельно и не считается тратой.
    expect(text).toContain("Переводы себе 2 операции · 30 000 ₽ не трата и не доход — в бюджет не идут");
    expect(text).toContain("Пропущено при разборе 2 операции отменённые 1 · нулевые 1");
    // Незнакомое — списком продавцов, по одному полю на продавца, с категориями по группам.
    expect(text).toContain("Не узнали: 2 продавца");
    expect(text).toContain("ООО \"Ромашка\" 2 операции · списание 4 189,90 ₽ · 5 августа и 6 августа");
    expect(html).toMatch(/<select id="import-merchant-0"[^>]*><option value="" selected="">Выберите категорию<\/option><optgroup label="Каждый день">/u);
    expect(html).toContain('<option value="#skip">Пропустить — не добавлять</option>');
    // «Прочее» доступно только как явный выбор человека, не как умолчание.
    expect(html).toMatch(/<option value="[^"#]+">Прочее<\/option>/u);
    expect(html).not.toMatch(/<option value="[^"]+" selected="">Прочее<\/option>/u);
    // Узнанное — свёрнутым списком с плиткой категории и ступенью, по которой узнали.
    expect(text).toContain("Узнали: 9 операций");
    expect(text).toContain("Продукты 2 авг · Пятёрочка · категория банка −1 234,56 ₽");
    expect(text).toContain("Связь и подписки 7 авг · МТС · по названию −799 ₽");
    expect(text).toContain("Зарплата 1 авг · Зарплата за июль · по названию +120 000 ₽");
    // Кнопка называет число словами, а незнакомое без категории названо неотправленным.
    expect(text).toContain("Добавить 9 операций в бюджет");
    expect(text).toContain("3 операции без категории не будут добавлены.");
    expect(text).toContain("Отменить и забыть файл");
    // Второй счёт есть — переводы себе можно записать переводами, по умолчанию не добавляются.
    expect(html).toMatch(/<select id="import-transfer-account"[^>]*><option value="" selected="">Не добавлять<\/option><option value="[^"]+">Считать переводами на «Накопительный»<\/option>/u);
  });

  it("квитанция импорта предлагает отмену одной кнопкой", () => {
    const stage: ImportStage = { kind: "done", ids: ["a", "b"], count: 9, expenseMinor: 1_529_356, incomeMinor: 12_035_025, transferMinor: 0 };
    const text = plainText(renderToStaticMarkup(<ImportScreen budget={household()} initialStage={stage} onChange={vi.fn(async () => undefined)} onBack={vi.fn()} memory={silentMemory} />));

    expect(text).toContain("Добавлено: 9 операций");
    expect(text).toContain("покупки 15 293,56 ₽ · приходы 120 350,25 ₽");
    expect(text).toContain("Отменить импорт — удалить 9 операций");
    expect(text).toContain("Загрузить ещё одну выписку");
  });

  it("держит цели нажатия по нормативу и не заводит радиусов и длительностей по месту", () => {
    const styles = readFileSync(new URL("../../styles.css", import.meta.url), "utf8");
    const importRules = styles.slice(styles.indexOf("§8 «Выписка банка»"), styles.indexOf("@media (min-width: 760px)"));
    const minimum = designTouchTargetMinimum();

    expect(importRules.length).toBeGreaterThan(200);
    expect(importRules).not.toMatch(/border-radius|#[0-9a-f]{3,6}\b|\d+m?s\b/u);
    // Поля выбора категории — обычные поля §6: 52 pt, не меньше норматива.
    const field = /\.field input, \.field select, \.amount-field input \{[^}]*min-height: (\d+)px/u.exec(styles);
    expect(Number(field?.[1])).toBeGreaterThanOrEqual(minimum);
    // Кнопка выбора файла наследует цель нажатия кнопки.
    expect(styles).toMatch(/\.primary-button, \.secondary-button \{[^}]*min-height: 48px/u);
  });

  it("называет период одним месяцем, когда он один", () => {
    // Дата словом склеена неразрывным пробелом (§7.9): в сравнении он приводится к обычному.
    const words = (period: { from: string; to: string }) => periodWords(period).replaceAll("\u00a0", " ");
    expect(words({ from: "2026-08-01", to: "2026-08-25" })).toBe("с 1 по 25 августа");
    expect(words({ from: "2026-07-28", to: "2026-08-25" })).toBe("с 28 июля по 25 августа");
    expect(words({ from: "2026-08-25", to: "2026-08-25" })).toBe("25 августа");
    expect(periodWords(null)).toBe("");
  });
});
