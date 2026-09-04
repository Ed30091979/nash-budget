/// <reference types="node" />
import { readFileSync } from "node:fs";

/**
 * Машиночитаемое чтение `DESIGN.md`.
 *
 * Норматив живёт в документе, а не в тестах. Пока числа стояли переписанными в утверждениях,
 * документ мог требовать 48, код держать 44, и все тесты оставались зелёными — ровно это и
 * случилось с целями нажатия. Поэтому проверки берут порог отсюда, а сюда он приходит из §9
 * `DESIGN.md`: поменяется документ — поменяется и то, что требует код.
 *
 * Модуль обслуживает проверки, приложение его не импортирует и в сборку он не попадает.
 */
const TOUCH_TARGET_RULE = /Цель нажатия — минимум (\d+)×\1 pt, между целями — (\d+) pt/u;

function designSection9(): RegExpExecArray {
  const document = readFileSync(new URL("../../../DESIGN.md", import.meta.url), "utf8");
  const declared = TOUCH_TARGET_RULE.exec(document);
  if (declared === null) throw new Error("DESIGN.md §9 больше не называет цель нажатия и зазор — норматив утерян.");
  return declared;
}

/** §9: «Цель нажатия — минимум 48×48 pt, между целями — 8 pt» — первое число. */
export function designTouchTargetMinimum(): number {
  return Number(designSection9()[1]);
}

/** Та же строка §9 — второе число: зазор между соседними целями. */
export function designTargetGap(): number {
  return Number(designSection9()[2]);
}

/**
 * Адресует ли селектор то, что нажимают или заполняют.
 *
 * Совпадение считается по целому имени, а не по подстроке: `.quick-label` — подпись плитки, а не
 * цель нажатия, хотя «label» в нём и есть.
 */
const TOUCH_TARGET_ELEMENTS = /(?:^|[\s>+~(])(?:button|select|input|textarea|summary|label)(?![\w-])/u;
const TOUCH_TARGET_CLASSES = /\.(?:file-button|nav-button|step-progress-step|row-open|remove-category|skip-link|danger-button|primary-button|secondary-button|quiet-button|text-button|envelope|list-row)(?![\w-])/u;
const TOUCH_TARGET_ATTRIBUTES = /\[(?:tabindex|role="button")/u;

export function addressesTouchTarget(selector: string): boolean {
  return TOUCH_TARGET_ELEMENTS.test(selector)
    || TOUCH_TARGET_CLASSES.test(selector)
    || TOUCH_TARGET_ATTRIBUTES.test(selector);
}
