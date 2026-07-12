const functions = require("firebase-functions");
const admin = require("firebase-admin");
// Do not call admin.initializeApp() in FlutterFlow Cloud Functions.

const REGION = "europe-west3";

const TOGETHER_DISTANCE_KM = 1;
const UPCOMING_WINDOW_MS = 24 * 60 * 60 * 1000;
const TRAVEL_PACK_WINDOW_MS = 12 * 60 * 60 * 1000;

const RELATIONSHIPS_COL = "relationships";
const REL_VIEWS_COL = "relationship_views";
const CALENDAR_EVENTS_COL = "calendar_events";

// =====================================================
// HELPERS
// =====================================================

function nonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : "";
}

function numberOrNull(value) {
  if (value === null || value === undefined || value === "") {
    return null;
  }

  const parsed = Number(value);

  return Number.isFinite(parsed) ? parsed : null;
}

function tsToMs(value) {
  return value && typeof value.toMillis === "function"
    ? value.toMillis()
    : null;
}

function updatedMs(event) {
  return tsToMs(event.updated_at) || tsToMs(event.created_at) || 0;
}

function sortMeetingCandidates(a, b) {
  const aStart = tsToMs(a.start) || 0;
  const bStart = tsToMs(b.start) || 0;

  if (aStart !== bStart) {
    return aStart - bStart;
  }

  const aUpdated = updatedMs(a);
  const bUpdated = updatedMs(b);

  if (aUpdated !== bUpdated) {
    return bUpdated - aUpdated;
  }

  return String(a.id || "").localeCompare(String(b.id || ""));
}

// =====================================================
// FIND RELEVANT NEXT MEETING
// =====================================================

async function findBestNextMeeting(
  db,
  relationshipId,
  nowTs,
  nowMs,
  upcomingUntilTs,
) {
  /*
   * Find a Next Meeting that has already started
   * but has not yet reached its exact end time.
   */
  const activeSnap = await db
    .collection(CALENDAR_EVENTS_COL)
    .where("relationship_id", "==", relationshipId)
    .where("category_key", "==", "next_meeting")
    .where("start", "<=", nowTs)
    .orderBy("start", "desc")
    .limit(20)
    .get();

  const activeCandidates = [];

  activeSnap.forEach((doc) => {
    const event = doc.data() || {};

    const startMs = tsToMs(event.start);
    const endMs = tsToMs(event.end);

    if (startMs === null || endMs === null) {
      return;
    }

    /*
     * Next Meeting must always contain a valid
     * start and end time.
     */
    if (endMs <= startMs) {
      return;
    }

    if (nowMs >= startMs && nowMs < endMs) {
      activeCandidates.push({
        id: doc.id,
        ...event,
      });
    }
  });

  if (activeCandidates.length > 0) {
    activeCandidates.sort(sortMeetingCandidates);

    return {
      event: activeCandidates[0],
      shouldStartTravel: true,
      shouldSetUpcoming: false,
    };
  }

  /*
   * Find a Next Meeting starting within the
   * next 24 hours.
   */
  const upcomingSnap = await db
    .collection(CALENDAR_EVENTS_COL)
    .where("relationship_id", "==", relationshipId)
    .where("category_key", "==", "next_meeting")
    .where("start", ">", nowTs)
    .where("start", "<=", upcomingUntilTs)
    .orderBy("start", "asc")
    .limit(20)
    .get();

  if (!upcomingSnap.empty) {
    const upcomingCandidates = [];

    upcomingSnap.docs.forEach((doc) => {
      const event = doc.data() || {};

      const startMs = tsToMs(event.start);
      const endMs = tsToMs(event.end);

      if (startMs === null || endMs === null || endMs <= startMs) {
        return;
      }

      upcomingCandidates.push({
        id: doc.id,
        ...event,
      });
    });

    if (upcomingCandidates.length > 0) {
      upcomingCandidates.sort(sortMeetingCandidates);

      return {
        event: upcomingCandidates[0],
        shouldStartTravel: false,
        shouldSetUpcoming: true,
      };
    }
  }

  return null;
}

// =====================================================
// CALLABLE FUNCTION
// =====================================================

