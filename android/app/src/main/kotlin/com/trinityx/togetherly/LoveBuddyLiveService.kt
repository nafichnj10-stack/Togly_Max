package com.trinityx.togetherly

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.Service
import android.appwidget.AppWidgetManager
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.graphics.Bitmap
import android.os.Build
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import android.util.Log
import com.bumptech.glide.Glide
import com.google.firebase.auth.FirebaseAuth
import com.google.firebase.firestore.FirebaseFirestore
import com.google.firebase.firestore.ListenerRegistration
import java.util.concurrent.TimeUnit

class LoveBuddyLiveService : Service() {

    private val TAG = "LoveBuddyLiveService"
    private val mainHandler = Handler(Looper.getMainLooper())
    private val db by lazy { FirebaseFirestore.getInstance() }

    private var authListener: FirebaseAuth.AuthStateListener? = null

    private var relViewListener: ListenerRegistration? = null
    private var relDocListener: ListenerRegistration? = null
    private var myUserListener: ListenerRegistration? = null
    private var partnerPublicListener: ListenerRegistration? = null

    private var currentUid: String? = null
    private var currentPartnerUid: String? = null
    private var currentRelationshipId: String? = null

    private val pulseHandler = Handler(Looper.getMainLooper())
    private var pulseStartTime = 0L
    private var bikeFrameCounter = 0
    private val PULSE_CYCLE_MS = 4000L
    private val PULSE_TICK_MS = 120L
    private val pulseRunnable = object : Runnable {
        override fun run() {
            if (!SendLoveAnimator.isPlaying) {
                val elapsed = System.currentTimeMillis() - pulseStartTime
                val phase = (elapsed % PULSE_CYCLE_MS) / PULSE_CYCLE_MS.toFloat()
                bikeFrameCounter++
                refreshWidget(pulsePhase = phase, bikeFrame = bikeFrameCounter)
            }
            pulseHandler.postDelayed(this, PULSE_TICK_MS)
        }
    }

    override fun onCreate() {
        super.onCreate()
        GlideNetworkSetup.ensureInitialized(applicationContext)
        startForegroundWithNotification()
        startWhenAuthenticated()

        pulseStartTime = System.currentTimeMillis()
        pulseHandler.postDelayed(pulseRunnable, PULSE_TICK_MS)
    }

    private fun startWhenAuthenticated() {
        val auth = FirebaseAuth.getInstance()

        auth.currentUser?.let { onUserSignedIn(it.uid) }

        val listener = FirebaseAuth.AuthStateListener { firebaseAuth ->
            val uid = firebaseAuth.currentUser?.uid
            if (uid == null) {
                Log.d(TAG, "User signed out — detaching listeners")
                detachAllListeners()
                currentUid = null
                showNotConnectedState()
            } else if (uid != currentUid) {
                Log.d(TAG, "User signed in / switched: uid=$uid")
                detachAllListeners()
                onUserSignedIn(uid)
            }
        }
        authListener = listener
        auth.addAuthStateListener(listener)
    }

    private fun onUserSignedIn(uid: String) {
        currentUid = uid
        attachRelationshipViewListener(uid)
        attachMyUserListener(uid)
    }

    private fun attachRelationshipViewListener(uid: String) {
        relViewListener = db.collection("relationship_views").document(uid)
            .addSnapshotListener { snapshot, error ->
                if (error != null) {
                    Log.e(TAG, "relationship_views listen failed: ${error.message}")
                    return@addSnapshotListener
                }
                if (snapshot == null || !snapshot.exists()) {
                    showNotConnectedState()
                    return@addSnapshotListener
                }
                val data = snapshot.data ?: return@addSnapshotListener
                handleRelationshipViewUpdate(data)
            }
    }

    private fun showNotConnectedState() {
        val prefs = getSharedPreferences("togly_prefs", Context.MODE_PRIVATE)
        prefs.edit().putString("widget_state", "not_connected").apply()
        refreshWidget()
    }

