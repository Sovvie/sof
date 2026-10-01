"use strict";

// The package publish / account commands, end to end against a fake registry.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const { sendJson, startServer } = require("./helpers");

const home = fs.mkdtempSync(path.join(os.tmpdir(), "sof-commands-home-"));
process.env.SOF_HOME = home;
delete process.env.SOF_REGISTRY_TOKEN;

let server;
let runPackage;
let publishReply = { status: 200, body: { state: "published" } };

test.before(async () => {
  server = await startServer((request, response) => {
    if (request.url === "/v1/publish") {
      return sendJson(response, publishReply.status, publishReply.body);
    }
    if (request.url === "/v1/whoami") {
      return sendJson(response, 200, {
        login: "Sovvie",
        id: 7,
        trusted: true,
        scopes: ["sovvie"],
        canClaim: null,
      });
    }
    if (request.url.startsWith("/v1/scopes/")) {
      return sendJson(response, 200, {
        scope: "sovvie",
        owners: [
          { login: "Sovvie", id: 7 },
          { login: "friend", id: 8 },
        ],
      });
    }
    if (request.url.startsWith("/v1/packages/")) {
      const [, , , scope, name, version, action] = request.url.split("/");
      return sendJson(response, 200, {
        package: `${scope}/${name}`,
        version,
        state: action === "yank" ? "yanked" : "active",
      });
    }
    sendJson(response, 404, { error: "no such route" });
  });

  // The registry URL is read once, when constants.js loads, so set it before requiring anything.
  process.env.SOF_REGISTRY_URL = server.url;
  ({ runPackage } = require("../src/commands/package"));
});

test.after(async () => {
  await server.close();
});

test.beforeEach(() => {
  server.requests.length = 0;
  publishReply = { status: 200, body: { state: "published" } };
  delete process.env.SOF_REGISTRY_TOKEN;
  fs.rmSync(path.join(home, "auth.json"), { force: true });
});

async function capture(run) {
  const lines = [];
  const original = console.log;
  console.log = (...parts) => lines.push(parts.join(" "));
  try {
    await run();
  } finally {
    console.log = original;
  }
  return lines.join("\n");
}

function makeProject(files = { "src/Demo/init.luau": "return 1" }) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "sof-commands-project-"));
  for (const [name, contents] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, name)), { recursive: true });
    fs.writeFileSync(path.join(root, name), contents);
  }
  const config = path.join(root, "sof.toml");
  fs.writeFileSync(
    config,
    ['[[package]]', 'name = "sovvie/demo"', 'version = "1.0.0"', 'description = "Demo"', 'include = "src/Demo"', ""].join("\n")
  );
  return config;
}

function publishRequests() {
  return server.requests.filter((request) => request.url === "/v1/publish");
}

test("publish prints a success line and uploads once", async () => {
  process.env.SOF_REGISTRY_TOKEN = "tok";
  const output = await capture(() => runPackage(["publish", makeProject()]));

  assert.match(output, /✓ sovvie\/demo@1\.0\.0/);
  assert.match(output, new RegExp(`index: ${server.url}/index/sovvie/demo\\.json`));
  assert.equal(publishRequests().length, 1);
});

test("publish reports a quarantined upload as held for review, not as success", async () => {
  process.env.SOF_REGISTRY_TOKEN = "tok";
  publishReply = {
    status: 202,
    body: {
      state: "quarantined",
      findings: [{ rule: "remote-asset", file: "Demo/init.luau", line: 3, why: "requires a remote asset id" }],
    },
  };

  const output = await capture(() => runPackage(["publish", makeProject()]));

  assert.match(output, /HELD FOR REVIEW/);
  assert.match(output, /remote-asset Demo\/init\.luau:3: requires a remote asset id/);
  assert.match(output, /goes live once a registry admin approves it/);
  assert.doesNotMatch(output, /✓/);
});

test("publish without a sign-in stops before packing or uploading anything", async () => {
  await assert.rejects(
    capture(() => runPackage(["publish", makeProject()])),
    /Not signed in\. Run "sof run package login" first\./
  );
  assert.equal(server.requests.length, 0);
});

