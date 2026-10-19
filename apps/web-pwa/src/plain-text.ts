/**
 * Мягкий перенос (U+00AD) — только для глаза (ревью 2b, раунд 3, NEW-3).
 *
 * Имена плиток набраны с мягкими переносами (`hyphenation.ts`), чтобы слово переносилось с дефисом.
 * Из приложения они не уходят: в буфере обмена «Тра\u00adн\u00adс\u00adпорт» — это не «Транспорт» для
 * поиска, а вставленный в комментарий — отказ домена «Уберите из комментария скрытые или служебные
 * символы»: правило ввода (`packages/domain/src/text.ts`) не пускает Default_Ignorable, и так и
 * должно остаться. Поэтому снимает их интерфейс, и только их:
 *
 * - копирование из приложения (`installPlainCopy`): выделенный текст уходит в буфер без U+00AD, а
 *   выделять текст по-прежнему можно;
 * - поля имён и комментария (`plainInputValue`): мягкими переносами полны и чужие страницы
 *   (`&shy;`), и вставка оттуда не должна упираться в отказ.
 *
 * Ни один другой символ не трогается: остальное — дело правила домена и его слов.
 */

const SOFT_HYPHEN = "\u00ad";
const SOFT_HYPHENS = /\u00ad/gu;

/** Текст без мягких переносов — и без единого другого изменения. */
export function withoutSoftHyphens(text: string): string {
  return text.includes(SOFT_HYPHEN) ? text.replace(SOFT_HYPHENS, "") : text;
}

/** То, что нужно от поля ввода: значение и каретка. */
export interface PlainInputTarget {
  value: string;
  readonly selectionStart: number | null;
  setSelectionRange(start: number, end: number): void;
}

/**
 * Значение поля после ввода или вставки — без U+00AD. Если мягкие переносы были, поле получает
 * чистое значение сразу, и каретка остаётся за тем же символом, за которым стояла: контролируемое
 * поле React потом не переставит её в конец.
 */
export function plainInputValue(input: PlainInputTarget): string {
  const value = input.value;
  if (!value.includes(SOFT_HYPHEN)) return value;
  const clean = withoutSoftHyphens(value);
  const caret = input.selectionStart;
  input.value = clean;
  if (caret !== null) {
    const at = withoutSoftHyphens(value.slice(0, caret)).length;
    input.setSelectionRange(at, at);
  }
  return clean;
}

/** То, что нужно от события копирования. */
export interface CopyEventLike {
  readonly target: unknown;
  readonly clipboardData: { setData(format: string, data: string): void } | null;
  preventDefault(): void;
}

interface SelectableField {
  readonly value: string;
  readonly selectionStart: number | null;
  readonly selectionEnd: number | null;
}

function isSelectableField(target: unknown): target is SelectableField {
  return typeof target === "object" && target !== null && "value" in target && "selectionStart" in target && "selectionEnd" in target
    && typeof (target as SelectableField).value === "string";
}

/** Что копируется: выделенное в поле ввода или выделение документа. */
function copiedText(event: CopyEventLike, selection: () => string): string {
  const target = event.target;
  if (isSelectableField(target) && target.selectionStart !== null && target.selectionEnd !== null && target.selectionStart !== target.selectionEnd) {
    return target.value.slice(target.selectionStart, target.selectionEnd);
  }
  return selection();
}

/**
 * Копирование без мягких переносов. Если в выделенном их нет, копирование идёт как всегда, с
 * оформлением; если есть — в буфер уходит тот же текст без U+00AD, простым текстом.
 */
export function handlePlainCopy(event: CopyEventLike, selection: () => string): void {
  const text = copiedText(event, selection);
  if (!text.includes(SOFT_HYPHEN) || event.clipboardData === null) return;
  event.clipboardData.setData("text/plain", withoutSoftHyphens(text));
  event.preventDefault();
}

/** Ставит копирование без мягких переносов на весь документ; возвращает, как его снять. */
export function installPlainCopy(target: Document): () => void {
  const onCopy = (event: ClipboardEvent) => handlePlainCopy(event, () => target.getSelection()?.toString() ?? "");
  target.addEventListener("copy", onCopy);
  return () => target.removeEventListener("copy", onCopy);
}
