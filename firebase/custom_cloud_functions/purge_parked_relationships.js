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

/*
 * Collections whose documents belong to one relationship.
 *
 * Each collection is searched by relationship_id.
 */
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

// --------------------------------------------------
// Firestore deletion helpers
// --------------------------------------------------

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

    if (snapshot.empty) {
      break;
    }

    const batch = db.batch();

    snapshot.docs.forEach((document) => {
      batch.delete(document.ref);
    });

    await batch.commit();

    total += snapshot.size;

    if (snapshot.size < limit) {
      break;
    }
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

    if (snapshot.empty) {
      break;
    }

    const batch = db.batch();

    snapshot.docs.forEach((document) => {
      batch.delete(document.ref);
    });

    await batch.commit();

    total += snapshot.size;

    if (snapshot.size < limit) {
      break;
    }
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

  /*
   * Current structure:
   * PublicUsers document ID may equal the Firebase UID.
   */
  const directReference = db.collection(PUBLIC_USERS_COL).doc(uid);

  const directSnapshot = await directReference.get();

  if (directSnapshot.exists) {
    references.set(directReference.path, directReference);
  }

  /*
   * Legacy structure:
   * PublicUsers document ID may be different,
   * while the uid is stored as a field.
   */
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

// --------------------------------------------------
// Relationship purge
// --------------------------------------------------

async function purgeRelationshipById(relationshipId) {
  const relationshipRef = db.collection(RELATIONSHIPS_COL).doc(relationshipId);

  const relationshipSnapshot = await relationshipRef.get();

  if (!relationshipSnapshot.exists) {
    /*
     * The main relationship may already be deleted.
     * Still try to remove orphaned relationship data.
     */
    for (const collectionName of RELATIONSHIP_BOUND_COLLECTIONS) {
      await deleteByAnyRelationshipField(collectionName, relationshipId).catch(
        () => null,
      );
    }

    return {
      status: "already_deleted",
      relationship_id: relationshipId,
    };
  }

  const relationship = relationshipSnapshot.data() || {};

  const userAUid = nonEmptyString(
    relationship.userA_id ?? relationship.userAId ?? relationship.userA,
  );

  const userBUid = nonEmptyString(
    relationship.userB_id ?? relationship.userBId ?? relationship.userB,
  );

  const members = uniqueStrings([userAUid, userBUid]);

  // --------------------------------------------------
  // 1. Delete relationship-bound top-level documents
  // --------------------------------------------------

  for (const collectionName of RELATIONSHIP_BOUND_COLLECTIONS) {
    await deleteByAnyRelationshipField(collectionName, relationshipId).catch(
      () => null,
    );
  }

  /*
   * relationship_views are normally stored using the
   * user UID as the document ID, but also clean up any
   * legacy documents that contain relationship_id.
   */
  await deleteByAnyRelationshipField(
    RELATIONSHIP_VIEWS_COL,
    relationshipId,
  ).catch(() => null);

  // --------------------------------------------------
  // 2. Delete relationship subcollections
  // --------------------------------------------------

  const relationshipSubcollections = ["love_coupons"];

  for (const subcollectionName of relationshipSubcollections) {
    await deleteSubcollection(relationshipRef, subcollectionName).catch(
      () => null,
    );
  }

  // --------------------------------------------------
  // 3. Delete relationship_views by member UID
  // --------------------------------------------------

  await Promise.all(
    members.map((uid) =>
      db
        .collection(RELATIONSHIP_VIEWS_COL)
        .doc(uid)
        .delete()
        .catch(() => null),
    ),
  );

  // --------------------------------------------------
  // 4. Delete relationship Storage files
  // --------------------------------------------------

  const storagePrefixes = [
    `couples/${relationshipId}/`,
    `relationships/${relationshipId}/`,
  ];

  for (const prefix of storagePrefixes) {
    await deleteStoragePrefix(prefix).catch(() => null);
  }

  const now = admin.firestore.Timestamp.now();

  // --------------------------------------------------
  // 5. Clean Users
  // --------------------------------------------------

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

    /*
     * Remove any relationship-specific live-location
     * state that may exist in Users.
     *
     * The general preference
     * live_travel_tracking_enabled is deliberately
     * preserved because it is a user setting.
     */
    live_location_active: admin.firestore.FieldValue.delete(),

    live_location_mode: admin.firestore.FieldValue.delete(),

    live_travel_tracking_prompt_event_id: admin.firestore.FieldValue.delete(),

    updated_at: now,
  };

  await Promise.all(
    members.map((uid) =>
      db
        .collection(USERS_COL)
        .doc(uid)
        .set(userPatch, { merge: true })
        .catch(() => null),
    ),
  );

  /*
   * Fallback for legacy or incomplete relationships
   * where member UIDs could not be read correctly.
   */
  const fallbackFields = [
    "last_relationship_id",
    "restore_relationship_id",
    "relationship_id",
  ];

  for (const fieldName of fallbackFields) {
    const fallbackSnapshot = await db
      .collection(USERS_COL)
      .where(fieldName, "==", relationshipId)
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

  // --------------------------------------------------
  // 6. Clean PublicUsers
  // --------------------------------------------------

  const publicUserPatch = {
    relationship_id: admin.firestore.FieldValue.delete(),

    partnerUID: admin.firestore.FieldValue.delete(),

    relationship_status: admin.firestore.FieldValue.delete(),

    updated_at: now,
  };

  for (const uid of members) {
    const references = await getPublicUserReferences(uid).catch(() => []);

    await Promise.all(
      references.map((reference) =>
        reference.set(publicUserPatch, { merge: true }).catch(() => null),
      ),
    );
  }

  /*
   * Additional fallback in case the member list was
   * incomplete but PublicUsers still contains the
   * relationship ID.
   */
  const publicFallbackSnapshot = await db
    .collection(PUBLIC_USERS_COL)
    .where("relationship_id", "==", relationshipId)
    .get()
    .catch(() => null);

  if (publicFallbackSnapshot && !publicFallbackSnapshot.empty) {
    await Promise.all(
      publicFallbackSnapshot.docs.map((document) =>
        document.ref.set(publicUserPatch, { merge: true }).catch(() => null),
      ),
    );
  }

  // --------------------------------------------------
  // 7. Finally delete the relationship document
  // --------------------------------------------------

  await relationshipRef.delete();

  return {
    status: "purged",
    relationship_id: relationshipId,
    members_cleaned: members.length,
  };
}

// --------------------------------------------------
// Scheduled purge
// --------------------------------------------------

exports.purgeParkedRelationships = functions
  .region(REGION)
  .pubsub.schedule("every 30 minutes")
  .timeZone("Europe/Berlin")
  .onRun(async () => {
    const now = admin.firestore.Timestamp.now();

    const snapshot = await db
      .collection(RELATIONSHIPS_COL)
      .where("active", "==", false)
      .where("purge_at", "<=", now)
      .limit(50)
      .get();

    if (snapshot.empty) {
      return {
        ok: true,
        purged: 0,
        results: [],
      };
    }

    const results = [];

    for (const document of snapshot.docs) {
      try {
        const result = await purgeRelationshipById(document.id);

        results.push({
          id: document.id,
          status: result.status,
        });
      } catch (error) {
        console.error("[purgeParkedRelationships] failed:", document.id, error);

        results.push({
          id: document.id,
          status: "error",
          error: String(error?.message || error),
        });
      }
    }

    return {
      ok: true,

      purged: results.filter((result) => result.status === "purged").length,

      results,
    };
  });
