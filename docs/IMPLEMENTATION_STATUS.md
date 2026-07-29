# Статус реализации

Дата среза: 30 июля 2026 года. Финальный локальный audit Phase 10 принят. Базовый pre-commit HEAD аудита — `8234806`; точный SHA текущего implementation-checkpoint будет записан отдельным companion evidence-коммитом в [каноническом плане](../plans/family-budget-implementation.md).

## Текущий продукт

### Excel MVP

- текущий артефакт: [`outputs/2026-07-29-phase2-rc1/family-budget-mvp.xlsx`](../outputs/2026-07-29-phase2-rc1/family-budget-mvp.xlsx);
- checkpoint: `658d3b8` (`feat(excel): align workbook with canonical golden fixtures`);
- `11` листов, `6` структурированных таблиц, `48 795` байт, SHA-256 `478e173ce41f9231c84c5831ebf0704347cdfa81d09b6eefe87430b4056e1ed9`;
- [inspection](../outputs/2026-07-29-phase2-rc1/family-budget-mvp.xlsx.inspect.ndjson): `12 428` байт, SHA-256 `da2125b38b934bdd27d50fbc1226d94aed372cd9d4059fe901319d1d1558cb8a`;
- финальный sanitized XLSX повторно импортирован; formula scan `#REF!/#DIV/0!/#VALUE!/#NAME?/#N/A` — `0`;
- подтверждены `8` типизированных дат, `17` числовых денежных значений, `15` validation rules и mutation/rollback всех `6` таблиц;
- архив содержит `34` записи без VBA/macros, external links/connections и локальных путей;
- все `11` preview-листов прошли визуальную проверку; временные PNG не коммитились.

Точные значения G-002: июль 2026 — доход `180 000 ₽`, ежемесячные `53 000 ₽`, повседневные `53 000 ₽`, резерв `19 809 ₽`, цель `10 000 ₽`, свободно `44 191 ₽`; сентябрь — сезонные `31 000 ₽`, свободно `13 191 ₽`; январь 2027 — платёж из резерва `72 000 ₽`, свободно `13 191 ₽` без второго вычитания. После первой оплаты ежегодный платёж резервируется построчно как `ROUNDUP(Сумма / 12; 0)`.

Fresh Phase 10 regeneration на Node.js `24.14` дала `11` листов, `6` таблиц, `15` validations, `0` formula errors и безопасный пакет из `34` записей. Fresh XLSX: `48 793` байта, SHA-256 `508c68282406f9a760bd2281dff1735069493ab20d537950c635377d0d31ffac`; inspection: `12 428` байт, SHA-256 `90d2dc3c07894c2cf7c07f331a0921a882a7cb19a4d15537972d03a2a4d8fa88`. Отличие от tracked release-книги ограничено случайными relationship/sheet IDs; после нормализации семантика совпадает.

Книга не зашифрована и намеренно не включает `sheetProtection`, чтобы пользователь мог редактировать таблицы. Цвета и Excel Tables не являются security-контролем. Реальные Microsoft Excel Accessibility Checker, клавиатурная навигация и масштаб 200% остаются ручным gate.

Legacy workbook под `outputs/legacy/` сохранён только для расследования и не является текущим результатом.

### Web/PWA

- чистый первый запуск не создаёт скрытых demo-операций; бюджет создаётся через onboarding;
- доступны CRUD крупных/ежегодных, ежемесячных, сезонных и повседневных планов;
- доступны создание, изменение и удаление дохода, расхода, возврата, перевода и взноса в цель;
- дашборды показывают план/факт, горизонты 12/24, ближайшие платежи, числовую таблицу и текстовое резюме;
- поиск и фильтры операций не меняют исходные данные;
- IndexedDB v2 поддерживает versioned migrations, CAS, атомарные JSON backup/restore/clear и metadata последней копии;
- CSV — отдельный Excel-совместимый экспорт с BOM и защитой от formula injection, а не backup;
- PWA имеет installable manifest, Workbox offline shell, navigation fallback, controlled update, CSP и anti-framing headers;
- автоматизированы keyboard/focus/semantics, touch targets, narrow phone/iPad/landscape и эквивалент zoom 200%;
- отмена перехода при dirty-черновике сохраняет сумму операции `1 234` и сумму планирования `4 321`; подтверждение отбрасывает черновик, а закрытие окна защищено `beforeunload`;
- restore принимает валидный 24-месячный горизонт `9997-12 → 9999-11`, а невозможный горизонт от `9998-02` и backup с валютой не `RUB` отклоняются без записи даже при валидном checksum.

