const functions = require("firebase-functions");
const admin = require("firebase-admin");

try {
  admin.app();
} catch {
  admin.initializeApp();
}

const db = admin.firestore();

const REGION = "europe-west3";
const USERS_COL = "Users";
const PUBLIC_USERS_COL = "PublicUsers";
const RELATIONSHIPS_COL = "relationships";
const RELATIONSHIP_VIEWS_COL = "relationship_views";
const RECONNECT_REQUESTS_COL = "reconnect_requests";

// --------------------------------------------------
// Basic helpers
// --------------------------------------------------

function nonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : "";
}

function firstNonEmpty(...values) {
  for (const value of values) {
    const result = nonEmptyString(value);

    if (result) {
      return result;
    }
  }

  return "";
}

function toNumberOrNull(value) {
  if (value === null || value === undefined || value === "") {
    return null;
  }

  const numberValue = Number(value);

  return Number.isFinite(numberValue) ? numberValue : null;
}

function normalizeLanguage(raw) {
  let language = String(raw || "en")
    .toLowerCase()
    .trim();

  if (language.includes("-")) {
    language = language.split("-")[0];
  }

  if (language.includes("_")) {
    language = language.split("_")[0];
  }

  return ["de", "en", "es"].includes(language) ? language : "en";
}

async function getUserLanguage(uid) {
  try {
    const snapshot = await db.collection(USERS_COL).doc(uid).get();

    return normalizeLanguage(
      snapshot.exists ? snapshot.get("appLanguage") : "en",
    );
  } catch {
    return "en";
  }
}

function translate(language, key) {
  const messages = {
    en: {
      AUTH: "Please sign in to continue.",
      REQUEST_ID_REQUIRED: "Please provide a valid request id.",
      REQUEST_NOT_FOUND: "We couldn’t find this request.",
      ONLY_TARGET: "Only your partner can accept this request.",
      REQUEST_MISSING_RELATIONSHIP:
        "This request is missing the relationship data.",
      RELATIONSHIP_MISSING:
        "We couldn’t find the relationship for this request.",
      WINDOW_EXPIRED: "The reconnect window has expired.",
      RELATIONSHIP_NEEDS_TWO: "This relationship must have two members.",
      ALREADY_RESOLVED: "This request is no longer pending.",
      SUCCESS: "You’re connected again 💕",
      ERROR: "Something went wrong. Please try again.",
    },

    de: {
      AUTH: "Bitte melde dich an, um fortzufahren.",
      REQUEST_ID_REQUIRED: "Bitte gib eine gültige Anfrage-ID an.",
      REQUEST_NOT_FOUND: "Diese Anfrage konnten wir nicht finden.",
      ONLY_TARGET: "Nur dein Partner kann diese Anfrage annehmen.",
      REQUEST_MISSING_RELATIONSHIP:
        "Bei dieser Anfrage fehlen Beziehungsdaten.",
      RELATIONSHIP_MISSING:
        "Die Beziehung zu dieser Anfrage konnten wir nicht finden.",
      WINDOW_EXPIRED: "Das Zeitfenster zum Wiederverbinden ist abgelaufen.",
      RELATIONSHIP_NEEDS_TWO:
        "Diese Beziehung muss aus zwei Personen bestehen.",
      ALREADY_RESOLVED: "Diese Anfrage ist nicht mehr offen.",
      SUCCESS: "Ihr seid wieder verbunden 💕",
      ERROR: "Etwas ist schiefgelaufen. Bitte versuche es erneut.",
    },

    es: {
      AUTH: "Inicia sesión para continuar.",
      REQUEST_ID_REQUIRED: "Por favor, indica un ID de solicitud válido.",
      REQUEST_NOT_FOUND: "No pudimos encontrar esta solicitud.",
      ONLY_TARGET: "Solo tu pareja puede aceptar esta solicitud.",
      REQUEST_MISSING_RELATIONSHIP:
        "A esta solicitud le faltan datos de la relación.",
      RELATIONSHIP_MISSING:
        "No pudimos encontrar la relación de esta solicitud.",
      WINDOW_EXPIRED: "El plazo para reconectar ha expirado.",
      RELATIONSHIP_NEEDS_TWO: "Esta relación debe tener dos miembros.",
      ALREADY_RESOLVED: "Esta solicitud ya no está pendiente.",
      SUCCESS: "Están conectados de nuevo 💕",
      ERROR: "Algo salió mal. Inténtalo de nuevo.",
    },
  };

  return messages[language]?.[key] || messages.en[key];
}

