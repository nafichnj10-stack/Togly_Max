const functions = require("firebase-functions");
const admin = require("firebase-admin");

try {
  admin.app();
} catch {
  admin.initializeApp();
}

const db = admin.firestore();
const bucket = admin.storage().bucket();

const REGION = "europe-west3";

const USERS_COL = "Users";
const PUBLIC_USERS_COL = "PublicUsers";
const RELATIONSHIPS_COL = "relationships";
const RELATIONSHIP_VIEWS_COL = "relationship_views";

const RELATIONSHIP_BOUND_COLLECTIONS = [
  "albums",
  "gallery",
  "bucket_list",
  "love_notes",
  "daily_questions",
  "answers",
  "calendar_events",
  "mood_updates",
  "wishes",
  "relationship_requests",
  "reconnect_requests",
  "heartbeat_sessions",
  "heartbeat_answers",
  "relationship_emotion_checkins",
  "love_awards",

  // Love Treasure
  "love_treasures",
  "treasure_surprises",
  "treasure_reveals",
];

// --------------------------------------------------
// Basic helpers
// --------------------------------------------------

function nonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : "";
}

function uniqueStrings(values) {
  return Array.from(
    new Set(values.map((value) => nonEmptyString(value)).filter(Boolean)),
  );
}

function usersRef(uid) {
  return db.collection(USERS_COL).doc(uid);
}

function relationshipViewRef(uid) {
  return db.collection(RELATIONSHIP_VIEWS_COL).doc(uid);
}

// --------------------------------------------------
// Firestore deletion helpers
// --------------------------------------------------

async function deleteByQuery({ collection, field, value, limit = 300 }) {
  let total = 0;

  while (true) {
    const snapshot = await db
      .collection(collection)
      .where(field, "==", value)
      .limit(limit)
      .get();

    if (snapshot.empty) break;

    const batch = db.batch();

    snapshot.docs.forEach((document) => {
      batch.delete(document.ref);
    });

    await batch.commit();

    total += snapshot.size;

    if (snapshot.size < limit) break;
  }

  return total;
}

async function deleteByAnyRelationshipField(collection, relationshipId) {
  const possibleFields = [
    "relationship_id",
    "relationshipId",
    "relationship_ref_id",
  ];

  let total = 0;

  for (const field of possibleFields) {
    total += await deleteByQuery({
      collection,
      field,
      value: relationshipId,
    }).catch(() => 0);
  }

  return total;
}

async function deleteSubcollection(parentRef, subcollectionName, limit = 300) {
  let total = 0;

  while (true) {
    const snapshot = await parentRef
      .collection(subcollectionName)
      .limit(limit)
      .get();

    if (snapshot.empty) break;

    const batch = db.batch();

    snapshot.docs.forEach((document) => {
      batch.delete(document.ref);
    });

    await batch.commit();

    total += snapshot.size;

    if (snapshot.size < limit) break;
  }

  return total;
}

async function deleteStoragePrefix(prefix) {
  const [files] = await bucket.getFiles({
    prefix,
  });

  if (!files || files.length === 0) {
    return 0;
  }

  await Promise.all(files.map((file) => file.delete().catch(() => null)));

  return files.length;
}

// --------------------------------------------------
// PublicUsers helpers
// --------------------------------------------------

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
    .limit(20)
    .get();

  querySnapshot.docs.forEach((document) => {
    references.set(document.ref.path, document.ref);
  });

  return Array.from(references.values());
}

async function deletePublicUsersForUid(uid) {
  const references = await getPublicUserReferences(uid);

  await Promise.all(
    references.map((reference) => reference.delete().catch(() => null)),
  );
}

// --------------------------------------------------
// Partner cleanup
// --------------------------------------------------

