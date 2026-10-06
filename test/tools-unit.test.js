"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const zlib = require("zlib");
const AdmZip = require("adm-zip");
const tar = require("tar");

const { pickAsset } = require("../src/tools/assets");
const { chooseEntry, extractExecutable, tarProgram } = require("../src/tools/extract");
const { findLockEntry, mergeLockEntries, readToolsLock, writeToolsLock, currentPlatform } = require("../src/tools/lock");
const {
  addToolToConfig,
  editToolsText,
  readToolsFromConfig,
  removeToolFromConfig,
  updateToolsInConfig,
} = require("../src/tools/manifest");
const { findToolEntry } = require("../src/tools/resolve");
const { normalizeAlias, parseToolId, parseToolSpecifier } = require("../src/tools/spec");

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "sof-tools-test-"));
}

function withEnv(values, run) {
  const saved = {};
  for (const [key, value] of Object.entries(values)) {
    saved[key] = process.env[key];
    process.env[key] = value;
  }
  try {
    return run();
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
}

// --- specifiers -----------------------------------------------------------------------------

test("a tool specifier is owner/repo@version, with an optional github: prefix and v", () => {
  assert.deepEqual(parseToolSpecifier("rojo-rbx/rojo@7.6.1"), { owner: "rojo-rbx", repo: "rojo", version: "7.6.1" });
  assert.deepEqual(parseToolSpecifier("github:JohnnyMorganz/StyLua@v2.0.2"), {
    owner: "JohnnyMorganz",
    repo: "StyLua",
    version: "2.0.2",
  });
  assert.equal(parseToolSpecifier("JohnnyMorganz/luau-lsp@1.40.0").repo, "luau-lsp");
  assert.equal(parseToolSpecifier("Roblox/luau@0.640").version, "0.640");
  assert.equal(parseToolSpecifier("a/b@1.0.0-rc.1+build").version, "1.0.0-rc.1+build");
});

test("specifiers that would escape the tool folder are rejected", () => {
  for (const bad of [
    "../evil/tool@1.0.0",
    "owner/../tool@1.0.0",
    "owner/repo@../../x",
    "owner/repo@1.0.0/../../x",
    "owner/repo@..",
    ".hidden/repo@1.0.0",
    "owner/.repo@1.0.0",
    "owner/repo@-1",
    "owner/repo",
    "owner@1.0.0",
    "owner/repo@",
    "owner/repo name@1.0.0",
    "a\\b/repo@1.0.0",
  ]) {
    assert.throws(() => parseToolSpecifier(bad), /owner\/repo@version/, bad);
  }
});

test("aliases become file names, so they are restricted", () => {
  for (const good of ["rojo", "selene28", "luau-lsp", "tool.v2", "Rojo", "sofa", "mysof", "luau", "lune", "wally"]) {
    assert.equal(normalizeAlias(good, "test"), good);
  }

  for (const bad of ["", " ", ".", "..", ".hidden", "-x", "a/b", "a\\b", "con", "NUL", "com1.txt", "sof", "SOF", "a b", "a:b"]) {
    assert.throws(() => normalizeAlias(bad, "test"), /alias|reserved/, JSON.stringify(bad));
  }
});

test("a sof.toml can't claim the name of a program sof, its shims or the shell rely on", () => {
  // The shims go in a folder that is on PATH, so [tools] node = "evil/node@1.0.0" would otherwise
  // make every node (including the one sof itself starts) the attacker's binary.
  for (const name of [
    "node", "NODE", "node.exe", "npm", "npx", "git", "sh", "bash", "dirname", "env", "curl", "tar", "powershell", "cmd.exe", "python3",
    "sof", "sof.cmd", "sof.ps1", "sof.exe", "sof-shim.cfg", "sof-shim", "Sof-anything",
  ]) {
    assert.throws(() => normalizeAlias(name, "test"), /reserved/, name);
  }
});

test("parseToolId accepts owner/repo with an optional version", () => {
  assert.deepEqual(parseToolId("rojo-rbx/rojo"), { owner: "rojo-rbx", repo: "rojo", version: null });
  assert.deepEqual(parseToolId("github:rojo-rbx/rojo@v7.6.1"), { owner: "rojo-rbx", repo: "rojo", version: "7.6.1" });
  assert.equal(parseToolId("rojo-rbx/rojo@latest").version, "latest");
  assert.throws(() => parseToolId("rojo"), /Invalid tool identifier/);
  assert.throws(() => parseToolId("a/b@../x"), /Invalid tool version/);
});

// --- [tools] editing ------------------------------------------------------------------------

test("editToolsText changes only the lines it is asked to and keeps comments and order", () => {
  const original = [
    "# my project",
    "[tools]",
    '# formatter first',
    'stylua = "JohnnyMorganz/StyLua@2.0.0"   # pinned for CI',
    'rojo = "rojo-rbx/rojo@7.4.1"',
    "",
    "[[dependencies]]",
    'path = "Packages"',
    "",
  ].join("\n");

  const updated = editToolsText(original, { set: { rojo: "rojo-rbx/rojo@7.6.1", selene: "Kampfkarren/selene@0.30.1" } });
  assert.equal(
    updated,
    [
      "# my project",
      "[tools]",
      "# formatter first",
      'stylua = "JohnnyMorganz/StyLua@2.0.0"   # pinned for CI',
      'rojo = "rojo-rbx/rojo@7.6.1"',
      'selene = "Kampfkarren/selene@0.30.1"',
      "",
      "[[dependencies]]",
      'path = "Packages"',
      "",
    ].join("\n")
  );

  assert.equal(
    editToolsText(updated, { remove: ["stylua"] }).includes("stylua"),
    false
  );
});

test("editToolsText keeps CRLF line endings and adds a [tools] table when there is none", () => {
  const crlf = '[[dependencies]]\r\npath = "Packages"\r\n';
  const added = editToolsText(crlf, { set: { rojo: "rojo-rbx/rojo@7.6.1" } });
  assert.equal(added, '[[dependencies]]\r\npath = "Packages"\r\n\r\n[tools]\r\nrojo = "rojo-rbx/rojo@7.6.1"\r\n');
  assert.equal(added.replace(/\r\n/g, "").includes("\n"), false);
  assert.equal(editToolsText("", { set: { rojo: "rojo-rbx/rojo@7.6.1" } }), '[tools]\nrojo = "rojo-rbx/rojo@7.6.1"\n');
});

test("editToolsText handles quoted keys and single-quoted values", () => {
  const text = "[tools]\n\"rojo\" = 'rojo-rbx/rojo@7.4.1'\n";
  assert.equal(editToolsText(text, { set: { rojo: "rojo-rbx/rojo@7.6.1" } }), '[tools]\n"rojo" = "rojo-rbx/rojo@7.6.1"\n');
});

test("add, update and remove edit sof.toml on disk and keep the rest of the file", () => {
  const dir = tempDir();
  const file = path.join(dir, "sof.toml");
  fs.writeFileSync(file, '[tools]\nrojo = "rojo-rbx/rojo@7.4.1"\n\n[[dependencies]]\npath = "Packages"\nStream = "sovvie/stream@^2"\n');

  assert.equal(addToolToConfig(file, "selene", "Kampfkarren/selene@0.30.1").replaced, false);
  assert.equal(addToolToConfig(file, "rojo", "rojo-rbx/rojo@7.6.1").replaced, true);
  assert.deepEqual(readToolsFromConfig(file).tools, {
    rojo: "rojo-rbx/rojo@7.6.1",
    selene: "Kampfkarren/selene@0.30.1",
  });

  updateToolsInConfig(file, { selene: "Kampfkarren/selene@0.32.0" });
  assert.equal(readToolsFromConfig(file).tools.selene, "Kampfkarren/selene@0.32.0");

  assert.equal(removeToolFromConfig(file, "ROJO").alias, "rojo");
  assert.deepEqual(Object.keys(readToolsFromConfig(file).tools), ["selene"]);
  assert.match(fs.readFileSync(file, "utf8"), /\[\[dependencies\]\]\npath = "Packages"\nStream = "sovvie\/stream@\^2"/);

  assert.throws(() => removeToolFromConfig(file, "nope"), /no tool "nope"/);
  assert.throws(() => updateToolsInConfig(file, { nope: "a/b@1.0.0" }), /no tool "nope"/);
});

test("a tool that isn't written as an owner/repo@version string is refused with a clear message", () => {
  const dir = tempDir();
  const file = path.join(dir, "sof.toml");

  fs.writeFileSync(file, '[tools]\nrojo = { github = "rojo-rbx/rojo", version = "7.4.1" }\n');
  assert.throws(() => readToolsFromConfig(file), /\[tools\]\.rojo must be a string like "owner\/repo@version"/);

  fs.writeFileSync(file, '[tools]\nrojo = "rojo-rbx/rojo"\n');
  assert.throws(() => readToolsFromConfig(file), /must use "owner\/repo@version"/);
});

test("a name with a dot is written as a quoted key, so it isn't read as a nested table", () => {
  const dir = tempDir();
  const file = path.join(dir, "sof.toml");
  fs.writeFileSync(file, '[tools]\nrojo = "rojo-rbx/rojo@7.6.1"\n');

  addToolToConfig(file, "foo.bar", "owner/foo.bar@1.0.0");
  assert.match(fs.readFileSync(file, "utf8"), /^"foo\.bar" = "owner\/foo\.bar@1\.0\.0"$/m);
  assert.equal(readToolsFromConfig(file).tools["foo.bar"], "owner/foo.bar@1.0.0");

  updateToolsInConfig(file, { "foo.bar": "owner/foo.bar@2.0.0" });
  assert.equal(readToolsFromConfig(file).tools["foo.bar"], "owner/foo.bar@2.0.0");
  removeToolFromConfig(file, "foo.bar");
  assert.deepEqual(Object.keys(readToolsFromConfig(file).tools), ["rojo"]);
});

test("adding Rojo next to rojo changes the one entry rather than adding a second that loses", () => {
  const dir = tempDir();
  const file = path.join(dir, "sof.toml");
  fs.writeFileSync(file, '[tools]\nrojo = "rojo-rbx/rojo@7.4.1"\n');

  const result = addToolToConfig(file, "Rojo", "rojo-rbx/rojo@7.6.1");
  assert.equal(result.replaced, true);
  assert.equal(result.alias, "rojo");
  assert.deepEqual(readToolsFromConfig(file).tools, { rojo: "rojo-rbx/rojo@7.6.1" });
});

test("known tool config files are scaffolded without ever following a symbolic link", (t) => {
  const dir = tempDir();
  const outside = path.join(tempDir(), "victim.txt");

  try {
    fs.symlinkSync(outside, path.join(dir, "selene.toml"));
  } catch (_err) {
    t.skip("this machine can't create symbolic links");
    return;
  }

  const { scaffoldToolConfigs } = require("../src/tools/tool-configs");
  const result = scaffoldToolConfigs(dir, ["selene", "stylua"]);
  assert.deepEqual(result.skippedExisting, ["selene.toml"]);
  assert.deepEqual(result.created, [".stylua.toml"]);
  assert.equal(fs.existsSync(outside), false, "the link's target was not created");

  assert.deepEqual(scaffoldToolConfigs(dir, ["selene", "stylua"]).created, [], "an existing file is left alone");
});

test("a .tar.xz file with symbolic links is refused before anything is unpacked", async (t) => {
  const source = tempDir();
  fs.mkdirSync(path.join(source, "tool-1.0"));
  fs.writeFileSync(path.join(source, "tool-1.0", "tool"), "BINARY");
  try {
    fs.symlinkSync("tool", path.join(source, "tool-1.0", "alias"));
  } catch (_err) {
    t.skip("this machine can't create symbolic links");
    return;
  }

  const made = require("child_process").spawnSync(tarProgram(), ["-cJf", "tool.tar.xz", "tool-1.0"], { cwd: source, encoding: "utf8" });
  if (made.error || made.status !== 0) {
    t.skip("this machine's tar can't write xz");
    return;
  }

  const archive = fs.readFileSync(path.join(source, "tool.tar.xz"));
  await assert.rejects(extractExecutable(archive, "tool-linux-x86_64.tar.xz", ["tool"]), /symbolic or hard links/);
});

test("the global tools file may not exist yet", () => {
  const dir = tempDir();
  const file = path.join(dir, "tools.toml");

  assert.deepEqual(readToolsFromConfig(file, { allowMissing: true }).tools, {});
  assert.throws(() => readToolsFromConfig(file), /does not exist/);

  addToolToConfig(file, "rojo", "rojo-rbx/rojo@7.6.1", { allowMissing: true });
  assert.equal(fs.readFileSync(file, "utf8"), '[tools]\nrojo = "rojo-rbx/rojo@7.6.1"\n');
});

// --- picking the release asset ---------------------------------------------------------------

function names(list) {
  return list.map((name) => ({ name }));
}

const ROJO = names([
  "rojo-7.6.1-linux-aarch64.zip",
  "rojo-7.6.1-linux-x86_64.zip",
  "rojo-7.6.1-macos-aarch64.zip",
  "rojo-7.6.1-macos-x86_64.zip",
  "rojo-7.6.1-windows-aarch64.zip",
  "rojo-7.6.1-windows-x86_64.zip",
]);

const SELENE = names([
  "selene-0.30.1-linux.zip",
  "selene-0.30.1-macos.zip",
  "selene-0.30.1-windows.zip",
  "selene-light-0.30.1-linux.zip",
  "selene-light-0.30.1-macos.zip",
  "selene-light-0.30.1-windows.zip",
]);

const STYLUA = names([
  "stylua-linux-aarch64-musl.zip",
  "stylua-linux-aarch64.zip",
  "stylua-linux-x86_64-musl.zip",
  "stylua-linux-x86_64.zip",
  "stylua-macos-aarch64.zip",
  "stylua-macos-x86_64.zip",
  "stylua-windows-x86_64.zip",
]);

const WALLY = names(["wally-v0.3.2-linux.zip", "wally-v0.3.2-macos.zip", "wally-v0.3.2-win64.zip"]);

const LUAU_LSP = names(["luau-lsp-linux-arm64.zip", "luau-lsp-linux-x86_64.zip", "luau-lsp-macos.zip", "luau-lsp-win64.zip"]);

const DARKLUA = names(["darklua-linux-aarch64.tar.gz", "darklua-linux-x86_64.tar.gz", "darklua-macos-aarch64.tar.gz", "darklua-macos-x86_64.tar.gz", "darklua-windows-x86_64.zip", "checksums.txt"]);

const CARGO_DIST = names([
  "tool-x86_64-pc-windows-msvc.zip",
  "tool-x86_64-pc-windows-msvc.zip.sha256",
  "tool-x86_64-apple-darwin.tar.gz",
  "tool-aarch64-apple-darwin.tar.gz",
  "tool-x86_64-unknown-linux-gnu.tar.gz",
  "tool-x86_64-unknown-linux-musl.tar.gz",
  "tool-installer.sh",
  "tool-installer.ps1",
  "tool-x86_64-pc-windows-msvc.msi",
  "source.tar.gz",
]);

function pick(assets, repo, platform, arch) {
  return pickAsset(assets, { repo, platform, arch }).asset.name;
}

test("assets are chosen per platform from the naming schemes Roblox tools use", () => {
  assert.equal(pick(ROJO, "rojo", "win32", "x64"), "rojo-7.6.1-windows-x86_64.zip");
  assert.equal(pick(ROJO, "rojo", "win32", "arm64"), "rojo-7.6.1-windows-aarch64.zip");
  assert.equal(pick(ROJO, "rojo", "darwin", "arm64"), "rojo-7.6.1-macos-aarch64.zip");
  assert.equal(pick(ROJO, "rojo", "darwin", "x64"), "rojo-7.6.1-macos-x86_64.zip");
  assert.equal(pick(ROJO, "rojo", "linux", "arm64"), "rojo-7.6.1-linux-aarch64.zip");

  assert.equal(pick(WALLY, "wally", "win32", "x64"), "wally-v0.3.2-win64.zip");
  assert.equal(pick(WALLY, "wally", "darwin", "arm64"), "wally-v0.3.2-macos.zip");
  assert.equal(pick(LUAU_LSP, "luau-lsp", "win32", "x64"), "luau-lsp-win64.zip");
  assert.equal(pick(LUAU_LSP, "luau-lsp", "linux", "arm64"), "luau-lsp-linux-arm64.zip");
  assert.equal(pick(DARKLUA, "darklua", "linux", "x64"), "darklua-linux-x86_64.tar.gz");
  assert.equal(pick(DARKLUA, "darklua", "win32", "x64"), "darklua-windows-x86_64.zip");
});

test("a different program in the same release is not chosen (selene vs selene-light)", () => {
  assert.equal(pick(SELENE, "selene", "win32", "x64"), "selene-0.30.1-windows.zip");
  assert.equal(pick(SELENE, "selene", "linux", "x64"), "selene-0.30.1-linux.zip");
  assert.equal(pick(SELENE, "selene", "darwin", "arm64"), "selene-0.30.1-macos.zip");
});

test("linux prefers a static musl build; windows prefers msvc", () => {
  assert.equal(pick(STYLUA, "StyLua", "linux", "x64"), "stylua-linux-x86_64-musl.zip");
  assert.equal(pick(STYLUA, "StyLua", "linux", "arm64"), "stylua-linux-aarch64-musl.zip");
  assert.equal(pick(CARGO_DIST, "tool", "linux", "x64"), "tool-x86_64-unknown-linux-musl.tar.gz");
  assert.equal(pick(CARGO_DIST, "tool", "win32", "x64"), "tool-x86_64-pc-windows-msvc.zip");
});

test("Windows on Arm and Apple silicon fall back to x64 builds when there is no native one", () => {
  assert.equal(pick(STYLUA, "StyLua", "win32", "arm64"), "stylua-windows-x86_64.zip");
  assert.equal(pick(STYLUA, "StyLua", "darwin", "arm64"), "stylua-macos-aarch64.zip");
  assert.equal(pick(CARGO_DIST.filter((asset) => !/aarch64/.test(asset.name)), "tool", "darwin", "arm64"), "tool-x86_64-apple-darwin.tar.gz");
  assert.throws(() => pick(STYLUA.filter((asset) => !/aarch64/.test(asset.name)), "StyLua", "linux", "arm64"), /no release asset for linux\/arm64/);
});

test("checksums, installers, docs and other formats are never picked, and 32-bit is a last resort", () => {
  assert.equal(
    pick(names(["tool-1.0-windows-x64.zip.sha256", "tool-1.0-windows-x64.zip", "tool-1.0-windows-x64.msi", "tool-1.0-windows-x64.txt"]), "tool", "win32", "x64"),
    "tool-1.0-windows-x64.zip"
  );
  assert.equal(pick(names(["tool-win32.zip", "tool-win64.zip"]), "tool", "win32", "x64"), "tool-win64.zip");
  assert.equal(pick(names(["tool-win32.zip"]), "tool", "win32", "x64"), "tool-win32.zip");
  assert.throws(() => pick(names(["tool-windows.7z", "tool-windows.tar.zst", "tool-windows.bz2"]), "tool", "win32", "x64"), /no release asset/);
  assert.throws(() => pick([], "tool", "win32", "x64"), /the release has no assets/);
});

test("Go-style names (amd64, 386, arm) and bare .exe files pick the 64-bit build", () => {
  const shfmt = names([
    "shfmt_v3.14.1_darwin_amd64",
    "shfmt_v3.14.1_darwin_arm64",
    "shfmt_v3.14.1_linux_386",
    "shfmt_v3.14.1_linux_amd64",
    "shfmt_v3.14.1_linux_arm",
    "shfmt_v3.14.1_linux_arm64",
    "shfmt_v3.14.1_windows_386.exe",
    "shfmt_v3.14.1_windows_amd64.exe",
  ]);
  assert.equal(pick(shfmt, "sh", "win32", "x64"), "shfmt_v3.14.1_windows_amd64.exe");
  assert.equal(pick(shfmt, "sh", "win32", "arm64"), "shfmt_v3.14.1_windows_amd64.exe");
  assert.equal(pick(shfmt, "sh", "linux", "x64"), "shfmt_v3.14.1_linux_amd64");
  assert.equal(pick(shfmt, "sh", "linux", "arm64"), "shfmt_v3.14.1_linux_arm64");
  assert.equal(pick(shfmt, "sh", "darwin", "arm64"), "shfmt_v3.14.1_darwin_arm64");
});

test("a bare executable asset is accepted", () => {
  assert.equal(pick(names(["tool-linux-x86_64", "tool-windows-x86_64.exe"]), "tool", "linux", "x64"), "tool-linux-x86_64");
  assert.equal(pick(names(["tool-linux-x86_64", "tool-windows-x86_64.exe"]), "tool", "win32", "x64"), "tool-windows-x86_64.exe");
});

test("an unsupported platform is reported", () => {
  assert.throws(() => pickAsset(ROJO, { repo: "rojo", platform: "freebsd", arch: "x64" }), /can't install tools on freebsd/);
});

// --- extracting the executable ---------------------------------------------------------------

function zipOf(files) {
  const zip = new AdmZip();
  for (const [name, content] of Object.entries(files)) {
    zip.addFile(name, Buffer.from(content));
  }
  return zip.toBuffer();
}

async function tarGzOf(files, mode = 0o755) {
  const dir = tempDir();
  for (const [name, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, name)), { recursive: true });
    fs.writeFileSync(path.join(dir, name), content, { mode });
  }

  const archive = path.join(tempDir(), "a.tar.gz");
  await tar.c({ gzip: true, file: archive, cwd: dir }, Object.keys(files).map((name) => name.split("/")[0]).filter((name, index, all) => all.indexOf(name) === index));
  return fs.readFileSync(archive);
}

