# Канонический план реализации семейного бюджета

Статус плана: активный. Рабочая дата исходного среза: 18 июля 2026 года.

## Режим оркестрации и границы

- Канонический рабочий каталог: `/Users/edfurman/Projects/Бюджет семейный`.
- Оркестратор не пишет код: реализацию и исправления выполняют субагенты с явно назначенными, непересекающимися file scope.
- Приёмку проводят свежие субагенты, которые не были исполнителями этой фазы: отдельно code review и security review.
- Ревьюеры работают read-only. Любая находка сначала перепроверяется оркестратором по фактическому файлу, строке, тесту и воспроизводимому значению.
- Параллельная реализация допустима только для непересекающихся файлов. Общие файлы (`package.json`, `pnpm-lock.yaml`, `App.tsx`, этот план) изменяются последовательно.
- Никогда не применять `git add .` или `git add -A`: в implementation-коммит входят только поимённо проверенные файлы текущей фазы; этот план фиксируется отдельным evidence-коммитом.
- Чужие незакоммиченные изменения не изменять, не форматировать и не включать в коммит. При пересечении file scope остановиться и запросить пользователя.
- Запрещены deploy, production push, загрузка в RuStore, запуск rollout и любые изменения production-состояния.
- Реальные действия на семейном iPhone/iPad, владение RuStore-аккаунтом, release signing key, загрузка AAB и alpha/production rollout — ручные gates пользователя, а не автономные действия оркестратора.
- Рабочий `appId` до ручного подтверждения: `ru.familybudget.app`. Его нельзя публиковать или фиксировать как окончательный идентификатор магазина без пользователя.
- Мелкий дефолт по округлению: ежемесячный резерв каждого крупного платежа округляется вверх до целого рубля; деньги в данных по-прежнему хранятся целым числом копеек. Поэтому G-002 должен давать июльский резерв `19 809 ₽`, а не `19 808,45 ₽`. Решение необходимо зафиксировать в `docs/DECISIONS.md` в фазе 1.

## Обязательный цикл каждой фазы

1. До выдачи задач: `git status --short`, `git log --oneline --decorate -12`; зафиксировать исходный SHA и чужие dirty-файлы.
2. Выдать реализацию одному или нескольким субагентам с непересекающимися file scope. Исполнитель не меняет этот план.
3. Оркестратор проверяет diff по каждому заявленному файлу и запускает указанные unit/type/build команды.
4. Оркестратор выполняет live-check и сверяет именно перечисленные даты, суммы и счётчики, а не только наличие экрана.
5. Свежий субагент делает code review; другой свежий субагент делает security/privacy review.
6. Подтверждённые замечания немедленно исправляет исполнитель/отдельный fix-агент только в назначенном scope. Затем повторяются тесты, build, live-check и затронутые review.
7. Оркестратор поимённо stage-ит только файлы реализации/проверок фазы, исключая этот план, сверяет `git diff --cached --name-only` и создаёт implementation checkpoint-коммит A с заявленным сообщением.
8. После коммита A отдельный docs-агент меняет только этот файл: отмечает фазу `[x]`, записывает SHA коммита A и короткое доказательство build/live/code-review/security-review. Оркестратор stage-ит только этот план и создаёт отдельный evidence-коммит B: `docs(plan): record phase N evidence`.
9. SHA evidence-коммита B не пытаются записать внутрь него самого: он подтверждается следующим `git log` и входит в финальный отчёт. Любые последующие исправления снова образуют пару `fix`-коммит A + evidence-коммит B; прежняя галочка до повторной приёмки снимается.

Фаза считается готовой только после полного цикла и двухкоммитного шаблона A/B. Зелёная сборка без live-check и двух независимых review не закрывает фазу.

## Подтверждённый исходный срез

Подтверждено файлами и запуском `pnpm verify` 18 июля 2026 года:

- [x] Существуют продуктовая, архитектурная, QA, Excel и RuStore-документация в `docs/`, JSON Schema и fixtures `G-000`/`G-001` в `contracts/`.
- [x] Существуют monorepo-пакеты `packages/domain`, `packages/storage`, PWA `apps/web-pwa` и базовая Capacitor-конфигурация `apps/android/capacitor.config.ts` с локальным `webDir` и без `server.url`.
- [x] После baseline-hardening `pnpm verify` зелёный: domain `8/8`, storage `2/2`, web `14/14` — всего `24/24` теста, все четыре TypeScript-проверки и Vite production build.
- [x] Production PWA build сгенерировал manifest, service worker и Workbox precache из 13 записей; это подтверждает build, но не заменяет реальный Safari/Home Screen gate.
- [x] Domain-тесты подтверждают G-001: доход `100 000 ₽`, расходы `76 500 ₽`, капитал `23 500 ₽`, основной счёт `13 500 ₽`, накопительный `10 000 ₽`, продукты `−1 500 ₽` и `over_limit`.
- [x] Domain-тесты подтверждают сезонность и повторение: июль/август без сезонного слоя, сентябрь с `31 000 ₽`, страховка `72 000 ₽` в январе 2027/2028, лагерь `90 000 ₽` в июне 2027 и `0 ₽` в июне 2028.
- [x] Старый Excel-прототип сохранён без удаления под `outputs/legacy/` для расследования, но исключён из baseline и не считается текущим или release-ready артефактом.
- [ ] Старый workbook не прошёл повторную приёмку: raw Settings содержит доход `158 000 ₽` при `180 000 ₽` в builder, commitments содержат прежние значения `10 000 ₽`/`17 500 ₽`, а reviewer сообщил ошибку `#NAME`; прежние заявления о полном formula scan отозваны до фазы 2.
- [ ] Полный Excel release gate из `docs/QA_ACCEPTANCE.md` не подтверждён автоматикой и реальным Excel Accessibility Checker.
- [x] Git-baseline создан локально без deploy/push: implementation checkpoint `87a841a` содержит ровно 55 утверждённых source/docs/contracts/test/tool файлов.
- [ ] Parity G-002 не закрыт: текущий domain-тест ожидает `19 808,45 ₽`, тогда как Excel/документация задают округление резерва до `19 809 ₽`.
- [ ] PWA пока стартует с demo seed, не имеет полного CRUD четырёх слоёв и всех типов операций.
- [ ] Storage сохраняет schema version 1 и уже имеет строгий phase-0 restore guard, но versioned migrations, полноценная атомарная restore, CSV и дата backup остаются фазе 3.
- [ ] Нативный Android-проект и AAB отсутствуют.

