package com.trinityx.togetherly

import android.app.NotificationChannel
import android.app.NotificationManager
import android.appwidget.AppWidgetManager
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.graphics.BitmapFactory
import android.os.Build
import android.util.Log
import androidx.core.app.NotificationCompat
import com.google.firebase.auth.FirebaseAuth
import com.google.firebase.functions.FirebaseFunctions

// ✅ script item 5 + 5.1 + client feedback item 3 & 6:
// Widget-এর "Send Love" / "Birthday Wish" বাটনে ট্যাপ করলে আগে Cloud Function
// কল হয়, রেসপন্স আসার পরে:
//   • সফল হলে (ok == true): animation চলবে + Cloud Function-এর localized
//     `snackText` (en/de/es, ইউজারের appLanguage অনুযায়ী) একটা ছোট
//     confirmation Notification-এ দেখানো হয়
//   • ব্যর্থ হলে (cooldown/daily-limit/other): animation চলবে না, সার্ভারের
//     real localized message দেখানো হয়
// প্লেইন Toast-এর বদলে Notification ব্যবহার করা হচ্ছে কারণ Toast-এ কাস্টম আইকন
// (Togly logo) modern Android-এ (12+) reliably দেখানো যায় না — Notification-এ
// largeIcon হিসেবে Togly-এর আসল লোগো দেখানো যায়, তাই ডিফল্ট Flutter আইকনের
// বদলে এখন Togly branding দেখাবে।
class SendLoveReceiver : BroadcastReceiver() {

    companion object {
        private const val TAG = "SendLoveReceiver"
        private const val REGION = "europe-west3"
        private const val CHANNEL_ID = "togly_send_love_feedback"
        private const val NOTIFICATION_ID = 2001
    }

    override fun onReceive(context: Context, intent: Intent) {
        val widgetId = intent.getIntExtra(AppWidgetManager.EXTRA_APPWIDGET_ID, -1)
        val appContext = context.applicationContext
        val pendingResult = goAsync()

        val prefs = appContext.getSharedPreferences("togly_prefs", Context.MODE_PRIVATE)
        val widgetState = prefs.getString("widget_state", "normal") ?: "normal"
        val loveType = if (widgetState.startsWith("birthday")) "birthday" else "normal"

        if (FirebaseAuth.getInstance().currentUser == null) {
            showFeedback(appContext, "Please open the app and sign in first.")
            pendingResult.finish()
            return
        }

        val data = hashMapOf("mode" to "send", "type" to loveType)

        FirebaseFunctions.getInstance(REGION)
            .getHttpsCallable("sendSilentCheckIn")
            .call(data)
            .addOnSuccessListener { result ->
                @Suppress("UNCHECKED_CAST")
                val response = result.data as? Map<String, Any?> ?: emptyMap()
                handleResponse(appContext, widgetId, response)
                pendingResult.finish()
            }
            .addOnFailureListener { e ->
                Log.e(TAG, "sendSilentCheckIn failed: ${e.message}")
                showFeedback(appContext, "Couldn't send love — please check your connection and try again.")
                pendingResult.finish()
            }
    }

    private fun handleResponse(context: Context, widgetId: Int, data: Map<String, Any?>) {
        val ok = data["ok"] == true
        val code = data["code"] as? String ?: ""
        val waitMinutes = (data["waitMinutes"] as? Number)?.toInt() ?: 0

        // ✅ client feedback item 3: Cloud Function-এর localized snackText-ই আগে
        // ব্যবহার করা হচ্ছে (en/de/es) — নিজের হার্ডকোড করা ইংরেজি টেক্সট শুধু
        // snackText না থাকলে (edge-case fallback হিসেবে) ব্যবহার হবে
        val serverSnackText = (data["snackText"] as? String)?.takeIf { it.isNotBlank() }

        if (ok) {
            showFeedback(context, serverSnackText ?: "Love sent to your partner 💜")
            // ✅ শুধু সফল হলেই animation চলবে
            SendLoveAnimator.play(context, widgetId)
            // ✅ Love Sent state auto-revert fix: এখানেই সরাসরি ৩০-মিনিটের রিফ্রেশ
            // alarm সিডিউল করা হচ্ছে, কারণ LoveBuddyLiveService তখনই চলে যখন app
            // খোলা থাকে — কিন্তু widget-এর Send Love ট্যাপ app বন্ধ থাকলেও কাজ করে।
            // তাই app না খুলেও ঠিক ৩০ মিনিট পরে widget নিজে থেকেই normal/আগের
            // state-এ ফিরে আসবে।
            scheduleLoveStateRefresh(context)
        } else {
            val fallback = when (code) {
                "COOLDOWN" -> if (waitMinutes > 0) {
                    "You can send love again in $waitMinutes min ⏳"
                } else {
                    "Please wait a bit before sending again ⏳"
                }
                "DAILY_LIMIT" -> "You've reached today's Send Love limit 💜"
                "NO_REL_VIEW" -> "Couldn't find your relationship — please open the app."
                else -> "Couldn't send love right now — please try again."
            }
            showFeedback(context, serverSnackText ?: fallback)
        }
    }

    // ✅ Love Sent state auto-revert fix: Send Love ট্যাপ হওয়ার সাথে সাথেই
    // (app খোলা থাক বা না থাক) সরাসরি এখান থেকে exact, Doze-safe one-shot
    // alarm সিডিউল করা হয় — যাতে ৩০ মিনিট পরে widget নিজে নিজেই আগের/normal
    // state-এ ফিরে আসে, app open করার উপর নির্ভর করতে হয় না।
    private fun scheduleLoveStateRefresh(context: Context) {
        val triggerAtMs = System.currentTimeMillis() + 30 * 60 * 1000L + 5000L
        val alarmManager = context.getSystemService(Context.ALARM_SERVICE) as? android.app.AlarmManager ?: return
        val intent = Intent(context, LoveStateRefreshReceiver::class.java)
        val pendingIntent = android.app.PendingIntent.getBroadcast(
            context, 5001, intent,
            android.app.PendingIntent.FLAG_UPDATE_CURRENT or android.app.PendingIntent.FLAG_IMMUTABLE
        )
        try {
            alarmManager.setExactAndAllowWhileIdle(android.app.AlarmManager.RTC_WAKEUP, triggerAtMs, pendingIntent)
        } catch (e: SecurityException) {
            alarmManager.set(android.app.AlarmManager.RTC_WAKEUP, triggerAtMs, pendingIntent)
        }
    }

    private fun showFeedback(context: Context, message: String) {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            val manager = context.getSystemService(NotificationManager::class.java)
            val channel = NotificationChannel(
                CHANNEL_ID, "Send Love feedback", NotificationManager.IMPORTANCE_HIGH
            )
            manager?.createNotificationChannel(channel)
        }

        val largeIcon = try {
            BitmapFactory.decodeResource(context.resources, R.drawable.ic_togly_notify)
        } catch (e: Exception) {
            null
        }

        val builder = NotificationCompat.Builder(context, CHANNEL_ID)
            .setContentTitle("Togly")
            .setContentText(message)
            .setStyle(NotificationCompat.BigTextStyle().bigText(message))
            .setSmallIcon(context.applicationInfo.icon)
            .setPriority(NotificationCompat.PRIORITY_HIGH)
            .setAutoCancel(true)
            .setTimeoutAfter(6000)

        if (largeIcon != null) {
            builder.setLargeIcon(largeIcon)
        }

        androidx.core.app.NotificationManagerCompat.from(context)
            .notify(NOTIFICATION_ID, builder.build())
    }
}
