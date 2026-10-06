"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("crypto");
const fs = require("fs");
const http = require("http");
const os = require("os");
const path = require("path");
const { once } = require("events");

process.env.SOF_ACCOUNT_PROTECTION = "off"; // these tests read the stored tokens directly
process.env.SOF_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "sofstaff-"));
const store = require("../src/account/store");
const login = require("../src/account/login");
const auth = {
  staffLogin: login.accountLogin,
  readStaffAuth: store.readAccount,
  clearStaffAuth: store.clearAccount,
  getStaffAccessToken: store.getAccessToken,
  noteRegistryResponse: store.noteRegistryResponse,
  authFile: store.accountFile,
};

const json = (res, status, body) => {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
};

// A stand-in for the registry and for Authentik, on one port.
async function startServer(options = {}) {
  const state = { tokenRequests: [], challenges: new Map(), refreshTokens: new Set(["refresh-1"]), seen: [] };
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      state.seen.push({ url: req.url, headers: req.headers });
      const base = `http://127.0.0.1:${server.address().port}`;
      const issuer = `${base}/application/o/sof-registry/`;
      if (req.url === "/config.json") {
        if (options.configStatus) return json(res, options.configStatus, {});
        return json(res, 200, { api: 1, staff_login: options.noStaffLogin ? null : { issuer, client_id: "sof-registry" } });
      }
      if (req.url.endsWith("/.well-known/openid-configuration")) {
        return json(res, 200, {
          issuer: options.wrongIssuer ? "https://evil.example/" : issuer,
          authorization_endpoint: `${base}/application/o/authorize/`,
          token_endpoint: options.foreignTokenEndpoint ? "https://evil.example/token" : `${base}/application/o/token/`,
        });
      }
      if (req.url === "/application/o/token/") {
        const form = Object.fromEntries(new URLSearchParams(body));
        state.tokenRequests.push(form);
        if (form.grant_type === "authorization_code") {
          const challenge = state.challenges.get(form.code);
          const proof = crypto.createHash("sha256").update(form.code_verifier || "").digest("base64url");
          if (!challenge || proof !== challenge) return json(res, 400, { error: "invalid_grant" });
          return json(res, 200, { access_token: "access-1", refresh_token: "refresh-1", expires_in: 600 });
        }
        if (form.grant_type === "refresh_token") {
          if (!state.refreshTokens.has(form.refresh_token)) return json(res, 400, { error: "invalid_grant" });
          state.refreshTokens.delete(form.refresh_token);
          state.refreshTokens.add("refresh-2");
          return json(res, 200, { access_token: "access-2", refresh_token: "refresh-2", expires_in: 600 });
        }
      }
      if (req.url === "/v1/staff/whoami") return json(res, 200, { username: "alice", email: "alice@sov.gg", staff: true });
      return json(res, 404, {});
    });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  state.base = `http://127.0.0.1:${server.address().port}`;
  state.close = () => server.close();
  return state;
}

// Plays the browser: reads the authorize URL, remembers the PKCE challenge, then "redirects" back.
function browser(idp, overrides = {}) {
  return async (authorizeUrl) => {
    const params = new URL(authorizeUrl).searchParams;
    assert.equal(params.get("client_id"), "sof-registry");
    assert.equal(params.get("response_type"), "code");
    assert.equal(params.get("code_challenge_method"), "S256");
    assert.match(params.get("scope"), /offline_access/);
    assert.match(params.get("redirect_uri"), /^http:\/\/127\.0\.0\.1:\d+\/callback$/);
    idp.challenges.set("the-code", params.get("code_challenge"));
    const back = new URL(params.get("redirect_uri"));
    back.searchParams.set("state", overrides.state || params.get("state"));
    if (overrides.error) back.searchParams.set("error", overrides.error);
    else back.searchParams.set("code", "the-code");
    setImmediate(() => fetch(back).catch(() => {}));
    return true;
  };
}

test.beforeEach(() => auth.clearStaffAuth());

test("login: PKCE code flow, tokens stored privately for this registry", async () => {
  const idp = await startServer();
  try {
    await auth.staffLogin(idp.base, { log() {}, opener: browser(idp) });
    const stored = auth.readStaffAuth();
    assert.equal(stored.registry, idp.base);
    assert.equal(stored.access_token, "access-1");
    assert.equal(stored.refresh_token, "refresh-1");
    assert.ok(stored.expires_at > Date.now());
    const grant = idp.tokenRequests[0];
    assert.equal(grant.grant_type, "authorization_code");
    assert.equal(grant.client_id, "sof-registry");
    assert.ok(grant.code_verifier.length >= 43, "PKCE verifier is long enough");
    if (process.platform !== "win32") {
      assert.equal(fs.statSync(auth.authFile()).mode & 0o777, 0o600);
    }
  } finally {
    idp.close();
  }
});

test("login refuses a response whose state does not match, and stores nothing", async () => {
  const idp = await startServer();
  try {
    await assert.rejects(auth.staffLogin(idp.base, { log() {}, opener: browser(idp, { state: "forged" }) }), /wrong state/);
    assert.equal(auth.readStaffAuth(), null);
    assert.equal(idp.tokenRequests.length, 0, "no code is ever exchanged after a bad state");
  } finally {
    idp.close();
  }
});

test("login reports a cancelled sign-in", async () => {
  const idp = await startServer();
  try {
    await assert.rejects(auth.staffLogin(idp.base, { log() {}, opener: browser(idp, { error: "access_denied" }) }), /access_denied/);
    assert.equal(auth.readStaffAuth(), null);
  } finally {
    idp.close();
  }
});

