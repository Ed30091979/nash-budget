/// <reference types="node" />
import { readFileSync } from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { designTouchTargetMinimum } from "../design-contract";
import { FREE_PROMISE, INTRO_SLIDES, Onboarding } from "./Onboarding";
import { readAppSource } from "../app/shell-source";

const noop = async () => undefined;
const slide = (index: number) => renderToStaticMarkup(<Onboarding onComplete={noop} onDemo={noop} initialSlide={index} />);
const plain = (html: string) => html.replace(/<[^>]+>/gu, " ").replace(/\s+/gu, " ").trim();

describe("первый запуск: три слайда (дизайн v5, 01 → 02 → 02b)", () => {
  it("слайд 1: марка, «Пропустить», иллюстрация, «Шаг 1 из 3», заголовок с фокусом и «Дальше» — без полей и анкеты", () => {
    const html = slide(0);
    expect(html).toContain("Наш бюджет");
    expect(html).toContain(">Пропустить</button>");
    // Заголовок и абзац — дважды: с мягкими переносами для глаз и без них для слуха (`Hyphenated`).
    expect(html).toMatch(/<h1 id="intro-title-tap" tabindex="-1"><span class="hyphenated" aria-hidden="true"><span class="hy-plain">Записать трату\u00a0— два шага<\/span><span class="hy-soft">[^<]+<\/span><\/span><span class="sr-only">Записать трату\u00a0— два шага<\/span><\/h1>/u);
    expect(html).toContain('<span class="sr-only">Коснитесь категории и наберите сумму. Без форм и лишних полей.</span>');
    expect(html).toContain('role="img" aria-label="Шаг 1 из 3"');
    expect(html).toContain(">Дальше</button>");
    expect(html).not.toContain("Начать");
    expect(html).not.toContain("Посмотреть на примере");
    // §e п. 8: «Для себя / пары / семьи» и поля названия плана и счёта ушли.
    for (const gone of ["Для себя", "Для пары", "Для семьи", "Название плана", "основной счёт", "<input", "<form", "Шаг 1 из 4"]) {
      expect(html, gone).not.toContain(gone);
    }
  });

  it("слайд 2 — про «хватит ли до зарплаты», тоже с «Пропустить»", () => {
    const html = slide(1);
    expect(html).toContain('<span class="sr-only">Видно, хватит ли до\u00a0зарплаты</span></h1>');
    expect(html).toContain('<span class="sr-only">Приложение считает, сколько можно тратить каждый день до следующей выплаты.</span>');
    expect(html).toContain('aria-label="Шаг 2 из 3"');
    expect(html).toContain(">Пропустить</button>");
  });

  it("слайд 3: обещание одной строкой, «Начать» и тихая «Посмотреть на примере»; «Пропустить» здесь нет", () => {
    const html = slide(2);
    expect(html).toContain('<span class="sr-only">Начните без регистрации</span></h1>');
    expect(FREE_PROMISE).toBe("Бесплатно. Без подписок и рекламы. Данные только на\u00a0этом телефоне.");
    expect(html).toContain(`<span class="sr-only">${FREE_PROMISE}</span>`);
    expect(html).toMatch(/class="primary-button wide" type="button"[^>]*>Начать<\/button>/u);
    expect(html).toMatch(/class="quiet-button wide" type="button"[^>]*>Посмотреть на примере<\/button>/u);
    expect(html).not.toContain("Пропустить");
    expect(html).toContain('aria-label="Шаг 3 из 3"');
    // Бесплатность — один раз и только здесь: ни на первом, ни на втором слайде.
    expect(plain(slide(0))).not.toContain("Бесплатно");
    expect(plain(slide(1))).not.toContain("Бесплатно");
  });

  it("иллюстрации декоративны: aria-hidden, без внешних ресурсов и без текста внутри картинки", () => {
    for (const index of [0, 1, 2]) {
      const art = /<div class="intro-art">([\s\S]*?)<\/div>/u.exec(slide(index))?.[1] ?? "";
      expect(art).toMatch(/^<svg [^>]*aria-hidden="true"/u);
      expect(art).not.toMatch(/https?:|<image|<text|xlink|href=/u);
    }
    expect(INTRO_SLIDES).toHaveLength(3);
  });

  it("слайды — последовательность: фокус на заголовке каждого, стрелки и Esc, и ни одного URL или localStorage", () => {
    const component = readFileSync(new URL("./Onboarding.tsx", import.meta.url), "utf8");
    const model = readFileSync(new URL("./model.ts", import.meta.url), "utf8");
    expect(component).toContain("titleRef.current?.focus({ preventScroll: true });");
    expect(component).toContain("}, [index]);");
    expect(component).toMatch(/event\.key === "Escape" && !last[\s\S]{0,80}void start\(\)/u);
    expect(component).toContain('event.key === "ArrowRight"');
    expect(component).toContain('event.key === "ArrowLeft"');
    // «Пропустить» ведёт туда же, куда «Начать»: молча создаётся набор.
    expect(component.match(/onClick=\{\(\) => void start\(\)\}/gu)).toHaveLength(2);
    // Память первого запуска пишется до публикации бюджета: «Обзор» читает её в первом же кадре.
    expect(component.indexOf("firstRun.replace(beginFirstRun(day))")).toBeLessThan(component.indexOf("await onComplete(state)"));
    expect(component.match(/operationLock\.current\.run/gu)).toHaveLength(2);
    expect(`${component}\n${model}`).not.toMatch(/localStorage|sessionStorage|console\.|URLSearchParams|error\.message/u);
    // Ни одной пойманной ошибки с именем: её текст не попадает на экран (`.catch(() => …)` не связывает).
    expect(component).not.toMatch(/catch\s*\(\s*[A-Za-z_$]/u);
    expect(model).toContain("repository.createIfAbsent(state)");
    expect(model).toContain("prepare(result.value)");
    expect(model).toContain("publish(value)");
  });

  it("цели нажатия по нормативу, и демо подставляется только по кнопке", () => {
    const styles = readFileSync(new URL("../styles.css", import.meta.url), "utf8");
    const app = readAppSource();
    const minimum = designTouchTargetMinimum();
    for (const selector of [".primary-button, .secondary-button", ".quiet-button", ".intro-skip"]) {
      const declared = new RegExp(`${selector.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")} \\{[^}]*min-height: (\\d+)px`, "su").exec(styles);
      expect(declared, `${selector} должен объявлять цель нажатия`).not.toBeNull();
      expect(Number(declared?.[1]), selector).toBeGreaterThanOrEqual(minimum);
    }
    // Демо — только по кнопке и ровно в одном месте: пустое хранилище открывает слайды, а не пример.
    expect(app).not.toMatch(/stored\s*\?[^:]*:\s*buildDemoBudgetState/su);
    expect(app).toContain('setLoadState("empty")');
    expect(app.match(/buildDemoBudgetState\(\)/gu)).toHaveLength(1);
    expect(app.match(/result\.status === "existing"/gu)).toHaveLength(2);
    expect(app).not.toMatch(/\sstyle\s*=/u);
  });

  it("сторожа, жившие в прежнем тесте онбординга: поле суммы — настоящее поле, полоса лимита — атрибутом", () => {
    const styles = readFileSync(new URL("../styles.css", import.meta.url), "utf8");
    const operations = readFileSync(new URL("../features/entry/EntrySheet.tsx", import.meta.url), "utf8");
    const tile = readFileSync(new URL("../components/tiles/CategoryTile.tsx", import.meta.url), "utf8");
    // Поле суммы с клавиатурой на экране просит не поднимать системную, без неё зовёт десятичную.
    expect(operations).toContain('inputMode={keypad ? "none" : "decimal"}');
    expect(operations).toMatch(/id="entry-amount"[\s\S]{0,200}maxLength=\{24\}/u);
    expect(operations).not.toContain("readOnly");
    // Доля полосы приходит атрибутом (CSP запрещает инлайновые стили), имя плитки называет её словами.
    expect(tile).toContain('<span className={`tile-bar ${tile.status}`} data-fill={tile.fill} aria-hidden="true" />');
    expect(tile).toContain("label={categoryTileLabel(tile, currency)}");
    expect(styles).toMatch(/\.limit-bar \{[^}]*linear-gradient/su);
  });
});
