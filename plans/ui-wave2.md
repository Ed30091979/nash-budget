# План волны 2: интерфейс 2.0 «Наш бюджет»

Статус: утверждён оркестратором 19.10.2026 как ТЗ волны 2 (решения по умолчанию ниже; владелец может изменить). База кода: `778ca1e` (волна 1, модель данных v3) плюс раунд укрепления синхронизации (удержание «только чтение»). Номера строк — на `778ca1e`.
Макет направления: canvas «Наш бюджет 2.0 — экраны» (Main/Entry/Feed/Reports.dc.html, 390×844). Исследование конкурента: `coinkeeper-research.md` (что нельзя копировать — §6.2).

## 0. Корневые причины известных дефектов (подтверждены по коду и артефактам прогонов)

- **(a) Клавиатура при смене кегля.** `features/operations/Keypad.tsx:23–41` подписан только на `change` медиазапроса и `resize`; смена кегля по умолчанию (e2e `Page.setFontSizes`, системный шрифт при открытом приложении) не даёт ни того, ни другого. В `e2e/keypad.spec.ts:218–246` цикл заканчивается на 390×844, `setViewportSize(390,844)` повторно не шлёт `resize` → устаревший снимок `useSyncExternalStore`.
- **(b1) «Ещё» не переходит после записи.** Трейс содержит `dialog` с `DISCARD_DRAFT_CONFIRMATION`. `OperationsScreen.tsx:493` считает `dirty` по черновику, сумма очищается только в `success()` после `await onChange` (`:555–571`, `:665–674`) — весь полёт записи черновик «грязный»; флаг уходит в App пассивным `useEffect` (`:533` → `App.tsx:389, 413`); `navigate` (`App.tsx:700–705`) зовёт блокирующий `window.confirm`, Playwright отвечает «нет». Хелпер `recordExpense` (`e2e/family-sync.spec.ts:112–122`) не ждёт квитанции. Реальный пользователь получает лишний вопрос.
- **(b2) «Код из письма» не появляется** — каскад: тест «при недоступном сервере…» останавливает сервер (`family-sync.spec.ts:233`) и поднимает только в конце (`:267`); падая на (b1), оставляет сервер выключенным; следующий тест видит alert «Сервер синхронизации недоступен…». Комментарий `:278` про `test.fail()` устарел.

Попутные дефекты, которые волна обязана закрыть: `category-visual.ts:35, 99` — поиск по обычному объекту `BY_NAME` (имя «constructor»/«__proto__»), поля `category.icon/color` (D-036) не читаются; `money.ts:2–3`, `components/Money.tsx`, `transaction-words.ts:59` (`rubles`) знают только RUB (D-031); `features/operations/model.ts:206` (`assertBaseCurrencyAccount`) отвергает операции по иностранному счёту, `draftFromTransaction` (`OperationsScreen.tsx:217–238`) не умеет `debt_*`; `features/dashboard/model.ts:344–363` — поиск не видит заметок, меток, счетов, суммы «1 250»; `materializeRecurring` двигает водяной знак каждого активного правила — UI зовёт её только когда у правила реально наступило вхождение.

## 1. Карта экранов

Обозначения: «есть» — функция есть на 778ca1e; «добавить» — новая (в стиле `packages/domain`: `fail(code, field, текст)`, `makeId`, `indexState(next)`).

### 1.1 Обзор — `#/` (`?m=YYYY-MM`)
Шапка: переключатель месяца (стрелки 48), «Всего на счетах», «Потрачено N из M»; строка «Можно на повседневные 27 000 ₽ · хватает до 20 октября» (→ «План месяца»); тревога ключа, баннер «только чтение», семейная новость; ряд «Доходы» (плитки категорий дохода, горизонтальная прокрутка внутри ряда); ряд «Счета» (тёмные плитки); сетка «Расходы» (4 колонки, пастельные плитки, полоса потрачено/лимит, глиф состояния); плитки «+».
Взаимодействия — чистый автомат `features/overview/pick-model.ts`: категория → лист расхода с выбранного/основного счёта; счёт → категория; доход → счёт; счёт → другой счёт = перевод; тот же счёт = снять выбор; Esc = сброс; подсказка в `role="status"`; DnD только при `(pointer: fine)` через те же переходы.
Есть: `calculateBudget` + `findBudgetForMonth`; `calculateHoldings` (`accountBalancesMinor`, `totalInBaseMinor`); `baseAmountOf`; `calculateAnnualPlan`, `reach/periodClock/paydayDays` (`reach.ts`); `carryBudgetForward`, `monthAfterPeriod` («Открыть {месяц}», `App.tsx:673–691`); `percentStep` (`reach.ts:43`).
Добавить: `features/overview/overview-model.ts` (данные плиток, статус normal|near|over по `budget.warningThreshold`, доход по категориям за месяц с плиткой «Без категории» D-026, сумма лимитов); `pick-model.ts`.
Переиспользовать: герой-логику `TodayScreen` (`App.tsx:884–1017`) → `ReachLine`; `familyNewsSince/familyNewsLines`; `syncAlarm`; `categoryVisual` (переписать на `Map` + поля сущности).
Удалить: `TodayScreen`, `CategoryList` (`App.tsx:1186`), `TransactionList` (`:1245`), `.hero-card*`.