test("publish checks the package against the registry's rules before uploading", async () => {
  process.env.SOF_REGISTRY_TOKEN = "tok";
  const config = makeProject({ "src/Demo/init.luau": "return 1", "src/Demo/model.rbxm": "binary" });

  await assert.rejects(
    capture(() => runPackage(["publish", config])),
    /would be rejected by the registry:[\s\S]*model\.rbxm" is not an allowed file type/
  );
  assert.equal(publishRequests().length, 0);
});

test("publish shows the registry's reason when the version already exists", async () => {
  process.env.SOF_REGISTRY_TOKEN = "tok";
  publishReply = { status: 409, body: { error: "sovvie/demo@1.0.0 already exists" } };

  await assert.rejects(
    capture(() => runPackage(["publish", makeProject()])), /\(409\): sovvie\/demo@1\.0\.0 already exists/);
});

test("whoami shows the account, and where the token came from", async () => {
  process.env.SOF_REGISTRY_TOKEN = "tok-whoami";
  const output = await capture(() => runPackage(["whoami"]));

  assert.match(output, /Signed in as Sovvie/);
  assert.match(output, /Scopes you own: sovvie/);
  assert.match(output, /Token from: SOF_REGISTRY_TOKEN/);
  assert.equal(server.requests[0].headers.authorization, "Bearer tok-whoami");
  assert.doesNotMatch(output, /tok-whoami/);
});

test("whoami without a sign-in says how to log in", async () => {
  await assert.rejects(runPackage(["whoami"]), /Not signed in\. Run "sof run package login" first\./);
});

test("logout deletes the saved sign-in", async () => {
  fs.writeFileSync(path.join(home, "auth.json"), JSON.stringify({ token: "saved", login: "sovvie" }));

  const output = await capture(() => runPackage(["logout"]));

  assert.match(output, /Signed out/);
  assert.equal(fs.existsSync(path.join(home, "auth.json")), false);
});

test("owner add and remove call the scope endpoint and list the owners", async () => {
  process.env.SOF_REGISTRY_TOKEN = "tok";

  const added = await capture(() => runPackage(["owner", "add", "Sovvie", "@friend"]));
  const removed = await capture(() => runPackage(["owner", "remove", "sovvie", "friend"]));

  assert.deepEqual(
    server.requests.map((request) => [request.method, request.url]),
    [
      ["PUT", "/v1/scopes/sovvie/owners/friend"],
      ["DELETE", "/v1/scopes/sovvie/owners/friend"],
    ]
  );
  assert.equal(server.requests[0].headers.authorization, "Bearer tok");
  assert.match(added, /Owners of sovvie: Sovvie, friend/);
  assert.match(removed, /Owners of sovvie/);

  await assert.rejects(runPackage(["owner", "add", "sovvie"]), /Usage: sof run package owner/);
});

test("yank and unyank post to the version's endpoint", async () => {
  process.env.SOF_REGISTRY_TOKEN = "tok";

  const yanked = await capture(() => runPackage(["yank", "sovvie/router", "1.0.0"]));
  const restored = await capture(() => runPackage(["unyank", "sovvie/router", "1.0.0"]));

  assert.deepEqual(
    server.requests.map((request) => [request.method, request.url]),
    [
      ["POST", "/v1/packages/sovvie/router/1.0.0/yank"],
      ["POST", "/v1/packages/sovvie/router/1.0.0/unyank"],
    ]
  );
  assert.match(yanked, /sovvie\/router@1\.0\.0: yanked/);
  assert.match(restored, /sovvie\/router@1\.0\.0: active/);

  await assert.rejects(runPackage(["yank", "router"]), /Usage: sof run package yank/);
});

test("a rejected token is reported with a hint, and never printed", async () => {
  process.env.SOF_REGISTRY_TOKEN = "tok-secret";
  const rejecting = await startServer((_request, response) => sendJson(response, 401, { error: "bad token" }));
  // Same command, different registry: go through the provider/account code with a throwaway URL.
  const { fetchWhoami } = require("../src/commands/registry-account");

  try {
    await assert.rejects(
      fetchWhoami({ token: "tok-secret", source: "SOF_REGISTRY_TOKEN" }, rejecting.url),
      (error) => {
        assert.match(error.message, /\(401\): bad token/);
        assert.match(error.message, /rejected SOF_REGISTRY_TOKEN/);
        assert.doesNotMatch(error.message, /tok-secret/);
        return true;
      }
    );
  } finally {
    await rejecting.close();
  }
});
