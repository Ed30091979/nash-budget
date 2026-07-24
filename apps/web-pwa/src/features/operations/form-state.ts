import { type OperationsErrorView } from "./model";

export interface OperationsFormState {
  readonly busy: boolean;
  readonly errorField: string | null;
  readonly errorMessage: string | null;
}

export type OperationsFormAction =
  | { readonly type: "submit" }
  | { readonly type: "success" }
  | { readonly type: "failure"; readonly error: OperationsErrorView }
  | { readonly type: "change" };

export const INITIAL_OPERATIONS_FORM_STATE: OperationsFormState = {
  busy: false,
  errorField: null,
  errorMessage: null,
};

export function operationsFormReducer(
  state: OperationsFormState,
  action: OperationsFormAction,
): OperationsFormState {
  switch (action.type) {
    case "submit":
      return state.busy ? state : { busy: true, errorField: null, errorMessage: null };
    case "success":
      return INITIAL_OPERATIONS_FORM_STATE;
    case "failure":
      return { busy: false, errorField: action.error.field, errorMessage: action.error.message };
    case "change":
      return state.busy ? state : INITIAL_OPERATIONS_FORM_STATE;
  }
}

export interface OperationsSubmissionGate {
  readonly locked: boolean;
  run<T>(operation: () => Promise<T>): Promise<
    | { readonly status: "completed"; readonly value: T }
    | { readonly status: "ignored" }
  >;
}

/** Locks in the event handler before a same-tick second submit can enqueue a duplicate. */
export function createOperationsSubmissionGate(): OperationsSubmissionGate {
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
