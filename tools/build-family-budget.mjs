import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { SpreadsheetFile, Workbook } from "@oai/artifact-tool";
import { sanitizeXlsx } from "./sanitize-xlsx.mjs";

const cliArgs = process.argv.slice(2);
if (cliArgs.length > 1) {
  throw new Error("Usage: node tools/build-family-budget.mjs [output-id]");
}

const outputId = cliArgs[0] ?? process.env.FAMILY_BUDGET_OUTPUT_ID ?? "local-build";
if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(outputId)) {
  throw new Error("output-id must contain 1-64 ASCII letters, digits, dots, underscores, or hyphens");
}

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const projectDir = path.resolve(scriptDir, "..");
const outputDir = path.join(projectDir, "outputs", outputId);
const previewDir = "/tmp/family-budget-workbook-previews";
const outputPath = path.join(outputDir, "family-budget-mvp.xlsx");
const inspectionPath = `${outputPath}.inspect.ndjson`;
const formulaErrorsPath = `${outputPath}.formula-errors.ndjson`;
const previewInspectionPath = path.join(previewDir, "inspection.ndjson");
const previewFormulaErrorsPath = path.join(previewDir, "formula-errors.ndjson");

await fs.mkdir(outputDir, { recursive: true });
await fs.mkdir(previewDir, { recursive: true });

const wb = Workbook.create();
const C = {
  ink: "#173D35", green: "#176B58", teal: "#2B8A72", mint: "#DFF3EB",
  cream: "#FFF8E8", amber: "#D49332", paleAmber: "#FFF0CF", red: "#BD4937",
  paleRed: "#FBE9E5", blue: "#356FA3", paleBlue: "#E8F2FF", gray: "#64716D",
  paleGray: "#F3F6F4", border: "#DCE4DF", white: "#FFFFFF", input: "#FFF8D8",
};
const RUB = '#,##0 "₽";[Red]-#,##0 "₽"';
const DATE = "yyyy-mm-dd";
const PERCENT = "0.0%";
const YES_NO = ["Да", "Нет"];
const categories = ["Жильё", "ЖКХ и связь", "Дети", "Продукты", "Транспорт", "Досуг", "Дом и мелкие покупки", "Здоровье", "Подарки", "Прочее"];
const accounts = ["Основной", "Резерв платежей", "Наличные"];
const calendarMonths = ["янв", "фев", "мар", "апр", "май", "июн", "июл", "авг", "сен", "окт", "ноя", "дек"];

function title(sheet, address, text) {
  const range = sheet.getRange(address);
  range.merge();
  range.values = [[text]];
  range.format = { fill: C.ink, font: { bold: true, color: C.white, fontSize: 16 }, verticalAlignment: "center", horizontalAlignment: "left" };
  range.format.rowHeight = 38;
}
function section(sheet, address, text, fill = C.green) {
  const range = sheet.getRange(address);
  range.merge();
  range.values = [[text]];
  range.format = { fill, font: { bold: true, color: C.white }, verticalAlignment: "center", horizontalAlignment: "left" };
  range.format.rowHeight = 25;
}
function header(range) {
  range.format = { fill: C.ink, font: { bold: true, color: C.white }, verticalAlignment: "center", horizontalAlignment: "center", wrapText: true, borders: { preset: "inside", style: "thin", color: C.border } };
  range.format.rowHeight = 34;
}
function input(range) {
  range.format.fill = C.input;
  range.format.borders = { preset: "inside", style: "thin", color: "#E6D59A" };
}
function formula(range) {
  range.format.fill = C.paleBlue;
  range.format.font = { color: C.ink };
}
function currency(range) {
  range.format.numberFormat = RUB;
  range.format.horizontalAlignment = "right";
}
function date(range) {
  range.setNumberFormat(DATE);
  range.format.horizontalAlignment = "center";
}
function widths(sheet, map) {
  for (const [column, width] of Object.entries(map)) sheet.getRange(`${column}:${column}`).format.columnWidth = width;
}
function addTableStyle(sheet, bodyAddress) {
  const range = sheet.getRange(bodyAddress);
  range.format.borders = { insideHorizontal: { style: "thin", color: C.border } };
  range.format.verticalAlignment = "center";
}
function yesNo(range) { range.dataValidation = { rule: { type: "list", values: YES_NO } }; }
function categoryValidation(range) { range.dataValidation = { rule: { type: "list", values: categories } }; }
function accountValidation(range) { range.dataValidation = { rule: { type: "list", values: accounts } }; }
const start = wb.worksheets.add("Быстрый старт");
const dashboard = wb.worksheets.add("Дашборд");
const horizon = wb.worksheets.add("Горизонт 24 мес");
const annual = wb.worksheets.add("Крупные и ежегодные");
const monthly = wb.worksheets.add("Ежемесячные");
const seasonal = wb.worksheets.add("Сезонные");
const flexible = wb.worksheets.add("Повседневные");
const operations = wb.worksheets.add("Операции");
const goals = wb.worksheets.add("Цели");
const settings = wb.worksheets.add("Настройки");
const refs = wb.worksheets.add("Справочники");
const sheets = [start, dashboard, horizon, annual, monthly, seasonal, flexible, operations, goals, settings, refs];
for (const sheet of sheets) sheet.showGridLines = false;

