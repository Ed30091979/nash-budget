import { describe, expect, it } from "vitest";
import {
  decodeStatementBytes,
  decodeWindows1251,
  detectDelimiter,
  encodeWindows1251,
  parseCsvRecords,
  StatementParseError,
} from "./csv";

describe("кодировка выписки", () => {
  it("таблица windows-1251 совпадает с TextDecoder платформы на всех 256 байтах", () => {
    // Проверено исполнением, а не взято на веру: собственная таблица нужна там, где у платформы
    // нет полного ICU, и она обязана давать ровно то же, что даёт платформа там, где он есть.
    const bytes = Uint8Array.from({ length: 256 }, (_, index) => index);
    expect(decodeWindows1251(bytes)).toBe(new TextDecoder("windows-1251").decode(bytes));
  });

  it("читает кириллицу в windows-1251, а не выдаёт кракозябры", () => {
    const bytes = encodeWindows1251("Пятёрочка;МТС;ООО «Ромашка» № 7");
    // Файл, прочитанный как UTF-8, дал бы мусор; строгий декодер его отвергает.
    expect(() => new TextDecoder("utf-8", { fatal: true }).decode(bytes)).toThrow();
    const decoded = decodeStatementBytes(bytes);
    expect(decoded.encoding).toBe("windows-1251");
    expect(decoded.text).toBe("Пятёрочка;МТС;ООО «Ромашка» № 7");
  });

  it("узнаёт UTF-8 с меткой порядка байтов и без неё, а также UTF-16", () => {
    const utf8 = new TextEncoder().encode("Дата;Сумма\n");
    expect(decodeStatementBytes(utf8)).toEqual({ text: "Дата;Сумма\n", encoding: "utf-8" });
    expect(decodeStatementBytes(Uint8Array.from([0xef, 0xbb, 0xbf, ...utf8]))).toEqual({ text: "Дата;Сумма\n", encoding: "utf-8" });
    const utf16 = new Uint8Array(2 + "Дата".length * 2);
    utf16[0] = 0xff;
    utf16[1] = 0xfe;
    [..."Дата"].forEach((character, index) => {
      const code = character.charCodeAt(0);
      utf16[2 + index * 2] = code & 0xff;
      utf16[3 + index * 2] = code >> 8;
    });
    expect(decodeStatementBytes(utf16)).toEqual({ text: "Дата", encoding: "utf-16le" });
  });

  it("отказывает файлу больше 5 МБ словами, которые человек прочтёт", () => {
    expect(() => decodeStatementBytes(new Uint8Array(5 * 1024 * 1024 + 1))).toThrow(StatementParseError);
  });
});

describe("разделитель и разбор CSV", () => {
  it("выбирает разделитель по заголовку и не считает запятую внутри кавычек", () => {
    expect(detectDelimiter('"Дата операции";"Сумма, руб";"Описание"\n')).toBe(";");
    expect(detectDelimiter("Дата,Сумма,Описание\n")).toBe(",");
    expect(detectDelimiter("Дата\tСумма\tОписание\n")).toBe("\t");
    // Ничья решается в пользу точки с запятой: запятая у русских выгрузок занята дробной частью.
    expect(detectDelimiter("Дата;Сумма,Описание\n")).toBe(";");
  });

  it("держит кавычки, удвоенные кавычки, разделитель и перевод строки внутри поля", () => {
    const text = '"Описание";"Сумма"\r\n"ООО ""Ромашка""; филиал";"-1 234,56"\r\n"Мосэнергосбыт\nЛицевой счёт 123";"-6400,00"\n"Аптека ""36,6""";"-1500,00"';
    expect(parseCsvRecords(text, ";")).toEqual([
      ["Описание", "Сумма"],
      ['ООО "Ромашка"; филиал', "-1 234,56"],
      ["Мосэнергосбыт\nЛицевой счёт 123", "-6400,00"],
      ['Аптека "36,6"', "-1500,00"],
    ]);
  });

  it("принимает CRLF, LF и CR, пропускает пустые строки и метку порядка байтов", () => {
    expect(parseCsvRecords("﻿a;b\r\n\r\n1;2\r3;4\n\n", ";")).toEqual([["a", "b"], ["1", "2"], ["3", "4"]]);
  });

  it("отказывает незакрытой кавычке", () => {
    expect(() => parseCsvRecords('"a;b\n1;2', ";")).toThrow(StatementParseError);
  });
});
