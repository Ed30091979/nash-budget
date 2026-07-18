# Versioned contracts

Этот каталог — единый машиночитаемый контракт расчётов для Excel-прототипа и Android core. Golden fixtures самодостаточны: потребитель читает один JSON-файл, проверяет его по схеме и сравнивает результат расчёта с объектом `expected`.

## Версия 1.0.0

- JSON Schema: `schemas/budget-fixture.schema.json`;
- базовый сценарий: `fixtures/g-000.json`;
- сценарий с целью: `fixtures/g-001.json`;
- все денежные значения с суффиксом `Minor` — целые числа в минимальных единицах валюты;
- для RUB `minorUnit.exponent = 2`, поэтому `10000000` означает 100 000,00 ₽;
- `occurredOn`, `startDate`, `endDate` и `deadline` — локальные календарные даты семьи без времени;
- `createdAt` и `updatedAt` — UTC timestamps;
- идентификаторы стабильны и не должны генерироваться заново при запуске теста.

`G-001` содержит весь `G-000` и дополнительную цель/операцию. Поле `derivedFromFixtureId` служит для трассировки, а не для наследования или merge.

## Правила расчёта

Схема проверяет форму данных и основные кардинальности. Реализация дополнительно обязана проверять ссылочную целостность и следующие инварианты:

1. `effectiveLimitMinor = plannedMinor + rolloverMinor + adjustmentMinor`.
2. В факт входят только транзакции со `status = posted`.
3. Доход имеет одно положительное движение. Расход имеет одно отрицательное движение, а сумма splits равна `amountMinor`.
4. Перевод и взнос в цель имеют ровно два движения, их сумма равна нулю; они не входят ни в доход, ни в расход.
5. `expenseMinor` — чистый расход: проведённые расходы минус проведённые возвраты по категориям.
6. Баланс счёта равен начальному балансу плюс сумма проведённых движений по счёту. `netWorthMinor` — сумма балансов всех активных счетов.
7. `remainingExpenseLimitsMinor` — сумма `effectiveLimitMinor - actualExpenseMinor` по расходным категориям.
8. `plannedFreeToAllocateMinor = plannedIncomeMinor - plannedExpenseLimitsMinor - plannedGoalContributionsMinor`.
9. `usageBasisPoints` — отношение факта к эффективному лимиту, умноженное на 10 000 и округлённое до ближайшего целого по правилу half-up. Для нулевого лимита значение `null`.
10. Статус категории определяется в таком порядке: факт выше лимита — `over_limit`; факт ровно равен лимиту — `limit_exhausted`; факт не ниже предупреждающего порога — `warning`; иначе — `within_limit`. При нулевом лимите положительный факт сразу даёт `over_limit`.
11. `overLimitMinor = max(actualExpenseMinor - plannedLimitMinor, 0)`.

Ссылки `householdId`, `memberId`, `accountId`, `categoryId`, `periodId`, `optionalGoalId` и `originalTransactionId` должны указывать на сущности того же fixture. `currency` счетов и `minorUnit.currency` должны совпадать с `household.baseCurrency` для этих single-currency fixtures.

В `G-001` для полноты сущности задана детерминированная цель 100 000 ₽. Критерий из QA остаётся прежним: взнос 10 000 ₽ увеличивает прогресс на 10 000 ₽ и не меняет доход, расход или общий капитал.

## Политика версий

- `schemaVersion` использует Semantic Versioning.
- Breaking-изменение обязательных полей или семантики повышает major-версию.
- Совместимое добавление необязательного поля повышает minor-версию.
- Исправление описания или fixture без изменения семантики повышает patch-версию.
- Потребитель обязан отклонить неизвестную major-версию до частичного импорта.
- Изменение существующего golden fixture требует отдельного review ожидаемых сумм до обновления Excel и Android тестов.

## Минимальная проверка

```bash
python3 -m json.tool contracts/schemas/budget-fixture.schema.json >/dev/null
python3 -m json.tool contracts/fixtures/g-000.json >/dev/null
python3 -m json.tool contracts/fixtures/g-001.json >/dev/null
```

Если установлен пакет `jsonschema`, fixtures также проверяются непосредственно по Draft 2020-12 schema.