## Фаза 0. Git-baseline и воспроизводимый исходный checkpoint

Статус: [x] готово  
Checkpoint: `chore(repo): establish reviewed reproducible baseline`  
SHA/доказательство: implementation `87a841a`; 55 файлов по точному pathspec; legacy XLSX сохранён в ignored `outputs/legacy/` и отсутствует в коммите; TypeScript `6.0.3` + Capacitor `8.4.2`, `cap doctor` green; `pnpm verify` — domain `8`, storage `2`, web `14`, всего `24` теста, typechecks/build green; HTTP `/`, `/year`, `/operations`, `/more`, manifest и service worker вернули `200`; browser live smoke: расход `9 000 ₽` изменил доступное на повседневное до `18 000 ₽`, продукты — перелимит `1 000 ₽`, reload сохранил значения; свежие code/security rereviews — `APPROVE`, blocker/high/medium findings отсутствуют; dependency audit — `0` vulnerabilities.

File scope исполнителей:

- `.gitignore` для исключения `node_modules`, временных preview/render-файлов и локальных IDE-файлов;
- `package.json`, `pnpm-lock.yaml` — только выделенный compatibility-исполнитель после проверки TypeScript/Capacitor;
- `apps/web-pwa/src/App.tsx` и отдельный regression-test — только исполнитель исправления legacy normalization;
- `packages/storage/src/index.ts`, `packages/storage/tests/**` — только исполнитель strict restore;
- `tools/build-family-budget.mjs` и исходники sanitizer/inspection в `tools/**` сохраняются в baseline; `.xlsx`, его inspection-output и другие бинарные/generated Excel-артефакты в фазе 0 не пересобираются и не коммитятся;
- `plans/family-budget-implementation.md` меняет только docs-агент после приёмки.

Реализация и проверки:

- [x] Выполнить `git init`; определить default branch локально, без remote и push.
- [x] Составить явный список baseline-файлов через `rg --files -g '!node_modules'`; не включать секреты, кеши, временные файлы и rendered previews, если они не являются заявленным артефактом.
- [x] До прочих изменений выполнить ранний compatibility gate для текущих TypeScript `7.0.2` + Capacitor `8.4.2`: из корня `pnpm verify`, затем `pnpm --filter @family-budget/android exec cap doctor`; сохранить точный вывод и версии Node/pnpm/Java.
- [x] Отдельно проверить candidate TypeScript `6.0.3` с теми же `pnpm verify` и `cap doctor`. Зафиксировать первую полностью зелёную совместимую комбинацию; при равном результате дефолт — закрепить `6.0.3` как консервативную версию для Capacitor 8, обновив только `package.json`/`pnpm-lock.yaml`. Любое сохранение TypeScript 7 требует записанного воспроизводимого основания.
- [x] Исправить legacy normalization без подмены пользовательского G-001/старого состояния на planning demo: совместимо добавить отсутствующие `annualCommitments`/`scheduledExpenses`, сохранить все исходные UUID, суммы, даты и операции; добавить regression-test.
- [x] Ужесточить текущий restore до фазовых migrations: лимит входного JSON `5 MiB`, строгая проверка полного `BudgetState` до `setBudget`/IndexedDB write, понятное отклонение unknown/duplicate IDs и отсутствие частичной записи. Более общий versioned schema/migration остаётся фазе 3.
- [x] Сохранить старый workbook и inspection без удаления в `outputs/legacy/`, но исключить их из baseline через явный `.gitignore`/pathspec; `git diff --cached --name-only` для коммита A не содержит ни одного `.xlsx` или generated inspection-файла.
- [x] Включить в baseline исходники `tools/build-family-budget.mjs` и sanitizer/inspection, чтобы фаза 2 могла воспроизводимо построить новый артефакт; не запускать и не выдавать старую книгу за результат этих инструментов.
- [x] Выполнить финальный root `pnpm verify` и получить не меньше исходных domain `6`, storage `2`, web `3` тестов плюс добавленные regression-тесты; повторить `pnpm --filter @family-budget/android exec cap doctor` на закреплённой версии TypeScript.
- [x] Live-check production preview: открыть `Сегодня`, `Год`, `Операции`, `Ещё`; сверить горизонт `12`/`24`, июль 2026, страховку январь 2027 `72 000 ₽`, лагерь июнь 2027 `90 000 ₽`, июнь 2028 `0 ₽`.
- [x] Свежий code reviewer подтверждает TS/Capacitor gate, сохранность legacy-данных, строгий restore, наличие исходников builder/sanitizer и отсутствие stale workbook в baseline.
- [x] Свежий security reviewer проверяет лимит restore `5 MiB`, secrets, remote executable code, `server.url`, финансовые данные в URL/localStorage/cache/logs и что legacy XLSX/inspection не staged; бинарник не удаляется и не объявляется безопасным.
- [x] Коммит A: поимённо stage-ить только утверждённый baseline и review fixes, исключая этот план; до коммита проверить `git diff --cached --name-only`.
- [x] Коммит B после приёмки: docs-агент записывает SHA коммита A и доказательство, затем stage-ится только этот план.

## Фаза 1. Канонические fixtures, parity и domain-инварианты

