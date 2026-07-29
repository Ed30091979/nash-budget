import { describe, expect, it, vi } from "vitest";
import {
  downloadTextFile,
  resolveNativeFileExporter,
} from "./download";

describe("Safari-compatible download", () => {
  it("appends and clicks the anchor, then revokes the URL on the next tick", async () => {
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

    await downloadTextFile(
      {
        filename: "family-budget-backup-2026-07-17.json",
        mediaType: "application/json;charset=utf-8",
        text: '{"safe":true}',
      },
      { kind: "browser", ...environment } as never,
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

describe("native file export", () => {
  const download = {
    filename: "family-budget-backup-2026-07-30.json",
    mediaType: "application/json;charset=utf-8",
    text: '{"safe":true}',
  };

  it("resolves only after the native exporter confirms a completed write", async () => {
    let complete!: (result: { readonly saved: boolean }) => void;
    const exporter = {
      saveTextFile: vi.fn(
        () => new Promise<{ readonly saved: boolean }>((resolve) => {
          complete = resolve;
        }),
      ),
    };

    let settled = false;
    const pending = downloadTextFile(download, {
      kind: "native",
      exporter,
    }).then(() => {
      settled = true;
    });

    await Promise.resolve();
    expect(settled).toBe(false);
    expect(exporter.saveTextFile).toHaveBeenCalledWith(download);
    complete({ saved: true });
    await pending;
    expect(settled).toBe(true);
  });

  it.each(["EXPORT_CANCELLED", "EXPORT_WRITE_FAILED"])(
    "rejects when the native picker/export rejects with %s",
    async (code) => {
      const error = Object.assign(new Error("Native export failed."), { code });
      const exporter = {
        saveTextFile: vi.fn(async () => {
          throw error;
        }),
      };

      await expect(downloadTextFile(download, {
        kind: "native",
        exporter,
      })).rejects.toBe(error);
    },
  );

  it("rejects an unconfirmed native completion", async () => {
    await expect(downloadTextFile(download, {
      kind: "native",
      exporter: {
        saveTextFile: vi.fn(async () => ({ saved: false })),
      },
    })).rejects.toThrow(/did not confirm/u);
  });

  it("uses only the Android-injected plugin and never silently falls back", () => {
    const exporter = {
      saveTextFile: vi.fn(async () => ({ saved: true })),
    };
    expect(resolveNativeFileExporter({
      isNativePlatform: () => true,
      getPlatform: () => "android",
      Plugins: { NativeFileExport: exporter },
    })).toBe(exporter);
    expect(resolveNativeFileExporter({
      isNativePlatform: () => false,
      getPlatform: () => "web",
    })).toBeNull();
    expect(() => resolveNativeFileExporter({
      isNativePlatform: () => true,
      getPlatform: () => "android",
      Plugins: {},
    })).toThrow(/bridge is unavailable/u);
  });
});
