/**
 * Чтение банковской выгрузки: байты → текст → таблица.
 *
 * Кодировка и разделитель определяются по содержимому, а не по расширению: русские банки отдают
 * `windows-1251` с точкой с запятой, и файл, прочитанный как UTF-8, даёт кракозябры вместо
 * названий магазинов — словарь продавцов не находит в них ничего. Внешних библиотек нет
 * (политика безопасности и скан релиза их не пропустят), поэтому и таблица кодировки, и разбор
 * CSV написаны здесь; кавычки, удвоенные кавычки и переводы строк внутри поля обязаны работать.
 */

export type StatementEncoding = "utf-8" | "utf-16le" | "utf-16be" | "windows-1251";
export type CsvDelimiter = ";" | "," | "\t";

/** Отказ разбора, который человек будет читать. Ничего из содержимого файла в нём нет. */
export class StatementParseError extends Error {
  readonly userMessage: string;

  constructor(userMessage: string) {
    super("Statement parsing failed.");
    this.name = "StatementParseError";
    this.userMessage = userMessage;
  }
}

export const MAX_STATEMENT_BYTES = 5 * 1024 * 1024;
export const MAX_STATEMENT_ROWS = 50_000;
export const MAX_STATEMENT_COLUMNS = 100;
export const MAX_STATEMENT_FIELD_LENGTH = 10_000;

/**
 * Верхняя половина `windows-1251` по таблице WHATWG Encoding Standard: `0x80…0xBF` — знаки
 * пунктуации и буквы соседних кириллиц, `0xC0…0xFF` — сплошной ряд от «А» до «я».
 * Собственная таблица, а не только `TextDecoder`: у платформы без полного ICU декодера может
 * не быть, а выписка обязана читаться везде, где работает приложение. Тест сверяет таблицу с
 * `TextDecoder` побайтно там, где он есть.
 */
const WINDOWS_1251_HIGH: readonly number[] = [
  0x0402, 0x0403, 0x201a, 0x0453, 0x201e, 0x2026, 0x2020, 0x2021, 0x20ac, 0x2030, 0x0409, 0x2039, 0x040a, 0x040c, 0x040b, 0x040f,
  0x0452, 0x2018, 0x2019, 0x201c, 0x201d, 0x2022, 0x2013, 0x2014, 0x0098, 0x2122, 0x0459, 0x203a, 0x045a, 0x045c, 0x045b, 0x045f,
  0x00a0, 0x040e, 0x045e, 0x0408, 0x00a4, 0x0490, 0x00a6, 0x00a7, 0x0401, 0x00a9, 0x0404, 0x00ab, 0x00ac, 0x00ad, 0x00ae, 0x0407,
  0x00b0, 0x00b1, 0x0406, 0x0456, 0x0491, 0x00b5, 0x00b6, 0x00b7, 0x0451, 0x2116, 0x0454, 0x00bb, 0x0458, 0x0405, 0x0455, 0x0457,
];

export function decodeWindows1251(bytes: Uint8Array): string {
  const chunks: string[] = [];
  let piece: number[] = [];
  for (let index = 0; index < bytes.length; index += 1) {
    const byte = bytes[index]!;
    let code: number;
    if (byte < 0x80) code = byte;
    else if (byte < 0xc0) code = WINDOWS_1251_HIGH[byte - 0x80]!;
    else code = 0x0410 + (byte - 0xc0);
    piece.push(code);
    if (piece.length >= 4096) {
      chunks.push(String.fromCharCode(...piece));
      piece = [];
    }
  }
  if (piece.length > 0) chunks.push(String.fromCharCode(...piece));
  return chunks.join("");
}

/** Обратная таблица — только для проверок и образцов; приложению кодировать нечего. */
export function encodeWindows1251(text: string): Uint8Array {
  const reverse = new Map<number, number>();
  WINDOWS_1251_HIGH.forEach((code, index) => reverse.set(code, 0x80 + index));
  const bytes = new Uint8Array(text.length);
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    if (code < 0x80) bytes[index] = code;
    else if (code >= 0x0410 && code <= 0x044f) bytes[index] = 0xc0 + (code - 0x0410);
    else {
      const mapped = reverse.get(code);
      if (mapped === undefined) throw new Error(`Символ U+${code.toString(16)} не представим в windows-1251.`);
      bytes[index] = mapped;
    }
  }
  return bytes;
}