Статус: [x] готово  
Checkpoint: `feat(domain): align golden fixtures and planning rules`  
SHA/доказательство: implementation `cd334a2`; точный pathspec из 17 файлов без этого плана: `contracts/README.md`, `contracts/fixtures/g-002.json`, `contracts/schemas/budget-fixture.schema.json`, `contracts/schemas/planning-fixture.schema.json`, `docs/DECISIONS.md`, `docs/IMPLEMENTATION_STATUS.md`, `docs/QA_ACCEPTANCE.md`, `packages/domain/package.json`, `packages/domain/src/calculate.ts`, `packages/domain/src/index.ts`, `packages/domain/src/types.ts`, `packages/domain/tests/calculate.test.ts`, `packages/test-fixtures/package.json`, `packages/test-fixtures/src/index.ts`, `packages/test-fixtures/tests/fixtures.test.ts`, `packages/test-fixtures/tsconfig.json`, `pnpm-lock.yaml`; `pnpm verify` — fixtures `6/6`, domain `17/17`, storage `2/2`, web `14/14`, всего `39/39`, пять TypeScript typechecks и production PWA build с `13` precache entries; `pnpm audit` и `pnpm audit --prod` — `0` vulnerabilities. Точные канонические результаты: G-000 — доход/расходы/капитал `100 000 / 76 500 / 23 500 ₽`, основной/накопительный `23 500 / 0 ₽`, продукты `105%` и `−1 500 ₽`; G-001 — те же `100 000 / 76 500 / 23 500 ₽`, основной/накопительный `13 500 / 10 000 ₽`, прогресс цели `10 000 ₽`, планово свободно `10 000 ₽`; G-002 — июль 2026 резерв/свободно `19 809 / 44 191 ₽`, сентябрь сезонное/всего по расписанию/свободно `31 000 / 84 000 / 13 191 ₽`, январь 2027 due `72 000 ₽`, июнь 2027 due `90 000 ₽`, январь 2028 due `72 000 ₽`, июнь 2028 due `0 ₽`, первые 12 месяцев горизонтов 12/24 совпадают до копейки. Excess-refund gate сохранил gross/refund/net `76 500 / 40 000 / 36 500 ₽`, факт продуктов `−8 500 ₽`, перелимит `0 ₽`; schema/runtime gates отклоняют `status: "posted "`, `kind: "__proto__"`, unsafe integer movement, перевёрнутые movements, split `1`, duplicate/unknown references и bounded-input нарушения. Финальные свежие code review и security review — `APPROVE`, blocker/high/medium/low `0/0/0/0`. Excel, browser live/offline, iPhone/iPad, Android, RuStore и deploy этой фазой не подтверждались.

File scope исполнителя:

- `contracts/**`;
- `packages/test-fixtures/**`;
- `packages/domain/**`;
- `docs/DECISIONS.md`, `docs/QA_ACCEPTANCE.md`, `docs/IMPLEMENTATION_STATUS.md` — отдельный docs-исполнитель;
- корневые workspace/package файлы — один выделенный dependency-исполнитель последовательно, если потребуется добавить `packages/test-fixtures`.

Реализация и проверки:

- [x] Добавить versioned `G-002` в `contracts/fixtures` и сделать `packages/test-fixtures` типизированным адаптером без копирования данных.
- [x] Зафиксировать округление ежемесячного резерва вверх до целого рубля на каждый commitment и устранить расхождение domain/Excel/docs.
- [x] Добавить domain-проверки: первые 12 месяцев равны для горизонтов 12/24 до копейки; 28/29 февраля; due day 30/31; смена года/timezone-independent local date; 80%, 100%, 100% + 1 копейка; zero plan; возврат больше расхода; перевод в тот же счёт; duplicate UUID; safe-integer overflow.
- [x] `pnpm --filter @family-budget/domain test` и `pnpm verify` зелёные.
- [x] Live-check через тест/небольшой read-only runner: G-000 — `100 000 / 76 500 / 23 500 ₽`, продукты `105%`, `−1 500 ₽`; G-002 — июль 2026 резерв `19 809 ₽`, свободно `44 191 ₽`; сентябрь сезонное `31 000 ₽`, свободно `13 191 ₽`; январь 2027 due `72 000 ₽`; январь 2028 due `72 000 ₽`; июнь 2028 due `0 ₽`.
- [x] Свежий code review проверяет математику, границы дат и отсутствие double counting.
- [x] Свежий security review проверяет неконтролируемые размеры входа, duplicate IDs, unsafe integers и валидацию внешних fixtures.
- [x] Коммит A содержит только подтверждённые файлы этой фазы; коммит B содержит только план с SHA/доказательством A.

## Фаза 2. Excel parity и полный автоматизируемый QA

Статус: [ ] готово  
Checkpoint: `feat(excel): align workbook with canonical golden fixtures`  
SHA/доказательство: —

File scope исполнителя:

- `tools/build-family-budget.mjs`;
- `outputs/<новый-id>/family-budget-mvp.xlsx` и его компактный inspection-артефакт;
- `docs/EXCEL_MVP.md`, `docs/IMPLEMENTATION_STATUS.md` — отдельный docs-исполнитель.

Реализация и проверки:

- [ ] Явный blocker: не начинать генерацию и не закрывать фазу, пока недоступен требуемый artifact-tool loader/runtime для Spreadsheet workflow. Недоступность loader фиксируется как blocker, а не обходится повторной публикацией старого workbook или неподтверждённым альтернативным генератором.
- [ ] Генератор берёт значения/семантику из канонического G-002 или явного общего адаптера, а не поддерживает вторую независимую арифметику fixtures.
- [ ] Повторно сгенерировать 11 листов: быстрый старт, дашборд, горизонт 24 мес, крупные и ежегодные, ежемесячные, сезонные, повседневные, операции, цели, настройки, справочники.
- [ ] Проверить типы дат/денег, validation, расширение таблиц новой строкой, тексты статусов, подписи графика и отсутствие внешних ссылок/макросов.
- [ ] Запустить команду генерации по инструкции `spreadsheets` и формульный scan; найдено `0` совпадений `#REF!/#DIV/0!/#VALUE!/#NAME?/#N/A`.
- [ ] Live-check книги: 11 листов; июль доход `180 000 ₽`, ежемесячные `53 000 ₽`, повседневные `53 000 ₽`, резерв `19 809 ₽`, цель `10 000 ₽`, свободно `44 191 ₽`; сентябрь сезонное `31 000 ₽`, свободно `13 191 ₽`; январь 2027 платёж из резерва `72 000 ₽` без второго вычитания.
- [ ] Свежий code/formula review проверяет формулы, structured ranges и parity с G-002.
- [ ] Свежий security review проверяет отсутствие macros/external links, ложного заявления о шифровании и утечки локальных путей/данных в артефакт.
- [ ] Коммит A содержит только генератор, новый итоговый `.xlsx`, минимальный inspection и docs; временные PNG previews не коммитить. Коммит B содержит только план с SHA/доказательством A.

