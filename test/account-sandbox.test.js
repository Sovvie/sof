"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const sofHome = fs.mkdtempSync(path.join(os.tmpdir(), "sofhome-"));
process.env.SOF_ACCOUNT_PROTECTION = "off"; // these tests read the stored tokens directly
process.env.SOF_HOME = sofHome;
process.env.SECRET_FROM_ENV = "env-secret-value";

const store = require("../src/account/store");
const grants = require("../src/account/grants");
const { createBroker } = require("../src/account/broker");
const { runSandboxed, supportsPermissionFlag } = require("../src/addons/run-sandboxed");
const { SOF_REGISTRY_URL } = require("../src/packages/constants");

const TOKEN = "SECRET-TOKEN";
const BRIDGE = "roblox-sync.sov.gg";

function signIn() {
  store.writeAccount({
    registry: SOF_REGISTRY_URL,
    issuer: "https://auth.example/",
    client_id: "sof-registry",
    token_endpoint: "https://auth.example/token",
    access_token: TOKEN,
    refresh_token: "r",
    expires_at: Date.now() + 10 * 60 * 1000,
  });
}

// A stand-in for fetch that records what the broker sent.
function fakeFetch(seen, reply = {}) {
  return async (url, options) => {
    seen.push({ url: String(url), options });
    const headers = new Headers({ "content-type": "application/json", "set-cookie": "a=b", "x-secret": TOKEN, ...reply.headers });
    return new Response(reply.body ?? '{"ok":true}', { status: reply.status ?? 200, headers });
  };
}

test.beforeEach(() => {
  store.clearAccount();
  fs.rmSync(grants.grantsFile(), { force: true });
});

test("broker: adds the login itself, strips the add-on's credentials, returns only safe headers", async () => {
  signIn();
  const seen = [];
  const broker = createBroker({ addon: "demo", hosts: [BRIDGE], fetchImpl: fakeFetch(seen) });
  const result = await broker.request({
    url: `https://${BRIDGE}/database/ws:blk`,
    headers: { Authorization: "Bearer stolen", Cookie: "x=y", Accept: "application/json" },
  });
  assert.equal(seen[0].options.headers.Authorization, `Bearer ${TOKEN}`);
  assert.equal(seen[0].options.headers.Accept, "application/json");
  assert.equal(seen[0].options.headers.Cookie, undefined);
  assert.equal(seen[0].options.redirect, "manual");
  assert.equal(result.status, 200);
  assert.equal(result.body, '{"ok":true}');
  assert.deepEqual(Object.keys(result.headers), ["content-type"]);
  assert.ok(!JSON.stringify(result).includes(TOKEN), "the token is never in a result");
});

test("broker: refuses other hosts, plain http, credentials in the address, odd methods", async () => {
  signIn();
  const seen = [];
  const broker = createBroker({ addon: "demo", hosts: [BRIDGE, "evil.example"], fetchImpl: fakeFetch(seen) });
  const denied = async (options, code) => assert.rejects(broker.request(options), (err) => err.code === code);
  await denied({ url: "https://evil.example/steal" }, "host_denied"); // granted, but outside core's list
  await denied({ url: "https://sov.gg.evil.example/x" }, "host_denied");
  await denied({ url: "https://github.com/x" }, "host_denied");
  await denied({ url: `http://${BRIDGE}/x` }, "bad_request");
  await denied({ url: `https://user:pw@${BRIDGE}/x` }, "bad_request");
  await denied({ url: `https://${BRIDGE}/x`, method: "TRACE" }, "bad_request");
  await denied({ url: `https://${BRIDGE}/x`, method: "POST", body: { a: 1 } }, "bad_request");
  await denied({ url: "not a url" }, "bad_request");
  assert.equal(seen.length, 0, "nothing was sent");
});

test("broker: a host that was not granted to this add-on is refused", async () => {
  signIn();
  const broker = createBroker({ addon: "demo", hosts: [], fetchImpl: fakeFetch([]) });
  await assert.rejects(broker.request({ url: `https://${BRIDGE}/x` }), (err) => err.code === "host_denied");
});