Финальный PWA gate: Chromium E2E `5/5`; offline reload сохраняет IndexedDB-данные; controlled update и navigation guards сохраняют несохранённый ввод; release scan — `13` артефактов и `10` уникальных precache URL. Реальный HTTPS Safari/Home Screen/VoiceOver/Files gate на семейном iPhone/iPad не выполнялся.

### Domain и storage

- G-000/G-001/G-002 импортируются через `packages/test-fixtures` и валидируются без второй копии арифметики;
- деньги и промежуточные значения — safe integer minor units;
- резерв каждого commitment отдельно округляется вверх до целого рубля, затем суммы складываются;
- ежегодный платёж после первой даты переходит на 12-месячный цикл, разовый завершается;
- due day 29/30/31 нормализуется к последнему дню короткого месяца;
- проверяются duplicate/unknown references, excess refund, unsafe integer, malformed/oversized backup и prototype-pollution keys;
- restore валидирует весь документ, валюту `RUB` и допустимость полного планового горизонта до одной write-транзакции; повреждённый или семантически недопустимый импорт не меняет сохранённое состояние.

Канонические результаты: G-000 — доход/расходы/капитал `100 000 / 76 500 / 23 500 ₽`; G-002 — июльский резерв/свободно `19 809 / 44 191 ₽`, сентябрьские сезонные/свободно `31 000 / 13 191 ₽`, due в январе 2027 `72 000 ₽`, due в июне 2028 `0 ₽`.

### Android

- checkpoint `724328c` содержит локальный Capacitor/Android pipeline; prerequisite `b2152d1` показывает нативный статус «локально на устройстве»;
- один production React build копируется в локальные assets APK/AAB; `server.url` отсутствует;
- JDK `21.0.12`, Android SDK `36`, Gradle `8.14.3`, `minSdk 24`, `targetSdk/compileSdk 36`;
- рабочая локальная identity: `ru.familybudget.app`, `versionCode 1`, `versionName 0.1.0-local`; package name ещё не подтверждён для магазина;
- debug APK: `4 292 140` байт, SHA-256 `941918f60eca6df35251472b3a498c3f1c87375092c00dec2160d2eb820e7212`;
- неподписанный release AAB: `1 538 078` байт, SHA-256 `7f9d9b81c6a151dea7cb8c8fc0e894353b595edcdf02f18306784fcbda0694d8`;
- APK содержит один канонический debug v2 signer с сертификатом SHA-256 `16775a00f42bf0d89e957a51ad19c0b55b5494a28934a27043eb52e7745bddc6`; AAB остаётся неподписанным;
- artifact scan подтверждает `0` системных permissions, только экспортированную launcher `MainActivity`, `15` локальных web assets и отсутствие `server.url`, remote navigation allowlist, release signing config, keystore и credentials; Android backup/device transfer, cleartext/mixed content, WebView debugging и native logging отключены;
- G-000 и G-002 восстановлены через реальный DocumentsUI при `airplane_mode_on=1`; exact payload, счётчики и UI сохраняются после force-stop, remote requests — `0`;
- финальный cold-offline G-000 содержит accounts/categories/budgets/flexible lines/goals/commitments/schedules/transactions `2/3/1/3/0/0/0/4`, операций `4`;
- нативный export: отмена не создаёт файл или metadata; JSON `3 917` байт проходит exact checksum/restore; CSV `483` байта содержит BOM, header и `4` строки; перезапись stale-файла `13 903 → 3 917` байт обрезает хвост через `wt`.

