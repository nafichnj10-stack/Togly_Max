package com.trinityx.togetherly

// ✅ client feedback item 5: এই লজিকটা আগে LoveBuddyLiveService-এর ভেতরে
// private ফাংশন হিসেবে ছিল। এখন এটা আলাদা shared object-এ বের করে আনা
// হয়েছে, যাতে LoveBuddyLiveService (live Firestore listener) আর
// LoveStateRefreshReceiver (love_sent-এর ৩০ মিনিট পরের one-shot alarm
// refresh) — দুটোই ঠিক একই লজিক ব্যবহার করে, কোনো ভিন্নতা/bug তৈরি না হয়।
object WidgetStateResolver {

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
        // travel_pack_dog_to_cat/travel_pack_cat_to_dog নিজের মতোই থাকে —
        // ToglyWidgetProvider এদের জন্য আলাদা background + reverse animation দেখায়
        return backgroundKey
    }
}
