import { softHyphenate } from "../hyphenation";

/**
 * Текст с местами переноса для глаз и без них для слуха.
 *
 * При крупном шрифте на узком экране слово шире строки, а перенос по словарю есть не в каждом
 * браузере (`hyphenation.ts`). Поэтому видимых копий две: обычная — пока строка в кеглях широкая,
 * и с мягкими переносами — ниже 18em (узкий экран или системный крупный шрифт, тот же порог, что в
 * §5). На обычном телефоне заголовок не рвётся «прихо-дит» там, где слово и так влезло бы целиком.
 * Обе копии скрыты от читающих с экрана, а они слышат текст без переносов: мягкий перенос в
 * доступном имени — это шум (e2e `softHyphenedNames`). Подходит заголовку, абзацу и подписи кнопки.
 */
export function Hyphenated({ text }: { readonly text: string }) {
  return (
    <>
      <span className="hyphenated" aria-hidden="true">
        <span className="hy-plain">{text}</span>
        <span className="hy-soft">{softHyphenate(text)}</span>
      </span>
      <span className="sr-only">{text}</span>
    </>
  );
}