function clamp(number, minimum, maximum) {
  return Math.max(minimum, Math.min(maximum, number));
}

function loveStateFromScore(score) {
  if (score >= 65) return "happy";
  if (score >= 30) return "sad";
  return "angry";
}

// --------------------------------------------------
// PublicUsers helpers
// --------------------------------------------------

async function getPublicUserData(uid) {
  try {
    const directSnapshot = await db.collection(PUBLIC_USERS_COL).doc(uid).get();

    if (directSnapshot.exists) {
      return directSnapshot.data() || {};
    }

    const querySnapshot = await db
      .collection(PUBLIC_USERS_COL)
      .where("uid", "==", uid)
      .limit(1)
      .get();

    if (querySnapshot.empty) {
      return {};
    }

    return querySnapshot.docs[0].data() || {};
  } catch {
    return {};
  }
}

async function getPublicUserReferences(uid) {
  const references = new Map();

  const directReference = db.collection(PUBLIC_USERS_COL).doc(uid);

  const directSnapshot = await directReference.get();

  if (directSnapshot.exists) {
    references.set(directReference.path, directReference);
  }

  const querySnapshot = await db
    .collection(PUBLIC_USERS_COL)
    .where("uid", "==", uid)
    .limit(10)
    .get();

  querySnapshot.docs.forEach((document) => {
    references.set(document.ref.path, document.ref);
  });

  /*
   * PublicUsers normally uses uid as document ID.
   * Include the direct reference even if the document
   * does not currently exist, so it can be repaired.
   */
  references.set(directReference.path, directReference);

  return Array.from(references.values());
}

// --------------------------------------------------
// Distance helpers
// --------------------------------------------------

function haversineKm(lat1, lng1, lat2, lng2) {
  const earthRadiusKm = 6371;

  const latDifference = ((lat2 - lat1) * Math.PI) / 180;

  const lngDifference = ((lng2 - lng1) * Math.PI) / 180;

  const value =
    Math.sin(latDifference / 2) ** 2 +
    Math.cos((lat1 * Math.PI) / 180) *
      Math.cos((lat2 * Math.PI) / 180) *
      Math.sin(lngDifference / 2) ** 2;

  const centralAngle = 2 * Math.atan2(Math.sqrt(value), Math.sqrt(1 - value));

  return earthRadiusKm * centralAngle;
}

function calculateDistanceKm(profileA, profileB) {
  const latA = profileA.homeLat;
  const lngA = profileA.homeLng;
  const latB = profileB.homeLat;
  const lngB = profileB.homeLng;

  if (latA === null || lngA === null || latB === null || lngB === null) {
    return null;
  }

  return Math.max(0, Math.round(haversineKm(latA, lngA, latB, lngB)));
}

// --------------------------------------------------
// Profile helpers
// --------------------------------------------------