### 1.2 Лист ввода суммы — оверлей `?sheet=entry&kind=…&from=…&to=…` / `?sheet=entry&edit=<txId>`
Состав: «Закрыть» (48), вид (с «+» — переключатель Расход/Доход/Перевод), «Повторять» (48); плитки «откуда → куда» (выбор: счета/источники/категории/долги/цели); сумма `hero`; «В категории «Продукты» останется 13 250 ₽ из 30 000 ₽» (имя не склоняем); для иностранного счёта «≈ 1 157 ₽ по курсу 92,50 от 15 октября»; для перевода между валютами — поле «Зачислено, $»; чипы «Сегодня / Вчера / другой день» (нативный `input type=date`); «Комментарий» (`dir="auto"`, ≤ `NOTE_MAX_LENGTH`); метки (частые активные, «+ метка» создаёт в той же транзакции, ≤ `MAX_TAGS_PER_TRANSACTION`); клавиатура; кнопка «Записать 1 250 ₽» во всю ширину.
Режимы: expense, income, transfer, refund («Оформить возврат» из правки расхода), goal_contribution (2e), debt_out/debt_in (2e); правка — «Сохранить» и «Удалить» (диалог в приложении).
Есть: `createTransaction/editTransaction/deleteTransaction` (`features/operations/model.ts:410, 488, 522`); `createTag`, `normalizeNote`, `normalizeTagIds`; `findRate`, `convertMinor`, `indexRates`, `baseCurrencyOf`; `createOperationCategory`, `restoreCategory` (`model.ts:589, 645`).
Добавить: `TransactionDraft` + `note?`, `tagIds?`, `toAmount?`, снимок (курс дня или «сумма в базе вручную» как курс «сумма за сумму», D-031), черновики долга (2e); `makeTransaction` (`model.ts:294`) строит снимок вместо `assertBaseCurrencyAccount`; `carriedLabels` (`:284`) переносит только `memberId` и `recurringRuleId`; домен: общий `baseSnapshot(...)` (вынести из `recurring.ts` ~`:160–165`); `rates.ts` (`addExchangeRate`, `deleteExchangeRate`) для «Задать курс»; `features/entry/entry-model.ts`.
Переиспользовать: `Keypad.tsx` (тот же набор клавиш, включая «÷»; 4 колонки; кнопка записи отдельной строкой); `amount-expression.ts`; `createOperationsSubmissionGate` (`form-state.ts`); `effectTarget/effectValueMinor` (`save-receipt.ts`) + `MoneyOdometer` для тоста «Записано» с «Отменить»; `CategorySheet.tsx`.
Удалить: табло конвертов (`Envelope`, `OperationsScreen.tsx:392`), `OperationsScreen` после 2b, `.envelope*`, `.record-*`.

### 1.3 Операции — `#/operations?from&to&acc&cat&tag&member&kind`
В адресе — только фильтры закрытого типа: `from`/`to` — дата `ГГГГ-ММ-ДД`, `acc`/`cat`/`tag`/`member` — UUID, `kind` — значение из перечня (`docs/SECURITY.md` §7.3). Строка поиска в адрес не попадает никогда: это свободный текст — сумма, заметка, имя; она живёт в памяти экрана, переживает переход на лист правки и обратно, а перезагрузку и «Назад» с экрана — нет.
Заголовок, поиск «Сумма, комментарий, # метка»; чипы период/«Все счета»/«Все категории»/«Метки»/«Участник» (в семье); группы по дням «Сегодня, 18 октября» с итогом дня без переводов; строки: плитка, заголовок, мета «счёт · комментарий · #метка · повторяется…», сумма со знаком; пагинация 50; нажатие → лист в режиме правки.
Есть: `buildOperationSearchIndex/searchOperations` (`features/dashboard/model.ts:336–390`), `OPERATION_PAGE_SIZE`, `transactionDetail/kindLabels/kindSign/amountText` (`transaction-words.ts`), `filterTransactionsByMember`, `memberFilterOptions`, `transactionAuthorLabel`.
Добавить: `features/feed/feed-model.ts` (фильтры `accountIds/categoryIds/tagIds/memberId/from/to`; индекс с заметкой, именами меток, суммой «1250», «1 250», «1250,00»; группировка по дням с итогами в базе); реэкспорт в `dashboard`.
Заменить/удалить: `HistoryScreen.tsx` (`history.test.tsx` → тесты ленты), строка «Вся история» в `MoreScreen` (`App.tsx:1302+`); `TotalsFact` (`HistoryScreen.tsx:116`) → шапка «Отчётов».

### 1.4 Отчёты — `#/reports?view=expense|income|tags&period=month|quarter|year|custom&from&to&acc`
Сегмент «Расходы / Доходы / Метки»; чипы периода; карточка: кольцо (верхние 6 + «Остальное»), «К прошлому периоду ±N ₽», «Лимиты: 52 % от плана»; легенда — строки-кнопки 48 с суммой и долей (→ лента с фильтром); «По месяцам» — столбцы с подписями `notation: "compact"` («52 тыс.»); «Показать таблицей»; метки — полосами (операция с двумя метками входит в обе).
Есть: `calculateBudget` (`aggregateExecution`), `calculateTagExpenses`, `baseAmountOf`.
Добавить: `packages/domain/src/reports.ts` — `calculatePeriodBreakdown(state, {from, to, accountIds?})` (расходы по категориям с возвратами, доходы по категориям с «без категории», метки, итоги) и `calculateMonthlySeries(state, months)`; `features/reports/report-model.ts` (периоды, сравнение).
Компоненты: `Donut.tsx` (SVG, `stroke-dasharray`, разрывы 2 px), `MonthBars.tsx` (SVG), `ReportLegend.tsx`. Без `style={}` (CSP `style-src 'self'`, `vite.config.ts:35–36`): цвета серий — классами токенов.

