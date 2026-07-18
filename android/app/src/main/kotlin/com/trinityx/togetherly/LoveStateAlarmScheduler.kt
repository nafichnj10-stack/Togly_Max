package com.trinityx.togetherly

import android.app.AlarmManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.os.Build
import android.util.Log

object LoveStateAlarmScheduler {

    private const val TAG = "LoveStateAlarmScheduler"
    private const val REQUEST_CODE = 5001
    private const val BUFFER_MS = 5000L
    private const val THIRTY_MIN_MS = 30 * 60 * 1000L

    fun schedule(context: Context, lastSentAtMs: Long?) {
        val baseTime = lastSentAtMs ?: System.currentTimeMillis()
        val triggerAtMs = baseTime + THIRTY_MIN_MS + BUFFER_MS

        if (triggerAtMs <= System.currentTimeMillis()) {
            Log.d(TAG, "Trigger time already passed — skipping schedule")
            return
        }

        val appContext = context.applicationContext
        val alarmManager = appContext.getSystemService(Context.ALARM_SERVICE) as? AlarmManager
        if (alarmManager == null) {
            Log.e(TAG, "AlarmManager unavailable")
            return
        }

        val intent = Intent(appContext, LoveStateRefreshReceiver::class.java)
        val pendingIntent = PendingIntent.getBroadcast(
            appContext, REQUEST_CODE, intent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        )

        val canScheduleExact = hasExactAlarmPermission(appContext)
        if (!canScheduleExact) {
            Log.w(TAG, "Exact alarm permission NOT granted — falling back to inexact alarm")
        }

        try {
            if (canScheduleExact) {
                alarmManager.setExactAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, triggerAtMs, pendingIntent)
            } else {
                alarmManager.set(AlarmManager.RTC_WAKEUP, triggerAtMs, pendingIntent)
            }
        } catch (e: SecurityException) {
            Log.e(TAG, "SecurityException scheduling exact alarm, falling back: ${e.message}")
            alarmManager.set(AlarmManager.RTC_WAKEUP, triggerAtMs, pendingIntent)
        }
    }

    fun hasExactAlarmPermission(context: Context): Boolean {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.S) return true
        val alarmManager = context.getSystemService(Context.ALARM_SERVICE) as? AlarmManager ?: return false
        return alarmManager.canScheduleExactAlarms()
    }
}