function buildProfile(userData, publicUserData, existingView, fallbackPet) {
  const user = userData || {};
  const publicUser = publicUserData || {};
  const view = existingView || {};

  return {
    name: firstNonEmpty(
      user.name,
      user.display_name,
      user.displayName,
      publicUser.name,
      publicUser.display_name,
      publicUser.displayName,
      view.my_name,
    ),

    photoUrl: firstNonEmpty(
      user.photo_url,
      user.photoUrl,
      publicUser.photo_url,
      publicUser.photoUrl,
      view.my_photo_url,
    ),

    city: firstNonEmpty(user.city, publicUser.city, view.my_city),

    countryCode: firstNonEmpty(
      user.country_code,
      user.countryCode,
      publicUser.country_code,
      publicUser.countryCode,
      view.my_country_code,
    ),

    countryName: firstNonEmpty(
      user.country_name,
      user.countryName,
      publicUser.country_name,
      publicUser.countryName,
      view.my_country_name,
    ),

    homeLat: toNumberOrNull(
      user.home_lat ??
        user.homeLat ??
        publicUser.home_lat ??
        publicUser.homeLat ??
        view.my_home_lat,
    ),

    homeLng: toNumberOrNull(
      user.home_lng ??
        user.homeLng ??
        publicUser.home_lng ??
        publicUser.homeLng ??
        view.my_home_lng,
    ),

    loveCode: firstNonEmpty(
      user.love_code,
      user.loveCode,
      publicUser.love_code,
      publicUser.loveCode,
      view.my_love_code,
    ),

    loveBuddyName: firstNonEmpty(
      user.my_love_buddy_name,
      user.love_buddy_name,
      user.loveBuddyName,
      publicUser.my_love_buddy_name,
      publicUser.love_buddy_name,
      publicUser.loveBuddyName,
      view.my_love_buddy_name,
    ),

    loveBuddyPet:
      firstNonEmpty(
        user.my_love_buddy_pet,
        user.love_buddy_pet,
        user.loveBuddyPet,
        publicUser.my_love_buddy_pet,
        publicUser.love_buddy_pet,
        publicUser.loveBuddyPet,
        view.my_love_buddy_pet,
      ) || fallbackPet,

    tzOffsetMinutes:
      toNumberOrNull(
        user.tz_offset_minutes ??
          user.my_tz_offset_minutes ??
          publicUser.tz_offset_minutes ??
          publicUser.my_tz_offset_minutes ??
          view.my_tz_offset_minutes,
      ) ?? 0,
  };
}

// --------------------------------------------------
// Widget-state calculation
// --------------------------------------------------

function calculateWidgetState({
  relationship,
  userAView,
  userBView,
  userAPet,
  userBPet,
  currentDistanceKm,
}) {
  const rel = relationship || {};

  const birthdayActive = rel.love_buddies_birthday_active === true;

  const travelActive = rel.love_buddies_travel_active === true;

  const travelUpcomingActive = rel.love_buddies_travel_upcoming_active === true;

  const travelPackActive = rel.love_buddies_travel_pack_active === true;

  const togetherActive =
    rel.love_buddies_together_active === true ||
    (currentDistanceKm !== null && currentDistanceKm <= 1);

  const travelerUid = nonEmptyString(rel.love_buddies_traveler_uid);

  const returningUid = nonEmptyString(rel.love_buddies_returning_uid);

  const userASleeping = userAView.my_sleep_status === true;

  const userBSleeping = userBView.my_sleep_status === true;

  const lastLoveSentAt = rel.love_buddies_last_love_sent_at;

  const lastLoveSentByUid = nonEmptyString(
    rel.love_buddies_last_love_sent_by_uid,
  );

  const loveActive =
    lastLoveSentAt &&
    typeof lastLoveSentAt.toMillis === "function" &&
    Date.now() - lastLoveSentAt.toMillis() <= 30 * 60 * 1000;

  const userAUid = nonEmptyString(rel.userA_id);

  const userBUid = nonEmptyString(rel.userB_id);

  function petForUid(uid) {
    if (uid === userAUid) return userAPet;
    if (uid === userBUid) return userBPet;
    return null;
  }

  function partnerPetForUid(uid) {
    if (uid === userAUid) return userBPet;
    if (uid === userBUid) return userAPet;
    return null;
  }

  function directionalKey(prefix, actorUid) {
    const actorPet = petForUid(actorUid);

    const partnerPet = partnerPetForUid(actorUid);

    if (!actorPet || !partnerPet) {
      return `${prefix}_dog_to_cat`;
    }

    return `${prefix}_${actorPet}_to_${partnerPet}`;
  }

  let widgetState = "normal";
  let widgetBackgroundKey = "normal";

  if (birthdayActive) {
    widgetState = "birthday";
    widgetBackgroundKey = "birthday";
  } else if (togetherActive) {
    widgetState = "together";
    widgetBackgroundKey = "together";
  } else if (userASleeping && userBSleeping) {
    widgetState = "sleeping";
    widgetBackgroundKey = "sleep_both";
  } else if (userASleeping) {
    widgetState = "sleeping";
    widgetBackgroundKey = `sleep_${userAPet}`;
  } else if (userBSleeping) {
    widgetState = "sleeping";
    widgetBackgroundKey = `sleep_${userBPet}`;
  } else if (travelPackActive && returningUid) {
    widgetState = "travel_pack";
    widgetBackgroundKey = directionalKey("travel_pack", returningUid);
  } else if (travelActive && travelerUid) {
    widgetState = "traveling";
    widgetBackgroundKey = directionalKey("travel", travelerUid);
  } else if (travelUpcomingActive && travelerUid) {
    widgetState = "travel_upcoming";
    widgetBackgroundKey = directionalKey("travel_upcoming", travelerUid);
  } else if (loveActive && lastLoveSentByUid) {
    widgetState = "love_sent";
    widgetBackgroundKey = directionalKey("love", lastLoveSentByUid);
  }

  return {
    widgetState,
    widgetBackgroundKey,
    togetherActive,
  };
}

