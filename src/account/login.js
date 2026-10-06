"use strict";

// Browser sign-in to the company's Authentik for `sof run account login`.
//
// The standard "browser login for a CLI" flow (OAuth authorization code + PKCE with a loopback
// redirect). sof never sees your password. It receives a short-lived access token (10 minutes)
// plus a refresh token (30 days) and keeps them through src/account/store.js.

const crypto = require("crypto");
const http = require("http");
const childProcess = require("child_process");
const { SOF_REGISTRY_URL } = require("../packages/constants");
const { postForm, writeAccount } = require("./store");

const LOGIN_TIMEOUT_MS = 5 * 60 * 1000;

const base64url = (buffer) => buffer.toString("base64url");

// Never goes through a shell: a URL contains "&", which a shell would mangle (or worse).
function openBrowser(url) {
  if (process.env.SOF_NO_BROWSER === "1") {
    return false;
  }
  const [command, args] =
    process.platform === "win32"
      ? ["rundll32", ["url.dll,FileProtocolHandler", url]]
      : process.platform === "darwin"
        ? ["open", [url]]
        : ["xdg-open", [url]];
  try {
    const child = childProcess.spawn(command, args, { stdio: "ignore", detached: true });
    child.on("error", () => {});
    child.unref();
    return true;
  } catch (_err) {
    return false;
  }
}

async function discover(registryUrl) {
  const configResponse = await fetch(`${registryUrl}/config.json`, { headers: { "User-Agent": "sof-cli" } });
  if (!configResponse.ok) {
    throw new Error(`Could not read the registry configuration from ${registryUrl} (${configResponse.status}).`);
  }
  const config = await configResponse.json().catch(() => ({}));
  if (!config.staff_login || !config.staff_login.issuer || !config.staff_login.client_id) {
    throw new Error("This registry has no sov.gg sign-in configured.");
  }
  const { issuer, client_id: clientId } = config.staff_login;
  const response = await fetch(`${issuer}.well-known/openid-configuration`, { headers: { "User-Agent": "sof-cli" } });
  if (!response.ok) {
    throw new Error(`Could not read the sign-in configuration from ${issuer} (${response.status}).`);
  }
  const doc = await response.json();
  const origin = new URL(issuer).origin;
  if (doc.issuer !== issuer) {
    throw new Error("The sign-in server named a different issuer than the registry; refusing to continue.");
  }
  for (const endpoint of [doc.authorization_endpoint, doc.token_endpoint]) {
    if (typeof endpoint !== "string" || new URL(endpoint).origin !== origin) {
      throw new Error("The sign-in server pointed at another origin; refusing to continue.");
    }
  }
  return { issuer, clientId, authorizationEndpoint: doc.authorization_endpoint, tokenEndpoint: doc.token_endpoint };
}

// Waits for the browser to land on http://127.0.0.1:<port>/callback and returns {code}.
function waitForCallback(server, state) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Timed out waiting for the browser sign-in (5 minutes).")), LOGIN_TIMEOUT_MS);
    timer.unref();
    server.on("request", (req, res) => {
      const url = new URL(req.url, "http://127.0.0.1");
      if (url.pathname !== "/callback") {
        res.writeHead(404).end();
        return;
      }
      const page = (title, text) => {
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
        res.end(`<!doctype html><meta charset="utf-8"><title>${title}</title><body style="font:16px system-ui;max-width:32rem;margin:4rem auto"><h1>${title}</h1><p>${text}</p>`);
      };
      const error = url.searchParams.get("error");
      const code = url.searchParams.get("code");
      if (url.searchParams.get("state") !== state) {
        page("Sign-in failed", "This sign-in response did not match the request. Run the command again.");
        clearTimeout(timer);
        reject(new Error("The sign-in response had the wrong state; aborting."));
        return;
      }
      if (error || !code) {
        page("Sign-in cancelled", "You can close this window.");
        clearTimeout(timer);
        reject(new Error(`Sign-in was not completed (${error || "no code returned"}).`));
        return;
      }
      page("Signed in", "You can close this window and return to the terminal.");
      clearTimeout(timer);
      resolve({ code });
    });
  });
}

async function accountLogin(registryUrl = SOF_REGISTRY_URL, { log = console.log, opener = openBrowser } = {}) {
  const config = await discover(registryUrl);
  const verifier = base64url(crypto.randomBytes(48));
  const challenge = base64url(crypto.createHash("sha256").update(verifier).digest());
  const state = base64url(crypto.randomBytes(24));

  const server = http.createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const redirectUri = `http://127.0.0.1:${server.address().port}/callback`;
  const authorizeUrl =
    `${config.authorizationEndpoint}?` +
    new URLSearchParams({
      client_id: config.clientId,
      redirect_uri: redirectUri,
      response_type: "code",
      scope: "openid profile email offline_access",
      state,
      nonce: base64url(crypto.randomBytes(16)),
      code_challenge: challenge,
      code_challenge_method: "S256",
    }).toString();

  try {
    const callback = waitForCallback(server, state);
    callback.catch(() => {});
    const opened = await opener(authorizeUrl);
    log(opened ? "Opening your browser to sign in..." : "Open this address in your browser to sign in:");
    log(`\n  ${authorizeUrl}\n`);
    const { code } = await callback;

    const result = await postForm(config.tokenEndpoint, {
      grant_type: "authorization_code",
      code,
      redirect_uri: redirectUri,
      client_id: config.clientId,
      code_verifier: verifier,
    });
    if (!result.ok || !result.body.access_token) {
      throw new Error(`The sign-in server refused the login (${result.body.error_description || result.body.error || result.status}).`);
    }
    writeAccount({
      registry: registryUrl,
      issuer: config.issuer,
      client_id: config.clientId,
      token_endpoint: config.tokenEndpoint,
      access_token: result.body.access_token,
      refresh_token: result.body.refresh_token || "",
      expires_at: Date.now() + (Number(result.body.expires_in) || 600) * 1000,
    });
    return true;
  } finally {
    server.close();
  }
}

module.exports = { accountLogin };
