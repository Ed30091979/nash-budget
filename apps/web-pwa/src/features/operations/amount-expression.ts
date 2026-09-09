/**
 * Сумма как выражение: «1200+350», «3000÷2».
 *
 * Клавиатура суммы — калькулятор (§6): два чека одного похода складывают, счёт делят пополам, не
 * выходя из экрана. Знака «=» нет — равно́ здесь кнопка записи: она называет итог словами, а перед
 * записью выражение сворачивается в число (`settleAmount`). Считается слева направо, как на
 * простом калькуляторе: «1200+350÷2» — это половина от суммы двух чеков, а не чек плюс половина
 * второго. Итог округляется до копейки.
 *
 * Поле остаётся полем: с физической клавиатуры набирают `+ - / *` и точку, из буфера вставляют
 * «1 234,56» — всё это приводится к знакам клавиатуры и читается тем же разбором.
 */
export type KeypadKey = "0" | "1" | "2" | "3" | "4" | "5" | "6" | "7" | "8" | "9" | "," | "+" | "−" | "÷" | "backspace";

type Operator = "+" | "−" | "÷" | "×";

/** Тот же предел, что у поля: `maxLength={24}` ограничивает набор, а разбор — вставку. */
export const AMOUNT_MAX_LENGTH = 24;

export type AmountEvaluation =
  | { readonly kind: "empty" }
  /** `compound` — в выражении больше одного числа: тогда итог стоит показать отдельно. */
  | { readonly kind: "value"; readonly minor: number; readonly compound: boolean }
  | { readonly kind: "error"; readonly message: string };

export interface AmountSelection {
  readonly start: number;
  readonly end: number;
}

export interface AmountEdit {
  readonly text: string;
  /** Куда встаёт каретка после нажатия — если поле в фокусе. */
  readonly caret: number;
}

const OVERFLOW = "Сумма превышает максимально допустимое значение.";
const NOT_POSITIVE = "Сумма должна быть больше нуля.";
const MALFORMED = "Введите положительную сумму, не более двух знаков после запятой.";
const DIVISION_BY_ZERO = "На ноль делить нельзя.";
const MAX_SAFE_MINOR = BigInt(Number.MAX_SAFE_INTEGER);
const OPERATOR = /[+−÷×]/u;
const OPERATOR_AT_END = /[+−÷×]$/u;
const NUMBER_TOKEN = /^\d+(?:,\d*)?/u;

