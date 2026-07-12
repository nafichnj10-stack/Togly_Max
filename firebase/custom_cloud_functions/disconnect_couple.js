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

// --------------------------------------------------
// Basic helpers
// --------------------------------------------------

function nonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : "";
}

function normalizeLanguage(raw) {
  let language = String(raw || "en")
    .toLowerCase()
    .trim();

  if (language.includes("_")) {
    language = language.split("_")[0];
  }

  if (language.includes("-")) {
    language = language.split("-")[0];
  }

  return ["en", "de", "es"].includes(language) ? language : "en";
}

async function getUserLanguage(uid) {
  try {
    if (!uid) return "en";

    const snapshot = await db.collection(USERS_COL).doc(uid).get();

    const rawLanguage = snapshot.exists ? snapshot.get("appLanguage") : "en";

    return normalizeLanguage(rawLanguage);
  } catch {
    return "en";
  }
}

function translate(language, key) {
  const messages = {
    en: {
      AUTH: "Please sign in to continue.",

      NOT_MEMBER: "This relationship doesn’t belong to you.",

      NOT_FOUND: "We couldn’t find this relationship.",

      SUCCESS:
        "You’ve disconnected for now 💔 You can reconnect within 14 days.",

      ALREADY: "You’re already disconnected 💔",

      ERROR: "Something went wrong. Please try again.",
    },

    de: {
      AUTH: "Bitte melde dich an, um fortzufahren.",

      NOT_MEMBER: "Diese Beziehung gehört nicht zu dir.",

      NOT_FOUND: "Diese Beziehung konnten wir nicht finden.",

      SUCCESS:
        "Ihr habt euch vorerst getrennt 💔 Ihr könnt euch innerhalb von 14 Tagen wieder verbinden.",

      ALREADY: "Ihr seid bereits getrennt 💔",

      ERROR: "Etwas ist schiefgelaufen. Bitte versuche es erneut.",
    },

    es: {
      AUTH: "Inicia sesión para continuar.",

      NOT_MEMBER: "Esta relación no te pertenece.",

      NOT_FOUND: "No pudimos encontrar esta relación.",

      SUCCESS:
        "Se han separado por ahora 💔 Pueden volver a conectarse en un plazo de 14 días.",

      ALREADY: "Ya están desconectados 💔",

      ERROR: "Algo salió mal. Inténtalo de nuevo.",
    },
  };

  return messages[language]?.[key] || messages.en[key];
}

// --------------------------------------------------
// PublicUsers helpers
// --------------------------------------------------

async function getPublicUserReferences(uid) {
  const references = new Map();

  /*
   * Standard document where uid is also the
   * PublicUsers document ID.
   */
  const directReference = db.collection(PUBLIC_USERS_COL).doc(uid);

  const directSnapshot = await directReference.get();

  if (directSnapshot.exists) {
    references.set(directReference.path, directReference);
  }

  /*
   * Legacy support in case PublicUsers document ID
   * is not equal to the Firebase UID.
   */
  const querySnapshot = await db
    .collection(PUBLIC_USERS_COL)
    .where("uid", "==", uid)
    .limit(10)
    .get();

  querySnapshot.docs.forEach((document) => {
    references.set(document.ref.path, document.ref);
  });

  return Array.from(references.values());
}

// --------------------------------------------------
// Main callable
// --------------------------------------------------