### 1.5 Счета — `#/more/accounts`, `#/more/accounts/:id`, `#/more/accounts/new`
Список (активные, архив); форма: имя; тип `current/cash/savings/reserve`; валюта (частые сверху, имена через `Intl.DisplayNames('ru')`); начальный остаток (предупреждение «меняет остатки в прошлом»); иконка; цвет; «Учитывать в итоге»; порядок кнопками «Выше / Ниже»; архив/восстановление.
Есть: поля `Account`, `isSupportedCurrency`, `SUPPORTED_CURRENCIES`, `isDisplayKey`, `MAX_SORT_ORDER`, `calculateHoldings`.
Добавить: `packages/domain/src/accounts.ts` — `createAccount`, `updateAccount`, `archiveAccount`, `restoreAccount`, `moveAccount`; инварианты: валюту нельзя сменить при ссылках (операции, долги, цели, планы); счёт не в базе нельзя привязать к цели/плану (D-032).
Компоненты: `components/IconPicker.tsx`, `TonePicker.tsx` (radiogroup со словами «Мята», «Сирень»…), `CurrencySelect.tsx`, `ReorderControls.tsx`.

### 1.6 Курсы валют — `#/more/rates`
«Базовая валюта: ₽ RUB» (меняется только пока нет операций и планов; SECURITY §10 — запись один раз); по каждой используемой валюте последний курс, дата, история; «Добавить курс» (дата, «1 USD = 92,50 ₽»; для слабых — «100 KZT = 18,40 ₽»); удаление; пояснение «курс не переоценивает записанное».
Есть: `findRate`, `indexRates`, `isExchangeRateValue`, `RATE_PART_MIN/MAX`, `HOUSEHOLD_ID`.
Добавить: `rates.ts` (с 2b), `setBaseCurrency(state, code)` (отказ при любых операциях/планах/иностранных счетах); `features/rates/rate-input.ts` (до 6 знаков дробной части → `{baseMinor, quoteMinor}` в `[1, 10¹²]`).

### 1.7 Категории и источники дохода — `#/more/categories?type=expense|income`, `#/more/categories/:id`
Список по `CATEGORY_GROUPS` и доходы; создание, переименование, иконка, цвет, лимит текущего месяца, архив/восстановление, порядок; удаления нет (D-030).
Есть: `createCategory`, `normalizeCategoryName`, `findCategoryByName`, `suggestedCategories`, `CATEGORY_SUGGESTIONS`; веб: `archiveCategory/restoreCategory/createOperationCategory` (`operations/model.ts:533–660`), `groupedCategoryOptions/categoryNameOutcome/categorySuggestions` (`category-picker.ts`); лимиты `createFlexibleLine/editFlexibleLine/archiveFlexibleLine/reactivateFlexibleLine` (`planning/model.ts:334–417`).
Добавить: `updateCategory(state, id, {name?, icon?, color?, group?})`, `moveCategory` в `categories.ts`. `CategorySheet.tsx` → `features/categories/`.

### 1.8 Метки — `#/more/tags`
Список с числом операций; создание, переименование, архив; удаление только неиспользуемой (`deleteTag` сам отказывает, D-034). Добавить `renameTag`/`updateTag`.

### 1.9 Долги — `#/more/debts`, `#/more/debts/:id`
Разделы «Мне должны» / «Я должен»; итоги (к получению, к оплате, итог); строка: контрагент, остаток в валюте долга и в базе, срок, «просрочен» словом и глифом; создание (контрагент, направление, валюта, «уже был долг» = `openingMinor`, срок); четыре глагола D-033 («Дал в долг» owed_to_me+debt_out; «Взял в долг» i_owe+debt_in; «Вернул долг» i_owe+debt_out; «Мне вернули долг» owed_to_me+debt_in) → лист в режиме долга (при разных валютах — `debtAmountMinor`); архив; удаление только без движений.
Есть: `createDebt`, `archiveDebt`, `deleteDebt`, `calculateDebts`, `normalizeCounterparty`, `debtVerb` (`transaction-words.ts:48`). Добавить: черновики `debt_*` в `operations/model.ts`, создание и правка; снять отказ «Операцию по долгу эта форма пока не изменяет» (`OperationsScreen.tsx:642–648`).

### 1.10 Цели — `#/more/goals`, `#/more/goals/:id`
Прогресс (собрано, осталось, %), срок, рекомендуемый взнос в месяц, «Пополнить» (лист `goal_contribution`), «Достигнута» / «Отменить»; создание и правка: имя, сумма, счёт (только база, D-032; можно сразу завести копилку), срок, иконка, плановый взнос.
Добавить: `packages/domain/src/goals.ts` — `createGoal`, `updateGoal`, `setGoalStatus`, `calculateGoalProgress(state, asOf)`.

### 1.11 Регулярные — `#/more/recurring`, `#/more/recurring/:id`
Список «Аренда · каждый месяц · 30 000 ₽ · следующая 1 ноября»; пропуски с причиной («Нет курса USD на 1 октября — добавить курс», «Счёт в архиве»); правка влияет на будущие вхождения; архив; удаление (вхождения остаются).
Создание — из листа ввода «Повторять» (частота, интервал, дата окончания): одним `apply` `createRecurringRule` + `materializeRecurring(state, today)`; первое вхождение пишет материализация с выведенным id; при дате в прошлом лист предупреждает «Будет записано 4 операции: 1, 8, 15, 22 октября».
Материализация при открытии — `app/useRecurringOnOpen.ts`: после загрузки, при `visibilitychange`→видимо, при смене дня; только если у какого-то правила `occurrenceDates(rule, watermark, today)` не пусто; через координатор записи с `deletedIds` из надгробий журнала (в одиночном режиме пусто); пропускается при удержании; тост «Записаны регулярные: 3» со ссылкой на ленту.
Есть: `materializeRecurring`, `occurrenceDates/occurrenceDays`, `archiveRecurringRule`, `deleteRecurringRule`, `recurringOccurrenceId`. Добавить: `createRecurringRule`, `updateRecurringRule`; помощник «id надгробий журнала» в `sync-protocol`; `family.deletedIds()` в `features/family/controller.ts`.

