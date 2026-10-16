"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const {
  Registry,
  resolveRegistryUrl,
  parseSofIndex,
  parseWallyIndex,
  DEFAULT_REGISTRY_URL,
} = require("../src/registry");

const BASE = "https://registry.test/sof-index";

function sofIndex(versions) {
  const out = { scope: "sovvie", name: "router", versions: {} };
  for (const v of versions) {
    const [version, extra] = Array.isArray(v) ? v : [v, {}];
    out.versions[version] = { realm: "shared", description: "d", dependencies: {}, ...extra };
  }
  return out;
}

function reply(status, body, headers = {}) {
  const text = typeof body === "string" ? body : JSON.stringify(body);
  return new Response(status === 304 ? null : text, { status, headers });
}

// A fetch that serves from a table of "METHOD url" -> handler and records every call.
function fakeFetch(routes) {
  const calls = [];
  const fn = async (url, init = {}) => {
    calls.push({ url, headers: init.headers || {} });
    const handler = routes[url];
    if (!handler) return reply(404, "not found");
    return typeof handler === "function" ? handler({ url, headers: init.headers || {}, count: calls.filter((c) => c.url === url).length }) : handler;
  };
  fn.calls = calls;
  return fn;
}

function makeRegistry(fetchFn, overrides = {}) {
  let now = 1_000_000;
  const settings = { registryUrl: BASE, wallyEnabled: true, cacheMs: 5 * 60 * 1000, ...overrides };
  const registry = new Registry({
    getSettings: () => settings,
    fetch: fetchFn,
    now: () => now,
  });
  return {
    registry,
    settings,
    advance: (ms) => {
      now += ms;
    },
  };
}

const ROUTER_URL = `${BASE}/index/sovvie/router.json`;
const WALLY_PROMISE_URL = "https://raw.githubusercontent.com/UpliftGames/wally-index/main/evaera/promise";

test("resolveRegistryUrl prefers the setting, then the environment, then the default", () => {
  assert.equal(resolveRegistryUrl("https://x.test/idx/", {}), "https://x.test/idx");
  assert.equal(resolveRegistryUrl("", { SOF_REGISTRY_URL: "https://env.test/" }), "https://env.test");
  assert.equal(resolveRegistryUrl("  ", {}), DEFAULT_REGISTRY_URL);
});

test("parseSofIndex reads versions, yank flags and metadata", () => {
  const data = parseSofIndex("sovvie/router", {
    versions: {
      "1.0.0": { published: "2026-01-01T00:00:00Z", authors: ["a"], dependencies: { Stream: "sovvie/stream@^1" } },
      "1.1.0": { yanked: true, license: "MIT" },
    },
  });
  assert.equal(data.source, "sof");
  assert.deepEqual(
    data.versions.map((v) => [v.version, v.yanked]),
    [
      ["1.0.0", false],
      ["1.1.0", true],
    ]
  );
  assert.deepEqual(data.versions[0].dependencies, { Stream: "sovvie/stream@^1" });
  assert.equal(data.versions[1].license, "MIT");
  assert.equal(parseSofIndex("a/b", { versions: {} }), null);
  assert.throws(() => parseSofIndex("a/b", { nope: 1 }), /versions/);
});

test("parseWallyIndex reads the line-per-version format", () => {
  const text = [
    '{"package":{"name":"evaera/promise","version":"3.1.0","description":"P","license":"MIT","realm":"shared","authors":[]},"dependencies":{"A":"x/a@1"},"server-dependencies":{"B":"x/b@1"}}',
    "",
    '{"package":{"name":"evaera/promise","version":"3.2.0"},"dependencies":{}}',
  ].join("\n");
  const data = parseWallyIndex("evaera/promise", text);
  assert.equal(data.source, "wally");
  assert.deepEqual(
    data.versions.map((v) => v.version),
    ["3.1.0", "3.2.0"]
  );
  assert.deepEqual(data.versions[0].dependencies, { A: "x/a@1", B: "x/b@1" });
  assert.throws(() => parseWallyIndex("a/b", "{not json"), /not valid/);
  assert.equal(parseWallyIndex("a/b", ""), null);
});