/** Знаки с физической клавиатуры и из буфера — к знакам клавиатуры суммы. */
export function normalizeAmountText(text: string): string {
  return text
    .replace(/\s/gu, "")
    .replace(/-/gu, "−")
    .replace(/\//gu, "÷")
    .replace(/\*/gu, "×")
    .replace(/\./gu, ",");
}

/** Деление с округлением до ближайшего целого, половина — от нуля. Делитель положительный. */
function roundedDivision(numerator: bigint, divisor: bigint): bigint {
  const quotient = numerator / divisor;
  const remainder = numerator % divisor;
  const magnitude = remainder < 0n ? -remainder : remainder;
  if (magnitude * 2n < divisor) return quotient;
  return numerator < 0n ? quotient - 1n : quotient + 1n;
}

interface Term {
  readonly operator: Operator | null;
  readonly minor: bigint;
}

type ParsedTerms = { readonly terms: readonly Term[] } | { readonly message: string };

function parseTerms(text: string): ParsedTerms {
  const terms: Term[] = [];
  let pending: Operator | null = null;
  let index = 0;
  while (index < text.length) {
    const token = NUMBER_TOKEN.exec(text.slice(index));
    if (token === null) return { message: MALFORMED };
    const [rubles = "0", kopecks = ""] = token[0].split(",");
    if (kopecks.length > 2) return { message: MALFORMED };
    terms.push({ operator: pending, minor: BigInt(rubles) * 100n + BigInt(kopecks.padEnd(2, "0") || "0") });
    pending = null;
    index += token[0].length;
    if (index === text.length) break;
    const sign = text[index] ?? "";
    if (!OPERATOR.test(sign)) return { message: MALFORMED };
    pending = sign as Operator;
    index += 1;
  }
  // Незавершённое «1200+» — это 1200: предпросмотр не гаснет, пока человек тянется к следующей цифре.
  return { terms };
}

export function evaluateAmount(rawText: string): AmountEvaluation {
  const text = normalizeAmountText(rawText);
  if (text === "") return { kind: "empty" };
  if (rawText.length > AMOUNT_MAX_LENGTH) return { kind: "error", message: OVERFLOW };
  const parsed = parseTerms(text);
  if ("message" in parsed) return { kind: "error", message: parsed.message };
  const [first, ...rest] = parsed.terms;
  if (first === undefined) return { kind: "error", message: MALFORMED };
  let total = first.minor;
  for (const term of rest) {
    switch (term.operator) {
      case "+": total += term.minor; break;
      case "−": total -= term.minor; break;
      case "×": total = roundedDivision(total * term.minor, 100n); break;
      case "÷":
        if (term.minor === 0n) return { kind: "error", message: DIVISION_BY_ZERO };
        total = roundedDivision(total * 100n, term.minor);
        break;
      case null: return { kind: "error", message: MALFORMED };
    }
  }
  if (total <= 0n) return { kind: "error", message: NOT_POSITIVE };
  if (total > MAX_SAFE_MINOR) return { kind: "error", message: OVERFLOW };
  return { kind: "value", minor: Number(total), compound: rest.length > 0 };
}

/** Число так, как его принимает поле: «1550» или «1550,50» — запятая, без отбивки разрядов (§7). */
export function amountText(minor: number): string {
  const rubles = Math.floor(minor / 100);
  const kopecks = minor % 100;
  return kopecks === 0 ? String(rubles) : `${rubles},${String(kopecks).padStart(2, "0")}`;
}

/** Выражение — в число перед записью. Что не разобралось, остаётся как есть: ошибку назовёт домен. */
export function settleAmount(text: string): string {
  const result = evaluateAmount(text);
  return result.kind === "value" ? amountText(result.minor) : text;
}

/**
 * Нажатие клавиши клавиатуры суммы.
 *
 * С выделением в поле — правка на месте каретки, как у обычной клавиатуры; без него — в конце.
 * Третьей копейки нет, второй запятой в одном числе нет, знак после знака заменяет его, знак
 * после незакрытой запятой её снимает: клавиатура не даёт набрать то, чего разбор не примет.
 */
export function editAmount(text: string, key: KeypadKey, selection: AmountSelection | null): AmountEdit {
  const start = selection ? Math.min(selection.start, selection.end) : text.length;
  const end = selection ? Math.max(selection.start, selection.end) : text.length;
  const before = text.slice(0, start);
  const after = text.slice(end);
  const unchanged = { text, caret: end };

  if (key === "backspace") {
    if (start !== end) return { text: before + after, caret: start };
    if (before.length === 0) return unchanged;
    return { text: before.slice(0, -1) + after, caret: start - 1 };
  }

  const operand = before.split(OPERATOR).pop() ?? "";
  let head = before;
  let insert: string;
  if (key === ",") {
    if (operand.includes(",")) return unchanged;
    insert = operand === "" ? "0," : ",";
  } else if (key === "+" || key === "−" || key === "÷") {
    if (before === "") return unchanged;
    if (OPERATOR_AT_END.test(before) || before.endsWith(",")) head = before.slice(0, -1);
    insert = key;
  } else {
    if (/,\d{2}$/u.test(operand)) return unchanged;
    insert = key;
  }
  const next = head + insert + after;
  if (next.length > AMOUNT_MAX_LENGTH) return unchanged;
  return { text: next, caret: head.length + insert.length };
}