### 1.12 «Ещё» — `#/more`
«Учёт»: Счета, Категории и доходы, Метки, Долги, Цели, Регулярные, Курсы валют. «План»: «План месяца» (`#/more/plan-month` = `PlanningScreen` без изменений внутри), «План на год» (`#/more/plan-year` = `YearScreen` `App.tsx:1019` + `DashboardScreen` → `features/plan-year/`). «Данные»: «Сделать копию» первой строкой; «Импорт выписки» (`ImportScreen`); «Данные» (`DataManagementScreen`). «Семья» (`FamilyScreen` + уведомление об удержании). «О приложении»: как хранятся данные, хранилище (`storageText`), версия, лицензия Lucide ISC. `MoreScreen` (`App.tsx:1302`) → `features/more/MoreScreen.tsx`.

### 1.13 Общие оверлеи (2a)
`components/ConfirmDialog.tsx` (на `activateDialogEnvironment/handleDialogKeyboard`, `data-management/dialog-accessibility.ts`), `Toast.tsx` (одна плашка за раз, DESIGN §12), `ReadOnlyBanner.tsx`, `WriteRefusalNotice.tsx`, `BottomNav.tsx` с «+», `SheetFrame.tsx`.

## 2. Навигация и состояние

### 2.1 Свой hash-роутер (~200 строк, без зависимостей)
Почему не react-router: своя семантика защиты черновиков на `popstate`; без лишних зависимостей, офлайн; hash не требует переписывания адресов ни на статическом хостинге, ни в Capacitor, SW-навигация и CSP прежние.
`src/navigation/routes.ts`: union `Route`, `parseRoute(hash)`, `formatRoute(route)`; мусор/неизвестное/несуществующий id → родитель + тост «Запись не найдена»; у каждого маршрута `parent`. `src/navigation/router.ts`: `useRoute()` на `useSyncExternalStore` (`popstate`), `navigate(route, {replace})`, `back()`.
История: Обзор — корень; Обзор → вкладка = push, вкладка → вкладка = replace (Назад с любой вкладки → Обзор, с Обзора → выход); подэкраны и листы = push; внутренние кнопки «назад» (`components/BackButton.tsx`) → `parent` с replace (не слепой `history.back()`); при перезагрузке `sheet=` отбрасывается — черновик никогда не попадает в адрес.
Приватность: в hash только то, что разрешает закрытая грамматика `QUERY_GRAMMAR` (`routes.ts`): у маршрута — свой список ключей, у ключа — значение закрытого типа (UUID, перечень, дата, месяц, небольшое число); ни сумм, ни заметок, ни имён, ни строки поиска. Как это держится — `docs/SECURITY.md` §7.3.
Фокус и прокрутка: `h1` маршрута в фокусе после перехода (`focusRouteHeading`), прокрутка восстанавливается по ключу маршрута; лист ловит фокус и возвращает его на плитку.
Android: `@capacitor/app` нет; без новой зависимости, по образцу `NativeFileExportPlugin`: в `MainActivity.java` `OnBackPressedCallback` — `webView.canGoBack()` ? `goBack()` : отдать системе. Проверить на эмуляторе в 2a. iOS standalone — своя кнопка «назад» на каждом подэкране.

### 2.2 Состояние
Координатор `createAppBudgetSaveCoordinator` (`App.tsx:195–251`; сериализация, CAS, журнал) → `src/app/budget-store.ts`, `BudgetContext { budget, baseCurrency, apply }`. `App.tsx` (1371 строка) → `app/AppShell.tsx`, `app/routes.tsx`, `app/useRecurringOnOpen.ts`. Производные мемоизируются по ссылке на бюджет (`WeakMap`): метрики месяца, holdings, debts, индекс поиска. Маршрут и фильтры — в адресе; выбор плиток — состояние компонента; черновик листа ввода — `app/entry-draft-store.ts` (переживает навигацию и неудачную запись: «Не записано: … [Вернуться к черновику]»); тосты — очередь App.

### 2.3 Запись и удержание синхронизации
Контракт от слоя семьи (согласовать с результатом раунда укрепления): `family.writeBlock: { reason, title, body } | null`; запись в журнал может вернуть отказ (вариант `JournalWriteOutcome`, `features/family/controller.ts:405–455`, или типизированная ошибка). Координатор получает `writeBlock?: () => WriteBlock | null`, проверяет до `change()`, оба отказа → `BudgetWriteRefusedError`. `src/write/useBudgetWrite.ts`: `run(change)`, `refusal`, разбор ошибок домена в слова полей (`OperationsValidationError`, `TextValidationError`, `CategoryValidationError`, `DebtValidationError`, `TagValidationError`, `BUDGET_WRITE_CONFLICT_MESSAGE`).
Показ: (1) `ReadOnlyBanner` на каждом экране при `writeBlock` (`role="status"`, «Подробнее в «Семье»»); (2) нажатие на плитку/«+» → тост, лист не открывается; (3) удержание при открытом листе → `WriteRefusalNotice` (`role="alert"`), черновик остаётся.
Пути записи с обязательным показом отказа: лист ввода (создание, правка, удаление, отмена из тоста); категории, счета, метки, курсы, база; лимиты; долги, цели, правила; материализация (тихий пропуск + строка на «Регулярных»); импорт (применить/отменить, `ImportScreen.tsx:233, 264`); «Открыть месяц» (`App.tsx:673`); восстановление копии; `registerLocalMember` (молча). Очистка данных разрешена (аварийный выход).

