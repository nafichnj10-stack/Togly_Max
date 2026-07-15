package com.trinityx.togetherly

// ✅ client feedback item 5: এই লজিকটা আগে LoveBuddyLiveService-এর ভেতরে
// private ফাংশন হিসেবে ছিল। এখন এটা আলাদা shared object-এ বের করে আনা
// হয়েছে, যাতে LoveBuddyLiveService (live Firestore listener) আর
// LoveStateRefreshReceiver (love_sent-এর ৩০ মিনিট পরের one-shot alarm
// refresh) — দুটোই ঠিক একই লজিক ব্যবহার করে, কোনো ভিন্নতা/bug তৈরি না হয়।
//
// ✅ FIX: love_sent auto-revert bug — আগে এই resolver backgroundKey
// ("love_dog_to_cat"/"love_cat_to_dog") কে সময় না দেখেই সরাসরি ফেরত
// দিত। সার্ভার (Cloud Function) যদি ৩০ মিনিট পরে widget_background_key
// ফিল্ডটা নিজে থেকে "normal"-এ রিভার্ট না করে, widget চিরকাল love_sent
// state-এ আটকে থাকত। এখন client নিজেই widget_last_love_sent_at থেকে
// elapsed time চেক করে — ৩০ মিনিটের বেশি হয়ে গেলে backgroundKey যাই
// হোক, জোর করে "normal" রিটার্ন করা হয়, যাতে widget নিজে থেকেই ঠিক
// state-এ ফিরে আসে (সার্ভার ঠিক করুক বা না করুক)।
object WidgetStateResolver {

    private const val LOVE_SENT_DURATION_MS = 30 * 60 * 1000L

    // widget_background_key কে ToglyWidgetProvider-এর চেনা state key-তে ম্যাপ করে
    fun resolve(backgroundKey: String, data: Map<String, Any?>, currentUid: String?): String {
        if (backgroundKey == "birthday") {
            val myUid = currentUid
            val partnerUid = data["partner_uid"] as? String
            val birthdayUids = (data["widget_birthday_user_uids"] as? List<*>)?.map { it.toString() } ?: emptyList()
            val myBirthday = myUid != null && birthdayUids.contains(myUid)
            val partnerBirthday = partnerUid != null && birthdayUids.contains(partnerUid)
            return when {
                myBirthday && partnerBirthday -> "birthday_both"
                myBirthday -> "birthday_${data["my_love_buddy_pet"] as? String ?: "dog"}"
                partnerBirthday -> "birthday_${data["partner_love_buddy_pet"] as? String ?: "cat"}"
                else -> "normal"
            }
        }

        if (backgroundKey == "love_dog_to_cat" || backgroundKey == "love_cat_to_dog") {
            val lastSentAtMs = extractTimestampMillis(data["widget_last_love_sent_at"])
            if (lastSentAtMs != null && System.currentTimeMillis() - lastSentAtMs >= LOVE_SENT_DURATION_MS) {
                return "normal"
            }
        }

        // travel_pack_dog_to_cat/travel_pack_cat_to_dog নিজের মতোই থাকে —
        // ToglyWidgetProvider এদের জন্য আলাদা background + reverse animation দেখায়
        return backgroundKey
    }

    // Firestore Timestamp (.toDate()) বা epoch millis Number — দুটোই হ্যান্ডেল করে
    fun extractTimestampMillis(value: Any?): Long? {
        if (value == null) return null
        return try {
            val toDateMethod = value.javaClass.getMethod("toDate")
            (toDateMethod.invoke(value) as? java.util.Date)?.time
        } catch (e: Exception) {
            (value as? Number)?.toLong()
        }
    }
}
