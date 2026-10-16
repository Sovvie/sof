"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const childProcess = require("child_process");
const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");
const zlib = require("zlib");

const { sendJson, startServer } = require("./helpers");

const home = fs.mkdtempSync(path.join(os.tmpdir(), "sofhome-offline-"));
process.env.SOF_HOME = home;
delete process.env.SOF_OFFLINE;

const cache = require("../src/cache");
const { createRegistry } = require("../src/packages/registry");
const { runInstall } = require("../src/commands/install");
const { installTool, readInstallRecord, toolExecutablePath } = require("../src/tools/store");
const { currentPlatform, writeToolsLock } = require("../src/tools/lock");
const { verifyTools } = require("../src/tools/verify");
const { parseToolSpecifier } = require("../src/tools/spec");

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "sof-offline-test-"));
}

async function capture(run) {
  const lines = [];
  const original = { log: console.log, warn: console.warn, error: console.error };
  console.log = console.warn = console.error = (...parts) => lines.push(parts.join(" "));
  try {
    await run();
  } finally {
    Object.assign(console, original);
  }
  return lines.join("\n");
}

test.beforeEach(() => {
  cache.setOffline(false);
  fs.rmSync(cache.cacheRoot(), { recursive: true, force: true });
});

// --- the cache itself ---------------------------------------------------------------------------

test("cache: archives round trip, and a damaged one is ignored", () => {
  cache.writePackage("sof", "sovvie/router", "1.0.0", Buffer.from("archive"), "tar.gz");
  const hit = cache.readPackage("sof", "sovvie/router", "1.0.0");
  assert.equal(hit.buffer.toString(), "archive");
  assert.equal(hit.archiveType, "tar.gz");

  const file = path.join(cache.cacheRoot(), "packages", "sof", "sovvie", "router", "1.0.0.bin");
  fs.writeFileSync(file, "tampered");
  assert.equal(cache.readPackage("sof", "sovvie/router", "1.0.0"), null);
  assert.equal(cache.readPackage("sof", "sovvie/missing", "1.0.0"), null);
});

test("cache: names from a registry can't point outside the cache", () => {
  cache.writePackage("sof", "../../evil", "../1.0.0", Buffer.from("x"), "tar.gz");
  assert.ok(!fs.existsSync(path.join(home, "evil")));
  assert.equal(cache.readPackage("sof", "../../evil", "../1.0.0"), null);
});

test("cache: info counts, clear removes", () => {
  cache.writePackage("sof", "a/b", "1.0.0", Buffer.from("12345"), "tar.gz");
  cache.writeIndex("sof", "a/b", { source: "sof", packageName: "a/b", versions: [{ version: "1.0.0" }] });
  const info = cache.cacheInfo();
  assert.equal(info.packages.files, 2);
  assert.equal(info.index.files, 1);

  cache.clearCache(["packages"]);
  assert.equal(cache.cacheInfo().packages.files, 0);
  assert.equal(cache.cacheInfo().index.files, 1);
  assert.throws(() => cache.clearCache(["nope"]), /Unknown cache folder/);
});

// --- packages through the registry ---------------------------------------------------------------

async function withRegistry(run) {
  let served = 0;
  const server = await startServer((request, response) => {
    served += 1;
    if (request.url === "/index/sovvie/router.json") {
      sendJson(response, 200, { scope: "sovvie", name: "router", versions: { "1.0.0": {} } });
    } else if (request.url === "/packages/sovvie/router/1.0.0.tar.gz") {
      response.writeHead(200);
      response.end("ARCHIVE-BYTES");
    } else {
      response.writeHead(404);
      response.end("{}");
    }
  });
  try {
    await run({ server, served: () => served });
  } finally {
    await server.close();
  }
}

