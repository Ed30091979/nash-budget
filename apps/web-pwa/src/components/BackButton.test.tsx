import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { BackButton } from "./BackButton";

function accessibleName(markup: string): string {
  return markup.replace(/<[^>]*>/gu, "").trim();
}

describe("кнопка возврата", () => {
  it("это кнопка, и её имя — текст, а не стрелка", () => {
    const markup = renderToStaticMarkup(<BackButton label="К горизонту" onClick={vi.fn()} />);

    expect(markup).toMatch(/^<button [^>]*type="button"/u);
    expect(accessibleName(markup)).toBe("К горизонту");
    expect(markup).not.toContain("←");
  });

  it("стрелка — украшение и скрыта от читающих с экрана", () => {
    const markup = renderToStaticMarkup(<BackButton label="К разделу «Ещё»" onClick={vi.fn()} />);

    expect(markup).toContain('href="#glyph-arrow-left"');
    expect(markup).toMatch(/<svg[^>]*aria-hidden="true"/u);
    expect(accessibleName(markup)).toBe("К разделу «Ещё»");
  });
});
