export const HUMAN_READABLE_CSV_NOTICE = "CSV is a human-readable export, not a full backup.";
export const MAX_CSV_BYTES = 5 * 1024 * 1024;
export const MAX_CSV_ROWS = 50_000;
export const MAX_CSV_COLUMNS = 100;
export const MAX_CSV_FIELD_LENGTH = 10_000;

const FORMULA_AFTER_BOUNDED_PREFIX = /^(?:[\t\r]|[\u0000-\u0020\u007f-\u009f\u061c\u200b-\u200f\u2028-\u202f\u2060-\u2069\ufeff]*[=+\-@])/u;

function encodeField(value: unknown): string {
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value)) throw new Error("CSV содержит небезопасное числовое значение.");
    return String(value);
  }
  let field = value === null || value === undefined ? "" : String(value);
  if (field.length > MAX_CSV_FIELD_LENGTH) throw new Error("Поле CSV превышает допустимую длину.");
  if (FORMULA_AFTER_BOUNDED_PREFIX.test(field)) field = `'${field}`;
  return /[",\r\n]/.test(field) ? `"${field.replaceAll('"', '""')}"` : field;
}

/** Excel-compatible UTF-8 RFC 4180 export. This is intentionally not a restore format. */
export function serializeHumanReadableCsv(
  headers: readonly string[],
  rows: readonly (readonly unknown[])[],
): string {
  if (headers.length === 0 || headers.length > MAX_CSV_COLUMNS) {
    throw new Error("CSV содержит недопустимое количество столбцов.");
  }
  if (rows.length > MAX_CSV_ROWS) throw new Error("CSV содержит слишком много строк.");
  const encoder = new TextEncoder();
  const header = headers.map(encodeField).join(",");
  let encodedBytes = encoder.encode(`\uFEFF${header}\r\n`).byteLength;
  if (encodedBytes > MAX_CSV_BYTES) throw new Error("CSV больше допустимых 5 МБ.");
  const encodedRows = [header];
  for (const row of rows) {
    if (row.length !== headers.length) throw new Error("Строка CSV не соответствует заголовку.");
    const encodedRow = row.map(encodeField).join(",");
    encodedBytes += encoder.encode(`${encodedRow}\r\n`).byteLength;
    if (encodedBytes > MAX_CSV_BYTES) throw new Error("CSV больше допустимых 5 МБ.");
    encodedRows.push(encodedRow);
  }
  const text = `\uFEFF${encodedRows.join("\r\n")}\r\n`;
  return text;
}