### 2.4 Защита черновиков
`src/navigation/draft-guard.tsx`: `useDraftGuard({ isDirty: () => boolean, discard, label })` через ref; навигация читает `isDirty()` синхронно в момент нажатия — заменяет все `onDirtyChange` (`OperationsScreen.tsx:533`, `PlanningScreen.tsx:120–127, 336–368`, `ImportScreen.tsx:160–164`, `App.tsx:389–413`). «Грязно» = отличается от снимка при открытии (не пересчитывается от `budget`; сейчас `pristineDraft` зависит от `budget`, `OperationsScreen.tsx:492`). После «Записать» черновик синхронно, до `await`, переходит в «записывается» и перестаёт быть грязным; запись доводит координатор App, итог — тост; при ошибке черновик возвращается с кнопкой «Вернуться». Подтверждение — `ConfirmDialog` («Продолжить ввод» / «Не сохранять»), `window.confirm` удаляется; на `popstate` при грязном черновике адрес возвращается в историю и открывается тот же диалог. `beforeunload` (`protectUnsavedDraftOnUnload`) и `UpdatePrompt hasUnsavedChanges` (`components/UpdatePrompt.tsx:124–205`) читают тот же реестр; добавить незавершённый вход в «Семье».

### 2.5 Исправления (a), (b)
(a) `src/em-scale.ts`: скрытый сторож `<span aria-hidden class="em-sentinel">` (`position: fixed; visibility: hidden; pointer-events: none; font-size: medium; width: 1em; height: 1em`) под `ResizeObserver`; `useKeypadAvailable` подписан на сторож + `resize` + `change`, снимок каждый раз свежий (`matchMedia(KEYPAD_HIDDEN_MEDIA)`); `KEYPAD_HIDDEN_MEDIA` (`Keypad.tsx:16`) — единственное условие.
(b1) синхронный реестр + «записывается» + диалог в приложении; e2e `e2e/fixtures.ts`: `page.on("dialog")` роняет тест; `recordExpense` ждёт тоста.
(b2) `family-sync.spec.ts`: `test.afterEach` поднимает сервер (`/__e2e__/sync/start`); `signIn` после «Выслать код» падает с текстом `role=alert`; поправить комментарий `:278`.

## 3. DESIGN.md 4.0

### 3.1 Оглавление
§0 «Что меняется против 3.0»; §1 Принципы (п. 4: тон метит сущность, янтарь/красный — сигнал, акцент — действие и выбор; п. 5: скругление по ролям); §2 Границы бренда (без монет, без сине-жёлто-зелёной тройки, без анимации броска; своя лексика — «Операции», не «Лента»); §3 Цвет; §4 Типографика; §5 Сетка и форма; §6 Компоненты (плитки, кольцо выбора, нижняя навигация с «+», лист ввода, чип, сегмент, строка и день ленты, кольцо, столбцы, тост с отменой, диалог, баннер «только чтение», отказ записи, строка «Можно…»); §7 Деньги (+ мультивалютность: валюта счёта на плитках и строках, база в итогах, «≈» и дата курса); §8 Экраны; §9 Доступность (строку «Цель нажатия — минимум 48×48 pt, между целями — 8 pt» сохранить дословно — её разбирает `src/design-contract.ts`); §10 Движение (токены прежние); §11 Реализация; §12 Приёмка.

### 3.2 Токены: макет → наши имена

| Макет | Токен | Решение |
|---|---|---|
| холст `#F3F1EC` | `--canvas #F0ECE3` | оставить (значок, заставки, `capacitor.config.ts` backgroundColor, `app-icon.test.ts`, `splash.test.ts`, `apps/android/scripts/brand-palette.mjs`) |
| `#1C1B19` | `--ink #171410` | оставить |
| `#5E5A52` | `--ink-muted #5D574C` | оставить |
| `#E2DDD3` (границы чипов), `#B9B3A6` (пунктир «+») | `--line #8D8577` | заменить (1.35:1 и 1.85:1 < 3:1) |
| `#F0ECE3` (разделители строк) | `--border #DDD6C8` | оставить |
| `#E6E1D6` | `--surface-sunken` | совпадает |
| коралл `#D9481F` | новый `--accent` | «+», кольцо выбора, текущий месяц на столбцах, точка активной вкладки |
| — | `--orange #B8471A` | только марка (значок, Android); в интерфейсе не использовать |
| `#22252A` / `#FFFFFF` / `#D5D8DE` | новые `--tile-account`, `--on-tile-account`, `--on-tile-account-muted` | |
| `#E9E7FB` / `#3F3FB0` | новые `--tile-income`, `--income-ink` | |
| `#1F6B48` (доход в ленте) | новый `--positive-ink` | всегда со знаком «+» |
| янтарь полосы `#B86E00` | `--amber-ink #8A5A00` | заменить (2.8:1 к треку) |
| красный `#B3261E` | `--red-ink #A3341F` | оставить |
| тона mint/peach/sage/sand/rose/lilac | `--tone-{mint,peach,sage,amber,coral,lilac}` + новые `--tone-*-ink`: `#DDEFE5/#1F6B48`, `#FBE3D3/#9A4A1C`, `#E3EBDD/#46613A`, `#F5EBCF/#7A5A00`, `#F8E1E4/#9B2C3F`, `#ECE6F7/#5B3F9E` | ключи прежние (`color` — синхронизируемые данные; G-003 пишет `"sage"`, `"mint"`); «sand» → `amber`, «rose» → `coral`; неизвестный ключ → тон по имени/группе |
| `#FFFFFFB3` (подложка глифа) | новый `--icon-plate` | |
| серии отчёта `#B88A1B` (3.14), `#B9B3A6` (2.09), столбцы `#C9C2B4` (1.77) | `--chart-1…7`: `#1F6B48, #8A5A00, #5B3F9E, #D9481F, #9B2C3F, #2F6F9F`, «Остальное»/прочие месяцы `#8D8577` | заменить слабые |

