import { Icon } from "../Icon";

/** Плитка «+»: пунктир `--line` (3.10:1 на холсте), доступное имя называет, что добавится. */
export function AddTile({ label, onClick }: { readonly label: string; readonly onClick: () => void }) {
  return (
    <button className="add-tile" type="button" aria-label={label} onClick={onClick}>
      <Icon name="plus" size={24} />
    </button>
  );
}
