import {
  decodeStatementBytes,
  detectDelimiter,
  parseCsvRecords,
  StatementParseError,
  type CsvDelimiter,
  type StatementEncoding,
} from "./csv";

/**
 * Выгрузка операций Т-Банка: пятнадцать столбцов, точка с запятой, `windows-1251`, дата
 * «ДД.ММ.ГГГГ ЧЧ:ММ:СС», дробная часть через запятую, расход со знаком минус, статус `OK` или
 * `FAILED`, собственная категория банка отдельным столбцом.
 *
 * Столбцы читаются по заголовку, а не по позиции: банк вправе переставить или добавить столбец,
 * и тогда ломаться должно не чтение, а только то, чего действительно нет. Тот же путь принимает
 * выгрузку с общими именами («Дата», «Сумма», «Описание») и с парой «Приход»/«Расход» — это не
 * поддержка других банков, а отказ ломаться на очевидном.
 */
export type StatementDirection = "in" | "out";
export type StatementFormat = "tbank" | "generic";

export interface StatementOperation {
  /** Номер строки данных в файле, с единицы: по нему человек найдёт строку в своей выгрузке. */
  readonly line: number;
  readonly occurredOn: string;
  /** Всегда положительная; направление — отдельным полем. */
  readonly amountMinor: number;
  readonly direction: StatementDirection;
  readonly description: string;
  /** Категория, которую поставил банк; пусто, если столбца нет. */
  readonly bankCategory: string;
  readonly mcc: string;
}

export interface StatementSkips {
  /** Отменённые и неуспешные — банк их показывает, но денег они не двигали. */
  readonly failed: number;
  readonly foreignCurrency: number;
  readonly zeroAmount: number;
  /** Строки, в которых не прочлась дата или сумма. */
  readonly unreadable: number;
}

export interface StatementTotals {
  readonly outMinor: number;
  readonly inMinor: number;
}

export interface ParsedStatement {
  readonly encoding: StatementEncoding;
  readonly delimiter: CsvDelimiter;
  readonly format: StatementFormat;
  readonly operations: readonly StatementOperation[];
  readonly skipped: StatementSkips;
  readonly totals: StatementTotals;
  readonly period: { readonly from: string; readonly to: string } | null;
}

