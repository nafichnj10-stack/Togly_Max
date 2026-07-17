package com.trinityx.togetherly

import android.content.Context
import android.graphics.*
import android.widget.RemoteViews
import kotlin.math.sin

object WidgetBitmapHelper {

    private val bikeFrameCache = HashMap<Int, Bitmap>()

    private fun loadBikeFrame(context: Context, resId: Int, targetHeight: Int): Bitmap {
        val cacheKey = resId * 10000 + targetHeight
        bikeFrameCache[cacheKey]?.let { return it }
        val original = BitmapFactory.decodeResource(context.resources, resId)
        val scale = targetHeight / original.height.toFloat()
        val targetWidth = (original.width * scale).toInt().coerceAtLeast(1)
        val scaled = Bitmap.createScaledBitmap(original, targetWidth, targetHeight, true)
        if (scaled !== original) {
            original.recycle()
        }
        bikeFrameCache[cacheKey] = scaled
        return scaled
    }

    fun drawProfileBar(
        context: Context,
        views: RemoteViews,
        distanceKm: Int,
        progress: Float,
        leftTraveling: Boolean,
        leftPhoto: Bitmap? = null,
        rightPhoto: Bitmap? = null,
        distanceText: String = "$distanceKm km apart",
        togetherText: String = "Together again ❤️",
        heartFlightProgress: Float = -1f,
        pulsePhase: Float = 0f,
        showBikeAnimation: Boolean = false,
        bikeFrame: Int = 0,
        showCatBikeAnimation: Boolean = false,
        catFrame: Int = 0,
        // ✅ NEW: dog/cat অ্যানিমেশন কোন পাশে (left/right) আঁকা হবে তা নির্ধারণ
        // করে — কে dog, কে cat সেটা এখন gender/love_buddy_pet অনুযায়ী ঠিক হয়
        // (male সবসময় dog, female সবসময় cat), left/right শুধু "কে আমি, কে
        // পার্টনার" বোঝায়, dog/cat কোনটা সেটা বোঝায় না। ডিফল্ট ভ্যালু আগের
        // আচরণ (dog=left, cat=right) বজায় রাখে backward-compatibility-র জন্য।
        dogSide: String = "left",
        catSide: String = "right",
        // ✅ client feedback item 2 (Return Travel / travel_pack): true হলে
        // প্রোফাইল ছবি "কাছে আসার" বদলে "দূরে সরে যাওয়া" দেখাবে — অর্থাৎ
        // progress 0→1 বাড়ার সাথে সাথে ছবি মাঝ থেকে আবার নিজের বাড়ির
        // পজিশনে ফিরে যাবে (distance km বাড়তে থাকা অবস্থায়)
        reverseDirection: Boolean = false
    ) {
        val W = 441
        val H = 60
        val bikeExtraTop = 88
        val bitmap = Bitmap.createBitmap(W, H + bikeExtraTop, Bitmap.Config.ARGB_8888)
        val canvas = Canvas(bitmap)
        canvas.translate(0f, bikeExtraTop.toFloat())

        val distanceRowHeight = 34f
        val cardTop = -distanceRowHeight
        val cardBottom = H.toFloat()
        val cardCornerRadius = 26f
        val cardRect = RectF(0f, cardTop, W.toFloat(), cardBottom)

        val bgPaint = Paint().apply {
            color = Color.parseColor("#33FF69B4")
            isAntiAlias = true
        }
        canvas.drawRoundRect(cardRect, cardCornerRadius, cardCornerRadius, bgPaint)

        val borderPaintBg = Paint().apply {
            color = Color.parseColor("#FF69B4")
            style = Paint.Style.STROKE
            strokeWidth = 1.3f
            isAntiAlias = true
        }
        canvas.drawRoundRect(
            RectF(cardRect.left + 1.25f, cardRect.top + 1.25f, cardRect.right - 1.25f, cardRect.bottom - 1.25f),
            cardCornerRadius, cardCornerRadius, borderPaintBg
        )

        val cy = H / 2f + 3f
        val r = (H / 2f - 3f) * 1.0f
        val leftCx = r + 4f
        val rightCx = W - r - 4f

        // ✅ client feedback item 4: distance text আর এই canvas bitmap-এ আঁকা হয়
        // না — এখন সেটা widget_layout.xml-এর আলাদা tv_distance_text bubble-এ
        // (প্রোফাইল বার-এর ঠিক উপরে) সেট করা হয় ToglyWidgetProvider থেকে, যাতে
        // প্রোফাইল ছবি কাছে এলেও কখনো টেক্সট ঢাকা না পড়ে।
        val targetLeftCx = W / 2f - r - 2f
        val targetRightCx = W / 2f + r + 2f
        val t = (if (reverseDirection) 1f - progress else progress).coerceIn(0f, 1f)
        val actualLeftCx = leftCx + (targetLeftCx - leftCx) * t
        val actualRightCx = rightCx + (targetRightCx - rightCx) * t

        val lineStart = leftCx + r + 4f
        val lineEnd = rightCx - r - 4f
        val midX = (lineStart + lineEnd) / 2f
        val chainBottomY = H.toFloat() - (H * 0.30f)

        val dotPaint = Paint().apply {
            color = Color.parseColor("#FFFFC9E3")
            isAntiAlias = true
        }
        for (i in -3..3) {
            if (i == 0) continue
            val dt = i / 3f
            val x = midX + dt * (lineEnd - lineStart) / 2f
            val sag = (1f - dt * dt) * (H * 0.05f)
            val y = chainBottomY + sag
            canvas.drawCircle(x, y, 3.4f, dotPaint)
        }

        // ✅ client feedback item 2 (এই ডেলিভারি): hug emoji (🫂) এখন সম্পূর্ণ
        // static — আগের pulsing/growing scale animation বাদ দেওয়া হয়েছে।
        // Bicycle animation-ই এখন এই state-এর একমাত্র movement, তাই এখানে আর
        // আলাদা movement দরকার নেই — বড় হয়ে গেলে emoji-টা dominant/messy
        // দেখাচ্ছিল, এখন ফিক্সড সাইজে পরিষ্কার থাকবে।
        val heartCenterY = chainBottomY + 4.5f
        val heartPaint = Paint().apply {
            textSize = 34f
            textAlign = Paint.Align.CENTER
            isAntiAlias = true
        }
        canvas.drawText("🫂", midX, heartCenterY, heartPaint)

        drawTwinkle(canvas, midX + 15f, chainBottomY - 9f, pulsePhase, speed = 4f, baseSize = 11f, offset = 0f)
        drawTwinkle(canvas, midX - 16f, chainBottomY - 6f, pulsePhase, speed = 4f, baseSize = 9f, offset = 0.5f)

        if (heartFlightProgress in 0f..1f) {
            val ft = heartFlightProgress
            val flyX = actualLeftCx + (actualRightCx - actualLeftCx) * ft
            val arcBump = -(H * 0.55f) * (4f * ft * (1f - ft))
            val flyY = cy + arcBump
            val flySize = 15f + 3f * (4f * ft * (1f - ft))
            val flyPaint = Paint().apply {
                textSize = flySize
                textAlign = Paint.Align.CENTER
                isAntiAlias = true
            }
            canvas.drawText("❤️", flyX, flyY, flyPaint)

            val trailT = (ft - 0.18f).coerceAtLeast(0f)
            if (trailT > 0f) {
                val trailX = actualLeftCx + (actualRightCx - actualLeftCx) * trailT
                val trailArc = -(H * 0.55f) * (4f * trailT * (1f - trailT))
                val trailPaint = Paint().apply {
                    textSize = 8f
                    textAlign = Paint.Align.CENTER
                    isAntiAlias = true
                    alpha = 200
                }
                canvas.drawText("✨", trailX, cy + trailArc + 5f, trailPaint)
            }
        }

        drawCircle(canvas, actualLeftCx, cy, r, "👨", leftPhoto)
        drawCircle(canvas, actualRightCx, cy, r, "👩", rightPhoto)

        // ✅ FIX: dog সাইকেল অ্যানিমেশন আগে সবসময় left-এ (actualLeftCx) আঁকা হতো,
        // ধরে নেওয়া হতো "left = me = always dog"। এখন dogSide প্যারামিটার
        // অনুযায়ী সঠিক পাশে (আসল dog-পরিচয়ধারী ব্যক্তির পাশে) আঁকা হয়।
        if (showBikeAnimation) {
            val frameRes = when (bikeFrame % 5) {
                0 -> R.drawable.dog_cycle_1
                1 -> R.drawable.dog_cycle_2
                2 -> R.drawable.dog_cycle_3
                3 -> R.drawable.dog_cycle_2
                else -> R.drawable.dog_cycle_4
            }
            val bikeHeight = (r * 3f).toInt().coerceAtLeast(1)
            val bikeBitmap = loadBikeFrame(context, frameRes, bikeHeight)
            val bikeBottomY = 8f
            val bikeTop = bikeBottomY - bikeBitmap.height
            val dogCx = if (dogSide == "left") actualLeftCx else actualRightCx
            val bikeLeft = dogCx - bikeBitmap.width / 2f
            canvas.drawBitmap(bikeBitmap, bikeLeft, bikeTop, Paint().apply { isAntiAlias = true })
        }

        // ✅ FIX: cat সাইকেল অ্যানিমেশন আগে সবসময় right-এ (actualRightCx) আঁকা
        // হতো, ধরে নেওয়া হতো "right = partner = always cat"। এখন catSide
        // প্যারামিটার অনুযায়ী সঠিক পাশে আঁকা হয়।
        if (showCatBikeAnimation) {
            val frameRes = when (catFrame % 5) {
                0 -> R.drawable.cat_cycle_1
                1 -> R.drawable.cat_cycle_2
                2 -> R.drawable.cat_cycle_3
                3 -> R.drawable.cat_cycle_2
                else -> R.drawable.cat_cycle_4
            }
            val catBikeHeight = (r * 3f).toInt().coerceAtLeast(1)
            val catBikeBitmap = loadBikeFrame(context, frameRes, catBikeHeight)
            val catBikeBottomY = 8f
            val catBikeTop = catBikeBottomY - catBikeBitmap.height
            val catCx = if (catSide == "left") actualLeftCx else actualRightCx
            val catBikeLeft = catCx - catBikeBitmap.width / 2f
            canvas.drawBitmap(catBikeBitmap, catBikeLeft, catBikeTop, Paint().apply { isAntiAlias = true })
        }

        // ✅ fix: duplicate distance-text বাগ — এখন card_distance bubble অথবা
        // এই canvas দুটোর একটাই ব্যবহার হত — এখন শুধুমাত্র এইখানেই একবার
        // pill/card সহ আঁকা হয়।
        val displayText = if (distanceKm <= 0) togetherText else distanceText

        val distanceTextPaint = Paint().apply {
            textSize = 20f
            color = Color.WHITE
            typeface = Typeface.create(Typeface.DEFAULT, Typeface.BOLD)
            isAntiAlias = true
            textAlign = Paint.Align.CENTER
            setShadowLayer(3f, 0f, 1f, Color.parseColor("#DD000000"))
        }

        // distance পিল — প্রোফাইল বড় বাবলের ৯২% প্রস্থ, height ১.৫ গুন,
        // আর টেক্সট পিলের সম্পুর্ন মাঝে থাকবে
        val pillWidth = W * 0.92f
        val pillTop = cardTop + 11f
        val pillHeight = (distanceRowHeight - 13f) * 1.5f
        val pillRect = RectF(
            W / 2f - pillWidth / 2f,
            pillTop,
            W / 2f + pillWidth / 2f,
            pillTop + pillHeight
        )
        val pillCornerRadius = pillHeight / 2f

        // ✅ client feedback item 3: kilometer পিল আরও transparent করা হলো
        // (আগে #40FF69B4 / ~25% opacity ছিল, এখন #20FF69B4 / ~12.5% opacity)।
        // দরকার হলে হেক্সের প্রথম দুই ক্যারেক্টার (00-FF) বদলে opacity
        // আরও কমানো/বাড়ানো যাবে।
        val pillBgPaint = Paint().apply {
            color = Color.parseColor("#20FF69B4")
            isAntiAlias = true
        }
        canvas.drawRoundRect(pillRect, pillCornerRadius, pillCornerRadius, pillBgPaint)

        val pillBorderPaint = Paint().apply {
            color = Color.parseColor("#FF69B4")
            style = Paint.Style.STROKE
            strokeWidth = 1.3f
            isAntiAlias = true
        }
        canvas.drawRoundRect(pillRect, pillCornerRadius, pillCornerRadius, pillBorderPaint)

        val distanceTextFm = distanceTextPaint.fontMetrics
        val distanceTextY = pillRect.centerY() - (distanceTextFm.ascent + distanceTextFm.descent) / 2f
        canvas.drawText(displayText, W / 2f, distanceTextY, distanceTextPaint)

        views.setImageViewBitmap(R.id.img_profile_bar, bitmap)
    }

