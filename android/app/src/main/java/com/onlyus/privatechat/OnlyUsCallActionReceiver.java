package com.onlyus.privatechat;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;

public final class OnlyUsCallActionReceiver extends BroadcastReceiver {
    public static final String ACTION_DECLINE = "com.onlyus.privatechat.action.DECLINE_PUSH_CALL";
    public static final String ACTION_ANSWER = "com.onlyus.privatechat.action.ANSWER_PUSH_CALL";
    public static final String EXTRA_CALL_ID = "onlyus.callId";
    public static final String EXTRA_CALLER = "onlyus.caller";
    private static final String PREFS = "onlyus.pending-call";

    @Override
    public void onReceive(Context context, Intent intent) {
        if (intent == null) return;
        String callId = intent.getStringExtra(EXTRA_CALL_ID);
        String caller = intent.getStringExtra(EXTRA_CALLER);
        if (ACTION_DECLINE.equals(intent.getAction())) {
            SharedPreferences prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
            if (callId == null || !callId.equals(prefs.getString("activePushCallId", ""))) return;
            prefs.edit().remove("activePushCallId").remove("activePushCaller").apply();
            OnlyUsBackend.sendCallEvent(context, "rejected", callId);
            OnlyUsService.callEnded(context);
            return;
        }
        if (ACTION_ANSWER.equals(intent.getAction())) {
            SharedPreferences prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
            prefs.edit()
                .putString("pendingCallId", callId == null ? "" : callId)
                .putString("pendingCaller", caller == null ? "Your partner" : caller)
                .putBoolean("answerNextCall", true)
                .apply();
            OnlyUsBackend.sendCallEvent(context, "accepted", callId);
            Intent open = new Intent(context, MainActivity.class);
            open.setAction(ACTION_ANSWER);
            open.putExtra(EXTRA_CALL_ID, callId);
            open.putExtra(EXTRA_CALLER, caller);
            open.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_CLEAR_TOP | Intent.FLAG_ACTIVITY_SINGLE_TOP);
            context.startActivity(open);
        }
    }

    static boolean consumeAnswerFor(Context context, String callId) {
        SharedPreferences prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
        String expected = prefs.getString("pendingCallId", "");
        boolean pending = prefs.getBoolean("answerNextCall", false)
            && expected != null && !expected.isEmpty() && expected.equals(callId);
        if (pending) prefs.edit().remove("pendingCallId").remove("pendingCaller").putBoolean("answerNextCall", false).apply();
        return pending;
    }
}