test("login refuses a sign-in server that names another issuer or another origin", async () => {
  for (const options of [{ wrongIssuer: true }, { foreignTokenEndpoint: true }]) {
    const idp = await startServer(options);
    try {
      await assert.rejects(auth.staffLogin(idp.base, { log() {}, opener: browser(idp) }), /refusing to continue/);
    } finally {
      idp.close();
    }
  }
});

test("login explains when the registry has no staff sign-in", async () => {
  const idp = await startServer({ noStaffLogin: true });
  try {
    await assert.rejects(auth.staffLogin(idp.base, { log() {} }), /no sov.gg sign-in/);
  } finally {
    idp.close();
  }
});

test("a fresh token is used as is; the token is never offered to a different registry", async () => {
  const idp = await startServer();
  try {
    await auth.staffLogin(idp.base, { log() {}, opener: browser(idp) });
    const before = idp.seen.length;
    assert.equal(await auth.getStaffAccessToken(idp.base), "access-1");
    assert.equal(idp.seen.length, before, "no network call for a still-valid token");
    assert.equal(await auth.getStaffAccessToken("https://some-other-registry.example/x"), "");
  } finally {
    idp.close();
  }
});

test("an expiring token is refreshed, and a rotated refresh token is kept", async () => {
  const idp = await startServer();
  try {
    await auth.staffLogin(idp.base, { log() {}, opener: browser(idp) });
    const stored = auth.readStaffAuth();
    fs.writeFileSync(auth.authFile(), JSON.stringify({ ...stored, expires_at: Date.now() + 5000 }));
    assert.equal(await auth.getStaffAccessToken(idp.base), "access-2");
    assert.equal(auth.readStaffAuth().refresh_token, "refresh-2");
    const refresh = idp.tokenRequests.find((r) => r.grant_type === "refresh_token");
    assert.equal(refresh.refresh_token, "refresh-1");
    assert.equal(refresh.client_id, "sof-registry");
  } finally {
    idp.close();
  }
});

test("a lapsed sign-in degrades to anonymous reads and says so exactly once", async () => {
  const idp = await startServer();
  const originalError = console.error;
  const messages = [];
  console.error = (m) => messages.push(String(m));
  try {
    await auth.staffLogin(idp.base, { log() {}, opener: browser(idp) });
    const stored = auth.readStaffAuth();
    idp.refreshTokens.clear();
    fs.writeFileSync(auth.authFile(), JSON.stringify({ ...stored, expires_at: Date.now() - 1000 }));
    assert.equal(await auth.getStaffAccessToken(idp.base), "");
    assert.equal(await auth.getStaffAccessToken(idp.base), "");
    assert.equal(messages.filter((m) => /account login/.test(m)).length, 1);
    // The registry rejecting a token is reported through the same one-shot channel.
    auth.noteRegistryResponse({ headers: new Headers({ "www-authenticate": 'Bearer error="invalid_token"' }) });
    assert.equal(messages.length, 1, "already warned; no second message");
  } finally {
    console.error = originalError;
    idp.close();
  }
});

test("logout forgets the sign-in", async () => {
  const idp = await startServer();
  try {
    await auth.staffLogin(idp.base, { log() {}, opener: browser(idp) });
    auth.clearStaffAuth();
    assert.equal(auth.readStaffAuth(), null);
    assert.equal(await auth.getStaffAccessToken(idp.base), "");
  } finally {
    idp.close();
  }
});

test("the SOF provider sends the staff token to its own registry only, and not when signed out", async () => {
  const { SofProvider } = require("../src/packages/providers/sof");
  const idp = await startServer();
  try {
    const provider = new SofProvider({ registryUrl: idp.base });
    await provider.queryPackage("sovvie/whatever");
    assert.equal(idp.seen.at(-1).headers.authorization, undefined, "anonymous when signed out");
    await auth.staffLogin(idp.base, { log() {}, opener: browser(idp) });
    await provider.queryPackage("sovvie/whatever");
    assert.equal(idp.seen.at(-1).headers.authorization, "Bearer access-1");
  } finally {
    idp.close();
  }
});

test("login says so when the registry configuration cannot be read", async () => {
  const idp = await startServer({ configStatus: 503 });
  try {
    await assert.rejects(auth.staffLogin(idp.base, { log() {} }), /registry configuration .* \(503\)/);
  } finally {
    idp.close();
  }
});

test("whoami wording: staff are called staff, a group member is not", () => {
  const { describeAccount } = require("../src/commands/account");
  assert.equal(describeAccount({ username: "alice", email: "alice@sov.gg", staff: true }), "Signed in as staff: alice <alice@sov.gg> (private add-ons available)");
  const member = describeAccount({ username: "bob", staff: false, groups: ["contractors", "qa"] });
  assert.doesNotMatch(member, /as staff/);
  assert.match(member, /not staff/);
  assert.match(member, /contractors, qa/);
  assert.match(describeAccount({ username: "bob", staff: false }), /none listed/);
});

test("an old staff-auth.json is moved to account.json once", () => {
  const legacy = { registry: "https://r.example", access_token: "a", refresh_token: "r", expires_at: 1 };
  const legacyPath = path.join(process.env.SOF_HOME, "staff-auth.json");
  fs.writeFileSync(legacyPath, JSON.stringify(legacy));
  assert.equal(store.readAccount().access_token, "a");
  assert.equal(fs.existsSync(legacyPath), false);
  assert.equal(fs.existsSync(store.accountFile()), true);
});
