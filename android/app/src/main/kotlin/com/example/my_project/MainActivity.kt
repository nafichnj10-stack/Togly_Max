package com.trinityx.togetherly

import android.appwidget.AppWidgetManager
import android.content.ComponentName
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.provider.Settings
import com.google.firebase.auth.FirebaseAuth
import io.flutter.embedding.android.FlutterFragmentActivity
import io.flutter.embedding.engine.FlutterEngine
import io.flutter.plugin.common.MethodChannel

// ✅ এই চ্যানেলটাই মূল Togly Flutter অ্যাপ আর নেটিভ Home-Screen Widget-এর মধ্যে
// সেতু। এখন বেশিরভাগ কাজ (সার্ভিস চালু করা, pin-popup দেখানো) নেটিভভাবেই
// automatically হয়ে যায় — Flutter/FlutterFlow সাইডে আলাদা করে কিছু কল করার
// দরকার নেই। এই চ্যানেলটা শুধু ঐচ্ছিক ম্যানুয়াল কন্ট্রোলের জন্য রাখা হয়েছে
// (যেমন লগআউটে সাথে সাথে সার্ভিস বন্ধ করতে চাইলে)।
class MainActivity : FlutterFragmentActivity() {

    private val CHANNEL = "com.trinityx.togetherly/love_buddy_widget"

    // pin-request একসাথে একাধিকবার/দ্রুত succession-এ ট্রিগার হওয়া ঠেকাতে
    private var pinRequestInFlight = false

    // ✅ FIX: LoveBuddyLiveService আগে কখনো চালু হতো না (কোনো Dart action flow
    // থেকে কল করা হতো না) — এখন অ্যাপ চালু হওয়ার সাথে সাথেই নেটিভভাবে চালু হয়ে
    // যায়, কোনো manual wiring লাগে না।
    // ✅ NEW: paused/not_connected state-এ widget-এ ট্যাপ করলে app খোলার সাথে
    // সাথে নির্দিষ্ট route (Restore/Connect)-এ পাঠানোর জন্য — ToglyWidgetProvider
    // Intent-এ "pending_route" extra দেয়, এখানে সেটা ধরে SharedPreferences-এ
    // সেভ রাখা হয়, Dart side পরে "getPendingWidgetRoute" কল করে সেটা নিয়ে যায়।
    override fun onCreate(savedInstanceState: android.os.Bundle?) {
        super.onCreate(savedInstanceState)
        startForegroundServiceCompat(Intent(this, LoveBuddyLiveService::class.java))
        capturePendingRoute(intent)
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        capturePendingRoute(intent)
    }

    private fun capturePendingRoute(intent: Intent?) {
        val route = intent?.getStringExtra("pending_route") ?: return
        getSharedPreferences("togly_prefs", MODE_PRIVATE)
            .edit()
            .putString("pending_widget_route", route)
            .apply()
    }

    // ✅ NEW: অ্যাপ প্রতিবার foreground-এ আসার সময় (মানে লগইন করে হোম পেজে ঢোকা
    // সহ যেকোনো navigation-এর পর) চেক করে — ইউজার লগইন করা আছে কিনা, আর
    // widget ইতিমধ্যে হোমস্ক্রিনে পিন করা আছে কিনা। যদি লগইন করা থাকে কিন্তু
    // widget পিন করা না থাকে (একবারও add করা হয়নি, অথবা আগে add করা হলেও পরে
    // রিমুভ করে দেওয়া হয়েছে), তাহলে সিস্টেম "Add to Home Screen" popup
    // automatically দেখানো হয়। একবার add হয়ে গেলে widget count > 0 হয়ে যায়,
    // তাই পরবর্তীতে আর popup আসবে না — ঠিক যেভাবে চাওয়া হয়েছে।
    override fun onResume() {
        super.onResume()
        maybePromptToAddWidget()
    }