// --------------------------------------------------
// Non-destructive reconnect repair sync
// --------------------------------------------------

async function repairRelationshipAfterReconnect({
  relationshipId,
  userAUid,
  userBUid,
  now,
}) {
  const relationshipRef = db.collection(RELATIONSHIPS_COL).doc(relationshipId);

  const userARef = db.collection(USERS_COL).doc(userAUid);

  const userBRef = db.collection(USERS_COL).doc(userBUid);

  const userAViewRef = db.collection(RELATIONSHIP_VIEWS_COL).doc(userAUid);

  const userBViewRef = db.collection(RELATIONSHIP_VIEWS_COL).doc(userBUid);

  const [
    relationshipSnapshot,
    userASnapshot,
    userBSnapshot,
    publicA,
    publicB,
    userAViewSnapshot,
    userBViewSnapshot,
  ] = await Promise.all([
    relationshipRef.get(),
    userARef.get(),
    userBRef.get(),
    getPublicUserData(userAUid),
    getPublicUserData(userBUid),
    userAViewRef.get(),
    userBViewRef.get(),
  ]);

  if (
    !relationshipSnapshot.exists ||
    !userASnapshot.exists ||
    !userBSnapshot.exists
  ) {
    throw new Error("Reconnect repair data is missing.");
  }

  const relationship = relationshipSnapshot.data() || {};

  const userA = userASnapshot.data() || {};

  const userB = userBSnapshot.data() || {};

  const existingViewA = userAViewSnapshot.exists
    ? userAViewSnapshot.data() || {}
    : {};

  const existingViewB = userBViewSnapshot.exists
    ? userBViewSnapshot.data() || {}
    : {};

  const profileA = buildProfile(userA, publicA, existingViewA, "dog");

  const profileB = buildProfile(userB, publicB, existingViewB, "cat");

  const calculatedDistanceKm = calculateDistanceKm(profileA, profileB);

  const currentDistanceKm =
    calculatedDistanceKm ??
    toNumberOrNull(relationship.love_buddies_current_distance_km) ??
    toNumberOrNull(existingViewA.widget_distance_km) ??
    toNumberOrNull(existingViewB.widget_distance_km);

  const startDistanceKm =
    toNumberOrNull(relationship.love_buddies_start_distance_km) ??
    currentDistanceKm;

  const travelerUid =
    nonEmptyString(relationship.love_buddies_traveler_uid) || null;

  const returningUid =
    nonEmptyString(relationship.love_buddies_returning_uid) || null;

  const travelEventId = nonEmptyString(
    relationship.love_buddies_travel_event_id,
  );

  const birthdayUserUids = Array.isArray(
    relationship.love_buddies_birthday_user_uids,
  )
    ? relationship.love_buddies_birthday_user_uids
    : [];

  const liveLocationActive =
    relationship.love_buddies_live_location_active === true;

  const liveLocationMode =
    nonEmptyString(relationship.love_buddies_live_location_mode) || "off";

  const userAPet = profileA.loveBuddyPet || "dog";

  const userBPet = profileB.loveBuddyPet || "cat";

  const widgetResult = calculateWidgetState({
    relationship,
    userAView: existingViewA,
    userBView: existingViewB,
    userAPet,
    userBPet,
    currentDistanceKm,
  });

  let distanceProgress =
    toNumberOrNull(relationship.love_buddies_widget_distance_progress) ?? 0;

  if (
    relationship.love_buddies_travel_active === true &&
    startDistanceKm !== null &&
    startDistanceKm > 0 &&
    currentDistanceKm !== null
  ) {
    distanceProgress =
      ((startDistanceKm - currentDistanceKm) / startDistanceKm) * 100;

    distanceProgress = Math.round(clamp(distanceProgress, 0, 100));
  }

  const relationshipUpdate = {
    active: true,
    status: "active",
    relationship_status: "active",

    love_buddies_current_distance_km: currentDistanceKm,

    love_buddies_start_distance_km: startDistanceKm,

    love_buddies_distance_updated_at: now,

    love_buddies_user_a_name: profileA.loveBuddyName || profileA.name || "Bam",

    love_buddies_user_a_pet: userAPet,

    love_buddies_user_b_name: profileB.loveBuddyName || profileB.name || "Mimi",

    love_buddies_user_b_pet: userBPet,

    love_buddies_travel_upcoming_active:
      relationship.love_buddies_travel_upcoming_active === true,

    love_buddies_travel_active:
      relationship.love_buddies_travel_active === true,

    love_buddies_travel_pack_active:
      relationship.love_buddies_travel_pack_active === true,

    love_buddies_together_active: widgetResult.togetherActive,

    love_buddies_traveler_uid: travelerUid,

    love_buddies_destination_uid:
      nonEmptyString(relationship.love_buddies_destination_uid) || null,

    love_buddies_returning_uid: returningUid,

    love_buddies_travel_event_id: travelEventId || null,

    love_buddies_travel_all_day:
      relationship.love_buddies_travel_all_day === true,

    love_buddies_live_location_active: liveLocationActive,

    love_buddies_live_location_mode: liveLocationMode,

    love_buddies_birthday_active:
      relationship.love_buddies_birthday_active === true,

    love_buddies_birthday_user_uids: birthdayUserUids,

    love_buddies_widget_state: widgetResult.widgetState,

    love_buddies_widget_background_key: widgetResult.widgetBackgroundKey,

    love_buddies_widget_distance_progress: distanceProgress,

    love_buddies_widget_returning_uid: returningUid,

    love_buddies_widget_birthday_active:
      relationship.love_buddies_birthday_active === true,

    love_buddies_widget_birthday_user_uids: birthdayUserUids,

    love_buddies_widget_updated_at: now,

    love_buddies_updated_at: now,

    updated_at: now,
  };

  const sharedViewUpdate = {
    relationship_id: relationshipId,

    relationship_status: "active",

    widget_state: widgetResult.widgetState,

    widget_background_key: widgetResult.widgetBackgroundKey,

    widget_distance_km: currentDistanceKm,

    widget_distance_progress: distanceProgress,

    widget_traveler_uid: travelerUid,

    widget_returning_uid: returningUid,

    widget_travel_event_id: travelEventId,

    widget_last_love_sent_by_uid:
      relationship.love_buddies_last_love_sent_by_uid || null,

    widget_last_love_sent_at:
      relationship.love_buddies_last_love_sent_at || null,

    widget_last_love_sent_type:
      nonEmptyString(relationship.love_buddies_last_love_sent_type) || "normal",

    widget_birthday_active: relationship.love_buddies_birthday_active === true,

    widget_birthday_user_uids: birthdayUserUids,

    live_location_active: liveLocationActive,

    live_location_mode: liveLocationMode,

    /*
     * Preserve an existing decision for the
     * current travel event. Only provide defaults
     * if these fields did not exist before.
     */
    live_travel_tracking_enabled:
      existingViewA.live_travel_tracking_enabled === true,

    widget_updated_at: now,

    updated_at: now,
  };

  const userAViewUpdate = {
    ...sharedViewUpdate,

    uid: userAUid,

    partner_uid: userBUid,

    my_name: profileA.name,

    my_photo_url: profileA.photoUrl,

    my_city: profileA.city,

    my_country_code: profileA.countryCode,

    my_country_name: profileA.countryName,

    my_home_lat: profileA.homeLat,

    my_home_lng: profileA.homeLng,

    my_love_code: profileA.loveCode,

    my_love_buddy_name: profileA.loveBuddyName || profileA.name || "Bam",

    my_love_buddy_pet: userAPet,

    my_tz_offset_minutes: profileA.tzOffsetMinutes,

    my_tz_offset_updated_at: now,

    partner_name: profileB.name,

    partner_photo_url: profileB.photoUrl,

    partner_city: profileB.city,

    partner_country_code: profileB.countryCode,

    partner_country_name: profileB.countryName,

    partner_home_lat: profileB.homeLat,

    partner_home_lng: profileB.homeLng,

    partner_love_code: profileB.loveCode,

    partner_love_buddy_name: profileB.loveBuddyName || profileB.name || "Mimi",

    partner_love_buddy_pet: userBPet,

    partner_tz_offset_minutes: profileB.tzOffsetMinutes,

    partner_tz_offset_updated_at: now,

    live_travel_tracking_enabled:
      existingViewA.live_travel_tracking_enabled === true,

    live_travel_tracking_prompt_event_id: nonEmptyString(
      existingViewA.live_travel_tracking_prompt_event_id,
    ),

    profile_synced_at: now,
  };

  const userBViewUpdate = {
    ...sharedViewUpdate,

    uid: userBUid,

    partner_uid: userAUid,

    my_name: profileB.name,

    my_photo_url: profileB.photoUrl,

    my_city: profileB.city,

    my_country_code: profileB.countryCode,

    my_country_name: profileB.countryName,

    my_home_lat: profileB.homeLat,

    my_home_lng: profileB.homeLng,

    my_love_code: profileB.loveCode,

    my_love_buddy_name: profileB.loveBuddyName || profileB.name || "Mimi",

    my_love_buddy_pet: userBPet,

    my_tz_offset_minutes: profileB.tzOffsetMinutes,

    my_tz_offset_updated_at: now,

    partner_name: profileA.name,

    partner_photo_url: profileA.photoUrl,

    partner_city: profileA.city,

    partner_country_code: profileA.countryCode,

    partner_country_name: profileA.countryName,

    partner_home_lat: profileA.homeLat,

    partner_home_lng: profileA.homeLng,

    partner_love_code: profileA.loveCode,

    partner_love_buddy_name: profileA.loveBuddyName || profileA.name || "Bam",

    partner_love_buddy_pet: userAPet,

    partner_tz_offset_minutes: profileA.tzOffsetMinutes,

    partner_tz_offset_updated_at: now,

    live_travel_tracking_enabled:
      existingViewB.live_travel_tracking_enabled === true,

    live_travel_tracking_prompt_event_id: nonEmptyString(
      existingViewB.live_travel_tracking_prompt_event_id,
    ),

    profile_synced_at: now,
  };

  const batch = db.batch();

  batch.set(relationshipRef, relationshipUpdate, { merge: true });

  batch.set(userAViewRef, userAViewUpdate, { merge: true });

  batch.set(userBViewRef, userBViewUpdate, { merge: true });

  await batch.commit();

  return {
    distanceKm: currentDistanceKm,
    widgetState: widgetResult.widgetState,
  };
}

