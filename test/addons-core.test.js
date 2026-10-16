"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const childProcess = require("child_process");
const tar = require("tar");
const fs = require("fs");
const os = require("os");
const path = require("path");

const { sendJson, startServer } = require("./helpers");

const sofHome = fs.mkdtempSync(path.join(os.tmpdir(), "sofhome-addons-"));
process.env.SOF_HOME = sofHome;
process.env.SOF_ACCOUNT_PROTECTION = "off";
delete process.env.SOF_REQUIRE_SANDBOX;

const { parseArgs, createTestHost, helpFor } = require("../src/addons/kit");
const { checkRequires, readRequires } = require("../src/addons/requires");
const { inspectAddon } = require("../src/addons/descriptor");
const { scaffoldAddon } = require("../src/addons/scaffold");
const { runAddon } = require("../src/commands/addon");
const { runInstalledAddon } = require("../src/addons/run");
const { readManifest, writeManifest } = require("../src/addons/store");
const { supportsPermissionFlag } = require("../src/addons/run-sandboxed");

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "sof-addons-test-"));
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
  writeManifest({ addons: {} });
  delete process.env.SOF_REQUIRE_SANDBOX;
  process.exitCode = undefined;
});

// A tiny add-on: its run() is `body`, written as source.
function makeAddon(parent, name, { version = "1.0.0", sandbox, requires, body = "" } = {}) {
  const directory = path.join(parent, name);
  fs.mkdirSync(path.join(directory, "src"), { recursive: true });
  const descriptor = { name, version, command: name, entry: "src/main.js", export: "run", description: `the ${name} add-on`, usage: name };
  if (sandbox !== undefined) descriptor.sandbox = sandbox;
  if (requires) descriptor.requires = requires;
  fs.writeFileSync(path.join(directory, "sof-addon.json"), JSON.stringify(descriptor));
  fs.writeFileSync(path.join(directory, "src", "main.js"), `exports.run = async (argv, host) => { ${body} };\n`);
  return directory;
}

// --- the host kit -------------------------------------------------------------------------------

const SPEC = {
  positional: { name: "input", min: 1, max: 2 },
  flags: {
    "--out": { key: "out", type: "string", alias: "-o" },
    "--quality": { key: "quality", type: "integer", min: 1, max: 100, default: 80 },
    "--ratio": { key: "ratio", type: "number" },
    "--format": { key: "format", type: "string", choices: ["png", "webp"] },
    "--include": { key: "include", type: "string", repeat: true },
    "--strip": { key: "strip", default: true },
    "--dry-run": { key: "dryRun" },
  },
};

test("kit: options, values, repeats, negation, -- and defaults", () => {
  const { options, positional } = parseArgs(["a.png", "-o", "out", "--quality=50", "--include", "x", "--include=y", "--no-strip", "--dry-run", "--", "--odd"], SPEC);
  assert.deepEqual(positional, ["a.png", "--odd"]);
  assert.deepEqual(
    { out: options.out, quality: options.quality, include: options.include, strip: options.strip, dryRun: options.dryRun, help: options.help },
    { out: "out", quality: 50, include: ["x", "y"], strip: false, dryRun: true, help: false }
  );
  assert.equal(parseArgs(["a"], SPEC).options.quality, 80);
  assert.equal(parseArgs(["a", "--ratio", "-1.5"], SPEC).options.ratio, -1.5);
});

