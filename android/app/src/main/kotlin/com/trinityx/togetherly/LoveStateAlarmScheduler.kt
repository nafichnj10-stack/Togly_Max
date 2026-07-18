package com.trinityx.togetherly

import android.app.AlarmManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.os.Build
import android.util.Log

// ✅ Task 4 ফিক্স: আগে LoveBuddyLiveService আর SendLoveReceiver — দুই জায়গা
// থেকে আলাদাভাবে (কিন্তু একই requestCode 5001 দিয়ে) alarm schedule করা হতো,
// যেটা race condition তৈরি করতে পারত। এখন দুটোই এই একই shared object
// ব্যবহার করে।
//
// ✅ আসল বাগ: Android 12+ (API 31+) এ শুধু ম্যানিফেস্টে SCHEDULE_EXACT_ALARM
// permission ঘোষণা করলেই যথেষ্ট না — ইউজারকে আলাদাভাবে Settings থেকে
// "Alarms & reminders" অনুমতি ম্যানুয়ালি দিতে হয় (canScheduleExactAlarms()
// == false)। এই অনুমতি না থাকলে exact alarm silently ব্যর্থ হয়ে normal
// (inexact) alarm-এ fallback করে, যেটা Doze mode-এ অনেক দেরিতে (কখনো ঘন্টার
// পর ঘন্টা, বা যতক্ষণ না app foreground-এ আসে) ফায়ার হয় — এটাই "৩০ মিনিট
// পরে widget একা একা আগের state-এ ফেরে না" বাগের সবচেয়ে সম্ভাব্য কারণ।
object LoveStateAlarmScheduler {

    private const val TAG = "LoveStateAlarmScheduler"
    private const val REQUEST_CODE = 5001
    private const val BUFFER_MS = 5000L
    private const val THIRTY_MIN_MS = 30 * 60 * 1000L

    // lastSentAtMs না দিলে (SendLoveReceiver থেকে কল হলে) এখনকার সময় থেকে গোনা হয়
    fun schedule(context: Context, lastSentAtMs: Long?) {
        val baseTime = lastSentAtMs ?: System.currentTimeMillis()
        val triggerAtMs = baseTime + THIRTY_MIN_MS + BUFFER_MS

        if (triggerAtMs <= System.currentTimeMillis()) {
            Log.d(TAG, "Trigger time already passed — skipping schedule, next Firestore snapshot will correct state")
            return
        }

        val appContext = context.applicationContext
        val alarmManager = appContext.getSystemService(Context.ALARM_SERVICE) as? AlarmManager
        if (alarmManager == null) {
            Log.e(TAG, "AlarmManager unavailable — cannot schedule 30-min refresh")
            return
        }

        val intent = Intent(appContext, LoveStateRefreshReceiver::class.java)
        val pendingIntent = PendingIntent.getBroadcast(
            appContext, REQUEST_CODE, intent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        )

        val canScheduleExact = hasExactAlarmPermission(appContext)
        if (!canScheduleExact) {
            Log.w(
                TAG,
                "Exact alarm permission NOT granted — falling back to inexact alarm, " +
                    "which Doze mode can delay significantly. User needs to grant " +
                    "'Alarms & reminders' permission in system Settings for reliable auto-revert."
            )
        }

        try {
            if (canScheduleExact) {
                alarmManager.setExactAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, triggerAtMs, pendingIntent)
                Log.d(TAG, "Exact alarm scheduled for $triggerAtMs")
            } else {
                alarmManager.set(AlarmManager.RTC_WAKEUP, triggerAtMs, pendingIntent)
                Log.d(TAG, "Inexact alarm scheduled for $triggerAtMs (fallback — permission missing)")
            }
        } catch (e: SecurityException) {
            Log.e(TAG, "SecurityException scheduling exact alarm, falling back to inexact: ${e.message}")
            alarmManager.set(AlarmManager.RTC_WAKEUP, triggerAtMs, pendingIntent)
        }
    }

    // Flutter/MainActivity থেকে চেক করার জন্য — false এলে ইউজারকে Settings-এ
    // পাঠানো দরকার (openExactAlarmSettings ব্যবহার করে, MainActivity.kt দেখুন)
    fun hasExactAlarmPermission(context: Context): Boolean {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.S) return true
        val alarmManager = context.getSystemService(Context.ALARM_SERVICE) as? AlarmManager ?: return false
        return alarmManager.canScheduleExactAlarms()
    }
}