    private fun handleRelationshipViewUpdate(data: Map<String, Any?>) {
        val prefs = getSharedPreferences("togly_prefs", Context.MODE_PRIVATE)

        val partnerUid = data["partner_uid"] as? String
        val relationshipId = data["relationship_id"] as? String
        val relationshipStatus = data["relationship_status"] as? String

        if (relationshipId.isNullOrBlank() || partnerUid.isNullOrBlank()) {
            showNotConnectedState()
            return
        }

        val isPaused = data["paused"] == true ||
            relationshipStatus == "disconnect_pending" ||
            (data["widget_state"] as? String) == "paused"

        if (isPaused) {
            prefs.edit().putString("widget_state", "paused").apply()
            refreshWidget()
            return
        }

        val rawBackgroundKey = data["widget_background_key"] as? String ?: "normal"
        val resolvedState = WidgetStateResolver.resolve(rawBackgroundKey, data, currentUid)

        if (resolvedState == "love_dog_to_cat" || resolvedState == "love_cat_to_dog") {
            val lastSentAtMs = extractTimestampMillis(data["widget_last_love_sent_at"])
            LoveStateAlarmScheduler.schedule(this, lastSentAtMs)
        }

        // ✅ Task 5: Next Meeting Countdown — সরাসরি relationship_views থেকে,
        // Log যোগ করা হয়েছে যাতে raw ভ্যালু কী আসছে (আর কী টাইপে) সরাসরি
        // logcat-এ দেখা যায় — ডিবাগ করা সহজ হবে।
        val rawStart = data["widget_next_meeting_start_at"]
        val rawEnd = data["widget_next_meeting_end_at"]
        Log.d(TAG, "next_meeting raw -> event_id=${data["widget_next_meeting_event_id"]} " +
            "start=$rawStart (${rawStart?.javaClass?.simpleName}) " +
            "end=$rawEnd (${rawEnd?.javaClass?.simpleName}) " +
            "location=${data["widget_next_meeting_location"]}")

        val nextMeetingEventId = (data["widget_next_meeting_event_id"] as? String)?.takeIf { it.isNotBlank() }
        val nextMeetingStartMs = extractTimestampMillis(rawStart)
        val nextMeetingEndMs = extractTimestampMillis(rawEnd)
        val nextMeetingLocation = (data["widget_next_meeting_location"] as? String)?.takeIf { it.isNotBlank() } ?: ""

        prefs.edit().apply {
            putString("widget_state", resolvedState)
            val myLoveBuddyName = (data["my_love_buddy_name"] as? String)?.takeIf { it.isNotBlank() }
            val myRealName = (data["my_name"] as? String)?.takeIf { it.isNotBlank() }
            val partnerLoveBuddyName = (data["partner_love_buddy_name"] as? String)?.takeIf { it.isNotBlank() }
            val partnerRealName = (data["partner_name"] as? String)?.takeIf { it.isNotBlank() }
            putString("name_left", myLoveBuddyName ?: myRealName ?: "Me")
            putString("name_right", partnerLoveBuddyName ?: partnerRealName ?: "Partner")

            putString("pet_left", data["my_love_buddy_pet"] as? String ?: "dog")
            putString("pet_right", data["partner_love_buddy_pet"] as? String ?: "cat")

            (data["widget_distance_km"] as? Number)?.let {
                putFloat("current_distance", it.toFloat())
            }
            (data["widget_distance_progress"] as? Number)?.let {
                putInt("distance_progress_pct", it.toInt())
            }

            extractTimestampMillis(data["my_live_location_updated_at"])?.let {
                putLong("last_gps_update_ms", it)
            }

            val myTzOffset = (data["my_tz_offset_minutes"] as? Number)?.toInt()
            val partnerTzOffset = (data["partner_tz_offset_minutes"] as? Number)?.toInt()
            val diffHours = if (myTzOffset != null && partnerTzOffset != null) {
                Math.round(Math.abs(myTzOffset - partnerTzOffset) / 60f)
            } else {
                0
            }
            putInt("tz_diff_hours", diffHours)

            if (nextMeetingEventId != null && nextMeetingStartMs != null) {
                putString("next_meeting_event_id", nextMeetingEventId)
                putLong("next_meeting_start_at_ms", nextMeetingStartMs)
                putLong("next_meeting_end_at_ms", nextMeetingEndMs ?: -1L)
                putString("next_meeting_location", nextMeetingLocation)
            } else {
                putString("next_meeting_event_id", "")
                putLong("next_meeting_start_at_ms", -1L)
                putLong("next_meeting_end_at_ms", -1L)
                putString("next_meeting_location", "")
            }
            apply()
        }

        if (partnerUid != currentPartnerUid) {
            currentPartnerUid = partnerUid
            attachPartnerPublicListener(partnerUid)
        }

        if (relationshipId != currentRelationshipId) {
            currentRelationshipId = relationshipId
            attachRelationshipDocListener(relationshipId)
        }

        val myPhotoUrl = data["my_photo_url"] as? String
        val partnerPhotoUrl = data["partner_photo_url"] as? String
        loadPhotosAndRefresh(myPhotoUrl, partnerPhotoUrl)
    }

