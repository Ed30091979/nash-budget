/// <reference types="node" />
import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import {
  DISCARD_DRAFT_CONFIRMATION,
  protectUnsavedDraftOnUnload,
  shouldChangeScreen,
  type Screen,
} from "./App";

describe("draft-safe navigation", () => {
  it("changes a clean route without asking for confirmation", () => {
    const confirmDiscard = vi.fn(() => false);

    expect(shouldChangeScreen("operations", "today", false, confirmDiscard)).toBe(true);
    expect(confirmDiscard).not.toHaveBeenCalled();
  });

  it("keeps the dirty route mounted when discard is cancelled", () => {
    const confirmDiscard = vi.fn(() => false);

    expect(shouldChangeScreen("operations", "year", true, confirmDiscard)).toBe(false);
    expect(confirmDiscard).toHaveBeenCalledOnce();
  });

  it("changes the dirty route only after discard is confirmed", () => {
    const confirmDiscard = vi.fn(() => true);

    expect(shouldChangeScreen("planning", "more", true, confirmDiscard)).toBe(true);
    expect(confirmDiscard).toHaveBeenCalledOnce();
    expect(DISCARD_DRAFT_CONFIRMATION).toContain("черновик будет удалён");
  });

  it("does not navigate or ask when the destination is the current route", () => {
    const confirmDiscard = vi.fn(() => true);

    expect(shouldChangeScreen("operations", "operations", true, confirmDiscard)).toBe(false);
    expect(confirmDiscard).not.toHaveBeenCalled();
  });

  it.each([
    ["operations", "today"],
    ["operations", "year"],
    ["operations", "more"],
    ["planning", "today"],
    ["planning", "year"],
    ["planning", "operations"],
    ["planning", "more"],
  ] satisfies ReadonlyArray<readonly [Screen, Screen]>)(
    "guards the %s to %s route path while dirty",
    (current, destination) => {
      const confirmDiscard = vi.fn(() => false);

      expect(shouldChangeScreen(current, destination, true, confirmDiscard)).toBe(false);
      expect(confirmDiscard).toHaveBeenCalledOnce();
    },
  );

  it("protects browser unload only while a draft is dirty", () => {
    const cleanEvent = {
      preventDefault: vi.fn(),
      returnValue: "unchanged",
    } as unknown as BeforeUnloadEvent;
    const dirtyEvent = {
      preventDefault: vi.fn(),
      returnValue: "unchanged",
    } as unknown as BeforeUnloadEvent;

    protectUnsavedDraftOnUnload(cleanEvent, false);
    expect(cleanEvent.preventDefault).not.toHaveBeenCalled();
    expect(cleanEvent.returnValue).toBe("unchanged");

    protectUnsavedDraftOnUnload(dirtyEvent, true);
    expect(dirtyEvent.preventDefault).toHaveBeenCalledOnce();
    expect(dirtyEvent.returnValue).toBe("");
  });

  it("routes every internal unmounting control through the shared guard", () => {
    const source = readFileSync(new URL("./App.tsx", import.meta.url), "utf8");

    expect(source).toContain('onClick={() => navigate("today")}');
    expect(source).toContain('onClick={() => navigate("year")}');
    expect(source).toContain('onClick={() => navigate("operations")}');
    expect(source).toContain('onClick={() => navigate("more")}');
    expect(source).toContain('onAdd={() => navigate("operations")}');
    expect(source).toContain('onYear={() => navigate("year")}');
    expect(source).toContain('onPlanning={() => navigate("planning")}');
    expect(source).not.toMatch(/on(?:Click|Add|Year|Planning)=\{\(\) => setScreen\(/);
    expect(source).toContain('window.addEventListener("beforeunload", beforeUnload)');
    expect(source).toContain('window.removeEventListener("beforeunload", beforeUnload)');
  });
});
