const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const SERVICE_ACCOUNT_PATH = path.join(__dirname, 'service-account.json');
const GOOGLE_SERVICES_PATH = path.join(__dirname, '..', 'app', 'google-services.json');
const IDENTITY_TOOLKIT_URL = 'https://identitytoolkit.googleapis.com/v1';
const SCOPE = [
  'https://www.googleapis.com/auth/cloud-platform',
  'https://www.googleapis.com/auth/userinfo.email',
  'https://www.googleapis.com/auth/firebase',
  'https://www.googleapis.com/auth/firebase.database'
].join(' ');

function readServiceAccount() {
  if (!fs.existsSync(SERVICE_ACCOUNT_PATH)) {
    console.error('Missing ' + SERVICE_ACCOUNT_PATH + ': open Firebase Console > Project settings > Service accounts and download the service-account JSON into the server/ folder.');
    process.exit(1);
  }
  return JSON.parse(fs.readFileSync(SERVICE_ACCOUNT_PATH, 'utf8'));
}

function readRealtimeDatabaseUrl() {
  if (fs.existsSync(GOOGLE_SERVICES_PATH)) {
    const config = JSON.parse(fs.readFileSync(GOOGLE_SERVICES_PATH, 'utf8'));
    if (config.project_info && config.project_info.firebase_url) {
      return config.project_info.firebase_url;
    }
  }
  return 'https://booyahx-284ea-default-rtdb.asia-southeast1.firebasedatabase.app';
}

function base64Url(buffer) {
  return Buffer.from(buffer).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function signJwt(serviceAccount, claims) {
  const header = base64Url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const payload = base64Url(JSON.stringify(claims));
  const signature = crypto.createSign('RSA-SHA256')
    .update(header + '.' + payload)
    .sign(serviceAccount.private_key, 'base64');
  return header + '.' + payload + '.' + base64Url(Buffer.from(signature, 'base64'));
}

async function getAccessToken(serviceAccount) {
  const now = Math.floor(Date.now() / 1000);
  const assertion = signJwt(serviceAccount, {
    iss: serviceAccount.client_email,
    scope: SCOPE,
    aud: serviceAccount.token_uri,
    iat: now,
    exp: now + 3600
  });
  const response = await fetch(serviceAccount.token_uri, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion })
  });
  const data = await response.json();
  if (!response.ok || !data.access_token) {
    throw new Error('Token exchange failed: ' + JSON.stringify(data));
  }
  return data.access_token;
}

module.exports = {
  SERVICE_ACCOUNT_PATH,
  IDENTITY_TOOLKIT_URL,
  SCOPE,
  readServiceAccount,
  readRealtimeDatabaseUrl,
  getAccessToken
};