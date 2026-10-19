import { Icon } from "./Icon";

/**
 * Отказ или сбой записи, который экран, начавший её, уже не покажет (план волны 2, §2.3, п. 3).
 *
 * Уход с экрана в полёте записи вопроса не задаёт (черновик уже «записывается»), и если запись
 * потом не удалась — задержка семьи, конфликт с другой вкладкой, — форма, которая показала бы
 * ошибку, уже снята. Тогда об этом говорит оболочка: на том экране, где человек теперь стоит,
 * тревогой, которая не гаснет сама, пока её не прочли.
 */
export function WriteRefusalNotice({ message, onDismiss }: { readonly message: string; readonly onDismiss: () => void }) {
  return (
    <section className="key-alarm write-refusal-notice" role="alert" aria-labelledby="write-refusal-title">
      <span className="key-alarm-mark"><Icon name="triangle-alert" size={24} /></span>
      <div>
        <h2 id="write-refusal-title">Не записано</h2>
        <p>{message}</p>
        <button className="primary-button" type="button" onClick={onDismiss}>Понятно</button>
      </div>
    </section>
  );
}
