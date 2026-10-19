import { Icon } from "../../components/Icon";
import { Money } from "../../components/Money";
import type { FeedRowView } from "./feed-model";

/**
 * Строка операции (дизайн 5.0, макет 08): подложка 40 с глифом категории её тоном, название,
 * подпись «счёт · комментарий · #метка» и сумма со знаком в валюте счёта; у счёта в другой валюте
 * под ней — снимок в базовой («≈ 3 600 ₽», DESIGN §7). Вся строка — одна цель нажатия: она открывает
 * операцию в листе ввода, где её меняют и удаляют. Ожидаемая операция — пунктирной подложкой и
 * словом в доступном имени: цвет не единственный носитель. Чужой текст — в `<bdi>`.
 */
export function FeedRow({ view, onOpen, busy = false }: { readonly view: FeedRowView; readonly onOpen: () => void; readonly busy?: boolean }) {
  const income = view.sign === "+" && !view.pending;
  return (
    <li className={view.pending ? "feed-row pending" : "feed-row"}>
      <button className="feed-open" type="button" disabled={busy} aria-label={view.label} onClick={onOpen}>
        <span className={`icon-plate feed-plate tone-${view.tone}`}><Icon name={view.icon} size={20} /></span>
        <span className="feed-copy">
          <strong className="feed-title"><bdi dir="auto">{view.title}</bdi></strong>
          <small className="feed-meta">
            {view.meta.map((part, index) => (
              <span key={index} className={part.tag ? "feed-tag" : undefined}>
                {index > 0 ? " · " : null}
                {part.own ? <bdi dir="auto">{part.text}</bdi> : part.text}
              </span>
            ))}
          </small>
        </span>
        <span className={income ? "feed-amount positive" : "feed-amount"}>
          <Money value={view.amountMinor} currency={view.currency} {...(view.sign === undefined ? {} : { sign: view.sign })} />
          {view.baseMinor === null ? null : <small className="feed-base">≈ <Money value={view.baseMinor} /></small>}
        </span>
      </button>
    </li>
  );
}
