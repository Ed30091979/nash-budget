import { useEffect, useRef, useState, type ComponentType, type KeyboardEvent, type PointerEvent, type SVGProps } from "react";
import { type BudgetState } from "@family-budget/domain";
import { Hyphenated } from "../components/Hyphenated";
import { PrivateIllustration } from "../components/illustrations/PrivateIllustration";
import { ReachIllustration } from "../components/illustrations/ReachIllustration";
import { TapIllustration } from "../components/illustrations/TapIllustration";
import { EMPTY_FIRST_RUN, firstRunStore, type FirstRunStore } from "../features/onboarding-questions/memory";
import { beginFirstRun } from "../features/onboarding-questions/questions-model";
import { localToday } from "../reach";
import {
  buildOnboardingBudgetState,
  createAsyncOperationLock,
  currencyForLocale,
  deviceLanguage,
  onboardingFailureMessage,
} from "./model";

export interface IntroSlide {
  readonly key: string;
  readonly title: string;
  readonly text: string;
  readonly Illustration: ComponentType<SVGProps<SVGSVGElement>>;
}

/**
 * Три слайда первого запуска (дизайн v5, 01 → 02 → 02b): каждый — про настоящую функцию, а не про
 * «гибкость и надёжность». Неразрывный пробел держит тире и короткие слова со своей строкой.
 */
export const INTRO_SLIDES: readonly IntroSlide[] = [
  { key: "tap", title: "Записать трату\u00a0— два шага", text: "Коснитесь категории и наберите сумму. Без форм и лишних полей.", Illustration: TapIllustration },
  { key: "reach", title: "Видно, хватит ли до\u00a0зарплаты", text: "Приложение считает, сколько можно тратить каждый день до следующей выплаты.", Illustration: ReachIllustration },
  { key: "private", title: "Начните без регистрации", text: "Бесплатно. Без подписок и рекламы. Данные только на\u00a0этом телефоне.", Illustration: PrivateIllustration },
];

/** Обещание бесплатности — одной строкой и один раз, на последнем слайде (DIRECTION, п. 10). */
export const FREE_PROMISE = INTRO_SLIDES[2]!.text;

/** Сдвиг пальца по горизонтали, после которого слайд перелистывается. */
const SWIPE_DISTANCE = 56;

interface OnboardingProps {
  readonly onComplete: (state: BudgetState) => Promise<void>;
  readonly onDemo: () => Promise<void>;
  /** Память первого запуска этого устройства (по умолчанию — общая на вкладку). */
  readonly firstRun?: FirstRunStore;
  /** Сегодня по календарю семьи; подменяется проверками. */
  readonly today?: () => string;
  /** Тег языка устройства для валюты набора; подменяется проверками. */
  readonly language?: () => string | null;
  /** С какого слайда начать — для проверок разметки второго и третьего. */
  readonly initialSlide?: number;
}

/** Марка на слайдах: полоса с насечкой — знак приложения. Рядом стоит название, поэтому картинка декоративна. */
function BrandMark() {
  return (
    <svg className="intro-brand-mark" viewBox="0 0 28 28" width="28" height="28" aria-hidden="true" focusable="false">
      <rect width="28" height="28" rx="8" fill="#EFE8DC" />
      <rect x="5" y="12" width="18" height="4" rx="2" fill="#171410" />
      <rect x="17" y="10" width="2.5" height="8" fill="#EFE8DC" />
      <rect x="17.6" y="8" width="1.6" height="12" rx=".8" fill="#B8471A" />
    </svg>
  );
}

/**
 * Первый запуск: три слайда и сразу «Обзор» (DIRECTION §e).
 *
 * Слайды — настоящая последовательность: один на экране, «Шаг N из 3» словами, фокус на заголовке
 * каждого. «Дальше» листает вперёд, стрелки клавиатуры и взмах пальцем — в обе стороны.
 * «Пропустить» на первых двух и Esc ведут туда же, куда «Начать»: молча создаётся набор
 * (`buildOnboardingBudgetState`), и вопросы задаются уже поверх «Обзора». «Посмотреть на примере» —
 * демо, тихой кнопкой под главной. Ни одного поля и ни одного вопроса «для кого план».
 */
