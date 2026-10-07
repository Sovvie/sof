"use strict";

// sof.toml and sof.lock can come from a repository you just cloned: nothing they say may make
// package install write or delete outside the project.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const { readPackageInstallConfig } = require("../src/packages/config");
const { linkInstalledPackages, pruneRemovedPackages, writeRojoMeta } = require("../src/packages/linker");
const { readLockfile } = require("../src/packages/lockfile");
const { assertInsideProject, assertPackageAlias, assertProjectFolder } = require("../src/packages/safe-path");

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "sof-safety-test-"));
}

function configWith(text) {
  const directory = tempDir();
  const file = path.join(directory, "sof.toml");
  fs.writeFileSync(file, text);
  return file;
}

const entryFor = (overrides) => ({
  name: "sovvie/stream",
  alias: "Stream",
  version: "1.0.0",
  source: "sof",
  path: "Packages",
  checksum: "sha256:aaa",
  ...overrides,
});

test("a package folder must be a relative folder inside the project", () => {
  for (const good of ["Packages", "src/Packages", "./Packages", ".", "src\\Shared\\Packages", "a..b/c", "..a/b", "Packages/"]) {
    assert.doesNotThrow(() => assertProjectFolder(good, "path"), good);
  }

  for (const bad of [
    "..", "../x", "x/..", "x/../..", "..\\x", "x\\..\\..", "./../x", "a/b/../../..",
    "/etc", "/", "C:\\Users", "C:/Users", "C:x", "\\\\host\\share\\x", "//host/share/x", "\\x",
    "... ", ".. ", "x/.. /y", "x/.../y", "", "   ", "a\0b",
  ]) {
    assert.throws(() => assertProjectFolder(bad, "path"), /must be a folder inside the project/, JSON.stringify(bad));
  }
});

test("a package alias is one plain name", () => {
  for (const good of ["Stream", "Roact", "a-b_c", "v2.1", "x.y", "Üñí"]) {
    assert.doesNotThrow(() => assertPackageAlias(good, "alias"), good);
  }

  for (const bad of [".", "..", "...", " ", " x", "x ", "x.", "a/b", "a\\b", "..\\x", "../x", "", "a\0b"]) {
    assert.throws(() => assertPackageAlias(bad, "alias"), /single file or folder name/, JSON.stringify(bad));
  }
});

test("sof.toml can't point package install outside the project", () => {
  const ok = readPackageInstallConfig(configWith('[[dependencies]]\npath = "src/Packages"\nStream = "sovvie/stream@1.0.0"\n'));
  assert.equal(ok.groups[0].path, "src/Packages");
  assert.doesNotThrow(() => readPackageInstallConfig(configWith('[[dependencies]]\npath = "."\nStream = "sovvie/stream@1.0.0"\n')));

  assert.throws(() => readPackageInstallConfig(configWith('[[dependencies]]\npath = "../outside"\nStream = "sovvie/stream@1.0.0"\n')), /must be a folder inside the project/);
  assert.throws(() => readPackageInstallConfig(configWith('[[dependencies]]\npath = "C:\\\\Users\\\\me\\\\AppData"\nStream = "sovvie/stream@1.0.0"\n')), /must be a folder inside the project/);
  assert.throws(() => readPackageInstallConfig(configWith('[[dependencies]]\npath = "/etc"\nStream = "sovvie/stream@1.0.0"\n')), /must be a folder inside the project/);

  for (const alias of ["..", ".", "..."]) {
    assert.throws(
      () => readPackageInstallConfig(configWith(`[[dependencies]]\npath = "Packages"\n"${alias}" = "sovvie/stream@1.0.0"\n`)),
      /single file or folder name|path separators/,
      alias
    );
  }

  assert.throws(
    () => readPackageInstallConfig(configWith('[[dependencies]]\npath = "Packages"\nkeep_unknown_instances = ["../.."]\nStream = "sovvie/stream@1.0.0"\n')),
    /keep_unknown_instances/
  );
  assert.doesNotThrow(() =>
    readPackageInstallConfig(configWith('[[dependencies]]\npath = "Packages"\nkeep_unknown_instances = ["Stream"]\nStream = "sovvie/stream@1.0.0"\n'))
  );
});

