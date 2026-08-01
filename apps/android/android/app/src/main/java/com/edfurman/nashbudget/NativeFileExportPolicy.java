package com.edfurman.nashbudget;

import java.io.IOException;
import java.io.OutputStream;
import java.nio.charset.StandardCharsets;
import java.util.Locale;
import java.util.regex.Pattern;

final class NativeFileExportPolicy {
    static final int MAX_EXPORT_BYTES = 5 * 1024 * 1024;
    static final int MAX_FILENAME_LENGTH = 128;
    static final String WRITE_TRUNCATE_MODE = "wt";

    private static final Pattern SAFE_FILENAME = Pattern.compile(
        "^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$"
    );
    private static final String JSON_MEDIA_TYPE = "application/json;charset=utf-8";
    private static final String CSV_MEDIA_TYPE = "text/csv;charset=utf-8";

    private NativeFileExportPolicy() {}

    static ValidatedExport validate(String filename, String mediaType, String text) {
        if (
            filename == null ||
            filename.length() > MAX_FILENAME_LENGTH ||
            !SAFE_FILENAME.matcher(filename).matches()
        ) {
            throw new IllegalArgumentException("Invalid export filename.");
        }

        String normalizedFilename = filename.toLowerCase(Locale.ROOT);
        final String intentMediaType;
        if (JSON_MEDIA_TYPE.equals(mediaType) && normalizedFilename.endsWith(".json")) {
            intentMediaType = "application/json";
        } else if (CSV_MEDIA_TYPE.equals(mediaType) && normalizedFilename.endsWith(".csv")) {
            intentMediaType = "text/csv";
        } else {
            throw new IllegalArgumentException("Invalid export media type.");
        }

        if (text == null) {
            throw new IllegalArgumentException("Export content is required.");
        }
        byte[] utf8 = text.getBytes(StandardCharsets.UTF_8);
        if (utf8.length > MAX_EXPORT_BYTES) {
            throw new IllegalArgumentException("Export content is too large.");
        }
        return new ValidatedExport(filename, intentMediaType, utf8);
    }

    static boolean isUserSelectedContentUri(int resultCode, String uriScheme) {
        return resultCode == -1 && "content".equals(uriScheme);
    }

    static void writeAndClose(OutputStream output, byte[] utf8) throws IOException {
        if (output == null) {
            throw new IOException("Document provider returned no output stream.");
        }
        try (OutputStream target = output) {
            target.write(utf8);
            target.flush();
        }
    }

    static final class ValidatedExport {
        private final String filename;
        private final String intentMediaType;
        private final byte[] utf8;

        private ValidatedExport(String filename, String intentMediaType, byte[] utf8) {
            this.filename = filename;
            this.intentMediaType = intentMediaType;
            this.utf8 = utf8;
        }

        String filename() {
            return filename;
        }

        String intentMediaType() {
            return intentMediaType;
        }

        byte[] utf8() {
            return utf8;
        }
    }
}
