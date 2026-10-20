import type { CurrencyCode } from "@family-budget/domain";
import { Money } from "../../components/Money";
import type { ReportSegment } from "./report-model";

/** Геометрия кольца: радиус по середине штриха, толщина и разрыв между секторами. */
export const DONUT_SIZE = 140;
const RADIUS = 54;
const STROKE = 18;
const GAP = 2;
const CIRCUMFERENCE = 2 * Math.PI * RADIUS;

export interface DonutArc {
  readonly key: string;
  /** Длина дуги и сдвиг её начала по окружности — в единицах `viewBox`. */
  readonly length: number;
  readonly offset: number;
  /** Класс цвета: чернила тона категории или `--line` у «Остального». */
  readonly toneClass: string;
}

/** Класс цвета серии: сектор окрашен чернилами тона своей категории (DESIGN §3). */
export function chartToneClass(segment: Pick<ReportSegment, "tone" | "rest">): string {
  return segment.rest || segment.tone === null ? "chart-rest" : `chart-tone-${segment.tone}`;
}

/**
 * Дуги кольца: доля сектора — доля окружности, между соседними секторами — разрыв 2 px. Единственный
 * сектор — полный круг без разрыва; крошечный не пропадает совсем.
 */
export function donutArcs(segments: readonly ReportSegment[]): readonly DonutArc[] {
  let start = 0;
  return segments.map((segment) => {
    const span = segment.share * CIRCUMFERENCE;
    const length = segments.length === 1 ? CIRCUMFERENCE : Math.max(0.75, span - GAP);
    const arc = { key: segment.key, length: Number(length.toFixed(2)), offset: Number((-start).toFixed(2)), toneClass: chartToneClass(segment) };
    start += span;
    return arc;
  });
}

/**
 * Кольцо долей (DESIGN §6, «График горизонта»: исключение для доли целого). Никогда не стоит одно:
 * рядом легенда-кнопки с суммой и долей, ниже — таблица всех категорий. Для слуха кольцо — одна
 * картинка (`role="img"`) с выводом словами; цвета — классами (CSP `style-src 'self'`), геометрия —
 * атрибутами SVG.
 */
export function Donut({ segments, totalMinor, currency, label }: {
  readonly segments: readonly ReportSegment[];
  readonly totalMinor: number;
  readonly currency: CurrencyCode;
  /** Вывод словами: «Расходы за октябрь, 71 000 ₽: Жильё 63 %, Продукты 31 %, Транспорт 6 %». */
  readonly label: string;
}) {
  const center = DONUT_SIZE / 2;
  return (
    <div className="donut" role="img" aria-label={label}>
      <svg className="donut-svg" width={DONUT_SIZE} height={DONUT_SIZE} viewBox={`0 0 ${DONUT_SIZE} ${DONUT_SIZE}`} aria-hidden="true" focusable="false">
        {donutArcs(segments).map((arc) => (
          <circle
            key={arc.key}
            className={`donut-seg ${arc.toneClass}`}
            cx={center}
            cy={center}
            r={RADIUS}
            fill="none"
            strokeWidth={STROKE}
            strokeDasharray={`${arc.length} ${CIRCUMFERENCE.toFixed(2)}`}
            strokeDashoffset={arc.offset}
            transform={`rotate(-90 ${center} ${center})`}
          />
        ))}
      </svg>
      <span className="donut-center" aria-hidden="true">
        <b><Money value={totalMinor} currency={currency} /></b>
        <span>всего</span>
      </span>
    </div>
  );
}
