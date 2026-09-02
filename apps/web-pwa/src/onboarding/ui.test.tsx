/// <reference types="node" />
import { readFileSync } from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { Onboarding } from "./Onboarding";

describe("onboarding UI contract", () => {
  it("показывает короткий первый шаг с labels и явно отделённым демо", () => {
    const html = renderToStaticMarkup(<Onboarding onComplete={async () => undefined} onDemo={async () => undefined} />);
    expect(html).toContain("Шаг 1 из 4");
    expect(html).toContain("<label for=\"householdLabel\"");
    expect(html).toContain("<label for=\"accountLabel\"");
    expect(html.match(/type=\"radio\"/g)).toHaveLength(3);
    expect(html).toContain("Для себя");
    expect(html).toContain("Для пары");
    expect(html).toContain("Для семьи");
    expect(html).toContain("имена и личные данные не нужны");
    expect(html).toContain("Загрузить демонстрационный бюджет");
    expect(html).toContain("Это не ваши данные");
    expect(html).not.toContain("Доход в месяц");
  });

  it("фиксирует 44px touch targets и не использует URL, localStorage и logs в onboarding path", () => {
    const styles = readFileSync(new URL("../styles.css", import.meta.url), "utf8");
    const app = readFileSync(new URL("../App.tsx", import.meta.url), "utf8");
    const operations = readFileSync(new URL("../features/operations/OperationsScreen.tsx", import.meta.url), "utf8");
    const component = readFileSync(new URL("./Onboarding.tsx", import.meta.url), "utf8");
    const model = readFileSync(new URL("./model.ts", import.meta.url), "utf8");
    expect(styles).toMatch(/\.primary-button, \.secondary-button \{[^}]*min-height: 44px/s);
    expect(styles).toMatch(/\.text-button \{[^}]*min-height: 44px/s);
    expect(styles).toMatch(/\.composition-options label \{[^}]*min-height: 44px/s);
    expect(component).toContain('className="onboarding-fields" disabled={busy}');
    expect(component.match(/operationLock\.current\.run/g)).toHaveLength(2);
    expect(component).toContain('<div id="categories" tabIndex={-1}>');
    expect(component).toContain('id="composition" tabIndex={-1}');
    expect(component).not.toContain("браузе вымышленный");
    expect(`${component}\n${model}`).not.toContain("error.message");
    expect(component).not.toMatch(/catch\s*\([^)]/);
    expect(component).toContain('max={MAX_ONBOARDING_PERIOD_START}');
    expect(component.match(/maxLength=\{24\}/g)).toHaveLength(3);
    expect(model).toContain("repository.createIfAbsent(state)");
    expect(model).toContain("prepare(result.value)");
    expect(model).toContain("publish(value)");
    expect(model).not.toContain("repository.save(state)");
    expect(`${component}\n${model}`).not.toMatch(/localStorage|sessionStorage|console\.|URLSearchParams/);
    expect(app).not.toMatch(/stored\s*\?[^:]*:\s*makePlanningSeed/s);
    expect(app).toContain('setLoadState("empty")');
    expect(app.match(/makePlanningSeed\(\)/g)).toHaveLength(1);
    expect(app.match(/result\.status === "existing"/g)).toHaveLength(2);
    expect(operations).toContain('id="operation-amount" inputMode="decimal" maxLength={24}');
    expect(app).not.toMatch(/\sstyle\s*=/);
    expect(app).toContain('<progress className={`progress-track ${metric.status}`} max={100} value={progress}');
    expect(app).not.toContain("progress-value");
    expect(styles).toContain(".progress-track::-webkit-progress-value");
    expect(styles).toContain(".progress-track::-moz-progress-bar");
    expect(model).toContain('4: "Повседневные лимиты"');
  });

  it("даёт индикатору шагов вернуть назад и не пускает вперёд", () => {
    const html = renderToStaticMarkup(<Onboarding onComplete={async () => undefined} onDemo={async () => undefined} />);
    const component = readFileSync(new URL("./Onboarding.tsx", import.meta.url), "utf8");

    expect(html).toContain('<nav class="step-progress" aria-label="Шаги настройки">');
    expect(html.match(/class="step-progress-step /gu)).toHaveLength(4);
    expect(html).toContain('class="step-progress-step current"');
    expect(html.match(/class="step-progress-step upcoming"/gu)).toHaveLength(3);
    expect(html).not.toContain("step-progress-step done");
    // Первый шаг: возвращаться некуда, поэтому в индикаторе не нажимается ни одна кнопка.
    expect(html.match(/class="step-progress-step [a-z]+" type="button"[^>]*disabled=""/gu)).toHaveLength(4);
    expect(html).toContain('aria-current="step" aria-label="Шаг 1: План и счёт. Текущий шаг"');
    expect(html).toContain('aria-label="Шаг 4: Повседневные лимиты. Ещё не пройден"');
    expect(html).toContain('<span class="step-progress-number" aria-hidden="true">4</span>');
    // Нажимается только пройденный шаг, и уводит его туда та же модель, что запрещает шаг вперёд.
    expect(component).toContain('disabled={state !== "done" || busy}');
    expect(component).toContain("onClick={() => goToStep(value)}");
    expect(component).toContain("setNavigation((current) => returnToOnboardingStep(current, target));");
    expect(component).toContain("onClick={() => goToStep(moveOnboardingStep(step, \"back\"))}");
    expect(component).not.toMatch(/setStep\(/u);
  });

  it("называет шаг вместо команды и не показывает старую формулировку", () => {
    const html = renderToStaticMarkup(<Onboarding onComplete={async () => undefined} onDemo={async () => undefined} />);

    expect(html).toContain('<h1 id="onboarding-title" tabindex="-1">План и счёт</h1>');
    expect(html).not.toContain("Назовите план");
    expect(html).toContain("Шаг 1 из 4");
  });
});