async function clearPartnerAfterAccountDeletion(
  partnerUid,
  relationshipId,
  now,
) {
  if (!partnerUid) return;

  const partnerUserPatch = {
    relationship_id: admin.firestore.FieldValue.delete(),

    partnerUID: admin.firestore.FieldValue.delete(),

    relationship_status: admin.firestore.FieldValue.delete(),

    disconnect_cooldown_until: admin.firestore.FieldValue.delete(),

    last_relationship_id: admin.firestore.FieldValue.delete(),

    last_relationship_ref: admin.firestore.FieldValue.delete(),

    restore_required: admin.firestore.FieldValue.delete(),

    restore_state: admin.firestore.FieldValue.delete(),

    restore_request_id: admin.firestore.FieldValue.delete(),

    restore_relationship_id: admin.firestore.FieldValue.delete(),

    celebrate_reconnect: admin.firestore.FieldValue.delete(),

    celebrate_reconnect_at: admin.firestore.FieldValue.delete(),

    live_location_active: admin.firestore.FieldValue.delete(),

    live_location_mode: admin.firestore.FieldValue.delete(),

    live_travel_tracking_prompt_event_id: admin.firestore.FieldValue.delete(),

    updated_at: now,
  };

  await usersRef(partnerUid)
    .set(partnerUserPatch, { merge: true })
    .catch(() => null);

  const publicUserPatch = {
    relationship_id: admin.firestore.FieldValue.delete(),

    partnerUID: admin.firestore.FieldValue.delete(),

    relationship_status: admin.firestore.FieldValue.delete(),

    updated_at: now,
  };

  const publicReferences = await getPublicUserReferences(partnerUid).catch(
    () => [],
  );

  await Promise.all(
    publicReferences.map((reference) =>
      reference.set(publicUserPatch, { merge: true }).catch(() => null),
    ),
  );

  /*
   * Delete the partner's relationship_view completely.
   * The widget must then show its unconnected fallback.
   */
  await relationshipViewRef(partnerUid)
    .delete()
    .catch(() => null);

  /*
   * Extra fallback if a non-standard relationship_view
   * document exists.
   */
  if (relationshipId) {
    await deleteByAnyRelationshipField(
      RELATIONSHIP_VIEWS_COL,
      relationshipId,
    ).catch(() => null);
  }
}

// --------------------------------------------------
// Delete relationship and shared data
// --------------------------------------------------

async function deleteRelationshipData({
  relationshipId,
  deletingUid,
  fallbackPartnerUid,
  now,
}) {
  if (!relationshipId) {
    await clearPartnerAfterAccountDeletion(fallbackPartnerUid, "", now);

    return {
      relationshipDeleted: false,
      partnerUid: fallbackPartnerUid || "",
      deletedByCollection: {},
      storageDeleted: 0,
    };
  }

  const relationshipRef = db.collection(RELATIONSHIPS_COL).doc(relationshipId);

  const relationshipSnapshot = await relationshipRef.get();

  let members = [];
  let partnerUid = fallbackPartnerUid || "";

  if (relationshipSnapshot.exists) {
    const relationship = relationshipSnapshot.data() || {};

    const userAUid = nonEmptyString(
      relationship.userA_id ?? relationship.userAId ?? relationship.userA,
    );

    const userBUid = nonEmptyString(
      relationship.userB_id ?? relationship.userBId ?? relationship.userB,
    );

    members = uniqueStrings([userAUid, userBUid]);

    partnerUid =
      userAUid === deletingUid
        ? userBUid
        : userBUid === deletingUid
          ? userAUid
          : fallbackPartnerUid || "";
  }

  await clearPartnerAfterAccountDeletion(partnerUid, relationshipId, now);

  const deletedByCollection = {};

  for (const collection of RELATIONSHIP_BOUND_COLLECTIONS) {
    deletedByCollection[collection] = await deleteByAnyRelationshipField(
      collection,
      relationshipId,
    ).catch(() => 0);
  }

  /*
   * Delete standard UID-based relationship_views.
   */
  await Promise.all(
    members.map((uid) =>
      relationshipViewRef(uid)
        .delete()
        .catch(() => null),
    ),
  );

  /*
   * Delete relationship subcollections.
   */
  if (relationshipSnapshot.exists) {
    deletedByCollection["relationships/love_coupons"] =
      await deleteSubcollection(relationshipRef, "love_coupons").catch(() => 0);
  }

  let storageDeleted = 0;

  storageDeleted += await deleteStoragePrefix(
    `couples/${relationshipId}/`,
  ).catch(() => 0);

  storageDeleted += await deleteStoragePrefix(
    `relationships/${relationshipId}/`,
  ).catch(() => 0);

  if (relationshipSnapshot.exists) {
    await relationshipRef.delete().catch(() => null);
  }

  return {
    relationshipDeleted: relationshipSnapshot.exists,

    partnerUid: partnerUid || "",

    deletedByCollection,

    storageDeleted,
  };
}

