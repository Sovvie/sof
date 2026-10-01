"use strict";

// Registry sign-in: where the token lives and how to get one.
//
// Tokens come from the registry's own GitHub OAuth app (device flow, like Wally), so no
// password ever touches sof. SOF_REGISTRY_TOKEN (for CI) wins over the saved ~/.sof/auth.json.
// SOF_TOKEN and GITHUB_TOKEN are deliberately not used: the registry only accepts tokens it
// issued itself. A token is never printed or logged.

const fs = require("fs");
const path = require("path");
const { sofHome } = require("../addons/store");
const { SOF_REGISTRY_URL } = require("./constants");

const NOT_SIGNED_IN = 'Not signed in. Run "sof run package login" first.';
const GITHUB_URL = "https://github.com";
const DEVICE_GRANT_TYPE = "urn:ietf:params:oauth:grant-type:device_code";

function authFilePath() {
  return path.join(sofHome(), "auth.json");
}

function readSavedAuth() {
  try {
    const parsed = JSON.parse(fs.readFileSync(authFilePath(), "utf8"));
    if (parsed && typeof parsed.token === "string" && parsed.token.trim() !== "") {
      return {
        token: parsed.token.trim(),
        login: typeof parsed.login === "string" ? parsed.login : null,
      };
    }
  } catch (_err) {
    // Missing or unreadable file: not signed in.
  }
  return null;
}

// { token, source, login } or null. `source` says where the token came from, for messages.
function findToken() {
  const fromEnvironment = (process.env.SOF_REGISTRY_TOKEN || "").trim();
  if (fromEnvironment) {
    return { token: fromEnvironment, source: "SOF_REGISTRY_TOKEN", login: null };
  }

  const saved = readSavedAuth();
  return saved ? { token: saved.token, source: authFilePath(), login: saved.login } : null;
}

function requireToken() {
  const found = findToken();
  if (!found) {
    throw new Error(NOT_SIGNED_IN);
  }
  return found;
}

function saveAuth({ token, login }) {
  const filePath = authFilePath();
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify({ token, login }, null, 2)}\n`, { mode: 0o600 });
  try {
    // writeFileSync only applies the mode when it creates the file.
    fs.chmodSync(filePath, 0o600);
  } catch (_err) {
    // Best effort: Windows has no POSIX modes.
  }
  return filePath;
}

// True when a saved sign-in was removed.
function clearAuth() {
  const filePath = authFilePath();
  if (!fs.existsSync(filePath)) {
    return false;
  }
  fs.rmSync(filePath, { force: true });
  return true;
}

async function readJson(response, what) {
  try {
    return await response.json();
  } catch (_err) {
    throw new Error(`${what} sent an unreadable response (HTTP ${response.status}).`);
  }
}

async function fetchRegistryConfig(registryUrl = SOF_REGISTRY_URL) {
  const response = await fetch(`${registryUrl}/config.json`);
  if (!response.ok) {
    throw new Error(`Could not read ${registryUrl}/config.json (HTTP ${response.status}).`);
  }
  return readJson(response, "The registry");
}

async function postGithubForm(githubUrl, urlPath, fields) {
  const response = await fetch(`${githubUrl}${urlPath}`, {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams(fields).toString(),
  });
  return readJson(response, "GitHub");
}

const defaultSleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

// GitHub device flow. Resolves to the access token. `options.onCode({ url, code })` shows the
// user where to enter the code; `githubUrl`, `sleep` and `now` exist so tests don't need
// GitHub or real waiting.
async function deviceLogin(options = {}) {
  const registryUrl = options.registryUrl || SOF_REGISTRY_URL;
  const githubUrl = options.githubUrl || GITHUB_URL;
  const sleep = options.sleep || defaultSleep;
  const now = options.now || Date.now;

  const config = await fetchRegistryConfig(registryUrl);
  if (!config.github_oauth_id || config.publishing === false) {
    throw new Error(`Publishing is switched off on the registry at ${registryUrl}.`);
  }

  // No scope: the token only has to prove who the user is.
  const device = await postGithubForm(githubUrl, "/login/device/code", {
    client_id: config.github_oauth_id,
  });
  if (!device.device_code || !device.user_code || !device.verification_uri) {
    throw new Error(
      `GitHub did not start a device sign-in: ${device.error_description || device.error || "unexpected response"}.`
    );
  }

  if (options.onCode) {
    options.onCode({ url: device.verification_uri, code: device.user_code });
  }

  let intervalSeconds = Number(device.interval) > 0 ? Number(device.interval) : 5;
  const deadline = now() + (Number(device.expires_in) > 0 ? Number(device.expires_in) : 900) * 1000;

  while (true) {
    await sleep(intervalSeconds * 1000);
    if (now() > deadline) {
      throw new Error('The sign-in code expired before it was used. Run "sof run package login" again.');
    }

    const reply = await postGithubForm(githubUrl, "/login/oauth/access_token", {
      client_id: config.github_oauth_id,
      device_code: device.device_code,
      grant_type: DEVICE_GRANT_TYPE,
    });

    if (typeof reply.access_token === "string" && reply.access_token) {
      return reply.access_token;
    }

    switch (reply.error) {
      case "authorization_pending":
        break;
      case "slow_down":
        intervalSeconds = Math.max(intervalSeconds + 5, Number(reply.interval) || 0);
        break;
      case "expired_token":
        throw new Error('The sign-in code expired before it was used. Run "sof run package login" again.');
      case "access_denied":
        throw new Error("Sign-in was cancelled on GitHub.");
      default:
        throw new Error(
          `GitHub sign-in failed: ${reply.error_description || reply.error || "unexpected response"}.`
        );
    }
  }
}

module.exports = {
  NOT_SIGNED_IN,
  authFilePath,
  clearAuth,
  deviceLogin,
  fetchRegistryConfig,
  findToken,
  readSavedAuth,
  requireToken,
  saveAuth,
};
