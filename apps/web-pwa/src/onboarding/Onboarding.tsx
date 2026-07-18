import { type FormEvent, useEffect, useRef, useState } from "react";
import { type BudgetState } from "@family-budget/domain";
import {
  buildOnboardingBudgetState,
  createAsyncOperationLock,
  createInitialOnboardingDraft,
  HOUSEHOLD_COMPOSITION_LABELS,
  MAX_ONBOARDING_PERIOD_START,
  type EverydayCategoryDraft,
  type HouseholdComposition,
  moveOnboardingStep,
  onboardingFailureMessage,
  type OnboardingDraft,
  type OnboardingStep,
  validateOnboardingStep,
} from "./model";

interface OnboardingProps {
  readonly onComplete: (state: BudgetState) => Promise<void>;
  readonly onDemo: () => Promise<void>;
}

const stepTitles: Record<OnboardingStep, string> = {
  1: "Назовите план",
  2: "Выберите период",
  3: "Доход и обязательное",
  4: "Повседневные лимиты",
};

function ErrorText({ id, message }: { id: string; message?: string }) {
  return message ? <span className="field-error" id={`${id}-error`}>{message}</span> : null;
}

function fieldA11y(id: string, error?: string) {
  return {
    "aria-invalid": error ? true as const : undefined,
    "aria-describedby": error ? `${id}-error` : undefined,
  };
}

function firstErrorId(errors: Readonly<Record<string, string>>): string | undefined {
  return Object.keys(errors)[0];
}

