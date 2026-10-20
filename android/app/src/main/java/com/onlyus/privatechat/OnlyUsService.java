package com.onlyus.privatechat;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Person;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.media.AudioAttributes;
import android.media.Ringtone;
import android.media.RingtoneManager;
import android.net.Uri;
import android.os.Build;
import android.os.IBinder;
import android.os.Handler;
import android.os.Looper;
import android.os.PowerManager;
import android.provider.Settings;

public final class OnlyUsService extends Service {
    public static final String ACTION_RING = "com.onlyus.privatechat.action.RING";
    public static final String ACTION_STOP_RING = "com.onlyus.privatechat.action.STOP_RING";

    private static final String CHANNEL_SERVICE = "onlyus_connection";
    private static final String CHANNEL_CALLS = "onlyus_calls_v2";
    private static final int SERVICE_NOTIFICATION_ID = 7401;
    private static final int CALL_NOTIFICATION_ID = 7402;

    private PowerManager.WakeLock wakeLock;
    private Ringtone activeRingtone;
    private final Handler mainHandler = new Handler(Looper.getMainLooper());

    public static void start(Context context) {
        Intent intent = new Intent(context, OnlyUsService.class);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            context.startForegroundService(intent);
        } else {
            context.startService(intent);
        }
    }

    public static void incomingCall(Context context) {
        incomingCall(context, null, "Your partner");
    }

    public static void incomingCall(Context context, String callId, String caller) {
        Intent intent = new Intent(context, OnlyUsService.class);
        intent.setAction(ACTION_RING);
        if (callId != null) intent.putExtra(OnlyUsCallActionReceiver.EXTRA_CALL_ID, callId);
        if (caller != null) intent.putExtra(OnlyUsCallActionReceiver.EXTRA_CALLER, caller);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) context.startForegroundService(intent);
        else context.startService(intent);
    }

    public static void callEnded(Context context) {
        Intent intent = new Intent(context, OnlyUsService.class);
        intent.setAction(ACTION_STOP_RING);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) context.startForegroundService(intent);
        else context.startService(intent);
    }

    @Override
    public void onCreate() {
        super.onCreate();
        createChannels();
        acquireWakeLock();
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        startAsForeground();
        String action = intent == null ? null : intent.getAction();
        if (ACTION_RING.equals(action)) {
            showIncomingCall(
                intent == null ? null : intent.getStringExtra(OnlyUsCallActionReceiver.EXTRA_CALL_ID),
                intent == null ? null : intent.getStringExtra(OnlyUsCallActionReceiver.EXTRA_CALLER)
            );
        } else if (ACTION_STOP_RING.equals(action)) {
            cancelIncomingCall();
        }
        return START_STICKY;
    }

    private void createChannels() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return;
        NotificationManager manager = getSystemService(NotificationManager.class);
        if (manager == null) return;

        NotificationChannel serviceChannel = new NotificationChannel(
            CHANNEL_SERVICE, "Only Us connection", NotificationManager.IMPORTANCE_LOW);
        serviceChannel.setDescription("Keeps your private Only Us connection available.");
        serviceChannel.setShowBadge(false);
        manager.createNotificationChannel(serviceChannel);

        NotificationChannel callChannel = new NotificationChannel(
            CHANNEL_CALLS, "Only Us incoming calls", NotificationManager.IMPORTANCE_HIGH);
        callChannel.setDescription("Rings for incoming Only Us voice calls.");
        Uri ringtone = RingtoneManager.getDefaultUri(RingtoneManager.TYPE_RINGTONE);
        AudioAttributes audio = new AudioAttributes.Builder()
            .setUsage(AudioAttributes.USAGE_NOTIFICATION_RINGTONE)
            .setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION)
            .build();
        // Native Ringtone playback below loops using the phone's actual ringtone volume.
        // Use a fresh, silent notification channel so it does not double-play a one-shot sound.
        callChannel.setSound(null, null);
        callChannel.enableVibration(true);
        callChannel.setVibrationPattern(new long[] {0, 600, 300, 600, 500, 600});
        manager.createNotificationChannel(callChannel);
    }

    private PendingIntent openAppIntent() {
        Intent open = new Intent(this, MainActivity.class);
        open.setFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP | Intent.FLAG_ACTIVITY_CLEAR_TOP);
        return PendingIntent.getActivity(this, 7401, open,
            PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
    }

    private Notification buildServiceNotification() {
        return new Notification.Builder(this, CHANNEL_SERVICE)
            .setSmallIcon(R.drawable.ic_onlyus)
            .setContentTitle("Only Us is active")
            .setContentText("Private chat is staying connected.")
            .setContentIntent(openAppIntent())
            .setCategory(Notification.CATEGORY_SERVICE)
            .setOngoing(true)
            .setShowWhen(false)
            .build();
    }

    private void startAsForeground() {
        Notification notification = buildServiceNotification();
        if (Build.VERSION.SDK_INT >= 34) {
            startForeground(SERVICE_NOTIFICATION_ID, notification,
                android.content.pm.ServiceInfo.FOREGROUND_SERVICE_TYPE_REMOTE_MESSAGING);
        } else {
            startForeground(SERVICE_NOTIFICATION_ID, notification);
        }
    }

    private PendingIntent callActionIntent(String action, String callId, String caller, int requestCode) {
        if (OnlyUsCallActionReceiver.ACTION_ANSWER.equals(action)) {
            Intent intent = new Intent(this, MainActivity.class);
            intent.setAction(action);
            intent.setFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_CLEAR_TOP | Intent.FLAG_ACTIVITY_SINGLE_TOP);
            if (callId != null) intent.putExtra(OnlyUsCallActionReceiver.EXTRA_CALL_ID, callId);
            if (caller != null) intent.putExtra(OnlyUsCallActionReceiver.EXTRA_CALLER, caller);
            return PendingIntent.getActivity(this, requestCode, intent,
                PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
        }

        Intent intent = new Intent(this, OnlyUsCallActionReceiver.class);
        intent.setAction(action);
        if (callId != null) intent.putExtra(OnlyUsCallActionReceiver.EXTRA_CALL_ID, callId);
        if (caller != null) intent.putExtra(OnlyUsCallActionReceiver.EXTRA_CALLER, caller);
        return PendingIntent.getBroadcast(this, requestCode, intent,
            PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
    }

    private void showIncomingCall(String callId, String caller) {
        String callerName = (caller == null || caller.trim().isEmpty()) ? "Your partner" : caller;
        PendingIntent answerIntent = callActionIntent(
            OnlyUsCallActionReceiver.ACTION_ANSWER, callId, callerName, 7403);
        PendingIntent declineIntent = callActionIntent(
            OnlyUsCallActionReceiver.ACTION_DECLINE, callId, callerName, 7404);

        Notification.Builder builder = new Notification.Builder(this, CHANNEL_CALLS)
            .setSmallIcon(R.drawable.ic_onlyus)
            .setContentTitle("Only Us · Incoming call")
            .setContentText(callerName + " is calling. Tap to answer.")
            .setContentIntent(openAppIntent())
            .setCategory(Notification.CATEGORY_CALL)
            .setVisibility(Notification.VISIBILITY_PUBLIC)
            .setAutoCancel(true)
            .setOnlyAlertOnce(false)
            .setWhen(System.currentTimeMillis());

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            Person person = new Person.Builder().setName(callerName).setImportant(true).build();
            builder.setStyle(Notification.CallStyle.forIncomingCall(person, declineIntent, answerIntent));
        } else {
            builder.addAction(new Notification.Action.Builder(
                android.R.drawable.ic_menu_call, "Answer", answerIntent).build());
            builder.addAction(new Notification.Action.Builder(
                android.R.drawable.ic_menu_close_clear_cancel, "Decline", declineIntent).build());
        }

        NotificationManager manager = getSystemService(NotificationManager.class);
        if (manager != null) {
            if (Build.VERSION.SDK_INT < 34 || manager.canUseFullScreenIntent()) {
                builder.setFullScreenIntent(openAppIntent(), true);
            }
            manager.notify(CALL_NOTIFICATION_ID, builder.build());
        }
        startNativeRingtone();
    }

    private void startNativeRingtone() {
        stopNativeRingtone();
        try {
            Uri uri = RingtoneManager.getDefaultUri(RingtoneManager.TYPE_RINGTONE);
            if (uri == null) uri = RingtoneManager.getDefaultUri(RingtoneManager.TYPE_NOTIFICATION);
            if (uri == null) return;
            activeRingtone = RingtoneManager.getRingtone(getApplicationContext(), uri);
            if (activeRingtone == null) return;
            AudioAttributes attributes = new AudioAttributes.Builder()
                .setUsage(AudioAttributes.USAGE_NOTIFICATION_RINGTONE)
                .setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION)
                .build();
            activeRingtone.setAudioAttributes(attributes);
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
                activeRingtone.setLooping(true);
            }
            activeRingtone.play();
        } catch (Exception error) {
            android.util.Log.w("OnlyUsService", "Native ringtone could not start", error);
        }
    }

    private void stopNativeRingtone() {
        if (activeRingtone != null) {
            try { activeRingtone.stop(); } catch (Exception ignored) {}
            activeRingtone = null;
        }
    }

    private void cancelIncomingCall() {
        stopNativeRingtone();
        NotificationManager manager = getSystemService(NotificationManager.class);
        if (manager != null) manager.cancel(CALL_NOTIFICATION_ID);
    }

    private void acquireWakeLock() {
        try {
            PowerManager power = (PowerManager) getSystemService(POWER_SERVICE);
            if (power == null) return;
            wakeLock = power.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "OnlyUs:Connection");
            wakeLock.setReferenceCounted(false);
            if (!wakeLock.isHeld()) wakeLock.acquire();
        } catch (Exception error) {
            android.util.Log.w("OnlyUsService", "Could not acquire connection wake lock", error);
        }
    }

    @Override
    public void onTaskRemoved(Intent rootIntent) {
        // Recents swipe must not stop the signaling foreground service.
        // The service and wake lock remain active while the app UI is detached.
        super.onTaskRemoved(rootIntent);
    }

    @Override
    public void onDestroy() {
        mainHandler.removeCallbacksAndMessages(null);
        cancelIncomingCall();
        if (wakeLock != null && wakeLock.isHeld()) {
            try { wakeLock.release(); } catch (Exception ignored) {}
        }
        wakeLock = null;
        super.onDestroy();
    }

    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }
}