// Быстрый старт
title(start, "A1:H1", "Семейный план — быстрый старт");
start.getRange("A3:H3").merge();
start.getRange("A3").values = [["Горизонт — 24 месяца. Жёлтые ячейки можно менять; голубые считаются автоматически."]];
start.getRange("A3:H3").format = { fill: C.mint, font: { color: C.ink, bold: true }, wrapText: true, verticalAlignment: "center" };
start.getRange("A3:H3").format.rowHeight = 38;
section(start, "A5:H5", "Пять понятных шагов");
start.getRange("A6:B10").values = [
  ["1", "В «Настройках» укажите первый месяц, доход и горизонт 12 или 24 месяца."],
  ["2", "В «Крупных и ежегодных» внесите страховку, дачу, лагерь и другие платежи, к которым нужно копить."],
  ["3", "Разнесите постоянные платежи: каждый месяц — в «Ежемесячные», учебный сезон — в «Сезонные»."],
  ["4", "В «Повседневных» задайте месячные лимиты на продукты, транспорт и мелкие покупки."],
  ["5", "Фактические покупки заносите в «Операции». Итог смотрите на «Дашборде» и в горизонте."],
  ];
start.getRange("A6:A10").format = { fill: C.green, font: { bold: true, color: C.white, fontSize: 14 }, horizontalAlignment: "center", verticalAlignment: "center" };
start.getRange("B6:B10").format = { wrapText: true, verticalAlignment: "center", borders: { insideHorizontal: { style: "thin", color: C.border } } };
start.getRange("A6:B10").format.rowHeight = 42;
section(start, "A12:H12", "Что куда относить", C.amber);
start.getRange("A13:D17").values = [
  ["Слой", "Пример", "Как задаётся", "Зачем"],
  ["Крупные", "ОСАГО, дача, летний лагерь", "Дата, сумма, уже накоплено", "Понять, сколько откладывать каждый месяц"],
  ["Ежемесячные", "Ипотека, ЖКХ, интернет", "Сумма и день оплаты", "Не забыть обязательную регулярку"],
  ["Сезонные", "Обучение сентябрь–май, секции", "Отметки по месяцам", "Не завышать летние месяцы"],
  ["Повседневные", "Продукты, транспорт, мелкие покупки", "Лимит на месяц", "Сразу видеть остаток и перелимит"],
];
header(start.getRange("A13:D13"));
addTableStyle(start, "A14:D17");
start.getRange("A14:A17").format.font = { bold: true, color: C.ink };
start.getRange("A19:H21").merge(true);
start.getRange("A19:A21").values = [
  ["Важно: крупный платёж не вычитается дважды. В плане учитывается ежемесячное пополнение резерва, а сумма в месяце оплаты показывается справочно как платёж из резерва."],
  ["Категория «Дети» — только группа. Обучение может быть сезонным, лагерь — разовым или ежегодным, секции — по выбранным месяцам."],
  ["Файл не зашифрован. Храните его в защищённой папке и делайте резервную копию."],
];
start.getRange("A19:H21").format = { fill: C.paleAmber, wrapText: true, font: { color: C.ink }, verticalAlignment: "center" };
start.getRange("A19:H21").format.rowHeight = 38;
widths(start, { A: 21, B: 64, C: 24, D: 42, E: 12, F: 12, G: 12, H: 12 });
start.freezePanes.freezeRows(1);

