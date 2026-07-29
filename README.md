# Семейный бюджет

Статус: локальный release candidate, 30 июля 2026 года. Финальный локальный аудит Phase 10 принят; точный SHA текущего implementation-checkpoint будет записан отдельным companion evidence-коммитом в [каноническом плане](plans/family-budget-implementation.md). Deploy, публикация и production signing не выполнялись.

## Что это за проект

Проект состоит из трёх согласованных local-first поверхностей:

1. Excel-шаблон без макросов — самостоятельный редактируемый `.xlsx`, сгенерированный из канонического G-002.
2. React + TypeScript PWA — onboarding пустого бюджета, планирование, операции, дашборды, поиск, JSON backup/restore, CSV-экспорт, offline app shell и управляемое обновление.
3. Android-приложение через Capacitor — тот же production UI и domain-код в локальных assets APK/AAB, без `server.url` и обязательного доступа к PWA-домену.

Excel не является кодовой основой приложения. Excel, PWA и Android используют одни термины, правила учёта и golden fixtures; PWA и Android разделяют TypeScript domain, storage и React UI.

## Текущие артефакты

- [Excel MVP](outputs/2026-07-29-phase2-rc1/family-budget-mvp.xlsx): 11 листов, 6 таблиц, 48 795 байт, SHA-256 `478e173ce41f9231c84c5831ebf0704347cdfa81d09b6eefe87430b4056e1ed9`;
- [компактный Excel inspection](outputs/2026-07-29-phase2-rc1/family-budget-mvp.xlsx.inspect.ndjson): 12 428 байт, SHA-256 `da2125b38b934bdd27d50fbc1226d94aed372cd9d4059fe901319d1d1558cb8a`;
- локальный debug APK: 4 292 140 байт, SHA-256 `941918f60eca6df35251472b3a498c3f1c87375092c00dec2160d2eb820e7212`;
- неподписанный release AAB: 1 538 078 байт, SHA-256 `7f9d9b81c6a151dea7cb8c8fc0e894353b595edcdf02f18306784fcbda0694d8`.

APK/AAB собираются командой `pnpm --filter @family-budget/android verify:android`; эти generated-файлы не коммитятся и не являются store-релизом.

Legacy Excel-прототип сохранён отдельно под `outputs/legacy/` только для расследования. Он не является текущим или release-ready артефактом.

## Уже реализовано

- канонические JSON fixtures G-000/G-001/G-002 и JSON Schema в `contracts/`;
- расчёт 12/24 месяцев в целых копейках: ежемесячные, сезонные и повседневные расходы, резерв к срокам, цели и платежи из резерва без двойного вычитания;
- versioned IndexedDB storage, миграция v1 → v2, CAS-запись, атомарные backup/restore/clear и защита CSV от formula injection;
- первый запуск без скрытого demo seed и пошаговое создание пустого бюджета;
- CRUD четырёх слоёв планирования и операций `income`, `expense`, `refund`, `transfer`, `goal contribution`;
- дашборд, горизонты 12/24, ближайшие платежи, доступное числовое резюме, поиск и фильтры;
- installable PWA с offline navigation, controlled update, CSP/anti-framing headers и автоматизированными accessibility gates;
- локальный Android/Capacitor pipeline с debug APK и неподписанным AAB, artifact scan и offline emulator smoke;
- нативный Android-экспорт JSON/CSV через системный DocumentsUI без запроса storage permissions: отмена не создаёт файл и metadata, перезапись обрезает старый хвост.

Финальный прогон на Node.js `24.17` и pnpm `11.9` подтвердил frozen offline install для `6` workspaces и `332/332` теста в `pnpm verify`: Android Node `8`, fixtures `6`, storage `62`, domain `26`, web `230`; пять TypeScript typechecks и production build green. Chromium E2E — `5/5`, release scan — `13` артефактов и `10` уникальных precache URL, dependency audits — `0/0`. Excel formula scan — `0`, Android JDK 21/SDK 36/Gradle pipeline — green. Полные доказательства находятся в [локальном RC-отчёте](reports/release-candidate/LOCAL_RELEASE_CANDIDATE_REPORT.md).

## Запуск web/PWA

Требуются Node.js 24+ и pnpm 11.9+.

```bash
pnpm install --frozen-lockfile --offline
pnpm verify
pnpm dev
```

Production preview после `pnpm build`:

```bash
pnpm --filter @family-budget/web preview
```

Дополнительные локальные gates:

```bash
pnpm e2e
pnpm release:scan
pnpm audit
pnpm audit --prod
```

Для полного Android gate требуются JDK 21 и Android SDK 36:

```bash
pnpm --filter @family-budget/android verify:android
```

## Документация

- [Канонический план реализации](plans/family-budget-implementation.md)
- [Точный статус реализации](docs/IMPLEMENTATION_STATUS.md)
- [Продукт и границы MVP](docs/PRODUCT_SPEC.md)
- [Спецификация Excel MVP](docs/EXCEL_MVP.md)
- [Архитектура PWA и Android/Capacitor](docs/ARCHITECTURE.md)
- [QA и критерии приёмки](docs/QA_ACCEPTANCE.md)
- [План публикации в RuStore](docs/RUSTORE_RELEASE.md)
- [Журнал решений](docs/DECISIONS.md)
- [Skills, агенты и рабочий процесс](docs/SKILLS_AND_WORKFLOW.md)
- [Источники](docs/SOURCES.md)
- [Локальный release-candidate audit](reports/release-candidate/LOCAL_RELEASE_CANDIDATE_REPORT.md)

## Что намеренно остаётся ручным

Реальный Excel Accessibility Checker и масштаб 200%; HTTPS/Safari/Home Screen/VoiceOver/Files на семейном iPhone/iPad; слабые Android-устройства и разные System WebView; окончательные бренд, package name и владелец RuStore-аккаунта; release signing key; privacy/legal и пользовательская проверка; отдельно авторизованная закрытая RuStore alpha.

JSON backup, CSV и Excel-файл не шифруются приложением. Android-приложение само не загружает экспорт: пользователь выбирает место назначения в DocumentsUI, а выбранная cloud-папка может синхронизировать незашифрованный файл своим провайдером.

Семейная cloud sync не входит в текущий local-first release candidate. Не выполнялись deploy, push, signing, RuStore upload/publish или production rollout.
