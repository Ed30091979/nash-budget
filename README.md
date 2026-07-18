# Семейный бюджет

Статус: второй рабочий инкремент, версия `0.4` от 17 июля 2026 года.

## Рекомендация

Проект развиваем двумя связанными продуктами и двумя способами доставки основного приложения:

1. Excel-шаблон без макросов — быстрый рабочий MVP, проверяемая спецификация формул и самостоятельный скачиваемый продукт.
2. Единое offline-first приложение на React + TypeScript:
   - installable PWA для Safari на iPhone/iPad и запуска с Home Screen;
   - Android-приложение для RuStore через Capacitor с теми же локально собранными web-assets.

Excel не является кодовой основой приложения. Excel, PWA и Android-сборка используют одинаковые термины, правила учёта, контрольные примеры и версионируемый контракт данных. PWA и Android, в отличие от Excel, разделяют одно TypeScript-ядро и один React UI.

## Документация

- [План и этапы](docs/PROJECT_PLAN.md)
- [Продукт и границы MVP](docs/PRODUCT_SPEC.md)
- [Спецификация Excel-MVP](docs/EXCEL_MVP.md)
- [Архитектура PWA и Android/Capacitor](docs/ARCHITECTURE.md)
- [Публикация в RuStore](docs/RUSTORE_RELEASE.md)
- [QA и критерии приёмки](docs/QA_ACCEPTANCE.md)
- [Skills, агенты и рабочий процесс](docs/SKILLS_AND_WORKFLOW.md)
- [Журнал решений](docs/DECISIONS.md)
- [Источники](docs/SOURCES.md)

## Уже реализовано

- legacy Excel-прототип с 11 листами сохранён без удаления под `outputs/legacy/`, но из-за найденных расхождений и сообщения `#NAME` исключён из baseline и не считается текущим/release-ready MVP;
- канонические JSON fixtures и JSON Schema в `contracts/`;
- TypeScript domain-пакет с integer minor units, расчётом горизонта 12/24 месяца, резервом к сроку и сезонными расписаниями;
- мобильная React PWA: дружелюбный экран «Сегодня», горизонт 12/24 месяца, крупные и ежегодные платежи, ежемесячная и сезонная регулярка, повседневные лимиты, IndexedDB, offline app shell и JSON backup/restore;
- production Capacitor-конфигурация с локальным `webDir` и без `server.url`.

Текущий интерфейс запускается на демонстрационном сценарии планирования: страховка автомобиля, загородный дом, летний лагерь и обучение детей с сентября по май. Контрольный G-001 сохранён в domain-тестах как неизменяемая проверка базовой арифметики.

Старая Excel-книга не подтверждает актуальные контрольные значения: raw Settings содержит `158 000 ₽` при `180 000 ₽` в builder, а commitments — прежние `10 000 ₽`/`17 500 ₽`. Исходники builder и sanitizer сохраняются; новый workbook будет создан в фазе 2 после восстановления требуемого artifact-tool loader/runtime. Legacy-файл не удалён и не будет переиздан как итоговый.

## Запуск web/PWA

Требуется Node.js 24+ и pnpm 11.9+.

```bash
pnpm install
pnpm verify
pnpm dev
```

Production preview после `pnpm build`:

```bash
pnpm --filter @family-budget/web preview
```

## Следующий инкремент

- восстановление artifact-tool loader/runtime и генерация нового Excel-файла из канонического G-002 вместо legacy workbook;
- onboarding и создание пустой семьи вместо demo seed;
- формы редактирования крупных, ежемесячных, сезонных и повседневных планов в приложении;
- UI возврата, перевода и взноса в цель;
- миграции IndexedDB и атомарная проверка restore;
- генерация нативного Android-проекта, airplane-mode smoke и первая unsigned AAB;
- HTTPS staging и ручная проверка установки через Safari/Home Screen.

Точный статус и доказательства проверок: [docs/IMPLEMENTATION_STATUS.md](docs/IMPLEMENTATION_STATUS.md).
