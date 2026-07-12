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

function toNumberOrNull(value) {
  if (value === null || value === undefined || value === "") {
    return null;
  }

  const numberValue = Number(value);

  return Number.isFinite(numberValue) ? numberValue : null;
}

function timestampToIsoOrEmpty(value) {
  try {
    if (!value) return "";

    if (typeof value.toDate === "function") {
      return value.toDate().toISOString();
    }

    if (value instanceof Date) {
      return value.toISOString();
    }

    return "";
  } catch {
    return "";
  }
}

function toDateOrNull(value) {
  try {
    if (!value) return null;

    if (typeof value.toDate === "function") {
      return value.toDate();
    }

    if (value instanceof Date) {
      return value;
    }

    if (typeof value === "number" && Number.isFinite(value)) {
      return new Date(value);
    }

    if (typeof value === "string") {
      const parsed = new Date(value);

      if (!Number.isNaN(parsed.getTime())) {
        return parsed;
      }
    }

    return null;
  } catch {
    return null;
  }
}

function safeTimezoneOffset(value) {
  const offset = toNumberOrNull(value);

  if (offset === null) return 0;

  /*
   * Real-world timezone offsets currently remain
   * inside this range.
   */
  return Math.max(-840, Math.min(840, Math.round(offset)));
}

// --------------------------------------------------
// Birthday helpers
// --------------------------------------------------

function localDateParts(date, timezoneOffsetMinutes) {
  const shiftedDate = new Date(
    date.getTime() + timezoneOffsetMinutes * 60 * 1000,
  );

  return {
    year: shiftedDate.getUTCFullYear(),
    month: shiftedDate.getUTCMonth() + 1,
    day: shiftedDate.getUTCDate(),
  };
}

function isBirthdayToday({ birthday, timezoneOffsetMinutes, now }) {
  const birthdayDate = toDateOrNull(birthday);

  if (!birthdayDate) {
    return false;
  }

  const offset = safeTimezoneOffset(timezoneOffsetMinutes);

  const birthdayParts = localDateParts(birthdayDate, offset);

  const todayParts = localDateParts(now, offset);

  /*
   * Birth year is intentionally ignored.
   */
  return (
    birthdayParts.month === todayParts.month &&
    birthdayParts.day === todayParts.day
  );
}

// --------------------------------------------------
// Widget-state helpers
// --------------------------------------------------

function loveIsActive(relationship, nowDate) {
  const lastLoveDate = toDateOrNull(
    relationship.love_buddies_last_love_sent_at,
  );

  if (!lastLoveDate) {
    return false;
  }

  const differenceMs = nowDate.getTime() - lastLoveDate.getTime();

  return differenceMs >= 0 && differenceMs <= 30 * 60 * 1000;
}

function getRelationshipPet(relationship, uid) {
  const userAUid = nonEmptyString(relationship.userA_id);

  const userBUid = nonEmptyString(relationship.userB_id);

  if (uid === userAUid) {
    return nonEmptyString(relationship.love_buddies_user_a_pet) || "dog";
  }

  if (uid === userBUid) {
    return nonEmptyString(relationship.love_buddies_user_b_pet) || "cat";
  }

  return "dog";
}

function getPartnerPet(relationship, uid) {
  const userAUid = nonEmptyString(relationship.userA_id);

  const userBUid = nonEmptyString(relationship.userB_id);

  if (uid === userAUid) {
    return nonEmptyString(relationship.love_buddies_user_b_pet) || "cat";
  }

  if (uid === userBUid) {
    return nonEmptyString(relationship.love_buddies_user_a_pet) || "dog";
  }

  return "cat";
}

function directionalBackgroundKey({ prefix, relationship, actorUid }) {
  const actorPet = getRelationshipPet(relationship, actorUid);

  const partnerPet = getPartnerPet(relationship, actorUid);

  return `${prefix}_${actorPet}_to_${partnerPet}`;
}