exports.syncLoveBuddyTravelState = functions
  .region(REGION)
  .https.onCall(async (data, context) => {
    if (!context.auth?.uid) {
      throw new functions.https.HttpsError(
        "unauthenticated",
        "You must be signed in.",
      );
    }

    const uid = context.auth.uid;

    const relationshipId = nonEmptyString(data?.relationshipId);

    if (!relationshipId) {
      throw new functions.https.HttpsError(
        "invalid-argument",
        "Missing relationshipId.",
      );
    }

    const db = admin.firestore();

    const nowTs = admin.firestore.Timestamp.now();

    const nowMs = nowTs.toMillis();

    const upcomingUntilTs = admin.firestore.Timestamp.fromMillis(
      nowMs + UPCOMING_WINDOW_MS,
    );

    const relRef = db.collection(RELATIONSHIPS_COL).doc(relationshipId);

    const relSnap = await relRef.get();

    if (!relSnap.exists) {
      throw new functions.https.HttpsError(
        "not-found",
        "Relationship not found.",
      );
    }

    const rel = relSnap.data() || {};

    const userAId = nonEmptyString(rel.userA_id);

    const userBId = nonEmptyString(rel.userB_id);

    if (!userAId || !userBId) {
      throw new functions.https.HttpsError(
        "failed-precondition",
        "Relationship is missing userA_id or userB_id.",
      );
    }

    if (uid !== userAId && uid !== userBId) {
      throw new functions.https.HttpsError(
        "permission-denied",
        "You are not a member of this relationship.",
      );
    }

    /*
     * Do not change Travel or Widget states while
     * the relationship is paused.
     */
    if (
      rel.active !== true ||
      (rel.relationship_status && rel.relationship_status !== "active")
    ) {
      return {
        success: false,
        status: "relationship_not_active",
        travel_active: false,
        travel_upcoming_active: false,
        together_active: false,
        travel_pack_active: false,
      };
    }

    const currentDistanceKm = numberOrNull(
      rel.love_buddies_current_distance_km,
    );

    let travelActive = rel.love_buddies_travel_active === true;

    let togetherActive = rel.love_buddies_together_active === true;

    let travelUpcomingActive = rel.love_buddies_travel_upcoming_active === true;

    let travelPackActive = rel.love_buddies_travel_pack_active === true;

    const travelTargetAt = rel.love_buddies_travel_target_at || null;

    const travelerUid = nonEmptyString(rel.love_buddies_traveler_uid) || null;

    const returningUid = nonEmptyString(rel.love_buddies_returning_uid) || null;

    const updates = {
      love_buddies_updated_at: nowTs,
      updated_at: nowTs,
    };

    // =================================================
    // 1. END TRAVEL PACK AFTER 12 HOURS
    // =================================================

    if (travelPackActive) {
      const startedMs = tsToMs(rel.love_buddies_travel_pack_started_at);

      const travelPackExpired =
        startedMs !== null && nowMs - startedMs >= TRAVEL_PACK_WINDOW_MS;

      if (travelPackExpired) {
        updates.love_buddies_travel_pack_active = false;

        updates.love_buddies_travel_pack_ended_at = nowTs;

        updates.love_buddies_return_completed_at = nowTs;

        updates.love_buddies_returning_uid = null;

        updates.love_buddies_travel_active = false;

        updates.love_buddies_travel_upcoming_active = false;

        updates.love_buddies_together_active = false;

        updates.love_buddies_traveler_uid = null;

        updates.love_buddies_destination_uid = null;

        updates.love_buddies_travel_event_id = null;

        updates.love_buddies_travel_target_at = null;

        updates.love_buddies_travel_all_day = false;

        travelPackActive = false;
        travelActive = false;
        travelUpcomingActive = false;
        togetherActive = false;
      }
    }

    // =================================================
    // 2. END TOGETHER AT THE EXACT EVENT END TIME
    // =================================================

    if (togetherActive && !travelPackActive) {
      const targetReached =
        travelTargetAt &&
        typeof travelTargetAt.toMillis === "function" &&
        nowMs >= travelTargetAt.toMillis();

      if (targetReached) {
        const finalReturningUid = travelerUid || returningUid || null;

        updates.love_buddies_together_active = false;

        updates.love_buddies_travel_active = false;

        updates.love_buddies_travel_upcoming_active = false;

        updates.love_buddies_travel_pack_active = true;

        updates.love_buddies_travel_pack_started_at = nowTs;

        updates.love_buddies_travel_pack_ended_at = null;

        updates.love_buddies_returning_uid = finalReturningUid;

        updates.love_buddies_return_started_at = nowTs;

        updates.love_buddies_return_completed_at = null;

        togetherActive = false;
        travelActive = false;
        travelUpcomingActive = false;
        travelPackActive = true;
      }
    }

    // =================================================
    // 3. TRAVELER ARRIVED
    // =================================================

    if (
      !travelPackActive &&
      travelActive &&
      currentDistanceKm !== null &&
      currentDistanceKm <= TOGETHER_DISTANCE_KM
    ) {
      updates.love_buddies_travel_active = false;

      updates.love_buddies_travel_upcoming_active = false;

      updates.love_buddies_together_active = true;

      updates.love_buddies_together_started_at = nowTs;

      updates.love_buddies_travel_pack_active = false;

      updates.love_buddies_returning_uid = null;

      travelActive = false;
      travelUpcomingActive = false;
      togetherActive = true;
      travelPackActive = false;
    }

    // =================================================
    // 4. FIND NEXT MEETING
    // =================================================

    if (!travelActive && !togetherActive && !travelPackActive) {
      const chosen = await findBestNextMeeting(
        db,
        relationshipId,
        nowTs,
        nowMs,
        upcomingUntilTs,
      );

      if (chosen && chosen.event) {
        const chosenEvent = chosen.event;

        const finalTravelerUid =
          nonEmptyString(chosenEvent.traveler_uid) ||
          nonEmptyString(chosenEvent.created_by);

        const destinationUid =
          nonEmptyString(chosenEvent.destination_uid) ||
          (finalTravelerUid === userAId ? userBId : userAId);

        if (finalTravelerUid && destinationUid) {
          updates.love_buddies_traveler_uid = finalTravelerUid;

          updates.love_buddies_destination_uid = destinationUid;

          updates.love_buddies_travel_target_at = chosenEvent.end || null;

          /*
           * Next Meeting now always uses an exact
           * start and end time.
           */
          updates.love_buddies_travel_all_day = false;

          updates.love_buddies_travel_event_id = chosenEvent.id;

          updates.love_buddies_travel_pack_active = false;

          updates.love_buddies_returning_uid = null;

          if (chosen.shouldStartTravel) {
            updates.love_buddies_travel_active = true;

            updates.love_buddies_travel_upcoming_active = false;

            updates.love_buddies_together_active = false;

            /*
             * Only set the beginning once when
             * entering the traveling state.
             */
            if (!travelActive) {
              updates.love_buddies_travel_started_at = nowTs;
            }

            updates.love_buddies_start_distance_km =
              currentDistanceKm !== null
                ? currentDistanceKm
                : numberOrNull(rel.love_buddies_start_distance_km);

            travelActive = true;
            travelUpcomingActive = false;
            togetherActive = false;
            travelPackActive = false;
          } else if (chosen.shouldSetUpcoming) {
            updates.love_buddies_travel_active = false;

            updates.love_buddies_travel_upcoming_active = true;

            updates.love_buddies_together_active = false;

            travelActive = false;
            travelUpcomingActive = true;
            togetherActive = false;
            travelPackActive = false;
          }
        }
      } else {
        updates.love_buddies_travel_active = false;

        updates.love_buddies_travel_upcoming_active = false;

        updates.love_buddies_together_active = false;

        updates.love_buddies_travel_pack_active = false;

        updates.love_buddies_travel_event_id = null;

        updates.love_buddies_traveler_uid = null;

        updates.love_buddies_destination_uid = null;

        updates.love_buddies_travel_target_at = null;

        updates.love_buddies_travel_all_day = false;

        updates.love_buddies_returning_uid = null;

        travelActive = false;
        travelUpcomingActive = false;
        togetherActive = false;
        travelPackActive = false;
      }
    }

    await relRef.set(updates, { merge: true });

    await syncLoveBuddyWidgetStateInternal(db, relationshipId);

    return {
      success: true,
      status: "synced",
      travel_active: travelActive,
      travel_upcoming_active: travelUpcomingActive,
      together_active: togetherActive,
      travel_pack_active: travelPackActive,
    };
  });

