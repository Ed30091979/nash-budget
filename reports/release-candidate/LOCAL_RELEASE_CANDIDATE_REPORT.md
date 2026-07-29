# Локальный release-candidate audit

Дата: 30 июля 2026 года.

Базовый pre-commit HEAD: `8234806` (`docs(plan): record phase 2 evidence`).

Статус: финальный локальный audit Phase 10 принят. Точный SHA текущего implementation-checkpoint намеренно не указан до создания коммита; его зафиксирует отдельный companion evidence-коммит в [плане реализации](../../plans/family-budget-implementation.md).

## Границы

Release candidate local-first включает [Excel MVP](../../outputs/2026-07-29-phase2-rc1/family-budget-mvp.xlsx), PWA и локальную Android/Capacitor-сборку. Текущая продуктовая сводка находится в [статусе реализации](../../docs/IMPLEMENTATION_STATUS.md), критерии — в [QA acceptance](../../docs/QA_ACCEPTANCE.md).

Не выполнялись и не подразумеваются: deploy, production push, signing, создание или использование release key, RuStore upload/alpha/production rollout и семейная cloud sync.

## Как было / как стало

В baseline `87a841a` было `24/24` теста, четыре TypeScript-проверки, production PWA build, domain/storage/PWA и базовая Capacitor-конфигурация. Не были закрыты G-002 parity, текущий Excel, versioned migrations, пустой onboarding, полный planning/operations/recovery UI, PWA hardening, native Android project и AAB.

К Phase 10 приняты все локальные поверхности: единый domain и fixtures, редактируемый Excel из G-002, PWA с offline/backup/recovery и Android local-assets build с реальным DocumentsUI import/export. Финальный прогон подтвердил `332/332` теста, cross-surface exact values и backup round-trip; свежие code и security reviews завершились `APPROVE 0/0/0/0`.

## Checkpoints фаз

| Фаза | Implementation/fix SHA | Evidence SHA | Принятый результат |
|---|---|---|---|
| 0. Baseline | `87a841a` | `caa2107` | Воспроизводимый source/docs/contracts checkpoint, legacy XLSX исключён. |
| 1. Fixtures/domain | `cd334a2` | `4cd5184` | G-002, rounding/date/domain invariants и schema gates. |
| 2. Excel | `658d3b8` | `8234806` | Новый XLSX/inspection из G-002, formula/security/visual gates. |
| 3. Storage v2 | `57f95c6` | `f8d8fd6` | Migrations, atomic restore, integrity, CSV и clear. |
| 4. Onboarding | `8999db4`, `634d3b8` | `fadbdcf` | Атомарное создание пустого бюджета без demo seed. |
| 5. Planning CRUD | `fa49649`, `b6ae55a`, `290b762`, `cae46f5` | `5955c1f` | Четыре слоя планирования, long-horizon semantics и CAS. |
| 6. Operations | `de204b8` | `a3be654` | Все виды операций, атомарные переводы и limit signals. |
| 7. Dashboard/recovery | `8742292` | `fb1af00` | Dashboard/search/backup UI/CSV и recovery race fix. |
| 8. PWA hardening | `c11034f` | `bc9d7c4` | Offline/update/accessibility/CSP/release scan. |
| 9. Android | `b2152d1`, `724328c` | `5330e7f` | Local-assets Capacitor project, APK/AAB, emulator/artifact gates. |
| 10. Local RC audit | Текущий принятый change set; SHA после commit | Companion evidence-коммит в плане | Финальный clean rebuild, cross-surface live QA, fixes и full-range reviews приняты. |

## Финальная трассировка QA gates

