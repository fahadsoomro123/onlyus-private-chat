package com.onlyus.privatechat;

import android.content.Context;
import android.util.Log;

import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

final class OnlyUsBackend {
    private static final String TAG = "OnlyUsBackend";
    private static final ExecutorService IO = Executors.newSingleThreadExecutor();

    private OnlyUsBackend() {}

    static void registerPhoneToken(Context context, String fcmToken) {
        if (fcmToken == null || fcmToken.length() < 20) return;
        final Context app = context.getApplicationContext();
        IO.execute(() -> post(app, "/v1/register-phone", new JSONObjectSafe().put("fcmToken", fcmToken)));
    }

    static void sendCallEvent(Context context, String event, String callId) {
        if (callId == null || callId.length() < 8) return;
        final Context app = context.getApplicationContext();
        IO.execute(() -> {
            JSONObjectSafe body = new JSONObjectSafe()
                .put("from", "phone")
                .put("event", event)
                .put("callId", callId);
            post(app, "/v1/call", body);
        });
    }

    static String backendUrl(Context context) {
        try {
            JSONObject config = readConfig(context);
            String value = config.optString("backendUrl", "").trim();
            while (value.endsWith("/")) value = value.substring(0, value.length() - 1);
            return value;
        } catch (Exception ignored) {
            return "";
        }
    }

    static String pairingToken(Context context) {
        try {
            String token = readConfig(context).optString("roomKey", "").trim();
            return token.matches("[a-fA-F0-9]{48}") ? token : "";
        } catch (Exception ignored) {
            return "";
        }
    }

    private static JSONObject readConfig(Context context) throws Exception {
        try (InputStream input = context.getAssets().open("pair-config.json");
             ByteArrayOutputStream output = new ByteArrayOutputStream()) {
            byte[] buffer = new byte[4096];
            int count;
            while ((count = input.read(buffer)) != -1) output.write(buffer, 0, count);
            return new JSONObject(output.toString(StandardCharsets.UTF_8.name()));
        }
    }

    private static void post(Context context, String route, JSONObjectSafe body) {
        String base = backendUrl(context);
        String token = pairingToken(context);
        if (base.isEmpty() || token.isEmpty()) return;

        HttpURLConnection connection = null;
        try {
            URL url = new URL(base + route);
            connection = (HttpURLConnection) url.openConnection();
            connection.setRequestMethod("POST");
            connection.setConnectTimeout(5000);
            connection.setReadTimeout(5000);
            connection.setDoOutput(true);
            connection.setRequestProperty("Authorization", "Bearer " + token);
            connection.setRequestProperty("Content-Type", "application/json; charset=utf-8");
            byte[] payload = body.toJson().getBytes(StandardCharsets.UTF_8);
            connection.setFixedLengthStreamingMode(payload.length);
            try (OutputStream output = connection.getOutputStream()) {
                output.write(payload);
            }
            int status = connection.getResponseCode();
            if (status < 200 || status >= 300) {
                Log.w(TAG, "Backend request failed with HTTP " + status + " for " + route);
            }
        } catch (Exception error) {
            Log.w(TAG, "Backend is not configured or reachable for " + route + ": " + error.getMessage());
        } finally {
            if (connection != null) connection.disconnect();
        }
    }

    private static final class JSONObjectSafe {
        private final org.json.JSONObject value = new org.json.JSONObject();

        JSONObjectSafe put(String key, String text) {
            try { value.put(key, text == null ? "" : text); } catch (Exception ignored) {}
            return this;
        }

        String toJson() { return value.toString(); }
    }
}
