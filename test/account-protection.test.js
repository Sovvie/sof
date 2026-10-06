"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const http = require("http");
const os = require("os");
const path = require("path");
const { once } = require("events");

delete process.env.SOF_ACCOUNT_PROTECTION;
process.env.SOF_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "sofprotect-"));

const secretStore = require("../src/account/secret-store");
const store = require("../src/account/store");

const SECRET = "refresh.Token_123-abc";

// A stand-in for the OS tools: records what it was asked and answers from a script.
function fakeRun(answer = { status: 0, stdout: "" }) {
  const calls = [];
  const run = (command, args, input) => {
    calls.push({ command, args, input });
    return typeof answer === "function" ? answer(command, args, input) : answer;
  };
  return { run, calls };
}

test("the secret goes to the OS tool on stdin, never on the command line", () => {
  for (const platform of ["win32", "darwin", "linux"]) {
    const { run, calls } = fakeRun({ status: 0, stdout: "QkxPQg==" });
    const protection = secretStore.protect(SECRET, { account: "https://sov.gg/sof-index", platform, run });
    assert.ok(protection, platform);
    assert.ok(calls.length > 0);
    for (const call of calls) {
      assert.ok(!call.args.join(" ").includes(SECRET), `${platform}: the secret is not an argument`);
    }
    assert.ok(calls.some((call) => String(call.input).includes(SECRET)), `${platform}: it is sent on stdin`);
  }
});

test("Windows: DPAPI blob is what is kept, and it round-trips through the same tool", () => {
  const { run } = fakeRun({ status: 0, stdout: "QkxPQg==\r\n" });
  const protection = secretStore.protect(SECRET, { account: "r", platform: "win32", run });
  assert.deepEqual(protection, { backend: "dpapi", data: "QkxPQg==" });
  const back = fakeRun({ status: 0, stdout: SECRET });
  assert.equal(secretStore.unprotect(protection, { platform: "win32", run: back.run }), SECRET);
  assert.equal(back.calls[0].input, "QkxPQg==");
});

test("Keychain and libsecret keep only a name in the file", () => {
  const mac = secretStore.protect(SECRET, { account: "sov.gg-registry", platform: "darwin", run: fakeRun().run });
  assert.deepEqual(mac, { backend: "keychain", account: "sov.gg-registry" });
  const linux = secretStore.protect(SECRET, { account: "sov.gg-registry", platform: "linux", run: fakeRun().run });
  assert.deepEqual(linux, { backend: "libsecret", account: "sov.gg-registry" });
});

test("a secret that is not plain token characters is never built into a Keychain command", () => {
  const { run, calls } = fakeRun();
  assert.equal(secretStore.protect('abc" ; do-something', { account: "r", platform: "darwin", run }), null);
  assert.equal(secretStore.protect(SECRET, { account: 'r" -x "', platform: "darwin", run }), null);
  assert.equal(calls.length, 0);
});

test("a failing or missing store means no protection, not a crash", () => {
  assert.equal(secretStore.protect(SECRET, { account: "r", platform: "win32", run: fakeRun({ status: 1, stdout: "" }).run }), null);
  assert.equal(secretStore.protect(SECRET, { account: "r", platform: "linux", run: () => ({ status: null, stdout: "", error: new Error("ENOENT") }) }), null);
  assert.equal(secretStore.protect(SECRET, { account: "r", platform: "linux", run: () => { throw new Error("boom"); } }), null);
  assert.equal(secretStore.protect(SECRET, { account: "r", platform: "freebsd", run: fakeRun().run }), null);
  assert.equal(secretStore.unprotect({ backend: "dpapi", data: "x" }, { platform: "linux", run: fakeRun({ status: 0, stdout: "x" }).run }), null);
  assert.equal(secretStore.unprotect({ backend: "dpapi", data: "x" }, { platform: "win32", run: fakeRun({ status: 1, stdout: "" }).run }), null);
});