    // Firestore Timestamp / epoch millis Number / ISO-8601 String — তিনটাই হ্যান্ডেল করে
    private fun extractTimestampMillis(value: Any?): Long? {
        if (value == null) return null
        // Firestore Timestamp
        try {
            val toDateMethod = value.javaClass.getMethod("toDate")
            (toDateMethod.invoke(value) as? java.util.Date)?.time?.let { return it }
        } catch (e: Exception) { /* not a Timestamp, try next */ }
        // epoch millis Number
        (value as? Number)?.let { return it.toLong() }
        // ISO-8601 String (e.g. "2026-07-20T18:00:00Z")
        (value as? String)?.let { str ->
            try {
                return java.time.Instant.parse(str).toEpochMilli()
            } catch (e: Exception) {
                Log.e(TAG, "Could not parse timestamp string: $str (${e.message})")
            }
        }
        return null
    }

    private fun attachMyUserListener(uid: String) {
        myUserListener = db.collection("Users").document(uid)
            .addSnapshotListener { snapshot, error ->
                if (error != null) {
                    Log.e(TAG, "Users/$uid listen failed: ${error.message}")
                    return@addSnapshotListener
                }
                val data = snapshot?.data ?: return@addSnapshotListener
                val prefs = getSharedPreferences("togly_prefs", Context.MODE_PRIVATE)
                prefs.edit().apply {
                    putString("country_left", data["country_name"] as? String ?: "")
                    putString("flag_left", FlagUtils.countryCodeToFlagEmoji(data["country_code"] as? String))
                    val lang = (data["appLanguage"] as? String)?.lowercase()?.take(2)
                    if (lang == "en" || lang == "de" || lang == "es") {
                        putString("app_language", lang)
                    }
                    apply()
                }
                refreshWidget()
            }
    }

    private fun attachPartnerPublicListener(partnerUid: String) {
        partnerPublicListener?.remove()
        partnerPublicListener = db.collection("PublicUsers").document(partnerUid)
            .addSnapshotListener { snapshot, error ->
                if (error != null) {
                    Log.e(TAG, "PublicUsers/$partnerUid listen failed: ${error.message}")
                    return@addSnapshotListener
                }
                val data = snapshot?.data ?: return@addSnapshotListener
                val prefs = getSharedPreferences("togly_prefs", Context.MODE_PRIVATE)
                prefs.edit().apply {
                    putString("country_right", data["country_name"] as? String ?: "")
                    putString("flag_right", FlagUtils.countryCodeToFlagEmoji(data["country_code"] as? String))
                    apply()
                }
                refreshWidget()
            }
    }

