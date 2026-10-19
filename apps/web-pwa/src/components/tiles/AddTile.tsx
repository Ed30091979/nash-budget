import { Icon } from "../Icon";

/**
 * Плитка «+»: пунктирный квадрат `--line` (3.30:1 на холсте) и короткая подпись под ним — «Своя»,
 * «Доход». Доступное имя называет, что добавится, и содержит видимое слово (WCAG 2.5.3).
 */
export function AddTile({ label, caption, onClick }: { readonly label: string; readonly caption: string; readonly onClick: () => void }) {
  return (
    <button className="add-tile" type="button" aria-label={label} onClick={onClick}>
      <span className="tile-square add" aria-hidden="true"><Icon name="plus" size={24} /></span>
      <span className="tile-name" aria-hidden="true">{caption}</span>
    </button>
  );
}
