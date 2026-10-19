import { Icon, type IconName } from "./Icon";

/** Заголовок секции карточки: одна ступень заголовка и строка пояснения под ним. */
export function SectionTitle({ id, title, note, icon }: { id?: string; title: string; note: string; icon?: IconName }) {
  return <div className="section-title"><div><h2 id={id}>{icon ? <Icon name={icon} size={20} /> : null}{title}</h2><p>{note}</p></div></div>;
}