Радиусы (скруглённые плитки отменяют правило 3.0 «поверхности прямые»): `--radius-control` 14 и `--radius-pill` 999 — оставить; новые `--radius-tile` 16, `--radius-card` 20, `--radius-sheet` 24, `--radius-plate` 10, `--radius-fab` 18; `--radius-input` можно слить с control.
Типографика: `hero` 48/50 (сумма в листе); `hero-step` 28/32 (+ заголовок вкладок; «Всего на счетах» 30 → 28); `title` 17/23; `body` 15/22; `caption` 13/19; новый `--size-tile` 12/15; `label` 11/14 капсом (эйбрау и кикеры «ДОХОДЫ / СЧЕТА / РАСХОДЫ»; 0.06em → 0.08em); 600 → 700 (только 400 и 700). Все кегли — токенами `--size-*`/`--lh-*` в px (`e2e/font-scale.ts` умножает только их).
Размеры: плитки — категория `min-height` 92, счёт 76, доход 64×104; «+» 56; `--nav-height` 72 (кнопки 52, `layout-space.ts`); стрелки месяца, «Закрыть», «Повторять» 44 → 48; клавиши 52; чипы, сегмент, «+ метка» — цель 48 при видимой пилюле 32–36 (прозрачная кнопка, `.chip-face` внутри); сетки `repeat(auto-fill, minmax(max(4.5em, 64px), 1fr))` (320 → 4 колонки по 66; ×2.7 — меньше колонок).
Глубина: плитки плоские; карточки `--elevation-1`; лист и тост `--elevation-3`.

### 3.3 Контраст (тест `src/palette-contrast.test.ts` читает пары из таблицы §3 DESIGN.md и hex из `:root`)
Текст: `--ink` на холсте 15.57, на белом 18.36, на тонах 14.76–15.44, на плитке дохода 15.11; `--ink-muted` на холсте 6.07, на тонах 5.76–6.02, на плитке дохода 5.89; `--income-ink` на плитке дохода 6.78; белый на `--tile-account` 15.37, `--on-tile-account-muted` 10.77; `--positive-ink` на белом 6.45, на холсте 5.47.
Не текст (≥ 3): `--tone-*-ink` на подложке 5.88–7.50; заливка тона на треке 4.34–5.59; `--amber-ink` на треке 4.07–4.25; `--red-ink` на треке 4.70–4.91; белый глиф на `--accent` 4.29; кольцо `--accent` на холсте 3.64, на тёмной плитке 3.58, на тонах 3.45–3.58, на sunken 3.29; `--line` на белом 3.65, на холсте 3.10; серии графика на белом ≥ 3.65.
Запреты: `--accent` не для мелкого текста (4.29 < 4.5); красный текст на тёмной плитке нельзя (2.25) — отрицательный остаток белым с U+2212 и глифом; фокус `#0B57D0` на тёмной плитке 2.41 → кольцо только снаружи (offset 3, зазор 8; на холсте 5.42). Клавиши (1.18–1.30) и трек к тону (1.17) опознаются цифрой/подписью — записать явно.

### 3.4 Изменения токенов и проверок
Меняются: `--tone-*`. Добавляются: `--tone-*-ink`, `--accent`, токены плиток, `--positive-ink`, `--chart-*`, радиусы, `--size-tile`/`--lh-tile`; `--nav-height` 56 → 72. `--orange` уходит из интерфейса, остаётся токеном. Переписать «форму» в `src/motion-and-depth.test.ts:116–168` (радиусы — токены ролей, список поверхностей, `controlHousings`); обновить `src/design-contract.ts` (`TOUCH_TARGET_CLASSES` + `.tile`, `.chip`, `.fab`), `navigation-draft.test.tsx`, `phase8-accessibility.test.tsx`, `category-visual.test.ts`, `voice.test.tsx`.

## 4. Подволны (каждая — отдельный PR; `pnpm verify` + e2e; после каждой приложение выпускаемо)