// Настройки
title(settings, "A1:F1", "Настройки плана");
settings.getRange("A3:B9").values = [
  ["Первый месяц", null],
  ["Горизонт, месяцев", 24],
  ["Плановый доход в месяц", 180000],
  ["Порог предупреждения", 0.8],
  ["В финансовую подушку", 10000],
  ["Валюта", "RUB"],
  ["Версия модели", "2.0 · 17.07.2026"],
];
settings.getRange("B3").formulas = [["=DATE(2026,7,1)"]];
settings.getRange("A3:A9").format = { fill: C.paleGray, font: { bold: true, color: C.ink } };
input(settings.getRange("B3:B8"));
date(settings.getRange("B3"));
currency(settings.getRange("B5")); currency(settings.getRange("B7"));
settings.getRange("B6").format.numberFormat = PERCENT;
settings.getRange("B4").dataValidation = { rule: { type: "list", values: [12, 24] } };
settings.getRange("A11:F11").merge(); settings.getRange("A11").values = [["Совет: начните с крупных и сезонных платежей — именно они чаще всего ломают план одного месяца."]];
settings.getRange("A11:F11").format = { fill: C.mint, font: { color: C.ink }, wrapText: true };
settings.getRange("A11:F11").format.rowHeight = 34;
widths(settings, { A: 30, B: 24, C: 14, D: 14, E: 14, F: 14 });

// Крупные и ежегодные
title(annual, "A1:K1", "Крупные и ежегодные платежи");
annual.getRange("A3:K3").merge(); annual.getRange("A3").values = [["Введите ближайшую дату. Для ежегодного платежа план продолжит резервирование после первой оплаты; разовый завершится."]];
annual.getRange("A3:K3").format = { fill: C.cream, font: { color: C.ink }, wrapText: true };
annual.getRange("A5:K5").values = [["Название", "Категория", "Повтор", "Ближайшая дата", "Сумма", "Уже накоплено", "Мес. до срока", "Откладывать / мес", "Статус", "Активно", "Месяц оплаты"]];
header(annual.getRange("A5:K5"));
annual.getRange("A6:F8").values = [
  ["Страхование автомобиля", "Транспорт", "Ежегодный", null, 72000, 0],
  ["Платёж за загородный дом", "Жильё", "Ежегодный", null, 36000, 0],
  ["Летний лагерь", "Дети", "Разовый", null, 90000, 15000],
];
annual.getRange("D6:D8").formulas = [["=DATE(2027,1,15)"], ["=DATE(2027,5,1)"], ["=DATE(2027,6,15)"]];
annual.getRange("J6:J8").values = [["Да"], ["Да"], ["Да"]];
input(annual.getRange("A6:F25")); input(annual.getRange("J6:J25"));
for (let row = 6; row <= 25; row += 1) {
  annual.getRange(`G${row}`).formulas = [[`=IF(OR(A${row}="",J${row}<>"Да"),"",MAX(0,(YEAR(D${row})-YEAR('Настройки'!$B$3))*12+MONTH(D${row})-MONTH('Настройки'!$B$3)+1))`]];
  annual.getRange(`H${row}`).formulas = [[`=IF(OR(A${row}="",J${row}<>"Да"),0,IF(E${row}<=F${row},0,IF(G${row}>0,ROUNDUP((E${row}-F${row})/G${row},0),0)))`]];
  annual.getRange(`I${row}`).formulas = [[`=IF(A${row}="","",IF(E${row}<=F${row},"Собрано",IF(G${row}<=0,"Просрочено",IF(G${row}<=2,"Скоро","По плану"))))`]];
  annual.getRange(`K${row}`).formulas = [[`=IF(D${row}="","",MONTH(D${row}))`]];
}
formula(annual.getRange("G6:I25")); formula(annual.getRange("K6:K25"));
currency(annual.getRange("E6:F25")); currency(annual.getRange("H6:H25")); date(annual.getRange("D6:D25"));
categoryValidation(annual.getRange("B6:B25")); annual.getRange("C6:C25").dataValidation = { rule: { type: "list", values: ["Ежегодный", "Разовый"] } }; yesNo(annual.getRange("J6:J25"));
annual.getRange("I6:I25").conditionalFormats.add("containsText", { text: "Просрочено", format: { fill: C.paleRed, font: { color: C.red, bold: true } } });
annual.getRange("I6:I25").conditionalFormats.add("containsText", { text: "Скоро", format: { fill: C.paleAmber, font: { color: "#8C550D", bold: true } } });
addTableStyle(annual, "A6:K25"); widths(annual, { A: 30, B: 20, C: 16, D: 17, E: 16, F: 17, G: 14, H: 20, I: 15, J: 12, K: 14 });
annual.freezePanes.freezeRows(5);

