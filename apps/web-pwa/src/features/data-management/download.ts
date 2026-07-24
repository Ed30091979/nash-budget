import { type PreparedDownload } from "./model";

interface DownloadEnvironment {
  readonly document: Pick<Document, "body" | "createElement">;
  readonly url: Pick<typeof URL, "createObjectURL" | "revokeObjectURL">;
  readonly defer: (callback: () => void) => unknown;
}

function browserEnvironment(): DownloadEnvironment {
  return {
    document,
    url: URL,
    defer: (callback) => window.setTimeout(callback, 0),
  };
}

/**
 * Appending the anchor is required by Safari. Revocation is deferred because
 * revoking in the click stack can cancel downloads on iOS.
 */
export function downloadTextFile(
  download: PreparedDownload,
  environment: DownloadEnvironment = browserEnvironment(),
): void {
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
