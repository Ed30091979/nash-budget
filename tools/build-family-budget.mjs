import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { FileBlob, SpreadsheetFile, Workbook } from "@oai/artifact-tool";
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

async function lstatOrNull(targetPath) {
  try {
    return await fs.lstat(targetPath);
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

async function prepareSafeOutputDirectory(outputsRoot, id) {
  const rootStat = await fs.lstat(outputsRoot);
  if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) {
    throw new Error("outputs root must be a real directory, not a symlink");
  }
  const canonicalOutputsRoot = await fs.realpath(outputsRoot);
  const requestedOutputDir = path.join(outputsRoot, id);
  const existingOutputStat = await lstatOrNull(requestedOutputDir);
  if (existingOutputStat?.isSymbolicLink()) {
    throw new Error("output-id resolves through a symlink");
  }
  if (existingOutputStat && !existingOutputStat.isDirectory()) {
    throw new Error("output-id target exists and is not a directory");
  }
  if (!existingOutputStat) {
    await fs.mkdir(requestedOutputDir, { mode: 0o700 });
  }
  const createdOutputStat = await fs.lstat(requestedOutputDir);
  if (createdOutputStat.isSymbolicLink() || !createdOutputStat.isDirectory()) {
    throw new Error("output-id target must remain a real directory");
  }
  const canonicalOutputDir = await fs.realpath(requestedOutputDir);
  if (
    path.dirname(canonicalOutputDir) !== canonicalOutputsRoot
    || canonicalOutputDir !== path.join(canonicalOutputsRoot, id)
  ) {
    throw new Error("output directory must be a direct child of the canonical outputs root");
  }
  return { canonicalOutputsRoot, canonicalOutputDir };
}

async function assertSafeFileTarget(targetPath, canonicalOutputDir) {
  if (path.dirname(targetPath) !== canonicalOutputDir) {
    throw new Error(`Output target escapes canonical output directory: ${path.basename(targetPath)}`);
  }
  const targetStat = await lstatOrNull(targetPath);
  if (targetStat?.isSymbolicLink()) {
    throw new Error(`Output target must not be a symlink: ${path.basename(targetPath)}`);
  }
  if (targetStat?.isDirectory()) {
    throw new Error(`Output target must not be a directory: ${path.basename(targetPath)}`);
  }
}

async function runSymlinkEscapeProbe() {
  const probeRoot = await fs.mkdtemp(path.join(os.tmpdir(), "family-budget-output-probe-"));
  try {
    const probeOutputsRoot = path.join(probeRoot, "outputs");
    const outsideDirectory = path.join(probeRoot, "outside");
    await fs.mkdir(probeOutputsRoot, { mode: 0o700 });
    await fs.mkdir(outsideDirectory, { mode: 0o700 });
    await fs.symlink(outsideDirectory, path.join(probeOutputsRoot, "escape"), "dir");
    let rejected = false;
    try {
      await prepareSafeOutputDirectory(probeOutputsRoot, "escape");
    } catch (error) {
      rejected = /symlink/u.test(String(error?.message));
    }
    const outsideWriteOccurred = (await fs.readdir(outsideDirectory)).length !== 0;
    if (!rejected || outsideWriteOccurred) {
      throw new Error("Symlink output-id probe did not fail closed");
    }
    return { rejected: true, outsideWriteOccurred: false };
  } finally {
    await fs.rm(probeRoot, { recursive: true, force: true });
  }
}

const symlinkEscapeProbe = await runSymlinkEscapeProbe();
const outputsRoot = path.join(projectDir, "outputs");
const { canonicalOutputDir: outputDir } = await prepareSafeOutputDirectory(outputsRoot, outputId);
const previewDir = await fs.mkdtemp(path.join(os.tmpdir(), "family-budget-workbook-previews-"));
await fs.chmod(previewDir, 0o700);
const outputPath = path.join(outputDir, "family-budget-mvp.xlsx");
const inspectionPath = `${outputPath}.inspect.ndjson`;
const previewInspectionPath = path.join(previewDir, "inspection.ndjson");
const previewFormulaErrorsPath = path.join(previewDir, "formula-errors.ndjson");
const fixturePath = path.join(projectDir, "contracts", "fixtures", "g-002.json");
await assertSafeFileTarget(outputPath, outputDir);
await assertSafeFileTarget(inspectionPath, outputDir);

const fixture = JSON.parse(await fs.readFile(fixturePath, "utf8"));
if (
  fixture?.fixtureId !== "G-002"
  || fixture?.schemaVersion !== "1.0.0"
  || fixture?.horizonMonths !== 24
  || fixture?.minorUnit?.currency !== "RUB"
  || !Number.isInteger(fixture?.minorUnit?.exponent)
) {
  throw new Error("Canonical G-002 fixture has an unexpected contract");
}

const state = fixture.state;
const activeBudget = state.budgets.find((budget) => budget.id === state.activeBudgetId);
if (!activeBudget) throw new Error("Canonical G-002 has no active budget");

const minorDivisor = 10 ** fixture.minorUnit.exponent;
function major(minor) {
  if (!Number.isSafeInteger(minor)) throw new Error(`Unsafe minor-unit value: ${minor}`);
  return minor / minorDivisor;
}
function localDate(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new Error(`Invalid local date: ${value}`);
  const result = new Date(`${value}T00:00:00.000Z`);
  if (result.toISOString().slice(0, 10) !== value) throw new Error(`Invalid calendar date: ${value}`);
  return result;
}
function yesNoValue(value) {
  return value ? "Да" : "Нет";
}

const categoryById = new Map(state.categories.map((category) => [category.id, category]));
const accountById = new Map(state.accounts.map((account) => [account.id, account]));
const expenseCategories = state.categories
  .filter((category) => category.type === "expense" && category.active)
  .sort((left, right) => left.sortOrder - right.sortOrder);
const activeAccounts = state.accounts.filter((account) => account.active);
const categories = expenseCategories.map((category) => category.name);
const accounts = activeAccounts.map((account) => account.name);
const calendarMonths = ["янв", "фев", "мар", "апр", "май", "июн", "июл", "авг", "сен", "окт", "ноя", "дек"];
const monthFlags = (months = []) => Array.from(
  { length: 12 },
  (_, index) => yesNoValue(months.includes(index + 1)),
);
const annualRows = state.annualCommitments.map((item) => [
  item.name,
  categoryById.get(item.categoryId)?.name ?? "",
  item.recurrence === "annual" ? "Ежегодный" : "Разовый",
  localDate(item.dueDate),
  major(item.amountMinor),
  major(item.reservedMinor),
  yesNoValue(item.active),
]);
const monthlyRows = state.scheduledExpenses
  .filter((item) => item.mode === "monthly")
  .map((item) => [
    item.name,
    categoryById.get(item.categoryId)?.name ?? "",
    major(item.amountMinor),
    item.dueDay,
    yesNoValue(item.active),
    accountById.get(item.accountId)?.name ?? "",
  ]);
const seasonalRows = state.scheduledExpenses
  .filter((item) => item.mode === "selected_months")
  .map((item) => [
    item.name,
    categoryById.get(item.categoryId)?.name ?? "",
    major(item.amountMinor),
    item.dueDay,
    ...monthFlags(item.months),
    yesNoValue(item.active),
  ]);
const flexibleRows = activeBudget.lines.map((line) => {
  const category = categoryById.get(line.categoryId);
  if (!category) throw new Error(`Budget line references unknown category ${line.categoryId}`);
  return [
    category.name,
    category.group,
    major(line.plannedMinor + (line.rolloverMinor ?? 0) + (line.adjustmentMinor ?? 0)),
    yesNoValue(line.active !== false && category.active),
  ];
});
const operationType = { income: "Доход", expense: "Расход", refund: "Возврат" };
const operationRows = state.transactions
  .filter((transaction) => transaction.status === "posted" && operationType[transaction.kind])
  .map((transaction) => [
    localDate(transaction.occurredOn),
    operationType[transaction.kind],
    "categoryId" in transaction ? categoryById.get(transaction.categoryId)?.name ?? "" : "",
    major(transaction.amountMinor),
    "accountId" in transaction ? accountById.get(transaction.accountId)?.name ?? "" : "",
    fixture.fixtureId,
  ]);
const goalRows = state.goals.map((goal) => [
  goal.name,
  major(goal.targetMinor),
  major(goal.openingContributedMinor),
  major(goal.plannedContributionMinor),
  yesNoValue(goal.status === "active"),
]);
const expectedByMonth = new Map(fixture.expected.months.map((month) => [month.month, month]));

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
  ["Горизонт, месяцев", fixture.horizonMonths],
  ["Плановый доход в месяц", major(activeBudget.plannedIncomeMinor)],
  ["Порог предупреждения", activeBudget.warningThreshold],
  ["В финансовую подушку", goalRows.reduce((total, row) => total + row[3], 0)],
  ["Валюта", fixture.minorUnit.currency],
  ["Версия модели", `${fixture.fixtureId} · schema ${fixture.schemaVersion}`],
];
settings.getRange("B3").values = [[localDate(`${fixture.startMonth}-01`)]];
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
title(annual, "A1:L1", "Крупные и ежегодные платежи");
annual.getRange("A3:L3").merge(); annual.getRange("A3").values = [["Введите ближайшую дату. Для ежегодного платежа план продолжит резервирование после первой оплаты; разовый завершится."]];
annual.getRange("A3:L3").format = { fill: C.cream, font: { color: C.ink }, wrapText: true };
annual.getRange("A5:L5").values = [["Название", "Категория", "Повтор", "Ближайшая дата", "Сумма", "Уже накоплено", "Мес. до срока", "Откладывать / мес", "Статус", "Активно", "Месяц оплаты", "После первой оплаты / мес"]];
header(annual.getRange("A5:L5"));
if (annualRows.length > 0) {
  annual.getRangeByIndexes(5, 0, annualRows.length, 6).values = annualRows.map((row) => row.slice(0, 6));
  annual.getRangeByIndexes(5, 9, annualRows.length, 1).values = annualRows.map((row) => [row[6]]);
}
input(annual.getRange("A6:F25")); input(annual.getRange("J6:J25"));
for (let row = 6; row <= 25; row += 1) {
  annual.getRange(`G${row}`).formulas = [[`=IF(OR(A${row}="",J${row}<>"Да"),"",MAX(0,(YEAR(D${row})-YEAR('Настройки'!$B$3))*12+MONTH(D${row})-MONTH('Настройки'!$B$3)+1))`]];
  annual.getRange(`H${row}`).formulas = [[`=IF(A${row}="","",IF(J${row}<>"Да",0,IF(E${row}<=F${row},0,IF(G${row}>0,ROUNDUP((E${row}-F${row})/G${row},0),0))))`]];
  annual.getRange(`I${row}`).formulas = [[`=IF(A${row}="","",IF(E${row}<=F${row},"Собрано",IF(G${row}<=0,"Просрочено",IF(G${row}<=2,"Скоро","По плану"))))`]];
  annual.getRange(`K${row}`).formulas = [[`=IF(D${row}="","",MONTH(D${row}))`]];
  annual.getRange(`L${row}`).formulas = [[`=IF(A${row}="","",IF(AND(J${row}="Да",C${row}="Ежегодный"),ROUNDUP(E${row}/12,0),0))`]];
}
formula(annual.getRange("G6:I25")); formula(annual.getRange("K6:L25"));
currency(annual.getRange("E6:F25")); currency(annual.getRange("H6:H25")); currency(annual.getRange("L6:L25")); date(annual.getRange("D6:D25"));
categoryValidation(annual.getRange("B6:B25")); annual.getRange("C6:C25").dataValidation = { rule: { type: "list", values: ["Ежегодный", "Разовый"] } }; yesNo(annual.getRange("J6:J25"));
annual.getRange("I6:I25").conditionalFormats.add("containsText", { text: "Просрочено", format: { fill: C.paleRed, font: { color: C.red, bold: true } } });
annual.getRange("I6:I25").conditionalFormats.add("containsText", { text: "Скоро", format: { fill: C.paleAmber, font: { color: "#8C550D", bold: true } } });
addTableStyle(annual, "A6:L25"); widths(annual, { A: 30, B: 20, C: 16, D: 17, E: 16, F: 17, G: 14, H: 20, I: 15, J: 12, K: 14, L: 25 });
const annualTable = annual.tables.add("A5:L25", true, "AnnualCommitments");
annual.getRange("C6:D25").format.horizontalAlignment = "center";
annual.getRange("G6:G25").format.horizontalAlignment = "center";
annual.getRange("I6:K25").format.horizontalAlignment = "center";
annual.freezePanes.freezeRows(5);