test("ensure fetches once and caches until the TTL runs out", async () => {
  const fetchFn = fakeFetch({ [ROUTER_URL]: () => reply(200, sofIndex(["1.0.0"]), { etag: '"v1"' }) });
  const { registry, advance } = makeRegistry(fetchFn);

  assert.equal(registry.getState("sovvie/router"), null);
  await registry.ensure(["sovvie/router", "sovvie/router"]);
  assert.equal(registry.getState("sovvie/router").status, "ok");
  assert.equal(fetchFn.calls.length, 1);

  await registry.ensure(["sovvie/router"]);
  assert.equal(fetchFn.calls.length, 1, "fresh: no request");

  advance(5 * 60 * 1000 + 1);
  await registry.ensure(["sovvie/router"]);
  assert.equal(fetchFn.calls.length, 2, "stale: one revalidation");
});

test("a stale entry is revalidated with If-None-Match and a 304 keeps the data", async () => {
  const fetchFn = fakeFetch({
    [ROUTER_URL]: ({ headers }) =>
      headers["If-None-Match"] === '"v1"' ? reply(304, null) : reply(200, sofIndex(["1.0.0"]), { etag: '"v1"' }),
  });
  const { registry, advance } = makeRegistry(fetchFn);

  await registry.ensure(["sovvie/router"]);
  advance(10 * 60 * 1000);
  await registry.ensure(["sovvie/router"]);

  assert.equal(fetchFn.calls[1].headers["If-None-Match"], '"v1"');
  assert.equal(registry.getState("sovvie/router").data.versions[0].version, "1.0.0");
});

test("stale data keeps showing while it refreshes, and survives a failed refresh", async () => {
  let fail = false;
  const fetchFn = fakeFetch({
    [ROUTER_URL]: () => (fail ? reply(500, "boom") : reply(200, sofIndex(["1.0.0"]))),
  });
  const { registry, advance } = makeRegistry(fetchFn);

  await registry.ensure(["sovvie/router"]);
  fail = true;
  advance(10 * 60 * 1000);
  const refreshing = registry.ensure(["sovvie/router"]);
  assert.equal(registry.getState("sovvie/router").status, "ok", "still shown mid-refresh");
  await refreshing;
  assert.equal(registry.getState("sovvie/router").status, "ok", "kept after a failed refresh");

  // ...and it looks again soon, not only after another full TTL.
  advance(31 * 1000);
  await registry.ensure(["sovvie/router"]);
  assert.equal(fetchFn.calls.length, 3);
});

test("a changed package replaces the data and notifies listeners", async () => {
  let version = "1.0.0";
  const fetchFn = fakeFetch({ [ROUTER_URL]: () => reply(200, sofIndex([version])) });
  const { registry, advance } = makeRegistry(fetchFn);
  let changes = 0;
  registry.onDidChange(() => changes++);

  await registry.ensure(["sovvie/router"]);
  const before = registry.revision;
  version = "2.0.0";
  advance(10 * 60 * 1000);
  await registry.ensure(["sovvie/router"]);

  assert.equal(registry.getState("sovvie/router").data.versions[0].version, "2.0.0");
  assert.ok(registry.revision > before);
  assert.ok(changes >= 2);
});

test("404 in the sof index falls back to Wally, as the CLI does", async () => {
  const wally = '{"package":{"name":"evaera/promise","version":"3.2.1"},"dependencies":{}}\n';
  const fetchFn = fakeFetch({ [WALLY_PROMISE_URL]: () => reply(200, wally, { etag: '"w"' }) });
  const { registry } = makeRegistry(fetchFn);

  await registry.ensure(["evaera/promise"]);
  const state = registry.getState("evaera/promise");
  assert.equal(state.status, "ok");
  assert.equal(state.data.source, "wally");
  assert.deepEqual(
    fetchFn.calls.map((c) => c.url),
    [`${BASE}/index/evaera/promise.json`, WALLY_PROMISE_URL]
  );
});

