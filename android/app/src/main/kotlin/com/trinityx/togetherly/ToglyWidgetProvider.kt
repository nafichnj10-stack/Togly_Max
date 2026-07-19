package com.trinityx.togetherly

import android.app.PendingIntent
import android.appwidget.AppWidgetManager
import android.appwidget.AppWidgetProvider
import android.content.Context
import android.content.Intent
import android.graphics.Bitmap
import android.view.View
import android.widget.RemoteViews
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

class ToglyWidgetProvider : AppWidgetProvider() {

    override fun onUpdate(
        context: Context,
        appWidgetManager: AppWidgetManager,
        appWidgetIds: IntArray
    ) {
        for (widgetId in appWidgetIds) {
            updateWidget(context, appWidgetManager, widgetId)
        }
    }

    companion object {

        fun updateWidget(
            context: Context,
            appWidgetManager: AppWidgetManager,
            widgetId: Int,
            leftPhoto: Bitmap? = null,
            rightPhoto: Bitmap? = null,
            heartFlightProgress: Float = -1f,
            pulsePhase: Float = 0f,
            bikeFrame: Int = 0
        ) {
            val actualLeftPhoto = leftPhoto ?: PhotoCache.loadLeft(context)
            val actualRightPhoto = rightPhoto ?: PhotoCache.loadRight(context)

            val lc = LocaleHelper.localizedContext(context)
            val res = lc.resources

            val prefs = context.getSharedPreferences("togly_prefs", Context.MODE_PRIVATE)
            val state = prefs.getString("widget_state", "normal") ?: "normal"

            val lang = run {
                val savedLang = prefs.getString("app_language", null)
                if (savedLang == "en" || savedLang == "de" || savedLang == "es") savedLang else Locale.getDefault().language
            }

            val views = RemoteViews(context.packageName, R.layout.widget_layout)

            fun openAppPendingIntent(routeExtra: String? = null): PendingIntent {
                val intent = Intent(context, MainActivity::class.java)
                if (routeExtra != null) {
                    intent.putExtra("pending_route", routeExtra)
                }
                val requestCode = routeExtra?.hashCode() ?: 0
                return PendingIntent.getActivity(
                    context, requestCode, intent,
                    PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
                )
            }

            views.setOnClickPendingIntent(R.id.widget_bg, openAppPendingIntent())

            if (state == "not_connected") {
                views.setOnClickPendingIntent(R.id.widget_bg, openAppPendingIntent("/connect"))
                renderSimpleMessageState(
                    views, R.drawable.connect_with_partner, "💌",
                    lc.getString(R.string.not_connected_line1),
                    lc.getString(R.string.not_connected_line2)
                )
                appWidgetManager.updateAppWidget(widgetId, views)
                return
            }

            if (state == "paused") {
                views.setOnClickPendingIntent(R.id.widget_bg, openAppPendingIntent("/restore"))
                renderSimpleMessageState(
                    views, R.drawable.reconnect_partner, "💔",
                    lc.getString(R.string.paused_line1),
                    lc.getString(R.string.paused_line2)
                )
                appWidgetManager.updateAppWidget(widgetId, views)
                return
            }

            val currentDistance = prefs.getFloat("current_distance", 4356f)
            val nameLeft = prefs.getString("name_left", "Bam") ?: "Bam"
            val nameRight = prefs.getString("name_right", "Mimi") ?: "Mimi"
            val flagLeft = prefs.getString("flag_left", "🇩🇪") ?: "🇩🇪"
            val flagRight = prefs.getString("flag_right", "🇹🇭") ?: "🇹🇭"
            val countryLeft = prefs.getString("country_left", "Germany") ?: "Germany"
            val countryRight = prefs.getString("country_right", "Thailand") ?: "Thailand"
            val tzDiffHours = prefs.getInt("tz_diff_hours", 1)

            val nextMeetingEventId = prefs.getString("next_meeting_event_id", "") ?: ""
            val nextMeetingStartMs = prefs.getLong("next_meeting_start_at_ms", -1L)
            val nextMeetingEndMs = prefs.getLong("next_meeting_end_at_ms", -1L)
            val nextMeetingLocation = prefs.getString("next_meeting_location", "") ?: ""

            val petLeft = prefs.getString("pet_left", "dog") ?: "dog"
            val dogIsLeft = petLeft == "dog"
            val dogName = if (dogIsLeft) nameLeft else nameRight
            val catName = if (dogIsLeft) nameRight else nameLeft
            val dogSide = if (dogIsLeft) "left" else "right"
            val catSide = if (dogIsLeft) "right" else "left"

            views.setViewVisibility(R.id.widget_bg, View.VISIBLE)
            views.setViewVisibility(R.id.card_name_left, View.VISIBLE)
            views.setViewVisibility(R.id.card_name_right, View.VISIBLE)
            views.setViewVisibility(R.id.img_profile_bar, View.VISIBLE)

            views.setTextViewText(R.id.tv_name_left, "🐾 $nameLeft")
            views.setTextViewText(R.id.tv_flag_left, "$flagLeft $countryLeft")
            views.setTextViewText(R.id.tv_name_right, "🐾 $nameRight")
            views.setTextViewText(R.id.tv_flag_right, "$flagRight $countryRight")

            if (tzDiffHours == 0) {
                views.setViewVisibility(R.id.card_time_diff, View.GONE)
            } else {
                views.setViewVisibility(R.id.card_time_diff, View.VISIBLE)
                val timeDiffText = res.getQuantityString(R.plurals.time_diff_hours, tzDiffHours, tzDiffHours)
                views.setTextViewText(R.id.tv_time_diff, timeDiffText)
            }

            val distKm = currentDistance.toInt()
            val progress = (prefs.getInt("distance_progress_pct", 0) / 100f).coerceIn(0f, 1f)

            val isBirthdayState = state == "birthday_dog" || state == "birthday_cat" || state == "birthday_both"

            views.setViewVisibility(R.id.btn_send_love, View.VISIBLE)
            views.setTextViewText(
                R.id.tv_send_love_label,
                if (isBirthdayState) lc.getString(R.string.birthday_wish_button) else lc.getString(R.string.send_love_button)
            )

            val sendLoveIntent = Intent(context, SendLoveReceiver::class.java).apply {
                putExtra(AppWidgetManager.EXTRA_APPWIDGET_ID, widgetId)
            }
            val sendLovePendingIntent = PendingIntent.getBroadcast(
                context, widgetId, sendLoveIntent,
                PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
            )
            views.setOnClickPendingIntent(R.id.btn_send_love, sendLovePendingIntent)

            val distanceText = lc.getString(R.string.distance_km_apart, distKm)
            val togetherText = lc.getString(R.string.distance_together_label)

            val isTravelingState = state == "travel_dog_to_cat" || state == "travel_cat_to_dog" ||
                state == "travel_pack_dog_to_cat" || state == "travel_pack_cat_to_dog"
            if (isTravelingState) {
                val updatedAtMs = prefs.getLong("last_gps_update_ms", 0L)
                if (updatedAtMs > 0) {
                    views.setViewVisibility(R.id.tv_last_gps_update, View.VISIBLE)
                    views.setTextViewText(R.id.tv_last_gps_update, "📡 " + formatRelativeUpdateTime(lc, updatedAtMs))
                } else {
                    views.setViewVisibility(R.id.tv_last_gps_update, View.GONE)
                }
            } else {
                views.setViewVisibility(R.id.tv_last_gps_update, View.GONE)
            }

            when (state) {
                "normal" -> {
                    views.setImageViewResource(R.id.widget_bg, R.drawable.normal_mode)
                    if (nextMeetingEventId.isNotBlank() && nextMeetingStartMs > 0) {
                        applyNextMeetingCard(
                            views, lc, true, "📅", lc.getString(R.string.status_next_meeting_title),
                            formatMeetingDateTime(lang, nextMeetingStartMs), nextMeetingLocation,
                            nextMeetingStartMs
                        )
                    } else {
                        applyNextMeetingCard(views, lc, false, "", "", null, null, 0L)
                    }
                    WidgetBitmapHelper.drawProfileBar(context, views, distKm, 0f, true, actualLeftPhoto, actualRightPhoto, distanceText, togetherText, heartFlightProgress, pulsePhase, dogSide = dogSide, catSide = catSide)
                }
                "love_dog_to_cat" -> {
                    views.setImageViewResource(R.id.widget_bg, R.drawable.love_sent_dog)
                    applyHeader(views, true, "❤️", lc.getString(R.string.status_love_line1, dogName), lc.getString(R.string.status_love_line2), "")
                    WidgetBitmapHelper.drawProfileBar(context, views, distKm, 0f, true, actualLeftPhoto, actualRightPhoto, distanceText, togetherText, heartFlightProgress, pulsePhase, dogSide = dogSide, catSide = catSide)
                }
                "love_cat_to_dog" -> {
                    views.setImageViewResource(R.id.widget_bg, R.drawable.love_sent_cat)
                    applyHeader(views, true, "❤️", lc.getString(R.string.status_love_line1, catName), lc.getString(R.string.status_love_line2), "")
                    WidgetBitmapHelper.drawProfileBar(context, views, distKm, 0f, true, actualLeftPhoto, actualRightPhoto, distanceText, togetherText, heartFlightProgress, pulsePhase, dogSide = dogSide, catSide = catSide)
                }
                "travel_upcoming_dog_to_cat" -> {
                    views.setImageViewResource(R.id.widget_bg, R.drawable.travel_upcoming_dog_to_cat)
                    if (nextMeetingStartMs > 0) {
                        applyNextMeetingCard(
                            views, lc, true, "📅", lc.getString(R.string.status_next_meeting_title),
                            formatMeetingDateTime(lang, nextMeetingStartMs), nextMeetingLocation,
                            nextMeetingStartMs
                        )
                    } else {
                        applyHeader(views, true, "🧳", lc.getString(R.string.status_getting_ready_line1, dogName), lc.getString(R.string.status_getting_ready_line2), "")
                    }
                    WidgetBitmapHelper.drawProfileBar(context, views, distKm, 0f, true, actualLeftPhoto, actualRightPhoto, distanceText, togetherText, heartFlightProgress, pulsePhase, dogSide = dogSide, catSide = catSide)
                }
                "travel_upcoming_cat_to_dog" -> {
                    views.setImageViewResource(R.id.widget_bg, R.drawable.travel_upcoming_cat_to_dog)
                    if (nextMeetingStartMs > 0) {
                        applyNextMeetingCard(
                            views, lc, true, "📅", lc.getString(R.string.status_next_meeting_title),
                            formatMeetingDateTime(lang, nextMeetingStartMs), nextMeetingLocation,
                            nextMeetingStartMs
                        )
                    } else {
                        applyHeader(views, true, "🧳", lc.getString(R.string.status_getting_ready_line1, catName), lc.getString(R.string.status_getting_ready_line2), "")
                    }
                    WidgetBitmapHelper.drawProfileBar(context, views, distKm, 0f, false, actualLeftPhoto, actualRightPhoto, distanceText, togetherText, heartFlightProgress, pulsePhase, dogSide = dogSide, catSide = catSide)
                }
                "travel_dog_to_cat" -> {
                    views.setImageViewResource(R.id.widget_bg, R.drawable.travel_dog_to_cat)
                    applyHeader(views, true, "❤️", lc.getString(R.string.status_on_the_way_line1, dogName), lc.getString(R.string.status_on_the_way_line2, catName), lc.getString(R.string.status_km_to_go, distKm))
                    WidgetBitmapHelper.drawProfileBar(
                        context, views, distKm, progress, true, actualLeftPhoto, actualRightPhoto,
                        distanceText, togetherText, heartFlightProgress, pulsePhase,
                        showBikeAnimation = true, bikeFrame = bikeFrame,
                        dogSide = dogSide, catSide = catSide
                    )
                }
                "travel_cat_to_dog" -> {
                    views.setImageViewResource(R.id.widget_bg, R.drawable.travel_cat_to_dog)
                    applyHeader(views, true, "❤️", lc.getString(R.string.status_on_the_way_line1, catName), lc.getString(R.string.status_on_the_way_line2, dogName), lc.getString(R.string.status_km_to_go, distKm))
                    WidgetBitmapHelper.drawProfileBar(
                        context, views, distKm, progress, false, actualLeftPhoto, actualRightPhoto,
                        distanceText, togetherText, heartFlightProgress, pulsePhase,
                        showCatBikeAnimation = true, catFrame = bikeFrame,
                        dogSide = dogSide, catSide = catSide
                    )
                }
                "travel_pack_dog_to_cat" -> {
                    views.setImageViewResource(R.id.widget_bg, R.drawable.travel_pack_dog_to_cat)
                    applyHeader(views, true, "🏠", lc.getString(R.string.status_heading_home_line1, dogName), lc.getString(R.string.status_heading_home_line2), lc.getString(R.string.status_km_away_now, distKm))
                    WidgetBitmapHelper.drawProfileBar(
                        context, views, distKm, progress, true, actualLeftPhoto, actualRightPhoto,
                        distanceText, togetherText, heartFlightProgress, pulsePhase,
                        dogSide = dogSide, catSide = catSide, reverseDirection = true
                    )
                }
                "travel_pack_cat_to_dog" -> {
                    views.setImageViewResource(R.id.widget_bg, R.drawable.travel_pack_cat_to_dog)
                    applyHeader(views, true, "🏠", lc.getString(R.string.status_heading_home_line1, catName), lc.getString(R.string.status_heading_home_line2), lc.getString(R.string.status_km_away_now, distKm))
                    WidgetBitmapHelper.drawProfileBar(
                        context, views, distKm, progress, false, actualLeftPhoto, actualRightPhoto,
                        distanceText, togetherText, heartFlightProgress, pulsePhase,
                        dogSide = dogSide, catSide = catSide, reverseDirection = true
                    )
                }
                "together" -> {
                    views.setImageViewResource(R.id.widget_bg, R.drawable.together_mode)
                    if (nextMeetingEndMs > 0) {
                        applyNextMeetingCard(
                            views, lc, true, "🏡", lc.getString(R.string.status_together_time_left_title),
                            null, null, nextMeetingEndMs
                        )
                    } else {
                        applyHeader(views, true, "🏡", lc.getString(R.string.status_together_line1), lc.getString(R.string.status_together_line2), "")
                    }
                    WidgetBitmapHelper.drawProfileBar(context, views, 0, 1f, true, actualLeftPhoto, actualRightPhoto, distanceText, togetherText, heartFlightProgress, pulsePhase, dogSide = dogSide, catSide = catSide)
                }
                "sleep_both" -> {
                    views.setImageViewResource(R.id.widget_bg, R.drawable.sleep_both)
                    applyHeader(views, true, "😴", lc.getString(R.string.status_good_night), lc.getString(R.string.status_my_love), "")
                    WidgetBitmapHelper.drawProfileBar(context, views, distKm, 0f, true, actualLeftPhoto, actualRightPhoto, distanceText, togetherText, heartFlightProgress, pulsePhase, dogSide = dogSide, catSide = catSide)
                }
                "sleep_dog" -> {
                    views.setImageViewResource(R.id.widget_bg, R.drawable.sleep_dog)
                    applyHeader(views, true, "😴", lc.getString(R.string.status_good_night), dogName, "")
                    WidgetBitmapHelper.drawProfileBar(context, views, distKm, 0f, true, actualLeftPhoto, actualRightPhoto, distanceText, togetherText, heartFlightProgress, pulsePhase, dogSide = dogSide, catSide = catSide)
                }
                "sleep_cat" -> {
                    views.setImageViewResource(R.id.widget_bg, R.drawable.sleep_cat)
                    applyHeader(views, true, "😴", lc.getString(R.string.status_good_night), catName, "")
                    WidgetBitmapHelper.drawProfileBar(context, views, distKm, 0f, true, actualLeftPhoto, actualRightPhoto, distanceText, togetherText, heartFlightProgress, pulsePhase, dogSide = dogSide, catSide = catSide)
                }
                "birthday_dog" -> {
                    views.setImageViewResource(R.id.widget_bg, birthdayBackgroundRes(context, "birthday_dog"))
                    applyHeader(views, true, "🎂", lc.getString(R.string.status_happy_birthday), dogName, "")
                    WidgetBitmapHelper.drawProfileBar(context, views, distKm, 0f, true, actualLeftPhoto, actualRightPhoto, distanceText, togetherText, heartFlightProgress, pulsePhase, dogSide = dogSide, catSide = catSide)
                }
                "birthday_cat" -> {
                    views.setImageViewResource(R.id.widget_bg, birthdayBackgroundRes(context, "birthday_cat"))
                    applyHeader(views, true, "🎂", lc.getString(R.string.status_happy_birthday), catName, "")
                    WidgetBitmapHelper.drawProfileBar(context, views, distKm, 0f, true, actualLeftPhoto, actualRightPhoto, distanceText, togetherText, heartFlightProgress, pulsePhase, dogSide = dogSide, catSide = catSide)
                }
                "birthday_both" -> {
                    views.setImageViewResource(R.id.widget_bg, birthdayBackgroundRes(context, "birthday_both"))
                    applyHeader(views, false, "", "", "", "")
                    WidgetBitmapHelper.drawProfileBar(context, views, distKm, 0f, true, actualLeftPhoto, actualRightPhoto, distanceText, togetherText, heartFlightProgress, pulsePhase, dogSide = dogSide, catSide = catSide)
                }
                else -> {
                    views.setImageViewResource(R.id.widget_bg, R.drawable.normal_mode)
                    applyHeader(views, false, "", "", "", "")
                    WidgetBitmapHelper.drawProfileBar(context, views, distKm, 0f, true, actualLeftPhoto, actualRightPhoto, distanceText, togetherText, heartFlightProgress, pulsePhase, dogSide = dogSide, catSide = catSide)
                }
            }

            appWidgetManager.updateAppWidget(widgetId, views)
        }

        private fun applyHeader(
            views: RemoteViews,
            showHeader: Boolean,
            icon: String,
            line1: String,
            line2: String,
            line3: String
        ) {
            views.setViewVisibility(R.id.card_next_meeting, View.GONE)
            if (!showHeader) {
                views.setViewVisibility(R.id.layout_status, View.GONE)
                return
            }
            views.setViewVisibility(R.id.layout_status, View.VISIBLE)
            views.setTextViewText(R.id.tv_status_icon, icon)
            views.setTextViewText(R.id.tv_status_line1, line1)
            views.setTextViewText(R.id.tv_status_line2, line2)
            views.setTextViewText(R.id.tv_status_line3, line3)
        }

        // ✅ Task 5 (v2): card-style Next Meeting / Time Left Together display.
        // dateText/locationText == null হলে সেই লাইনটা hide হয়ে যায় (together
        // state-এ শুধু countdown দেখানো হয়, date/location দেখানো হয় না)।
        // Seconds বক্সটাও এখানে দেখানো হয় — পুরোপুরি রিয়েল-টাইম না হলেও, app
        // চালু/foreground service সচল থাকা অবস্থায় খুব ঘনঘন (প্রতি ~120ms)
        // widget রিফ্রেশ হয়, তাই বেশিরভাগ সময় প্রায় real-time-ই দেখাবে।
        private fun applyNextMeetingCard(
            views: RemoteViews,
            lc: Context,
            show: Boolean,
            icon: String,
            title: String,
            dateText: String?,
            locationText: String?,
            targetMs: Long
        ) {
            views.setViewVisibility(R.id.layout_status, View.GONE)
            if (!show) {
                views.setViewVisibility(R.id.card_next_meeting, View.GONE)
                return
            }
            views.setViewVisibility(R.id.card_next_meeting, View.VISIBLE)
            views.setTextViewText(R.id.tv_nm_icon, icon)
            views.setTextViewText(R.id.tv_nm_title, title)

            if (dateText.isNullOrBlank()) {
                views.setViewVisibility(R.id.tv_nm_datetime, View.GONE)
            } else {
                views.setViewVisibility(R.id.tv_nm_datetime, View.VISIBLE)
                views.setTextViewText(R.id.tv_nm_datetime, dateText)
            }

            if (locationText.isNullOrBlank()) {
                views.setViewVisibility(R.id.tv_nm_location, View.GONE)
            } else {
                views.setViewVisibility(R.id.tv_nm_location, View.VISIBLE)
                views.setTextViewText(R.id.tv_nm_location, "📍 $locationText")
            }

            val parts = computeCountdownParts(targetMs)
            views.setTextViewText(R.id.tv_nm_days, String.format(Locale.US, "%02d", parts[0]))
            views.setTextViewText(R.id.tv_nm_hours, String.format(Locale.US, "%02d", parts[1]))
            views.setTextViewText(R.id.tv_nm_minutes, String.format(Locale.US, "%02d", parts[2]))
            views.setTextViewText(R.id.tv_nm_seconds, String.format(Locale.US, "%02d", parts[3]))

            views.setTextViewText(R.id.tv_nm_days_label, lc.getString(R.string.nm_label_days))
            views.setTextViewText(R.id.tv_nm_hours_label, lc.getString(R.string.nm_label_hours))
            views.setTextViewText(R.id.tv_nm_minutes_label, lc.getString(R.string.nm_label_minutes))
            views.setTextViewText(R.id.tv_nm_seconds_label, lc.getString(R.string.nm_label_seconds))
        }

        private fun renderSimpleMessageState(
            views: RemoteViews,
            background: Int,
            icon: String,
            line1: String,
            line2: String
        ) {
            views.setImageViewResource(R.id.widget_bg, background)
            views.setViewVisibility(R.id.tv_last_gps_update, View.GONE)
            views.setViewVisibility(R.id.card_time_diff, View.GONE)
            views.setViewVisibility(R.id.card_name_left, View.GONE)
            views.setViewVisibility(R.id.card_name_right, View.GONE)
            views.setViewVisibility(R.id.img_profile_bar, View.GONE)
            views.setViewVisibility(R.id.btn_send_love, View.GONE)
            views.setViewVisibility(R.id.card_next_meeting, View.GONE)

            views.setViewVisibility(R.id.layout_status, View.VISIBLE)
            views.setTextViewText(R.id.tv_status_icon, icon)
            views.setTextViewText(R.id.tv_status_line1, line1)
            views.setTextViewText(R.id.tv_status_line2, line2)
            views.setTextViewText(R.id.tv_status_line3, "")
        }

        private fun birthdayBackgroundRes(context: Context, name: String): Int {
            val id = context.resources.getIdentifier(name, "drawable", context.packageName)
            return if (id != 0) id else R.drawable.bg_birthday_placeholder
        }

        private fun formatRelativeUpdateTime(lc: Context, updatedAtMs: Long): String {
            val diffMs = System.currentTimeMillis() - updatedAtMs
            val minutes = diffMs / 60000
            return when {
                minutes < 1 -> lc.getString(R.string.gps_updated_just_now)
                minutes < 60 -> lc.getString(R.string.gps_updated_min_ago, minutes)
                else -> lc.getString(R.string.gps_updated_hours_ago, minutes / 60)
            }
        }

        // ✅ Task 5 (v2): days/hours/minutes/seconds — চারটা আলাদা বক্সের জন্য
        private fun computeCountdownParts(targetMs: Long): LongArray {
            val diffMs = (targetMs - System.currentTimeMillis()).coerceAtLeast(0L)
            val totalSeconds = diffMs / 1000L
            val days = totalSeconds / 86400
            val hours = (totalSeconds % 86400) / 3600
            val minutes = (totalSeconds % 3600) / 60
            val seconds = totalSeconds % 60
            return longArrayOf(days, hours, minutes, seconds)
        }

        private fun formatMeetingDateTime(lang: String, targetMs: Long): String {
            val pattern = when (lang) {
                "de" -> "d. MMMM yyyy · HH:mm"
                "es" -> "d MMM yyyy · HH:mm"
                else -> "MMM d, yyyy · h:mm a"
            }
            val sdf = SimpleDateFormat(pattern, Locale(lang))
            return sdf.format(Date(targetMs))
        }
    }
}
