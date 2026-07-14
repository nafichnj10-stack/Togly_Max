package com.trinityx.togetherly

import android.appwidget.AppWidgetManager
import android.content.BroadcastReceiver
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.util.Log
import com.google.firebase.auth.FirebaseAuth
import com.google.firebase.firestore.FirebaseFirestore

// ✅ client feedback item 5: LoveBuddyLiveService love_sent state দেখলে ঠিক
// ৩০ মিনিট পরের জন্য একটা alarm সিডিউল করে (দেখুন scheduleLoveStateRefresh)।
// সেই alarm ফায়ার হলে এখানে সরাসরি Firestore থেকে একবার fresh ডেটা টেনে
// widget_state আপডেট করে দেওয়া হয় — কোনো live listener বা app-open-এর উপর
// নির্ভর না করে সরাসরি নিশ্চিত করা হচ্ছে যে ৩০ মিনিট পরে widget আগের সঠিক
// state-এ ফিরে যাবে।
class LoveStateRefreshReceiver : BroadcastReceiver() {

    companion object {
        private const val TAG = "LoveStateRefreshReceiver"
    }

    override fun onReceive(context: Context, intent: Intent) {
        val appContext = context.applicationContext
        val uid = FirebaseAuth.getInstance().currentUser?.uid
        if (uid == null) {
            Log.w(TAG, "No signed-in user, skipping 30-min refresh")
            return
        }

        val pendingResult = goAsync()

        FirebaseFirestore.getInstance().collection("relationship_views").document(uid).get()
            .addOnSuccessListener { snapshot ->
                val data = snapshot?.data
                if (data != null) {
                    val rawKey = data["widget_background_key"] as? String ?: "normal"
                    val resolvedState = WidgetStateResolver.resolve(rawKey, data, uid)
                    val prefs = appContext.getSharedPreferences("togly_prefs", Context.MODE_PRIVATE)
                    prefs.edit().putString("widget_state", resolvedState).apply()
                    Log.d(TAG, "30-min refresh: widget_state -> $resolvedState")
                    refreshAllWidgets(appContext)
                }
                pendingResult.finish()
            }
            .addOnFailureListener { e ->
                Log.e(TAG, "30-min refresh fetch failed: ${e.message}")
                pendingResult.finish()
            }
    }

    private fun refreshAllWidgets(context: Context) {
        val appWidgetManager = AppWidgetManager.getInstance(context)
        val componentName = ComponentName(context, ToglyWidgetProvider::class.java)
        val widgetIds = appWidgetManager.getAppWidgetIds(componentName)
        for (widgetId in widgetIds) {
            ToglyWidgetProvider.updateWidget(context, appWidgetManager, widgetId)
        }
    }
}
