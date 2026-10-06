"use strict";

// The sov.gg account (Authentik) login: where it is kept and how a token is obtained for use.
//
// Only sof core code reads this file. Add-ons never get the token: sandboxed add-ons run in a
// child process that cannot read ~/.sof (see src/addons/run-sandboxed.js) and reach the account
// through src/account/broker.js. The token is only ever sent to the registry it was issued for.

const fs = require("fs");
const path = require("path");
const { sofHome } = require("../addons/store");
const { SOF_REGISTRY_URL } = require("../packages/constants");
const secretStore = require("./secret-store");

const REFRESH_MARGIN_MS = 60 * 1000;

function accountFile() {
  return path.join(sofHome(), "account.json");
}

// Before `sof run account`, the sign-in lived in staff-auth.json.
function legacyFile() {
  return path.join(sofHome(), "staff-auth.json");
}

function parseAccount(file) {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
    return parsed && typeof parsed.access_token === "string" ? parsed : null;
  } catch (_err) {
    return null;
  }
}

// The refresh token is kept by the OS secret store when there is one (see secret-store.js); an
// account.json written before that, or where no store exists, holds it in the owner-only file.
let upgradeTried = false;
function upgradePlaintext(auth) {
  if (!auth.refresh_token || auth.refresh_protection || upgradeTried || !secretStore.enabled()) {
    return auth;
  }
  upgradeTried = true;
  writeAccount(auth);
  return parseAccount(accountFile()) || auth;
}

function readAccount() {
  const current = parseAccount(accountFile());
  if (current) {
    return upgradePlaintext(current);
  }
  const legacy = parseAccount(legacyFile());
  if (legacy) {
    writeAccount(legacy);
    fs.rmSync(legacyFile(), { force: true });
    return legacy;
  }
  return null;
}

function writeAccount(data) {
  const stored = { ...data };
  if (stored.refresh_token) {
    const protection = secretStore.protect(stored.refresh_token, { account: stored.registry });
    if (protection) {
      stored.refresh_protection = protection;
      stored.refresh_token = "";
    } else {
      delete stored.refresh_protection;
      if (secretStore.enabled()) {
        warnOnce("No secure store was available for your sov.gg sign-in; it is kept in a file only you can read.");
      }
    }
  }

  fs.mkdirSync(sofHome(), { recursive: true });
  const temporary = `${accountFile()}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(stored, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(temporary, accountFile());
  try {
    fs.chmodSync(accountFile(), 0o600);
  } catch (_err) {
    // Windows has no chmod; the file lives in the user's profile.
  }
}

function clearAccount() {
  const existing = parseAccount(accountFile());
  if (existing && existing.refresh_protection) {
    secretStore.forget(existing.refresh_protection);
  }
  fs.rmSync(accountFile(), { force: true });
  fs.rmSync(legacyFile(), { force: true });
}

async function postForm(url, fields) {
  const response = await fetch(url, {
    method: "POST",
    headers: { Accept: "application/json", "Content-Type": "application/x-www-form-urlencoded", "User-Agent": "sof-cli" },
    body: new URLSearchParams(fields).toString(),
  });
  const body = await response.json().catch(() => ({}));
  return { ok: response.ok, status: response.status, body };
}

let warned = false;
function warnOnce(message) {
  if (!warned) {
    warned = true;
    console.error(message);
  }
}

// A valid access token for `registryUrl`, refreshing it if it is about to expire. Returns "" when
// there is none (not signed in, signed in to a different registry, or the sign-in has lapsed).
async function getAccessToken(registryUrl = SOF_REGISTRY_URL) {
  let auth = readAccount();
  if (!auth || auth.registry !== registryUrl) {
    return "";
  }
  if (auth.expires_at - REFRESH_MARGIN_MS > Date.now()) {
    return auth.access_token;
  }
  if (!auth.refresh_token && !auth.refresh_protection) {
    warnOnce('Your sov.gg sign-in expired. Run "sof run account login".');
    return "";
  }

  // Another sof process may have refreshed while we were starting; use that instead of racing it.
  auth = readAccount() || auth;
  if (auth.expires_at - REFRESH_MARGIN_MS > Date.now()) {
    return auth.access_token;
  }
  const refreshToken = auth.refresh_protection ? secretStore.unprotect(auth.refresh_protection) : auth.refresh_token;
  if (!refreshToken) {
    warnOnce('Your sov.gg sign-in could not be unlocked here (another user or machine?). Run "sof run account login" again.');
    return "";
  }
  try {
    const result = await postForm(auth.token_endpoint, {
      grant_type: "refresh_token",
      refresh_token: refreshToken,
      client_id: auth.client_id,
    });
    if (!result.ok || !result.body.access_token) {
      warnOnce('Your sov.gg sign-in has lapsed. Run "sof run account login" to sign in again.');
      return "";
    }
    const next = {
      ...auth,
      access_token: result.body.access_token,
      refresh_token: result.body.refresh_token || refreshToken,
      expires_at: Date.now() + (Number(result.body.expires_in) || 600) * 1000,
    };
    delete next.refresh_protection; // writeAccount protects the (possibly rotated) token afresh
    writeAccount(next);
    return next.access_token;
  } catch (_err) {
    // Offline or the sign-in server is down: carry on as an anonymous reader.
    return "";
  }
}

// Call after a registry response: tell the user once if the registry rejected their token.
function noteRegistryResponse(response) {
  const challenge = response.headers && response.headers.get && response.headers.get("www-authenticate");
  if (challenge && /invalid_token/.test(challenge)) {
    warnOnce('The registry did not accept your sov.gg sign-in. Run "sof run account login" again.');
  }
}

module.exports = {
  accountFile,
  clearAccount,
  getAccessToken,
  noteRegistryResponse,
  postForm,
  readAccount,
  warnOnce,
  writeAccount,
};
