/**
 * Мягкие переносы в имени, которое стоит в узкой плитке (ревью 2b, LOW-9).
 *
 * Плитка «Обзора» на телефоне даёт имени 49–70 pt, а слово «Транспорт» шире. Перенос по словарю
 * (`hyphens: auto`) есть не в каждом браузере: в Chromium без словаря русского языка слово рвалось
 * посередине без дефиса — «Трансп|орт». Поэтому места переноса ставит само приложение: мягкий
 * перенос (U+00AD) там, где слово можно перенести по школьным правилам, и браузер рисует дефис,
 * только если перенос понадобился.
 *
 * Правила — на каждое слово из букв, кириллицы или латиницы:
 *
 * - по обе стороны переноса — не меньше двух букв, и в каждой части есть гласная;
 * - «й», «ь» и «ъ» не начинают строку — они остаются с буквой перед ними;
 * - согласная не отрывается от гласной после неё: «про-дук-ты», а не «прод-укты»;
 * - группу согласных можно делить где угодно: «тран-спорт» и «транс-порт» — оба верны.
 *
 * Слова без гласных («ЖКХ»), числа и знаки не трогаются.
 */

const SOFT_HYPHEN = "\u00ad";
const VOWELS = new Set([..."аеёиоуыэюяaeiouy"]);
const STAYS_WITH_PREVIOUS = new Set([..."йьъ"]);
const WORD = /[a-zа-яё]+/giu;

const isVowel = (letter: string) => VOWELS.has(letter.toLowerCase());
const isConsonant = (letter: string) => !isVowel(letter) && !STAYS_WITH_PREVIOUS.has(letter.toLowerCase());

function breakable(word: string, at: number): boolean {
  const letters = [...word];
  if (at < 2 || letters.length - at < 2) return false;
  const left = letters.slice(0, at);
  const right = letters.slice(at);
  if (!left.some(isVowel) || !right.some(isVowel)) return false;
  const first = right[0]!;
  if (STAYS_WITH_PREVIOUS.has(first.toLowerCase())) return false;
  return !(isConsonant(left[left.length - 1]!) && isVowel(first));
}

function hyphenateWord(word: string): string {
  const letters = [...word];
  let out = "";
  for (let index = 0; index < letters.length; index += 1) {
    if (breakable(word, index)) out += SOFT_HYPHEN;
    out += letters[index];
  }
  return out;
}

/** Имя с мягкими переносами — только для глаза: в доступное имя и в данные оно не идёт. */
export function softHyphenate(text: string): string {
  return text.replace(WORD, hyphenateWord);
}