// Ежемесячные
title(monthly, "A1:F1", "Ежемесячные обязательные платежи");
monthly.getRange("A3:F3").merge(); monthly.getRange("A3").values = [["Только стабильные платежи, которые повторяются каждый месяц. Факт оплаты всё равно внесите в «Операции»."]];
monthly.getRange("A3:F3").format = { fill: C.mint, font: { color: C.ink }, wrapText: true };
monthly.getRange("A5:F5").values = [["Название", "Категория", "Сумма / мес", "День оплаты", "Активно", "Счёт"]]; header(monthly.getRange("A5:F5"));
monthly.getRange("A6:F7").values = [["Аренда / ипотека", "Жильё", 45000, 5, "Да", "Основной"], ["ЖКХ, интернет и связь", "ЖКХ и связь", 8000, 15, "Да", "Основной"]];
input(monthly.getRange("A6:F25")); currency(monthly.getRange("C6:C25")); categoryValidation(monthly.getRange("B6:B25")); yesNo(monthly.getRange("E6:E25")); accountValidation(monthly.getRange("F6:F25"));
addTableStyle(monthly, "A6:F25"); widths(monthly, { A: 32, B: 22, C: 18, D: 16, E: 13, F: 20 }); monthly.freezePanes.freezeRows(5);

// Сезонные
title(seasonal, "A1:Q1", "Сезонные расходы по выбранным месяцам");
seasonal.getRange("A3:Q3").merge(); seasonal.getRange("A3").values = [["Пример: обучение и секции идут с сентября по май, а летом равны нулю. Для каждой строки отметьте нужные месяцы."]];
seasonal.getRange("A3:Q3").format = { fill: C.cream, font: { color: C.ink }, wrapText: true };
seasonal.getRange("A5:Q5").values = [["Название", "Категория", "Сумма / активный мес", "День", "Янв", "Фев", "Мар", "Апр", "Май", "Июн", "Июл", "Авг", "Сен", "Окт", "Ноя", "Дек", "Активно"]]; header(seasonal.getRange("A5:Q5"));
const schoolMonths = ["Да", "Да", "Да", "Да", "Да", "Нет", "Нет", "Нет", "Да", "Да", "Да", "Да"];
seasonal.getRange("A6:Q7").values = [["Обучение детей", "Дети", 25000, 10, ...schoolMonths, "Да"], ["Секции", "Дети", 6000, 12, ...schoolMonths, "Да"]];
input(seasonal.getRange("A6:Q25")); currency(seasonal.getRange("C6:C25")); categoryValidation(seasonal.getRange("B6:B25")); yesNo(seasonal.getRange("E6:Q25"));
addTableStyle(seasonal, "A6:Q25"); widths(seasonal, { A: 28, B: 18, C: 21, D: 10, E: 9, F: 9, G: 9, H: 9, I: 9, J: 9, K: 9, L: 9, M: 9, N: 9, O: 9, P: 9, Q: 12 }); seasonal.freezePanes.freezeRows(5); seasonal.freezePanes.freezeColumns(4);

// Операции до повседневных формул
title(operations, "A1:F1", "Операции — только фактические деньги");
operations.getRange("A3:F3").merge(); operations.getRange("A3").values = [["Не переносите сюда будущий план. Записывайте оплату после того, как она произошла."]];
operations.getRange("A3:F3").format = { fill: C.mint, font: { color: C.ink }, wrapText: true };
operations.getRange("A5:F5").values = [["Дата", "Тип", "Категория", "Сумма", "Счёт", "Комментарий"]]; header(operations.getRange("A5:F5"));
operations.getRange("A6:F10").values = [
  [null, "Доход", "", 180000, "Основной", "Зарплата"],
  [null, "Расход", "Жильё", 45000, "Основной", "Аренда"],
  [null, "Расход", "Продукты", 22000, "Основной", "Покупки"],
  [null, "Расход", "Транспорт", 4000, "Основной", "Топливо"],
  [null, "Расход", "ЖКХ и связь", 7500, "Основной", "Коммунальные"],
];
operations.getRange("A6:A10").formulas = [["=DATE(2026,7,1)"], ["=DATE(2026,7,5)"], ["=DATE(2026,7,8)"], ["=DATE(2026,7,9)"], ["=DATE(2026,7,15)"]];
input(operations.getRange("A6:F505")); date(operations.getRange("A6:A505")); currency(operations.getRange("D6:D505"));
operations.getRange("B6:B505").dataValidation = { rule: { type: "list", values: ["Доход", "Расход", "Возврат"] } }; categoryValidation(operations.getRange("C6:C505")); accountValidation(operations.getRange("E6:E505"));
addTableStyle(operations, "A6:F505"); widths(operations, { A: 15, B: 14, C: 25, D: 18, E: 20, F: 38 }); operations.freezePanes.freezeRows(5);

