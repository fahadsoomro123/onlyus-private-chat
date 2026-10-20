package com.onlyus.privatechat;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Person;
import android.content.Context;
import android.content.Intent;
import android.os.Build;
import android.util.Log;

import com.google.firebase.FirebaseApp;
import com.google.firebase.messaging.FirebaseMessagingService;
import com.google.firebase.messaging.RemoteMessage;

import java.util.Map;

public final class OnlyUsMessagingService extends FirebaseMessagingService {
    private static final String TAG = "OnlyUsPush";

    @Override
    public void onNewToken(String token) {
        super.onNewToken(token);
        OnlyUsBackend.registerPhoneToken(getApplicationContext(), token);
    }

    @Override
    public void onMessageReceived(RemoteMessage message) {
        super.onMessageReceived(message);
        Map<String, String> data = message.getData();
        String type = data.get("type");
        String callId = data.get("callId");
        String event = data.get("event");
        if (!"incoming_call".equals(type) || callId == null) return;

        if ("ringing".equals(event)) {
            String caller = data.getOrDefault("caller", "Your partner");
            OnlyUsBackend.registerPhoneToken(this, getCurrentTokenFallback(data));
            OnlyUsService.incomingCall(this, callId, caller);
        } else if ("accepted".equals(event) || "rejected".equals(event)
                || "ended".equals(event) || "missed".equals(event)) {
            OnlyUsService.callEnded(this);
        }
    }

    private String getCurrentTokenFallback(Map<String, String> ignored) {
        // Token refresh is handled by onNewToken; the service deliberately does not
        // trigger token retrieval on every call notification.
        return "";
    }

    static void refreshTokenRegistration(Context context) {
        try {
            if (FirebaseApp.getApps(context).isEmpty()) return;
            com.google.firebase.messaging.FirebaseMessaging.getInstance().getToken()
                .addOnSuccessListener(token -> OnlyUsBackend.registerPhoneToken(context, token))
                .addOnFailureListener(error ->
                    Log.w(TAG, "Could not retrieve FCM token: " + error.getMessage()));
        } catch (Exception error) {
            Log.w(TAG, "Firebase is not configured yet: " + error.getMessage());
        }
    }
}
