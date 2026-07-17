package com.trinityx.togetherly

import android.app.PendingIntent
import android.appwidget.AppWidgetManager
import android.appwidget.AppWidgetProvider
import android.content.Context
import android.content.Intent
import android.graphics.Bitmap
import android.view.View
import android.widget.RemoteViews

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

            val views = RemoteViews(context.packageName, R.layout.widget_layout)

            // ✅ Widget Tap Behavior: সাধারণ state-এ শুধু app খোলে। কিন্তু
            // not_connected/paused state-এ (item 1 ও 7) app খোলার সাথে সাথে
            // সরাসরি Connect/Restore পেজে পাঠানো হয় — "pending_route" extra
            // MainActivity ধরে রাখে, Flutter side সেটা পড়ে navigate করে।
            fun openAppPendingIntent(routeExtra: String? = null): PendingIntent {
                val intent = Intent(context, MainActivity::class.java)
                if (routeExtra != null) {
                    intent.putExtra("pending_route", routeExtra)
                }
                // routeExtra ভেদে আলাদা request code, যাতে PendingIntent ক্যাশ মিক্স না হয়
                val requestCode = routeExtra?.hashCode() ?: 0
                return PendingIntent.getActivity(
                    context, requestCode, intent,
                    PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
                )
            }

            views.setOnClickPendingIntent(R.id.widget_bg, openAppPendingIntent())

            // ✅ script item 11 + client feedback item 1: not connected —
            // নতুন background connect_with_partner, ট্যাপ করলে সরাসরি Connect পেজে
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

            // ✅ script item 10 + client feedback item 7: paused relationship —
            // নতুন background reconnect_partner, ট্যাপ করলে সরাসরি Restore পেজে
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
            val countdownDays = prefs.getInt("countdown_days", -1) // -1 = কোনো next meeting নেই

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

            // ✅ client feedback item 4: distance bubble সবসময় visible, শুধু
            // "together" state-এ togetherText দেখাবে (state-ভিত্তিক, যাতে
            // background আর bubble টেক্সট সবসময় সামঞ্জস্যপূর্ণ থাকে)
            // ✅ fix: duplicate distance text বাগ — এই আলাদা floating card আর
            // দেখানো হয় না, distance/together text এখন profile bar bitmap-এর
            // ভেতরেই (WidgetBitmapHelper.drawProfileBar) একটা pill আকারে আঁকা হয়।
            views.setViewVisibility(R.id.card_distance, View.GONE)

            // ✅ script item 8: শুধু traveling state-এ শেষ GPS আপডেট কতক্ষণ আগে এসেছে
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
                    // ✅ script item 1: শুধু আসল Next Meeting থাকলেই (countdownDays >= 0) header দেখাবে
                    if (countdownDays >= 0) {
                        applyHeader(views, true, "📅", lc.getString(R.string.status_next_reunion), lc.getString(R.string.status_days_pattern, countdownDays), "")
                    } else {
                        applyHeader(views, false, "", "", "", "")
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
                    val tripLine3Dog = if (countdownDays >= 0) res.getString(R.string.status_trip_in_days, countdownDays) else lc.getString(R.string.status_trip_starts_soon)
                    applyHeader(views, true, "🧳", lc.getString(R.string.status_getting_ready_line1, dogName), lc.getString(R.string.status_getting_ready_line2), tripLine3Dog)
                    WidgetBitmapHelper.drawProfileBar(context, views, distKm, 0f, true, actualLeftPhoto, actualRightPhoto, distanceText, togetherText, heartFlightProgress, pulsePhase, dogSide = dogSide, catSide = catSide)
                }
                "travel_upcoming_cat_to_dog" -> {
                    views.setImageViewResource(R.id.widget_bg, R.drawable.travel_upcoming_cat_to_dog)
                    val tripLine3Cat = if (countdownDays >= 0) res.getString(R.string.status_trip_in_days, countdownDays) else lc.getString(R.string.status_trip_starts_soon)
                    applyHeader(views, true, "🧳", lc.getString(R.string.status_getting_ready_line1, catName), lc.getString(R.string.status_getting_ready_line2), tripLine3Cat)
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
                // ✅ client feedback item 2: Return Travel — সাধারণ traveling থেকে
                // আলাদা: নতুন background, "Heading Home" header, আর প্রোফাইল ছবি
                // উল্টো দিকে (কাছ থেকে আবার দূরে) সরে যায় — reverseDirection = true।
                // আলাদা walking-animation art না থাকায় সাইকেল অ্যানিমেশন এখানে
                // দেখানো হচ্ছে না (bike sprite reuse করলে ভিজ্যুয়ালি না মিলত)।
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
                    applyHeader(views, true, "🏡", lc.getString(R.string.status_together_line1), lc.getString(R.string.status_together_line2), "")
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
                    // ✅ script item 4: দুজনেরই জন্মদিন হলে হেডার টেক্সট সম্পূর্ণ বাদ —
                    // background-এই "Happy Birthday to Us" লেখা আছে
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

        // ✅ script item 1 + 4: header দেখানো/লুকানো একই জায়গা থেকে নিয়ন্ত্রণ
        private fun applyHeader(
            views: RemoteViews,
            showHeader: Boolean,
            icon: String,
            line1: String,
            line2: String,
            line3: String
        ) {
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

        // ✅ script items 10 & 11: paused / not_connected — profile-bar লজিক ছাড়াই
        // একটা পরিষ্কার, emotional বার্তা দেখানো হয়
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
            views.setViewVisibility(R.id.card_distance, View.GONE)
            views.setViewVisibility(R.id.btn_send_love, View.GONE)

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

        // ✅ script item 8 + client feedback item 8: fully localized
        private fun formatRelativeUpdateTime(lc: Context, updatedAtMs: Long): String {
            val diffMs = System.currentTimeMillis() - updatedAtMs
            val minutes = diffMs / 60000
            return when {
                minutes < 1 -> lc.getString(R.string.gps_updated_just_now)
                minutes < 60 -> lc.getString(R.string.gps_updated_min_ago, minutes)
                else -> lc.getString(R.string.gps_updated_hours_ago, minutes / 60)
            }
        }
    }
}