test("registry: what was fetched is kept, and offline uses only that", async () => {
  await withRegistry(async ({ server, served }) => {
    const online = createRegistry({ registryUrl: server.url });
    const entry = await online.queryPackage("sovvie/router", { preferredSource: "sof", allowFallback: false });
    assert.equal(entry.versions[0].version, "1.0.0");
    const download = await online.downloadPackage("sof", "sovvie/router", "1.0.0");
    assert.equal(download.buffer.toString(), "ARCHIVE-BYTES");

    // The same download again does not touch the server (archives never change).
    const before = served();
    await online.downloadPackage("sof", "sovvie/router", "1.0.0");
    assert.equal(served(), before);

    cache.setOffline();
    const offlineEntry = await online.queryPackage("sovvie/router", { preferredSource: "sof", allowFallback: false });
    assert.equal(offlineEntry.versions[0].version, "1.0.0");
    assert.equal((await online.downloadPackage("sof", "sovvie/router", "1.0.0")).buffer.toString(), "ARCHIVE-BYTES");
    assert.equal(served(), before, "nothing was requested");

    await assert.rejects(() => online.queryPackage("sovvie/other", { preferredSource: "sof", allowFallback: false }), /Offline: sovvie\/other isn't in the cache/);
    await assert.rejects(() => online.downloadPackage("sof", "sovvie/router", "9.9.9"), /Offline: sovvie\/router@9\.9\.9 isn't in the cache/);
  });
});

// --- tools -------------------------------------------------------------------------------------------

const PLATFORM_WORDS = { linux: "linux", darwin: "macos", win32: "windows" };
const ARCH_WORDS = { x64: "x86_64", arm64: "aarch64" };

function assetName(version) {
  return `widget-${version}-${PLATFORM_WORDS[process.platform] || "linux"}-${ARCH_WORDS[process.arch] || "x86_64"}.gz`;
}

async function withGithub(content, run) {
  const gz = zlib.gzipSync(Buffer.from(content));
  let requests = 0;
  const server = await startServer((request, response) => {
    requests += 1;
    const url = new URL(request.url, "http://x");
    if (url.pathname === "/download") {
      response.writeHead(200);
      response.end(gz);
    } else if (/\/releases\/tags\/v1\.0\.0$/.test(url.pathname)) {
      sendJson(response, 200, {
        tag_name: "v1.0.0",
        assets: [{ name: assetName("1.0.0"), size: gz.length, browser_download_url: `${server.url}/download` }],
      });
    } else {
      sendJson(response, 404, { message: "Not Found" });
    }
  });
  const saved = { api: process.env.SOF_GITHUB_API_URL, token: process.env.GITHUB_TOKEN, gh: process.env.GH_TOKEN, rokit: process.env.ROKIT_ROOT };
  process.env.SOF_GITHUB_API_URL = server.url;
  process.env.GITHUB_TOKEN = "";
  process.env.GH_TOKEN = "";
  process.env.ROKIT_ROOT = tempDir();
  try {
    await run({ requests: () => requests, gz });
  } finally {
    for (const [key, name] of [["api", "SOF_GITHUB_API_URL"], ["token", "GITHUB_TOKEN"], ["gh", "GH_TOKEN"], ["rokit", "ROKIT_ROOT"]]) {
      if (saved[key] === undefined) delete process.env[name];
      else process.env[name] = saved[key];
    }
    await server.close();
  }
}

test("tools: a download is kept; a reinstall offline, or against a matching lock, doesn't download again", async () => {
  await withGithub("PROGRAM", async ({ requests }) => {
    const spec = parseToolSpecifier("acme/widget@1.0.0");
    const first = await installTool(spec, { alias: "widget" });
    assert.equal(fs.readFileSync(toolExecutablePath(spec), "utf8"), "PROGRAM");
    assert.ok(readInstallRecord(spec).exe, "the program's own checksum is recorded");
    const made = requests();

    // Offline: reinstalling takes the cached download.
    fs.rmSync(path.dirname(toolExecutablePath(spec)), { recursive: true, force: true });
    cache.setOffline();
    const output = [];
    await installTool(spec, { alias: "widget", log: (line) => output.push(line) });
    assert.equal(fs.readFileSync(toolExecutablePath(spec), "utf8"), "PROGRAM");
    assert.match(output.join("\n"), /Using the cached acme\/widget@1\.0\.0/);
    assert.equal(requests(), made);

    // Online with a lock that names exactly that file: also from the cache.
    cache.setOffline(false);
    fs.rmSync(path.dirname(toolExecutablePath(spec)), { recursive: true, force: true });
    await installTool(spec, { alias: "widget", expected: { asset: first.record.asset, sha256: first.record.sha256 } });
    assert.equal(requests(), made);

    // A lock that names another file is not satisfied by the cache, and is refused.
    fs.rmSync(path.dirname(toolExecutablePath(spec)), { recursive: true, force: true });
    await assert.rejects(() => installTool(spec, { alias: "widget", expected: { asset: first.record.asset, sha256: "0".repeat(64) } }), /doesn't match sof\.tools\.lock/);
  });
});

test("tools: offline with nothing cached says so", async () => {
  cache.setOffline();
  await assert.rejects(() => installTool(parseToolSpecifier("acme/gadget@2.0.0")), /isn't in the offline cache/);
});

test("tools verify: notices a changed program, a different download than the lock's, and a missing tool", async () => {
  await withGithub("PROGRAM", async () => {
    const spec = parseToolSpecifier("acme/widget@1.0.0");
    const { record } = await installTool(spec, { alias: "widget" });
    const entries = [{ alias: "widget", spec }, { alias: "ghost", spec: parseToolSpecifier("acme/ghost@1.0.0") }];

    const lockPath = path.join(tempDir(), "sof.tools.lock");
    const platform = currentPlatform();
    writeToolsLock(lockPath, [{ name: "acme/widget", version: "1.0.0", platform, asset: record.asset, sha256: record.sha256 }]);
    const lock = require("../src/tools/lock").readToolsLock(lockPath);

    let result = verifyTools(entries, lock);
    assert.deepEqual(result.problems, ["ghost 1.0.0 isn't installed (sof run tools install)"]);
    assert.match(result.ok[0], /widget 1\.0\.0 matches sof\.tools\.lock/);

    fs.writeFileSync(toolExecutablePath(spec), "EVIL");
    result = verifyTools(entries, lock);
    assert.match(result.problems.join("\n"), /widget 1\.0\.0 was changed after sof installed it/);

    writeToolsLock(lockPath, [{ name: "acme/widget", version: "1.0.0", platform, asset: record.asset, sha256: "f".repeat(64) }]);
    result = verifyTools([entries[0]], require("../src/tools/lock").readToolsLock(lockPath));
    assert.match(result.problems.join("\n"), /different file than sof\.tools\.lock/);
  });
});

// --- sof run install --frozen / --offline ------------------------------------------------------------

test("install --offline installs packages and tools from the cache; --frozen requires the lock files", async () => {
  await withGithub("PROGRAM", async () => {
    await withRegistry(async ({ server, served }) => {
      const project = tempDir();
      const previous = { cwd: process.cwd(), registry: process.env.SOF_REGISTRY_URL };
      fs.writeFileSync(path.join(project, "sof.toml"), '[tools]\nwidget = "acme/widget@1.0.0"\n');
      process.chdir(project);
      try {
        // Frozen without a tools lock is refused before anything is downloaded.
        await assert.rejects(() => runInstall(["--frozen"]), /--locked needs sof\.tools\.lock/);

        fs.rmSync(path.join(home, "tools"), { recursive: true, force: true });
        await capture(() => runInstall([]));
        assert.ok(fs.existsSync(toolExecutablePath(parseToolSpecifier("acme/widget@1.0.0"))));

        // Offline from here: remove the installed tool, install again with the network "down".
        fs.rmSync(path.join(home, "tools"), { recursive: true, force: true });
        const before = served();
        const output = await capture(() => runInstall(["--offline"]));
        assert.match(output, /Using the cached acme\/widget@1\.0\.0/);
        assert.equal(served(), before);
        assert.equal(process.env.SOF_OFFLINE, "1");
      } finally {
        process.chdir(previous.cwd);
        void server;
      }
    });
  });
});

test("cache command: info, path and clear", async () => {
  const { runCache } = require("../src/commands/cache");
  cache.writePackage("sof", "a/b", "1.0.0", Buffer.from("12345"), "tar.gz");
  assert.match(await capture(() => runCache(["info"])), /packages +2 file/);
  assert.equal((await capture(() => runCache(["path"]))).trim(), cache.cacheRoot());
  assert.match(await capture(() => runCache(["clear", "packages"])), /Cleared packages/);
  assert.equal(cache.cacheInfo().packages.files, 0);
  void childProcess;
  void crypto;
});
