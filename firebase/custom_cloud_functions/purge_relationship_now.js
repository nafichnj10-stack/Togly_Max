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

const RELATIONSHIPS_COL = "relationships";
const USERS_COL = "Users";
const PUBLIC_USERS_COL = "PublicUsers";
const RELATIONSHIP_VIEWS_COL = "relationship_views";

const RELATIONSHIP_BOUND_COLLECTIONS = [
  "albums",
  "gallery",
  "bucket_list",
  "love_notes",
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

async function deleteByQuery(
  collectionName,
  fieldName,
  fieldValue,
  limit = 300,
) {
  let total = 0;

  while (true) {
    const snapshot = await db
      .collection(collectionName)
      .where(fieldName, "==", fieldValue)
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

async function deleteByAnyRelationshipField(collectionName, relationshipId) {
  const possibleFields = [
    "relationship_id",
    "relationshipId",
    "relationship_ref_id",
  ];

  let total = 0;

  for (const fieldName of possibleFields) {
    total += await deleteByQuery(
      collectionName,
      fieldName,
      relationshipId,
    ).catch(() => 0);
  }

  return total;
}

async function deleteSubcollection(
  parentReference,
  subcollectionName,
  limit = 300,
) {
  let total = 0;

  while (true) {
    const snapshot = await parentReference
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

async function purgeRelationshipById(relationshipId) {
  const relationshipRef = db.collection(RELATIONSHIPS_COL).doc(relationshipId);

  const relationshipSnapshot = await relationshipRef.get();

  let members = [];

  if (relationshipSnapshot.exists) {
    const relationship = relationshipSnapshot.data() || {};

    const userAUid = nonEmptyString(
      relationship.userA_id ?? relationship.userAId ?? relationship.userA,
    );

    const userBUid = nonEmptyString(
      relationship.userB_id ?? relationship.userBId ?? relationship.userB,
    );

    members = uniqueStrings([userAUid, userBUid]);
  }

  const deletedByCollection = {};

  // Delete relationship-bound documents.
  for (const collectionName of RELATIONSHIP_BOUND_COLLECTIONS) {
    deletedByCollection[collectionName] = await deleteByAnyRelationshipField(
      collectionName,
      relationshipId,
    ).catch(() => 0);
  }

  // Also remove any relationship_views found by field.
  deletedByCollection.relationship_views = await deleteByAnyRelationshipField(
    RELATIONSHIP_VIEWS_COL,
    relationshipId,
  ).catch(() => 0);

  // Delete relationship subcollections.
  if (relationshipSnapshot.exists) {
    deletedByCollection["relationships/love_coupons"] =
      await deleteSubcollection(relationshipRef, "love_coupons").catch(() => 0);
  }

  // Delete relationship_views using user UIDs.
  await Promise.all(
    members.map((uid) =>
      db
        .collection(RELATIONSHIP_VIEWS_COL)
        .doc(uid)
        .delete()
        .catch(() => null),
    ),
  );

  // Delete relationship storage.
  let storageDeleted = 0;

  storageDeleted += await deleteStoragePrefix(
    `couples/${relationshipId}/`,
  ).catch(() => 0);

  storageDeleted += await deleteStoragePrefix(
    `relationships/${relationshipId}/`,
  ).catch(() => 0);

  const now = admin.firestore.Timestamp.now();

  const userPatch = {
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

  // Clean known members.
  await Promise.all(
    members.map((uid) =>
      db
        .collection(USERS_COL)
        .doc(uid)
        .set(userPatch, { merge: true })
        .catch(() => null),
    ),
  );

  // Repair/cleanup fallback for incomplete relationships.
  const fallbackUserFields = [
    "relationship_id",
    "last_relationship_id",
    "restore_relationship_id",
  ];

  for (const fieldName of fallbackUserFields) {
    const fallbackSnapshot = await db
      .collection(USERS_COL)
      .where(fieldName, "==", relationshipId)
      .limit(500)
      .get()
      .catch(() => null);

    if (fallbackSnapshot && !fallbackSnapshot.empty) {
      await Promise.all(
        fallbackSnapshot.docs.map((document) =>
          document.ref.set(userPatch, { merge: true }).catch(() => null),
        ),
      );
    }
  }

  const publicUserPatch = {
    relationship_id: admin.firestore.FieldValue.delete(),

    partnerUID: admin.firestore.FieldValue.delete(),

    relationship_status: admin.firestore.FieldValue.delete(),

    updated_at: now,
  };

  // Clean PublicUsers for known members.
  for (const uid of members) {
    const references = await getPublicUserReferences(uid).catch(() => []);

    await Promise.all(
      references.map((reference) =>
        reference.set(publicUserPatch, { merge: true }).catch(() => null),
      ),
    );
  }

  // PublicUsers fallback by relationship ID.
  const publicFallbackSnapshot = await db
    .collection(PUBLIC_USERS_COL)
    .where("relationship_id", "==", relationshipId)
    .limit(500)
    .get()
    .catch(() => null);

  if (publicFallbackSnapshot && !publicFallbackSnapshot.empty) {
    await Promise.all(
      publicFallbackSnapshot.docs.map((document) =>
        document.ref.set(publicUserPatch, { merge: true }).catch(() => null),
      ),
    );
  }

  if (relationshipSnapshot.exists) {
    await relationshipRef.delete();

    return {
      status: "purged",
      relationship_id: relationshipId,
      members,
      storageDeleted,
      deletedByCollection,
    };
  }

  return {
    status: "already_deleted",
    relationship_id: relationshipId,
    members,
    storageDeleted,
    deletedByCollection,
  };
}

exports.purgeRelationshipNow = functions
  .region(REGION)
  .https.onCall(async (data, context) => {
    const uid = context.auth?.uid;

    if (!uid) {
      throw new functions.https.HttpsError("unauthenticated", "Auth required.");
    }

    const userSnapshot = await db.collection(USERS_COL).doc(uid).get();

    const user = userSnapshot.exists ? userSnapshot.data() || {} : {};

    const relationshipIdFromClient = nonEmptyString(
      data?.relationshipId ??
        data?.relationshipid ??
        data?.relationship_id ??
        "",
    );

    const relationshipIdFromUser =
      nonEmptyString(user.last_relationship_id) ||
      nonEmptyString(user.restore_relationship_id) ||
      nonEmptyString(user.relationship_id) ||
      nonEmptyString(user.last_relationship_ref?.id);

    const relationshipId = relationshipIdFromClient || relationshipIdFromUser;

    if (!relationshipId) {
      return {
        ok: true,
        status: "no_relationship_to_purge",
        relationship_id: "",
      };
    }

    const relationshipRef = db
      .collection(RELATIONSHIPS_COL)
      .doc(relationshipId);

    const relationshipSnapshot = await relationshipRef.get();

    if (relationshipSnapshot.exists) {
      const relationship = relationshipSnapshot.data() || {};

      const userAUid = nonEmptyString(
        relationship.userA_id ?? relationship.userAId ?? relationship.userA,
      );

      const userBUid = nonEmptyString(
        relationship.userB_id ?? relationship.userBId ?? relationship.userB,
      );

      const isMember = uid === userAUid || uid === userBUid;

      const allowedByStoredRelationship =
        nonEmptyString(user.last_relationship_id) === relationshipId ||
        nonEmptyString(user.restore_relationship_id) === relationshipId ||
        nonEmptyString(user.relationship_id) === relationshipId;

      if (!isMember && !allowedByStoredRelationship) {
        throw new functions.https.HttpsError(
          "permission-denied",
          "Not allowed to purge this relationship.",
        );
      }
    } else {
      /*
       * When the relationship document was already
       * removed, only allow cleanup if the current
       * user still references this relationship.
       */
      const allowedByStoredRelationship =
        nonEmptyString(user.last_relationship_id) === relationshipId ||
        nonEmptyString(user.restore_relationship_id) === relationshipId ||
        nonEmptyString(user.relationship_id) === relationshipId;

      if (relationshipIdFromClient && !allowedByStoredRelationship) {
        throw new functions.https.HttpsError(
          "permission-denied",
          "Not allowed to purge this relationship.",
        );
      }
    }

    const result = await purgeRelationshipById(relationshipId);

    return {
      ok: true,
      ...result,
    };
  });