exports.disconnectCouple = functions
  .region(REGION)
  .https.onCall(async (data, context) => {
    try {
      const callerUid = context.auth?.uid;

      if (!callerUid) {
        return {
          ok: false,
          code: "UNAUTHENTICATED",
          message: translate("en", "AUTH"),
        };
      }

      const language = await getUserLanguage(callerUid);

      const relationshipId = nonEmptyString(
        data?.relationshipId ??
          data?.relationshipid ??
          data?.relationship_id ??
          "",
      );

      if (!relationshipId) {
        return {
          ok: false,
          code: "NOT_FOUND",
          message: translate(language, "NOT_FOUND"),
        };
      }

      const relationshipRef = db
        .collection(RELATIONSHIPS_COL)
        .doc(relationshipId);

      const relationshipSnapshot = await relationshipRef.get();

      if (!relationshipSnapshot.exists) {
        return {
          ok: false,
          code: "NOT_FOUND",
          message: translate(language, "NOT_FOUND"),
        };
      }

      const relationship = relationshipSnapshot.data() || {};

      const userAUid = nonEmptyString(relationship.userA_id);

      const userBUid = nonEmptyString(relationship.userB_id);

      const members = [userAUid, userBUid].filter(Boolean);

      if (members.length !== 2 || !members.includes(callerUid)) {
        return {
          ok: false,
          code: "NOT_MEMBER",
          message: translate(language, "NOT_MEMBER"),
        };
      }

      /*
       * Idempotent behavior:
       * If already disconnected and purge_at exists,
       * do not restart the 14-day countdown.
       */
      if (
        relationship.active === false &&
        relationship.purge_at &&
        typeof relationship.purge_at.toMillis === "function"
      ) {
        return {
          ok: true,
          code: "ALREADY",
          message: translate(language, "ALREADY"),

          relationship_id: relationshipId,

          relationship_status: "disconnect_pending",

          purge_at: relationship.purge_at.toDate().toISOString(),
        };
      }

      const now = admin.firestore.Timestamp.now();

      const purgeAt = admin.firestore.Timestamp.fromMillis(
        now.toMillis() + 14 * 24 * 60 * 60 * 1000,
      );

      const userARef = db.collection(USERS_COL).doc(userAUid);

      const userBRef = db.collection(USERS_COL).doc(userBUid);

      const userAViewRef = db.collection(RELATIONSHIP_VIEWS_COL).doc(userAUid);

      const userBViewRef = db.collection(RELATIONSHIP_VIEWS_COL).doc(userBUid);

      const [publicAReferences, publicBReferences] = await Promise.all([
        getPublicUserReferences(userAUid),
        getPublicUserReferences(userBUid),
      ]);

      // --------------------------------------------------
      // Relationship state while waiting for reconnect
      // --------------------------------------------------

      const relationshipPatch = {
        active: false,

        status: "disconnect_pending",

        relationship_status: "disconnect_pending",

        disconnected_at: now,

        disconnected_by_uid: callerUid,

        purge_at: purgeAt,

        notified_7d: false,

        notified_24h: false,

        notified_1h: false,

        /*
         * Stop every active travel phase.
         */
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

        love_buddies_return_started_at: null,

        love_buddies_return_completed_at: null,

        /*
         * Stop live GPS immediately.
         */
        love_buddies_live_location_active: false,

        love_buddies_live_location_mode: "off",

        love_buddies_live_traveler_uid: null,

        love_buddies_live_lat: null,

        love_buddies_live_lng: null,

        love_buddies_live_accuracy_meters: null,

        love_buddies_live_distance_km: null,

        love_buddies_live_location_updated_at: null,

        /*
         * Explicit paused widget state.
         * Existing relationship content stays stored,
         * but the widget no longer displays it.
         */
        love_buddies_widget_state: "paused",

        love_buddies_widget_background_key: "paused",

        love_buddies_widget_distance_progress: 0,

        love_buddies_widget_returning_uid: null,

        love_buddies_widget_updated_at: now,

        love_buddies_updated_at: now,

        updated_at: now,
      };

      // --------------------------------------------------
      // Users state
      // --------------------------------------------------

      const userPatch = {
        relationship_id: admin.firestore.FieldValue.delete(),

        partnerUID: admin.firestore.FieldValue.delete(),

        relationship_status: "disconnect_pending",

        disconnect_cooldown_until: purgeAt,

        /*
         * Reconnect / restore flow.
         */
        restore_required: true,

        restore_state: "ready_to_send",

        restore_request_id: "",

        restore_relationship_id: relationshipId,

        /*
         * Legacy restore references.
         */
        last_relationship_id: relationshipId,

        last_relationship_ref: relationshipRef,

        celebrate_reconnect: false,

        celebrate_reconnect_at: admin.firestore.FieldValue.delete(),

        updated_at: now,
      };

      // --------------------------------------------------
      // PublicUsers state
      // --------------------------------------------------

      const publicUserPatch = {
        relationship_id: admin.firestore.FieldValue.delete(),

        partnerUID: admin.firestore.FieldValue.delete(),

        relationship_status: "disconnect_pending",

        updated_at: now,
      };

      // --------------------------------------------------
      // relationship_views state
      // --------------------------------------------------

      const relationshipViewPatch = {
        relationship_id: admin.firestore.FieldValue.delete(),

        partner_uid: admin.firestore.FieldValue.delete(),

        relationship_status: "disconnect_pending",

        paused: true,

        paused_at: now,

        purge_at: purgeAt,

        last_relationship_id: relationshipId,

        restore_required: true,

        restore_relationship_id: relationshipId,

        /*
         * Widget must immediately stop showing
         * the previous active relationship state.
         */
        widget_state: "paused",

        widget_background_key: "paused",

        widget_distance_km: null,

        widget_distance_progress: 0,

        widget_traveler_uid: null,

        widget_returning_uid: null,

        widget_travel_event_id: "",

        widget_last_love_sent_by_uid: null,

        widget_last_love_sent_at: null,

        widget_last_love_sent_type: "normal",

        widget_birthday_active: false,

        widget_birthday_user_uids: [],

        widget_updated_at: now,

        /*
         * Stop location tracking and remove the
         * approval for the previous travel event.
         */
        live_location_active: false,

        live_location_mode: "off",

        live_travel_tracking_enabled: false,

        live_travel_tracking_prompt_event_id: "",

        updated_at: now,
      };

      /*
       * Core changes are written together.
       */
      const batch = db.batch();

      batch.set(relationshipRef, relationshipPatch, { merge: true });

      batch.set(userARef, userPatch, { merge: true });

      batch.set(userBRef, userPatch, { merge: true });

      batch.set(
        userAViewRef,
        {
          uid: userAUid,
          ...relationshipViewPatch,
        },
        { merge: true },
      );

      batch.set(
        userBViewRef,
        {
          uid: userBUid,
          ...relationshipViewPatch,
        },
        { merge: true },
      );

      publicAReferences.forEach((reference) => {
        batch.set(reference, publicUserPatch, { merge: true });
      });

      publicBReferences.forEach((reference) => {
        batch.set(reference, publicUserPatch, { merge: true });
      });

      await batch.commit();

      return {
        ok: true,
        code: "OK",
        message: translate(language, "SUCCESS"),

        relationship_id: relationshipId,

        relationship_status: "disconnect_pending",

        purge_at: purgeAt.toDate().toISOString(),

        disconnected_at: now.toDate().toISOString(),

        widget_state: "paused",

        live_location_active: false,
      };
    } catch (error) {
      console.error("[disconnectCouple] error:", error);

      return {
        ok: false,
        code: "ERROR",
        message: translate("en", "ERROR"),
      };
    }
  });