// Повседневные
title(flexible, "A1:H1", "Повседневные лимиты на месяц");
flexible.getRange("A3:H3").merge(); flexible.getRange("A3").values = [["Здесь только частые мелкие покупки. Постоянные, сезонные и крупные платежи уже учтены на отдельных листах."]];
flexible.getRange("A3:H3").format = { fill: C.mint, font: { color: C.ink }, wrapText: true };
flexible.getRange("A5:H5").values = [["Категория", "Группа", "Лимит / мес", "Потрачено", "Осталось", "Исполнение", "Статус", "Активно"]]; header(flexible.getRange("A5:H5"));
flexible.getRange("A6:C9").values = [["Продукты", "Повседневные", 30000], ["Транспорт", "Повседневные", 10000], ["Досуг", "Повседневные", 8000], ["Дом и мелкие покупки", "Повседневные", 5000]];
flexible.getRange("H6:H9").values = [["Да"], ["Да"], ["Да"], ["Да"]];
input(flexible.getRange("A6:C25")); input(flexible.getRange("H6:H25"));
for (let row = 6; row <= 25; row += 1) {
  flexible.getRange(`D${row}`).formulas = [[`=IF(OR(A${row}="",H${row}<>"Да"),0,SUMIFS('Операции'!$D$6:$D$505,'Операции'!$B$6:$B$505,"Расход",'Операции'!$C$6:$C$505,A${row},'Операции'!$A$6:$A$505,">="&'Настройки'!$B$3,'Операции'!$A$6:$A$505,"<"&DATE(YEAR('Настройки'!$B$3),MONTH('Настройки'!$B$3)+1,1))-SUMIFS('Операции'!$D$6:$D$505,'Операции'!$B$6:$B$505,"Возврат",'Операции'!$C$6:$C$505,A${row},'Операции'!$A$6:$A$505,">="&'Настройки'!$B$3,'Операции'!$A$6:$A$505,"<"&DATE(YEAR('Настройки'!$B$3),MONTH('Настройки'!$B$3)+1,1)))`]];
  flexible.getRange(`E${row}`).formulas = [[`=IF(A${row}="","",C${row}-D${row})`]];
  flexible.getRange(`F${row}`).formulas = [[`=IF(OR(A${row}="",C${row}=0),0,D${row}/C${row})`]];
  flexible.getRange(`G${row}`).formulas = [[`=IF(A${row}="","",IF(C${row}=0,"Без лимита",IF(D${row}>C${row},"Перелимит",IF(D${row}=C${row},"Лимит исчерпан",IF(D${row}/C${row}>='Настройки'!$B$6,"Почти лимит","В норме")))))`]];
}
formula(flexible.getRange("D6:G25")); currency(flexible.getRange("C6:E25")); flexible.getRange("F6:F25").format.numberFormat = PERCENT; categoryValidation(flexible.getRange("A6:A25")); yesNo(flexible.getRange("H6:H25"));
flexible.getRange("G6:G25").conditionalFormats.add("containsText", { text: "Перелимит", format: { fill: C.paleRed, font: { color: C.red, bold: true } } });
flexible.getRange("G6:G25").conditionalFormats.add("containsText", { text: "Почти", format: { fill: C.paleAmber, font: { color: "#8C550D", bold: true } } });
addTableStyle(flexible, "A6:H25"); widths(flexible, { A: 28, B: 20, C: 18, D: 18, E: 18, F: 15, G: 18, H: 12 }); flexible.freezePanes.freezeRows(5);

