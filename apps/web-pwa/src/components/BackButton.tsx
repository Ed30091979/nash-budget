import { Icon } from "./Icon";

/**
 * Возврат на предыдущий экран. Один приём на всё приложение: стрелка — векторный глиф из
 * спрайта и только украшение, имя кнопке даёт её текст (§6 и §9 документа дизайна).
 */
export function BackButton({ label, onClick }: { readonly label: string; readonly onClick: () => void }) {
  return (
    <button className="secondary-button back-button" type="button" onClick={onClick}>
      <Icon name="arrow-left" size={20} />{label}
    </button>
  );
}