    private fun drawTwinkle(
        canvas: Canvas,
        x: Float,
        y: Float,
        pulsePhase: Float,
        speed: Float,
        baseSize: Float,
        offset: Float
    ) {
        val phase = ((pulsePhase * speed) + offset) % 1f
        val wave = (sin(phase * (2 * Math.PI)).toFloat() + 1f) / 2f
        val alpha = (60 + wave * 195).toInt().coerceIn(0, 255)
        val size = baseSize * (0.75f + 0.45f * wave)

        val paint = Paint().apply {
            textSize = size
            textAlign = Paint.Align.CENTER
            isAntiAlias = true
            this.alpha = alpha
        }
        canvas.drawText("✨", x, y, paint)
    }

    private fun drawCircle(
        canvas: Canvas,
        cx: Float,
        cy: Float,
        r: Float,
        fallbackEmoji: String,
        photo: Bitmap? = null
    ) {
        val rX = r
        val rY = r * 0.94f
        val oval = RectF(cx - rX, cy - rY, cx + rX, cy + rY)

        if (photo != null) {
            canvas.save()
            val clipPath = Path().apply { addOval(oval, Path.Direction.CW) }
            canvas.clipPath(clipPath)

            val srcRect = Rect(0, 0, photo.width, photo.height)
            canvas.drawBitmap(photo, srcRect, oval, Paint().apply { isAntiAlias = true })
            canvas.restore()
        } else {
            val fillPaint = Paint().apply {
                color = Color.parseColor("#DDF5F5F5")
                isAntiAlias = true
            }
            canvas.drawOval(oval, fillPaint)

            val emojiPaint = Paint().apply {
                textSize = r * 1.15f
                isAntiAlias = true
                textAlign = Paint.Align.CENTER
            }
            canvas.drawText(fallbackEmoji, cx, cy + r * 0.40f, emojiPaint)
        }

        val thinBorderPaint = Paint().apply {
            color = Color.parseColor("#FFD16BA5")
            style = Paint.Style.STROKE
            strokeWidth = 3f
            isAntiAlias = true
        }
        canvas.drawOval(oval, thinBorderPaint)
    }
}