function tryDecode(label: string, bytes: Uint8Array): string | null {
  try {
    return new TextDecoder(label, { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
}

export interface DecodedStatement {
  readonly text: string;
  readonly encoding: StatementEncoding;
}

/**
 * Кодировка — по содержимому. Метка порядка байтов решает сразу; без неё файл сначала читается
 * как строгий UTF-8, и только отказ декодера делает его `windows-1251`. Отказ здесь надёжен:
 * кириллица в `windows-1251` лежит в `0xC0…0xFF`, а продолжение UTF-8-последовательности
 * обязано лежать в `0x80…0xBF`, поэтому две русские буквы подряд никогда не пройдут за UTF-8.
 */
export function decodeStatementBytes(bytes: Uint8Array): DecodedStatement {
  if (bytes.length > MAX_STATEMENT_BYTES) {
    throw new StatementParseError("Файл больше 5 МБ. Выгрузите период покороче.");
  }
  if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    const text = tryDecode("utf-8", bytes.subarray(3));
    if (text !== null) return { text, encoding: "utf-8" };
  }
  if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) {
    const text = tryDecode("utf-16le", bytes.subarray(2));
    if (text !== null) return { text, encoding: "utf-16le" };
  }
  if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) {
    const text = tryDecode("utf-16be", bytes.subarray(2));
    if (text !== null) return { text, encoding: "utf-16be" };
  }
  const utf8 = tryDecode("utf-8", bytes);
  if (utf8 !== null) return { text: utf8, encoding: "utf-8" };
  return { text: decodeWindows1251(bytes), encoding: "windows-1251" };
}

function firstLine(text: string): string {
  let inQuotes = false;
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index]!;
    if (character === '"') inQuotes = !inQuotes;
    else if (!inQuotes && (character === "\n" || character === "\r")) return text.slice(0, index);
  }
  return text;
}

/**
 * Разделитель — тот, которого в заголовке больше, вне кавычек. При равенстве побеждает точка
 * с запятой: у русских выгрузок запятая уже занята дробной частью суммы.
 */
export function detectDelimiter(text: string): CsvDelimiter {
  const header = firstLine(text);
  const counts: Record<CsvDelimiter, number> = { ";": 0, ",": 0, "\t": 0 };
  let inQuotes = false;
  for (const character of header) {
    if (character === '"') inQuotes = !inQuotes;
    else if (!inQuotes && (character === ";" || character === "," || character === "\t")) counts[character] += 1;
  }
  const order: readonly CsvDelimiter[] = [";", "\t", ","];
  let best: CsvDelimiter = ";";
  for (const candidate of order) {
    if (counts[candidate] > counts[best]) best = candidate;
  }
  return best;
}

/**
 * Разбор по RFC 4180: поле в кавычках может содержать разделитель, перевод строки и удвоенную
 * кавычку; концы строк — `\r\n`, `\n` или `\r`; пустые строки пропускаются.
 */
export function parseCsvRecords(text: string, delimiter: CsvDelimiter): string[][] {
  const records: string[][] = [];
  let record: string[] = [];
  let field = "";
  let inQuotes = false;
  let index = 0;
  const source = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;

  const pushField = (): void => {
    if (field.length > MAX_STATEMENT_FIELD_LENGTH) {
      throw new StatementParseError("В файле есть слишком длинное поле — это не похоже на выписку.");
    }
    record.push(field);
    field = "";
  };
  const pushRecord = (): void => {
    pushField();
    if (record.length > MAX_STATEMENT_COLUMNS) {
      throw new StatementParseError("В файле слишком много столбцов — это не похоже на выписку.");
    }
    if (!(record.length === 1 && record[0] === "")) {
      records.push(record);
      if (records.length > MAX_STATEMENT_ROWS + 1) {
        throw new StatementParseError("В файле больше 50 000 строк. Выгрузите период покороче.");
      }
    }
    record = [];
  };

  while (index < source.length) {
    const character = source[index]!;
    if (inQuotes) {
      if (character === '"') {
        if (source[index + 1] === '"') {
          field += '"';
          index += 2;
          continue;
        }
        inQuotes = false;
        index += 1;
        continue;
      }
      field += character;
      index += 1;
      continue;
    }
    if (character === '"') {
      inQuotes = true;
      index += 1;
      continue;
    }
    if (character === delimiter) {
      pushField();
      index += 1;
      continue;
    }
    if (character === "\r" || character === "\n") {
      pushRecord();
      index += character === "\r" && source[index + 1] === "\n" ? 2 : 1;
      continue;
    }
    field += character;
    index += 1;
  }
  if (inQuotes) throw new StatementParseError("В файле не закрыта кавычка — он повреждён или обрезан.");
  if (field.length > 0 || record.length > 0) pushRecord();
  return records;
}