Ручной gate, не блокирующий автономный code-ready статус: открыть итоговый файл в реальном Excel macOS/Windows, пройти Accessibility Checker, клавиатуру и масштаб 200%.

## Фаза 3. Storage v2, migrations и атомарный backup/restore

Статус: [x] готово
Checkpoint: `feat(storage): add migrations and validated atomic recovery`  
SHA/доказательство: implementation `57f95c6`; точный pathspec из 18 файлов без этого плана: `apps/web-pwa/package.json`, `apps/web-pwa/src/App.tsx`, `apps/web-pwa/src/backup.test.ts`, `apps/web-pwa/src/backup.ts`, `apps/web-pwa/src/storage-repository.test.ts`, `apps/web-pwa/src/storage-repository.ts`, `contracts/schemas/storage-backup.schema.json`, `docs/ARCHITECTURE.md`, `docs/QA_ACCEPTANCE.md`, `packages/storage/package.json`, `packages/storage/src/backup.ts`, `packages/storage/src/csv.ts`, `packages/storage/src/index.ts`, `packages/storage/src/indexed-db.ts`, `packages/storage/tests/backup.test.ts`, `packages/storage/tests/csv.test.ts`, `packages/storage/tests/indexed-db.test.ts`, `pnpm-lock.yaml`. `pnpm verify` — fixtures `6/6`, domain `17/17`, storage `28/28`, web `24/24`, всего `75/75`, пять TypeScript typechecks и production PWA build с `13` precache entries; frozen-lockfile install зелёный; `pnpm audit` и `pnpm audit --prod` — `0` vulnerabilities. Точный live/read-only gate: документ v1 с суммой `12 345` копеек мигрирован в schema v2; `createdAt` сохранён как `2026-07-17T12:00:00.000Z`; backup проходит byte-identical round-trip, а повреждённый restore отклоняется без изменения сохранённого документа; clear-all оставляет `0` документов. Projected G-001 после восстановления сохраняет счётчики `2/3/1/3/1/0/0/5` и суммы доход/расходы/капитал `100 000 / 76 500 / 23 500 ₽`. Legacy backup и CSV security gates подтверждают строгую валидацию, лимиты и защиту от formula injection. Финальные свежие абсолютные code review и security review — `APPROVE`, blocker/high/medium `0/0/0`. Неблокирующие low caveats: нет прямого synthetic-теста закрытия соединения через `versionchange`; checksum и repository-level интеграция покрыты соседними, а не отдельными end-to-end тестами. Реальные Safari/iPhone/Android/Excel/deploy и Phase 7 UI этой фазой не подтверждались.

File scope исполнителя:

- `packages/storage/**`;
- schema/codec-файлы в `contracts/schemas/**`, только если они не заняты фазой 1;
- `docs/ARCHITECTURE.md`, `docs/QA_ACCEPTANCE.md` — отдельный docs-исполнитель.

Реализация и проверки:

- [x] Реализовать последовательные IndexedDB migrations минимум `v1 → v2`, атомарное применение и тест отказа без частичного состояния.
- [x] Backup содержит app, version, schema version, createdAt и проверку целостности; payload валидируется полностью до одной записи.
- [x] Отклонять повреждённый JSON, чужой app, неподдерживаемую старшую версию, duplicate UUID, лишние/невалидные связи и чрезмерно большой импорт с понятной ошибкой.
- [x] Добавить last successful backup metadata, clear-all и CSV codec; явно различать CSV и полную backup-копию.
- [x] `pnpm --filter @family-budget/storage test`, затем `pnpm verify` зелёные.
- [x] Live-check в временной browser DB: миграция документа v1 с суммой `12 345` копеек сохраняет `123,45 ₽`; backup с временем `2026-07-17T12:00:00Z` проходит round-trip; испорченная сумма/UUID отклоняется и прежний документ остаётся байт-в-байт; clear оставляет `0` документов.
- [x] Свежий code review проверяет lifecycle IDB connection/transaction, migration rollback и ошибки blocked/versionchange.
- [x] Свежий security review проверяет prototype pollution, oversized JSON/CSV, формульную инъекцию CSV, content disclosure в ошибках и отсутствие данных в localStorage/logs.
- [x] Коммит A содержит только storage/contracts/docs-файлы фазы; коммит B содержит только план с SHA/доказательством A.

## Фаза 4. Onboarding и пустая семья вместо demo seed

Статус: [x] готово
Checkpoint: `feat(web): add empty-state onboarding and budget setup`  
SHA/доказательство: prerequisite storage checkpoint `8999db4` (`fix(storage): atomically initialize active budget`) выделен отдельно из-за границы file scope и устранения security-значимой multi-tab race; web implementation checkpoint `634d3b8`. В чистом IndexedDB до явного действия сохранено `0` документов и создано `0` demo-платежей. Onboarding с периодом `2026-07-01`, доходом `180 000 ₽`, обязательным платежом `53 000 ₽` и повседневными лимитами всего `53 000 ₽` создал `1` документ, `1` ежемесячное расписание и по `0` фактических операций, целей и ежегодных обязательств; дашборд показал нераспределённо `74 000 ₽`. Reload и offline reload при остановленном сервере через service worker сохранили тот же бюджет и суммы. Финальный `pnpm verify` — fixtures `6/6`, storage `43/43`, domain `17/17`, web `63/63`, всего `129/129`, пять TypeScript typechecks и production PWA build с `13` precache entries (`315,71 KiB`); `pnpm audit` и `pnpm audit --prod` — `0` vulnerabilities, frozen-lockfile install и `git diff --check` зелёные. Production preview вернул `200` для корня, manifest, service worker и проверенных assets; CSP scan чистый. Финальные свежие code review и security review — blocker/high/medium/low `0/0/0/0` каждое. Зафиксированные дефолты: состав хранится локальной неперсональной меткой со значениями `Для себя` / `Для пары` / `Для семьи` (по умолчанию `Для семьи`), старт периода ограничен максимумом `9997-12-01`, применяется строгая CSP; реальный iPhone/iPad этой фазой не проверялся.

