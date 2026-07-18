import { type PlanningErrorView } from "./model";

export interface PlanningFormState {
  readonly busy: boolean;
  readonly errorField: string | null;
  readonly errorMessage: string | null;
}

export type PlanningFormAction =
  | { readonly type: "submit" }
  | { readonly type: "success" }
  | { readonly type: "failure"; readonly error: PlanningErrorView }
  | { readonly type: "change" };

export const INITIAL_PLANNING_FORM_STATE: PlanningFormState = {
  busy: false,
  errorField: null,
  errorMessage: null,
};

export function planningFormReducer(
  state: PlanningFormState,
  action: PlanningFormAction,
): PlanningFormState {
  switch (action.type) {
    case "submit":
      return state.busy ? state : { busy: true, errorField: null, errorMessage: null };
    case "success":
      return INITIAL_PLANNING_FORM_STATE;
    case "failure":
      return { busy: false, errorField: action.error.field, errorMessage: action.error.message };
    case "change":
      return state.busy ? state : INITIAL_PLANNING_FORM_STATE;
  }
}

export interface SubmissionGate {
  readonly locked: boolean;
  run<T>(operation: () => Promise<T>): Promise<{ readonly status: "completed"; readonly value: T } | { readonly status: "ignored" }>;
}

/** Locks synchronously, before React has a chance to render, so a same-tick double submit is ignored. */
export function createSubmissionGate(): SubmissionGate {
  let locked = false;
  return {
    get locked() { return locked; },
    async run(operation) {
      if (locked) return { status: "ignored" };
      locked = true;
      try {
        return { status: "completed", value: await operation() };
      } finally {
        locked = false;
      }
    },
  };
}

export function resolveErrorTarget(
  prefix: string,
  error: PlanningErrorView,
  visibleFields: readonly string[],
): { readonly field: string; readonly id: string; readonly message: string } {
  const field = visibleFields.includes(error.field) ? error.field : "form";
  return { field, id: `${prefix}-${field}`, message: error.message };
}

export interface RestoreDraftState {
  readonly amount: string;
  readonly error: string | null;
}

export function changeRestoreDraft(
  current: Readonly<Record<string, RestoreDraftState>>,
  categoryId: string,
  amount: string,
): Readonly<Record<string, RestoreDraftState>> {
  return { ...current, [categoryId]: { amount, error: null } };
}

export function failRestoreDraft(
  current: Readonly<Record<string, RestoreDraftState>>,
  categoryId: string,
  amount: string,
  error: string,
): Readonly<Record<string, RestoreDraftState>> {
  return { ...current, [categoryId]: { amount, error } };
}

export function restoreControlId(categoryId: string): string {
  return `restore-${categoryId}`;
}

export type PlanningEditorAction =
  | { readonly type: "edit"; readonly id: string }
  | { readonly type: "cancel" }
  | { readonly type: "saved" };

export function nextEditingId(
  current: string | null,
  action: PlanningEditorAction,
): string | null {
  if (action.type === "edit") return action.id;
  if (action.type === "cancel" || action.type === "saved") return null;
  return current;
}
