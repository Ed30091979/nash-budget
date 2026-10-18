/**
 * Экран вместо бюджета, пока у устройства в семье нет документа семьи.
 *
 * Второе ревью, LOW-5 и MEDIUM-3: устройство в семье без документа показывало онбординг, а
 * онбординг создавал личный бюджет, который следующий приём выдавал за семейный; вступившее
 * устройство под задержкой показывало свой прежний бюджет как бюджет семьи и писало из него семье.
 * Теперь на месте бюджета — этот экран: что случилось и чего устройство ждёт. Бюджет семьи
 * открывается на его месте сам, как только придёт и откроется.
 *
 * Отсюда можно дойти до «Семьи» — выйти из неё, проверить вход и ключ, — и, если на устройстве
 * лежит прежний бюджет, сохранить его копию: бюджет семьи его заменит.
 */
import { useState } from "react";

import type { DocumentHoldNotice } from "./model";

export interface FamilyHoldScreenProps {
  readonly notice: DocumentHoldNotice;
  /** На устройстве лежит бюджет, который был у него до вступления. */
  readonly hasLocalBudget: boolean;
  readonly onBackup: () => Promise<void>;
  readonly onFamily: () => void;
}

export function FamilyHoldScreen({ notice, hasLocalBudget, onBackup, onFamily }: FamilyHoldScreenProps) {
  const [backup, setBackup] = useState<"idle" | "busy" | "done" | "failed">("idle");
  const saveBackup = () => {
    setBackup("busy");
    onBackup().then(
      () => setBackup("done"),
      () => setBackup("failed"),
    );
  };
  return (
    <section className="family-hold-screen" role="alert" aria-labelledby="family-hold-screen-title">
      <h1 id="family-hold-screen-title">{notice.title}</h1>
      <p>{notice.body}</p>
      {hasLocalBudget ? (
        <>
          <p>На устройстве остаётся бюджет, который был на нём до вступления в семью; бюджет семьи его заменит. Сохраните копию, если она нужна.</p>
          <button className="secondary-button" type="button" disabled={backup === "busy"} onClick={saveBackup}>
            Скачать копию прежнего бюджета
          </button>
          {backup === "done" ? <p role="status">Копия прежнего бюджета скачана.</p> : null}
          {backup === "failed" ? <p role="status">Копию сохранить не удалось. Попробуйте ещё раз.</p> : null}
        </>
      ) : null}
      <button className="primary-button" type="button" onClick={onFamily}>Открыть «Семью»</button>
    </section>
  );
}