test("the executable is found by name inside a zip, wherever it sits", async () => {
  const buffer = zipOf({ "README.md": "docs", "LICENSE": "mit", "rojo-7.6.1/bin/rojo.exe": "BINARY", "rojo-7.6.1/extra.dll": "other" });
  assert.equal((await extractExecutable(buffer, "rojo-7.6.1-windows-x86_64.zip", ["rojo"])).toString(), "BINARY");
});

test("a tool whose file isn't named like the repository is found by alias, or as the only file", async () => {
  const two = zipOf({ "tool.exe": "TOOL", "helper.exe": "HELPER" });
  assert.equal((await extractExecutable(two, "x.zip", ["repo", "helper"])).toString(), "HELPER");
  assert.equal((await extractExecutable(zipOf({ "weird-name.exe": "ONLY", "NOTICE.txt": "n" }), "x.zip", ["repo"])).toString(), "ONLY");
  await assert.rejects(extractExecutable(two, "x.zip", ["repo"]), /Couldn't tell which file in x\.zip is "repo" \(it holds: .*tool\.exe/);
});

test("tar.gz, plain gz and bare executables are supported", async () => {
  const targz = await tarGzOf({ "darklua-1.0/darklua": "ELF", "darklua-1.0/README.md": "docs" });
  assert.equal((await extractExecutable(targz, "darklua-linux-x86_64.tar.gz", ["darklua"])).toString(), "ELF");

  const alsoTgz = await tarGzOf({ "bin/other": "A", "bin/tool": "B" });
  assert.equal((await extractExecutable(alsoTgz, "tool.tgz", ["tool"])).toString(), "B");

  assert.equal((await extractExecutable(zlib.gzipSync(Buffer.from("RAW")), "tool-linux.gz", ["tool"])).toString(), "RAW");
  assert.equal((await extractExecutable(Buffer.from("BARE"), "tool-linux-x86_64", ["tool"])).toString(), "BARE");
});

test("tar.xz is the last choice, but it is chosen when it is all there is", () => {
  const assets = names(["tool-linux-x86_64.tar.xz", "tool-linux-x86_64.tar.gz"]);
  assert.equal(pick(assets, "tool", "linux", "x64"), "tool-linux-x86_64.tar.gz");
  assert.equal(pick([assets[0]], "tool", "linux", "x64"), "tool-linux-x86_64.tar.xz");
});

test("tar.xz files are opened with the system's tar", async (t) => {
  const source = tempDir();
  fs.mkdirSync(path.join(source, "tool-1.0"));
  fs.writeFileSync(path.join(source, "tool-1.0", "tool"), "XZ-BINARY", { mode: 0o755 });
  fs.writeFileSync(path.join(source, "tool-1.0", "README.md"), "docs");

  const made = require("child_process").spawnSync(tarProgram(), ["-cJf", "tool.tar.xz", "tool-1.0"], { cwd: source, encoding: "utf8" });
  if (made.error || made.status !== 0) {
    t.skip("this machine's tar can't write xz");
    return;
  }

  const archive = fs.readFileSync(path.join(source, "tool.tar.xz"));
  assert.equal((await extractExecutable(archive, "tool-linux-x86_64.tar.xz", ["tool"])).toString(), "XZ-BINARY");
  await assert.rejects(extractExecutable(Buffer.from("not an archive"), "tool.tar.xz", ["tool"]), /Couldn't open a \.tar\.xz file/);
});

test("a file that unpacks past the size limit is refused instead of filling memory", async () => {
  const limit = { maxBytes: 1024 * 1024 };
  const big = Buffer.alloc(3 * 1024 * 1024);

  await assert.rejects(extractExecutable(zlib.gzipSync(big), "tool-linux.gz", ["tool"], limit), /expands to more than 1 MB/);
  await assert.rejects(extractExecutable(zipOf({ "tool.exe": big }), "tool.zip", ["tool"], limit), /Couldn't tell which file/);
  await assert.rejects(extractExecutable(await tarGzOf({ tool: big }), "tool.tar.gz", ["tool"], limit), /Couldn't tell which file/);

  // Under the limit it still works.
  assert.equal((await extractExecutable(zipOf({ "tool.exe": "small" }), "tool.zip", ["tool"], limit)).toString(), "small");
});

test("unsupported or empty archives are reported", async () => {
  await assert.rejects(extractExecutable(Buffer.from("x"), "tool-linux.7z", ["tool"]), /can't open/);
  await assert.rejects(extractExecutable(zipOf({ "tool.exe": "" }), "tool.zip", ["tool"]), /is empty/);
  await assert.rejects(extractExecutable(zipOf({ "README.md": "docs" }), "tool.zip", ["tool"]), /Couldn't tell which file/);
});

test("chooseEntry prefers the entry nearest the top and ignores docs", () => {
  const entry = (entryPath, executable = false) => ({ path: entryPath, executable, read: () => Buffer.from(entryPath) });
  const chosen = chooseEntry([entry("a/b/c/tool.exe"), entry("tool.exe"), entry("docs/tool.md")], ["tool"]);
  assert.equal(chosen.path, "tool.exe");
  assert.equal(chooseEntry([entry("__MACOSX/tool"), entry("LICENSE-MIT")], ["tool"]), null);
});

// --- sof.tools.lock --------------------------------------------------------------------------

test("sof.tools.lock round-trips and keeps only what the config still lists", () => {
  const dir = tempDir();
  const lockPath = path.join(dir, "sof.tools.lock");
  const spec = parseToolSpecifier("rojo-rbx/rojo@7.6.1");
  const old = parseToolSpecifier("rojo-rbx/rojo@7.4.1");
  const platform = currentPlatform();

  const entries = [
    { name: "rojo-rbx/rojo", version: "7.4.1", platform, asset: "old.zip", sha256: "a".repeat(64) },
    { name: "rojo-rbx/rojo", version: "7.6.1", platform: "other-os", asset: "o.zip", sha256: "b".repeat(64) },
  ];
  writeToolsLock(lockPath, entries);
  const lock = readToolsLock(lockPath);
  assert.equal(lock.exists, true);
  assert.equal(findLockEntry(lock, old).asset, "old.zip");
  assert.equal(findLockEntry(lock, spec), null, "another platform's line doesn't count");

  const merged = mergeLockEntries(lock.entries, [{ spec, record: { asset: "new.zip", sha256: "c".repeat(64) } }], [spec]);
  assert.deepEqual(
    merged.map((entry) => [entry.version, entry.platform, entry.asset]).sort(),
    [["7.6.1", "other-os", "o.zip"], ["7.6.1", platform, "new.zip"]].sort()
  );

  const before = fs.statSync(lockPath).mtimeMs;
  const past = new Date(before - 60_000);
  fs.utimesSync(lockPath, past, past);
  writeToolsLock(lockPath, entries);
  assert.equal(fs.statSync(lockPath).mtimeMs, past.getTime(), "an unchanged lock isn't rewritten");
});

test("a malformed sof.tools.lock is reported", () => {
  const dir = tempDir();
  const lockPath = path.join(dir, "sof.tools.lock");
  fs.writeFileSync(lockPath, '[[tool]]\nname = "a/b"\n');
  assert.throws(() => readToolsLock(lockPath), /"version" must be a non-empty string/);
  fs.writeFileSync(lockPath, "not toml [");
  assert.throws(() => readToolsLock(lockPath), /Failed to parse/);
  assert.deepEqual(readToolsLock(path.join(dir, "missing.lock")), { exists: false, entries: [] });
});

// --- which version applies here --------------------------------------------------------------

test("the nearest sof.toml that lists a tool decides, then the folders above, then global tools", () => {
  const root = tempDir();
  const home = tempDir();
  const project = path.join(root, "game");
  const nested = path.join(project, "packages", "ui");
  fs.mkdirSync(nested, { recursive: true });

  fs.writeFileSync(path.join(root, "sof.toml"), '[tools]\nrojo = "rojo-rbx/rojo@7.0.0"\nselene = "Kampfkarren/selene@0.30.1"\n');
  fs.writeFileSync(path.join(project, "sof.toml"), '[tools]\nRojo = "rojo-rbx/rojo@7.6.1"\n');
  fs.writeFileSync(path.join(nested, "sof.toml"), '[[dependencies]]\npath = "Packages"\n');
  fs.writeFileSync(path.join(home, "tools.toml"), '[tools]\nstylua = "JohnnyMorganz/StyLua@2.0.2"\n');

  withEnv({ SOF_HOME: home }, () => {
    const rojo = findToolEntry("rojo", nested);
    assert.equal(rojo.specifier, "rojo-rbx/rojo@7.6.1", "the project's pin beats the one above it");
    assert.equal(rojo.global, false);

    assert.equal(findToolEntry("selene", nested).specifier, "Kampfkarren/selene@0.30.1", "falls through to a parent");
    assert.equal(findToolEntry("SELENE", nested).alias, "selene", "case-insensitive");

    const stylua = findToolEntry("stylua", nested);
    assert.equal(stylua.specifier, "JohnnyMorganz/StyLua@2.0.2");
    assert.equal(stylua.global, true);

    assert.equal(findToolEntry("wally", nested), null);
  });
});

test("a broken line for one tool doesn't stop another tool from resolving", () => {
  const dir = tempDir();
  fs.writeFileSync(path.join(dir, "sof.toml"), '[tools]\nrojo = "rojo-rbx/rojo@7.6.1"\nbroken = 12\n');
  withEnv({ SOF_HOME: tempDir() }, () => {
    assert.equal(findToolEntry("rojo", dir).specifier, "rojo-rbx/rojo@7.6.1");
  });
});
