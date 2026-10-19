import { NOTE_MAX_LENGTH } from "@family-budget/domain";

/**
 * Комментарий операции: одна строка, до `NOTE_MAX_LENGTH`. Текст бывает справа налево и смешанным —
 * это законный текст (SECURITY §7.2), поэтому направление поле берёт из самого текста (`dir="auto"`).
 */
export function NoteField({ value, onChange }: { readonly value: string; readonly onChange: (note: string) => void }) {
  return (
    <div className="field">
      <label htmlFor="entry-note">Комментарий</label>
      <input id="entry-note" dir="auto" autoComplete="off" maxLength={NOTE_MAX_LENGTH} placeholder="Например, Пятёрочка у дома" value={value} onChange={(event) => onChange(event.target.value)} />
    </div>
  );
}
