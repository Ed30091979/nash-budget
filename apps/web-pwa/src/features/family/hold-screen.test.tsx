/**
 * Экран ожидания документа семьи — второе ревью, LOW-5 и MEDIUM-3: что на нём сказано и что с
 * него можно сделать.
 */
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { FamilyHoldScreen } from "./FamilyHoldScreen";
import { familyDocumentNotice } from "./model";

const noop = async () => undefined;

describe("экран ожидания документа семьи", () => {
  it("без задержки говорит, что бюджет семьи ещё не пришёл, и ведёт в «Семью»", () => {
    const markup = renderToStaticMarkup(
      <FamilyHoldScreen notice={familyDocumentNotice(null)} hasLocalBudget={false} onBackup={noop} onFamily={() => undefined} />,
    );
    expect(markup).toContain('role="alert"');
    expect(markup).toContain("Бюджет семьи ещё не пришёл");
    expect(markup).toContain("записи на этом устройстве недоступны");
    expect(markup).toContain("Открыть «Семью»");
    // Сохранять нечего — кнопки копии нет.
    expect(markup).not.toContain("Скачать копию прежнего бюджета");
  });

  it("под задержкой называет версию причиной и предлагает копию прежнего бюджета, если он есть", () => {
    const markup = renderToStaticMarkup(
      <FamilyHoldScreen
        notice={familyDocumentNotice({ reason: "rejected_by_app", document: "empty" })}
        hasLocalBudget
        onBackup={noop}
        onFamily={() => undefined}
      />,
    );
    expect(markup).toContain("Бюджет семьи не открывается в этой версии");
    expect(markup).toContain("Обновите приложение");
    expect(markup).toContain("бюджет семьи его заменит");
    expect(markup).toContain("Скачать копию прежнего бюджета");
  });
});