// Ежемесячные
title(monthly, "A1:F1", "Ежемесячные обязательные платежи");
monthly.getRange("A3:F3").merge(); monthly.getRange("A3").values = [["Только стабильные платежи, которые повторяются каждый месяц. Факт оплаты всё равно внесите в «Операции»."]];
monthly.getRange("A3:F3").format = { fill: C.mint, font: { color: C.ink }, wrapText: true };
monthly.getRange("A5:F5").values = [["Название", "Категория", "Сумма / мес", "День оплаты", "Активно", "Счёт"]]; header(monthly.getRange("A5:F5"));
if (monthlyRows.length > 0) monthly.getRangeByIndexes(5, 0, monthlyRows.length, 6).values = monthlyRows;
input(monthly.getRange("A6:F25")); currency(monthly.getRange("C6:C25")); categoryValidation(monthly.getRange("B6:B25")); yesNo(monthly.getRange("E6:E25")); accountValidation(monthly.getRange("F6:F25"));
addTableStyle(monthly, "A6:F25"); widths(monthly, { A: 32, B: 22, C: 18, D: 16, E: 13, F: 20 }); monthly.freezePanes.freezeRows(5);
const monthlyTable = monthly.tables.add("A5:F25", true, "MonthlyExpenses");
monthly.getRange("D6:F25").format.horizontalAlignment = "center";

