import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { WRITE_REFUSAL_TEXT } from "../write-refusal";
import { ReadOnlyBanner } from "./ReadOnlyBanner";
import { WriteRefusalNotice } from "./WriteRefusalNotice";

describe("плашки записи", () => {
  it("«только чтение» — тревога со словами отказа и дверью в «Семью», без «закрыть»", () => {
    const html = renderToStaticMarkup(<ReadOnlyBanner title="Данные семьи не открываются" body={WRITE_REFUSAL_TEXT.held} onDetails={vi.fn()} />);
    expect(html).toContain('role="alert"');
    expect(html).toContain(WRITE_REFUSAL_TEXT.held);
    expect(html).toContain(">Подробнее</button>");
    expect(html).not.toMatch(/Закрыть|Понятно|Скрыть/u);
    // Состояние говорит словом и глифом, цвет — третьим.
    expect(html).toContain('href="#glyph-triangle-alert"');
  });

  it("неудача, которую экран не показал, — тревога «Не записано», которая гаснет только прочитанной", () => {
    const html = renderToStaticMarkup(<WriteRefusalNotice message={WRITE_REFUSAL_TEXT.notReady} onDismiss={vi.fn()} />);
    expect(html).toMatch(/<section class="key-alarm write-refusal-notice" role="alert" aria-labelledby="write-refusal-title">/u);
    expect(html).toContain('<h2 id="write-refusal-title">Не записано</h2>');
    expect(html).toContain(WRITE_REFUSAL_TEXT.notReady);
    expect(html).toContain(">Понятно</button>");
  });
});