File scope исполнителя:

- `apps/web-pwa/src/onboarding/**`;
- `apps/web-pwa/src/components/**` только новые onboarding/shared components;
- `apps/web-pwa/src/App.tsx`, `apps/web-pwa/src/styles.css` — один интеграционный исполнитель последовательно;
- тесты onboarding рядом с web-кодом.

Реализация и проверки:

- [x] Первый запуск не сохраняет демонстрационные финансовые данные; demo доступно только как явно подписанный необязательный пример/import fixture.
- [x] Четыре коротких шага: состав семьи/локальные метки, RUB и период, доход/обязательные платежи, 3–5 повседневных лимитов.
- [x] Все поля имеют понятные подписи, back/forward без потери ввода, validation и touch targets не меньше 44 CSS px.
- [x] `pnpm --filter @family-budget/web test`, typecheck, production build и `pnpm verify` зелёные.
- [x] Live-check чистого профиля: до onboarding `0` операций и `0` demo-платежей; ввести доход `180 000 ₽`, обязательный платёж `53 000 ₽`, повседневный лимит `53 000 ₽`; после завершения остаётся `0` фактических операций, период начинается `2026-07-01`, дашборд показывает нераспределённо `74 000 ₽` до добавления резервов/целей.
- [x] Reload и offline reload возвращают тот же созданный бюджет и те же три суммы.
- [x] Свежий code review проверяет state machine, validation, focus/errors и отсутствие скрытого seed.
- [x] Свежий security review проверяет XSS через имена/категории, PII minimization, отсутствие данных в URL/logs/cache.
- [x] Коммит A содержит только web-файлы фазы; коммит B содержит только план с SHA/доказательством A.

## Фаза 5. CRUD четырёх слоёв планирования

Статус: [x] готово
Checkpoint: `feat(web): add flexible long-horizon planning CRUD`  
SHA/доказательство: web implementation `cae46f5`; обязательные prerequisite checkpoints: `fa49649` (domain recurrence/reserve semantics), `b6ae55a` (independent flexible-line archive + backup), `290b762` (CAS/versioned storage). Финальный `pnpm verify` — fixtures `6/6`, storage `61/61`, domain `24/24`, web `95/95`, всего `186/186`; пять TypeScript typechecks, production PWA build с `13` precache entries (`353,46 KiB`), `pnpm audit` и `pnpm audit --prod` — `0` vulnerabilities, frozen-lockfile install и `git diff --check` зелёные. Детерминированный production IndexedDB/CAS integration-check подтвердил счётчики accounts/categories/budgets/lines/goals/commitments/schedules/transactions `1/4/1/3/0/3/3/0`, июль 2026 резерв/свободно `19 809 / 54 191 ₽`, сентябрь сезонное/всего по расписанию/свободно `31 000 / 84 000 / 23 191 ₽`, страховку в январе 2027/2028 `72 000 ₽`, лагерь в июне 2027 `90 000 ₽` и июне 2028 `0 ₽`; после reload документ остался байт-в-байт тем же. Production preview вернул `200` для корня, manifest и service worker. Финальные свежие code review и security review — blocker/high/medium/low соответственно `0/0/0/0` и `0/0/0/1`. Managed browser отсутствовал у финального reviewer, поэтому кликовый live-check не заявляется: точные значения подтверждены production IndexedDB/CAS integration-check и production preview. Единственная подтверждённая low-находка перенесена в обязательный hosting gate фазы 8: HTTP CSP header с `frame-ancestors 'none'`, `X-Frame-Options: DENY` и проверка navigation response service worker; meta CSP сама по себе не обеспечивает anti-framing.

File scope исполнителя:

- `apps/web-pwa/src/features/planning/**`;
- соответствующие web-тесты;
- минимальные точки интеграции в `App.tsx`/`styles.css` выполняет один последовательный интегратор после feature-исполнителя.

Реализация и проверки:

- [x] Создание/редактирование/архивация: крупный ежегодный или разовый платёж, ежемесячная регулярка, выбранные месяцы, повседневный лимит.
- [x] Категория «Дети» не является типом расписания: одновременно поддерживаются обучение сентябрь–май, летний лагерь разово и мелкие детские покупки в повседневном лимите.
- [x] Due day 29/30/31 корректно нормализуется для короткого месяца по принятому documented rule.
- [x] Каждое изменение немедленно пересчитывает 12/24 месяца и сохраняется атомарно.
- [x] `pnpm --filter @family-budget/web test` и `pnpm verify` зелёные.
- [x] Live-check создать: страховку `72 000 ₽`, annual, `2027-01-15`; дом `36 000 ₽`, annual, `2027-05-01`; лагерь `90 000 ₽`, one-time, `2027-06-15`, уже накоплено `15 000 ₽`; обучение `25 000 ₽` и секции `6 000 ₽` только сентябрь–май; повседневные лимиты всего `53 000 ₽`.
- [x] Сверить июль 2026 резерв `19 809 ₽`, сентябрь сезонное `31 000 ₽`, январь 2027/2028 страховку `72 000 ₽`, июнь 2027 лагерь `90 000 ₽`, июнь 2028 лагерь `0 ₽`; после reload счётчики сущностей и суммы не меняются.
- [x] Свежий code review проверяет CRUD, archive semantics, date recurrences и отсутствие дублирования при edit.
- [x] Свежий security review проверяет DOM injection, ID spoofing, некорректные ссылки category/account и resource exhaustion длинными списками/строками.
- [x] Коммит A содержит только planning web-файлы и интеграционные точки; коммит B содержит только план с SHA/доказательством A.

## Фаза 6. Полный CRUD операций, атомарные переводы и сигналы

