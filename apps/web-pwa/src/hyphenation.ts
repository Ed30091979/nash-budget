/**
 * Мягкие переносы в имени, которое стоит в узкой плитке (ревью 2b, LOW-9; раунд 3, NEW-2, NEW-5).
 *
 * Плитка «Обзора» на телефоне даёт имени 49–70 pt, а слово «Транспорт» шире. Перенос по словарю
 * (`hyphens: auto`) есть не в каждом браузере: в Chromium без словаря русского языка слово рвалось
 * посередине без дефиса — «Трансп|орт». Поэтому места переноса ставит само приложение: мягкий
 * перенос (U+00AD) там, где слово можно перенести, и браузер рисует дефис, только если перенос
 * понадобился. Так набрано имя на каждой плитке: на «Обзоре», в выборе стороны листа ввода и на
 * плитках «откуда → куда».
 *
 * Правила — на каждое слово из букв кириллицы или латиницы:
 *
 * - по обе стороны переноса — не меньше двух букв, и в каждой части есть гласная;
 * - «й», «ь» и «ъ» не начинают строку — они остаются с буквой перед ними;
 * - согласная не отрывается от гласной после неё: «про-дук-ты», а не «прод-укты»;
 * - группу согласных можно делить где угодно: «тран-спорт» и «транс-порт» — оба верны, — кроме
 *   двух случаев: двойная согласная делится пополам («хоб-би», не «хо-бби»), и от корня после
 *   приставки не отрывается его начальная согласная («раз-вле-че-ния», не «разв-ле-че-ния»);
 * - приставка в начале слова не делится (`PREFIXES`): «Под-ра-бот-ка», а не «По-дра-бот-ка».
 *   Приставку правила узнают по буквам, а не по смыслу, и «Подарки» теряют верное «По-дар-ки», —
 *   осознанная цена: лишний запрет переноса ничего не портит, неверный перенос портит.
 *
 * Если и с этими правилами в слове остаётся кусок длиннее `LONGEST_UNBROKEN` букв без единого места
 * переноса — так бывает в слове с одной гласной, «Strengths», «Всплеск», — внутри него ставятся
 * запасные места: всё то же, только без требования гласной в каждой части. Не хватит и их — места
 * везде, где по краям слова остаётся по две буквы, строку не начинают «й», «ь», «ъ» и не делится
 * приставка (это правило не снимается никогда). Слово, которое не влезает в строку, обязано перенестись с дефисом, а не разорваться без
 * знака переноса; браузер берёт запасное место, только если слово иначе не влезает.
 *
 * Слова, числа и знаки других видов не трогаются.
 */

const SOFT_HYPHEN = "\u00ad";
const VOWELS = new Set([..."аеёиоуыэюяaeiouy"]);
const STAYS_WITH_PREVIOUS = new Set([..."йьъ"]);
const WORD = /[a-zа-яё]+/giu;

/**
 * Приставки, внутри которых перенос не ставится, когда слово с них начинается: без/бес, вз/вс,
 * воз/вос, из/ис, низ/нис, над, наи, об, обез/обес, от, пере, под, пред, пре, при, про, раз/рас,
 * роз/рос, меж. У «при», «про», «пре», «вз» и «вс» внутри нет места и по прочим правилам — они здесь
 * ради запасных мест. Ищется самая длинная: «обез» раньше «об», «пред» раньше «пре». Двубуквенные
 * на гласную («по», «за», «до», «вы») не нужны: внутри них места нет вовсе.
 */
export const PREFIXES: readonly string[] = [
  "без", "бес", "вз", "вс", "воз", "вос", "из", "ис", "низ", "нис", "над", "наи", "об", "обез", "обес", "от",
  "пере", "под", "пред", "пре", "при", "про", "раз", "рас", "роз", "рос", "меж",
].sort((left, right) => right.length - left.length);

/** Сколько букв подряд слово держит без места переноса, прежде чем в ход идут запасные места. */
export const LONGEST_UNBROKEN = 5;

const lower = (letter: string) => letter.toLowerCase();
const isVowel = (letter: string) => VOWELS.has(lower(letter));
const isConsonant = (letter: string) => !isVowel(letter) && !STAYS_WITH_PREVIOUS.has(lower(letter));

/** Чем слово ограничено по местам переноса, — один раз на слово. */
interface WordShape {
  readonly letters: readonly string[];
  /** Длина приставки, с которой начинается слово, — или 0: внутри неё переноса нет никогда. */
  readonly prefix: number;
  /** Конец начальных согласных корня за приставкой на согласную: внутри них — только последним средством. */
  readonly onsetEnd: number;
}

function shapeOf(word: string): WordShape {
  const letters = [...word];
  const text = letters.join("").toLowerCase();
  const prefix = PREFIXES.find((candidate) => text.startsWith(candidate) && letters.length > candidate.length)?.length ?? 0;
  // «Раз-вле-че-ния»: за приставкой на согласную начальные согласные корня — одно целое.
  let onsetEnd = prefix;
  if (prefix > 0 && isConsonant(letters[prefix - 1]!)) while (onsetEnd < letters.length && isConsonant(letters[onsetEnd]!)) onsetEnd += 1;
  return { letters, prefix, onsetEnd };
}

/** Последнее средство: по две буквы с краю, «й/ь/ъ» строку не начинают, приставка цела. */
function anyBreak({ letters, prefix }: WordShape, at: number): boolean {
  if (at < 2 || letters.length - at < 2 || at < prefix) return false;
  return !STAYS_WITH_PREVIOUS.has(lower(letters[at]!));
}

/** Запасное место: и корень за приставкой цел, и согласная не отрывается от гласной, и двойная согласная делится пополам. */
function spareBreak(shape: WordShape, at: number): boolean {
  if (!anyBreak(shape, at) || (at > shape.prefix && at < shape.onsetEnd)) return false;
  const { letters } = shape;
  const before = letters[at - 1]!;
  const first = letters[at]!;
  if (isConsonant(before) && isVowel(first)) return false;
  const next = letters[at + 1];
  return !(isConsonant(first) && next !== undefined && lower(next) === lower(first));
}

/** Место переноса по правилам: и гласная в каждой части. */
function syllableBreak(shape: WordShape, at: number): boolean {
  return spareBreak(shape, at) && shape.letters.slice(0, at).some(isVowel) && shape.letters.slice(at).some(isVowel);
}

/** Места переноса в слове — индексы букв, перед которыми он ставится. */
export function breakPoints(word: string): readonly number[] {
  const shape = shapeOf(word);
  const length = shape.letters.length;
  const points = new Set<number>();
  for (let at = 1; at < length; at += 1) if (syllableBreak(shape, at)) points.add(at);
  for (const fallback of [spareBreak, anyBreak]) {
    const edges = [0, ...[...points].sort((left, right) => left - right), length];
    for (let index = 1; index < edges.length; index += 1) {
      const from = edges[index - 1]!;
      const to = edges[index]!;
      if (to - from <= LONGEST_UNBROKEN) continue;
      for (let at = from + 1; at < to; at += 1) if (fallback(shape, at)) points.add(at);
    }
  }
  return [...points].sort((left, right) => left - right);
}

function hyphenateWord(word: string): string {
  const points = new Set(breakPoints(word));
  return [...word].map((letter, index) => (points.has(index) ? SOFT_HYPHEN + letter : letter)).join("");
}

/** Имя с мягкими переносами — только для глаза: в доступное имя, в буфер обмена и в данные оно не идёт. */
export function softHyphenate(text: string): string {
  return text.replace(WORD, hyphenateWord);
}
