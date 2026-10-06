"use strict";

// The account API add-ons get instead of the login. It runs in sof core, holds the token, and
// answers requests that came from an add-on (over IPC from its sandbox, or directly in tests).
// The add-on never receives the token, an Authorization header or the account file.

const { SOF_REGISTRY_URL } = require("../packages/constants");
const { getAccessToken, noteRegistryResponse } = require("./store");
const { ceilingHosts, schemeAllowed } = require("./hosts");

const METHODS = new Set(["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE"]);
// Headers an add-on may not set: credentials (we add the real one) and anything the transport owns.
const BLOCKED_REQUEST_HEADERS = new Set([
  "authorization",
  "proxy-authorization",
  "cookie",
  "host",
  "content-length",
  "connection",
  "transfer-encoding",
]);
// The only response headers handed back; never set-cookie or anything credential-like.
const RETURNED_HEADERS = ["content-type", "content-length", "etag", "location", "retry-after", "www-authenticate", "link"];

const MAX_BODY_BYTES = 5 * 1024 * 1024;
const MAX_RESPONSE_BYTES = 64 * 1024 * 1024;
const TIMEOUT_MS = 60 * 1000;

class AccountError extends Error {
  constructor(message, code) {
    super(message);
    this.code = code;
  }
}

// hosts: what the user granted this add-on (already within core's ceiling when it came from grants.js).
function createBroker({ addon, hosts, registryUrl = SOF_REGISTRY_URL, fetchImpl = fetch }) {
  const granted = new Set((hosts || []).map((host) => host.toLowerCase()));

  function checkUrl(rawUrl) {
    let url;
    try {
      url = new URL(String(rawUrl));
    } catch (_err) {
      throw new AccountError(`"${rawUrl}" is not a valid address.`, "bad_request");
    }
    if (!schemeAllowed(url)) {
      throw new AccountError(`${addon} may only use your sov.gg login over https.`, "bad_request");
    }
    if (url.username || url.password) {
      throw new AccountError("Addresses with credentials in them are refused.", "bad_request");
    }
    const host = url.host.toLowerCase();
    if (!granted.has(host) || !ceilingHosts(registryUrl).has(host)) {
      throw new AccountError(`${addon} is not allowed to send your sov.gg login to ${host}.`, "host_denied");
    }
    return url;
  }

  async function signedIn() {
    const token = await getAccessToken(registryUrl);
    if (!token) {
      throw new AccountError('Not signed in to sov.gg. Run "sof run account login".', "not_signed_in");
    }
    return token;
  }

  async function request({ url: rawUrl, method = "GET", headers = {}, body = null } = {}) {
    const url = checkUrl(rawUrl);
    const verb = String(method).toUpperCase();
    if (!METHODS.has(verb)) {
      throw new AccountError(`Method ${verb} is not allowed.`, "bad_request");
    }
    if (body !== null && typeof body !== "string") {
      throw new AccountError("The request body must be a string.", "bad_request");
    }
    if (body !== null && Buffer.byteLength(body) > MAX_BODY_BYTES) {
      throw new AccountError("The request body is too large.", "bad_request");
    }

    const sent = {};
    for (const [name, value] of Object.entries(headers || {})) {
      if (typeof value === "string" && !BLOCKED_REQUEST_HEADERS.has(name.toLowerCase())) {
        sent[name] = value;
      }
    }
    sent.Authorization = `Bearer ${await signedIn()}`;

    let response;
    try {
      response = await fetchImpl(url, {
        method: verb,
        headers: sent,
        body: verb === "GET" || verb === "HEAD" ? undefined : body,
        redirect: "manual", // never follow to another origin with the login attached
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch (err) {
      const cause = err.cause && err.cause.message ? `: ${err.cause.message}` : "";
      throw new AccountError(`request to ${url.host} failed (${err.message}${cause})`, "network");
    }
    noteRegistryResponse(response);

    const text = await response.text();
    if (text.length > MAX_RESPONSE_BYTES) {
      throw new AccountError("The response was too large.", "network");
    }
    const returned = {};
    for (const name of RETURNED_HEADERS) {
      const value = response.headers.get(name);
      if (value !== null) {
        returned[name] = value;
      }
    }
    return { status: response.status, ok: response.ok, headers: returned, body: text };
  }

  // Who the login belongs to. Never the token.
  async function whoami() {
    const token = await signedIn();
    const response = await fetchImpl(`${registryUrl}/v1/staff/whoami`, {
      headers: { Authorization: `Bearer ${token}`, Accept: "application/json", "User-Agent": "sof-cli" },
      redirect: "manual",
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!response.ok) {
      throw new AccountError(`sov.gg whoami failed (${response.status}).`, "network");
    }
    const me = await response.json();
    return {
      username: String(me.username || ""),
      email: me.email ? String(me.email) : "",
      staff: me.staff === true,
      groups: Array.isArray(me.groups) ? me.groups.map(String) : [],
    };
  }

  return { request, whoami };
}

module.exports = { AccountError, createBroker };