test("with Wally disabled an unknown package is simply not found", async () => {
  const fetchFn = fakeFetch({});
  const { registry } = makeRegistry(fetchFn, { wallyEnabled: false });
  await registry.ensure(["nobody/nothing"]);
  assert.equal(registry.getState("nobody/nothing").status, "notfound");
  assert.equal(fetchFn.calls.length, 1);
});

test("a name in neither index is notfound and is rechecked after a minute, not never", async () => {
  const fetchFn = fakeFetch({});
  const { registry, advance } = makeRegistry(fetchFn);
  await registry.ensure(["nobody/nothing"]);
  assert.equal(registry.getState("nobody/nothing").status, "notfound");
  const requests = fetchFn.calls.length;

  await registry.ensure(["nobody/nothing"]);
  assert.equal(fetchFn.calls.length, requests);

  advance(61 * 1000);
  await registry.ensure(["nobody/nothing"]);
  assert.ok(fetchFn.calls.length > requests, "someone may have just published it");
});

test("a sof registry failure is an error, and does not consult Wally for a different package", async () => {
  const fetchFn = fakeFetch({
    [ROUTER_URL]: () => reply(500, "down"),
    "https://raw.githubusercontent.com/UpliftGames/wally-index/main/sovvie/router": () =>
      reply(200, '{"package":{"version":"9.9.9"}}'),
  });
  const { registry } = makeRegistry(fetchFn);
  await registry.ensure(["sovvie/router"]);
  const state = registry.getState("sovvie/router");
  assert.equal(state.status, "error");
  assert.match(state.error, /500/);
  assert.equal(fetchFn.calls.length, 1);
});

test("network failures become an error state with a readable message", async () => {
  const fetchFn = async () => {
    const err = new TypeError("fetch failed");
    err.cause = new Error("getaddrinfo ENOTFOUND registry.test");
    throw err;
  };
  const { registry, advance } = makeRegistry(fetchFn);
  await registry.ensure(["sovvie/router"]);
  const state = registry.getState("sovvie/router");
  assert.equal(state.status, "error");
  assert.match(state.error, /Could not reach https:\/\/registry\.test.*ENOTFOUND/);

  // Retried after the short error backoff.
  let calls = 0;
  const { registry: again, advance: advance2 } = makeRegistry(async () => {
    calls++;
    throw new Error("down");
  });
  await again.ensure(["sovvie/router"]);
  await again.ensure(["sovvie/router"]);
  assert.equal(calls, 1);
  advance2(31 * 1000);
  await again.ensure(["sovvie/router"]);
  assert.equal(calls, 2);
  void advance;
});

test("at most six requests are in flight at once", async () => {
  let active = 0;
  let peak = 0;
  const fetchFn = async () => {
    active++;
    peak = Math.max(peak, active);
    await new Promise((resolve) => setTimeout(resolve, 5));
    active--;
    return reply(200, sofIndex(["1.0.0"]));
  };
  const { registry } = makeRegistry(fetchFn);
  const names = Array.from({ length: 20 }, (_, i) => `s/p${i}`);
  await registry.ensure(names);
  assert.equal(peak, 6);
  assert.ok(names.every((name) => registry.getState(name).status === "ok"));
});

test("concurrent ensure calls for one package share a single request", async () => {
  const fetchFn = fakeFetch({
    [ROUTER_URL]: async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
      return reply(200, sofIndex(["1.0.0"]));
    },
  });
  const { registry } = makeRegistry(fetchFn);
  await Promise.all([registry.ensure(["sovvie/router"]), registry.ensure(["sovvie/router"])]);
  assert.equal(fetchFn.calls.length, 1);
});