Debug APK и AAB — локальные generated-артефакты. AAB не подписан и не загружался в RuStore.

## Закрытые checkpoints

| Фаза | Implementation checkpoint | Evidence checkpoint |
|---|---|---|
| 0. Baseline | `87a841a` | `caa2107` |
| 1. Fixtures/domain | `cd334a2` | `4cd5184` |
| 2. Excel | `658d3b8` | `8234806` |
| 3. Storage v2 | `57f95c6` | `f8d8fd6` |
| 4. Onboarding | `8999db4`, `634d3b8` | `fadbdcf` |
| 5. Planning CRUD | `fa49649`, `b6ae55a`, `290b762`, `cae46f5` | `5955c1f` |
| 6. Operations | `de204b8` | `a3be654` |
| 7. Dashboard/recovery | `8742292` | `fb1af00` |
| 8. PWA hardening | `c11034f` | `bc9d7c4` |
| 9. Android | `b2152d1`, `724328c` | `5330e7f` |
| 10. Local RC audit | Текущий принятый change set; SHA фиксируется после commit | Companion evidence-коммит в плане |

## Финальный принятый автоматизированный срез

- Node.js `24.17`, pnpm `11.9`, frozen offline install для `6` workspaces;
- root `pnpm verify`: `332/332` теста — Android Node `8`, fixtures `6`, storage `62`, domain `26`, web `230`; пять TypeScript typechecks и production build green;
- Chromium E2E: `5/5`;
- release scan: `13` артефактов, `10` уникальных precache URL;
- `pnpm audit` / `pnpm audit --prod`: `0/0` vulnerabilities;
- storage targeted regression: `57/57`; domain exact-value runner: `2/2`;
- fresh Excel: `11` листов, `6` таблиц, `15` validations, `0` formula errors, `34` безопасные package entries; normalized semantic identity с release-книгой;
- Android на JDK `21.0.12`, SDK `36`, Gradle `8.14.3`: sync, unit tests, lint, clean APK, unsigned AAB и artifact scan green;
- domain/PWA/Android подтвердили G-000 `100 000 / 76 500 / 23 500 ₽` и G-002 июль `19 809 / 44 191 ₽`, сентябрь `31 000 / 13 191 ₽`, январь 2027 due `72 000 ₽`, июнь 2028 due `0 ₽`;
- PWA backup round-trip для G-000/G-002 сохранил exact payload; Android восстановил оба файла через DocumentsUI offline и сохранил payload/UI после force-stop;
- начальные code review findings blocker/high/medium/low `0/1/0/2` исправлены; финальный code review — `APPROVE 0/0/0/0`;
- начальные security/privacy findings `0/0/3/1` исправлены; финальный security review — `APPROVE 0/0/0/0`;
- scans не нашли secrets, keys/keystores, production URL, remote executable code, финансовые данные в логах, локальные пути или source maps; Git remote отсутствует.

## Ручные gate и границы

Пользователь вручную выполняет:

- реальный Excel Accessibility Checker, клавиатура и масштаб 200%;
- HTTPS/Safari/Home Screen/VoiceOver/offline/update/Files на семейном iPhone/iPad;
- слабые Android-устройства и разные версии System WebView;
- окончательные бренд, package name, platform minimums и владелец RuStore-аккаунта;
- release signing key и его защищённые резервные копии;
- privacy/legal, карточка магазина, поддержка и проверка на 5–10 семьях;
- отдельно авторизованная закрытая RuStore alpha и только затем решение о rollout.

Приложение само не загружает экспорт: пользователь выбирает назначение в системном DocumentsUI. Выбранная cloud-папка может синхронизировать незашифрованный JSON/CSV своим провайдером; XLSX также является локальным незашифрованным файлом.

Не выполнялись: production deploy/push, signing, создание release key, RuStore upload/publish, cloud sync и production rollout.