### 2a. Каркас и навигация (без новых функций; чинит e2e)
Вливается после PR удержания синхронизации (оба трогают `App.tsx` и `controller.ts`).
Файлы: `App.tsx` (разбор на `app/*`, роутер вместо `Screen` `:66` и `navigate` `:700`, удаление `window.confirm` и `DISCARD_DRAFT_CONFIRMATION` `:74`, `writeBlock`); `styles.css` (токены §3.2, навигация на 5 мест); DESIGN.md §0–§5, §9; `Keypad.tsx`, `OperationsScreen.tsx`, `PlanningScreen.tsx`, `ImportScreen.tsx` (реестр черновиков); `UpdatePrompt.tsx`; `MainActivity.java`.
Новые: `navigation/routes.ts`, `navigation/router.ts`, `navigation/draft-guard.tsx`, `components/ConfirmDialog.tsx`, `BottomNav.tsx`, `ReadOnlyBanner.tsx`, `WriteRefusalNotice.tsx`, `write/useBudgetWrite.ts`, `em-scale.ts`.
Временная раскладка: Обзор = нынешний `TodayScreen`; Операции = `HistoryScreen` вкладкой; «+» = `#/new` с нынешним `OperationsScreen`; Отчёты = `TotalsFact` + список категорий; Ещё = прежнее + «План месяца», «План на год».
Тесты: маршруты (включая мусор), push/replace/back и родители, синхронный реестр, «записывается», возврат на `popstate`, доступность `ConfirmDialog`, отказ координатора при `writeBlock` с сохранением черновика, `em-scale` с поддельным `ResizeObserver`; переписать `navigation-draft.test.tsx` и тест «формы»; e2e: `fixtures.ts` (падение на нативном диалоге, `goTo(page, "Обзор")`), `keypad.spec.ts` (смена кегля без смены размера), `family-sync.spec.ts` (afterEach, ожидание квитанции, `signIn`), подписи вкладок в `family-budget.spec.ts`, `messages.spec.ts`, `accessibility.spec.ts`; новый сценарий «Назад» (`page.goBack()`).
Риски: новые подписи навигации в тестах; API удержания; «Назад» в Capacitor 8 — эмулятор.

### 2b. Обзор и лист ввода суммы
Файлы: `features/overview/*` (`OverviewScreen`, `overview-model.ts`, `pick-model.ts`, `MonthSwitch`, `ReachLine`); `components/tiles/{Tile, CategoryTile, AccountTile, IncomeTile, AddTile, TileGrid}.tsx`; `features/entry/*` (`EntrySheet`, `entry-model.ts`, `FromToTiles`, `TargetPicker`, `DateChips`, `NoteField`, `TagChips`); `components/Toast.tsx`; `features/rates/RateQuickSheet.tsx`. Правки: `operations/model.ts` (заметка, метки, иностранный снимок, `toAmount`); `packages/domain/src/rates.ts` + общий `baseSnapshot`; `category-visual.ts` (`Map`, поля через `Object.hasOwn`); `money.ts`, `Money.tsx` (проп `currency`, контекст базы, `formatToParts` для любой валюты).
Удалить: `TodayScreen`, `CategoryList`, `TransactionList`, `OperationsScreen`/`Envelope`, `.envelope*`, `.record-*`, `.hero-card`.
Тесты: `pick-model` (все последовательности); `overview-model` (G-002 «Можно… 27 000 ₽», пороги, итог holdings); `entry-model` (все виды, иностранный счёт без курса — понятный отказ, заметка и метки, Сегодня/Вчера по местному календарю); UI листа (ловушка фокуса, Esc с защитой черновика); e2e `overview.spec.ts` (четыре тап-последовательности, DnD на десктопе `dragTo`, только клавиатура, 320 и ×2.7 без горизонтальной прокрутки); `entry.spec.ts` вместо `keypad.spec.ts` («шесть касаний от плитки до записи», выражения, каретка и буфер, скрытие клавиатуры); хелперы family-sync (запись через плитку, `flexibleRemaining` → `.reach-line strong`).
Риски: канонические G-002 в e2e; плотность 23 категорий; длинные имена; недоступный курс.

### 2c. Справочники: счета, курсы, категории и доходы, метки
Файлы: `features/accounts/*`, `features/rates/*` (экран), `features/categories/*` (+ `CategorySheet.tsx`), `features/tags/*`; `components/{IconPicker, TonePicker, CurrencySelect, ReorderControls}.tsx`; иконки в спрайт (без монет): `search`, `x`, `check`, `pencil`, `archive`, `chart-pie`, `chart-column`, `hand-coins`, `layout-grid`, `list`, `chevron-left`, `hash`, `dollar-sign`, `euro`, `scale`.
Домен: `accounts.ts`, `updateCategory`/`moveCategory`, `renameTag`, `setBaseCurrency`; возможно выбор базы в онбординге (`onboarding/model.ts` `currency: "RUB"` → `CurrencyCode`).
Тесты: домен (валюта неизменна при ссылках; цели и планы только в базе; дубли имён; пределы `sortOrder`; `isDisplayKey`); `family/journal.test.ts` (круговой проход правки счёта); e2e `manage.spec.ts` (USD-счёт, курс, расход в $, плитка в $, итог в ₽; переименование, иконка, цвет, лимит; архив прячет с Обзора, в ленте остаётся).
Риски: LWW целой сущности при одновременной правке; правка начального остатка.

### 2d. Лента операций и отчёты
Файлы: `features/feed/*` (`FeedScreen`, `FeedRow`, `DayGroup`, `FilterBar`, `FilterSheet`, `feed-model.ts`), `features/reports/*` (`ReportsScreen`, `Donut`, `MonthBars`, `ReportLegend`, `report-model.ts`), `packages/domain/src/reports.ts`, `e2e/canonical-ledger.ts` (G-003 из `@family-budget/test-fixtures`). Удалить: `HistoryScreen.tsx`, `history.test.tsx`.
Адрес: фильтры — новые ключи `operations` в `QUERY_GRAMMAR` (дата, UUID, перечень), каждый с примером в `ROUTE_FIXTURES` и в выписанном руками `ROUTE_FRAGMENT` (`navigation/test-fixture.ts`). Строка поиска — состояние экрана в памяти, не ключ адреса и не `history.state`: ни `q=`, ни иного свободного текста грамматика не принимает, и `address-privacy.test.ts` это держит.
Тесты: домен на G-003 (C1 1 550 000; C2 факт 506 338; T1 506 338, T2 1 550 000, T3 12 000 000); `feed-model` (фильтры, поиск по заметке, метке, «1 250»/«1250», итоги дня); фильтры в адресе (Назад восстанавливает; строки поиска в адресе нет); доступность графиков (`role="img"` + таблица); e2e `feed.spec.ts`, `reports.spec.ts`.
Риски: 50 000 операций (мемоизировать индекс); календарный период против окна бюджета (определить явно); доли меток > 100 %.