test("SOF_ACCOUNT_PROTECTION=off disables it", () => {
  process.env.SOF_ACCOUNT_PROTECTION = "off";
  try {
    assert.equal(secretStore.enabled(), false);
    assert.equal(secretStore.protect(SECRET, { account: "r", platform: "win32", run: fakeRun().run }), null);
  } finally {
    delete process.env.SOF_ACCOUNT_PROTECTION;
  }
});

test("logout asks Keychain and libsecret to forget the entry", () => {
  const mac = fakeRun();
  secretStore.forget({ backend: "keychain", account: "a" }, { platform: "darwin", run: mac.run });
  assert.deepEqual(mac.calls[0].args.slice(0, 1), ["delete-generic-password"]);
  const linux = fakeRun();
  secretStore.forget({ backend: "libsecret", account: "a" }, { platform: "linux", run: linux.run });
  assert.equal(linux.calls[0].command, "secret-tool");
});

// ---- Real Windows DPAPI, end to end through account.json.
const realDpapi = { skip: process.platform !== "win32" && "real DPAPI is only on Windows" };

async function startIdp() {
  const seen = [];
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      seen.push(Object.fromEntries(new URLSearchParams(body)));
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ access_token: "access-2", refresh_token: "refresh-rotated", expires_in: 600 }));
    });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  return { server, seen, url: `http://127.0.0.1:${server.address().port}/token` };
}

function account(overrides = {}) {
  return {
    registry: require("../src/packages/constants").SOF_REGISTRY_URL,
    issuer: "https://auth.example/",
    client_id: "sof-registry",
    token_endpoint: "https://auth.example/token",
    access_token: "access-1",
    refresh_token: "refresh-1",
    expires_at: Date.now() + 10 * 60 * 1000,
    ...overrides,
  };
}

test("real DPAPI: account.json holds no readable refresh token", realDpapi, () => {
  store.clearAccount();
  store.writeAccount(account());
  const raw = fs.readFileSync(store.accountFile(), "utf8");
  assert.ok(!raw.includes("refresh-1"), "the refresh token is not in the file");
  const stored = JSON.parse(raw);
  assert.equal(stored.refresh_token, "");
  assert.equal(stored.refresh_protection.backend, "dpapi");
  assert.equal(secretStore.unprotect(stored.refresh_protection), "refresh-1");
});

test("real DPAPI: a refresh unlocks the token, uses it, and stores the rotated one protected", realDpapi, async () => {
  const idp = await startIdp();
  try {
    store.clearAccount();
    store.writeAccount(account({ token_endpoint: idp.url, expires_at: Date.now() + 1000 }));
    assert.equal(await store.getAccessToken(), "access-2");
    assert.equal(idp.seen[0].grant_type, "refresh_token");
    assert.equal(idp.seen[0].refresh_token, "refresh-1", "the protected token was decrypted for the refresh");
    const raw = fs.readFileSync(store.accountFile(), "utf8");
    assert.ok(!raw.includes("refresh-rotated") && !raw.includes("refresh-1"));
    assert.equal(secretStore.unprotect(JSON.parse(raw).refresh_protection), "refresh-rotated");
  } finally {
    idp.server.close();
  }
});

test("real DPAPI: an account.json from before protection is upgraded in place", realDpapi, () => {
  store.clearAccount();
  fs.writeFileSync(store.accountFile(), JSON.stringify(account({ refresh_token: "refresh-plain" })));
  const read = store.readAccount();
  assert.equal(read.refresh_token, "");
  assert.ok(read.refresh_protection);
  assert.ok(!fs.readFileSync(store.accountFile(), "utf8").includes("refresh-plain"));
});

test("a protected sign-in that cannot be unlocked asks to sign in again instead of sending nothing useful", async () => {
  store.clearAccount();
  fs.writeFileSync(
    store.accountFile(),
    JSON.stringify(account({ refresh_token: "", refresh_protection: { backend: "dpapi", data: "bm90LWEtcmVhbC1ibG9i" }, expires_at: 1 }))
  );
  const original = console.error;
  const messages = [];
  console.error = (m) => messages.push(String(m));
  try {
    assert.equal(await store.getAccessToken(), "");
  } finally {
    console.error = original;
  }
  assert.ok(messages.some((m) => /account login/.test(m)));
});
