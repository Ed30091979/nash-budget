import { softHyphenate } from "../hyphenation";

/**
 * Текст с местами переноса для глаз и без них для слуха.
 *
 * При крупном шрифте на узком экране слово шире строки, а перенос по словарю есть не в каждом
 * браузере (`hyphenation.ts`). Видимая копия несёт мягкие переносы и скрыта от читающих с экрана,
 * а они слышат копию без них: мягкий перенос в доступном имени — это шум (e2e `softHyphenedNames`).
 * Подходит заголовку, абзацу и подписи кнопки: их имя берётся из текста внутри.
 */
export function Hyphenated({ text }: { readonly text: string }) {
  return <><span className="hyphenated" aria-hidden="true">{softHyphenate(text)}</span><span className="sr-only">{text}</span></>;
}