### 2e. Долги, цели, регулярные
Файлы: `features/debts/*`, `features/goals/*`, `features/recurring/*` (`RecurringScreen`, `RepeatSheet`), `app/useRecurringOnOpen.ts`; домен `goals.ts`, `createRecurringRule`/`updateRecurringRule`; черновики долга в `operations/model.ts`; `family.deletedIds()` + помощник в sync-protocol.
Тесты: четыре глагола D-033; прогресс цели, срок, рекомендуемый взнос; «Повторять» сегодня — одна операция с выведенным id; идемпотентность на двух «устройствах»; `deletedIds` соблюдается; материализация не трогает правила без наступивших вхождений; e2e `debts-goals-recurring.spec.ts` с `page.clock` (на следующий день вхождение появляется один раз, удалённое не возвращается).
Риски: зависимость от ветки синхронизации; двойной счёт `RecurringRule` и `ScheduledExpense` в «Плане на год»; смена дня и часовой пояс.

### 2f. Уборка, финал DESIGN.md 4.0, гейты
Удалить мёртвые классы и токены (DESIGN §11); финал DESIGN.md §6–§8, §11, чек-лист §12; `palette-contrast.test.ts`; e2e доступности по всем маршрутам (320/375/390/430, 512×680, 667×375, 768, 1024; ×1 и ×2.7); проверка сообщений на новых маршрутах; новое демо (`onboarding/demo.ts`: карта, наличные, USD с курсом, копилка; источники дохода, метки, долг, цель со сроком, правило); снимки для магазина (`e2e/hello-shot.ts` → `outputs/.../store-assets`); документы `PRODUCT_SPEC.md`, `ARCHITECTURE.md`, `QA_ACCEPTANCE.md`, `IMPLEMENTATION_STATUS.md`; лист сравнения экранов с CoinKeeper для юриста.
Риски: перегенерация ассетов; хрупкие проверки по исходнику.

## 5. Правила доступности и языка для каждого экрана
1. Перетаскивание всегда дублируется касанием: основной путь — касания; DnD только `pointer: fine` через тот же автомат; выбор — `aria-pressed`, видимая галочка, кольцо, подсказка в `role="status"`; Esc сбрасывает; ничего «только долгим нажатием» — у каждого ряда «Изменить».
2. Цвет никогда не единственный сигнал: состояние лимита — глиф (треугольник — почти лимит, круг — перелимит) + цифры «3 500 / 3 000» + слово в доступном имени; доход/расход — «+»/«−»; просрочка — слово и глиф; сегменты графика — легенда с суммой и долей + таблица; текущий месяц — жирная подпись.
3. Суммы только через `Money`/`formatToParts`: неразрывные пробелы, U+2212, `tabular-nums`, знак валюты всегда; `nowrap` на суммах запрещён; разрыв разрядов только в герое; валюта счёта на плитках/строках, база в итогах; литерал «₽» в коде запрещён (база из `household`).
4. 320 px: нет горизонтальной прокрутки; ряд доходов прокручивается внутри; имена на плитках до двух строк с `hyphens: auto`, полное имя — в доступном имени и в листе.
5. Масштаб 200 % и ×2.7: медиа/контейнерные запросы в `em`; клавиатура по сторожу `em`; кегли только токенами; лист становится прокручиваемой страницей; цели ≥ 48×48, зазор 8 (§9).
6. Фокус: кольцо 3 px, отступ 3, `--focus`; `h1` в фокусе после перехода; лист ловит фокус и возвращает на плитку.
7. Чужой текст: заметки и имена в `<bdi>` с `dir="auto"`, переполнение ограничено; ключи оформления только через `Map`/`Object.hasOwn`; неизвестный ключ — запасной вид (SECURITY §7.2).
8. Движение: только токены; `prefers-reduced-motion` отключает всё; анимации броска нет.
9. Язык: `lang="ru"`; счётные слова через `plural.ts`; даты через `Intl` ru-RU с неразрывным пробелом; проценты через `Intl` («52 %»); имена не склоняются, рядом рамочное слово («в категории «Продукты»»); глаголы долгов по D-033; своя лексика (не «Лента», не «Участники учёта», не «монетки», без тарифов конкурента); текстовые глифы вроде «⌫» запрещены (`Icon.test.tsx`), только спрайт.

## 6. Решения по умолчанию (оркестратор) и вопросы владельцу
По умолчанию: «Всего на счетах» = `calculateHoldings` (курсы, `includeInTotal`); строка «Можно на повседневные · хватает до…» остаётся на Обзоре (наше отличие); имена на плитках обрезаются после двух строк (полное имя в доступном имени); `RecurringRule` в «План на год» не входят, экран предупреждает о похожем платеже; палитра и скруглённые плитки; только ручные курсы; без SMS/push; синхронизация выключена в сборках; PIN и уведомления — следующая волна; Excel заморожен; «Свой период» в отчётах бесплатно; база RUB (выбор в онбординге необязателен); цели и планы только в базе; расширенное демо.
До выпуска: юридическая сверка экранов с CoinKeeper; проверка на настоящих iPhone и Android после 2b и 2f.