// =====================================================
// WIDGET STATE SYNC
// =====================================================

async function syncLoveBuddyWidgetStateInternal(db, relationshipId) {
  const relRef = db.collection(RELATIONSHIPS_COL).doc(relationshipId);

  const relSnap = await relRef.get();

  if (!relSnap.exists) {
    return;
  }

  const rel = relSnap.data() || {};

  const userAId = nonEmptyString(rel.userA_id);

  const userBId = nonEmptyString(rel.userB_id);

  if (!userAId || !userBId) {
    return;
  }

  const userAViewRef = db.collection(REL_VIEWS_COL).doc(userAId);

  const userBViewRef = db.collection(REL_VIEWS_COL).doc(userBId);

  const [userAViewSnap, userBViewSnap] = await Promise.all([
    userAViewRef.get(),
    userBViewRef.get(),
  ]);

  const userAView = userAViewSnap.exists ? userAViewSnap.data() || {} : {};

  const userBView = userBViewSnap.exists ? userBViewSnap.data() || {} : {};

  const currentTravelEventId =
    typeof rel.love_buddies_travel_event_id === "string"
      ? rel.love_buddies_travel_event_id
      : "";

  const userAEventChanged =
    String(userAView.widget_travel_event_id || "") !== currentTravelEventId;

  const userBEventChanged =
    String(userBView.widget_travel_event_id || "") !== currentTravelEventId;

  const userAPet = rel.love_buddies_user_a_pet || "dog";

  const userBPet = rel.love_buddies_user_b_pet || "cat";

  const userAName = rel.love_buddies_user_a_name || "Bam";

  const userBName = rel.love_buddies_user_b_name || "Mimi";

  const currentDistanceKm = numberOrNull(rel.love_buddies_current_distance_km);

  const storedStartDistanceKm = numberOrNull(
    rel.love_buddies_start_distance_km,
  );

  const startDistanceKm =
    storedStartDistanceKm !== null ? storedStartDistanceKm : currentDistanceKm;

  const travelerUid = nonEmptyString(rel.love_buddies_traveler_uid) || null;

  const returningUid = nonEmptyString(rel.love_buddies_returning_uid) || null;

  const travelActive = rel.love_buddies_travel_active === true;

  const travelUpcomingActive = rel.love_buddies_travel_upcoming_active === true;

  const travelPackActive = rel.love_buddies_travel_pack_active === true;

  const togetherActive = rel.love_buddies_together_active === true;

  const birthdayActive = rel.love_buddies_birthday_active === true;

  const birthdayUserUids = Array.isArray(rel.love_buddies_birthday_user_uids)
    ? rel.love_buddies_birthday_user_uids
    : [];

  const liveLocationActive = rel.love_buddies_live_location_active === true;

  const liveLocationMode = rel.love_buddies_live_location_mode || "off";

  const lastLoveSentByUid =
    nonEmptyString(rel.love_buddies_last_love_sent_by_uid) || null;

  const lastLoveSentAt = rel.love_buddies_last_love_sent_at || null;

  const lastLoveSentType = rel.love_buddies_last_love_sent_type || "normal";

  const userASleeping = userAView.my_sleep_status === true;

  const userBSleeping = userBView.my_sleep_status === true;

  const nowMs = Date.now();

  const lastLoveSentMs = tsToMs(lastLoveSentAt);

  const loveActive =
    lastLoveSentMs !== null &&
    nowMs >= lastLoveSentMs &&
    nowMs - lastLoveSentMs <= 30 * 60 * 1000;

  let distanceProgress = 0;

  if (
    (travelActive || travelPackActive) &&
    startDistanceKm !== null &&
    startDistanceKm > 0 &&
    currentDistanceKm !== null
  ) {
    if (travelPackActive) {
      distanceProgress = (currentDistanceKm / startDistanceKm) * 100;
    } else {
      distanceProgress =
        ((startDistanceKm - currentDistanceKm) / startDistanceKm) * 100;
    }

    distanceProgress = Math.max(0, Math.min(100, Math.round(distanceProgress)));
  }

  function getPetByUid(targetUid) {
    if (targetUid === userAId) {
      return userAPet;
    }

    if (targetUid === userBId) {
      return userBPet;
    }

    return null;
  }

  function getPartnerPetByUid(targetUid) {
    if (targetUid === userAId) {
      return userBPet;
    }

    if (targetUid === userBId) {
      return userAPet;
    }

    return null;
  }

  function buildDirectionalKey(prefix, actorUid) {
    const actorPet = getPetByUid(actorUid);

    const partnerPet = getPartnerPetByUid(actorUid);

    if (!actorPet || !partnerPet) {
      return `${prefix}_dog_to_cat`;
    }

    return `${prefix}_${actorPet}` + `_to_${partnerPet}`;
  }

  function buildSleepKey() {
    if (userASleeping && userBSleeping) {
      return "sleep_both";
    }

    if (userASleeping) {
      return `sleep_${userAPet}`;
    }

    if (userBSleeping) {
      return `sleep_${userBPet}`;
    }

    return null;
  }

  let widgetState = "normal";

  let widgetBackgroundKey = "normal";

  const sleepKey = buildSleepKey();

  /*
   * Widget priority:
   *
   * 1. Birthday
   * 2. Together
   * 3. Sleeping
   * 4. Travel Pack
   * 5. Traveling
   * 6. Travel Upcoming
   * 7. Love Sent
   * 8. Normal
   */
  if (birthdayActive) {
    widgetState = "birthday";

    widgetBackgroundKey = "birthday";
  } else if (togetherActive) {
    widgetState = "together";

    widgetBackgroundKey = "together";
  } else if (sleepKey) {
    widgetState = "sleeping";

    widgetBackgroundKey = sleepKey;
  } else if (travelPackActive && returningUid) {
    widgetState = "travel_pack";

    widgetBackgroundKey = buildDirectionalKey("travel_pack", returningUid);
  } else if (travelActive && travelerUid) {
    widgetState = "traveling";

    widgetBackgroundKey = buildDirectionalKey("travel", travelerUid);
  } else if (travelUpcomingActive && travelerUid) {
    widgetState = "travel_upcoming";

    widgetBackgroundKey = buildDirectionalKey("travel_upcoming", travelerUid);
  } else if (loveActive && lastLoveSentByUid) {
    widgetState = "love_sent";

    widgetBackgroundKey = buildDirectionalKey("love", lastLoveSentByUid);
  }

  const now = admin.firestore.FieldValue.serverTimestamp();

  const sharedViewUpdate = {
    widget_state: widgetState,

    widget_background_key: widgetBackgroundKey,

    widget_distance_km: currentDistanceKm,

    widget_distance_progress: distanceProgress,

    widget_traveler_uid: travelerUid,

    widget_returning_uid: returningUid,

    widget_travel_event_id: currentTravelEventId,

    widget_last_love_sent_by_uid: lastLoveSentByUid,

    widget_last_love_sent_at: lastLoveSentAt,

    widget_last_love_sent_type: lastLoveSentType,

    widget_birthday_active: birthdayActive,

    widget_birthday_user_uids: birthdayUserUids,

    live_location_active: liveLocationActive,

    live_location_mode: liveLocationMode,

    widget_updated_at: now,

    updated_at: now,
  };

  const userAUpdate = {
    ...sharedViewUpdate,

    my_love_buddy_pet: userAPet,

    my_love_buddy_name: userAName,

    partner_love_buddy_pet: userBPet,

    partner_love_buddy_name: userBName,
  };

  if (userAEventChanged) {
    userAUpdate.live_travel_tracking_enabled = false;

    userAUpdate.live_travel_tracking_prompt_event_id = "";
  }

  const userBUpdate = {
    ...sharedViewUpdate,

    my_love_buddy_pet: userBPet,

    my_love_buddy_name: userBName,

    partner_love_buddy_pet: userAPet,

    partner_love_buddy_name: userAName,
  };

  if (userBEventChanged) {
    userBUpdate.live_travel_tracking_enabled = false;

    userBUpdate.live_travel_tracking_prompt_event_id = "";
  }

  const batch = db.batch();

  batch.set(
    relRef,
    {
      love_buddies_widget_state: widgetState,

      love_buddies_widget_background_key: widgetBackgroundKey,

      love_buddies_widget_distance_progress: distanceProgress,

      love_buddies_widget_returning_uid: returningUid,

      love_buddies_widget_birthday_active: birthdayActive,

      love_buddies_widget_birthday_user_uids: birthdayUserUids,

      love_buddies_widget_updated_at: now,
    },
    { merge: true },
  );

  batch.set(userAViewRef, userAUpdate, { merge: true });

  batch.set(userBViewRef, userBUpdate, { merge: true });

  await batch.commit();
}