| QA gate | Команда или проверка | Финальный результат |
|---|---|---|
| Runtime и зависимости | Node.js `24.17`, pnpm `11.9`; `pnpm install --frozen-lockfile --offline` | Green, `6` workspaces |
| Root tests/type/build | `pnpm verify` | `332/332`: Android Node `8`, fixtures `6`, storage `62`, domain `26`, web `230`; пять typechecks и production build green |
| Storage regression | targeted migrations/restore/backup suite | `57/57` |
| Domain exact values | read-only exact runner | `2/2` |
| PWA browser | `pnpm e2e` | Chromium `5/5` |
| PWA artifact security | `pnpm release:scan` | `13` артефактов, `10` уникальных precache URL |
| Dependency vulnerabilities | `pnpm audit`; `pnpm audit --prod` | `0/0` |
| Excel с нуля | Node.js `24.14`, artifact-tool generation/import/scan | `11` листов, `6` таблиц, `15` validations, `0` formula errors, `34` безопасные package entries |
| Android с нуля | JDK `21.0.12`, SDK `36`, Gradle `8.14.3`; `pnpm --filter @family-budget/android verify:android` | Sync, Node tests, Gradle unit tests, lint, clean APK, unsigned AAB и artifact scan green |
| Cross-surface fixture | domain runner, PWA production profile, Android emulator | G-000/G-002 exact; Android import через DocumentsUI offline, force-stop persistence, `0` remote requests |
| PWA backup | G-000 и G-002 export/restore | Exact payload, UUID, даты, суммы и счётчики сохранены |
| Android native export | реальный DocumentsUI create/cancel/overwrite | JSON/CSV exact, cancel без side effects, overwrite без хвоста |
| Repository/artifact scan | secrets/private keys/keystores/production endpoints/remote executable code/financial logs/absolute local paths/source maps | `0` genuine findings; Git remote отсутствует |
| Full-range code review | свежий reviewer после исправлений | `APPROVE`, blocker/high/medium/low `0/0/0/0` |
| Full-range security/privacy review | другой свежий reviewer после исправлений | `APPROVE`, blocker/high/medium/low `0/0/0/0` |
| Excel native accessibility | Microsoft Excel Accessibility Checker, keyboard, 200% | Ручной gate пользователя |
| iOS/PWA device gate | HTTPS Safari, Home Screen, VoiceOver, offline/update/Files | Ручной gate пользователя |
| Android device gate | Слабое физическое устройство, разные System WebView | Ручной gate пользователя |

## Контрольные значения и backup parity

| Fixture | Канонический результат | Domain | PWA | Android |
|---|---|---|---|---|
| G-000 | доход `100 000 ₽`; расходы `76 500 ₽`; капитал `23 500 ₽` | Exact | Exact после backup restore | Exact после DocumentsUI restore offline |
| G-002, июль 2026 | резерв `19 809 ₽`; свободно `44 191 ₽` | Exact | Exact после backup restore | Exact после DocumentsUI restore offline |
| G-002, сентябрь 2026 | сезонные `31 000 ₽`; свободно `13 191 ₽` | Exact | Exact | Exact |
| G-002, январь 2027 | due `72 000 ₽` | Exact | Exact | Exact |
| G-002, июнь 2028 | due `0 ₽` | Exact | Exact | Exact |

Оба Android restore выполнены через реальный системный DocumentsUI при `airplane_mode_on=1`. Exact payload, collection counts и UI сохранились после force-stop; наблюдалось `0` remote requests. Финальный cold-offline G-000 содержит accounts/categories/budgets/flexible lines/goals/commitments/schedules/transactions `2/3/1/3/0/0/0/4`, операций `4`.

PWA backup round-trip для G-000 и G-002 сохранил exact payload. Restore с повреждённым checksum, валютой не `RUB` даже при валидном checksum или невозможным 24-месячным горизонтом отклоняется до записи.

## Excel reproducibility

Tracked release-артефакт остаётся текущим Excel MVP:

| Артефакт | Размер, байт | SHA-256 | Статус |
|---|---:|---|---|
| `outputs/2026-07-29-phase2-rc1/family-budget-mvp.xlsx` | 48 795 | `478e173ce41f9231c84c5831ebf0704347cdfa81d09b6eefe87430b4056e1ed9` | Tracked release Excel |
| `outputs/2026-07-29-phase2-rc1/family-budget-mvp.xlsx.inspect.ndjson` | 12 428 | `da2125b38b934bdd27d50fbc1226d94aed372cd9d4059fe901319d1d1558cb8a` | Tracked inspection |

Fresh Phase 10 regeneration на Node.js `24.14`:

| Артефакт | Размер, байт | SHA-256 | Результат |
|---|---:|---|---|
| Fresh XLSX | 48 793 | `508c68282406f9a760bd2281dff1735069493ab20d537950c635377d0d31ffac` | `11` листов, `6` таблиц, `15` validations, formula scan `0` |
| Fresh inspection | 12 428 | `90d2dc3c07894c2cf7c07f331a0921a882a7cb19a4d15537972d03a2a4d8fa88` | `34` safe entries, canonical exact values |

