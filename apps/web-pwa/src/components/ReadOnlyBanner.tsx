import { Icon } from "./Icon";

/**
 * Плашка «только чтение» (план волны 2, §2.3, п. 1): пока документ семьи задержан, устройство
 * только читает, и человек узнаёт об этом до того, как запись откажет, — на каждом экране, кроме
 * «Семьи», где задержка названа сама. Слова — те же, что у отказа записи (`WRITE_REFUSAL_TEXT`):
 * «обновите приложение» для расхождения версий, «дождитесь бюджета» — для журнала без бюджета.
 * Закрыть её нельзя: это состояние, а не сообщение.
 */
export function ReadOnlyBanner({ title, body, onDetails }: { readonly title: string; readonly body: string; readonly onDetails: () => void }) {
  return (
    <section className="key-alarm family-hold-banner" role="alert" aria-labelledby="app-hold-title">
      <span className="key-alarm-mark"><Icon name="triangle-alert" size={24} /></span>
      <div>
        <h2 id="app-hold-title">{title}</h2>
        <p>{body}</p>
        <button className="primary-button" type="button" onClick={onDetails}>Подробнее</button>
      </div>
    </section>
  );
}