// Цели
title(goals, "A1:F1", "Финансовые цели"); goals.getRange("A3:F3").merge(); goals.getRange("A3").values = [["Цели отделены от крупных платежей: подушка — накопление капитала, страховка и лагерь — будущие расходы."]]; goals.getRange("A3:F3").format = { fill: C.paleBlue, font: { color: C.ink }, wrapText: true };
goals.getRange("A5:F5").values = [["Цель", "Целевая сумма", "Уже накоплено", "В месяц", "Прогресс", "Активно"]]; header(goals.getRange("A5:F5"));
goals.getRange("A6:D6").values = [["Финансовая подушка", 600000, 15000, 10000]]; goals.getRange("F6").values = [["Да"]];
for (let row = 6; row <= 15; row += 1) goals.getRange(`E${row}`).formulas = [[`=IF(OR(A${row}="",B${row}=0),0,C${row}/B${row})`]];
input(goals.getRange("A6:D15")); input(goals.getRange("F6:F15")); formula(goals.getRange("E6:E15")); currency(goals.getRange("B6:D15")); goals.getRange("E6:E15").format.numberFormat = PERCENT; yesNo(goals.getRange("F6:F15")); addTableStyle(goals, "A6:F15"); widths(goals, { A: 30, B: 20, C: 20, D: 17, E: 15, F: 12 });

// Горизонт 24 месяца
title(horizon, "A1:Y1", "Горизонт семьи — 24 месяца");
horizon.getRange("A3:Y3").merge(); horizon.getRange("A3").values = [["Главная строка — «Свободно после плана». Платежи из резерва показаны отдельно и не вычитаются второй раз."]]; horizon.getRange("A3:Y3").format = { fill: C.mint, font: { color: C.ink }, wrapText: true };
horizon.getRange("A4:A14").values = [["Показатель"], ["Плановый доход"], ["Ежемесячные"], ["Сезонные"], ["Повседневные лимиты"], ["В резерв крупных"], ["В цели"], ["Всего запланировано"], ["Свободно после плана"], ["Платежи из резерва"], ["Статус"]];
header(horizon.getRange("A4:A14"));
const seasonalSums = Array.from({ length: 12 }, (_, index) => {
  const column = String.fromCharCode("E".charCodeAt(0) + index);
  return `SUMIFS('Сезонные'!$C$6:$C$25,'Сезонные'!$${column}$6:$${column}$25,"Да",'Сезонные'!$Q$6:$Q$25,"Да")`;
});
for (let col = 0; col < 24; col += 1) {
  const excelCol = String.fromCharCode("B".charCodeAt(0) + col);
  horizon.getRange(`${excelCol}4`).formulas = [[`=DATE(YEAR('Настройки'!$B$3),MONTH('Настройки'!$B$3)+${col},1)`]];
  horizon.getRange(`${excelCol}5`).formulas = [["='Настройки'!$B$5"]];
  horizon.getRange(`${excelCol}6`).formulas = [[`=SUMIFS('Ежемесячные'!$C$6:$C$25,'Ежемесячные'!$E$6:$E$25,"Да")`]];
  horizon.getRange(`${excelCol}7`).formulas = [[`=CHOOSE(MONTH(${excelCol}$4),${seasonalSums.join(",")})`]];
  horizon.getRange(`${excelCol}8`).formulas = [[`=SUMIFS('Повседневные'!$C$6:$C$25,'Повседневные'!$H$6:$H$25,"Да")`]];
  horizon.getRange(`${excelCol}9`).formulas = [[`=SUMIFS('Крупные и ежегодные'!$H$6:$H$25,'Крупные и ежегодные'!$J$6:$J$25,"Да",'Крупные и ежегодные'!$D$6:$D$25,">="&${excelCol}$4)+SUMIFS('Крупные и ежегодные'!$E$6:$E$25,'Крупные и ежегодные'!$J$6:$J$25,"Да",'Крупные и ежегодные'!$C$6:$C$25,"Ежегодный",'Крупные и ежегодные'!$D$6:$D$25,"<"&${excelCol}$4)/12`]];
  horizon.getRange(`${excelCol}10`).formulas = [[`=SUMIFS('Цели'!$D$6:$D$15,'Цели'!$F$6:$F$15,"Да")`]];
  horizon.getRange(`${excelCol}11`).formulas = [[`=SUM(${excelCol}6:${excelCol}10)`]];
  horizon.getRange(`${excelCol}12`).formulas = [[`=${excelCol}5-${excelCol}11`]];
  horizon.getRange(`${excelCol}13`).formulas = [[`=SUMIFS('Крупные и ежегодные'!$E$6:$E$25,'Крупные и ежегодные'!$J$6:$J$25,"Да",'Крупные и ежегодные'!$D$6:$D$25,">="&${excelCol}$4,'Крупные и ежегодные'!$D$6:$D$25,"<"&DATE(YEAR(${excelCol}$4),MONTH(${excelCol}$4)+1,1))+SUMIFS('Крупные и ежегодные'!$E$6:$E$25,'Крупные и ежегодные'!$J$6:$J$25,"Да",'Крупные и ежегодные'!$C$6:$C$25,"Ежегодный",'Крупные и ежегодные'!$K$6:$K$25,MONTH(${excelCol}$4),'Крупные и ежегодные'!$D$6:$D$25,"<"&${excelCol}$4)`]];
  horizon.getRange(`${excelCol}14`).formulas = [[`=IF(${excelCol}12<0,"Дефицит",IF(${excelCol}12<${excelCol}5*0.1,"Мало запаса","Запас есть"))`]];
}
date(horizon.getRange("B4:Y4")); horizon.getRange("B4:Y4").format = { fill: C.green, font: { bold: true, color: C.white }, numberFormat: "mmm yy", horizontalAlignment: "center" };
currency(horizon.getRange("B5:Y13")); formula(horizon.getRange("B5:Y14"));
horizon.getRange("B12:Y12").format = { fill: C.mint, font: { bold: true, color: C.green }, numberFormat: RUB };
horizon.getRange("B13:Y13").format.fill = C.cream;
horizon.getRange("B14:Y14").conditionalFormats.add("containsText", { text: "Дефицит", format: { fill: C.paleRed, font: { color: C.red, bold: true } } });
horizon.getRange("B14:Y14").conditionalFormats.add("containsText", { text: "Мало", format: { fill: C.paleAmber, font: { color: "#8C550D", bold: true } } });
addTableStyle(horizon, "A4:Y14"); widths(horizon, { A: 28 }); for (const col of "BCDEFGHIJKLMNOPQRSTUVWXY") widths(horizon, { [col]: 15 }); horizon.freezePanes.freezeRows(4); horizon.freezePanes.freezeColumns(1);