// Сезонные
title(seasonal, "A1:Q1", "Сезонные расходы по выбранным месяцам");
seasonal.getRange("A3:Q3").merge(); seasonal.getRange("A3").values = [["Пример: обучение и секции идут с сентября по май, а летом равны нулю. Для каждой строки отметьте нужные месяцы."]];
seasonal.getRange("A3:Q3").format = { fill: C.cream, font: { color: C.ink }, wrapText: true };
seasonal.getRange("A5:Q5").values = [["Название", "Категория", "Сумма / активный мес", "День", "Янв", "Фев", "Мар", "Апр", "Май", "Июн", "Июл", "Авг", "Сен", "Окт", "Ноя", "Дек", "Активно"]]; header(seasonal.getRange("A5:Q5"));
if (seasonalRows.length > 0) seasonal.getRangeByIndexes(5, 0, seasonalRows.length, 17).values = seasonalRows;
input(seasonal.getRange("A6:Q25")); currency(seasonal.getRange("C6:C25")); categoryValidation(seasonal.getRange("B6:B25")); yesNo(seasonal.getRange("E6:Q25"));
addTableStyle(seasonal, "A6:Q25"); widths(seasonal, { A: 28, B: 18, C: 21, D: 10, E: 9, F: 9, G: 9, H: 9, I: 9, J: 9, K: 9, L: 9, M: 9, N: 9, O: 9, P: 9, Q: 12 }); seasonal.freezePanes.freezeRows(5); seasonal.freezePanes.freezeColumns(4);
const seasonalTable = seasonal.tables.add("A5:Q25", true, "SeasonalExpenses");
seasonal.getRange("D6:Q25").format.horizontalAlignment = "center";

// Операции до повседневных формул
title(operations, "A1:F1", "Операции — только фактические деньги");
operations.getRange("A3:F3").merge(); operations.getRange("A3").values = [["Не переносите сюда будущий план. Записывайте оплату после того, как она произошла."]];
operations.getRange("A3:F3").format = { fill: C.mint, font: { color: C.ink }, wrapText: true };
operations.getRange("A5:F5").values = [["Дата", "Тип", "Категория", "Сумма", "Счёт", "Комментарий"]]; header(operations.getRange("A5:F5"));
if (operationRows.length > 0) operations.getRangeByIndexes(5, 0, operationRows.length, 6).values = operationRows;
input(operations.getRange("A6:F505")); date(operations.getRange("A6:A505")); currency(operations.getRange("D6:D505"));
operations.getRange("B6:B505").dataValidation = { rule: { type: "list", values: ["Доход", "Расход", "Возврат"] } }; categoryValidation(operations.getRange("C6:C505")); accountValidation(operations.getRange("E6:E505"));
addTableStyle(operations, "A6:F505"); widths(operations, { A: 15, B: 14, C: 25, D: 18, E: 20, F: 38 }); operations.freezePanes.freezeRows(5);
const operationsTable = operations.tables.add("A5:F505", true, "Operations");
operations.getRange("B6:B505").format.horizontalAlignment = "center";
operations.getRange("E6:E505").format.horizontalAlignment = "center";

