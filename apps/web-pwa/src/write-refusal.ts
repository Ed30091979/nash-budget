/**
 * Отказ записи бюджета, который человек должен прочитать, — и его слова.
 *
 * Пока документ задержан (`SyncStatusReport.hold`) или ещё не стал документом семьи, устройство
 * только читает: правка строится из того, что показано на экране, а это не состояние журнала, и
 * обновление ушло бы семье целой сущностью под меткой, которая перебивает чужую правку. Поэтому
 * запись отклоняется, ничего не уходит в очередь, а форма показывает эти слова вместо общего
 * «Не удалось сохранить».
 */
export const WRITE_REFUSAL_TEXT = {
  held: "Записи временно недоступны: данные семьи не открываются этой версией приложения. Обновите приложение — записи откроются сами.",
  pending: "Записи временно недоступны: бюджет семьи ещё не пришёл на это устройство. Записи откроются сами, как только он придёт.",
  refused: "Запись не сохранена: вместе с изменениями семьи она дала бы бюджет, который эта версия приложения не открывает. Ничего не отправлено семье.",
} as const;

export type WriteRefusalReason = keyof typeof WRITE_REFUSAL_TEXT;

/**
 * `userMessage` — слова для человека, как у `DataManagementError`: экраны показывают его, а не
 * `message` произвольной ошибки, которая могла бы принести на экран чужой текст.
 */
export class BudgetWriteRefusal extends Error {
  readonly reason: WriteRefusalReason;
  readonly userMessage: string;

  constructor(reason: WriteRefusalReason) {
    super(WRITE_REFUSAL_TEXT[reason]);
    this.name = "BudgetWriteRefusal";
    this.reason = reason;
    this.userMessage = WRITE_REFUSAL_TEXT[reason];
  }
}
