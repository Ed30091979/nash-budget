/// <reference types="node" />
import { readFileSync } from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { designTouchTargetMinimum } from "../../design-contract";
import { makeG000State } from "../operations/test-fixture";
import { DataManagementScreen } from "./DataManagementScreen";

describe("data-management UI", () => {
  it("explains readable exports, backup recency, trusted restore and explicit deletion", () => {
    const budget = {
      ...makeG000State(),
      transactions: [
        ...makeG000State().transactions,
        makeG000State().transactions[0]!,
        makeG000State().transactions[1]!,
      ],
    };
    const html = renderToStaticMarkup(
      <DataManagementScreen
        budget={budget}
        lastSuccessfulBackup="2026-07-17T09:30:00.000Z"
        onCreateBackup={vi.fn(async () => ({ text: "{}", createdAt: "2026-07-17T09:30:00.000Z" }))}
        onRecordSuccessfulBackup={vi.fn(async () => undefined)}
        onRestoreBackup={vi.fn(async () => undefined)}
        onPersistClear={vi.fn(async () => undefined)}
        onPublishEmpty={vi.fn()}
      />,
    );

    expect(html).toContain("Последняя успешная копия:");
    expect(html).toContain("6 операций");
    expect(html).toContain(
      "Приложение само не загружает файлы ни на свой сервер, ни на сторонние серверы.",
    );
    expect(html).toContain("Место сохранения выбираете вы.");
    expect(html).toContain(
      "Если выбрать облачную папку, незашифрованный файл может синхронизироваться с облаком.",
    );
    expect(html).not.toContain("В облако они не отправляются.");
    expect(html).toContain("JSON не зашифрован");
    expect(html).toContain("CSV не зашифрован");
    expect(html).toContain("Это таблица для Excel, а не резервная копия");
    expect(html).toContain("импорт CSV не поддерживается");
    expect(html).toContain("только свою доверенную JSON-копию");
    expect(html).toContain('accept=".json,application/json"');
    expect(html).toContain('id="backup-file"');
    expect(html).toContain('for="backup-file"');
    expect(html).toContain('aria-describedby="json-restore-notice"');
    expect(html).toContain('aria-describedby="json-backup-notice"');
    expect(html).toContain('aria-describedby="csv-export-notice"');
    expect(html).toContain('aria-busy="false"');
    // Копия — первая строка списка, удаление — последняя, и оба названы словами.
    expect(html.indexOf("Сделать резервную копию")).toBeLessThan(html.indexOf("Удалить данные с этого устройства"));
    expect(html).toContain("Удалить данные с этого устройства");
    expect(html).not.toContain('type="file" name=');
  });

  it("contains no raw HTML, logging, URL query or direct browser-storage writes", () => {
    const source = [
      readFileSync(new URL("./DataManagementScreen.tsx", import.meta.url), "utf8"),
      readFileSync(new URL("./model.ts", import.meta.url), "utf8"),
      readFileSync(new URL("./recovery.ts", import.meta.url), "utf8"),
    ].join("\n");

    expect(source).not.toContain("dangerouslySetInnerHTML");
    expect(source).not.toMatch(/console\.(?:log|error|warn)/);
    expect(source).not.toContain("localStorage");
    expect(source).not.toContain("sessionStorage");
    expect(source).not.toContain("indexedDB");
    expect(source).not.toContain("URLSearchParams");
    expect(source).not.toContain("location.");
    expect(source).not.toContain("error.message");
    expect(source).toContain('role="alertdialog"');
    expect(source).toContain("Удалить все данные");
  });

  it("publishes a backup date and success only after download and metadata persistence", () => {
    const screenSource = readFileSync(
      new URL("./DataManagementScreen.tsx", import.meta.url),
      "utf8",
    );

    expect(screenSource).toMatch(
      /await downloadThenRecordSuccessfulBackup\([\s\S]*await downloadTextFile[\s\S]*setLastBackupAt\(createdAt\);[\s\S]*type: "succeed"/,
    );
    expect(screenSource).not.toMatch(
      /setLastBackupAt\(result\.createdAt\)[\s\S]*downloadTextFile/,
    );
    expect(screenSource).toMatch(
      /activity: "csv"[\s\S]*await downloadTextFile\(prepareOperationsCsvDownload\(budget\)\)[\s\S]*type: "succeed"/,
    );
    // Third review: a copy this build will not restore is downloaded and said so, and is kept as
    // written with a warning — never recorded as the last successful one.
    const warned = screenSource.slice(screenSource.indexOf("if (result.restoreWarning) {"), screenSource.indexOf("const createdAt = await downloadThenRecordSuccessfulBackup("));
    expect(warned).toContain("await downloadTextFile(prepareJsonDownload(result.text));");
    expect(warned).toContain("setWarnedBackupAt(result.createdAt);");
    expect(warned).toContain("return;");
    expect(warned).not.toMatch(/onRecordSuccessfulBackup|setLastBackupAt/u);
    expect(screenSource).toContain("записана с предупреждением: эта версия её не восстановит.");
  });

  it("keeps a visible focus indicator when the hidden restore input receives keyboard focus", () => {
    const styles = readFileSync(
      new URL("../../styles.css", import.meta.url),
      "utf8",
    );

    expect(styles).toMatch(/\.file-button:focus-within\s*\{[\s\S]*outline:\s*3px\s+solid\s+var\(--focus\);/);
    const declared = /\.file-button\s*\{[^}]*min-height:\s*(\d+)px;/su.exec(styles);
    expect(Number(declared?.[1])).toBeGreaterThanOrEqual(designTouchTargetMinimum());
  });
});