Статус: [x] готово
Checkpoint: `feat(web): complete transaction flows and limit signals`  
SHA/доказательство: implementation `de204b8` (`17` точных файлов). Финальный `pnpm verify` — fixtures `6/6`, storage `61/61`, domain `26/26`, web `129/129`, всего `222/222`; пять TypeScript typechecks, production PWA build с `13` precache entries (`375,83 KiB`), frozen-lockfile install и `git diff --check` зелёные. В dependency graph остался только `fast-uri@3.1.4`; `pnpm audit` и `pnpm audit --prod` — `0` vulnerabilities. Детерминированный production fake-IndexedDB/CAS live-check G-000 подтвердил: исходно `4` операции, доход `100 000 ₽`, расходы `76 500 ₽`, капитал/основной `23 500 ₽`, накопительный `0 ₽`, продукты `31 500 ₽`, перелимит `1 500 ₽`; refund `1 500 ₽` датой `2026-07-07` дал `5` операций, расходы `75 000 ₽`, продукты `30 000 ₽`, статус «Лимит исчерпан», перелимит `0 ₽`, капитал/основной `25 000 ₽`; transfer `5 000 ₽` дал `6` операций, основной/накопительный `20 000 / 5 000 ₽`, расходы `75 000 ₽`, капитал `25 000 ₽`; edit transfer до `7 000 ₽` дал `18 000 / 7 000 ₽` при тех же `6` операциях, delete вернул `5` операций и `25 000 / 0 ₽`. Каждый шаг создавал новую revision, сохранял ровно один документ и после reload оставался байт-в-байт тем же. Отдельно подтверждены обратимость goal contribution G-001, пороги `80% / 100% / 100% + 0,01 ₽ / нулевой план`, допустимый refund в тот же день, принятие excess refund D-013, отказ раннего refund без записи в общих domain/backup-путях и зависимость archive от всех бюджетов. Production browser live-check на чистом профиле и порту `4176` подтвердил текущий onboarding/demo: Today `27 000 ₽`, резерв `19 809 ₽`, нераспределённо `44 191 ₽`, по расписанию `53 000 ₽`, страховка `72 000 ₽` и резерв в месяц `10 286 ₽`; экран Operations показывает доход `180 000 ₽`, расход `71 000 ₽`, капитал `124 000 ₽`, счета `109 000 / 15 000 ₽`, selector всех пяти видов и полную историю из `4` операций. Доступный сигнал содержит точные текст, значок и число; архивирование используемой категории «Продукты» блокируется безопасной ошибкой без изменения сигнала; browser console error/warn пуст. Выбор файла для точного G-000 import/click недоступен в managed backend, а у двух свежих live-QA агентов browser runtime отсутствовал, поэтому точный G-000 UI click-path не заявляется: его значения подтверждены production IDB/CAS integration. Финальные свежие code review и security review — APPROVE, blocker/high/medium/low `0/0/0/0` и `0/0/0/0`. Обязательный anti-framing hosting gate фазы 8 остаётся открытым.

File scope исполнителя:

- `apps/web-pwa/src/features/operations/**`;
- связанные adapters/tests в `apps/web-pwa/src/**`;
- минимальные изменения domain/storage допускаются только отдельным исполнителям после проверки, что их файлы не заняты другой задачей;
- `App.tsx`/`styles.css` — последовательный интегратор.

Реализация и проверки:

- [x] Создание, редактирование и удаление income, expense, refund, transfer и goal contribution.
- [x] Перевод и взнос в цель записываются атомарно; same-account запрещён; refund связан с категорией/исходной операцией; использованная категория архивируется.
- [x] После любой операции пересчитываются карточки, история и статусы `normal / near_limit / exhausted / over_limit`; сигнал содержит текст, значок и число.
- [x] `pnpm verify` и integration-тесты IDB + domain зелёные.
- [x] Live-check G-000: старт `4` операций, доход `100 000 ₽`, расходы `76 500 ₽`, продукты `31 500 ₽` и перелимит `1 500 ₽`.
- [x] Добавить refund `1 500 ₽` от `2026-07-07`: операций `5`, расходы `75 000 ₽`, продукты `30 000 ₽`, статус `Лимит исчерпан`, перелимит `0 ₽`.
- [x] Добавить transfer `5 000 ₽`: операций `6`, расходы остаются `75 000 ₽`, капитал `25 000 ₽`, основной `20 000 ₽`, накопительный `5 000 ₽`; edit/delete полностью возвращают прежние числа.
- [x] Проверить отдельно 80%, 100%, 100% + `0,01 ₽` и нулевой план без crash.
- [x] Свежий code review проверяет атомарность, edit/delete recalculation и idempotency UI-submit.
- [x] Свежий security review проверяет replay/double-submit, malformed IDs, oversized notes, data exposure в errors/logs и CSV/backup взаимодействие.
- [x] Коммит A содержит только operation/integration-файлы; коммит B содержит только план с SHA/доказательством A.

## Фаза 7. Дашборды, поиск, CSV и recovery UX

Статус: [x] готово
Checkpoint: `feat(web): complete insights search and recovery UX`  
SHA/доказательство: implementation `874229283946266c025511f40335edfae808cded`; точный scope из `21` файла: `apps/web-pwa/src/{App.tsx,styles.css,phase7-app-integration.test.tsx}`, пять файлов `apps/web-pwa/src/features/dashboard/{DashboardScreen.tsx,index.ts,model.test.ts,model.ts,ui.test.tsx}`, одиннадцать файлов `apps/web-pwa/src/features/data-management/{DataManagementScreen.tsx,dialog-accessibility.test.ts,dialog-accessibility.ts,download.test.ts,download.ts,index.ts,model.test.ts,model.ts,recovery.test.ts,recovery.ts,ui.test.tsx}` и `packages/storage/{src/indexed-db.ts,tests/indexed-db.test.ts}`. Два storage-файла включены как проверенное исправление найденной на review гонки: поздняя запись metadata об успешной backup после clear не должна воскрешать очищенный документ; это явное prerequisite/review-fix исключение из первоначальной формулировки commit A только для dashboard/data-management/integration.

