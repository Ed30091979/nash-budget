# План публикации в RuStore

Актуальность проверки: 17 июля 2026 года. Перед фактической публикацией требования перепроверяются повторно по официальной документации.

## Главный вывод

RuStore получает полноценное Android-приложение, собранное через Capacitor в APK/AAB. React/TypeScript assets входят в artifact локально: это не ярлык и не оболочка удалённого сайта. Production build не содержит `server.url`, а бюджет, IndexedDB, backup и основной UI работают в airplane mode с первого запуска после установки.

Источники: [публикация приложений](https://www.rustore.ru/help/developers/publishing-and-verifying-apps/app-publication), [требования модерации](https://www.rustore.ru/help/developers/publishing-and-verifying-apps/requirement-apps).

## Контракт Capacitor-сборки

- `apps/web-pwa` и `apps/android` используют один проверенный production build из общих `packages/*`;
- Capacitor `webDir` указывает на локальный build output, который копируется в Android project перед release;
- `server.url` и live-reload URL разрешены только в отделённой development-конфигурации и запрещены в production;
- core-функции не загружают UI, расчёты, схемы или пользовательские данные с PWA-домена;
- Android artifact проходит первый запуск и полный core-сценарий в airplane mode;
- network inspection, распаковка artifact и automated config scan входят в release gate;
- внешние ссылки не выполняются внутри доверенного app origin без allowlist-политики.

Capacitor является способом упаковки, но не освобождает продукт от требований к законченности, качеству, безопасности, данным и разрешениям.

## Аккаунт и владение

- бесплатное приложение может публиковать физлицо, ИП или юрлицо;
- монетизация RuStore — платное приложение, подписки и внутренние товары — доступна ИП и юрлицам;
- для коммерческого проекта лучше сразу использовать отдельный рабочий VK ID и корпоративно контролируемый аккаунт;
- доступ выдаётся ролями; владелец, релиз-менеджер и финансовая роль не должны зависеть от личного аккаунта временного сотрудника;
- для регистрации ИП/юрлица применяются предусмотренные RuStore способы подтверждения, включая УКЭП/VK Бизнес ID по текущим правилам.

Источники: [регистрация разработчика](https://www.rustore.ru/help/developers/developer-account/registration-developer), [страница разработчика и различия аккаунтов](https://www.rustore.ru/developer), [роли и доступы](https://www.rustore.ru/help/developers/developer-account/user-roles).

Решение до первой публикации: если монетизация входит в ближайший план, создавать коммерческий контур под ИП/ООО, а не выпускать продукт из личного аккаунта «на время».

## Package name, AAB и подпись

- выбрать уникальный неизменяемый `packageName`;
- зафиксировать схему `versionCode` и build flavors;
- для production предпочесть AAB;
- перед `cap sync` собирать только проверенные production web-assets;
- включать assets в artifact через локальный `webDir`, без remote runtime URL;
- выполнить процедуру подписи AAB по документации RuStore, включая upload key/app-signing материалы;
- release key и пароли хранить как критичные секреты с несколькими защищёнными резервными копиями;
- подпись последующих версий должна совпадать, иначе обновления и часть SDK не смогут подтвердить приложение;
- при публикации в нескольких магазинах заранее согласовать единую стратегию сертификата и отдельные store-flavors.

Источники: [загрузка AAB](https://www.rustore.ru/help/developers/publishing-and-verifying-apps/app-publication/new-version-app/upload-aab), [подписи APK/AAB](https://www.rustore.ru/help/developers/publishing-and-verifying-apps/app-publication/apk-signature), [проверка подписи](https://www.rustore.ru/help/guides/check-sign).

## Категория, данные и разрешения

RuStore относит учёт расходов и ведение бюджета к категории «Финансы». Сам калькулятор не выполняет банковские операции, однако правила магазина и применимое законодательство о данных всё равно обязательны.

Для local-first MVP:

- не запрашивать чувствительные разрешения без функции, которая действительно без них невозможна;
- не собирать ФИО, телефон, контакты, SMS, банковские реквизиты и геолокацию;
- точно задекларировать собираемые/передаваемые типы данных и разрешения;
- разместить политику конфиденциальности, пользовательские условия и контакты поддержки;
- не отправлять суммы, категории, комментарии и содержимое экспортов в аналитику или crash-логи;
- получить отдельное юридическое заключение до появления аккаунтов, облачной семейной синхронизации или внешней аналитики.

RuStore указывает: при работе с персональными данными разработчик должен обеспечить требуемый статус оператора, информирование и согласие; запрещённые permissions ведут к отклонению, чувствительные требуют обоснования. Это не заменяет индивидуальную юридическую консультацию по 152-ФЗ.

Источники: [категории](https://www.rustore.ru/help/developers/publishing-and-verifying-apps/app-publication/new-version-app/category), [требования к данным и разрешениям](https://www.rustore.ru/help/developers/publishing-and-verifying-apps/requirement-apps), [декларация разрешений](https://www.rustore.ru/help/developers/publishing-and-verifying-apps/app-publication/new-version-app/declare-app-permissions), [статья 22 закона 152-ФЗ](https://www.consultant.ru/document/cons_doc_LAW_61801/d996966e22e1320c9de1ab82d9f6be12c3d9d765/).

## Монетизация: критическое изменение 2026 года

**Новый проект не должен использовать RuStore BillingClient SDK.** RuStore сообщает, что 1 августа 2026 года обработка покупок и подписок через BillingClient прекращается. При будущей монетизации применяется актуальный **RuStore Pay SDK** через тонкий Kotlin Capacitor plugin; TypeScript domain не зависит от SDK магазина.

Рекомендуемая продуктовая последовательность:

1. бесплатный local-first MVP;
2. после подтверждения спроса — одноразовый Pro для локальных функций;
3. подписка только вместе с постоянной серверной ценностью, например защищённой синхронизацией семьи;
4. узкий TypeScript-интерфейс `StorePayments` и Kotlin bridge внутри `apps/android`;
5. серверная проверка покупки, восстановление прав, отмены, возвраты и окончание подписки.

Источники: [Pay SDK](https://www.rustore.ru/help/sdk/pay), [уведомление о прекращении BillingClient](https://www.rustore.ru/help/sdk/payments/kotlin-java/migration/3-2-0-migration), [платёжная песочница](https://www.rustore.ru/help/developers/monetization/sandbox).

## Тестирование и выпуск

Последовательность:

1. внутренние debug/release сборки и device matrix;
2. artifact/config scan и первый запуск в airplane mode;
3. закрытая альфа в RuStore с проверкой сохранения IndexedDB при обновлении;
4. устранение ошибок и проверка store-card;
5. ручная первая публикация;
6. поэтапный rollout `5% → 20% → 50% → 100%` как стартовая политика;
7. после первой активной версии — автоматизация загрузки/публикации через RuStore API;
8. мягкое обновление по умолчанию; принудительное только при критической несовместимости.

Открытая бета доступна после публичного релиза и не заменяет закрытую альфу. Тестовые данные/аккаунт для модератора предоставляются, если появится авторизация.

Источники: [альфа-тестирование](https://www.rustore.ru/help/developers/publishing-and-verifying-apps/app-publication/testing/alpha-testing), [бета-тестирование](https://www.rustore.ru/help/developers/publishing-and-verifying-apps/app-publication/testing/beta-testing), [поэтапная публикация](https://www.rustore.ru/help/developers/publishing-and-verifying-apps/app-publication/setting-up-publication/step-by-step-publication), [RuStore API](https://www.rustore.ru/help/work-with-rustore-api/api-upload-publication-app), [Update SDK](https://www.rustore.ru/help/sdk/updates).

## Android Developer Verification

Это отдельный release-risk. RuStore указывает дату применения проверки разработчика/package name для своих приложений с 30 сентября 2026 года, тогда как текущий Android FAQ описывает поэтапное глобальное внедрение. Консервативный план:

- до релиза повторно сверить обе официальные страницы;
- заранее зарегистрировать разработчика, package name и ключ, если процедура уже применима;
- для организации заранее подготовить требуемые корпоративные документы, включая D‑U‑N‑S при необходимости.

Источники: [позиция RuStore](https://www.rustore.ru/help/developers/publishing-and-verifying-apps/app-publication/package-name-verification), [Android Developer Verification FAQ](https://developer.android.com/developer-verification/guides/faq), [Android Developer Console для распространения вне Google Play](https://developer.android.com/developer-verification/guides/android-developer-console).

## Release checklist

### Владение и доступ

- [ ] Выбран тип аккаунта и юридический владелец.
- [ ] Рабочий VK ID не принадлежит временному сотруднику.
- [ ] Назначены роли и резервный администратор.

### Сборка

- [ ] `packageName`, `versionCode` и flavors зафиксированы.
- [ ] Release key создан, проверен и резервирован.
- [ ] Production React assets собраны, протестированы и скопированы в локальный Capacitor `webDir`.
- [ ] `server.url`, live-reload URL и remote app shell отсутствуют в production config/artifact.
- [ ] APK/APKS, сгенерированный из release AAB для тестового устройства, устанавливается и запускается; сам AAB напрямую не устанавливается.
- [ ] Обновление предыдущей версии через альфа-трек RuStore сохраняет данные и проходит с той же app-signing подписью.
- [ ] Нет BillingClient; Pay/Update SDK используются только при наличии функции и только через проверенный Kotlin/Capacitor bridge.

### Качество

- [ ] Приложение стабильно offline и после перезапуска.
- [ ] Первый запуск после установки полностью проходит в airplane mode.
- [ ] PWA-домен недоступен, но UI, IndexedDB, расчёты и backup продолжают работать.
- [ ] Пройдены golden, migration, import/export и UI-тесты.
- [ ] Обновление приложения сохраняет и при необходимости мигрирует IndexedDB.
- [ ] Проверены слабое устройство, разные экраны и accessibility.
- [ ] Нет финансовых данных в production-логах.

### Карточка и compliance

- [ ] Русское название/описание без кликбейта и чужих товарных знаков.
- [ ] Иконка и скриншоты соответствуют фактическому UI.
- [ ] Категория, возрастная маркировка, контакты и поддержка заполнены.
- [ ] Privacy policy и пользовательские условия доступны.
- [ ] Разрешения и типы данных задекларированы по фактическому поведению.
- [ ] Проверена актуальная процедура Android Developer Verification.

### Релиз

- [ ] Закрытая альфа завершена.
- [ ] Есть план поэтапного rollout и критерии остановки.
- [ ] Есть канал поддержки и процедура ответа на отзывы.
- [ ] После первой активной версии настроена безопасная CI/CD-автоматизация.