test("changing the registry URL drops what was cached for the old one", async () => {
  const fetchFn = fakeFetch({
    [ROUTER_URL]: () => reply(200, sofIndex(["1.0.0"])),
    "https://other.test/index/sovvie/router.json": () => reply(200, sofIndex(["5.0.0"])),
  });
  const { registry, settings } = makeRegistry(fetchFn);
  await registry.ensure(["sovvie/router"]);
  assert.equal(registry.getState("sovvie/router").data.versions[0].version, "1.0.0");

  settings.registryUrl = "https://other.test";
  assert.equal(registry.getState("sovvie/router"), null);
  await registry.ensure(["sovvie/router"]);
  assert.equal(registry.getState("sovvie/router").data.versions[0].version, "5.0.0");
});

test("names the sof registry cannot hold skip straight to Wally", async () => {
  const fetchFn = fakeFetch({});
  const { registry } = makeRegistry(fetchFn);
  await registry.ensure(["Some Where/odd"]);
  assert.equal(fetchFn.calls.length, 1);
  assert.match(fetchFn.calls[0].url, /raw\.githubusercontent\.com/);
});

test("the package list is paged, cached and refreshed in the background", async () => {
  const page = (offset) =>
    reply(200, {
      total: 130,
      packages: Array.from({ length: offset === 0 ? 100 : 30 }, (_, i) => ({
        name: `sovvie/p${offset + i}`,
        latest: "1.0.0",
        versions: 1,
        description: "d",
      })),
    });
  const fetchFn = fakeFetch({
    [`${BASE}/v1/packages?limit=100&offset=0`]: () => page(0),
    [`${BASE}/v1/packages?limit=100&offset=100`]: () => page(100),
  });
  const { registry, advance } = makeRegistry(fetchFn);

  assert.equal(registry.cachedList(), null);
  const list = await registry.getList();
  assert.equal(list.length, 130);
  assert.equal(fetchFn.calls.length, 2);

  await registry.getList();
  assert.equal(fetchFn.calls.length, 2, "cached");

  advance(10 * 60 * 1000);
  const stale = await registry.getList();
  assert.equal(stale.length, 130, "stale list is returned at once");
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(fetchFn.calls.length, 4, "and refreshed in the background");
});

test("a list failure with nothing cached rejects with the reason", async () => {
  const fetchFn = fakeFetch({ [`${BASE}/v1/packages?limit=100&offset=0`]: () => reply(503, "no") });
  const { registry } = makeRegistry(fetchFn);
  await assert.rejects(registry.getList(), /503/);
});

test("works against a real HTTP server with the real fetch (headers, etag, 304)", async () => {
  const seen = [];
  const server = http.createServer((req, res) => {
    seen.push({ url: req.url, ifNoneMatch: req.headers["if-none-match"], ua: req.headers["user-agent"] });
    if (req.url === "/idx/index/sovvie/router.json") {
      if (req.headers["if-none-match"] === '"abc"') {
        res.writeHead(304);
        res.end();
        return;
      }
      res.writeHead(200, { "content-type": "application/json", etag: '"abc"' });
      res.end(JSON.stringify(sofIndex(["1.0.0", ["1.1.0", { yanked: true }]])));
      return;
    }
    res.writeHead(404);
    res.end("nope");
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();

  try {
    let now = 0;
    const settings = { registryUrl: `http://127.0.0.1:${port}/idx`, wallyEnabled: false, cacheMs: 1000 };
    const registry = new Registry({ getSettings: () => settings, now: () => now, userAgent: "sof-vscode/test" });

    await registry.ensure(["sovvie/router"]);
    const state = registry.getState("sovvie/router");
    assert.equal(state.status, "ok");
    assert.equal(state.data.versions.find((v) => v.version === "1.1.0").yanked, true);

    now += 5000;
    await registry.ensure(["sovvie/router"]);
    assert.equal(seen[1].ifNoneMatch, '"abc"');
    assert.equal(seen[0].ua, "sof-vscode/test");
    assert.equal(registry.getState("sovvie/router").status, "ok");
  } finally {
    server.close();
  }
});
