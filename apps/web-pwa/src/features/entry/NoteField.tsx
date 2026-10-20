import { NOTE_MAX_LENGTH } from "@family-budget/domain";
import { plainInputValue } from "../../plain-text";

/**
 * Комментарий операции: одна строка, до `NOTE_MAX_LENGTH`. Текст бывает справа налево и смешанным —
 * это законный текст (SECURITY §7.2), поэтому направление поле берёт из самого текста (`dir="auto"`).
 * Мягкие переносы со вставленного поле снимает само (`plain-text.ts`): домен их не пустит.
 */
export function NoteField({ value, onChange }: { readonly value: string; readonly onChange: (note: string) => void }) {
  return (
    <div className="field">
      {/* Подпись — для диктора и голосового ввода; глазу то же слово говорит образец в пустом поле (макет 07). */}
      <label htmlFor="entry-note" className="visually-hidden">Комментарий</label>
      <input id="entry-note" dir="auto" autoComplete="off" maxLength={NOTE_MAX_LENGTH} placeholder="Комментарий" value={value} onChange={(event) => onChange(plainInputValue(event.currentTarget))} />
    </div>
  );
}
