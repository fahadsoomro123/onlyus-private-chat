package com.onlyus.privatechat;

import android.Manifest;
import android.app.Activity;
import android.app.AlertDialog;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.graphics.Color;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.PowerManager;
import android.provider.Settings;
import android.view.View;
import android.view.ViewGroup;
import android.view.ViewParent;
import android.view.Window;
import android.webkit.JavascriptInterface;
import android.webkit.PermissionRequest;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;

import java.io.IOException;
import java.io.InputStream;
import java.util.Collections;
import java.util.HashMap;
import java.util.Locale;
import java.util.Map;

public final class MainActivity extends Activity {
    private static final int REQUEST_AUDIO = 7214;
    private static final String ASSET_HOST = "appassets.androidplatform.net";
    private static WebView retainedWebView;
    private WebView webView;
    private boolean restoredRetainedWebView;
    private PermissionRequest pendingAudioRequest;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        OnlyUsService.start(this);
        handleCallActionIntent(getIntent());
        OnlyUsMessagingService.refreshTokenRegistration(getApplicationContext());
        if (Build.VERSION.SDK_INT >= 33
            && checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) {
            requestPermissions(new String[]{Manifest.permission.POST_NOTIFICATIONS}, 7215);
        }
        Window window = getWindow();
        window.setStatusBarColor(Color.rgb(246, 248, 252));
        window.setNavigationBarColor(Color.rgb(246, 248, 252));
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
            window.getDecorView().setSystemUiVisibility(View.SYSTEM_UI_FLAG_LIGHT_STATUS_BAR);
        }

        synchronized (MainActivity.class) {
            if (retainedWebView != null) {
                webView = retainedWebView;
                retainedWebView = null;
                restoredRetainedWebView = true;
            } else {
                webView = new WebView(getApplicationContext());
            }
        }
        webView.addJavascriptInterface(new OnlyUsBridge(getApplicationContext()), "AndroidOnlyUs");
        webView.setBackgroundColor(Color.rgb(246, 248, 252));
        WebSettings settings = webView.getSettings();
        settings.setJavaScriptEnabled(true);
        settings.setDomStorageEnabled(true);
        settings.setMediaPlaybackRequiresUserGesture(false);
        settings.setAllowFileAccess(false);
        settings.setAllowContentAccess(false);
        settings.setSupportMultipleWindows(false);
        settings.setJavaScriptCanOpenWindowsAutomatically(false);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.LOLLIPOP) {
            settings.setMixedContentMode(WebSettings.MIXED_CONTENT_NEVER_ALLOW);
        }
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            settings.setSafeBrowsingEnabled(true);
        }

        webView.setWebViewClient(new WebViewClient() {
            @Override
            public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                Uri uri = request.getUrl();
                return !(uri != null
                    && "https".equalsIgnoreCase(uri.getScheme())
                    && ASSET_HOST.equalsIgnoreCase(uri.getHost()));
            }

            @Override
            public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest request) {
                Uri uri = request.getUrl();
                if (uri == null || !ASSET_HOST.equalsIgnoreCase(uri.getHost())) {
                    return super.shouldInterceptRequest(view, request);
                }
                return openBundledAsset(uri.getPath());
            }
        });

        webView.setWebChromeClient(new WebChromeClient() {
            @Override
            public void onPermissionRequest(PermissionRequest request) {
                runOnUiThread(() -> handleWebPermission(request));
            }
        });

        setContentView(webView);
        webView.resumeTimers();
        if (!restoredRetainedWebView) {
            webView.loadUrl("https://" + ASSET_HOST + "/assets/index.html");
        }
        webView.postDelayed(this::requestBackgroundCallPermission, 1400);
    }

    private void handleCallActionIntent(Intent intent) {
        if (intent == null || !OnlyUsCallActionReceiver.ACTION_ANSWER.equals(intent.getAction())) return;
        String callId = intent.getStringExtra(OnlyUsCallActionReceiver.EXTRA_CALL_ID);
        String caller = intent.getStringExtra(OnlyUsCallActionReceiver.EXTRA_CALLER);
        if (callId == null || callId.isEmpty()) return;
        android.content.SharedPreferences prefs = getSharedPreferences("onlyus.pending-call", MODE_PRIVATE);
        if (!callId.equals(prefs.getString("activePushCallId", ""))) return;
        prefs.edit()
            .remove("activePushCallId")
            .remove("activePushCaller")
            .putString("pendingCallId", callId)
            .putString("pendingCaller", caller == null ? "Your partner" : caller)
            .putBoolean("answerNextCall", true)
            .apply();
        OnlyUsBackend.sendCallEvent(this, "accepted", callId);
        OnlyUsService.callEnded(this);
        if (webView != null) {
            webView.postDelayed(() -> webView.evaluateJavascript(
                "window.onlyUsAnswerPendingCall && window.onlyUsAnswerPendingCall();", null), 250);
        }
    }

    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        setIntent(intent);
        handleCallActionIntent(intent);
    }

    private void requestBackgroundCallPermission() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.M) return;
        PowerManager power = (PowerManager) getSystemService(POWER_SERVICE);
        if (power == null || power.isIgnoringBatteryOptimizations(getPackageName())) return;
        new AlertDialog.Builder(this)
            .setTitle("Keep Only Us available")
            .setMessage("Allow unrestricted battery use so Only Us can keep its private connection active while the screen is off. This uses extra battery.")
            .setPositiveButton("Allow", (dialog, which) -> {
                try {
                    Intent intent = new Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS,
                        Uri.parse("package:" + getPackageName()));
                    startActivity(intent);
                } catch (Exception error) {
                    startActivity(new Intent(Settings.ACTION_IGNORE_BATTERY_OPTIMIZATION_SETTINGS));
                }
            })
            .setNegativeButton("Later", null)
            .show();
    }

    private WebResourceResponse openBundledAsset(String urlPath) {
        if (urlPath == null || !urlPath.startsWith("/assets/") || urlPath.contains("..")) {
            return new WebResourceResponse("text/plain", "UTF-8", 403, "Forbidden",
                Collections.emptyMap(), null);
        }
        String assetName = urlPath.substring("/assets/".length());
        String lower = assetName.toLowerCase(Locale.ROOT);
        String mime = "application/octet-stream";
        if (lower.endsWith(".html")) mime = "text/html";
        else if (lower.endsWith(".js")) mime = "text/javascript";
        else if (lower.endsWith(".css")) mime = "text/css";
        else if (lower.endsWith(".json")) mime = "application/json";
        else if (lower.endsWith(".svg")) mime = "image/svg+xml";

        try {
            InputStream stream = getAssets().open(assetName);
            Map<String, String> headers = new HashMap<>();
            headers.put("Access-Control-Allow-Origin", "https://" + ASSET_HOST);
            headers.put("X-Content-Type-Options", "nosniff");
            headers.put("Cache-Control", lower.endsWith("pair-config.json") ? "no-store" : "no-cache");
            return new WebResourceResponse(mime, "UTF-8", 200, "OK", headers, stream);
        } catch (IOException e) {
            return new WebResourceResponse("text/plain", "UTF-8", 404, "Not Found",
                Collections.emptyMap(), null);
        }
    }

    private static final class OnlyUsBridge {
        private final Context appContext;

        OnlyUsBridge(Context context) {
            appContext = context.getApplicationContext();
        }

        @JavascriptInterface
        public void incomingCall(String callId, String caller) {
            OnlyUsService.incomingCall(appContext, callId, caller);
        }

        @JavascriptInterface
        public void callEnded() {
            OnlyUsService.callEnded(appContext);
        }

        @JavascriptInterface
        public boolean shouldAutoAnswer(String callId) {
            return OnlyUsCallActionReceiver.consumeAnswerFor(appContext, callId);
        }
    }

    private void handleWebPermission(PermissionRequest request) {
        if (request == null) return;
        Uri origin = request.getOrigin();
        if (origin == null || !"https".equalsIgnoreCase(origin.getScheme())
            || !ASSET_HOST.equalsIgnoreCase(origin.getHost())) {
            request.deny();
            return;
        }

        boolean needsAudio = false;
        for (String resource : request.getResources()) {
            if (PermissionRequest.RESOURCE_AUDIO_CAPTURE.equals(resource)) {
                needsAudio = true;
            } else {
                request.deny();
                return;
            }
        }
        if (!needsAudio) {
            request.deny();
            return;
        }

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M
            && checkSelfPermission(Manifest.permission.RECORD_AUDIO) != PackageManager.PERMISSION_GRANTED) {
            pendingAudioRequest = request;
            requestPermissions(new String[]{Manifest.permission.RECORD_AUDIO}, REQUEST_AUDIO);
            return;
        }
        request.grant(new String[]{PermissionRequest.RESOURCE_AUDIO_CAPTURE});
    }

    @Override
    public void onRequestPermissionsResult(int requestCode, String[] permissions, int[] grantResults) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults);
        if (requestCode != REQUEST_AUDIO || pendingAudioRequest == null) return;
        PermissionRequest request = pendingAudioRequest;
        pendingAudioRequest = null;
        if (grantResults.length > 0 && grantResults[0] == PackageManager.PERMISSION_GRANTED) {
            request.grant(new String[]{PermissionRequest.RESOURCE_AUDIO_CAPTURE});
        } else {
            request.deny();
        }
    }

    @Override
    protected void onDestroy() {
        if (pendingAudioRequest != null) {
            try { pendingAudioRequest.deny(); } catch (Exception ignored) {}
            pendingAudioRequest = null;
        }
        if (webView != null) {
            // Keep the live WebView/PeerJS socket across a swipe from Recents.
            // OnlyUsService is foreground and holds a partial wake lock, so the
            // WebView can continue receiving signaling without an Activity window.
            ViewParent parent = webView.getParent();
            if (parent instanceof ViewGroup) {
                ((ViewGroup) parent).removeView(webView);
            }
            synchronized (MainActivity.class) {
                if (retainedWebView == null) {
                    retainedWebView = webView;
                } else if (retainedWebView != webView) {
                    webView.stopLoading();
                    webView.setWebChromeClient(null);
                    webView.setWebViewClient(null);
                    webView.destroy();
                }
            }
            webView = null;
        }
        super.onDestroy();
    }
}
