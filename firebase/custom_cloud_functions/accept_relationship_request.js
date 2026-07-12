const functions = require("firebase-functions");
const admin = require("firebase-admin");

try {
  admin.app();
} catch {
  admin.initializeApp();
}

const db = admin.firestore();
const messaging = admin.messaging();

const REGION = "europe-west3";
const REQUESTS_COL = "relationship_requests";
const REL_COL = "relationships";
const USERS_COL = "Users";
const PUBLIC_COL = "PublicUsers";
const REL_VIEWS_COL = "relationship_views";

const ROUTE_ON_TAP = "home";

// --------------------------------------------------
// Generic helpers
// --------------------------------------------------

function nonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : "";
}

function firstNonEmpty(...values) {
  for (const value of values) {
    const result = nonEmptyString(value);
    if (result) return result;
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

function toTimestampOrNull(value) {
  try {
    if (!value) return null;

    if (typeof value.toMillis === "function") {
      return value;
    }

    if (value instanceof Date) {
      return admin.firestore.Timestamp.fromDate(value);
    }

    if (typeof value === "number" && Number.isFinite(value)) {
      return admin.firestore.Timestamp.fromMillis(value);
    }

    if (typeof value === "string") {
      const date = new Date(value);

      if (!Number.isNaN(date.getTime())) {
        return admin.firestore.Timestamp.fromDate(date);
      }
    }

    return null;
  } catch {
    return null;
  }
}

function utcDayKeyFromTs(timestamp) {
  if (!timestamp || typeof timestamp.toDate !== "function") {
    return "";
  }

  const date = timestamp.toDate();
  const year = date.getUTCFullYear();
  const month = String(date.getUTCMonth() + 1).padStart(2, "0");
  const day = String(date.getUTCDate()).padStart(2, "0");

  return `${year}-${month}-${day}`;
}

function pickTogetherSince(timestampA, timestampB) {
  const a = timestampA || null;
  const b = timestampB || null;

  if (!a && !b) {
    return {
      togetherSince: null,
      conflict: false,
      source: "none",
    };
  }

  if (a && !b) {
    return {
      togetherSince: a,
      conflict: false,
      source: "single_a",
    };
  }

  if (!a && b) {
    return {
      togetherSince: b,
      conflict: false,
      source: "single_b",
    };
  }

  const dayA = utcDayKeyFromTs(a);
  const dayB = utcDayKeyFromTs(b);

  if (dayA && dayB && dayA === dayB) {
    return {
      togetherSince: a,
      conflict: false,
      source: "match_day",
    };
  }

  const earlierTimestamp = a.toMillis() <= b.toMillis() ? a : b;

  return {
    togetherSince: earlierTimestamp,
    conflict: true,
    source: "min_mismatch",
  };
}

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

function calculateInitialDistanceKm(userA, userB) {
  const latA = toNumberOrNull(userA.home_lat);
  const lngA = toNumberOrNull(userA.home_lng);
  const latB = toNumberOrNull(userB.home_lat);
  const lngB = toNumberOrNull(userB.home_lng);

  if (latA === null || lngA === null || latB === null || lngB === null) {
    return null;
  }

  return Math.max(0, Math.round(haversineKm(latA, lngA, latB, lngB)));
}

// --------------------------------------------------
// Language / notification helpers
// --------------------------------------------------

async function getUserLang(uid) {
  try {
    if (!uid) return "en";

    const snapshot = await db.collection(USERS_COL).doc(uid).get();

    let language = snapshot.exists
      ? String(snapshot.get("appLanguage") || "")
          .trim()
          .toLowerCase()
      : "";

    if (language.includes("_")) {
      language = language.split("_")[0];
    }

    if (language.includes("-")) {
      language = language.split("-")[0];
    }

    return ["en", "de", "es"].includes(language) ? language : "en";
  } catch {
    return "en";
  }
}

function t(language, translations) {
  if (language === "de") return translations.de;
  if (language === "es") return translations.es;
  return translations.en;
}

async function getTokensForUid(uid) {
  const snapshot = await db
    .collection(USERS_COL)
    .doc(uid)
    .collection("fcm_tokens")
    .get();

  if (snapshot.empty) return [];

  return snapshot.docs
    .map(
      (document) =>
        document.get("fcm_token") || document.get("token") || document.id,
    )
    .filter((token) => typeof token === "string" && token.length > 10);
}

async function canReceiveRelationshipAlerts(uid) {
  try {
    const snapshot = await db.collection(USERS_COL).doc(uid).get();

    const user = snapshot.exists ? snapshot.data() || {} : {};

    if (user.muteAllNotifications === true) {
      return false;
    }

    if (user.relationshipAlertsEnabled !== true) {
      return false;
    }

    return true;
  } catch {
    return false;
  }
}

async function getPublicName(uid) {
  try {
    const snapshot = await db.collection(PUBLIC_COL).doc(uid).get();

    const publicUser = snapshot.exists ? snapshot.data() || {} : {};

    return firstNonEmpty(
      publicUser.display_name,
      publicUser.displayName,
      publicUser.name,
      publicUser.full_name,
      publicUser.fullName,
    );
  } catch {
    return "";
  }
}

async function pushConnectedToUid(targetUid, partnerName, relationshipId) {
  const allowed = await canReceiveRelationshipAlerts(targetUid);

  if (!allowed) return;

  const tokens = await getTokensForUid(targetUid);

  if (!tokens.length) return;

  const language = await getUserLang(targetUid);

  const title = t(language, {
    en: "You’re connected 💜",
    de: "Ihr seid verbunden 💜",
    es: "¡Ya están conectados! 💜",
  });

  const body = partnerName
    ? t(language, {
        en: `You and ${partnerName} are now connected. Say hi 💫`,
        de: `Du und ${partnerName} seid jetzt verbunden. Sag kurz Hallo 💫`,
        es: `Tú y ${partnerName} ya están conectados. Di hola 💫`,
      })
    : t(language, {
        en: "You’re now connected. Say hi 💫",
        de: "Ihr seid jetzt verbunden. Sag kurz Hallo 💫",
        es: "Ya están conectados. Di hola 💫",
      });

  await messaging.sendEachForMulticast({
    tokens,
    notification: {
      title,
      body,
    },
    data: {
      type: "relationship_connected",
      route: ROUTE_ON_TAP,
      relationshipId: String(relationshipId || ""),
    },
  });
}

async function getPublicUserByUid(uid) {
  try {
    if (!uid) return null;

    const directSnapshot = await db.collection(PUBLIC_COL).doc(uid).get();

    if (directSnapshot.exists) {
      return directSnapshot.data() || null;
    }

    const querySnapshot = await db
      .collection(PUBLIC_COL)
      .where("uid", "==", uid)
      .limit(1)
      .get();

    if (querySnapshot.empty) return null;

    return querySnapshot.docs[0].data() || null;
  } catch {
    return null;
  }
}

// --------------------------------------------------
// Profile builder
// --------------------------------------------------

function buildProfile(userData, publicData, fallbackPet) {
  const user = userData || {};
  const publicUser = publicData || {};

  return {
    name: firstNonEmpty(
      user.name,
      user.display_name,
      user.displayName,
      publicUser.name,
      publicUser.display_name,
      publicUser.displayName,
    ),

    photoUrl: firstNonEmpty(
      user.photo_url,
      user.photoUrl,
      publicUser.photo_url,
      publicUser.photoUrl,
    ),

    city: firstNonEmpty(user.city, publicUser.city),

    countryCode: firstNonEmpty(
      user.country_code,
      user.countryCode,
      publicUser.country_code,
      publicUser.countryCode,
    ),

    countryName: firstNonEmpty(
      user.country_name,
      user.countryName,
      publicUser.country_name,
      publicUser.countryName,
    ),

    homeLat: toNumberOrNull(
      user.home_lat ??
        user.homeLat ??
        publicUser.home_lat ??
        publicUser.homeLat,
    ),

    homeLng: toNumberOrNull(
      user.home_lng ??
        user.homeLng ??
        publicUser.home_lng ??
        publicUser.homeLng,
    ),

    loveCode: firstNonEmpty(
      user.love_code,
      user.loveCode,
      publicUser.love_code,
      publicUser.loveCode,
    ),

    loveBuddyName: firstNonEmpty(
      user.my_love_buddy_name,
      user.love_buddy_name,
      user.loveBuddyName,
      publicUser.my_love_buddy_name,
      publicUser.love_buddy_name,
      publicUser.loveBuddyName,
    ),

    loveBuddyPet:
      firstNonEmpty(
        user.my_love_buddy_pet,
        user.love_buddy_pet,
        user.loveBuddyPet,
        publicUser.my_love_buddy_pet,
        publicUser.love_buddy_pet,
        publicUser.loveBuddyPet,
      ) || fallbackPet,

    tzOffsetMinutes:
      toNumberOrNull(
        user.tz_offset_minutes ??
          user.my_tz_offset_minutes ??
          publicUser.tz_offset_minutes ??
          publicUser.my_tz_offset_minutes,
      ) ?? 0,
  };
}

// --------------------------------------------------
// Complete relationship initialization
// --------------------------------------------------

async function initializeRelationshipSystemInternal({
  relationshipId,
  userAUid,
  userBUid,
  userAData,
  userBData,
  publicAData,
  publicBData,
  nowTs,
}) {
  const relationshipRef = db.collection(REL_COL).doc(relationshipId);

  const userAViewRef = db.collection(REL_VIEWS_COL).doc(userAUid);

  const userBViewRef = db.collection(REL_VIEWS_COL).doc(userBUid);

  const profileA = buildProfile(userAData, publicAData, "dog");

  const profileB = buildProfile(userBData, publicBData, "cat");

  const distanceKm = calculateInitialDistanceKm(
    {
      home_lat: profileA.homeLat,
      home_lng: profileA.homeLng,
    },
    {
      home_lat: profileB.homeLat,
      home_lng: profileB.homeLng,
    },
  );

  const relationshipUpdate = {
    love_buddies_current_distance_km: distanceKm,

    love_buddies_start_distance_km: distanceKm,

    love_buddies_distance_updated_at: nowTs,

    love_buddies_user_a_name: profileA.loveBuddyName || profileA.name || "Bam",

    love_buddies_user_a_pet: profileA.loveBuddyPet,

    love_buddies_user_b_name: profileB.loveBuddyName || profileB.name || "Mimi",

    love_buddies_user_b_pet: profileB.loveBuddyPet,

    love_buddies_last_love_sent_at: null,

    love_buddies_last_love_sent_by_uid: null,

    love_buddies_last_love_sent_type: "normal",

    love_buddies_birthday_active: false,

    love_buddies_birthday_user_uids: [],

    love_buddies_birthday_started_at: null,

    love_buddies_birthday_ended_at: null,

    love_buddies_travel_upcoming_active: false,

    love_buddies_travel_active: false,

    love_buddies_travel_pack_active: false,

    love_buddies_together_active: false,

    love_buddies_traveler_uid: null,

    love_buddies_destination_uid: null,

    love_buddies_returning_uid: null,

    love_buddies_travel_event_id: null,

    love_buddies_travel_all_day: false,

    love_buddies_travel_started_at: null,

    love_buddies_travel_target_at: null,

    love_buddies_together_started_at: null,

    love_buddies_return_started_at: null,

    love_buddies_return_completed_at: null,

    love_buddies_live_location_active: false,

    love_buddies_live_location_mode: "off",

    love_buddies_live_traveler_uid: null,

    love_buddies_live_lat: null,

    love_buddies_live_lng: null,

    love_buddies_live_accuracy_meters: null,

    love_buddies_live_distance_km: distanceKm,

    love_buddies_live_location_updated_at: null,

    love_buddies_widget_state: "normal",

    love_buddies_widget_background_key: "normal",

    love_buddies_widget_distance_progress: 0,

    love_buddies_widget_returning_uid: null,

    love_buddies_widget_birthday_active: false,

    love_buddies_widget_birthday_user_uids: [],

    love_buddies_widget_updated_at: nowTs,

    love_buddies_updated_at: nowTs,

    updated_at: nowTs,
  };

  const commonViewDefaults = {
    relationship_id: relationshipId,

    relationship_status: "active",

    love_score: 65,

    love_percent: 0.65,

    love_state: "happy",

    love_last_update: nowTs,

    love_today_points: 0,

    my_mood: "",

    my_mood_updated_at: nowTs,

    partner_mood: "",

    partner_mood_updated_at: nowTs,

    my_sleep_status: false,

    my_sleep_status_updated_at: nowTs,

    my_sleep_started_at: null,

    my_sleep_ended_at: null,

    my_sleep_checkin_12h_sent: false,

    partner_sleep_status: false,

    partner_sleep_status_updated_at: nowTs,

    partner_sleep_started_at: null,

    partner_sleep_ended_at: null,

    partner_sleep_checkin_12h_sent: false,

    live_location_active: false,

    live_location_mode: "off",

    live_travel_tracking_enabled: false,

    live_travel_tracking_prompt_event_id: "",

    widget_state: "normal",

    widget_background_key: "normal",

    widget_distance_km: distanceKm,

    widget_distance_progress: 0,

    widget_traveler_uid: null,

    widget_returning_uid: null,

    widget_travel_event_id: "",

    widget_last_love_sent_by_uid: null,

    widget_last_love_sent_at: null,

    widget_last_love_sent_type: "normal",

    widget_birthday_active: false,

    widget_birthday_user_uids: [],

    widget_updated_at: nowTs,

    updated_at: nowTs,
  };

  const userAViewUpdate = {
    uid: userAUid,

    partner_uid: userBUid,

    ...commonViewDefaults,

    my_name: profileA.name,

    my_photo_url: profileA.photoUrl,

    my_city: profileA.city,

    my_country_code: profileA.countryCode,

    my_country_name: profileA.countryName,

    my_home_lat: profileA.homeLat,

    my_home_lng: profileA.homeLng,

    my_love_code: profileA.loveCode,

    my_love_buddy_name: profileA.loveBuddyName || profileA.name || "Bam",

    my_love_buddy_pet: profileA.loveBuddyPet,

    my_tz_offset_minutes: profileA.tzOffsetMinutes,

    my_tz_offset_updated_at: nowTs,

    partner_name: profileB.name,

    partner_photo_url: profileB.photoUrl,

    partner_city: profileB.city,

    partner_country_code: profileB.countryCode,

    partner_country_name: profileB.countryName,

    partner_home_lat: profileB.homeLat,

    partner_home_lng: profileB.homeLng,

    partner_love_code: profileB.loveCode,

    partner_love_buddy_name: profileB.loveBuddyName || profileB.name || "Mimi",

    partner_love_buddy_pet: profileB.loveBuddyPet,

    partner_tz_offset_minutes: profileB.tzOffsetMinutes,

    partner_tz_offset_updated_at: nowTs,

    profile_synced_at: nowTs,
  };

  const userBViewUpdate = {
    uid: userBUid,

    partner_uid: userAUid,

    ...commonViewDefaults,

    my_name: profileB.name,

    my_photo_url: profileB.photoUrl,

    my_city: profileB.city,

    my_country_code: profileB.countryCode,

    my_country_name: profileB.countryName,

    my_home_lat: profileB.homeLat,

    my_home_lng: profileB.homeLng,

    my_love_code: profileB.loveCode,

    my_love_buddy_name: profileB.loveBuddyName || profileB.name || "Mimi",

    my_love_buddy_pet: profileB.loveBuddyPet,

    my_tz_offset_minutes: profileB.tzOffsetMinutes,

    my_tz_offset_updated_at: nowTs,

    partner_name: profileA.name,

    partner_photo_url: profileA.photoUrl,

    partner_city: profileA.city,

    partner_country_code: profileA.countryCode,

    partner_country_name: profileA.countryName,

    partner_home_lat: profileA.homeLat,

    partner_home_lng: profileA.homeLng,

    partner_love_code: profileA.loveCode,

    partner_love_buddy_name: profileA.loveBuddyName || profileA.name || "Bam",

    partner_love_buddy_pet: profileA.loveBuddyPet,

    partner_tz_offset_minutes: profileA.tzOffsetMinutes,

    partner_tz_offset_updated_at: nowTs,

    profile_synced_at: nowTs,
  };

  const batch = db.batch();

  batch.set(relationshipRef, relationshipUpdate, {
    merge: true,
  });

  batch.set(userAViewRef, userAViewUpdate, {
    merge: true,
  });

  batch.set(userBViewRef, userBViewUpdate, {
    merge: true,
  });

  await batch.commit();

  return {
    distanceKm,
  };
}

// --------------------------------------------------
// Texts
// --------------------------------------------------

const TEXT = {
  unauth: {
    en: "Please log in again.",
    de: "Bitte melde dich erneut an.",
    es: "Por favor, inicia sesión de nuevo.",
  },

  missingRequestId: {
    en: "Missing requestId.",
    de: "Anfrage-ID fehlt.",
    es: "Falta el requestId.",
  },

  notFound: {
    en: "Request not found.",
    de: "Anfrage nicht gefunden.",
    es: "Solicitud no encontrada.",
  },

  notPending: {
    en: "This request is no longer pending.",
    de: "Diese Anfrage ist nicht mehr offen.",
    es: "Esta solicitud ya no está pendiente.",
  },

  onlyTarget: {
    en: "Only the invited person can accept this request.",
    de: "Nur die eingeladene Person kann diese Anfrage annehmen.",
    es: "Solo la persona invitada puede aceptar esta solicitud.",
  },

  missingUsers: {
    en: "Something is missing. Please try again.",
    de: "Da fehlt etwas. Bitte versuch es erneut.",
    es: "Falta algo. Por favor, inténtalo de nuevo.",
  },

  alreadyConnected: {
    en: "One of you is already connected.",
    de: "Eine:r von euch ist bereits verbunden.",
    es: "Uno de ustedes ya está conectado.",
  },

  success: {
    en: "You’re connected now 💜",
    de: "Ihr seid jetzt verbunden 💜",
    es: "¡Ya están conectados! 💜",
  },

  errorGeneric: {
    en: "Something went wrong. Please try again.",
    de: "Etwas ist schiefgelaufen. Bitte versuch es erneut.",
    es: "Algo salió mal. Por favor, inténtalo de nuevo.",
  },
};

// --------------------------------------------------
// Main callable function
// --------------------------------------------------

exports.acceptRelationshipRequest = functions
  .region(REGION)
  .https.onCall(async (data, context) => {
    const callerUid = context.auth?.uid;
    const language = await getUserLang(callerUid);

    const requestId = nonEmptyString(
      data?.requestId ?? data?.requestid ?? data?.request_id ?? "",
    );

    if (!callerUid) {
      return {
        ok: false,
        code: "UNAUTHENTICATED",
        message: TEXT.unauth[language],
        relationshipId: "",
      };
    }

    if (!requestId) {
      return {
        ok: false,
        code: "MISSING_REQUEST_ID",
        message: TEXT.missingRequestId[language],
        relationshipId: "",
      };
    }

    try {
      const requestRef = db.collection(REQUESTS_COL).doc(requestId);

      const requestSnapshot = await requestRef.get();

      if (!requestSnapshot.exists) {
        return {
          ok: false,
          code: "NOT_FOUND",
          message: TEXT.notFound[language],
          relationshipId: "",
        };
      }

      const request = requestSnapshot.data() || {};

      if (request.status !== "pending") {
        return {
          ok: false,
          code: "NOT_PENDING",
          message: TEXT.notPending[language],
          relationshipId: "",
        };
      }

      if (request.target_id !== callerUid) {
        return {
          ok: false,
          code: "NOT_TARGET",
          message: TEXT.onlyTarget[language],
          relationshipId: "",
        };
      }

      const initiatorUid = nonEmptyString(request.initiator_id);

      const targetUid = nonEmptyString(request.target_id);

      if (!initiatorUid || !targetUid) {
        return {
          ok: false,
          code: "MISSING_USERS",
          message: TEXT.missingUsers[language],
          relationshipId: "",
        };
      }

      const [initiatorUserSnapshot, targetUserSnapshot, publicA, publicB] =
        await Promise.all([
          db.collection(USERS_COL).doc(initiatorUid).get(),

          db.collection(USERS_COL).doc(targetUid).get(),

          getPublicUserByUid(initiatorUid),
          getPublicUserByUid(targetUid),
        ]);

      if (!initiatorUserSnapshot.exists || !targetUserSnapshot.exists) {
        return {
          ok: false,
          code: "MISSING_USERS",
          message: TEXT.missingUsers[language],
          relationshipId: "",
        };
      }

      const initiatorUser = initiatorUserSnapshot.data() || {};

      const targetUser = targetUserSnapshot.data() || {};

      const initiatorRelationshipId = nonEmptyString(
        initiatorUser.relationship_id,
      );

      const targetRelationshipId = nonEmptyString(targetUser.relationship_id);

      if (initiatorRelationshipId || targetRelationshipId) {
        return {
          ok: false,
          code: "ALREADY_CONNECTED",
          message: TEXT.alreadyConnected[language],
          relationshipId: "",
        };
      }

      const togetherTimestampA = toTimestampOrNull(
        publicA?.together_since ?? initiatorUser.together_since,
      );

      const togetherTimestampB = toTimestampOrNull(
        publicB?.together_since ?? targetUser.together_since,
      );

      const togetherResult = pickTogetherSince(
        togetherTimestampA,
        togetherTimestampB,
      );

      const nowTs = admin.firestore.Timestamp.now();

      const relationshipRef = db.collection(REL_COL).doc();

      const relationshipId = relationshipRef.id;

      await db.runTransaction(async (transaction) => {
        const relationshipPayload = {
          relationship_id: relationshipId,

          userA_id: initiatorUid,

          userB_id: targetUid,

          active: true,

          status: "active",

          relationship_status: "active",

          created_at: nowTs,

          updated_at: nowTs,

          started_at: nowTs,
        };

        if (togetherResult.togetherSince) {
          relationshipPayload.together_since = togetherResult.togetherSince;

          relationshipPayload.together_since_set_at = nowTs;

          relationshipPayload.together_since_conflict =
            togetherResult.conflict === true;

          relationshipPayload.together_since_source =
            togetherResult.source || "none";
        }

        transaction.set(relationshipRef, relationshipPayload);

        transaction.set(
          db.collection(USERS_COL).doc(initiatorUid),
          {
            relationship_id: relationshipId,

            partnerUID: targetUid,

            relationship_status: "active",

            updated_at: nowTs,
          },
          {
            merge: true,
          },
        );

        transaction.set(
          db.collection(USERS_COL).doc(targetUid),
          {
            relationship_id: relationshipId,

            partnerUID: initiatorUid,

            relationship_status: "active",

            updated_at: nowTs,
          },
          {
            merge: true,
          },
        );

        transaction.set(
          db.collection(PUBLIC_COL).doc(initiatorUid),
          {
            relationship_id: relationshipId,

            partnerUID: targetUid,

            relationship_status: "active",

            updated_at: nowTs,
          },
          {
            merge: true,
          },
        );

        transaction.set(
          db.collection(PUBLIC_COL).doc(targetUid),
          {
            relationship_id: relationshipId,

            partnerUID: initiatorUid,

            relationship_status: "active",

            updated_at: nowTs,
          },
          {
            merge: true,
          },
        );

        transaction.update(requestRef, {
          status: "accepted",

          relationship_id: relationshipId,

          relationship_status: "active",

          updated_at: nowTs,
        });
      });

      const initialization = await initializeRelationshipSystemInternal({
        relationshipId,
        userAUid: initiatorUid,

        userBUid: targetUid,

        userAData: initiatorUser,

        userBData: targetUser,

        publicAData: publicA,

        publicBData: publicB,

        nowTs,
      });

      const [initiatorName, targetName] = await Promise.all([
        getPublicName(initiatorUid),
        getPublicName(targetUid),
      ]);

      await Promise.all([
        pushConnectedToUid(initiatorUid, targetName, relationshipId).catch(
          () => null,
        ),

        pushConnectedToUid(targetUid, initiatorName, relationshipId).catch(
          () => null,
        ),
      ]);

      return {
        ok: true,

        code: "OK",

        message: TEXT.success[language],

        relationshipId,

        relationship_status: "active",

        together_since_conflict: togetherResult.conflict === true,

        initial_distance_km: initialization.distanceKm,
      };
    } catch (error) {
      console.error("[acceptRelationshipRequest] failed:", error);

      return {
        ok: false,
        code: "ERROR",
        message: TEXT.errorGeneric[language],
        relationshipId: "",
      };
    }
  });
