/**
 * Auto-sends push notifications the moment the admin panel writes one to
 * Realtime Database, instead of requiring someone to run
 * `server/send-notifications.js` by hand.
 *
 * Trigger: RTDB `notifications/{notificationId}` create.
 * Delivery: OneSignal REST API (same OneSignal app as the Android SDK,
 * App ID below). The app calls OneSignal.login(uid) on sign-in, so every
 * user is addressable by their Firebase uid as external_id — the same uids
 * the admin panel already targets by email.
 *
 * SECRET — the OneSignal REST API key is read from the environment and must
 * NEVER be committed. The local copy lives in the git-ignored
 * secrets.properties (ONESIGNAL_REST_API_KEY). Set it on the function with:
 *   firebase deploy --only functions --set-env-vars ONESIGNAL_REST_API_KEY=...
 * or (Google Cloud console) Cloud Functions -> service -> Edit -> Environment
 * variables. Without it the function logs an error, writes `error` on the
 * notification record and leaves `pushed` false so it can be re-driven.
 */
const { onValueCreated } = require("firebase-functions/v2/database");
const { logger } = require("firebase-functions");
const admin = require("firebase-admin");

admin.initializeApp();

const ONESIGNAL_APP_ID = "5ac52536-3dcf-4430-89d2-8488e887abad";
const ONESIGNAL_API_URL = "https://api.onesignal.com/notifications";
// OneSignal accepts up to 20,000 aliases per request; keep a safe margin.
const ALIASES_PER_REQUEST = 10000;

function isBanned(value) {
  return value === true || value === "true" || value === 1;
}

function collectUsers(usersSnapshotVal) {
  const users = [];
  if (!usersSnapshotVal) return users;
  Object.keys(usersSnapshotVal).forEach((uid) => {
    const record = usersSnapshotVal[uid];
    users.push({
      uid,
      email: (record.email || "").toLowerCase(),
      banned: isBanned(record.isBanned),
    });
  });
  return users;
}

/** Resolves the admin panel's target selection into Firebase uids (= OneSignal external_ids). */
function targetUids(users, notification) {
  if (notification.target === "specific") {
    const emails = String(notification.targetEmails || "")
      .split(",")
      .map((entry) => entry.trim().toLowerCase())
      .filter(Boolean);
    const uids = emails.filter((entry) => !entry.includes("@"));
    const matched = users.filter(
      (user) => emails.includes(user.email) || (uids.length > 0 && uids.includes(user.uid))
    );
    return matched.map((user) => user.uid);
  }
  return users.filter((user) => !user.banned).map((user) => user.uid);
}

/**
 * Builds the OneSignal push payload. `data` keeps the exact same keys the app
 * received under FCM (id, title, message, image, imageUrl, movieId, icon), so
 * existing deep-link handling in the app keeps working unchanged.
 */
function buildPayload(notification, notificationId, uids) {
  const data = {
    id: notification.id || notificationId,
    title: notification.title || "",
    message: notification.message || "",
    image: notification.image || notification.imageUrl || "",
    imageUrl: notification.imageUrl || notification.image || "",
    movieId: notification.movieId || "",
  };
  if (notification.icon && String(notification.icon).startsWith("fa-")) {
    data.icon = notification.icon;
  }
  const payload = {
    app_id: ONESIGNAL_APP_ID,
    target_channel: "push",
    include_aliases: { external_id: uids },
    headings: { en: notification.title || "Mana Cinema" },
    contents: { en: notification.message || "" },
    data,
  };
  const picture = notification.image || notification.imageUrl || notification.moviePoster || "";
  if (picture) {
    payload.big_picture = picture; // Android large image
    payload.large_icon = picture;
  }
  return payload;
}

async function sendToOneSignal(payload) {
  const apiKey = process.env.ONESIGNAL_REST_API_KEY;
  const response = await fetch(ONESIGNAL_API_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: "Key " + apiKey,
    },
    body: JSON.stringify(payload),
  });
  const body = await response.json().catch(() => ({}));
  return { ok: response.ok, status: response.status, body };
}

function chunk(list, size) {
  const chunks = [];
  for (let i = 0; i < list.length; i += size) {
    chunks.push(list.slice(i, i + size));
  }
  return chunks;
}

exports.sendNotificationOnCreate = onValueCreated(
  "/notifications/{notificationId}",
  async (event) => {
    const notification = event.data.val();
    const notificationId = event.params.notificationId;

    if (!notification || notification.pushed === true) {
      return null; // already sent, or empty write
    }

    if (!process.env.ONESIGNAL_REST_API_KEY) {
      logger.error(
        "ONESIGNAL_REST_API_KEY is not set — cannot deliver notification " +
          notificationId + " via OneSignal."
      );
      await event.data.ref.update({
        error: "ONESIGNAL_REST_API_KEY not set",
        failedAt: admin.database.ServerValue.TIMESTAMP,
      });
      return null;
    }

    const db = admin.database();
    const usersSnap = await db.ref("users").get();
    const users = collectUsers(usersSnap.val());
    const uids = targetUids(users, notification);

    logger.info(
      "Notification " + notificationId + ": targeting " + uids.length + " user(s) via OneSignal."
    );

    let sent = 0;
    let failed = 0;
    const onesignalIds = [];
    const errors = [];

    for (const batch of chunk(uids, ALIASES_PER_REQUEST)) {
      try {
        const result = await sendToOneSignal(
          buildPayload(notification, notificationId, batch)
        );
        if (result.ok && result.body && result.body.id) {
          onesignalIds.push(result.body.id);
          if (typeof result.body.recipients === "number") {
            sent += result.body.recipients;
          }
        } else if (result.ok) {
          // 200 with no id = OneSignal created no message: every alias in this
          // batch has no active subscription. Not a delivery failure.
          logger.warn(
            "Notification " + notificationId + ": OneSignal created no message for a batch " +
              "(no active subscriptions for those users)."
          );
        } else {
          failed += 1;
          const detail = JSON.stringify(result.body).slice(0, 300);
          errors.push(detail);
          logger.error(
            "OneSignal send failed for notification " + notificationId +
              " (" + result.status + "): " + detail
          );
        }
      } catch (error) {
        failed += 1;
        errors.push(error.message);
        logger.error("OneSignal request error for notification " + notificationId + ": " + error.message);
      }
    }

    // Keep the exact record shape the admin panel's "Sent Notifications" view
    // already reads, plus the OneSignal message ids for dashboard cross-reference.
    await event.data.ref.update({
      pushed: true,
      sentCount: sent,
      failedCount: failed,
      sentAt: admin.database.ServerValue.TIMESTAMP,
      ...(onesignalIds.length > 0 ? { onesignalIds } : {}),
      ...(errors.length > 0 ? { lastErrors: errors.slice(0, 5) } : {}),
    });

    logger.info(
      "Notification " + notificationId + ": recipients=" + sent + " failedRequests=" + failed
    );
    return null;
  }
);