Разница fresh/tracked XLSX ограничена случайными relationship/sheet IDs. Нормализованное семантическое содержимое совпадает; tracked release не заменялся недетерминированными байтами.

## Android artifacts и live export

| Артефакт | Размер, байт | SHA-256 | Статус |
|---|---:|---|---|
| `apps/android/android/app/build/outputs/apk/debug/app-debug.apk` | 4 292 140 | `941918f60eca6df35251472b3a498c3f1c87375092c00dec2160d2eb820e7212` | Generated debug, не для публикации |
| `apps/android/android/app/build/outputs/bundle/release/app-release.aab` | 1 538 078 | `7f9d9b81c6a151dea7cb8c8fc0e894353b595edcdf02f18306784fcbda0694d8` | Generated unsigned, не для публикации |

APK содержит ровно один ожидаемый canonical debug v2 signer; SHA-256 сертификата `16775a00f42bf0d89e957a51ad19c0b55b5494a28934a27043eb52e7745bddc6`. Это debug identity, а не production signing. AAB остаётся неподписанным.

Artifact scan подтвердил `0` системных permissions, только экспортированную launcher `MainActivity`, `15` локальных web assets, отсутствие `server.url`, remote navigation allowlist, release signing config, keystore и credentials. Android backup/device transfer, cleartext/mixed content, WebView debugging и native logging отключены.

Реальный native export через DocumentsUI:

- cancel не изменил backup metadata и не создал файл;
- JSON — `3 917` байт, exact checksum и успешный restore;
- CSV — `483` байта, UTF-8 BOM, header и `4` строки данных;
- overwrite stale JSON обрезал файл `13 903 → 3 917` байт без остаточного хвоста; native writer использует truncating mode `wt`.

## Исправления финального review

Code review сначала нашёл blocker/high/medium/low `0/1/0/2`. Исправлено и перепроверено:

- отмена navigation при dirty-черновике сохраняет сумму операции `1 234` и сумму планирования `4 321`;
- подтверждение navigation отбрасывает черновик; закрытие окна защищено `beforeunload`;
- restore горизонта `24` месяца принимает `9997-12 → 9999-11`;
- restore от `9998-02` отклоняется без записи;
- валюта backup строго `RUB`; modern backup с корректной checksum и `USD` отклоняется без записи.

Security/privacy review сначала нашёл `0/0/3/1`. Исправлено и перепроверено:

- native overwrite открывает файл с truncating mode `wt`;
- privacy copy не обещает отсутствие синхронизации выбранной внешней папки;
- restore строго проверяет `RUB`;
- APK signer policy требует единственный ожидаемый canonical debug v2 signer.

Финальные code и security verdicts: `APPROVE`, blocker/high/medium/low `0/0/0/0` каждый.

## Privacy и security

Финальные scans не нашли secrets, private keys/keystores, production URL, remote executable code, финансовые данные в логах, локальные абсолютные пути или source maps. Git remote отсутствует. Финансовые данные не попадают в URL, localStorage или service-worker cache.

JSON backup, CSV и XLSX являются локальными незашифрованными файлами. Android-приложение само не загружает экспорт: пользователь выбирает место назначения в DocumentsUI. Если выбрана cloud-папка, её провайдер может синхронизировать незашифрованный файл. Приложение не реализует семейную cloud sync.

Не выполнялись deploy, push, signing, создание release key, RuStore upload/publish или production rollout.

## Ручной handoff

Пользователь выполняет:

1. открывает итоговый `.xlsx` в Microsoft Excel macOS/Windows, запускает Accessibility Checker, проходит клавиатурой и проверяет масштаб 200%;
2. предоставляет HTTPS test origin или размещает staging и на семейном iPhone/iPad проходит Safari → «На экран Домой», VoiceOver, offline, controlled update и Files/Share backup/restore;
3. проверяет Android-сборку на слабом физическом устройстве и нескольких версиях System WebView;
4. выбирает окончательные бренд, название, platform minimums, package name, тип и юридического владельца RuStore-аккаунта;
5. создаёт, защищает и резервирует release signing key;
6. проводит privacy/legal review, утверждает декларацию данных/разрешений, политику, поддержку и карточку магазина;
7. проводит проверку на 5–10 семьях минимум неделю;
8. отдельным явно разрешённым запуском загружает подписанный AAB в закрытую RuStore alpha, проверяет upgrade/recovery и только затем решает вопрос rollout.

Production publish не подразумевается ни одним из этих пунктов.