export function Onboarding({ onComplete, onDemo, firstRun = firstRunStore(), today = () => localToday(new Date()), language = deviceLanguage, initialSlide = 0 }: OnboardingProps) {
  const [index, setIndex] = useState(() => Math.min(Math.max(0, Math.trunc(initialSlide)), INTRO_SLIDES.length - 1));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const titleRef = useRef<HTMLHeadingElement>(null);
  const operationLock = useRef(createAsyncOperationLock());
  const swipe = useRef<{ readonly x: number; readonly y: number } | null>(null);
  const slide = INTRO_SLIDES[index]!;
  const last = index === INTRO_SLIDES.length - 1;

  useEffect(() => {
    titleRef.current?.focus({ preventScroll: true });
  }, [index]);

  const go = (next: number) => {
    if (busy || next < 0 || next >= INTRO_SLIDES.length || next === index) return;
    setError(null);
    setIndex(next);
  };

  const start = async () => {
    if (operationLock.current.locked) return;
    setBusy(true);
    setError(null);
    try {
      await operationLock.current.run(async () => {
        const day = today();
        const state = buildOnboardingBudgetState({ today: day, currency: currencyForLocale(language()) });
        // Память первого запуска — до публикации бюджета: «Обзор» спрашивает её в первом же кадре.
        // Сбой памяти набору не мешает — вопросы тогда просто не зададутся.
        await firstRun.replace(beginFirstRun(day)).catch(() => undefined);
        await onComplete(state);
      });
    } catch {
      setError(onboardingFailureMessage("save"));
    } finally {
      setBusy(false);
    }
  };

  const demo = async () => {
    if (operationLock.current.locked) return;
    setBusy(true);
    setError(null);
    try {
      await operationLock.current.run(async () => {
        // Пример — не первый запуск: вопросов и подсказки на первую трату у него нет.
        await firstRun.replace(EMPTY_FIRST_RUN).catch(() => undefined);
        await onDemo();
      });
    } catch {
      setError(onboardingFailureMessage("demo"));
    } finally {
      setBusy(false);
    }
  };

  const onKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    if (event.key === "Escape" && !last) {
      event.preventDefault();
      void start();
    } else if (event.key === "ArrowRight") {
      event.preventDefault();
      go(index + 1);
    } else if (event.key === "ArrowLeft") {
      event.preventDefault();
      go(index - 1);
    }
  };
  const onPointerDown = (event: PointerEvent<HTMLElement>) => {
    swipe.current = event.pointerType === "mouse" ? null : { x: event.clientX, y: event.clientY };
  };
  const onPointerUp = (event: PointerEvent<HTMLElement>) => {
    const from = swipe.current;
    swipe.current = null;
    if (from === null) return;
    const dx = event.clientX - from.x;
    if (Math.abs(dx) < SWIPE_DISTANCE || Math.abs(event.clientY - from.y) > Math.abs(dx)) return;
    go(dx < 0 ? index + 1 : index - 1);
  };

  const titleId = `intro-title-${slide.key}`;
  return (
    <main className="intro" aria-labelledby={titleId} aria-busy={busy} onKeyDown={onKeyDown}>
      <header className="intro-top">
        <span className="intro-brand"><BrandMark />Наш бюджет</span>
        {last ? null : <button className="intro-skip" type="button" aria-disabled={busy || undefined} onClick={() => void start()}>Пропустить</button>}
      </header>
      <section className="intro-slide" key={slide.key} aria-roledescription="слайд" aria-label={`${index + 1} из ${INTRO_SLIDES.length}`} onPointerDown={onPointerDown} onPointerUp={onPointerUp}>
        <div className="intro-art"><slide.Illustration /></div>
        <p className="intro-dots" role="img" aria-label={`Шаг ${index + 1} из ${INTRO_SLIDES.length}`}>
          {INTRO_SLIDES.map((item, dot) => <span key={item.key} className={dot === index ? "current" : undefined} />)}
        </p>
        <h1 id={titleId} ref={titleRef} tabIndex={-1}><Hyphenated text={slide.title} /></h1>
        <p className="intro-text"><Hyphenated text={slide.text} /></p>
        <div className="intro-actions">
          {last ? <>
            <button className="primary-button wide" type="button" aria-disabled={busy || undefined} aria-busy={busy} onClick={() => void start()}>Начать</button>
            <button className="quiet-button wide" type="button" aria-disabled={busy || undefined} onClick={() => void demo()}>Посмотреть на примере</button>
          </> : (
            <button className="primary-button wide" type="button" aria-disabled={busy || undefined} onClick={() => go(index + 1)}>Дальше</button>
          )}
        </div>
        {error === null ? null : <p className="intro-error" role="alert">{error} Попробуйте ещё раз.</p>}
      </section>
    </main>
  );
}
