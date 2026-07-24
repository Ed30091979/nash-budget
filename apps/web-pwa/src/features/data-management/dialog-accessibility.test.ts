import { describe, expect, it, vi } from "vitest";
import {
  activateDialogEnvironment,
  handleDialogKeyboard,
  isolateApplicationRoot,
} from "./dialog-accessibility";

function keyboardEvent(key: string, shiftKey = false) {
  return {
    key,
    shiftKey,
    preventDefault: vi.fn(),
    stopPropagation: vi.fn(),
  };
}

function dialogHarness(active: "first" | "last" | "outside" = "first") {
  const document = { activeElement: null as unknown };
  const first = { focus: vi.fn(() => { document.activeElement = first; }) };
  const last = { focus: vi.fn(() => { document.activeElement = last; }) };
  const outside = { focus: vi.fn(() => { document.activeElement = outside; }) };
  document.activeElement = active === "first" ? first : active === "last" ? last : outside;
  const dialog = {
    ownerDocument: document,
    focus: vi.fn(() => { document.activeElement = dialog; }),
    contains: (value: unknown) => value === first || value === last || value === dialog,
    querySelectorAll: vi.fn(() => [first, last]),
  };
  return { dialog, first, last, outside, document };
}

describe("clear confirmation keyboard behavior", () => {
  it("wraps Tab and Shift+Tab inside the dialog", () => {
    const forward = dialogHarness("last");
    const tab = keyboardEvent("Tab");
    handleDialogKeyboard(tab, forward.dialog, true, vi.fn());
    expect(tab.preventDefault).toHaveBeenCalledTimes(1);
    expect(forward.first.focus).toHaveBeenCalledTimes(1);

    const backward = dialogHarness("first");
    const shiftTab = keyboardEvent("Tab", true);
    handleDialogKeyboard(shiftTab, backward.dialog, true, vi.fn());
    expect(shiftTab.preventDefault).toHaveBeenCalledTimes(1);
    expect(backward.last.focus).toHaveBeenCalledTimes(1);
  });

  it("recovers focus into the dialog if it was moved outside", () => {
    const { dialog, first } = dialogHarness("outside");
    const event = keyboardEvent("Tab");
    handleDialogKeyboard(event, dialog, true, vi.fn());
    expect(event.preventDefault).toHaveBeenCalledTimes(1);
    expect(first.focus).toHaveBeenCalledTimes(1);
  });

  it("cancels with Escape only while the recovery state is idle", () => {
    const { dialog } = dialogHarness();
    const cancel = vi.fn();
    const idleEscape = keyboardEvent("Escape");
    handleDialogKeyboard(idleEscape, dialog, true, cancel);
    expect(idleEscape.preventDefault).toHaveBeenCalledTimes(1);
    expect(idleEscape.stopPropagation).toHaveBeenCalledTimes(1);
    expect(cancel).toHaveBeenCalledTimes(1);

    const busyEscape = keyboardEvent("Escape");
    handleDialogKeyboard(busyEscape, dialog, false, cancel);
    expect(busyEscape.preventDefault).not.toHaveBeenCalled();
    expect(cancel).toHaveBeenCalledTimes(1);
  });
});

describe("application isolation while the dialog is open", () => {
  function target(initial: Record<string, string> = {}) {
    const attributes = new Map(Object.entries(initial));
    return {
      attributes,
      getAttribute: (name: string) => attributes.get(name) ?? null,
      hasAttribute: (name: string) => attributes.has(name),
      setAttribute: (name: string, value: string) => { attributes.set(name, value); },
      removeAttribute: (name: string) => { attributes.delete(name); },
    };
  }

  it("makes the app root inert and aria-hidden, then restores its exact prior state", () => {
    const root = target({ "data-app": "budget" });
    const restore = isolateApplicationRoot(root);
    expect(Object.fromEntries(root.attributes)).toEqual({
      "data-app": "budget",
      inert: "",
      "aria-hidden": "true",
    });

    restore();
    expect(Object.fromEntries(root.attributes)).toEqual({ "data-app": "budget" });
  });

  it("preserves pre-existing isolation attributes", () => {
    const root = target({ inert: "", "aria-hidden": "false" });
    const restore = isolateApplicationRoot(root);
    restore();
    expect(Object.fromEntries(root.attributes)).toEqual({
      inert: "",
      "aria-hidden": "false",
    });
  });

  it("focuses the safe action on activation and restores the connected opener on close", () => {
    const root = target();
    const safeAction = { focus: vi.fn() };
    const opener = { focus: vi.fn(), isConnected: true };
    const restore = activateDialogEnvironment(root, safeAction, opener);

    expect(safeAction.focus).toHaveBeenCalledTimes(1);
    expect(root.attributes.get("inert")).toBe("");
    restore();
    expect(root.attributes.has("inert")).toBe(false);
    expect(opener.focus).toHaveBeenCalledTimes(1);
  });

  it("does not focus a detached opener after successful navigation", () => {
    const opener = { focus: vi.fn(), isConnected: false };
    const restore = activateDialogEnvironment(null, null, opener);
    restore();
    expect(opener.focus).not.toHaveBeenCalled();
  });
});