Финальный `pnpm verify` — fixtures `6/6`, storage `62/62`, domain `26/26`, web `174/174`, всего `268/268`; зелёные пять TypeScript typechecks, production build с `13` precache entries (`409,99 KiB`), frozen-lockfile install и `git diff --check`; `pnpm audit` и `pnpm audit --prod` — `0` vulnerabilities. Root live-check в IAB на финальном build подтвердил июль: по расписанию `53 000 ₽`, повседневный факт `26 000 ₽`, остаток `27 000 ₽`, резерв `19 809 ₽`, свободно `44 191 ₽`; сентябрь: сезонное `31 000 ₽`, свободно `13 191 ₽`; ближайшие суммы: январь 2027 `72 000 ₽`, июнь 2027 `90 000 ₽`. Список ближайших платежей показывает ровно одно ближайшее вхождение каждого расписания, включая сентябрьские обучение/секции и ежегодные платежи. Destructive-clear dialog безопасно закрывается кнопкой «Отмена» и Escape, после чего focus возвращается на opener.

Детерминированные gates подтвердили горизонты `12/24` с одинаковым префиксом первых `12` месяцев, январь 2028 `72 000 ₽` и июнь 2028 `0 ₽`; канонический G-000 после refund и transfer содержит `6` операций, доход/расходы/капитал `100 000 / 75 000 / 25 000 ₽`, поиск «Продукты» возвращает `2` записи, reset — `6`, totals инвариантны. Backup проходит byte-identical round-trip по UUID, датам, суммам и счётчикам; повреждённый backup не меняет состояние; CSV содержит BOM, header и `6` data rows; поздняя backup metadata после clear не воскрешает документ. Финальные свежие code review и security review — `APPROVE`, blocker/high/medium/low `0/0/0/0` каждое. File-picker upload через IAB backend выполнить не удалось, поэтому точные restore/CSV утверждения относятся к детерминированным integration gates; реальный iPhone и deploy этой фазой не заявляются.

File scope исполнителя:

- `apps/web-pwa/src/features/dashboard/**`;
- `apps/web-pwa/src/features/data-management/**`;
- связанные web-тесты;
- `App.tsx`/`styles.css` — последовательный интегратор.

Реализация и проверки:

- [x] Дашборд показывает план/факт, ближайшие платежи и горизонт 12/24; график имеет числовую таблицу и доступное текстовое резюме.
- [x] Фильтры и поиск операций не изменяют исходные данные.
- [x] Backup UI показывает дату последней успешной копии, предупреждает о незашифрованном JSON/CSV и позволяет атомарно restore/clear с подтверждением.
- [x] CSV открывается в Excel-совместимой UTF-8 форме, экранирует формулы и не называется backup.
- [x] `pnpm verify` и UI/integration-тесты зелёные.
- [x] Live-check G-002: переключение 12→24 даёт `12` и `24` карточки, первые `12` совпадают; январь 2027 `72 000 ₽`, июнь 2027 `90 000 ₽`, январь 2028 `72 000 ₽`, июнь 2028 `0 ₽`.
- [x] На наборе `6` операций поиск по «Продукты» возвращает ожидаемые `2` записи (расход и refund), сброс снова показывает `6`; totals до/после фильтра одинаковы.
- [x] Export/import возвращает одинаковые UUID, даты, суммы и счётчики; повреждённый файл не меняет ни одну сумму; CSV содержит header + `6` data rows.
- [x] Свежий code review проверяет derived state, график/таблицу, поиск и recovery state machine.
- [x] Свежий security review проверяет CSV injection, download filename/content type, file size/type, destructive clear confirmation и отсутствие backup contents в логах.
- [x] Коммит A содержит только dashboard/data-management/integration-файлы; коммит B содержит только план с SHA/доказательством A.

## Фаза 8. PWA offline, controlled update, accessibility и web hardening

Статус: [ ] готово  
Checkpoint: `feat(pwa): harden offline updates accessibility and security`  
SHA/доказательство: —

File scope исполнителя:

- `apps/web-pwa/vite.config.ts`, `apps/web-pwa/index.html`, `apps/web-pwa/public/**`;
- `apps/web-pwa/src/components/UpdatePrompt.tsx`, accessibility/style fixes;
- browser/e2e config и tests в отдельной новой папке;
- корневые package/lock files — один dependency-интегратор последовательно.

Реализация и проверки:

- [ ] Автоматизировать browser core-scenario, offline reload/navigation и controlled service-worker update без потери несохранённого ввода/IndexedDB.
- [ ] Добавить проверяемую CSP и release scan: нет remote executable code, finance data в URL/localStorage/SW cache, случайного `server.url`, source maps/secrets.
- [ ] Обязательный hosting gate по low-находке фазы 5: серверный HTTP CSP header содержит `frame-ancestors 'none'`, `X-Frame-Options: DENY`; проверить заголовки корня и navigation response service worker, не считать meta CSP достаточной anti-framing защитой.
- [ ] Проверить manifest `standalone`, start_url/scope/icons, nested navigation fallback и offline status.
- [ ] Пройти keyboard, focus, semantic labels, non-color statuses, touch 44 px, narrow phone/iPad/landscape и zoom 200% в автоматизируемой части.
- [ ] `pnpm verify`, browser/e2e и production artifact scan зелёные.
- [ ] Live-check в чистом browser profile: сначала восстановить подписанный тестовый backup G-002, затем внести расход `9 000 ₽` в продукты датой `2026-07-18`; доступно на повседневное меняется `27 000 → 18 000 ₽`, продукты показывают перелимит `1 000 ₽`, счётчик операций растёт на `1`.
- [ ] Отключить сеть, перезагрузить корень и вложенный route: остаются `18 000 ₽`, `1 000 ₽`, тот же счётчик и дата; включить сеть и применить SW update — значения не меняются.
- [ ] Свежий code review проверяет PWA lifecycle, race conditions update и browser compatibility.
- [ ] Свежий security review проверяет CSP, dependency audit, bundle/manifest/SW cache, URL handling и утечки production artifact.
- [ ] Коммит A содержит только PWA/e2e/package-файлы; коммит B содержит только план с SHA/доказательством A.