function calculateNonBirthdayWidgetState({
  relationship,
  userAView,
  userBView,
  nowDate,
}) {
  const rel = relationship || {};
  const viewA = userAView || {};
  const viewB = userBView || {};

  const userAUid = nonEmptyString(rel.userA_id);

  const userBUid = nonEmptyString(rel.userB_id);

  const userAPet = getRelationshipPet(rel, userAUid);

  const userBPet = getRelationshipPet(rel, userBUid);

  const travelerUid = nonEmptyString(rel.love_buddies_traveler_uid);

  const returningUid = nonEmptyString(rel.love_buddies_returning_uid);

  const lastLoveSentByUid = nonEmptyString(
    rel.love_buddies_last_love_sent_by_uid,
  );

  const togetherActive = rel.love_buddies_together_active === true;

  const travelPackActive = rel.love_buddies_travel_pack_active === true;

  const travelActive = rel.love_buddies_travel_active === true;

  const travelUpcomingActive = rel.love_buddies_travel_upcoming_active === true;

  const userASleeping = viewA.my_sleep_status === true;

  const userBSleeping = viewB.my_sleep_status === true;

  let widgetState = "normal";
  let widgetBackgroundKey = "normal";

  /*
   * State priority below Birthday:
   *
   * Together
   * Sleep
   * Travel pack
   * Traveling
   * Travel upcoming
   * Love sent
   * Normal
   */

  if (togetherActive) {
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

    widgetBackgroundKey = directionalBackgroundKey({
      prefix: "travel_pack",
      relationship: rel,
      actorUid: returningUid,
    });
  } else if (travelActive && travelerUid) {
    widgetState = "traveling";

    widgetBackgroundKey = directionalBackgroundKey({
      prefix: "travel",
      relationship: rel,
      actorUid: travelerUid,
    });
  } else if (travelUpcomingActive && travelerUid) {
    widgetState = "travel_upcoming";

    widgetBackgroundKey = directionalBackgroundKey({
      prefix: "travel_upcoming",
      relationship: rel,
      actorUid: travelerUid,
    });
  } else if (loveIsActive(rel, nowDate) && lastLoveSentByUid) {
    widgetState = "love_sent";

    widgetBackgroundKey = directionalBackgroundKey({
      prefix: "love",
      relationship: rel,
      actorUid: lastLoveSentByUid,
    });
  }

  return {
    widgetState,
    widgetBackgroundKey,
  };
}

// --------------------------------------------------
// Birthday synchronization
// --------------------------------------------------

async function synchronizeBirthdayState({
  relationshipId,
  relationship,
  userAUid,
  userBUid,
  userA,
  userB,
  userAView,
  userBView,
  nowTimestamp,
}) {
  const nowDate = nowTimestamp.toDate();

  const userAOffset = safeTimezoneOffset(
    userA.tz_offset_minutes ?? userAView.my_tz_offset_minutes,
  );

  const userBOffset = safeTimezoneOffset(
    userB.tz_offset_minutes ?? userBView.my_tz_offset_minutes,
  );

  const userAHasBirthday = isBirthdayToday({
    birthday: userA.birthday,
    timezoneOffsetMinutes: userAOffset,
    now: nowDate,
  });

  const userBHasBirthday = isBirthdayToday({
    birthday: userB.birthday,
    timezoneOffsetMinutes: userBOffset,
    now: nowDate,
  });

  const birthdayUserUids = [];

  if (userAHasBirthday) {
    birthdayUserUids.push(userAUid);
  }

  if (userBHasBirthday) {
    birthdayUserUids.push(userBUid);
  }

  const birthdayActive = birthdayUserUids.length > 0;

  const previouslyActive = relationship.love_buddies_birthday_active === true;

  let widgetState;
  let widgetBackgroundKey;

  if (birthdayActive) {
    widgetState = "birthday";
    widgetBackgroundKey = "birthday";
  } else {
    const fallbackState = calculateNonBirthdayWidgetState({
      relationship,
      userAView,
      userBView,
      nowDate,
    });

    widgetState = fallbackState.widgetState;

    widgetBackgroundKey = fallbackState.widgetBackgroundKey;
  }

  const relationshipPatch = {
    love_buddies_birthday_active: birthdayActive,

    love_buddies_birthday_user_uids: birthdayUserUids,

    love_buddies_widget_state: widgetState,

    love_buddies_widget_background_key: widgetBackgroundKey,

    love_buddies_widget_birthday_active: birthdayActive,

    love_buddies_widget_birthday_user_uids: birthdayUserUids,

    love_buddies_widget_updated_at: nowTimestamp,

    love_buddies_updated_at: nowTimestamp,

    updated_at: nowTimestamp,
  };

  /*
   * Only change start/end timestamps when the
   * birthday state actually changes.
   */
  if (birthdayActive && !previouslyActive) {
    relationshipPatch.love_buddies_birthday_started_at = nowTimestamp;

    relationshipPatch.love_buddies_birthday_ended_at = null;
  }

  if (!birthdayActive && previouslyActive) {
    relationshipPatch.love_buddies_birthday_ended_at = nowTimestamp;
  }

  const viewPatch = {
    relationship_id: relationshipId,

    relationship_status: "active",

    widget_state: widgetState,

    widget_background_key: widgetBackgroundKey,

    widget_birthday_active: birthdayActive,

    widget_birthday_user_uids: birthdayUserUids,

    widget_updated_at: nowTimestamp,

    updated_at: nowTimestamp,
  };

  const batch = db.batch();

  batch.set(
    db.collection(RELATIONSHIPS_COL).doc(relationshipId),
    relationshipPatch,
    { merge: true },
  );

  batch.set(db.collection(RELATIONSHIP_VIEWS_COL).doc(userAUid), viewPatch, {
    merge: true,
  });

  batch.set(db.collection(RELATIONSHIP_VIEWS_COL).doc(userBUid), viewPatch, {
    merge: true,
  });

  await batch.commit();

  return {
    birthdayActive,
    birthdayUserUids,
    widgetState,
    widgetBackgroundKey,
  };
}

