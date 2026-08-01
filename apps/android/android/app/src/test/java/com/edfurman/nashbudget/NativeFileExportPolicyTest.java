package com.edfurman.nashbudget;

import static org.junit.Assert.assertArrayEquals;
import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertThrows;
import static org.junit.Assert.assertTrue;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.OutputStream;
import java.nio.charset.StandardCharsets;
import org.junit.Test;

public class NativeFileExportPolicyTest {
    @Test
    public void usesExplicitWriteAndTruncateModeForDocumentProviders() {
        assertEquals("wt", NativeFileExportPolicy.WRITE_TRUNCATE_MODE);
    }

    @Test
    public void acceptsOnlyProductJsonAndCsvExports() {
        NativeFileExportPolicy.ValidatedExport json = NativeFileExportPolicy.validate(
            "family-budget-backup-2026-07-30.json",
            "application/json;charset=utf-8",
            "{\"месяц\":\"июль\"}"
        );
        assertEquals("application/json", json.intentMediaType());
        assertArrayEquals(
            "{\"месяц\":\"июль\"}".getBytes(StandardCharsets.UTF_8),
            json.utf8()
        );

        NativeFileExportPolicy.ValidatedExport csv = NativeFileExportPolicy.validate(
            "family-budget-operations-2026-07-30.csv",
            "text/csv;charset=utf-8",
            "Дата;Сумма\n"
        );
        assertEquals("text/csv", csv.intentMediaType());
    }

    @Test
    public void rejectsTraversalSeparatorsUnicodeAndOverlongNames() {
        for (String filename : new String[] {
            "../backup.json",
            "folder/backup.json",
            "folder\\backup.json",
            ".json",
            "бюджет.json",
            "a".repeat(NativeFileExportPolicy.MAX_FILENAME_LENGTH + 1) + ".json",
        }) {
            assertThrows(
                IllegalArgumentException.class,
                () -> NativeFileExportPolicy.validate(
                    filename,
                    "application/json;charset=utf-8",
                    "{}"
                )
            );
        }
    }

    @Test
    public void rejectsMismatchedOrUnlistedMediaTypes() {
        assertThrows(
            IllegalArgumentException.class,
            () -> NativeFileExportPolicy.validate(
                "backup.csv",
                "application/json;charset=utf-8",
                "{}"
            )
        );
        assertThrows(
            IllegalArgumentException.class,
            () -> NativeFileExportPolicy.validate(
                "backup.json",
                "text/plain",
                "{}"
            )
        );
    }

    @Test
    public void enforcesFiveMiBUtf8Limit() {
        String atLimit = "a".repeat(NativeFileExportPolicy.MAX_EXPORT_BYTES);
        assertEquals(
            NativeFileExportPolicy.MAX_EXPORT_BYTES,
            NativeFileExportPolicy.validate(
                "backup.json",
                "application/json;charset=utf-8",
                atLimit
            ).utf8().length
        );
        assertThrows(
            IllegalArgumentException.class,
            () -> NativeFileExportPolicy.validate(
                "backup.json",
                "application/json;charset=utf-8",
                atLimit + "я"
            )
        );
    }

    @Test
    public void acceptsOnlyAUserSelectedContentUri() {
        assertTrue(NativeFileExportPolicy.isUserSelectedContentUri(-1, "content"));
        assertFalse(NativeFileExportPolicy.isUserSelectedContentUri(0, "content"));
        assertFalse(NativeFileExportPolicy.isUserSelectedContentUri(-1, "file"));
        assertFalse(NativeFileExportPolicy.isUserSelectedContentUri(-1, null));
    }

    @Test
    public void writesFlushesAndClosesBeforeReturning() throws IOException {
        TrackingOutputStream output = new TrackingOutputStream();
        byte[] expected = "Данные".getBytes(StandardCharsets.UTF_8);

        NativeFileExportPolicy.writeAndClose(output, expected);

        assertArrayEquals(expected, output.toByteArray());
        assertTrue(output.flushed);
        assertTrue(output.closed);
    }

    @Test
    public void closesTheDocumentWhenWritingFails() {
        FailingOutputStream output = new FailingOutputStream();

        assertThrows(
            IOException.class,
            () -> NativeFileExportPolicy.writeAndClose(output, new byte[] { 1 })
        );
        assertTrue(output.closed);
    }

    private static final class TrackingOutputStream extends ByteArrayOutputStream {
        private boolean flushed;
        private boolean closed;

        @Override
        public void flush() throws IOException {
            flushed = true;
            super.flush();
        }

        @Override
        public void close() throws IOException {
            closed = true;
            super.close();
        }
    }

    private static final class FailingOutputStream extends OutputStream {
        private boolean closed;

        @Override
        public void write(int value) throws IOException {
            throw new IOException("synthetic write failure");
        }

        @Override
        public void close() {
            closed = true;
        }
    }
}