test("broker: not signed in says so; whoami never returns the token", async () => {
  const broker = createBroker({ addon: "demo", hosts: [BRIDGE], fetchImpl: fakeFetch([]) });
  await assert.rejects(broker.request({ url: `https://${BRIDGE}/x` }), (err) => err.code === "not_signed_in");
  signIn();
  const who = await createBroker({
    addon: "demo",
    hosts: [],
    fetchImpl: fakeFetch([], { body: JSON.stringify({ username: "alice", email: "a@sov.gg", staff: true, groups: ["staff"], access_token: TOKEN }) }),
  }).whoami();
  assert.deepEqual(who, { username: "alice", email: "a@sov.gg", staff: true, groups: ["staff"] });
});

test("grants: asked once on a terminal, never silently, refused for hosts core does not allow", async () => {
  const descriptor = { name: "demo", account: { hosts: [BRIDGE] } };
  await assert.rejects(grants.ensureGranted(descriptor, { interactive: false }), /sof run account grant demo/);
  await assert.rejects(grants.ensureGranted(descriptor, { interactive: true, prompt: async () => false }), /was not given access/);
  assert.deepEqual(await grants.ensureGranted(descriptor, { interactive: true, prompt: async () => true }), [BRIDGE]);
  // Already granted: no question, even without a terminal.
  assert.deepEqual(await grants.ensureGranted(descriptor, { interactive: false }), [BRIDGE]);
  // A new version that asks for more hosts is asked again.
  const wider = { name: "demo", account: { hosts: [BRIDGE, "sov.gg"] } };
  await assert.rejects(grants.ensureGranted(wider, { interactive: false }), /needs permission/);
  await assert.rejects(grants.ensureGranted({ name: "x", account: { hosts: ["evil.example"] } }), /does not allow/);
  assert.equal(grants.revoke("demo"), true);
  assert.equal(grants.revoke("demo"), false);
});

test("supportsPermissionFlag follows Node's release lines", () => {
  assert.equal(supportsPermissionFlag("20.19.0"), false);
  assert.equal(supportsPermissionFlag("22.12.0"), false);
  assert.equal(supportsPermissionFlag("22.13.0"), true);
  assert.equal(supportsPermissionFlag("23.4.0"), false);
  assert.equal(supportsPermissionFlag("23.5.0"), true);
  assert.equal(supportsPermissionFlag("24.0.0"), true);
});

// An add-on that tries everything a hostile one would, and writes what happened to result.json.
function makeAddon() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "sofaddon-"));
  fs.writeFileSync(
    path.join(directory, "sof-addon.json"),
    JSON.stringify({
      name: "probe",
      version: "1.0.0",
      command: "probe",
      entry: "index.js",
      export: "run",
      sandbox: true,
      account: { hosts: [BRIDGE] },
    })
  );
  fs.writeFileSync(
    path.join(directory, "index.js"),
    `"use strict";
const fs = require("fs");
exports.run = async (argv, host) => {
  const out = {};
  const attempt = async (name, fn) => {
    try { out[name] = { ok: true, value: await fn() }; }
    catch (err) { out[name] = { ok: false, code: err.code || "", message: err.message }; }
  };
  await attempt("readLogin", () => fs.readFileSync(argv[0], "utf8"));
  await attempt("listHome", () => fs.readdirSync(require("path").dirname(argv[0])));
  await attempt("spawn", () => require("child_process").execSync("echo hi").toString());
  await attempt("writeOutside", () => fs.writeFileSync(argv[1], "x"));
  await attempt("env", () => process.env.SECRET_FROM_ENV || "");
  await attempt("sandboxFlag", () => process.env.SOF_ADDON_SANDBOX);
  await attempt("granted", async () => (await host.account.request({ url: "https://${BRIDGE}/database/ws:blk", headers: { Authorization: "Bearer mine" } })).body);
  await attempt("evil", () => host.account.request({ url: "https://evil.example/x" }));
  await attempt("whoami", () => host.account.whoami());
  fs.writeFileSync("result.json", JSON.stringify(out));
};
`
  );
  return directory;
}