// Повседневные
title(flexible, "A1:H1", "Повседневные лимиты на месяц");
flexible.getRange("A3:H3").merge(); flexible.getRange("A3").values = [["Здесь только частые мелкие покупки. Постоянные, сезонные и крупные платежи уже учтены на отдельных листах."]];
flexible.getRange("A3:H3").format = { fill: C.mint, font: { color: C.ink }, wrapText: true };
flexible.getRange("A5:H5").values = [["Категория", "Группа", "Лимит / мес", "Потрачено", "Осталось", "Исполнение", "Статус", "Активно"]]; header(flexible.getRange("A5:H5"));
if (flexibleRows.length > 0) {
  flexible.getRangeByIndexes(5, 0, flexibleRows.length, 3).values = flexibleRows.map((row) => row.slice(0, 3));
  flexible.getRangeByIndexes(5, 7, flexibleRows.length, 1).values = flexibleRows.map((row) => [row[3]]);
}
input(flexible.getRange("A6:C25")); input(flexible.getRange("H6:H25"));
for (let row = 6; row <= 25; row += 1) {
  flexible.getRange(`D${row}`).formulas = [[`=IF(A${row}="","",IF(H${row}<>"Да",0,SUMIFS(Operations[Сумма],Operations[Тип],"Расход",Operations[Категория],A${row},Operations[Дата],">="&'Настройки'!$B$3,Operations[Дата],"<"&DATE(YEAR('Настройки'!$B$3),MONTH('Настройки'!$B$3)+1,1))-SUMIFS(Operations[Сумма],Operations[Тип],"Возврат",Operations[Категория],A${row},Operations[Дата],">="&'Настройки'!$B$3,Operations[Дата],"<"&DATE(YEAR('Настройки'!$B$3),MONTH('Настройки'!$B$3)+1,1))))`]];
  flexible.getRange(`E${row}`).formulas = [[`=IF(A${row}="","",C${row}-D${row})`]];
  flexible.getRange(`F${row}`).formulas = [[`=IF(A${row}="","",IF(C${row}=0,0,D${row}/C${row}))`]];
  flexible.getRange(`G${row}`).formulas = [[`=IF(A${row}="","",IF(C${row}=0,"Без лимита",IF(D${row}>C${row},"Перелимит",IF(D${row}=C${row},"Лимит исчерпан",IF(D${row}/C${row}>='Настройки'!$B$6,"Почти лимит","В норме")))))`]];
}
formula(flexible.getRange("D6:G25")); currency(flexible.getRange("C6:E25")); flexible.getRange("F6:F25").format.numberFormat = PERCENT; categoryValidation(flexible.getRange("A6:A25")); yesNo(flexible.getRange("H6:H25"));
flexible.getRange("G6:G25").conditionalFormats.add("containsText", { text: "Перелимит", format: { fill: C.paleRed, font: { color: C.red, bold: true } } });
flexible.getRange("G6:G25").conditionalFormats.add("containsText", { text: "Почти", format: { fill: C.paleAmber, font: { color: "#8C550D", bold: true } } });
addTableStyle(flexible, "A6:H25"); widths(flexible, { A: 28, B: 20, C: 18, D: 18, E: 18, F: 15, G: 18, H: 12 }); flexible.freezePanes.freezeRows(5);
const flexibleTable = flexible.tables.add("A5:H25", true, "FlexibleBudgets");
flexible.getRange("F6:F25").format.horizontalAlignment = "right";
flexible.getRange("H6:H25").format.horizontalAlignment = "center";

// Цели
title(goals, "A1:F1", "Финансовые цели"); goals.getRange("A3:F3").merge(); goals.getRange("A3").values = [["Цели отделены от крупных платежей: подушка — накопление капитала, страховка и лагерь — будущие расходы."]]; goals.getRange("A3:F3").format = { fill: C.paleBlue, font: { color: C.ink }, wrapText: true };
goals.getRange("A5:F5").values = [["Цель", "Целевая сумма", "Уже накоплено", "В месяц", "Прогресс", "Активно"]]; header(goals.getRange("A5:F5"));
if (goalRows.length > 0) {
  goals.getRangeByIndexes(5, 0, goalRows.length, 4).values = goalRows.map((row) => row.slice(0, 4));
  goals.getRangeByIndexes(5, 5, goalRows.length, 1).values = goalRows.map((row) => [row[4]]);
}
for (let row = 6; row <= 15; row += 1) goals.getRange(`E${row}`).formulas = [[`=IF(A${row}="","",IF(B${row}=0,0,C${row}/B${row}))`]];
input(goals.getRange("A6:D15")); input(goals.getRange("F6:F15")); formula(goals.getRange("E6:E15")); currency(goals.getRange("B6:D15")); goals.getRange("E6:E15").format.numberFormat = PERCENT; yesNo(goals.getRange("F6:F15")); addTableStyle(goals, "A6:F15"); widths(goals, { A: 30, B: 20, C: 20, D: 17, E: 15, F: 12 });
const goalsTable = goals.tables.add("A5:F15", true, "Goals");
goals.getRange("F6:F15").format.horizontalAlignment = "center";

