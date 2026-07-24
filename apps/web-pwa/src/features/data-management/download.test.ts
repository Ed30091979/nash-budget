import { describe, expect, it, vi } from "vitest";
import { downloadTextFile } from "./download";

describe("Safari-compatible download", () => {
  it("appends and clicks the anchor, then revokes the URL on the next tick", () => {
    const order: string[] = [];
    const anchor = {
      href: "",
      download: "",
      rel: "",
      click: vi.fn(() => order.push("click")),
      remove: vi.fn(() => order.push("remove")),
    };
    let deferred: (() => void) | undefined;
    const environment = {
      document: {
        body: { append: vi.fn(() => order.push("append")) },
        createElement: vi.fn(() => anchor),
      },
      url: {
        createObjectURL: vi.fn(() => "blob:opaque-id"),
        revokeObjectURL: vi.fn(() => order.push("revoke")),
      },
      defer: vi.fn((callback: () => void) => { deferred = callback; }),
    };

    downloadTextFile(
      {
        filename: "family-budget-backup-2026-07-17.json",
        mediaType: "application/json;charset=utf-8",
        text: '{"safe":true}',
      },
      environment as never,
    );

    expect(anchor.href).toBe("blob:opaque-id");
    expect(anchor.download).toBe("family-budget-backup-2026-07-17.json");
    expect(anchor.rel).toBe("noopener");
    expect(order).toEqual(["append", "click", "remove"]);
    expect(environment.url.revokeObjectURL).not.toHaveBeenCalled();
    deferred?.();
    expect(order).toEqual(["append", "click", "remove", "revoke"]);
  });
});