// Дашборд
title(dashboard, "A1:N1", "Семейный бюджет — июль 2026 и будущие платежи");
const cards = [
  ["A3:C3", "A4:C5", "Можно на повседневное", "=SUM('Повседневные'!$C$6:$C$25)-SUM('Повседневные'!$D$6:$D$25)", C.green, RUB],
  ["A7:C7", "A8:C9", "Отложить к срокам", "='Горизонт 24 мес'!B9", C.amber, RUB],
  ["E3:G3", "E4:G5", "Платежи по расписанию", "='Горизонт 24 мес'!B6+'Горизонт 24 мес'!B7", C.blue, RUB],
  ["E7:G7", "E8:G9", "Свободно после плана", "='Горизонт 24 мес'!B12", C.teal, RUB],
];
for (const [labelAddress, valueAddress, labelText, formulaText, fill, numberFormat] of cards) {
  const labelRange = dashboard.getRange(labelAddress); labelRange.merge(); labelRange.values = [[labelText]]; labelRange.format = { fill, font: { bold: true, color: C.white }, verticalAlignment: "center" };
  const valueRange = dashboard.getRange(valueAddress); valueRange.merge(); valueRange.formulas = [[formulaText]]; valueRange.format = { fill: C.white, font: { bold: true, color: C.ink, fontSize: 18 }, horizontalAlignment: "center", verticalAlignment: "center", borders: { preset: "outside", style: "medium", color: fill }, numberFormat };
}
section(dashboard, "A11:F11", "Ближайшие крупные платежи", C.ink);
dashboard.getRange("A12:F12").values = [["Название", "Дата", "Сумма", "Уже накоплено", "Откладывать / мес", "Статус"]]; header(dashboard.getRange("A12:F12"));
for (let row = 13; row <= 15; row += 1) {
  const source = row - 7;
  dashboard.getRange(`A${row}:F${row}`).formulas = [[`='Крупные и ежегодные'!A${source}`, `='Крупные и ежегодные'!D${source}`, `='Крупные и ежегодные'!E${source}`, `='Крупные и ежегодные'!F${source}`, `='Крупные и ежегодные'!H${source}`, `='Крупные и ежегодные'!I${source}`]];
}
formula(dashboard.getRange("A13:F15")); date(dashboard.getRange("B13:B15")); currency(dashboard.getRange("C13:E15"));
dashboard.getRange("A20:D20").values = [["Месяц", "Доход", "Всего запланировано", "Свободно"]]; header(dashboard.getRange("A20:D20"));
for (let row = 21; row <= 44; row += 1) {
  const sourceCol = String.fromCharCode("B".charCodeAt(0) + row - 21);
  dashboard.getRange(`A${row}:D${row}`).formulas = [[`=TEXT('Горизонт 24 мес'!${sourceCol}4,"mmm yy")`, `='Горизонт 24 мес'!${sourceCol}5`, `='Горизонт 24 мес'!${sourceCol}11`, `='Горизонт 24 мес'!${sourceCol}12`]];
}
currency(dashboard.getRange("B21:D44")); formula(dashboard.getRange("A21:D44"));
const chart = dashboard.charts.add("line", dashboard.getRange("A20:D44")); chart.title = "Доход, план и свободный остаток — 24 месяца, ₽"; chart.hasLegend = true; chart.xAxis = { axisType: "textAxis", textStyle: { fontSize: 9 } }; chart.yAxis = { numberFormatCode: '#,##0 "₽"' }; chart.setPosition("H3", "N18");
widths(dashboard, { A: 25, B: 18, C: 21, D: 20, E: 24, F: 18, G: 6, H: 14, I: 14, J: 14, K: 14, L: 14, M: 14, N: 14 }); dashboard.freezePanes.freezeRows(1);

