package com.edfurman.nashbudget;

import android.app.Activity;
import android.content.Intent;
import android.net.Uri;
import androidx.activity.result.ActivityResult;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.ActivityCallback;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.io.IOException;
import java.io.OutputStream;

@CapacitorPlugin(name = "NativeFileExport")
public final class NativeFileExportPlugin extends Plugin {
    private boolean exportPending;

    @PluginMethod
    public synchronized void saveTextFile(PluginCall call) {
        if (exportPending) {
            call.reject("Another file export is already in progress.", "EXPORT_BUSY");
            return;
        }

        final NativeFileExportPolicy.ValidatedExport export;
        try {
            export = validatedCall(call);
        } catch (IllegalArgumentException exception) {
            call.reject("File export input was rejected.", "EXPORT_INVALID");
            return;
        }

        Intent intent = new Intent(Intent.ACTION_CREATE_DOCUMENT);
        intent.addCategory(Intent.CATEGORY_OPENABLE);
        intent.setType(export.intentMediaType());
        intent.putExtra(Intent.EXTRA_TITLE, export.filename());

        exportPending = true;
        try {
            startActivityForResult(call, intent, "documentSelected");
        } catch (RuntimeException exception) {
            exportPending = false;
            call.reject("The system file picker could not be opened.", "EXPORT_UNAVAILABLE");
        }
    }

    @ActivityCallback
    private void documentSelected(PluginCall call, ActivityResult result) {
        if (call == null) {
            finishExport();
            return;
        }
        if (result == null || result.getResultCode() != Activity.RESULT_OK) {
            finishExport();
            call.reject("File export was cancelled.", "EXPORT_CANCELLED");
            return;
        }

        Intent resultData = result.getData();
        Uri selectedUri = resultData == null ? null : resultData.getData();
        if (
            selectedUri == null ||
            !NativeFileExportPolicy.isUserSelectedContentUri(
                result.getResultCode(),
                selectedUri.getScheme()
            )
        ) {
            finishExport();
            call.reject("The system file picker returned an invalid document.", "EXPORT_INVALID_RESULT");
            return;
        }

        final NativeFileExportPolicy.ValidatedExport export;
        try {
            export = validatedCall(call);
        } catch (IllegalArgumentException exception) {
            finishExport();
            call.reject("File export input was rejected.", "EXPORT_INVALID");
            return;
        }

        getBridge().execute(() -> writeSelectedDocument(call, selectedUri, export));
    }

    private void writeSelectedDocument(
        PluginCall call,
        Uri selectedUri,
        NativeFileExportPolicy.ValidatedExport export
    ) {
        try {
            OutputStream output = getContext()
                .getContentResolver()
                .openOutputStream(selectedUri, NativeFileExportPolicy.WRITE_TRUNCATE_MODE);
            NativeFileExportPolicy.writeAndClose(output, export.utf8());
            JSObject result = new JSObject();
            result.put("saved", true);
            finishExport();
            call.resolve(result);
        } catch (IOException | RuntimeException exception) {
            finishExport();
            call.reject("The selected document could not be written.", "EXPORT_WRITE_FAILED");
        }
    }

    private static NativeFileExportPolicy.ValidatedExport validatedCall(PluginCall call) {
        return NativeFileExportPolicy.validate(
            call.getString("filename"),
            call.getString("mediaType"),
            call.getString("text")
        );
    }

    private synchronized void finishExport() {
        exportPending = false;
    }
}