// --------------------------------------------------
// Main callable
// --------------------------------------------------

exports.resolveHomeState = functions
  .region(REGION)
  .https.onCall(async (data, context) => {
    if (!context.auth) {
      throw new functions.https.HttpsError(
        "unauthenticated",
        "Authentication required.",
      );
    }

    const uid = context.auth.uid;

    const tzOffsetMinutes = Number(data?.tzOffsetMinutes);

    if (!Number.isFinite(tzOffsetMinutes)) {
      throw new functions.https.HttpsError(
        "invalid-argument",
        "tzOffsetMinutes must be a number.",
      );
    }

    const normalizedOffset = safeTimezoneOffset(tzOffsetMinutes);

    const userRef = db.collection(USERS_COL).doc(uid);

    const userSnapshot = await userRef.get();

    const user = userSnapshot.exists ? userSnapshot.data() || {} : {};

    const userRelationshipId = nonEmptyString(user.relationship_id);

    const restoreRequired = user.restore_required === true;

    const restoreRelationshipId = nonEmptyString(user.restore_relationship_id);

    const restoreState = nonEmptyString(user.restore_state);

    const restoreRequestId = nonEmptyString(user.restore_request_id);

    const disconnectCooldownUntil = user.disconnect_cooldown_until || null;

    // =====================================================
    // 1. ACTIVE COUPLE MODE
    // =====================================================

    if (userRelationshipId) {
      const myViewRef = db.collection(RELATIONSHIP_VIEWS_COL).doc(uid);

      const myViewSnapshot = await myViewRef.get();

      if (!myViewSnapshot.exists) {
        return {
          ok: true,
          mode: "couple_missing_view",
          homeMode: "single_demo",
          hasActiveRelationship: false,
          isSingleMode: true,
          isReconnectMode: false,

          uid,
          partnerUid: "",
          relationshipId: "",
          relationshipStatus: "missing_view",

          restoreRequired: false,
          restoreRelationshipId: "",
          restoreState: "",
          restoreRequestId: "",
          disconnectCooldownUntil: "",

          tzOffsetMinutes: normalizedOffset,
        };
      }

      const myView = myViewSnapshot.data() || {};

      const partnerUid = nonEmptyString(myView.partner_uid);

      const viewRelationshipId = nonEmptyString(myView.relationship_id);

      if (!partnerUid || !viewRelationshipId) {
        return {
          ok: true,
          mode: "couple_incomplete_view",
          homeMode: "single_demo",
          hasActiveRelationship: false,
          isSingleMode: true,
          isReconnectMode: false,

          uid,
          partnerUid: "",
          relationshipId: "",
          relationshipStatus: "incomplete_view",

          restoreRequired: false,
          restoreRelationshipId: "",
          restoreState: "",
          restoreRequestId: "",
          disconnectCooldownUntil: "",

          tzOffsetMinutes: normalizedOffset,
        };
      }

      const relationshipId = viewRelationshipId || userRelationshipId;

      const relationshipRef = db
        .collection(RELATIONSHIPS_COL)
        .doc(relationshipId);

      const partnerUserRef = db.collection(USERS_COL).doc(partnerUid);

      const partnerViewRef = db
        .collection(RELATIONSHIP_VIEWS_COL)
        .doc(partnerUid);

      const [relationshipSnapshot, partnerUserSnapshot, partnerViewSnapshot] =
        await Promise.all([
          relationshipRef.get(),
          partnerUserRef.get(),
          partnerViewRef.get(),
        ]);

      if (!relationshipSnapshot.exists) {
        return {
          ok: true,
          mode: "couple_missing_relationship",
          homeMode: "single_demo",
          hasActiveRelationship: false,
          isSingleMode: true,
          isReconnectMode: false,

          uid,
          partnerUid: "",
          relationshipId: "",
          relationshipStatus: "missing_relationship",

          restoreRequired: false,
          restoreRelationshipId: "",
          restoreState: "",
          restoreRequestId: "",
          disconnectCooldownUntil: "",

          tzOffsetMinutes: normalizedOffset,
        };
      }

      const relationship = relationshipSnapshot.data() || {};

      const partnerUser = partnerUserSnapshot.exists
        ? partnerUserSnapshot.data() || {}
        : {};

      const partnerView = partnerViewSnapshot.exists
        ? partnerViewSnapshot.data() || {}
        : {};

      const relationshipUserAUid = nonEmptyString(relationship.userA_id);

      const relationshipUserBUid = nonEmptyString(relationship.userB_id);

      /*
       * Make sure Birthday synchronization always
       * uses the correct userA/userB ordering.
       */
      let userAUid = relationshipUserAUid;

      let userBUid = relationshipUserBUid;

      let userA;
      let userB;
      let userAView;
      let userBView;

      if (uid === userAUid) {
        userA = user;
        userB = partnerUser;
        userAView = myView;
        userBView = partnerView;
      } else {
        userA = partnerUser;
        userB = user;
        userAView = partnerView;
        userBView = myView;
      }

      /*
       * Defensive fallback for older relationship
       * documents without correct userA/userB IDs.
       */
      if (!userAUid || !userBUid) {
        userAUid = uid;
        userBUid = partnerUid;
        userA = user;
        userB = partnerUser;
        userAView = myView;
        userBView = partnerView;
      }

      const nowTimestamp = admin.firestore.Timestamp.now();

      const timezoneBatch = db.batch();

      /*
       * Own view:
       * current device timezone.
       */
      timezoneBatch.set(
        myViewRef,
        {
          my_tz_offset_minutes: normalizedOffset,

          my_tz_offset_updated_at: nowTimestamp,

          relationship_status: "active",

          updated_at: nowTimestamp,
        },
        { merge: true },
      );

      /*
       * Partner view:
       * my timezone is the partner timezone
       * from their perspective.
       */
      timezoneBatch.set(
        partnerViewRef,
        {
          partner_tz_offset_minutes: normalizedOffset,

          partner_tz_offset_updated_at: nowTimestamp,

          relationship_status: "active",

          updated_at: nowTimestamp,
        },
        { merge: true },
      );

      /*
       * Keep Users timezone current as well.
       */
      timezoneBatch.set(
        userRef,
        {
          tz_offset_minutes: normalizedOffset,

          relationship_status: "active",

          updated_at: nowTimestamp,
        },
        { merge: true },
      );

      await timezoneBatch.commit();

      /*
       * Use the newly supplied timezone for the
       * currently logged-in user immediately.
       */
      if (uid === userAUid) {
        userA = {
          ...userA,
          tz_offset_minutes: normalizedOffset,
        };
      } else if (uid === userBUid) {
        userB = {
          ...userB,
          tz_offset_minutes: normalizedOffset,
        };
      }

      const birthdayResult = await synchronizeBirthdayState({
        relationshipId,
        relationship,
        userAUid,
        userBUid,
        userA,
        userB,
        userAView,
        userBView,
        nowTimestamp,
      });

      return {
        ok: true,
        mode: "couple",
        homeMode: "couple",
        hasActiveRelationship: true,
        isSingleMode: false,
        isReconnectMode: false,

        uid,
        partnerUid,
        relationshipId,
        relationshipStatus: "active",

        restoreRequired: false,
        restoreRelationshipId: "",
        restoreState: "",
        restoreRequestId: "",
        disconnectCooldownUntil: "",

        tzOffsetMinutes: normalizedOffset,

        birthdayActive: birthdayResult.birthdayActive,

        birthdayUserUids: birthdayResult.birthdayUserUids,

        widgetState: birthdayResult.widgetState,

        widgetBackgroundKey: birthdayResult.widgetBackgroundKey,
      };
    }

    // =====================================================
    // 2. RECONNECT PENDING MODE
    // =====================================================

    if (restoreRequired && restoreRelationshipId) {
      return {
        ok: true,
        mode: "reconnect_pending",
        homeMode: "reconnect_pending",
        hasActiveRelationship: false,
        isSingleMode: false,
        isReconnectMode: true,

        uid,
        partnerUid: "",
        relationshipId: "",
        relationshipStatus: "disconnect_pending",

        restoreRequired: true,
        restoreRelationshipId,
        restoreState,
        restoreRequestId,

        disconnectCooldownUntil: timestampToIsoOrEmpty(disconnectCooldownUntil),

        tzOffsetMinutes: normalizedOffset,
      };
    }

    // =====================================================
    // 3. SINGLE / DEMO MODE
    // =====================================================

    return {
      ok: true,
      mode: "single_demo",
      homeMode: "single_demo",
      hasActiveRelationship: false,
      isSingleMode: true,
      isReconnectMode: false,

      uid,
      partnerUid: "",
      relationshipId: "",
      relationshipStatus: "none",

      restoreRequired: false,
      restoreRelationshipId: "",
      restoreState: "",
      restoreRequestId: "",
      disconnectCooldownUntil: "",

      tzOffsetMinutes: normalizedOffset,
    };
  });