test("sof.lock can't name a path or alias that reaches outside the project", () => {
  const lockWith = (fields) => {
    const directory = tempDir();
    const file = path.join(directory, "sof.lock");
    const entry = { name: "sovvie/stream", alias: "Stream", version: "1.0.0", source: "sof", path: "Packages", checksum: "sha256:aaa", ...fields };
    fs.writeFileSync(file, `[[package]]\n${Object.entries(entry).map(([key, value]) => `${key} = ${JSON.stringify(value)}`).join("\n")}\n`);
    return file;
  };

  assert.equal(readLockfile(lockWith({})).entries.length, 1);
  assert.throws(() => readLockfile(lockWith({ alias: ".." })), /single file or folder name/);
  assert.throws(() => readLockfile(lockWith({ path: "." , alias: ".." })), /single file or folder name/);
  assert.throws(() => readLockfile(lockWith({ path: "../../x" })), /must be a folder inside the project/);
  assert.throws(() => readLockfile(lockWith({ path: "/home/me" })), /must be a folder inside the project/);
  assert.throws(() => readLockfile(lockWith({ path: "C:\\Users" })), /must be a folder inside the project/);
});

test("package install and prune refuse to touch anything outside the project, whatever they are handed", () => {
  const parent = tempDir();
  const project = path.join(parent, "project");
  const neighbour = path.join(parent, "neighbour");
  fs.mkdirSync(project);
  fs.mkdirSync(neighbour);
  fs.writeFileSync(path.join(neighbour, "keep.txt"), "mine");
  fs.writeFileSync(path.join(project, "sof.toml"), "");

  const extracted = path.join(tempDir(), "pkg");
  fs.mkdirSync(extracted);
  fs.writeFileSync(path.join(extracted, "init.luau"), "return 1");
  fs.writeFileSync(path.join(extracted, "Util.luau"), "return 2");

  // Entries built by hand, as if validation upstream had been skipped.
  assert.throws(() => linkInstalledPackages([{ ...entryFor({ path: "../neighbour" }), extractedPath: extracted }], project), /outside the project/);
  assert.throws(() => linkInstalledPackages([{ ...entryFor({ path: path.join(parent, "neighbour") }), extractedPath: extracted }], project), /outside the project/);
  assert.deepEqual(fs.readdirSync(neighbour), ["keep.txt"]);

  // The reviewer's case: a lock entry with alias ".." and path "." would delete the project's parent.
  assert.throws(() => pruneRemovedPackages([entryFor({ alias: "..", path: "../neighbour" })], [], project), /outside the project/);
  assert.equal(fs.existsSync(path.join(neighbour, "keep.txt")), true);

  assert.throws(() => writeRojoMeta(project, { path: "../neighbour", keepUnknownInstances: ["x"] }), /outside the project/);

  // The ordinary case still works.
  const linked = linkInstalledPackages([{ ...entryFor({}), extractedPath: extracted }], project);
  assert.equal(fs.existsSync(path.join(project, "Packages", "Stream", "init.luau")), true);
  assert.equal(linked.entries.length, 1);
  assert.deepEqual(pruneRemovedPackages([entryFor({})], [], project).length, 1);
  assert.equal(fs.existsSync(path.join(project, "Packages", "Stream")), false);
});

test("a symbolic link inside the project can't carry package install outside it", (t) => {
  const parent = tempDir();
  const project = path.join(parent, "project");
  const outside = path.join(parent, "outside");
  fs.mkdirSync(project);
  fs.mkdirSync(outside);
  fs.writeFileSync(path.join(outside, "keep.txt"), "mine");

  try {
    fs.symlinkSync(outside, path.join(project, "Packages"), "junction");
  } catch (_err) {
    t.skip("this machine can't create symbolic links");
    return;
  }

  const extracted = path.join(tempDir(), "pkg");
  fs.mkdirSync(extracted);
  fs.writeFileSync(path.join(extracted, "init.luau"), "return 1");

  assert.throws(() => assertInsideProject(project, path.join(project, "Packages", "Stream")), /outside the project/);
  assert.throws(() => linkInstalledPackages([{ ...entryFor({}), extractedPath: extracted }], project), /outside the project/);
  assert.deepEqual(fs.readdirSync(outside), ["keep.txt"], "nothing was written through the link");
  assert.throws(() => pruneRemovedPackages([entryFor({})], [], project), /outside the project/);
  assert.equal(fs.readFileSync(path.join(outside, "keep.txt"), "utf8"), "mine");
});
