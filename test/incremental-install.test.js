"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const {
  classifyEntries,
  fingerprintInstalled,
  hashConfigGroups,
  isInstallCurrent,
  recordInstalled,
} = require("../src/packages/state");
const { findMissingTools } = require("../src/rokit/installed");
const { writeLockfile, readLockfile } = require("../src/packages/lockfile");

const PKG_PATH = "src/Packages";

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "sof-test-"));
}

function writePackage(root, alias, files) {
  const directory = path.join(root, PKG_PATH, alias);
  for (const [name, contents] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(directory, name)), { recursive: true });
    fs.writeFileSync(path.join(directory, name), contents);
  }
  return directory;
}

function resolvedEntry(overrides = {}) {
  return {
    alias: "Stream",
    name: "sovvie/stream",
    path: PKG_PATH,
    source: "sof",
    version: "2.0.0",
    aliasRewrites: {},
    expectedChecksum: null,
    ...overrides,
  };
}

function lockEntryFor(entry, checksum = "sha256:aaa") {
  return { name: entry.name, alias: entry.alias, version: entry.version, source: entry.source, path: entry.path, checksum };
}

function installedState(root, entry, checksum = "sha256:aaa") {
  const destination = path.join(root, PKG_PATH, entry.alias);
  const record = recordInstalled({ ...entry, checksum }, destination, root);
  return { packages: { [`${PKG_PATH}::${entry.alias}`]: record } };
}

test("an untouched installed package is up to date", () => {
  const root = tempDir();
  writePackage(root, "Stream", { "init.luau": "return 1", "Util.luau": "return 2" });
  const entry = resolvedEntry();
  const state = installedState(root, entry);

  const { current, stale } = classifyEntries([entry], [lockEntryFor(entry)], state, root);

  assert.equal(current.length, 1);
  assert.equal(stale.length, 0);
});

test("a package that is not in the lockfile is new", () => {
  const root = tempDir();
  const { stale } = classifyEntries([resolvedEntry()], [], { packages: {} }, root);

  assert.deepEqual(stale.map((item) => item.reason), ["new"]);
});

test("a version bump reinstalls only that package", () => {
  const root = tempDir();
  writePackage(root, "Stream", { "init.luau": "return 1" });
  writePackage(root, "Butler", { "init.luau": "return 1" });
  const stream = resolvedEntry();
  const butler = resolvedEntry({ alias: "Butler", name: "sovvie/butler", version: "1.0.0" });
  const state = {
    packages: { ...installedState(root, stream).packages, ...installedState(root, butler).packages },
  };
  const bumped = { ...stream, version: "2.1.0" };

  const { current, stale } = classifyEntries(
    [bumped, butler],
    [lockEntryFor(stream), lockEntryFor(butler)],
    state,
    root
  );

  assert.deepEqual(current.map((item) => item.entry.alias), ["Butler"]);
  assert.deepEqual(stale.map((item) => [item.entry.alias, item.reason]), [["Stream", "2.0.0 -> 2.1.0"]]);
});

test("a deleted or edited package folder is reinstalled", () => {
  const root = tempDir();
  const directory = writePackage(root, "Stream", { "init.luau": "return 1" });
  const entry = resolvedEntry();
  const state = installedState(root, entry);
  const locks = [lockEntryFor(entry)];

  fs.writeFileSync(path.join(directory, "init.luau"), "return 999");
  assert.equal(classifyEntries([entry], locks, state, root).stale[0].reason, "modified");

  fs.rmSync(directory, { recursive: true });
  assert.equal(classifyEntries([entry], locks, state, root).stale[0].reason, "missing");
});

test("changed alias rewrites or checksum reinstall the package", () => {
  const root = tempDir();
  writePackage(root, "Stream", { "init.luau": "return 1" });
  const entry = resolvedEntry();
  const state = installedState(root, entry);
  const locks = [lockEntryFor(entry)];

  const rewritten = resolvedEntry({ aliasRewrites: { Butler: "Bt" } });
  assert.equal(classifyEntries([rewritten], locks, state, root).stale[0].reason, "requires changed");

  const republished = resolvedEntry({ expectedChecksum: "sha256:bbb" });
  assert.equal(classifyEntries([republished], locks, state, root).stale[0].reason, "checksum changed");
});

test("sof's own init.meta.json does not make a package look modified", () => {
  const root = tempDir();
  const directory = writePackage(root, "Stream", { "init.luau": "return 1" });
  const before = fingerprintInstalled(directory);

  fs.writeFileSync(path.join(directory, "init.meta.json"), "{}");

  assert.equal(fingerprintInstalled(directory), before);
});

test("isInstallCurrent needs matching config, lockfile and untouched files", () => {
  const root = tempDir();
  writePackage(root, "Stream", { "init.luau": "return 1" });
  const entry = resolvedEntry();
  const groups = [{ path: PKG_PATH, dependencies: [], keepUnknownInstances: [] }];

  const lockfilePath = path.join(root, "sof.lock");
  const written = writeLockfile(lockfilePath, [lockEntryFor(entry)]);
  const lockfile = readLockfile(lockfilePath);
  assert.equal(lockfile.hash, written.hash);

  const state = {
    ...installedState(root, entry),
    configHash: hashConfigGroups(groups),
    lockHash: written.hash,
  };

  assert.equal(isInstallCurrent(state, hashConfigGroups(groups), lockfile, root), true);

  const otherGroups = [{ path: PKG_PATH, dependencies: [{ alias: "X" }], keepUnknownInstances: [] }];
  assert.equal(isInstallCurrent(state, hashConfigGroups(otherGroups), lockfile, root), false);

  fs.appendFileSync(path.join(root, PKG_PATH, "Stream", "init.luau"), "-- edited");
  assert.equal(isInstallCurrent(state, hashConfigGroups(groups), lockfile, root), false);
});

test("writeLockfile leaves an unchanged lockfile alone", () => {
  const root = tempDir();
  const lockfilePath = path.join(root, "sof.lock");
  const entries = [lockEntryFor(resolvedEntry())];

  writeLockfile(lockfilePath, entries);
  const past = new Date(Date.now() - 60_000);
  fs.utimesSync(lockfilePath, past, past);
  writeLockfile(lockfilePath, entries);

  assert.equal(fs.statSync(lockfilePath).mtimeMs, past.getTime());
});

test("findMissingTools compares tool storage and links with [tools]", () => {
  const rokitHome = tempDir();
  const suffix = process.platform === "win32" ? ".exe" : "";
  fs.mkdirSync(path.join(rokitHome, "tool-storage", "kampfkarren", "selene", "0.31.0"), { recursive: true });
  fs.mkdirSync(path.join(rokitHome, "bin"), { recursive: true });
  fs.writeFileSync(path.join(rokitHome, "bin", `selene${suffix}`), "");

  const tools = {
    selene: "Kampfkarren/selene@0.31.0",
    rojo: "rojo-rbx/rojo@7.6.1",
  };
  assert.deepEqual(findMissingTools(tools, rokitHome).map((tool) => tool.alias), ["rojo"]);

  assert.deepEqual(
    findMissingTools({ selene: "Kampfkarren/selene@0.32.0" }, rokitHome).map((tool) => tool.alias),
    ["selene"]
  );
});