    private fun maybePromptToAddWidget() {
        if (pinRequestInFlight) return
        if (FirebaseAuth.getInstance().currentUser == null) return // লগইন না থাকলে popup দেখানো হবে না

        val appWidgetManager = AppWidgetManager.getInstance(this)
        val provider = ComponentName(this, ToglyWidgetProvider::class.java)
        val existingWidgetIds = appWidgetManager.getAppWidgetIds(provider)

        if (existingWidgetIds.isNotEmpty()) return // widget আগে থেকেই যোগ করা আছে, popup দরকার নেই

        if (appWidgetManager.isRequestPinAppWidgetSupported) {
            pinRequestInFlight = true
            appWidgetManager.requestPinAppWidget(provider, null, null)
            // সিস্টেম ডায়ালগ দেখানোর জন্য যথেষ্ট সময় দেওয়া হচ্ছে, তারপর ফ্ল্যাগ রিসেট
            android.os.Handler(mainLooper).postDelayed({ pinRequestInFlight = false }, 3000)
        }
    }

    override fun configureFlutterEngine(flutterEngine: FlutterEngine) {
        super.configureFlutterEngine(flutterEngine)

        MethodChannel(flutterEngine.dartExecutor.binaryMessenger, CHANNEL).setMethodCallHandler { call, result ->
            when (call.method) {
                "startWidgetSync" -> {
                    startForegroundServiceCompat(Intent(this, LoveBuddyLiveService::class.java))
                    result.success(true)
                }
                "stopWidgetSync" -> {
                    stopService(Intent(this, LoveBuddyLiveService::class.java))
                    result.success(true)
                }
                "startLocationTracking" -> {
                    startForegroundServiceCompat(Intent(this, LoveBuddyLocationService::class.java))
                    result.success(true)
                }
                "stopLocationTracking" -> {
                    stopService(Intent(this, LoveBuddyLocationService::class.java))
                    result.success(true)
                }
                "requestPinWidget" -> {
                    result.success(requestPinWidget())
                }
                "getPendingWidgetRoute" -> {
                    val prefs = getSharedPreferences("togly_prefs", MODE_PRIVATE)
                    val route = prefs.getString("pending_widget_route", null)
                    if (route != null) {
                        prefs.edit().remove("pending_widget_route").apply()
                    }
                    result.success(route)
                }
                // ✅ Task 4 ফিক্স: Flutter সাইড থেকে চেক করার জন্য — false এলে
                // ইউজারকে বোঝাতে হবে কেন Send Love-এর ৩০ মিনিটের auto-revert
                // কাজ নাও করতে পারে, এবং openExactAlarmSettings দিয়ে সরাসরি
                // Settings-এ পাঠানো যাবে।
                "hasExactAlarmPermission" -> {
                    result.success(LoveStateAlarmScheduler.hasExactAlarmPermission(this))
                }
                "openExactAlarmSettings" -> {
                    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
                        val intent = Intent(Settings.ACTION_REQUEST_SCHEDULE_EXACT_ALARM).apply {
                            data = Uri.parse("package:$packageName")
                        }
                        startActivity(intent)
                        result.success(true)
                    } else {
                        result.success(false)
                    }
                }
                else -> result.notImplemented()
            }
        }
    }

    private fun startForegroundServiceCompat(intent: Intent) {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            startForegroundService(intent)
        } else {
            startService(intent)
        }
    }

    // ম্যানুয়াল ট্রিগারের জন্য এখনো রাখা হলো (যেমন সেটিংস পেজে "Re-add widget" বাটন থাকলে)
    private fun requestPinWidget(): Boolean {
        val appWidgetManager = AppWidgetManager.getInstance(this)
        val provider = ComponentName(this, ToglyWidgetProvider::class.java)
        return if (appWidgetManager.isRequestPinAppWidgetSupported) {
            appWidgetManager.requestPinAppWidget(provider, null, null)
            true
        } else {
            false
        }
    }
}
