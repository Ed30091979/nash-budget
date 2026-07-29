import { type PreparedDownload } from "./model";

interface NativeFileExportPlugin {
  saveTextFile(options: PreparedDownload): Promise<{ readonly saved: boolean }>;
}

interface CapacitorRuntime {
  readonly Plugins?: {
    readonly NativeFileExport?: NativeFileExportPlugin;
  };
  isNativePlatform?(): boolean;
  getPlatform?(): string;
}

interface NativeDownloadEnvironment {
  readonly kind: "native";
  readonly exporter: NativeFileExportPlugin;
}

interface BrowserDownloadEnvironment {
  readonly kind: "browser";
  readonly document: Pick<Document, "body" | "createElement">;
  readonly url: Pick<typeof URL, "createObjectURL" | "revokeObjectURL">;
  readonly defer: (callback: () => void) => unknown;
}

export type DownloadEnvironment =
  | NativeDownloadEnvironment
  | BrowserDownloadEnvironment;

export function resolveNativeFileExporter(
  runtime: CapacitorRuntime | undefined = (
    globalThis as typeof globalThis & {
      readonly Capacitor?: CapacitorRuntime;
    }
  ).Capacitor,
): NativeFileExportPlugin | null {
  if (
    runtime?.isNativePlatform?.() !== true ||
    runtime.getPlatform?.() !== "android"
  ) {
    return null;
  }
  const exporter = runtime.Plugins?.NativeFileExport;
  if (typeof exporter?.saveTextFile !== "function") {
    throw new Error("Native file export bridge is unavailable.");
  }
  return exporter;
}

function runtimeEnvironment(): DownloadEnvironment {
  const exporter = resolveNativeFileExporter();
  if (exporter) {
    return {
      kind: "native",
      exporter,
    };
  }
  return {
    kind: "browser",
    document,
    url: URL,
    defer: (callback) => window.setTimeout(callback, 0),
  };
}

/**
 * Appending the anchor is required by Safari. Revocation is deferred because
 * revoking in the click stack can cancel downloads on iOS.
 */
export async function downloadTextFile(
  download: PreparedDownload,
  environment: DownloadEnvironment = runtimeEnvironment(),
): Promise<void> {
  if (environment.kind === "native") {
    const result = await environment.exporter.saveTextFile(download);
    if (result.saved !== true) {
      throw new Error("Native file export did not confirm completion.");
    }
    return;
  }

  const objectUrl = environment.url.createObjectURL(
    new Blob([download.text], { type: download.mediaType }),
  );
  const anchor = environment.document.createElement("a");
  anchor.href = objectUrl;
  anchor.download = download.filename;
  anchor.rel = "noopener";
  try {
    environment.document.body.append(anchor);
    anchor.click();
  } finally {
    anchor.remove();
    environment.defer(() => environment.url.revokeObjectURL(objectUrl));
  }
}
