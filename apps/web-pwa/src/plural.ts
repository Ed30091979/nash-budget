/**
 * «1 конверт», «2 конверта», «5 конвертов»: число в русской строке склоняет существительное.
 * Одиннадцать–четырнадцать — исключение из хвоста, как у любого счётного слова.
 *
 * Одна функция на всё приложение: до этого её копии жили в `App.tsx` и на экране импорта, и
 * третья копия для семейной новости была бы третьим местом, где склонение можно сломать.
 */
export function plural(count: number, forms: readonly [string, string, string]): string {
  const tail = count % 100;
  const last = count % 10;
  if (tail >= 11 && tail <= 14) return `${count} ${forms[2]}`;
  if (last === 1) return `${count} ${forms[0]}`;
  if (last >= 2 && last <= 4) return `${count} ${forms[1]}`;
  return `${count} ${forms[2]}`;
}