export function Onboarding({ onComplete, onDemo }: OnboardingProps) {
  const [draft, setDraft] = useState<OnboardingDraft>(() => createInitialOnboardingDraft());
  const [step, setStep] = useState<OnboardingStep>(1);
  const [errors, setErrors] = useState<Readonly<Record<string, string>>>({});
  const [busy, setBusy] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const titleRef = useRef<HTMLHeadingElement>(null);
  const operationLock = useRef(createAsyncOperationLock());

  useEffect(() => {
    titleRef.current?.focus();
  }, [step]);

  const patchDraft = <K extends keyof OnboardingDraft>(key: K, value: OnboardingDraft[K]) => {
    setDraft((current) => ({ ...current, [key]: value }));
    setErrors({});
    setSaveError(null);
  };

  const patchCategory = (index: number, patch: Partial<EverydayCategoryDraft>) => {
    patchDraft("categories", draft.categories.map((category, categoryIndex) => (
      categoryIndex === index ? { ...category, ...patch } : category
    )));
  };

  const focusError = (id: string | undefined) => {
    if (!id) return;
    window.setTimeout(() => document.getElementById(id)?.focus(), 0);
  };

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const validation = validateOnboardingStep(draft, step);
    setErrors(validation.errors);
    if (!validation.valid) {
      focusError(firstErrorId(validation.errors));
      return;
    }
    if (step < 4) {
      setStep(moveOnboardingStep(step, "forward"));
      setErrors({});
      return;
    }

    if (operationLock.current.locked) return;
    setBusy(true);
    setSaveError(null);
    try {
      await operationLock.current.run(async () => {
        await onComplete(buildOnboardingBudgetState(draft));
      });
    } catch {
      setSaveError(onboardingFailureMessage("save"));
    } finally {
      setBusy(false);
    }
  };

  const startDemo = async () => {
    if (operationLock.current.locked) return;
    setBusy(true);
    setSaveError(null);
    try {
      await operationLock.current.run(onDemo);
    } catch {
      setSaveError(onboardingFailureMessage("demo"));
    } finally {
      setBusy(false);
    }
  };

  return (
    <main className="onboarding-shell">
      <section className="onboarding-card" aria-labelledby="onboarding-title">
        <header className="onboarding-heading">
          <span className="brand-mark" aria-hidden="true">₽</span>
          <div>
            <p className="onboarding-kicker">Шаг {step} из 4</p>
            <h1 id="onboarding-title" ref={titleRef} tabIndex={-1}>{stepTitles[step]}</h1>
          </div>
        </header>
        <div className="step-progress" aria-label={`Выполнено ${step} из 4 шагов`}>
          {[1, 2, 3, 4].map((value) => <span className={value <= step ? "active" : ""} key={value} />)}
        </div>

        <form className="onboarding-form" aria-busy={busy} onSubmit={(event) => void submit(event)} noValidate>
          <fieldset className="onboarding-fields" disabled={busy}>
            <legend className="sr-only">Настройка семейного бюджета</legend>
          {step === 1 ? <>
            <p className="onboarding-help">Только локальные подписи: имена и личные данные не нужны.</p>
            <fieldset className="composition-options" id="composition" tabIndex={-1} {...fieldA11y("composition", errors.composition)}>
              <legend>Для кого этот план</legend>
              {(Object.entries(HOUSEHOLD_COMPOSITION_LABELS) as [HouseholdComposition, string][]).map(([value, label]) => <label key={value}><input type="radio" name="composition" value={value} checked={draft.composition === value} onChange={() => patchDraft("composition", value)} />{label}</label>)}
              <ErrorText id="composition" message={errors.composition} />
            </fieldset>
            <div className="field">
              <label htmlFor="householdLabel">Название плана</label>
              <input id="householdLabel" autoComplete="off" maxLength={80} value={draft.householdLabel} onChange={(event) => patchDraft("householdLabel", event.target.value)} {...fieldA11y("householdLabel", errors.householdLabel)} />
              <ErrorText id="householdLabel" message={errors.householdLabel} />
            </div>
            <div className="field">
              <label htmlFor="accountLabel">Как назвать основной счёт</label>
              <input id="accountLabel" autoComplete="off" maxLength={80} value={draft.accountLabel} onChange={(event) => patchDraft("accountLabel", event.target.value)} {...fieldA11y("accountLabel", errors.accountLabel)} />
              <ErrorText id="accountLabel" message={errors.accountLabel} />
            </div>
          </> : null}

          {step === 2 ? <>
            <p className="onboarding-help">Первый план охватит один месяц. Горизонт на 12–24 месяца появится сразу после настройки.</p>
            <div className="field">
              <label htmlFor="currency">Валюта</label>
              <input id="currency" value="Российский рубль (RUB)" readOnly aria-readonly="true" {...fieldA11y("currency", errors.currency)} />
              <ErrorText id="currency" message={errors.currency} />
            </div>
            <div className="field">
              <label htmlFor="periodStart">Начало бюджетного периода</label>
              <input id="periodStart" type="date" max={MAX_ONBOARDING_PERIOD_START} value={draft.periodStart} onChange={(event) => patchDraft("periodStart", event.target.value)} {...fieldA11y("periodStart", errors.periodStart)} />
              <small>Выберите первое число месяца.</small>
              <ErrorText id="periodStart" message={errors.periodStart} />
            </div>
          </> : null}

          {step === 3 ? <>
            <p className="onboarding-help">Доход — это план, не запись о фактическом поступлении. Обязательный платёж будет повторяться ежемесячно.</p>
            <div className="amount-field">
              <label htmlFor="monthlyIncome">Доход в месяц, ₽</label>
              <input id="monthlyIncome" inputMode="decimal" maxLength={24} placeholder="180 000" value={draft.monthlyIncome} onChange={(event) => patchDraft("monthlyIncome", event.target.value)} {...fieldA11y("monthlyIncome", errors.monthlyIncome)} />
              <ErrorText id="monthlyIncome" message={errors.monthlyIncome} />
            </div>
            <div className="field">
              <label htmlFor="mandatoryName">Обязательный ежемесячный платёж</label>
              <input id="mandatoryName" maxLength={80} value={draft.mandatoryName} onChange={(event) => patchDraft("mandatoryName", event.target.value)} {...fieldA11y("mandatoryName", errors.mandatoryName)} />
              <ErrorText id="mandatoryName" message={errors.mandatoryName} />
            </div>
            <div className="field">
              <label htmlFor="mandatoryAmount">Сумма платежа, ₽</label>
              <input id="mandatoryAmount" inputMode="decimal" maxLength={24} placeholder="53 000" value={draft.mandatoryAmount} onChange={(event) => patchDraft("mandatoryAmount", event.target.value)} {...fieldA11y("mandatoryAmount", errors.mandatoryAmount)} />
              <ErrorText id="mandatoryAmount" message={errors.mandatoryAmount} />
            </div>
          </> : null}

          {step === 4 ? <>
            <p className="onboarding-help">Задайте 3–5 лимитов на мелкие покупки. Их можно будет изменить позже.</p>
            <div id="categories" tabIndex={-1}><ErrorText id="categories" message={errors.categories} /></div>
            <div className="category-edit-list">
              {draft.categories.map((category, index) => {
                const nameId = `category-${index}-name`;
                const limitId = `category-${index}-limit`;
                return <fieldset className="category-edit-row" key={category.key}>
                  <legend>Категория {index + 1}</legend>
                  <div className="field">
                    <label htmlFor={nameId}>Название</label>
                    <input id={nameId} maxLength={80} value={category.name} onChange={(event) => patchCategory(index, { name: event.target.value })} {...fieldA11y(nameId, errors[nameId])} />
                    <ErrorText id={nameId} message={errors[nameId]} />
                  </div>
                  <div className="field">
                    <label htmlFor={limitId}>Лимит, ₽</label>
                    <input id={limitId} inputMode="decimal" maxLength={24} placeholder="0" value={category.limit} onChange={(event) => patchCategory(index, { limit: event.target.value })} {...fieldA11y(limitId, errors[limitId])} />
                    <ErrorText id={limitId} message={errors[limitId]} />
                  </div>
                  {draft.categories.length > 3 ? <button className="text-button remove-category" type="button" onClick={() => patchDraft("categories", draft.categories.filter((_, categoryIndex) => categoryIndex !== index))}>Удалить категорию</button> : null}
                </fieldset>;
              })}
            </div>
            {draft.categories.length < 5 ? <button className="secondary-button wide" type="button" onClick={() => patchDraft("categories", [...draft.categories, { key: crypto.randomUUID(), name: "", limit: "" }])}>+ Добавить категорию</button> : null}
          </> : null}

          {saveError ? <p className="onboarding-save-error" role="alert">{saveError} Данные не были опубликованы.</p> : null}
          <div className="onboarding-actions">
            {step > 1 ? <button className="secondary-button" type="button" onClick={() => { setStep(moveOnboardingStep(step, "back")); setErrors({}); setSaveError(null); }}>Назад</button> : <span />}
            <button className="primary-button" type="submit">{busy ? "Сохраняем…" : step === 4 ? "Создать бюджет" : "Далее"}</button>
          </div>
          </fieldset>
        </form>

        {step === 1 ? <aside className="demo-option">
          <p><strong>Хотите сначала посмотреть?</strong><br />Демо создаст в этом браузере вымышленный пример. Это не ваши данные.</p>
          <button className="text-button" type="button" disabled={busy} onClick={() => void startDemo()}>Загрузить демонстрационный бюджет</button>
        </aside> : null}
      </section>
    </main>
  );
}
