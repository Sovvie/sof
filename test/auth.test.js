"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const home = fs.mkdtempSync(path.join(os.tmpdir(), "sof-auth-test-"));
process.env.SOF_HOME = home;

const {
  authFilePath,
  clearAuth,
  deviceLogin,
  findToken,
  requireToken,
  saveAuth,
} = require("../src/packages/auth");
const { startServer, sendJson } = require("./helpers");

function reset() {
  delete process.env.SOF_REGISTRY_TOKEN;
  delete process.env.SOF_TOKEN;
  delete process.env.GITHUB_TOKEN;
  clearAuth();
}

test("auth.json lives under SOF_HOME and is kept private", () => {
  reset();
  const file = saveAuth({ token: "secret-token", login: "sovvie" });

  assert.equal(file, path.join(home, "auth.json"));
  assert.equal(authFilePath(), file);
  assert.deepEqual(JSON.parse(fs.readFileSync(file, "utf8")), { token: "secret-token", login: "sovvie" });
  if (process.platform !== "win32") {
    assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  }
});

test("a saved sign-in is found, and logout removes it", () => {
  reset();
  assert.equal(findToken(), null);

  saveAuth({ token: "saved", login: "sovvie" });
  assert.deepEqual(
    { token: findToken().token, login: findToken().login },
    { token: "saved", login: "sovvie" }
  );

  assert.equal(clearAuth(), true);
  assert.equal(clearAuth(), false);
  assert.equal(findToken(), null);
});

test("SOF_REGISTRY_TOKEN wins over the saved file", () => {
  reset();
  saveAuth({ token: "saved", login: "sovvie" });
  process.env.SOF_REGISTRY_TOKEN = "  from-ci  ";

  assert.equal(findToken().token, "from-ci");
  assert.equal(findToken().source, "SOF_REGISTRY_TOKEN");
  reset();
});

test("SOF_TOKEN and GITHUB_TOKEN are never used", () => {
  reset();
  process.env.SOF_TOKEN = "nope";
  process.env.GITHUB_TOKEN = "nope";

  assert.equal(findToken(), null);
  assert.throws(() => requireToken(), /Not signed in\. Run "sof run package login" first\./);
  reset();
});

test("a corrupt auth.json counts as signed out", () => {
  reset();
  fs.writeFileSync(authFilePath(), "{not json");
  assert.equal(findToken(), null);
  reset();
});

// A fake registry (config.json) plus a fake GitHub (device flow endpoints).
async function deviceFixture({ config, polls }) {
  const github = await startServer(async (request, response, record) => {
    if (request.url === "/login/device/code") {
      return sendJson(response, 200, {
        device_code: "dev-code",
        user_code: "ABCD-1234",
        verification_uri: "https://github.com/login/device",
        interval: 1,
        expires_in: 900,
      });
    }
    if (request.url === "/login/oauth/access_token") {
      return sendJson(response, 200, polls.shift());
    }
    response.writeHead(404);
    response.end();
  });
  const registry = await startServer((request, response) => {
    if (request.url === "/config.json") {
      return sendJson(response, 200, config);
    }
    response.writeHead(404);
    response.end();
  });
  return { github, registry };
}

test("device login waits through pending and slow_down, then returns the token", async () => {
  const { github, registry } = await deviceFixture({
    config: { api: 1, github_oauth_id: "client-xyz", publishing: true },
    polls: [
      { error: "authorization_pending" },
      { error: "slow_down" },
      { access_token: "gho_token", token_type: "bearer" },
    ],
  });

  try {
    const sleeps = [];
    const shown = [];
    const token = await deviceLogin({
      registryUrl: registry.url,
      githubUrl: github.url,
      sleep: async (milliseconds) => sleeps.push(milliseconds),
      onCode: (info) => shown.push(info),
    });

    assert.equal(token, "gho_token");
    assert.deepEqual(shown, [{ url: "https://github.com/login/device", code: "ABCD-1234" }]);
    // interval 1s; slow_down adds 5s from then on.
    assert.deepEqual(sleeps, [1000, 1000, 6000]);

    const [codeRequest, firstPoll] = github.requests;
    assert.equal(codeRequest.headers.accept, "application/json");
    assert.equal(codeRequest.body.toString(), "client_id=client-xyz");
    assert.equal(
      firstPoll.body.toString(),
      "client_id=client-xyz&device_code=dev-code&grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Adevice_code"
    );
  } finally {
    await github.close();
    await registry.close();
  }
});

test("device login fails clearly when the code is denied or expires", async () => {
  for (const [error, pattern] of [
    ["access_denied", /cancelled on GitHub/],
    ["expired_token", /expired/],
    ["something_else", /GitHub sign-in failed: something_else/],
  ]) {
    const { github, registry } = await deviceFixture({
      config: { api: 1, github_oauth_id: "client-xyz", publishing: true },
      polls: [{ error }],
    });
    try {
      await assert.rejects(
        deviceLogin({ registryUrl: registry.url, githubUrl: github.url, sleep: async () => {} }),
        pattern
      );
    } finally {
      await github.close();
      await registry.close();
    }
  }
});

test("device login gives up once the code's lifetime has passed", async () => {
  const { github, registry } = await deviceFixture({
    config: { api: 1, github_oauth_id: "client-xyz", publishing: true },
    polls: [{ error: "authorization_pending" }],
  });
  try {
    let clock = 0;
    await assert.rejects(
      deviceLogin({
        registryUrl: registry.url,
        githubUrl: github.url,
        now: () => clock,
        sleep: async (milliseconds) => {
          clock += 1000 * 1000 + milliseconds;
        },
      }),
      /expired/
    );
  } finally {
    await github.close();
    await registry.close();
  }
});

test("device login says so when publishing is switched off on the registry", async () => {
  const { github, registry } = await deviceFixture({
    config: { api: 1, github_oauth_id: null, publishing: false },
    polls: [],
  });
  try {
    await assert.rejects(
      deviceLogin({ registryUrl: registry.url, githubUrl: github.url, sleep: async () => {} }),
      /Publishing is switched off/
    );
    assert.equal(github.requests.length, 0);
  } finally {
    await github.close();
    await registry.close();
  }
});