    private fun attachRelationshipDocListener(relationshipId: String) {
        relDocListener?.remove()
        relDocListener = db.collection("relationships").document(relationshipId)
            .addSnapshotListener { snapshot, error ->
                if (error != null) {
                    Log.e(TAG, "relationships/$relationshipId listen failed: ${error.message}")
                    return@addSnapshotListener
                }
                val prefs = getSharedPreferences("togly_prefs", Context.MODE_PRIVATE)
                val relData = snapshot?.data

                val isPaused = relData != null && (
                    relData["active"] == false ||
                    (relData["relationship_status"] as? String) == "disconnect_pending" ||
                    (relData["love_buddies_widget_state"] as? String) == "paused"
                )
                if (isPaused) {
                    prefs.edit().putString("widget_state", "paused").apply()
                    refreshWidget()
                }
            }
    }

    private fun detachAllListeners() {
        relViewListener?.remove(); relViewListener = null
        relDocListener?.remove(); relDocListener = null
        myUserListener?.remove(); myUserListener = null
        partnerPublicListener?.remove(); partnerPublicListener = null
        currentPartnerUid = null
        currentRelationshipId = null
    }

    private fun loadPhotosAndRefresh(myPhotoUrl: String?, partnerPhotoUrl: String?) {
        Thread {
            val leftBitmap = tryLoadBitmap(myPhotoUrl, "MY")
            val rightBitmap = tryLoadBitmap(partnerPhotoUrl, "PARTNER")
            refreshWidget(leftBitmap, rightBitmap)
        }.start()
    }

    private fun tryLoadBitmap(url: String?, label: String): Bitmap? {
        if (url.isNullOrBlank()) return null
        return try {
            val bitmap = Glide.with(applicationContext)
                .asBitmap()
                .load(url)
                .submit(150, 150)
                .get(15, TimeUnit.SECONDS)

            if (label == "MY") PhotoCache.saveLeft(applicationContext, bitmap)
            if (label == "PARTNER") PhotoCache.saveRight(applicationContext, bitmap)
            bitmap
        } catch (e: Exception) {
            Log.e(TAG, "$label photo failed to load ($url): ${e.message}")
            null
        }
    }

    private fun refreshWidget(leftPhoto: Bitmap? = null, rightPhoto: Bitmap? = null, pulsePhase: Float = 0f, bikeFrame: Int = 0) {
        val appWidgetManager = AppWidgetManager.getInstance(this)
        val componentName = ComponentName(this, ToglyWidgetProvider::class.java)
        val widgetIds = appWidgetManager.getAppWidgetIds(componentName)
        for (widgetId in widgetIds) {
            ToglyWidgetProvider.updateWidget(
                context = this,
                appWidgetManager = appWidgetManager,
                widgetId = widgetId,
                leftPhoto = leftPhoto,
                rightPhoto = rightPhoto,
                pulsePhase = pulsePhase,
                bikeFrame = bikeFrame
            )
        }
    }

    private fun startForegroundWithNotification() {
        val channelId = "love_buddy_live_channel"
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            val channel = NotificationChannel(
                channelId, "Love Buddy Live Sync",
                NotificationManager.IMPORTANCE_MIN
            )
            val manager = getSystemService(NotificationManager::class.java)
            manager?.createNotificationChannel(channel)
        }

        val notification: Notification = androidx.core.app.NotificationCompat.Builder(this, channelId)
            .setContentTitle("Love Buddy widget active")
            .setSmallIcon(android.R.drawable.ic_dialog_info)
            .setPriority(androidx.core.app.NotificationCompat.PRIORITY_MIN)
            .build()

        startForeground(1, notification)
    }

    override fun onDestroy() {
        authListener?.let { FirebaseAuth.getInstance().removeAuthStateListener(it) }
        detachAllListeners()
        pulseHandler.removeCallbacksAndMessages(null)
        mainHandler.removeCallbacksAndMessages(null)
        super.onDestroy()
    }

    override fun onBind(intent: Intent?): IBinder? = null
}