/** Ключ заголовка: регистр, «ё», кавычки, метка порядка байтов и лишние пробелы не в счёт. */
export function headerKey(value: string): string {
  return value
    .replace(/﻿/gu, "")
    .replace(/["«»]/gu, "")
    .normalize("NFKC")
    .toLocaleLowerCase("ru-RU")
    .replace(/ё/gu, "е")
    .replace(/\s+/gu, " ")
    .trim();
}

interface ColumnMap {
  readonly date: number;
  readonly amount: number | null;
  readonly currency: number | null;
  readonly incoming: number | null;
  readonly outgoing: number | null;
  readonly description: number | null;
  readonly category: number | null;
  readonly status: number | null;
  readonly mcc: number | null;
}

const DATE_HEADERS = ["дата операции", "дата платежа", "дата проводки", "дата"];
const AMOUNT_HEADERS = ["сумма платежа", "сумма операции", "сумма операции с округлением", "сумма"];
const CURRENCY_HEADERS: Readonly<Record<string, string>> = {
  "сумма платежа": "валюта платежа",
  "сумма операции": "валюта операции",
  "сумма операции с округлением": "валюта операции",
  "сумма": "валюта",
};
const INCOMING_HEADERS = ["приход", "зачисление", "кредит"];
const OUTGOING_HEADERS = ["расход", "списание", "дебет"];
const DESCRIPTION_HEADERS = ["описание", "описание операции", "назначение платежа", "назначение", "контрагент", "получатель"];
const CATEGORY_HEADERS = ["категория", "категория операции"];
const STATUS_HEADERS = ["статус", "статус операции"];
const MCC_HEADERS = ["mcc", "mcc-код", "код mcc"];

function findColumn(keys: readonly string[], candidates: readonly string[]): number | null {
  for (const candidate of candidates) {
    const index = keys.indexOf(candidate);
    if (index >= 0) return index;
  }
  return null;
}

function mapColumns(header: readonly string[]): { readonly columns: ColumnMap; readonly format: StatementFormat } {
  const keys = header.map(headerKey);
  const date = findColumn(keys, DATE_HEADERS);
  if (date === null) {
    throw new StatementParseError("В файле нет столбца с датой операции. Нужна выгрузка операций в CSV, например из Т-Банка.");
  }
  const amount = findColumn(keys, AMOUNT_HEADERS);
  const incoming = findColumn(keys, INCOMING_HEADERS);
  const outgoing = findColumn(keys, OUTGOING_HEADERS);
  if (amount === null && (incoming === null || outgoing === null)) {
    throw new StatementParseError("В файле нет столбца с суммой операции. Нужна выгрузка операций в CSV, например из Т-Банка.");
  }
  const amountKey = amount === null ? null : keys[amount] ?? null;
  const currency = amountKey === null ? null : findColumn(keys, [CURRENCY_HEADERS[amountKey] ?? "валюта"]);
  const columns: ColumnMap = {
    date,
    amount,
    currency,
    incoming,
    outgoing,
    description: findColumn(keys, DESCRIPTION_HEADERS),
    category: findColumn(keys, CATEGORY_HEADERS),
    status: findColumn(keys, STATUS_HEADERS),
    mcc: findColumn(keys, MCC_HEADERS),
  };
  const format: StatementFormat =
    keys.includes("дата операции") && keys.includes("сумма платежа") && keys.includes("категория") ? "tbank" : "generic";
  return { columns, format };
}

const DATE_DMY = /^(\d{1,2})\.(\d{1,2})\.(\d{2}|\d{4})(?:[ T].*)?$/u;
const DATE_ISO = /^(\d{4})-(\d{2})-(\d{2})(?:[ T].*)?$/u;

/** «31.08.2026 14:03:11», «31.08.26» и «2026-08-31» → «2026-08-31»; несуществующая дата — `null`. */
export function parseStatementDate(raw: string): string | null {
  const value = raw.trim();
  let year: number;
  let month: number;
  let day: number;
  const dmy = DATE_DMY.exec(value);
  const iso = dmy === null ? DATE_ISO.exec(value) : null;
  if (dmy !== null) {
    day = Number(dmy[1]);
    month = Number(dmy[2]);
    year = dmy[3]!.length === 2 ? 2000 + Number(dmy[3]) : Number(dmy[3]);
  } else if (iso !== null) {
    year = Number(iso[1]);
    month = Number(iso[2]);
    day = Number(iso[3]);
  } else {
    return null;
  }
  if (year < 1990 || year > 9999) return null;
  const candidate = `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
  const parsed = new Date(`${candidate}T00:00:00.000Z`);
  return Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== candidate ? null : candidate;
}

/** Без флага `g`: у глобального выражения `test` помнит позицию и через раз лжёт о знаке. */
const MINUS_SIGNS = /^[−–—-]/u;

/**
 * «-1 234,56» → −123456 копеек. Разряды могут быть отбиты пробелом, дробная часть — запятой или
 * точкой; арифметика целочисленная, чтобы 0,1 + 0,2 не превратились в 0,30000000000000004.
 */
export function parseStatementAmount(raw: string): number | null {
  const compact = raw.replace(/[\s  ]/gu, "").replace(/₽|руб\.?|rub/giu, "");
  if (compact.length === 0) return null;
  const negative = MINUS_SIGNS.test(compact);
  const unsigned = compact.replace(/^[+−–—-]/u, "").replace(",", ".");
  if (!/^\d+(?:\.\d+)?$/u.test(unsigned)) return null;
  const [rublesPart, fractionPart = ""] = unsigned.split(".");
  const rounded = fractionPart.length > 2 && Number(fractionPart.charAt(2)) >= 5 ? 1 : 0;
  const kopecks = Number(fractionPart.slice(0, 2).padEnd(2, "0")) + rounded;
  const minor = Number(rublesPart) * 100 + kopecks;
  if (!Number.isSafeInteger(minor)) return null;
  return negative ? -minor : minor;
}

function isRubles(currency: string): boolean {
  const key = headerKey(currency);
  return key === "" || key === "rub" || key === "rur" || key === "руб" || key === "₽" || key === "643";
}

function isFailedStatus(status: string): boolean {
  const key = headerKey(status);
  return key === "failed" || key === "cancelled" || key === "canceled" || key.startsWith("отмен") || key.startsWith("отклон") || key === "неуспешно";
}

/**
 * Разбирает файл выгрузки целиком: кодировку, разделитель, заголовок и строки. Каждая строка либо
 * становится операцией, либо считается в пропущенных — с причиной, которую экран назовёт.
 * Сам файл после этого больше никому не нужен: дальше живут только операции.
 */
export function parseStatement(bytes: Uint8Array): ParsedStatement {
  const decoded = decodeStatementBytes(bytes);
  const delimiter = detectDelimiter(decoded.text);
  const records = parseCsvRecords(decoded.text, delimiter);
  const header = records[0];
  if (header === undefined || records.length < 2) {
    throw new StatementParseError("Файл пуст: в нём нет ни одной операции.");
  }
  const { columns, format } = mapColumns(header);

  const operations: StatementOperation[] = [];
  const skipped = { failed: 0, foreignCurrency: 0, zeroAmount: 0, unreadable: 0 };
  let outMinor = 0;
  let inMinor = 0;
  let from: string | null = null;
  let to: string | null = null;
  const cell = (record: readonly string[], index: number | null): string => (index === null ? "" : (record[index] ?? "").trim());

  for (let line = 1; line < records.length; line += 1) {
    const record = records[line]!;
    if (columns.status !== null && isFailedStatus(cell(record, columns.status))) {
      skipped.failed += 1;
      continue;
    }
    const occurredOn = parseStatementDate(cell(record, columns.date));
    if (occurredOn === null) {
      skipped.unreadable += 1;
      continue;
    }
    let signedMinor: number | null;
    if (columns.amount !== null) {
      if (!isRubles(cell(record, columns.currency))) {
        skipped.foreignCurrency += 1;
        continue;
      }
      signedMinor = parseStatementAmount(cell(record, columns.amount));
    } else {
      const incoming = parseStatementAmount(cell(record, columns.incoming)) ?? 0;
      const outgoing = parseStatementAmount(cell(record, columns.outgoing)) ?? 0;
      signedMinor = incoming !== 0 ? Math.abs(incoming) : -Math.abs(outgoing);
    }
    if (signedMinor === null) {
      skipped.unreadable += 1;
      continue;
    }
    if (signedMinor === 0) {
      skipped.zeroAmount += 1;
      continue;
    }
    const direction: StatementDirection = signedMinor < 0 ? "out" : "in";
    const amountMinor = Math.abs(signedMinor);
    if (direction === "out") outMinor += amountMinor;
    else inMinor += amountMinor;
    if (!Number.isSafeInteger(outMinor) || !Number.isSafeInteger(inMinor)) {
      throw new StatementParseError("Суммы в файле слишком велики для бюджета.");
    }
    if (from === null || occurredOn < from) from = occurredOn;
    if (to === null || occurredOn > to) to = occurredOn;
    operations.push({
      line,
      occurredOn,
      amountMinor,
      direction,
      description: cell(record, columns.description).replace(/\s+/gu, " "),
      bankCategory: cell(record, columns.category),
      mcc: cell(record, columns.mcc),
    });
  }

  return {
    encoding: decoded.encoding,
    delimiter,
    format,
    operations,
    skipped,
    totals: { outMinor, inMinor },
    period: from === null || to === null ? null : { from, to },
  };
}
