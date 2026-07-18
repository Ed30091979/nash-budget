# План выполнения

Оценки ниже — ориентиры для одного основного разработчика с помощью Codex. Они уточняются после Excel-прототипа и вертикального PWA/Capacitor-среза.

## Цель

Создать понятный семейный калькулятор, который:

- показывает план и факт доходов/расходов;
- показывает сезонность и крупные платежи на горизонте 12/24 месяца;
- предупреждает о приближении к лимиту и перелимите;
- не даёт двойного учёта переводов, возвратов и накоплений;
- работает без сети и регистрации после установки;
- доступен семье на iPhone/iPad как Home Screen PWA;
- публикуется в RuStore как Capacitor Android app с локальными assets;
- масштабируется без дублирования бизнес-логики по платформам.

## Продуктовые контуры

| Контур | Назначение | Результат |
|---|---|---|
| Excel | Проверка методологии, формул и UX; ранняя пользовательская ценность | `.xlsx` без макросов |
| Web/PWA | Основное installable приложение для Safari/iOS и других браузеров | HTTPS PWA, manifest `standalone`, Workbox service worker |
| Android/RuStore | Доставка того же React/TypeScript приложения в магазин | Capacitor shell и подписанный `.aab` с локальными assets |

PWA и Android — один продукт: общий React UI, TypeScript domain, IndexedDB storage и fixtures. Excel остаётся отдельной исполнимой спецификацией. Связующее звено всех контуров — единая терминология, схемы данных и golden-тесты.

## Этапы

### 0. Основание проекта — 2–3 рабочих дня

- утвердить границы MVP и единый scope PWA/Android;
- утвердить словарь операций и формулы;
- определить стартовые категории;
- проверить существующие versioned JSON fixtures в `contracts/` и отдельно зафиксировать backup schema;
- зафиксировать имя продукта, web origin, package name и модель владения аккаунтом RuStore;
- зафиксировать минимальную матрицу Safari/iOS, Android и System WebView для spikes.

Выходной критерий: один и тот же пример можно однозначно рассчитать вручную, в Excel и `packages/domain`.

### 1. Excel-MVP — 1–2 недели

- листы «Быстрый старт», «Дашборд», «Горизонт 24 мес», «Крупные и ежегодные», «Ежемесячные», «Сезонные», «Повседневные», «Операции», «Цели», «Настройки», «Справочники»;
- отдельные модели ежегодного/разового платежа, ежемесячной регулярки, выбранных месяцев и повседневного лимита;
- таблицы, проверки ввода и защищённые формулы;
- статусы «В норме», «Близко к лимиту», «Лимит исчерпан», «Перелимит»;
- графики план/факт и динамики трат;
- визуальная проверка каждого листа и полный QA из `QA_ACCEPTANCE.md`.

Выходной критерий: файл проходит golden-тесты, открывается без восстановления и не содержит ошибок формул.

### 2. Пользовательская проверка — 1–2 недели параллельно

- 5–10 семей с разным составом, доходом и сочетанием iOS/Android;
- проверка терминов, категорий, порогов и полезности графиков;
- проверка понятности установки через Safari «На экран Домой»;
- фиксация времени до первого бюджета, первой резервной копии и типичных ошибок;
- решение, нужны ли цели и регулярные платежи в первом app-релизе.

Выходной критерий: список подтверждённых сценариев, отклонённых гипотез и зафиксированный одинаковый scope PWA/Android.

### 3. Вертикальный PWA/Capacitor-срез — 1–2 недели

Реализовать одну цепочку:

`первый запуск → лимит → расход → предупреждение → обновлённый дашборд → backup export`.

Одновременно:

- создать monorepo и границы `apps/*`/`packages/*`;
- реализовать чистое TypeScript-ядро и IndexedDB repository;
- собрать manifest `standalone` и Workbox precache;
- установить PWA через Safari/Home Screen и пройти сценарий offline;
- собрать Capacitor Android с local `webDir`, без `server.url`;
- пройти тот же сценарий на Android в airplane mode с первого запуска после установки;
- проверить backup/export и restore на iOS и Android.

Выходной критерий: один production web build работает как установленная PWA и внутри подписываемой Android test build, а результаты совпадают с fixtures.

### 4. Local-first app MVP — 6–9 недель

- React + TypeScript, IndexedDB, Workbox и Capacitor;
- доходы, расходы, возвраты и атомарные переводы;
- счета, категории, крупные платежи, ежемесячные и сезонные расписания, повседневные лимиты;
- дашборд, фильтры, поиск и in-app сигналы;
- versioned JSON backup/restore и CSV-экспорт;
- storage migrations и controlled service-worker updates;
- accessibility, unit-, migration-, UI- и integration-тесты;
- отсутствие аккаунта, backend, банковских разрешений и чувствительной телеметрии.

Выходной критерий: все core-сценарии работают offline на Home Screen PWA и Android/Capacitor и дают одинаковые результаты с Excel fixtures.

### 5. Hardening, PWA deploy и RuStore — 2–3 недели

- compatibility matrix на реальных Safari/iOS и Android System WebView;
- storage eviction/backup recovery drills;
- security headers, CSP, dependency audit и проверка отсутствия remote code;
- проверка release artifact: local assets, нет production `server.url`, airplane mode;
- privacy/legal review и финальная декларация данных/разрешений;
- signing key и резервные копии;
- HTTPS PWA deploy, карточка RuStore, скриншоты, политика конфиденциальности и поддержка;
- закрытая альфа, исправления и поэтапный релиз.

Выходной критерий: стабильная installable PWA и общедоступная RuStore-версия с проверенным recovery/rollback-процессом.

### 6. Синхронизация и монетизация — только после валидации

Отдельный проектный этап, ориентир 6–10 недель:

- аккаунты, приглашения и роли семьи;
- server sync, аудит, отзыв доступа и conflict resolution;
- persistent outbox, idempotency и удаление данных;
- актуальный RuStore Pay SDK через тонкий Kotlin/Capacitor bridge;
- server-side проверка прав, восстановление покупок и возвраты;
- PWA-модель оплаты только после отдельного продуктового и правового решения.

До этого этапа подписка не нужна: регулярная оплата оправдана только регулярной серверной ценностью.

## Предлагаемая структура проекта

```text
Бюджет семейный/
├── README.md
├── docs/
├── excel-template/
├── apps/
│   ├── web-pwa/        # React entry, manifest, Workbox service worker
│   └── android/        # Capacitor Android shell и будущие Kotlin bridges
└── packages/
    ├── domain/         # TypeScript-модели и расчёты без platform API
    ├── storage/        # IndexedDB repositories, migrations, backup codecs
    ├── platform/       # Web/Capacitor adapters и store ports
    ├── ui/             # Общие React screens/components
    └── test-fixtures/  # Типизированный package-адаптер к корневому contracts/
```

Корневой `contracts/` остаётся каноническим источником JSON Schema/golden fixtures; `packages/test-fixtures` не дублирует их, а предоставляет TypeScript-валидацию и импорт. Папка backend появляется только после отдельного решения о синхронизации.

## Критические точки решения

1. После Excel: подтверждены ли формулы и повседневная ценность?
2. После vertical slice: одинаково ли надёжен сценарий в Safari/Home Screen и Capacitor airplane mode?
3. Перед MVP: подтверждены ли storage migrations, backup/restore и service-worker update без потери данных?
4. Перед RuStore: физлицо для бесплатного релиза или ИП/ООО для коммерческого контура?
5. После публичного MVP: нужна ли многопользовательская синхронизация?
6. Только после доказанного спроса: одноразовый Pro или подписка?
