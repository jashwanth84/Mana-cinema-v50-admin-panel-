// MANUAL FALLBACK ONLY. Notifications the admin panel writes are now sent automatically by
// the `sendNotificationOnCreate` Cloud Function in functions/index.js as soon as they're
// created. Run this script by hand only if Cloud Functions are unavailable (e.g. no Blaze
// plan) or to re-drive a notification that somehow didn't fire.
const { readServiceAccount, readRealtimeDatabaseUrl, getAccessToken } = require('./admin-client');

const FCM_V1_URL = 'https://fcm.googleapis.com/v1/projects/Z_PROJECT/messages:send';
const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');

function rtdbUrl() {
  return readRealtimeDatabaseUrl().replace(/\/$/, '');
}

function rtdbFetch(url, token, options) {
  return fetch(url + '?access_token=' + encodeURIComponent(token), options);
}

function isBanned(value) {
  return value === true || value === 'true' || value === 1;
}

function tokensForRecord(record) {
  const tokens = new Set();
  if (record && record.fcmToken) tokens.add(record.fcmToken);
  if (record && record.fcmTokens && typeof record.fcmTokens === 'object') {
    Object.keys(record.fcmTokens).forEach((token) => tokens.add(token));
  }
  return Array.from(tokens);
}

function collectUsers(usersSnapshot) {
  const users = [];
  if (!usersSnapshot) return users;
  Object.keys(usersSnapshot).forEach((uid) => {
    const record = usersSnapshot[uid];
    const tokens = tokensForRecord(record);
    if (tokens.length === 0) return;
    users.push({
      uid,
      email: (record.email || '').toLowerCase(),
      displayName: record.displayName || '',
      tokens,
      banned: isBanned(record.isBanned)
    });
  });
  return users;
}

function targetTokens(users, notification) {
  if (notification.target === 'specific') {
    const emails = String(notification.targetEmails || '')
      .split(',')
      .map((entry) => entry.trim().toLowerCase())
      .filter(Boolean);
    const uids = emails.filter((entry) => !entry.includes('@'));
    const matched = users.filter((user) =>
      emails.includes(user.email) || (uids.length > 0 && uids.includes(user.uid))
    );
    return matched.flatMap((user) => user.tokens);
  }
  return users.filter((user) => !user.banned).flatMap((user) => user.tokens);
}

function buildMessage(notification, token) {
  const message = {
    token,
    notification: {
      title: notification.title || 'Mana Cinema',
      body: notification.message || ''
    },
    data: {
      id: notification.id || '',
      title: notification.title || '',
      message: notification.message || '',
      image: notification.image || notification.imageUrl || '',
      imageUrl: notification.imageUrl || notification.image || '',
      movieId: notification.movieId || ''
    }
  };
  if (notification.icon && notification.icon.startsWith('fa-')) {
    message.data.icon = notification.icon;
  }
  return message;
}

async function sendToDevice(token, notification, projectId, accessToken) {
  const response = await fetch(FCM_V1_URL.replace('Z_PROJECT', projectId), {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': 'Bearer ' + accessToken
    },
    body: JSON.stringify({ message: buildMessage(notification, token) })
  });
  if (response.ok) return { ok: true };
  const body = await response.text().catch(() => '');
  const stale = response.status === 404 ||
    body.includes('UNREGISTERED') || body.includes('INVALID_ARGUMENT');
  return { ok: false, stale, status: response.status, detail: body.slice(0, 160) };
}

async function markPushed(notification, token, summary) {
  const patch = {
    pushed: true,
    pushedAt: Date.now(),
    sentCount: summary.sent,
    failedCount: summary.failed
  };
  const response = await rtdbFetch(
    rtdbUrl() + '/notifications/' + notification.id + '.json',
    token,
    { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(patch) }
  );
  if (!response.ok) {
    console.error('  WARNING: could not mark notification ' + notification.id + ' as pushed (' + response.status + ')');
  }
}

async function main() {
  const serviceAccount = readServiceAccount();
  const projectId = serviceAccount.project_id;
  const accessToken = await getAccessToken(serviceAccount);

  const notificationsResponse = await rtdbFetch(rtdbUrl() + '/notifications.json', accessToken);
  if (!notificationsResponse.ok) {
    throw new Error('Notifications read failed (' + notificationsResponse.status + '). An RTDB admin access token was used, so check the RTDB URL in admin-client.js.');
  }
  const notificationsJson = await notificationsResponse.json();
  const notifications = notificationsJson
    ? Object.keys(notificationsJson).map((key) => ({ id: key, ...notificationsJson[key] }))
    : [];
  const pending = notifications.filter((notification) => !notification.pushed);

  const usersResponse = await rtdbFetch(rtdbUrl() + '/users.json', accessToken);
  if (!usersResponse.ok) {
    throw new Error('Users read failed (' + usersResponse.status + ').');
  }
  const users = collectUsers(await usersResponse.json());
  console.log('Project            : ' + projectId);
  console.log('Pending            : ' + pending.length + ' notification(s)');
  console.log('Registered devices : ' + users.length + ' token(s)');
  if (dryRun) {
    console.log('DRY RUN - no messages sent, nothing modified.');
  }

  for (const notification of pending) {
    const tokens = targetTokens(users, notification);
    console.log('  - "' + (notification.title || 'untitled') + '" -> ' + tokens.length + ' device(s)' + (dryRun ? ' [dry]' : ''));
    if (dryRun) continue;

    let sent = 0;
    let failed = 0;
    let stale = 0;
    for (const token of tokens) {
      const result = await sendToDevice(token, notification, projectId, accessToken);
      if (result.ok) sent += 1;
      else {
        failed += 1;
        if (result.stale) stale += 1;
      }
    }
    await markPushed(notification, accessToken, { sent, failed });
    console.log('    sent: ' + sent + ', failed: ' + failed + (stale > 0 ? ' (' + stale + ' stale token(s))' : ''));
  }

  if (pending.length === 0 && notifications.length > 0) {
    console.log('No pending notifications. Add one from the admin panel and re-run this script.');
  }
  if (notifications.length === 0) {
    console.log('The notifications node is empty. Create one in the admin panel first, then re-run.');
  }
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});