// Горизонт 24 месяца
title(horizon, "A1:Y1", "Горизонт семьи — 24 месяца");
horizon.getRange("A3:Y3").merge(); horizon.getRange("A3").values = [["Главная строка — «Свободно после плана». Платежи из резерва показаны отдельно и не вычитаются второй раз."]]; horizon.getRange("A3:Y3").format = { fill: C.mint, font: { color: C.ink }, wrapText: true };
horizon.getRange("A4:A14").values = [["Показатель"], ["Плановый доход"], ["Ежемесячные"], ["Сезонные"], ["Повседневные лимиты"], ["В резерв крупных"], ["В цели"], ["Всего запланировано"], ["Свободно после плана"], ["Платежи из резерва"], ["Статус"]];
header(horizon.getRange("A4:A14"));
const seasonalSums = Array.from({ length: 12 }, (_, index) => {
  const monthName = ["Янв", "Фев", "Мар", "Апр", "Май", "Июн", "Июл", "Авг", "Сен", "Окт", "Ноя", "Дек"][index];
  return `SUMIFS(SeasonalExpenses[Сумма / активный мес],SeasonalExpenses[${monthName}],"Да",SeasonalExpenses[Активно],"Да")`;
});
for (let col = 0; col < 24; col += 1) {
  const excelCol = String.fromCharCode("B".charCodeAt(0) + col);
  horizon.getRange(`${excelCol}4`).formulas = [[`=DATE(YEAR('Настройки'!$B$3),MONTH('Настройки'!$B$3)+${col},1)`]];
  horizon.getRange(`${excelCol}5`).formulas = [["='Настройки'!$B$5"]];
  horizon.getRange(`${excelCol}6`).formulas = [[`=SUMIFS(MonthlyExpenses[Сумма / мес],MonthlyExpenses[Активно],"Да")`]];
  horizon.getRange(`${excelCol}7`).formulas = [[`=CHOOSE(MONTH(${excelCol}$4),${seasonalSums.join(",")})`]];
  horizon.getRange(`${excelCol}8`).formulas = [[`=SUMIFS(FlexibleBudgets[Лимит / мес],FlexibleBudgets[Активно],"Да")`]];
  horizon.getRange(`${excelCol}9`).formulas = [[`=SUMIFS(AnnualCommitments[Откладывать / мес],AnnualCommitments[Активно],"Да",AnnualCommitments[Ближайшая дата],">="&${excelCol}$4)+SUMIFS(AnnualCommitments[После первой оплаты / мес],AnnualCommitments[Активно],"Да",AnnualCommitments[Повтор],"Ежегодный",AnnualCommitments[Ближайшая дата],"<"&${excelCol}$4)`]];
  horizon.getRange(`${excelCol}10`).formulas = [[`=SUMIFS(Goals[В месяц],Goals[Активно],"Да")`]];
  horizon.getRange(`${excelCol}11`).formulas = [[`=SUM(${excelCol}6:${excelCol}10)`]];
  horizon.getRange(`${excelCol}12`).formulas = [[`=${excelCol}5-${excelCol}11`]];
  horizon.getRange(`${excelCol}13`).formulas = [[`=SUMIFS(AnnualCommitments[Сумма],AnnualCommitments[Активно],"Да",AnnualCommitments[Ближайшая дата],">="&${excelCol}$4,AnnualCommitments[Ближайшая дата],"<"&DATE(YEAR(${excelCol}$4),MONTH(${excelCol}$4)+1,1))+SUMIFS(AnnualCommitments[Сумма],AnnualCommitments[Активно],"Да",AnnualCommitments[Повтор],"Ежегодный",AnnualCommitments[Месяц оплаты],MONTH(${excelCol}$4),AnnualCommitments[Ближайшая дата],"<"&${excelCol}$4)`]];
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
title(dashboard, "A1:N1", `Семейный бюджет — старт ${fixture.startMonth} и будущие платежи`);
const cards = [
  ["A3:C3", "A4:C5", "Можно на повседневное", "=SUM(FlexibleBudgets[Лимит / мес])-SUM(FlexibleBudgets[Потрачено])", C.green, RUB],
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
const chartTitle = "Доход, план и свободный остаток — 24 месяца, ₽";
const chart = dashboard.charts.add("line", dashboard.getRange("A20:D44")); chart.title = chartTitle; chart.hasLegend = true; chart.xAxis = { axisType: "textAxis", textStyle: { fontSize: 9 } }; chart.yAxis = { numberFormatCode: '#,##0 "₽"' }; chart.setPosition("H3", "N18");
widths(dashboard, { A: 25, B: 18, C: 21, D: 20, E: 24, F: 18, G: 6, H: 14, I: 14, J: 14, K: 14, L: 14, M: 14, N: 14 }); dashboard.freezePanes.freezeRows(1);

// Справочники
title(refs, "A1:F1", "Справочники"); refs.getRange("A3:F3").values = [["Да / Нет", "Повтор", "Тип операции", "Категории", "Счета", "Месяцы"]]; header(refs.getRange("A3:F3"));
refs.getRange("A4:A5").values = [["Да"], ["Нет"]];
refs.getRange("B4:B5").values = [["Ежегодный"], ["Разовый"]];
refs.getRange("C4:C6").values = [["Доход"], ["Расход"], ["Возврат"]];
refs.getRangeByIndexes(3, 3, categories.length, 1).values = categories.map((value) => [value]);
refs.getRangeByIndexes(3, 4, accounts.length, 1).values = accounts.map((value) => [value]);
refs.getRange("F4:F15").values = calendarMonths.map((value) => [value]);
widths(refs, { A: 16, B: 18, C: 18, D: 28, E: 22, F: 14 });

// The renderer applies date formats reliably when they are part of a complete format block.
settings.getRange("B3").format = { fill: C.input, numberFormat: DATE, horizontalAlignment: "center", borders: { preset: "outside", style: "thin", color: "#E6D59A" } };
annual.getRange("D6:D25").format = { fill: C.input, numberFormat: DATE, horizontalAlignment: "center", borders: { insideHorizontal: { style: "thin", color: C.border } } };
operations.getRange("A6:A505").format = { fill: C.input, numberFormat: DATE, horizontalAlignment: "center", borders: { insideHorizontal: { style: "thin", color: C.border } } };
dashboard.getRange("B13:B15").format = { fill: C.paleBlue, numberFormat: DATE, horizontalAlignment: "center", borders: { insideHorizontal: { style: "thin", color: C.border } } };

function valueAt(sheet, address) {
  return sheet.getRange(address).values[0][0];
}
function formulaAt(sheet, address) {
  return sheet.getRange(address).formulas[0][0];
}
function assertExact(label, actual, expected) {
  if (typeof actual !== "number" || Math.abs(actual - expected) > 0.000001) {
    throw new Error(`${label}: expected ${expected}, received ${String(actual)}`);
  }
}
function columnForMonth(month) {
  const [startYear, startMonth] = fixture.startMonth.split("-").map(Number);
  const [year, calendarMonth] = month.split("-").map(Number);
  const offset = (year - startYear) * 12 + calendarMonth - startMonth;
  if (offset < 0 || offset >= fixture.horizonMonths) throw new Error(`Month ${month} is outside G-002 horizon`);
  return String.fromCharCode("B".charCodeAt(0) + offset);
}

const mutationProbes = {};

const annualExistingBaseline = {
  amount: valueAt(annual, "E6"),
  postDueReservePerMonth: valueAt(annual, "L6"),
  february2027Reserve: valueAt(horizon, "I9"),
};
annual.getRange("E6").values = [[annualExistingBaseline.amount + 1]];
const annualExistingAfter = {
  amount: valueAt(annual, "E6"),
  postDueReservePerMonth: valueAt(annual, "L6"),
  february2027Reserve: valueAt(horizon, "I9"),
};
assertExact("existing annual per-row ROUNDUP", annualExistingAfter.postDueReservePerMonth, annualExistingBaseline.postDueReservePerMonth + 1);
assertExact("existing annual downstream post-due reserve", annualExistingAfter.february2027Reserve, annualExistingBaseline.february2027Reserve + 1);
annual.getRange("E6").values = [[annualExistingBaseline.amount]];
assertExact("existing annual rollback formula", valueAt(annual, "L6"), annualExistingBaseline.postDueReservePerMonth);
assertExact("existing annual rollback downstream", valueAt(horizon, "I9"), annualExistingBaseline.february2027Reserve);

const newAnnualBaseline = valueAt(horizon, "B9");
annual.getRange("A25:F25").values = [[
  "Проверка округления новой строки",
  categories[0],
  "Ежегодный",
  localDate("2026-06-15"),
  12001,
  0,
]];
annual.getRange("J25").values = [["Да"]];
const newAnnualAfter = {
  postDueReservePerMonth: valueAt(annual, "L25"),
  july2026Reserve: valueAt(horizon, "B9"),
};
assertExact("new annual per-row ROUNDUP", newAnnualAfter.postDueReservePerMonth, 1001);
assertExact("new annual downstream post-due reserve", newAnnualAfter.july2026Reserve, newAnnualBaseline + 1001);
annual.getRange("A25:F25").clear({ applyTo: "contents" });
annual.getRange("J25").clear({ applyTo: "contents" });
assertExact("new annual rollback downstream", valueAt(horizon, "B9"), newAnnualBaseline);
mutationProbes.AnnualCommitments = {
  existingRow: {
    baseline: annualExistingBaseline,
    afterAmount72001: annualExistingAfter,
    rollback: {
      amount: valueAt(annual, "E6"),
      postDueReservePerMonth: valueAt(annual, "L6"),
      february2027Reserve: valueAt(horizon, "I9"),
    },
  },
  newRow: {
    amount: 12001,
    expectedPerRowCeiling: 1001,
    baselineJulyReserve: newAnnualBaseline,
    afterInsert: newAnnualAfter,
    rollbackJulyReserve: valueAt(horizon, "B9"),
  },
  passed: true,
};

const structuredExtensionBaseline = {
  scheduled: valueAt(horizon, "B6"),
  free: valueAt(horizon, "B12"),
};
monthly.getRange("A25:F25").values = [[
  "Проверка расширения",
  categories[0],
  123,
  1,
  "Да",
  accounts[0],
]];
const monthlyAfter = {
  scheduled: valueAt(horizon, "B6"),
  free: valueAt(horizon, "B12"),
};
assertExact("structured row extension scheduled", monthlyAfter.scheduled, structuredExtensionBaseline.scheduled + 123);
assertExact("structured row extension free", monthlyAfter.free, structuredExtensionBaseline.free - 123);
monthly.getRange("A25:F25").clear({ applyTo: "contents" });
assertExact("structured row extension rollback scheduled", valueAt(horizon, "B6"), structuredExtensionBaseline.scheduled);
assertExact("structured row extension rollback free", valueAt(horizon, "B12"), structuredExtensionBaseline.free);
mutationProbes.MonthlyExpenses = {
  row: 25,
  amount: 123,
  baseline: structuredExtensionBaseline,
  afterInsert: monthlyAfter,
  rollback: { scheduled: valueAt(horizon, "B6"), free: valueAt(horizon, "B12") },
  passed: true,
};

const seasonalBaseline = {
  amount: valueAt(seasonal, "C6"),
  september: valueAt(horizon, "D7"),
  free: valueAt(horizon, "D12"),
};
seasonal.getRange("C6").values = [[seasonalBaseline.amount + 1]];
const seasonalAfter = { september: valueAt(horizon, "D7"), free: valueAt(horizon, "D12") };
assertExact("seasonal downstream amount", seasonalAfter.september, seasonalBaseline.september + 1);
assertExact("seasonal downstream free", seasonalAfter.free, seasonalBaseline.free - 1);
seasonal.getRange("C6").values = [[seasonalBaseline.amount]];
assertExact("seasonal rollback amount", valueAt(horizon, "D7"), seasonalBaseline.september);
assertExact("seasonal rollback free", valueAt(horizon, "D12"), seasonalBaseline.free);
mutationProbes.SeasonalExpenses = {
  baseline: seasonalBaseline,
  afterPlusOne: seasonalAfter,
  rollback: { september: valueAt(horizon, "D7"), free: valueAt(horizon, "D12") },
  passed: true,
};

const flexibleBaseline = {
  limit: valueAt(flexible, "C6"),
  total: valueAt(horizon, "B8"),
  free: valueAt(horizon, "B12"),
};
flexible.getRange("C6").values = [[flexibleBaseline.limit + 1]];
const flexibleAfter = { total: valueAt(horizon, "B8"), free: valueAt(horizon, "B12") };
assertExact("flexible downstream total", flexibleAfter.total, flexibleBaseline.total + 1);
assertExact("flexible downstream free", flexibleAfter.free, flexibleBaseline.free - 1);
flexible.getRange("C6").values = [[flexibleBaseline.limit]];
assertExact("flexible rollback total", valueAt(horizon, "B8"), flexibleBaseline.total);
assertExact("flexible rollback free", valueAt(horizon, "B12"), flexibleBaseline.free);
mutationProbes.FlexibleBudgets = {
  baseline: flexibleBaseline,
  afterPlusOne: flexibleAfter,
  rollback: { total: valueAt(horizon, "B8"), free: valueAt(horizon, "B12") },
  passed: true,
};

const operationsBaseline = {
  productExpense: valueAt(operations, "D8"),
  productSpent: valueAt(flexible, "D6"),
  productRemaining: valueAt(flexible, "E6"),
  dashboardAvailable: valueAt(dashboard, "A4"),
};
operations.getRange("D8").values = [[operationsBaseline.productExpense + 1]];
const operationsAfter = {
  productSpent: valueAt(flexible, "D6"),
  productRemaining: valueAt(flexible, "E6"),
  dashboardAvailable: valueAt(dashboard, "A4"),
};
assertExact("operations downstream spent", operationsAfter.productSpent, operationsBaseline.productSpent + 1);
assertExact("operations downstream remaining", operationsAfter.productRemaining, operationsBaseline.productRemaining - 1);
assertExact("operations downstream dashboard", operationsAfter.dashboardAvailable, operationsBaseline.dashboardAvailable - 1);
operations.getRange("D8").values = [[operationsBaseline.productExpense]];
assertExact("operations rollback spent", valueAt(flexible, "D6"), operationsBaseline.productSpent);
assertExact("operations rollback remaining", valueAt(flexible, "E6"), operationsBaseline.productRemaining);
assertExact("operations rollback dashboard", valueAt(dashboard, "A4"), operationsBaseline.dashboardAvailable);
mutationProbes.Operations = {
  baseline: operationsBaseline,
  afterPlusOne: operationsAfter,
  rollback: {
    productSpent: valueAt(flexible, "D6"),
    productRemaining: valueAt(flexible, "E6"),
    dashboardAvailable: valueAt(dashboard, "A4"),
  },
  passed: true,
};

const goalsBaseline = {
  contribution: valueAt(goals, "D6"),
  total: valueAt(horizon, "B10"),
  free: valueAt(horizon, "B12"),
};
goals.getRange("D6").values = [[goalsBaseline.contribution + 1]];
const goalsAfter = { total: valueAt(horizon, "B10"), free: valueAt(horizon, "B12") };
assertExact("goals downstream total", goalsAfter.total, goalsBaseline.total + 1);
assertExact("goals downstream free", goalsAfter.free, goalsBaseline.free - 1);
goals.getRange("D6").values = [[goalsBaseline.contribution]];
assertExact("goals rollback total", valueAt(horizon, "B10"), goalsBaseline.total);
assertExact("goals rollback free", valueAt(horizon, "B12"), goalsBaseline.free);
mutationProbes.Goals = {
  baseline: goalsBaseline,
  afterPlusOne: goalsAfter,
  rollback: { total: valueAt(horizon, "B10"), free: valueAt(horizon, "B12") },
  passed: true,
};

for (const expected of fixture.expected.months) {
  const col = columnForMonth(expected.month);
  assertExact(`${expected.month} planned income`, valueAt(horizon, `${col}5`), major(expected.plannedIncomeMinor));
  assertExact(`${expected.month} scheduled expenses`, valueAt(horizon, `${col}6`) + valueAt(horizon, `${col}7`), major(expected.scheduledExpenseMinor));
  assertExact(`${expected.month} seasonal expenses`, valueAt(horizon, `${col}7`), major(expected.seasonalExpenseMinor));
  assertExact(`${expected.month} flexible plan`, valueAt(horizon, `${col}8`), major(expected.flexiblePlanMinor));
  assertExact(`${expected.month} annual reserve`, valueAt(horizon, `${col}9`), major(expected.annualReserveMinor));
  assertExact(`${expected.month} annual due`, valueAt(horizon, `${col}13`), major(expected.annualDueMinor));
  assertExact(`${expected.month} goal plan`, valueAt(horizon, `${col}10`), major(expected.goalPlanMinor));
  assertExact(`${expected.month} spendable after plan`, valueAt(horizon, `${col}12`), major(expected.spendableAfterPlanMinor));
}

const typedDates = [
  valueAt(settings, "B3"),
  ...annualRows.map((_, index) => valueAt(annual, `D${index + 6}`)),
  ...operationRows.map((_, index) => valueAt(operations, `A${index + 6}`)),
];
if (typedDates.some((value) => !(value instanceof Date))) {
  throw new Error("Workbook input dates must remain typed Date values");
}
const typedMoney = [
  valueAt(settings, "B5"),
  ...annualRows.map((_, index) => valueAt(annual, `E${index + 6}`)),
  ...monthlyRows.map((_, index) => valueAt(monthly, `C${index + 6}`)),
  ...seasonalRows.map((_, index) => valueAt(seasonal, `C${index + 6}`)),
  ...flexibleRows.map((_, index) => valueAt(flexible, `C${index + 6}`)),
  ...operationRows.map((_, index) => valueAt(operations, `D${index + 6}`)),
  ...goalRows.map((_, index) => valueAt(goals, `B${index + 6}`)),
];
if (typedMoney.some((value) => typeof value !== "number" || !Number.isFinite(value))) {
  throw new Error("Workbook money inputs must remain finite numeric values");
}

const tableNames = [
  ...annual.tables.items,
  ...monthly.tables.items,
  ...seasonal.tables.items,
  ...flexible.tables.items,
  ...operations.tables.items,
  ...goals.tables.items,
].map((table) => table.name);
const expectedTableNames = [
  annualTable.name,
  monthlyTable.name,
  seasonalTable.name,
  flexibleTable.name,
  operationsTable.name,
  goalsTable.name,
];
if (JSON.stringify(tableNames) !== JSON.stringify(expectedTableNames)) {
  throw new Error(`Unexpected input table set: ${tableNames.join(", ")}`);
}
const extensionFormulas = [
  formulaAt(annual, "G25"),
  formulaAt(annual, "H25"),
  formulaAt(annual, "I25"),
  formulaAt(annual, "K25"),
  formulaAt(annual, "L25"),
  formulaAt(flexible, "D25"),
  formulaAt(flexible, "E25"),
  formulaAt(flexible, "F25"),
  formulaAt(flexible, "G25"),
  formulaAt(goals, "E15"),
];
if (extensionFormulas.some((value) => typeof value !== "string" || !value.startsWith("="))) {
  throw new Error("Reserved table rows must keep calculated formulas for new entries");
}
const structuredFormulaSamples = [
  formulaAt(flexible, "D6"),
  formulaAt(horizon, "B6"),
  formulaAt(horizon, "B7"),
  formulaAt(horizon, "B8"),
  formulaAt(horizon, "B9"),
  formulaAt(horizon, "B10"),
  formulaAt(horizon, "B13"),
  formulaAt(dashboard, "A4"),
];
if (structuredFormulaSamples.some((value) => !/AnnualCommitments|MonthlyExpenses|SeasonalExpenses|FlexibleBudgets|Operations|Goals/u.test(value))) {
  throw new Error("Key formulas must use expandable structured table references");
}

const previewRanges = {
  "Быстрый старт": "A1:H21",
  "Дашборд": "A1:N44",
  "Горизонт 24 мес": "A1:Y14",
  "Крупные и ежегодные": "A1:L25",
  "Ежемесячные": "A1:F15",
  "Сезонные": "A1:Q15",
  "Повседневные": "A1:H25",
  "Операции": "A1:F20",
  "Цели": "A1:F15",
  "Настройки": "A1:F11",
  "Справочники": "A1:F15",
};
for (const sheet of sheets) {
  const png = await wb.render({ sheetName: sheet.name, range: previewRanges[sheet.name], scale: 0.85, format: "png" });
  await fs.writeFile(path.join(previewDir, `${sheet.name}.png`), new Uint8Array(await png.arrayBuffer()));
}

const output = await SpreadsheetFile.exportXlsx(wb);
await output.save(outputPath);
await sanitizeXlsx(outputPath);
await assertSafeFileTarget(outputPath, outputDir);

const finalWorkbook = await SpreadsheetFile.importXlsx(await FileBlob.load(outputPath));
const sheetInspection = await finalWorkbook.inspect({ kind: "sheet", include: "id,name", maxChars: 5000 });
const horizonInspection = await wb.inspect({
  kind: "table",
  sheetId: "Горизонт 24 мес",
  range: "A4:Y14",
  include: "values,formulas",
  tableMaxRows: 14,
  tableMaxCols: 25,
  maxChars: 12000,
});
const inputInspection = await wb.inspect({
  kind: "table",
  sheetId: "Настройки",
  range: "A3:B9",
  include: "values,formulas",
  tableMaxRows: 10,
  tableMaxCols: 3,
  maxChars: 4000,
});
const formulaErrors = await finalWorkbook.inspect({
  kind: "match",
  searchTerm: "#REF!|#DIV/0!|#VALUE!|#NAME\\?|#N/A",
  options: { useRegex: true, maxResults: 200 },
  summary: "sanitized final artifact formula error scan",
  maxChars: 12000,
});
const formulaErrorRecords = formulaErrors.ndjson.trim()
  ? formulaErrors.ndjson.trim().split(/\r?\n/u).map((line) => JSON.parse(line))
  : [];
const formulaErrorCount = formulaErrorRecords.reduce((total, record) => {
  if (Array.isArray(record.matches)) return total + record.matches.length;
  if (record.kind === "match" && record.address) return total + 1;
  return total;
}, 0);
if (formulaErrorCount !== 0) {
  throw new Error(`Formula error scan returned ${formulaErrorCount} matches`);
}

const july = expectedByMonth.get("2026-07");
const september = expectedByMonth.get("2026-09");
const january = expectedByMonth.get("2027-01");
if (!july || !september || !january) throw new Error("Canonical G-002 expected months are incomplete");
const compactRecords = [
  {
    kind: "phase2-meta",
    fixtureId: fixture.fixtureId,
    schemaVersion: fixture.schemaVersion,
    fixturePath: "contracts/fixtures/g-002.json",
    sheetCount: sheets.length,
    sheets: sheets.map((sheet) => sheet.name),
    inputTables: tableNames,
    formulaErrorCount,
    finalArtifactScan: true,
    outputSafety: {
      canonicalDirectChild: true,
      fileTargetsNotSymlinks: true,
      symlinkEscapeProbe,
      privateRandomPreviewDirectory: true,
    },
    previews: sheets.map((sheet) => ({
      file: `${sheet.name}.png`,
      range: previewRanges[sheet.name],
    })),
  },
  {
    kind: "typed-inputs",
    dates: { count: typedDates.length, allTypedDates: true, numberFormat: DATE },
    money: { count: typedMoney.length, allNumeric: true, numberFormat: RUB },
    validations: {
      horizonMonths: "Настройки!B4 => [12,24]",
      annualCategory: "Крупные и ежегодные!B6:B25",
      annualRecurrence: "Крупные и ежегодные!C6:C25",
      annualActive: "Крупные и ежегодные!J6:J25",
      monthlyCategoryActiveAccount: "Ежемесячные!B6:B25,E6:F25",
      seasonalCategoryMonthsActive: "Сезонные!B6:B25,E6:Q25",
      operationsTypeCategoryAccount: "Операции!B6:C505,E6:E505",
      flexibleCategoryActive: "Повседневные!A6:A25,H6:H25",
      goalsActive: "Цели!F6:F15",
    },
  },
  {
    kind: "structured-extension",
    reservedRows: {
      AnnualCommitments: "A6:L25",
      MonthlyExpenses: "A6:F25",
      SeasonalExpenses: "A6:Q25",
      FlexibleBudgets: "A6:H25",
      Operations: "A6:F505",
      Goals: "A6:F15",
    },
    lastReservedRowFormulaCount: extensionFormulas.length,
    mutationProbes,
    structuredFormulaSamples,
  },
  {
    kind: "canonical-exact-values",
    july2026: {
      income: valueAt(horizon, "B5"),
      monthly: valueAt(horizon, "B6"),
      seasonal: valueAt(horizon, "B7"),
      flexible: valueAt(horizon, "B8"),
      reserve: valueAt(horizon, "B9"),
      goal: valueAt(horizon, "B10"),
      free: valueAt(horizon, "B12"),
      expectedFree: major(july.spendableAfterPlanMinor),
    },
    september2026: {
      seasonal: valueAt(horizon, "D7"),
      free: valueAt(horizon, "D12"),
      expectedFree: major(september.spendableAfterPlanMinor),
    },
    january2027: {
      dueFromReserve: valueAt(horizon, "H13"),
      free: valueAt(horizon, "H12"),
      expectedFreeWithoutSecondSubtraction: major(january.spendableAfterPlanMinor),
      freeFormula: formulaAt(horizon, "H12"),
      dueFormula: formulaAt(horizon, "H13"),
    },
  },
  {
    kind: "chart",
    title: chartTitle,
    helperRange: "Дашборд!A20:D44",
    firstLabel: valueAt(dashboard, "A21"),
    lastLabel: valueAt(dashboard, "A44"),
    seriesCount: chart.series.items.length,
  },
];
const compactInspection = [
  ...compactRecords.map((record) => JSON.stringify(record)),
  sheetInspection.ndjson.trim(),
  inputInspection.ndjson.trim(),
  horizonInspection.ndjson.trim(),
  ...formulaErrorRecords.map((record) => JSON.stringify(record)),
].filter(Boolean).join("\n") + "\n";
await Promise.all([
  fs.writeFile(inspectionPath, compactInspection, "utf8"),
  fs.writeFile(previewInspectionPath, compactInspection, "utf8"),
  fs.writeFile(previewFormulaErrorsPath, formulaErrors.ndjson, "utf8"),
]);
await assertSafeFileTarget(inspectionPath, outputDir);

console.log(JSON.stringify({
  outputId,
  outputPath,
  inspectionPath,
  previewDir,
  previewInspectionPath,
  previewFormulaErrorsPath,
  formulaErrorCount,
  sheets: sheets.map((sheet) => sheet.name),
}));
