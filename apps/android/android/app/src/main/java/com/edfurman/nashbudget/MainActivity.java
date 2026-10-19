package com.edfurman.nashbudget;

import android.os.Bundle;
import android.webkit.WebView;
import androidx.activity.OnBackPressedCallback;
import com.getcapacitor.Bridge;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    protected void onCreate(Bundle savedInstanceState) {
        registerPlugin(NativeFileExportPlugin.class);
        super.onCreate(savedInstanceState);
        getOnBackPressedDispatcher().addCallback(this, new WebHistoryBackCallback());
    }

    /**
     * System Back walks the web app's own history, the way the browser's Back does.
     *
     * The app keeps its routes in that history (the address hash): Back from a subscreen lands on
     * its parent, from a tab on the overview, and a dirty draft is asked about in the app's own
     * dialog. Without this callback Android finished the activity from any screen. When the
     * history has nothing behind the current entry (the overview opened at launch), Back is left
     * to the system, which leaves the app as usual.
     */
    private final class WebHistoryBackCallback extends OnBackPressedCallback {
        WebHistoryBackCallback() {
            super(true);
        }

        @Override
        public void handleOnBackPressed() {
            Bridge bridge = getBridge();
            WebView webView = bridge == null ? null : bridge.getWebView();
            if (webView != null && webView.canGoBack()) {
                webView.goBack();
                return;
            }
            setEnabled(false);
            getOnBackPressedDispatcher().onBackPressed();
            setEnabled(true);
        }
    }
}