// --------------------------------------------------
// User-related requests
// --------------------------------------------------

async function deleteRequestsForUid(uid) {
  const queryDefinitions = [
    ["relationship_requests", "initiator_id"],
    ["relationship_requests", "target_id"],
    ["reconnect_requests", "initiator_id"],
    ["reconnect_requests", "target_id"],
  ];

  for (const [collection, field] of queryDefinitions) {
    await deleteByQuery({
      collection,
      field,
      value: uid,
    }).catch(() => null);
  }
}

// --------------------------------------------------
// Main callable
// --------------------------------------------------

exports.deleteMyAccount = functions
  .region(REGION)
  .https.onCall(async (data, context) => {
    const uid = context.auth?.uid;

    if (!uid) {
      throw new functions.https.HttpsError("unauthenticated", "Auth required.");
    }

    const now = admin.firestore.Timestamp.now();

    const userRef = usersRef(uid);
    const userSnapshot = await userRef.get();

    const user = userSnapshot.exists ? userSnapshot.data() || {} : {};

    const relationshipId =
      nonEmptyString(user.relationship_id) ||
      nonEmptyString(user.last_relationship_id) ||
      nonEmptyString(user.restore_relationship_id) ||
      nonEmptyString(user.last_relationship_ref?.id);

    const fallbackPartnerUid =
      nonEmptyString(user.partnerUID) || nonEmptyString(user.partner_uid);

    const relationshipResult = await deleteRelationshipData({
      relationshipId,
      deletingUid: uid,
      fallbackPartnerUid,
      now,
    });

    /*
     * Delete any remaining relationship_view belonging
     * to the deleting user.
     */
    await relationshipViewRef(uid)
      .delete()
      .catch(() => null);

    /*
     * Delete pending relationship and reconnect requests
     * involving the user, including requests without a
     * valid relationship_id.
     */
    await deleteRequestsForUid(uid);

    /*
     * Delete user-owned Storage.
     */
    let userStorageDeleted = 0;

    userStorageDeleted += await deleteStoragePrefix(`users/${uid}/`).catch(
      () => 0,
    );

    /*
     * Delete PublicUsers documents.
     */
    await deletePublicUsersForUid(uid).catch(() => null);

    /*
     * Delete FCM tokens before deleting Users document.
     */
    await deleteSubcollection(userRef, "fcm_tokens").catch(() => null);

    /*
     * Delete the main Users document.
     */
    await userRef.delete().catch(() => null);

    /*
     * Delete Firebase Authentication user last.
     */
    try {
      await admin.auth().deleteUser(uid);
    } catch (error) {
      console.error("[deleteMyAccount] Auth deletion failed:", error);

      throw new functions.https.HttpsError(
        "internal",
        "Auth user deletion failed.",
      );
    }

    return {
      ok: true,

      uid,

      relationship_id: relationshipId || null,

      partner_uid: relationshipResult.partnerUid || null,

      relationship_deleted: relationshipResult.relationshipDeleted,

      relationship_storage_deleted: relationshipResult.storageDeleted,

      user_storage_deleted: userStorageDeleted,
    };
  });