Ручной gate: на реальном семейном iPhone/iPad открыть HTTPS-сборку в Safari, добавить «На экран Домой», пройти VoiceOver, offline и Files/Share backup/restore. HTTPS deploy в рамках этого плана запрещён.

## Фаза 9. Локальный Android/Capacitor проект и непубликуемый AAB

Статус: [ ] готово  
Checkpoint: `feat(android): add local-assets capacitor build pipeline`  
SHA/доказательство: —

File scope исполнителя:

- `apps/android/**`;
- Android-specific verification scripts;
- корневые package/lock files — последовательный dependency-интегратор, если требуется.

Реализация и проверки:

- [ ] Создать native Android project, синхронизировать один production React build в local assets; production config/artifact не содержит `server.url`/live-reload URL.
- [ ] Зафиксировать versionCode/versionName для локальной тестовой сборки, минимальные SDK после local compatibility spike и отсутствие лишних permissions.
- [ ] Собрать локальный debug APK и непубликуемый release AAB без production signing key; проверить содержимое артефактов и установку APK на emulator.
- [ ] `pnpm verify`, `cap sync android`, Gradle unit/lint/build и artifact scan зелёные.
- [ ] Live-check emulator с airplane mode до первого запуска: onboarding показывает `0` demo-операций; ввести доход `180 000 ₽`, обязательные `53 000 ₽`, повседневные `53 000 ₽`; получить `74 000 ₽` нераспределённо, добавить расход `9 000 ₽`, перезапустить и сверить те же суммы/счётчик offline.
- [ ] Network inspection показывает `0` обязательных запросов к PWA-домену для UI, данных и расчётов; web assets реально находятся внутри APK/AAB.
- [ ] Свежий code review проверяет Gradle/Capacitor config, asset sync reproducibility и отсутствие platform fork domain logic.
- [ ] Свежий security review проверяет permissions, exported components, cleartext traffic, WebView navigation/allowlist, backup flags, logs и release artifact.
- [ ] Коммит A содержит только Android/scripts/package-файлы; коммит B содержит только план с SHA/доказательством A. Keystore и signing credentials никогда не коммитить.

Ручной gate: проверить на реальном Android-устройстве, создать и безопасно резервировать release signing key, подтвердить окончательный package name. RuStore upload/alpha запрещены в автономном цикле.

## Фаза 10. Локальный release-candidate audit и handoff

Статус: [ ] готово  
Checkpoint: `docs(release): finalize local release candidate evidence`  
SHA/доказательство: —

File scope исполнителя:

- `docs/**`;
- локальные verification scripts/reports в заранее созданной `reports/release-candidate/**`;
- store text/assets только как локальные drafts, без загрузки;
- source code меняется только отдельными fix-агентами в точечно назначенных файлах после найденного дефекта.

Реализация и проверки:

- [ ] Выполнить полный `pnpm verify`, Excel scan, browser/e2e, storage migrations/restore, Android Gradle checks и artifact security scan с нуля.
- [ ] Сформировать трассируемую таблицу QA gate → команда/ручной gate → результат → SHA/артефакт.
- [ ] Проверить отсутствие секретов, remote code, financial logs, production URL, keystore и чужих dirty-файлов во всех коммитах плана.
- [ ] Live-check одинакового fixture на domain, PWA и Android emulator: G-000 `100 000 / 76 500 / 23 500 ₽`; G-002 июль `19 809 / 44 191 ₽`, сентябрь `31 000 / 13 191 ₽`, январь 2027 `72 000 ₽`, июнь 2028 `0 ₽`; backup round-trip сохраняет UUID/даты/суммы/счётчики.
- [ ] Свежий финальный code reviewer не участвовал ни в одной реализации и проверяет весь range от baseline SHA до HEAD.
- [ ] Другой свежий security reviewer проверяет весь range, dependency/artifact scans и privacy claims.
- [ ] Все подтверждённые findings исправлены, затронутые фазы перегнаны, итоговый рабочий tree чист относительно заранее зафиксированных чужих файлов.
- [ ] Этот план содержит SHA и доказательство каждой закрытой фазы; `docs/IMPLEMENTATION_STATUS.md` и `README.md` соответствуют факту.
- [ ] Коммит A содержит только release docs/reports и подтверждённые точечные fixes; коммит B содержит только план с SHA/доказательством A.

## Ручные действия пользователя после автономного code-ready финала

Эти пункты намеренно не превращаются в автономные фазы и не разрешают deploy:

- [ ] Проверить итоговый `.xlsx` в Microsoft Excel macOS/Windows, Accessibility Checker и масштаб 200%.
- [ ] Предоставить HTTPS test origin или самостоятельно разместить staging; затем на семейном iPhone/iPad проверить Safari → «На экран Домой», VoiceOver, offline, update, Files/Share backup/restore.
- [ ] Проверить Android-сборку на реальном слабом устройстве и нескольких версиях System WebView.
- [ ] Выбрать окончательные название/бренд, минимальные версии платформ, тип и юридического владельца RuStore-аккаунта.
- [ ] Подтвердить окончательный package name до первой публикации; создать, защитить и резервировать release signing key.
- [ ] Провести privacy/legal review и утвердить декларацию данных/разрешений, политику конфиденциальности, контакты поддержки и карточку магазина.
- [ ] Провести пользовательскую проверку на 5–10 семьях минимум неделю и зафиксировать непонятные термины/сценарии.
- [ ] Отдельным явно разрешённым запуском загрузить AAB в закрытую RuStore alpha, проверить upgrade/recovery и только затем принимать решение о rollout. Production publish никогда не подразумевается этим планом.

## Финальный формат отчёта оркестратора

После фазы 10 оркестратор выдаёт:

1. `Как было`: исходный baseline SHA, доступные функции, известные пробелы и исходные значения проверок.
2. `Как стало`: список закрытых фаз с SHA, итоговые counts тестов, build/artifact checks и live-значения G-000/G-002.
3. `Что осталось пользователю руками`: только незакрытые ручные gates из раздела выше, без скрытого deploy или публикации.
4. `Что не делалось`: production deploy, RuStore upload/publish, signing key/credentials и семейная cloud sync.
