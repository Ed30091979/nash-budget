const FOCUSABLE_SELECTOR = [
  "button:not([disabled])",
  "[href]",
  "input:not([disabled])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  '[tabindex]:not([tabindex="-1"])',
].join(",");

interface FocusTarget {
  focus(): void;
}

interface DialogKeyboardTarget extends FocusTarget {
  readonly ownerDocument: { readonly activeElement: unknown };
  contains(value: unknown): boolean;
  querySelectorAll(selector: string): ArrayLike<FocusTarget>;
}

interface DialogKeyboardEvent {
  readonly key: string;
  readonly shiftKey: boolean;
  preventDefault(): void;
  stopPropagation(): void;
}

interface IsolationTarget {
  getAttribute(name: string): string | null;
  hasAttribute(name: string): boolean;
  setAttribute(name: string, value: string): void;
  removeAttribute(name: string): void;
}

interface RestorableFocusTarget extends FocusTarget {
  readonly isConnected?: boolean;
}

export function handleDialogKeyboard(
  event: DialogKeyboardEvent,
  dialog: DialogKeyboardTarget,
  allowEscapeCancel: boolean,
  cancel: () => void,
): void {
  if (event.key === "Escape") {
    if (!allowEscapeCancel) return;
    event.preventDefault();
    event.stopPropagation();
    cancel();
    return;
  }
  if (event.key !== "Tab") return;

  const focusable = Array.from(dialog.querySelectorAll(FOCUSABLE_SELECTOR));
  if (focusable.length === 0) {
    event.preventDefault();
    dialog.focus();
    return;
  }

  const first = focusable[0]!;
  const last = focusable.at(-1)!;
  const active = dialog.ownerDocument.activeElement;
  if (event.shiftKey && (active === first || !dialog.contains(active))) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && (active === last || !dialog.contains(active))) {
    event.preventDefault();
    first.focus();
  }
}

/**
 * The dialog is rendered through a body portal, so the application root can be
 * removed from both sequential keyboard navigation and the accessibility tree.
 */
export function isolateApplicationRoot(root: IsolationTarget): () => void {
  const hadInert = root.hasAttribute("inert");
  const previousAriaHidden = root.getAttribute("aria-hidden");
  root.setAttribute("inert", "");
  root.setAttribute("aria-hidden", "true");

  return () => {
    if (!hadInert) root.removeAttribute("inert");
    if (previousAriaHidden === null) root.removeAttribute("aria-hidden");
    else root.setAttribute("aria-hidden", previousAriaHidden);
  };
}

export function activateDialogEnvironment(
  root: IsolationTarget | null,
  initialFocus: FocusTarget | null,
  returnFocus: RestorableFocusTarget | null,
): () => void {
  const restoreIsolation = root ? isolateApplicationRoot(root) : () => undefined;
  initialFocus?.focus();
  return () => {
    restoreIsolation();
    if (returnFocus?.isConnected !== false) returnFocus?.focus();
  };
}