test("kit: mistakes are explained", () => {
  const bad = (argv, pattern) => assert.throws(() => parseArgs(argv, SPEC), pattern, argv.join(" "));
  bad(["a", "--nope"], /Unknown option: --nope/);
  bad(["a", "--out"], /--out needs a value/);
  bad(["a", "--quality", "abc"], /whole number/);
  bad(["a", "--quality", "1.5"], /whole number/);
  bad(["a", "--quality", "500"], /between 1 and 100/);
  bad(["a", "--format", "gif"], /one of: png, webp/);
  bad(["a", "--dry-run=yes"], /doesn't take a value/);
  bad([], /Missing input/);
  bad(["a", "b", "c"], /Too many arguments/);
  assert.equal(parseArgs(["--help"], SPEC).options.help, true);
});

test("kit: a help text is built from the spec, and the test host records output and answers", async () => {
  const help = helpFor("img", SPEC, "images");
  assert.match(help, /sof run img <input\.\.\.> \[options\]/);
  assert.match(help, /-o, --out <string>/);
  assert.match(help, /--format <png\|webp>/);

  const { host, output } = createTestHost({ answers: [true, false] });
  host.log.info("one");
  host.log.warn("two");
  assert.equal(await host.confirm("ok?"), true);
  assert.equal(await host.confirm("again?"), false);
  assert.equal(output(), "one\n! two");
});

// --- requires -----------------------------------------------------------------------------------

test("requires: shape is checked", () => {
  assert.deepEqual(readRequires({}), { sof: null, addons: {}, tools: [] });
  assert.throws(() => readRequires({ requires: [] }), /must be an object/);
  assert.throws(() => readRequires({ requires: { sof: "banana" } }), /semver range/);
  assert.throws(() => readRequires({ requires: { addons: { "Bad Name": "1" } } }), /invalid add-on name/);
  assert.throws(() => readRequires({ requires: { addons: { docs: "nope" } } }), /semver range/);
  assert.throws(() => readRequires({ requires: { tools: ["a b"] } }), /tool aliases/);
  assert.throws(() => readRequires({ requires: { other: 1 } }), /unknown key/);
});

test("requires: missing and too-old add-ons, the sof version and tools are reported with a fix", () => {
  const descriptor = { requires: { sof: ">=9.0.0", addons: { docs: "^2.0.0", gone: "*" }, tools: ["ffmpeg"] } };
  const problems = checkRequires(descriptor, { manifest: { addons: { docs: { version: "1.4.0" } } }, sofVersion: "2.7.2", findTool: () => null });
  assert.deepEqual(problems.map((problem) => problem.kind), ["sof", "addon", "addon", "tool"]);
  assert.match(problems[1].message, /docs \^2\.0\.0 \(installed: 1\.4\.0\)/);
  assert.equal(problems[1].fix, "sof run addon update docs");
  assert.equal(problems[2].fix, "sof run addon add gone@*");

  assert.deepEqual(
    checkRequires(descriptor, { manifest: { addons: { docs: { version: "2.1.0" }, gone: { version: "0.1.0" } } }, sofVersion: "9.1.0", findTool: () => ({}) }),
    []
  );
});

// --- scaffolding and checking -------------------------------------------------------------------

test("a scaffolded add-on is valid, sandboxed, and its own tests pass", () => {
  const directory = path.join(tempDir(), "hello");
  scaffoldAddon({ name: "hello", directory });
  const result = inspectAddon(directory);
  assert.deepEqual(result.problems, []);
  assert.equal(result.descriptor.sandbox, true);
  assert.ok(result.warnings.every((warning) => !/sandbox/.test(warning)));

  const run = childProcess.spawnSync(process.execPath, ["--test"], { cwd: directory, env: { ...process.env, SOF_ADDON_KIT: require.resolve("../src/addons/kit") }, encoding: "utf8" });
  assert.equal(run.status, 0, run.stdout + run.stderr);

  assert.throws(() => scaffoldAddon({ name: "hello", directory }), /already exists/);
  assert.throws(() => scaffoldAddon({ name: "Bad", directory: tempDir() }), /isn't a good add-on name/);
  assert.throws(() => scaffoldAddon({ name: "install", directory: tempDir() }), /built-in/);
  assert.equal(inspectAddon(path.join(tempDir(), "nope")).problems.length, 1);
});

test("inspect: problems stop a release, warnings are advice", () => {
  const parent = tempDir();
  const directory = makeAddon(parent, "thing");
  let result = inspectAddon(directory);
  assert.deepEqual(result.problems, []);
  assert.ok(result.warnings.some((warning) => /"sandbox" is not declared/.test(warning)));

  fs.writeFileSync(path.join(directory, "sof-addon.json"), JSON.stringify({ name: "Thing", version: "one", command: "install", entry: "src/missing.js", sandbox: "yes", requires: { sof: "banana" } }));
  result = inspectAddon(directory);
  assert.equal(result.problems.length, 6, result.problems.join("\n"));
});

// --- running: requires, composition, sandbox policy ---------------------------------------------

test("an add-on whose requirements aren't met doesn't start, and says how to fix it", async () => {
  const parent = tempDir();
  await capture(() => runAddon(["add", "--path", makeAddon(parent, "needy", { sandbox: false, requires: { sof: ">=99.0.0" }, body: "throw new Error('should not run');" })]));
  const addon = readManifest().addons.needy;
  await assert.rejects(() => runInstalledAddon(addon, []), /can't run yet:\n {2}- needs sof >=99\.0\.0.*\(sof run self update\)/);
});

test("an add-on gets the host: args, config from sof.toml, and can call an add-on it requires", async () => {
  const parent = tempDir();
  const project = tempDir();
  fs.writeFileSync(path.join(project, "sof.toml"), '[addons.caller]\ngreeting = "hi"\n');
  const marker = path.join(project, "marker.txt");

  await capture(async () => {
    await runAddon(["add", "--path", makeAddon(parent, "callee", { sandbox: false, body: `require('fs').appendFileSync(${JSON.stringify(marker)}, 'callee:' + argv.join(',') + '\\n');` })]);
    await runAddon([
      "add",
      "--path",
      makeAddon(parent, "caller", {
        sandbox: false,
        requires: { addons: { callee: "^1.0.0" } },
        body: `const { options } = host.args.parse(argv, { flags: { '--n': { key: 'n', type: 'integer', default: 0 } } });
               const config = await host.config();
               await host.addons.run('callee', [config.greeting, String(options.n)]);
               if (typeof host.tempDir !== 'function' || host.sandboxed !== false) throw new Error('host');`,
      }),
    ]);
  });

  await runInstalledAddon(readManifest().addons.caller, ["--n", "3"], { cwd: project });
  assert.equal(fs.readFileSync(marker, "utf8"), "callee:hi,3\n");
});

test("an add-on can only call add-ons it lists under requires.addons", async () => {
  const parent = tempDir();
  await capture(async () => {
    await runAddon(["add", "--path", makeAddon(parent, "other", { sandbox: false })]);
    await runAddon(["add", "--path", makeAddon(parent, "sneaky", { sandbox: false, body: "await host.addons.run('other', []);" })]);
  });
  await assert.rejects(() => runInstalledAddon(readManifest().addons.sneaky, []), /can only call add-ons it lists under "requires\.addons"/);
});

const SANDBOX = { skip: !supportsPermissionFlag() && "needs Node 22.13 or newer" };

test("a sandboxed add-on can call sandboxed add-ons, but not unsandboxed ones", SANDBOX, async () => {
  const parent = tempDir();
  const project = tempDir();
  const marker = path.join(project, "marker.txt");

  await capture(async () => {
    await runAddon(["add", "--path", makeAddon(parent, "safe", { sandbox: true, body: `require('fs').appendFileSync(${JSON.stringify(marker)}, 'safe:' + argv.join(',') + '\\n');` })]);
    await runAddon(["add", "--path", makeAddon(parent, "loose", { sandbox: false })]);
    await runAddon(["add", "--path", makeAddon(parent, "boxed", { sandbox: true, requires: { addons: { safe: "*", loose: "*" } }, body: `
      const config = await host.config();
      await host.addons.run('safe', ['from-boxed', String(config.n)]);
      try { await host.addons.run('loose', []); } catch (error) { require('fs').appendFileSync(${JSON.stringify(marker)}, 'refused:' + error.message + '\\n'); }` })]);
  });
  fs.writeFileSync(path.join(project, "sof.toml"), "[addons.boxed]\nn = 7\n");

  await runInstalledAddon(readManifest().addons.boxed, [], { cwd: project });
  const lines = fs.readFileSync(marker, "utf8").trim().split("\n");
  assert.equal(lines[0], "safe:from-boxed,7");
  assert.match(lines[1], /refused:.*sandbox, so it can only call sandboxed add-ons/);
});

test("SOF_REQUIRE_SANDBOX=1 refuses add-ons that aren't sandboxed", async () => {
  const parent = tempDir();
  await capture(() => runAddon(["add", "--path", makeAddon(parent, "loose", { body: "" })]));
  process.env.SOF_REQUIRE_SANDBOX = "1";
  await assert.rejects(() => runInstalledAddon(readManifest().addons.loose, []), /isn't sandboxed/);
});

test("an add-on that others require can't be removed without --force", async () => {
  const parent = tempDir();
  await capture(async () => {
    await runAddon(["add", "--path", makeAddon(parent, "base")]);
    await runAddon(["add", "--path", makeAddon(parent, "top", { requires: { addons: { base: "*" } } })]);
  });
  await assert.rejects(() => runAddon(["remove", "base"]), /top requires base/);
  await capture(() => runAddon(["remove", "base", "--force"]));
  assert.equal(readManifest().addons.base, undefined);
});

// --- the registry: add (with requirements), search, info, outdated ------------------------------

function archive(descriptor) {
  const folder = tempDir();
  fs.mkdirSync(path.join(folder, "src"));
  fs.writeFileSync(path.join(folder, "sof-addon.json"), JSON.stringify({ command: descriptor.name, entry: "src/main.js", ...descriptor }));
  fs.writeFileSync(path.join(folder, "src", "main.js"), "exports.run = async () => {};\n");
  const file = path.join(tempDir(), "a.tar.gz");
  // The tar package, not a `tar` program: GNU tar (Git for Windows) reads "C:\..." as a remote host.
  tar.c({ file, gzip: true, cwd: folder, portable: true, sync: true }, ["sof-addon.json", "src"]);
  return fs.readFileSync(file);
}

async function withRegistry(addons, run) {
  const server = await startServer((request, response) => {
    const url = new URL(request.url, "http://x");
    const index = url.pathname.match(/^\/index\/sofaddon\/([^/]+)\.json$/);
    const artifact = url.pathname.match(/^\/packages\/sofaddon\/([^/]+)\/([^/]+)\.tar\.gz$/);
    if (index && addons[index[1]]) {
      sendJson(response, 200, { scope: "sofaddon", name: index[1], versions: Object.fromEntries(Object.keys(addons[index[1]]).map((version) => [version, {}])) });
    } else if (artifact && addons[artifact[1]] && addons[artifact[1]][artifact[2]]) {
      response.writeHead(200, { "Content-Type": "application/gzip" });
      response.end(archive(addons[artifact[1]][artifact[2]]));
    } else if (url.pathname === "/v1/packages") {
      const query = url.searchParams.get("q") || "";
      const packages = Object.entries(addons)
        .filter(([name]) => name.includes(query))
        .map(([name, versions]) => ({ name: `sofaddon/${name}`, latest: Object.keys(versions).pop(), description: `the ${name} add-on` }));
      sendJson(response, 200, { packages, total: packages.length });
    } else {
      response.writeHead(404);
      response.end("{}");
    }
  });

  const modules = Object.keys(require.cache).filter((key) => key.includes(`${path.sep}sof${path.sep}src${path.sep}packages${path.sep}`) || key.includes("/src/commands/addon.js"));
  const saved = process.env.SOF_REGISTRY_URL;
  process.env.SOF_REGISTRY_URL = server.url;
  // The registry URL is read when the modules load, so load them again for this server.
  for (const key of Object.keys(require.cache)) {
    if (/[\\/]src[\\/](packages|commands[\\/]addon\.js|addons[\\/]run)/.test(key)) delete require.cache[key];
  }
  try {
    await run(require("../src/commands/addon").runAddon);
  } finally {
    if (saved === undefined) delete process.env.SOF_REGISTRY_URL;
    else process.env.SOF_REGISTRY_URL = saved;
    await server.close();
    void modules;
  }
}

const DOCS = { name: "docs", version: "1.0.0", description: "docs", sandbox: true };

test("add installs what the add-on requires, and says what it is allowed to do", async () => {
  await withRegistry(
    {
      base: { "1.0.0": { ...DOCS, name: "base" }, "1.2.0": { ...DOCS, name: "base", version: "1.2.0" } },
      top: { "1.0.0": { name: "top", version: "1.0.0", description: "top", sandbox: false, env: ["HOME"], requires: { addons: { base: "^1.0.0" }, tools: ["ffmpeg"] } } },
    },
    async (run) => {
      const output = await capture(() => run(["add", "top"]));
      const manifest = readManifest().addons;
      assert.equal(manifest.top.version, "1.0.0");
      assert.equal(manifest.base.version, "1.2.0", "the newest that fits");
      assert.match(output, /NOT sandboxed: runs with all your permissions/);
      assert.match(output, /reads environment variables: HOME/);
      assert.match(output, /needs the add-on base \^1\.0\.0 \(installed with it\)/);
      assert.match(output, /top needs base \^1\.0\.0: installing it too/);
      assert.match(output, /needs these in \[tools\].*ffmpeg/);
    }
  );
});

test("search, info and outdated", async () => {
  await withRegistry(
    {
      alpha: { "1.0.0": { ...DOCS, name: "alpha" }, "2.0.0": { ...DOCS, name: "alpha", version: "2.0.0" } },
      beta: { "1.0.0": { ...DOCS, name: "beta", account: { hosts: ["roblox-sync.sov.gg"] } } },
    },
    async (run) => {
      assert.match(await capture(() => run(["search", "alp"])), /alpha +2\.0\.0 +the alpha add-on/);
      assert.match(await capture(() => run(["search", "zzz"])), /No add-ons match "zzz"/);

      const info = await capture(() => run(["info", "beta"]));
      assert.match(info, /latest: +1\.0\.0/);
      assert.match(info, /sandboxed: no access to your sign-in/);
      assert.match(info, /Install it with: sof run addon add beta/);

      await capture(() => run(["add", "alpha@1.0.0"]));
      assert.match(await capture(() => run(["outdated"])), /alpha {2}1\.0\.0 -> 2\.0\.0/);
      await capture(() => run(["update", "alpha"]));
      assert.match(await capture(() => run(["outdated"])), /up to date/);
    }
  );
});