// Справочники
title(refs, "A1:F1", "Справочники"); refs.getRange("A3:F3").values = [["Да / Нет", "Повтор", "Тип операции", "Категории", "Счета", "Месяцы"]]; header(refs.getRange("A3:F3"));
refs.getRange("A4:A5").values = [["Да"], ["Нет"]]; refs.getRange("B4:B5").values = [["Ежегодный"], ["Разовый"]]; refs.getRange("C4:C6").values = [["Доход"], ["Расход"], ["Возврат"]]; refs.getRange("D4:D13").values = categories.map((value) => [value]); refs.getRange("E4:E6").values = accounts.map((value) => [value]); refs.getRange("F4:F15").values = calendarMonths.map((value) => [value]);
widths(refs, { A: 16, B: 18, C: 18, D: 28, E: 22, F: 14 });

// The renderer applies date formats reliably when they are part of a complete format block.
settings.getRange("B3").format = { fill: C.input, numberFormat: DATE, horizontalAlignment: "center", borders: { preset: "outside", style: "thin", color: "#E6D59A" } };
annual.getRange("D6:D25").format = { fill: C.input, numberFormat: DATE, horizontalAlignment: "center", borders: { insideHorizontal: { style: "thin", color: C.border } } };
operations.getRange("A6:A505").format = { fill: C.input, numberFormat: DATE, horizontalAlignment: "center", borders: { insideHorizontal: { style: "thin", color: C.border } } };
dashboard.getRange("B13:B15").format = { fill: C.paleBlue, numberFormat: DATE, horizontalAlignment: "center", borders: { insideHorizontal: { style: "thin", color: C.border } } };

for (const sheet of sheets) {
  const png = await wb.render({ sheetName: sheet.name, autoCrop: "all", scale: 0.85, format: "png" });
  await fs.writeFile(path.join(previewDir, `${sheet.name}.png`), new Uint8Array(await png.arrayBuffer()));
}

const inspection = await wb.inspect({ kind: "workbook,sheet,drawing", maxChars: 12000 });
await Promise.all([
  fs.writeFile(inspectionPath, inspection.ndjson, "utf8"),
  fs.writeFile(previewInspectionPath, inspection.ndjson, "utf8"),
]);
const errors = await wb.inspect({ kind: "match", searchTerm: "#REF!|#DIV/0!|#VALUE!|#NAME\\?|#N/A", options: { useRegex: true, maxResults: 200 }, maxChars: 12000 });
await Promise.all([
  fs.writeFile(formulaErrorsPath, errors.ndjson, "utf8"),
  fs.writeFile(previewFormulaErrorsPath, errors.ndjson, "utf8"),
]);

const output = await SpreadsheetFile.exportXlsx(wb);
await output.save(outputPath);
await sanitizeXlsx(outputPath);
console.log(JSON.stringify({
  outputId,
  outputPath,
  inspectionPath,
  formulaErrorsPath,
  previewDir,
  previewInspectionPath,
  previewFormulaErrorsPath,
  sheets: sheets.map((sheet) => sheet.name),
}));
