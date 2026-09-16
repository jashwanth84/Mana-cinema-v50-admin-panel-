const { readServiceAccount, getAccessToken } = require('./admin-client');

const SIGN_UP_URL = 'https://identitytoolkit.googleapis.com/v1/accounts:signUp';
const UPDATE_URL = 'https://identitytoolkit.googleapis.com/v1/accounts:update';

const args = process.argv.slice(2);
function argValue(name) {
  const index = args.indexOf(name);
  return index >= 0 && args[index + 1] ? args[index + 1] : null;
}

async function lookupUid(accessToken, email) {
  const response = await fetch('https://identitytoolkit.googleapis.com/v1/accounts:lookup', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + accessToken },
    body: JSON.stringify({ email })
  });
  const data = await response.json();
  if (!response.ok || !data.users || !data.users[0]) {
    throw new Error('Lookup failed for ' + email + ': ' + JSON.stringify(data));
  }
  return data.users[0].localId;
}

async function createUser(accessToken, email, password, displayName) {
  const response = await fetch(SIGN_UP_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + accessToken },
    body: JSON.stringify({ email, password, displayName, returnSecureToken: true })
  });
  const data = await response.json();
  if (!response.ok || !data.localId) {
    throw new Error('Account creation failed for ' + email + ': ' + JSON.stringify(data));
  }
  return data.localId;
}

async function setAdminClaim(accessToken, localId) {
  const response = await fetch(UPDATE_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + accessToken },
    body: JSON.stringify({ localId, customAttributes: JSON.stringify({ admin: true }) })
  });
  const data = await response.json();
  if (!response.ok) {
    throw new Error('Custom claim failed: ' + JSON.stringify(data));
  }
}

function requireArgs() {
  const grantAdminEmail = argValue('--grant-admin-email');
  const adminEmail = argValue('--admin-email');
  const adminPass = argValue('--admin-pass');
  const userEmail = argValue('--user-email');
  const userPass = argValue('--user-pass');
  if (grantAdminEmail) {
    return { grantAdminEmail };
  }
  if (!adminEmail || !adminPass || !userEmail || !userPass) {
    console.error('Usage: node provision.js --admin-email admin@example.com --admin-pass ******** --user-email user@example.com --user-pass ******** [--admin-name Name] [--user-name Name]');
    console.error('Or grant admin to an existing account: node provision.js --grant-admin-email existing@example.com');
    process.exit(1);
  }
  return {
    adminEmail,
    adminPass,
    userEmail,
    userPass,
    adminName: argValue('--admin-name') || 'Admin',
    userName: argValue('--user-name') || 'User'
  };
}

async function main() {
  const config = requireArgs();
  const serviceAccount = readServiceAccount();
  const accessToken = await getAccessToken(serviceAccount);

  if (config.grantAdminEmail) {
    const uid = await lookupUid(accessToken, config.grantAdminEmail);
    await setAdminClaim(accessToken, uid);
    console.log('Admin claim granted: ' + config.grantAdminEmail + ' (uid ' + uid + ', claim admin:true)');
    return;
  }

  const adminUid = await createUser(accessToken, config.adminEmail, config.adminPass, config.adminName);
  await setAdminClaim(accessToken, adminUid);
  console.log('Admin account created: ' + config.adminEmail + ' (uid ' + adminUid + ', claim admin:true)');

  const userUid = await createUser(accessToken, config.userEmail, config.userPass, config.userName);
  console.log('User account created: ' + config.userEmail + ' (uid ' + userUid + ')');
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});