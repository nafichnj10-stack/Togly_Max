package com.trinityx.togetherly

import android.appwidget.AppWidgetManager
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.os.Handler
import android.os.Looper
import android.util.Log
import android.widget.Toast
import com.google.firebase.auth.FirebaseAuth
import com.google.firebase.functions.FirebaseFunctions

// ✅ script item 5 + 5.1: Widget-এর "Send Love" / "Birthday Wish" বাটনে ট্যাপ করলে
// এখন আগে Cloud Function কল হয়, রেসপন্স আসার পরে:
//   • সফল হলে (ok == true): animation চলবে + "Love sent to your partner 💜" Toast
//   • ব্যর্থ হলে (cooldown/daily-limit/other): animation চলবে না, বরং
//     সার্ভারের real message অনুযায়ী Toast (যেমন "wait X min")
// sendSilentCheckIn Cloud Function relationshipId চায় না — context.auth.uid
// থেকেই নিজে বের করে নেয়। love_sent state ৩০ মিনিট পর নিজে থেকেই আগের
// state-এ ফিরে যায় (sync_love_buddy_travel_cron.js প্রতি ১৫ মিনিটে রিফ্রেশ করে)।
class SendLoveReceiver : BroadcastReceiver() {

    companion object {
        private const val TAG = "SendLoveReceiver"
        private const val REGION = "europe-west3"
    }

    override fun onReceive(context: Context, intent: Intent) {
        val widgetId = intent.getIntExtra(AppWidgetManager.EXTRA_APPWIDGET_ID, -1)
        val appContext = context.applicationContext
        val pendingResult = goAsync()

        val prefs = appContext.getSharedPreferences("togly_prefs", Context.MODE_PRIVATE)
        val widgetState = prefs.getString("widget_state", "normal") ?: "normal"
        val loveType = if (widgetState.startsWith("birthday")) "birthday" else "normal"

        if (FirebaseAuth.getInstance().currentUser == null) {
            showToast(appContext, "Please open the app and sign in first.")
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
                showToast(appContext, "Couldn't send love — please check your connection and try again.")
                pendingResult.finish()
            }
    }

    private fun handleResponse(context: Context, widgetId: Int, data: Map<String, Any?>) {
        val ok = data["ok"] == true
        val code = data["code"] as? String ?: ""
        val waitMinutes = (data["waitMinutes"] as? Number)?.toInt() ?: 0

        if (ok) {
            // ✅ শুধু সফল হলেই animation চলবে
            showToast(context, "Love sent to your partner 💜")
            SendLoveAnimator.play(context, widgetId)
        } else {
            val message = when (code) {
                "COOLDOWN" -> if (waitMinutes > 0) {
                    "You can send love again in $waitMinutes min ⏳"
                } else {
                    "Please wait a bit before sending again ⏳"
                }
                "DAILY_LIMIT" -> "You've reached today's Send Love limit 💜"
                "NO_REL_VIEW" -> "Couldn't find your relationship — please open the app."
                else -> (data["message"] as? String)?.takeIf { it.isNotBlank() }
                    ?: "Couldn't send love right now — please try again."
            }
            showToast(context, message)
        }
    }

    private fun showToast(context: Context, message: String) {
        Handler(Looper.getMainLooper()).post {
            Toast.makeText(context, message, Toast.LENGTH_LONG).show()
        }
    }
}
