/**
 * Место под навигацию и шапку — измеренное, а не предположенное.
 *
 * Токен `--nav-height` называет проектную высоту панели: 4 + 48 + 4 (§6 `DESIGN.md`). Но панель
 * растёт вместе с системным шрифтом: при ×2.7 подписи вкладок переносятся, и на 320 pt панель
 * занимает 188 pt, на 390 — 150. Отступ оболочки и полоса записи считались от 56, полоса вставала
 * на 56, панель занимала 150 — и кнопка «Записать покупку» уходила под навигацию ровно в том
 * режиме, который включают ради читаемости. На широком экране та же арифметика у шапки: навигация
 * липла под воображаемую шапку в 56 pt, а настоящая при ×2.7 — 79, и верх вкладок был под ней.
 *
 * Таблица стилей не умеет прочитать высоту одного блока для другого, поэтому высоты снимаются с
 * разметки и пишутся в токены места — `--nav-space` и `--header-space`, — от которых считаются все,
 * кто на панель и шапку опирается. Пока измерения нет, токены держат проектные значения из `:root`.
 * Сама панель эти токены не читает: её `min-height` считается от `--nav-height`, иначе измерение
 * кормило бы само себя.
 */
export const NAV_SPACE_PROPERTY = "--nav-space";
export const HEADER_SPACE_PROPERTY = "--header-space";

/**
 * Пишет настоящие высоты шапки и навигации в токены места на `root` и держит их в актуальном
 * состоянии, пока не вызвана возвращённая отписка. Отписка снимает токены: без навигации на экране
 * место под неё резервировать нечему.
 *
 * Высота берётся у рамки блока целиком — с внутренними отступами и safe-area, — потому что именно
 * столько панель занимает на экране.
 */
export function observeLayoutSpace(root: HTMLElement, header: Element, nav: Element): () => void {
  const write = () => {
    root.style.setProperty(HEADER_SPACE_PROPERTY, `${header.getBoundingClientRect().height}px`);
    root.style.setProperty(NAV_SPACE_PROPERTY, `${nav.getBoundingClientRect().height}px`);
  };
  const release = () => {
    root.style.removeProperty(HEADER_SPACE_PROPERTY);
    root.style.removeProperty(NAV_SPACE_PROPERTY);
  };
  // Первое значение — сразу, до первой отрисовки: наблюдатель сообщит о размере только на
  // следующем кадре, а полоса записи уже в этом кадре обязана стоять на настоящей панели.
  write();
  if (typeof ResizeObserver === "undefined") return release;
  const observer = new ResizeObserver(write);
  observer.observe(header);
  observer.observe(nav);
  return () => {
    observer.disconnect();
    release();
  };
}
