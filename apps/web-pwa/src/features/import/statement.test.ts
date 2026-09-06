import { describe, expect, it } from "vitest";
import { encodeWindows1251, StatementParseError } from "./csv";
import { parseStatement, parseStatementAmount, parseStatementDate } from "./statement";
import { SAMPLE_EXPECTED, sampleStatementBytes, sampleStatementText } from "./test-fixture";

describe("выгрузка Т-Банка", () => {
  it("разбирает файл в windows-1251 с точкой с запятой и запятой в дробной части до копейки", () => {
    const parsed = parseStatement(sampleStatementBytes());

    expect(parsed.encoding).toBe("windows-1251");
    expect(parsed.delimiter).toBe(";");
    expect(parsed.format).toBe("tbank");
    expect(parsed.operations).toHaveLength(SAMPLE_EXPECTED.operations);
    // Сумма разобранного совпадает с суммой в файле до копейки — с обеих сторон.
    expect(parsed.totals).toEqual({ outMinor: SAMPLE_EXPECTED.outMinor, inMinor: SAMPLE_EXPECTED.inMinor });
    expect(parsed.period).toEqual(SAMPLE_EXPECTED.period);
    expect(parsed.skipped).toEqual({ failed: SAMPLE_EXPECTED.failed, foreignCurrency: 0, zeroAmount: SAMPLE_EXPECTED.zeroAmount, unreadable: 0 });

    const byLine = new Map(parsed.operations.map((operation) => [operation.line, operation]));
    // Кириллица прочитана, а не превращена в кракозябры; кавычки в названии сохранены.
    expect(byLine.get(2)).toMatchObject({ occurredOn: "2026-08-02", amountMinor: 123_456, direction: "out", description: "Пятёрочка", bankCategory: "Супермаркеты", mcc: "5411" });
    expect(byLine.get(6)?.description).toBe('ООО "Ромашка"');
    expect(byLine.get(14)?.description).toBe('Аптека "36,6"');
    // Перевод строки внутри поля не разорвал запись.
    expect(byLine.get(15)).toMatchObject({ amountMinor: 640_000, bankCategory: "ЖКХ", description: "Мосэнергосбыт Лицевой счёт 123" });
    // Покупка в валюте берётся по рублёвой сумме платежа.
    expect(byLine.get(10)).toMatchObject({ amountMinor: 235_000, direction: "out" });
    // Приход остаётся приходом.
    expect(byLine.get(1)).toMatchObject({ amountMinor: 12_000_000, direction: "in" });
    // Отменённая строка пропущена, а не записана.
    expect(byLine.has(9)).toBe(false);
  });

  it("читает тот же файл в UTF-8 с тем же результатом", () => {
    const utf8 = parseStatement(new TextEncoder().encode(sampleStatementText()));
    const cp1251 = parseStatement(sampleStatementBytes());
    expect(utf8.encoding).toBe("utf-8");
    expect(utf8.operations).toEqual(cp1251.operations);
  });

  it("пропускает операции в другой валюте без рублёвой суммы и считает их", () => {
    const text = '"Дата операции";"Статус";"Сумма операции";"Валюта операции";"Категория";"Описание"\n"01.08.2026 10:00:00";"OK";"-25,00";"USD";"Другое";"Apple"\n"02.08.2026 10:00:00";"OK";"-100,00";"RUB";"Другое";"Магазин"\n';
    const parsed = parseStatement(encodeWindows1251(text));
    expect(parsed.format).toBe("generic");
    expect(parsed.operations).toHaveLength(1);
    expect(parsed.skipped.foreignCurrency).toBe(1);
  });

  it("принимает выгрузку с общими именами столбцов и парой «Приход»/«Расход»", () => {
    const text = "Дата операции,Описание операции,Приход,Расход\n31.05.26,CARD2CARD,1500.00,0\n29.05.26,\"KUSCHAVEL, MOSCOW\",0,300\n";
    const parsed = parseStatement(new TextEncoder().encode(text));
    expect(parsed.delimiter).toBe(",");
    expect(parsed.operations.map((item) => [item.occurredOn, item.direction, item.amountMinor])).toEqual([
      ["2026-05-31", "in", 150_000],
      ["2026-05-29", "out", 30_000],
    ]);
  });

  it("отказывает файлу без даты или суммы и пустому файлу", () => {
    expect(() => parseStatement(new TextEncoder().encode("Описание;Категория\nа;б\n"))).toThrow(StatementParseError);
    expect(() => parseStatement(new TextEncoder().encode("Дата;Описание\n01.08.2026;а\n"))).toThrow(StatementParseError);
    expect(() => parseStatement(new TextEncoder().encode("Дата;Сумма\n"))).toThrow(StatementParseError);
  });

  it("разбирает дату «ДД.ММ.ГГГГ» со временем и без, а несуществующую отвергает", () => {
    expect(parseStatementDate("31.08.2026 14:03:11")).toBe("2026-08-31");
    expect(parseStatementDate("01.02.2026")).toBe("2026-02-01");
    expect(parseStatementDate("31.05.26")).toBe("2026-05-31");
    expect(parseStatementDate("2026-08-31T10:00:00")).toBe("2026-08-31");
    expect(parseStatementDate("31.02.2026")).toBeNull();
    expect(parseStatementDate("вчера")).toBeNull();
  });

  it("разбирает сумму с запятой, точкой, отбивкой разрядов и знаком, целочисленно", () => {
    expect(parseStatementAmount("-1 234,56")).toBe(-123_456);
    expect(parseStatementAmount("1234.5")).toBe(123_450);
    expect(parseStatementAmount("−3199,90")).toBe(-319_990);
    expect(parseStatementAmount("0,10")).toBe(10);
    expect(parseStatementAmount("0,00")).toBe(0);
    expect(parseStatementAmount("12,345")).toBe(1_235);
    expect(parseStatementAmount("")).toBeNull();
    expect(parseStatementAmount("много")).toBeNull();
  });
});