// --------------------------------------------------
// Main callable
// --------------------------------------------------

exports.acceptReconnectRequest = functions
  .region(REGION)
  .https.onCall(async (data, context) => {
    try {
      const uid = context.auth?.uid;

      if (!uid) {
        return {
          ok: false,
          code: "AUTH_REQUIRED",
          message: translate("en", "AUTH"),
        };
      }

      const language = await getUserLanguage(uid);

      const requestId = String(data?.requestId || "").trim();

      if (!requestId) {
        return {
          ok: false,
          code: "REQUEST_ID_REQUIRED",
          message: translate(language, "REQUEST_ID_REQUIRED"),
        };
      }

      const requestRef = db.collection(RECONNECT_REQUESTS_COL).doc(requestId);

      const requestSnapshot = await requestRef.get();

      if (!requestSnapshot.exists) {
        return {
          ok: false,
          code: "REQUEST_NOT_FOUND",
          message: translate(language, "REQUEST_NOT_FOUND"),
        };
      }

      const request = requestSnapshot.data() || {};

      if (uid !== request.target_id) {
        return {
          ok: false,
          code: "ONLY_TARGET",
          message: translate(language, "ONLY_TARGET"),
        };
      }

      if (request.status && request.status !== "pending") {
        return {
          ok: true,
          code: "ALREADY_RESOLVED",
          message: translate(language, "ALREADY_RESOLVED"),
          status: request.status,
        };
      }

      const relationshipId = String(request.relationship_id || "").trim();

      if (!relationshipId) {
        return {
          ok: false,
          code: "REQUEST_MISSING_RELATIONSHIP",
          message: translate(language, "REQUEST_MISSING_RELATIONSHIP"),
        };
      }

      const relationshipRef = db
        .collection(RELATIONSHIPS_COL)
        .doc(relationshipId);

      const relationshipSnapshot = await relationshipRef.get();

      if (!relationshipSnapshot.exists) {
        return {
          ok: false,
          code: "RELATIONSHIP_MISSING",
          message: translate(language, "RELATIONSHIP_MISSING"),
        };
      }

      const relationship = relationshipSnapshot.data() || {};

      const now = admin.firestore.Timestamp.now();

      if (
        !relationship.purge_at ||
        typeof relationship.purge_at.toMillis !== "function" ||
        now.toMillis() > relationship.purge_at.toMillis()
      ) {
        await requestRef
          .update({
            status: "expired",
            relationship_status: "expired",
            updated_at: now,
          })
          .catch(() => null);

        return {
          ok: false,
          code: "WINDOW_EXPIRED",
          message: translate(language, "WINDOW_EXPIRED"),
        };
      }

      const userAUid = String(relationship.userA_id || "").trim();

      const userBUid = String(relationship.userB_id || "").trim();

      if (!userAUid || !userBUid) {
        return {
          ok: false,
          code: "RELATIONSHIP_NEEDS_TWO",
          message: translate(language, "RELATIONSHIP_NEEDS_TWO"),
        };
      }

      const [
        userAViewSnapshot,
        userBViewSnapshot,
        publicAReferences,
        publicBReferences,
      ] = await Promise.all([
        db.collection(RELATIONSHIP_VIEWS_COL).doc(userAUid).get(),

        db.collection(RELATIONSHIP_VIEWS_COL).doc(userBUid).get(),

        getPublicUserReferences(userAUid),

        getPublicUserReferences(userBUid),
      ]);

      const userAView = userAViewSnapshot.exists
        ? userAViewSnapshot.data() || {}
        : {};

      const userBView = userBViewSnapshot.exists
        ? userBViewSnapshot.data() || {}
        : {};

      const scoreA = clamp(Number(userAView.love_score ?? 65), 0, 100);

      const scoreB = clamp(Number(userBView.love_score ?? 65), 0, 100);

      await db.runTransaction(async (transaction) => {
        transaction.update(relationshipRef, {
          active: true,
          status: "active",
          relationship_status: "active",
          updated_at: now,

          disconnected_at: admin.firestore.FieldValue.delete(),

          purge_at: admin.firestore.FieldValue.delete(),

          notified_7d: admin.firestore.FieldValue.delete(),

          notified_24h: admin.firestore.FieldValue.delete(),

          notified_1h: admin.firestore.FieldValue.delete(),
        });

        transaction.set(
          db.collection(USERS_COL).doc(userAUid),
          {
            relationship_id: relationshipId,

            partnerUID: userBUid,

            relationship_status: "active",

            celebrate_reconnect: true,

            celebrate_reconnect_at: now,

            restore_required: false,

            restore_state: admin.firestore.FieldValue.delete(),

            restore_request_id: admin.firestore.FieldValue.delete(),

            restore_relationship_id: admin.firestore.FieldValue.delete(),

            disconnect_cooldown_until: admin.firestore.FieldValue.delete(),

            updated_at: now,
          },
          { merge: true },
        );

        transaction.set(
          db.collection(USERS_COL).doc(userBUid),
          {
            relationship_id: relationshipId,

            partnerUID: userAUid,

            relationship_status: "active",

            celebrate_reconnect: true,

            celebrate_reconnect_at: now,

            restore_required: false,

            restore_state: admin.firestore.FieldValue.delete(),

            restore_request_id: admin.firestore.FieldValue.delete(),

            restore_relationship_id: admin.firestore.FieldValue.delete(),

            disconnect_cooldown_until: admin.firestore.FieldValue.delete(),

            updated_at: now,
          },
          { merge: true },
        );

        publicAReferences.forEach((reference) => {
          transaction.set(
            reference,
            {
              relationship_id: relationshipId,

              partnerUID: userBUid,

              relationship_status: "active",

              updated_at: now,
            },
            { merge: true },
          );
        });

        publicBReferences.forEach((reference) => {
          transaction.set(
            reference,
            {
              relationship_id: relationshipId,

              partnerUID: userAUid,

              relationship_status: "active",

              updated_at: now,
            },
            { merge: true },
          );
        });

        transaction.set(
          db.collection(RELATIONSHIP_VIEWS_COL).doc(userAUid),
          {
            uid: userAUid,

            relationship_id: relationshipId,

            partner_uid: userBUid,

            relationship_status: "active",

            paused: admin.firestore.FieldValue.delete(),

            paused_at: admin.firestore.FieldValue.delete(),

            purge_at: admin.firestore.FieldValue.delete(),

            last_relationship_id: admin.firestore.FieldValue.delete(),

            restore_required: admin.firestore.FieldValue.delete(),

            restore_relationship_id: admin.firestore.FieldValue.delete(),

            love_score: scoreA,

            love_percent: scoreA / 100,

            love_state: loveStateFromScore(scoreA),

            love_last_update: now,

            love_today_points: userAView.love_today_points ?? 0,

            updated_at: now,
          },
          { merge: true },
        );

        transaction.set(
          db.collection(RELATIONSHIP_VIEWS_COL).doc(userBUid),
          {
            uid: userBUid,

            relationship_id: relationshipId,

            partner_uid: userAUid,

            relationship_status: "active",

            paused: admin.firestore.FieldValue.delete(),

            paused_at: admin.firestore.FieldValue.delete(),

            purge_at: admin.firestore.FieldValue.delete(),

            last_relationship_id: admin.firestore.FieldValue.delete(),

            restore_required: admin.firestore.FieldValue.delete(),

            restore_relationship_id: admin.firestore.FieldValue.delete(),

            love_score: scoreB,

            love_percent: scoreB / 100,

            love_state: loveStateFromScore(scoreB),

            love_last_update: now,

            love_today_points: userBView.love_today_points ?? 0,

            updated_at: now,
          },
          { merge: true },
        );

        transaction.update(requestRef, {
          status: "accepted",

          relationship_status: "active",

          accepted_at: now,

          updated_at: now,
        });
      });

      const repairResult = await repairRelationshipAfterReconnect({
        relationshipId,
        userAUid,
        userBUid,
        now,
      });

      return {
        ok: true,
        code: "RESTORED",
        message: translate(language, "SUCCESS"),

        relationship_id: relationshipId,

        relationship_status: "active",

        celebrate_reconnect: true,

        distance_km: repairResult.distanceKm,

        widget_state: repairResult.widgetState,
      };
    } catch (error) {
      console.error("[acceptReconnectRequest]", error);

      return {
        ok: false,
        code: "ERROR",
        message: translate("en", "ERROR"),
      };
    }
  });