test("a sandboxed add-on cannot read the login, run programs or see secrets, but can use the account", async (t) => {
  signIn();
  const directory = makeAddon();
  const project = fs.mkdtempSync(path.join(os.tmpdir(), "sofproject-"));
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), "sofoutside-"));
  t.after(() => {
    for (const dir of [directory, project, outside]) fs.rmSync(dir, { recursive: true, force: true });
  });
  grants.grant("probe", [BRIDGE]);

  const seen = [];
  const fetchImpl = async (url, options) => {
    seen.push({ url: String(url), headers: options.headers });
    const body = String(url).endsWith("/v1/staff/whoami")
      ? JSON.stringify({ username: "alice", email: "a@sov.gg", staff: true, groups: ["staff"] })
      : '{"rows":1}';
    return new Response(body, { status: 200, headers: { "content-type": "application/json" } });
  };

  const exitBefore = process.exitCode;
  process.exitCode = undefined;
  try {
    await runSandboxed({ name: "probe", directory }, [store.accountFile(), path.join(outside, "x.txt")], { cwd: project, fetchImpl });
    assert.equal(process.exitCode ?? 0, 0);
  } finally {
    process.exitCode = exitBefore;
  }

  const raw = fs.readFileSync(path.join(project, "result.json"), "utf8");
  const out = JSON.parse(raw);
  assert.equal(out.readLogin.ok, false);
  assert.equal(out.readLogin.code, "ERR_ACCESS_DENIED");
  assert.equal(out.listHome.ok, false);
  assert.equal(out.spawn.ok, false);
  assert.equal(out.writeOutside.ok, false);
  assert.equal(out.env.value, "", "the environment's secrets are not passed on");
  assert.equal(out.sandboxFlag.value, "1");
  assert.equal(out.granted.value, '{"rows":1}');
  assert.equal(out.evil.ok, false);
  assert.equal(out.evil.code, "host_denied");
  assert.equal(out.whoami.value.username, "alice");
  assert.ok(!raw.includes(TOKEN), "the add-on never saw the token");
  assert.ok(!fs.existsSync(path.join(outside, "x.txt")));

  const bridgeCall = seen.find((c) => c.url.includes("/database/"));
  assert.equal(bridgeCall.headers.Authorization, `Bearer ${TOKEN}`, "core attached the real login, not the add-on's");
  assert.ok(!seen.some((c) => c.url.includes("evil.example")));
});

test("an add-on that was not granted the account still runs, but its account calls are refused", async (t) => {
  signIn();
  const directory = makeAddon();
  const project = fs.mkdtempSync(path.join(os.tmpdir(), "sofproject-"));
  t.after(() => {
    for (const dir of [directory, project]) fs.rmSync(dir, { recursive: true, force: true });
  });
  const seen = [];
  const exitBefore = process.exitCode;
  process.exitCode = undefined;
  try {
    await runSandboxed({ name: "probe", directory }, [store.accountFile(), path.join(project, "y.txt")], { cwd: project, fetchImpl: fakeFetch(seen) });
  } finally {
    process.exitCode = exitBefore;
  }
  const out = JSON.parse(fs.readFileSync(path.join(project, "result.json"), "utf8"));
  assert.equal(out.granted.ok, false);
  assert.match(out.granted.message, /sof run account grant probe/);
  assert.equal(out.whoami.ok, false);
  assert.equal(seen.length, 0, "nothing was sent to sov.gg");
});

test("a sandboxed add-on is not started from a folder that holds sof's own home", async (t) => {
  const directory = makeAddon();
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  grants.grant("probe", [BRIDGE]);
  await assert.rejects(runSandboxed({ name: "probe", directory }, [], { cwd: path.dirname(sofHome) }), /project folder/);
});
