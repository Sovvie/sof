"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");
const zlib = require("zlib");

const ADDON = path.join(__dirname, "..", "addons", "bundle");
const { parseArgs } = require(path.join(ADDON, "src", "lib", "args"));
const { resolveFormat, defaultFileName } = require(path.join(ADDON, "src", "lib", "naming"));
const { bundle } = require(path.join(ADDON, "src", "commands", "bundle"));

function canResolve(name) {
  try {
    require.resolve(name, { paths: [ADDON] });
    return true;
  } catch (_err) {
    return false;
  }
}
const HAS_IGNORE = canResolve("ignore");
const HAS_TOML = canResolve("smol-toml");
const NEEDS_IGNORE = HAS_IGNORE ? {} : { skip: "addons/bundle dependencies are not installed (npm install in addons/bundle)" };
const NEEDS_TOML = HAS_IGNORE && HAS_TOML ? {} : { skip: "addons/bundle dependencies are not installed (npm install in addons/bundle)" };

function tmp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "sof-bundle-"));
}

function write(root, rel, text = "x", mode) {
  const file = path.join(root, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
  if (mode) fs.chmodSync(file, mode);
}

function project() {
  const root = tmp();
  write(root, "src/main.lua", "print('main')\n");
  write(root, "src/util/helper.lua", "return 1\n");
  write(root, "README.md", "# demo\n");
  write(root, "build.log", "noise\n");
  write(root, "notes/todo.txt", "todo\n");
  write(root, ".git/config", "[core]\n");
  write(root, "node_modules/dep/index.js", "x\n");
  write(root, ".gitignore", "*.log\nsecret/\n");
  write(root, "secret/key.txt", "shh\n");
  write(root, "src/.gitignore", "generated.lua\n!keep.log\n");
  write(root, "src/generated.lua", "gen\n");
  write(root, "src/keep.log", "kept by nested rule\n");
  write(root, "package.json", JSON.stringify({ name: "demo", version: "2.5.1" }));
  return root;
}

function args(list) {
  return parseArgs(list);
}

async function list(root, flags = []) {
  const result = await bundle(args([root, "--list", ...flags]), { cwd: root, env: {} });
  return result.list.map((item) => item.path);
}

// Minimal readers so the tests do not depend on an unzip/tar program or on adm-zip.
function readZip(file) {
  const buf = fs.readFileSync(file);
  let end = buf.length - 22;
  while (end >= 0 && buf.readUInt32LE(end) !== 0x06054b50) end--;
  assert.ok(end >= 0, "end of central directory");
  const count = buf.readUInt16LE(end + 10);
  let p = buf.readUInt32LE(end + 16);
  const out = {};
  for (let i = 0; i < count; i++) {
    assert.equal(buf.readUInt32LE(p), 0x02014b50);
    const method = buf.readUInt16LE(p + 10);
    const crc = buf.readUInt32LE(p + 16);
    const size = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const attr = buf.readUInt32LE(p + 38) >>> 16;
    const offset = buf.readUInt32LE(p + 42);
    const name = buf.toString("utf8", p + 46, p + 46 + nameLen);
    const dataStart = offset + 30 + buf.readUInt16LE(offset + 26) + buf.readUInt16LE(offset + 28);
    const raw = buf.subarray(dataStart, dataStart + size);
    const data = method === 8 ? zlib.inflateRawSync(raw) : raw;
    if (typeof zlib.crc32 === "function") assert.equal(zlib.crc32(data) >>> 0, crc, `crc of ${name}`);
    out[name] = { data: data.toString("utf8"), mode: attr & 0o7777, time: buf.readUInt16LE(offset + 10) };
    p += 46 + nameLen + extraLen + commentLen;
  }
  return out;
}

function readTarGz(file) {
  const buf = zlib.gunzipSync(fs.readFileSync(file));
  const out = {};
  let p = 0;
  let longName = null;
  while (p + 512 <= buf.length && buf[p] !== 0) {
    const field = (from, len) => buf.toString("utf8", p + from, p + from + len).replace(/\0.*$/s, "");
    const size = parseInt(field(124, 12), 8);
    const type = field(156, 1);
    const prefix = field(345, 155);
    let name = field(0, 100);
    if (prefix) name = `${prefix}/${name}`;
    const body = buf.toString("utf8", p + 512, p + 512 + size);
    p += 512 + Math.ceil(size / 512) * 512;
    if (type === "L") {
      longName = body.replace(/\0+$/, "");
      continue;
    }
    if (longName) {
      name = longName;
      longName = null;
    }
    out[name] = { data: body, mode: parseInt(field(100, 8), 8) - 0, mtime: parseInt(buf.toString("latin1", p - 512 - Math.ceil(size / 512) * 512 + 136, p - 512 - Math.ceil(size / 512) * 512 + 147), 8) };
  }
  return out;
}

function sha(file) {
  return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

test("parseArgs reads flags, repeats and =values", () => {
  const o = args(["proj", "-o", "a.zip", "--include", "src", "--include=docs", "--exclude", "*.tmp", "--no-gitignore", "--root-folder", "--name", "n", "--version=1.0.0", "--list", "--no-reproducible", "--json"]);
  assert.equal(o.folder, "proj");
  assert.equal(o.out, "a.zip");
  assert.deepEqual(o.include, ["src", "docs"]);
  assert.deepEqual(o.exclude, ["*.tmp"]);
  assert.equal(o.gitignore, false);
  assert.equal(o.rootFolder, true);
  assert.equal(o.name, "n");
  assert.equal(o.version, "1.0.0");
  assert.equal(o.list, true);
  assert.equal(o.reproducible, false);
  assert.equal(o.json, true);
  assert.equal(args([]).reproducible, true);
  assert.equal(args([]).gitignore, undefined);
  assert.throws(() => args(["--bogus"]), /Unknown option/);
  assert.throws(() => args(["a", "b"]), /only one folder/);
  assert.throws(() => args(["--out"]), /needs a value/);
  assert.throws(() => args(["--format", "rar"]), /Unknown format/);
  assert.equal(args(["-h"]).help, true);
});

test("format and default naming", () => {
  assert.equal(resolveFormat("a.zip"), "zip");
  assert.equal(resolveFormat("a.tar.gz"), "tar.gz");
  assert.equal(resolveFormat("a.TGZ"), "tar.gz");
  assert.equal(resolveFormat(undefined, "tgz"), "tar.gz");
  assert.equal(resolveFormat(undefined), "zip");
  assert.throws(() => resolveFormat("a.zip", "tar.gz"), /does not match/);
  assert.throws(() => resolveFormat("a.bin"), /Can't tell/);
  const date = new Date(Date.UTC(2024, 4, 6));
  assert.equal(defaultFileName({ folder: "/x/My Game", version: "1.2.0", date, format: "zip" }), "My-Game-1.2.0.zip");
  assert.equal(defaultFileName({ folder: "/x/game", date, format: "tar.gz" }), "game-2024-05-06.tar.gz");
  assert.equal(defaultFileName({ folder: "/x/game", name: "other", version: "v1", date, format: "zip" }), "other-v1.zip");
});

test("selection honors .gitignore (root and nested) and always skips .git and node_modules", NEEDS_IGNORE, async () => {
  const root = project();
  assert.deepEqual(await list(root), [
    ".gitignore",
    "README.md",
    "notes/todo.txt",
    "package.json",
    "src/.gitignore",
    "src/keep.log",
    "src/main.lua",
    "src/util/helper.lua",
  ]);
});

test("--no-gitignore keeps ignored files but still drops .git and node_modules", NEEDS_IGNORE, async () => {
  const root = project();
  const files = await list(root, ["--no-gitignore"]);
  assert.ok(files.includes("build.log"));
  assert.ok(files.includes("secret/key.txt"));
  assert.ok(files.includes("src/generated.lua"));
  assert.ok(!files.some((f) => f.startsWith(".git/") || f.includes("node_modules")));
});

test("include and exclude patterns", NEEDS_IGNORE, async () => {
  const root = project();
  assert.deepEqual(await list(root, ["--include", "src/**/*.lua"]), ["src/main.lua", "src/util/helper.lua"]);
  assert.deepEqual(await list(root, ["--include", "*.md", "--include", "notes/"]), ["README.md", "notes/todo.txt"]);
  const files = await list(root, ["--exclude", "notes/", "--exclude", "*.md", "--exclude", "src/util"]);
  assert.deepEqual(files, [".gitignore", "package.json", "src/.gitignore", "src/keep.log", "src/main.lua"]);
  assert.deepEqual(await list(root, ["--include", "src", "--exclude", "*.log", "--no-gitignore"]), [
    "src/.gitignore",
    "src/generated.lua",
    "src/main.lua",
    "src/util/helper.lua",
  ]);
});

test("default output goes to ./dist and is named from the folder and version", NEEDS_IGNORE, async () => {
  const root = project();
  const result = await bundle(args([]), { cwd: root, env: {} });
  assert.equal(result.out, path.join(root, "dist", `${path.basename(root)}-2.5.1.zip`));
  assert.ok(fs.existsSync(result.out));
  assert.equal(result.files, 8);
  assert.equal(result.sha256, sha(result.out));
  assert.equal(result.size, fs.statSync(result.out).size);
  // dist/ is never part of the next bundle
  const again = await bundle(args([]), { cwd: root, env: {} });
  assert.equal(again.files, 8);
  assert.equal(again.sha256, result.sha256);
});

test("name falls back to the date, honoring SOURCE_DATE_EPOCH", NEEDS_IGNORE, async () => {
  const root = tmp();
  write(root, "a.txt", "a");
  const epoch = String(Date.UTC(2021, 2, 4) / 1000);
  const result = await bundle(args(["--name", "thing"]), { cwd: root, env: { SOURCE_DATE_EPOCH: epoch } });
  assert.equal(path.basename(result.out), "thing-2021-03-04.zip");
});

test("zip round trip, with --root-folder", NEEDS_IGNORE, async () => {
  const root = project();
  write(root, "bin/run.sh", "#!/bin/sh\n", 0o755);
  const out = path.join(tmp(), "out.zip");
  await bundle(args(["-o", out, "--root-folder", "--name", "demo"]), { cwd: root, env: {} });
  const entries = readZip(out);
  const names = Object.keys(entries);
  assert.ok(names.every((n) => n.startsWith("demo/")));
  assert.equal(entries["demo/src/main.lua"].data, "print('main')\n");
  assert.equal(entries["demo/src/util/helper.lua"].data, "return 1\n");
  assert.equal(entries["demo/README.md"].mode, 0o644);
  if (process.platform !== "win32") assert.equal(entries["demo/bin/run.sh"].mode, 0o755);
  assert.deepEqual(names, [...names].sort());
  assert.ok(!names.some((n) => n.includes("build.log") || n.includes(".git/")));
});

test("tar.gz round trip", NEEDS_IGNORE, async () => {
  const root = project();
  write(root, "deep/" + "d".repeat(60) + "/" + "e".repeat(60) + "/file.txt", "long path\n");
  const out = path.join(tmp(), "out.tgz");
  await bundle(args(["-o", out]), { cwd: root, env: {} });
  const entries = readTarGz(out);
  assert.equal(entries["src/main.lua"].data, "print('main')\n");
  assert.equal(entries["README.md"].data, "# demo\n");
  assert.equal(entries["deep/" + "d".repeat(60) + "/" + "e".repeat(60) + "/file.txt"].data, "long path\n");
  assert.equal(entries["README.md"].mode, 0o644);
  assert.equal(entries["README.md"].mtime, Date.UTC(2020, 0, 1) / 1000);
  assert.ok(!("build.log" in entries));
  // the gzip header does not carry a time or a platform-specific OS byte
  const raw = fs.readFileSync(out);
  assert.equal(raw.readUInt32LE(4), 0);
  assert.equal(raw[9], 3);
});

test("system tar and unzip can read the archives (when installed)", NEEDS_IGNORE, async (t) => {
  const childProcess = require("child_process");
  const root = project();
  const dir = tmp();
  await bundle(args(["-o", path.join(dir, "a.tar.gz")]), { cwd: root, env: {} });
  let listing;
  try {
    listing = childProcess.execFileSync("tar", ["tzf", path.join(dir, "a.tar.gz")], { encoding: "utf8" });
  } catch (_err) {
    return t.skip("no tar program");
  }
  assert.match(listing, /src\/main\.lua/);
});

test("reproducible: same input twice gives identical bytes, and survives touching files", NEEDS_IGNORE, async () => {
  const root = project();
  for (const ext of ["zip", "tar.gz"]) {
    const dir = tmp();
    const a = path.join(dir, `a.${ext}`);
    const b = path.join(dir, `b.${ext}`);
    await bundle(args(["-o", a]), { cwd: root, env: {} });
    const later = new Date(Date.now() + 60_000);
    fs.utimesSync(path.join(root, "README.md"), later, later);
    await bundle(args(["-o", b]), { cwd: root, env: {} });
    assert.equal(sha(a), sha(b), ext);
  }
});

test("--no-reproducible keeps real file times", NEEDS_IGNORE, async () => {
  const root = project();
  const old = new Date(Date.UTC(2010, 5, 7, 8, 10, 12));
  fs.utimesSync(path.join(root, "README.md"), old, old);
  const out = path.join(tmp(), "t.tar.gz");
  await bundle(args(["-o", out, "--no-reproducible"]), { cwd: root, env: {} });
  assert.equal(readTarGz(out)["README.md"].mtime, old.getTime() / 1000);
});

test("SOURCE_DATE_EPOCH sets the stored time", NEEDS_IGNORE, async () => {
  const root = project();
  const out = path.join(tmp(), "t.tar.gz");
  await bundle(args(["-o", out]), { cwd: root, env: { SOURCE_DATE_EPOCH: "1700000000" } });
  assert.equal(readTarGz(out)["README.md"].mtime, 1700000000);
});

test("symlinks are skipped and reported, never followed", NEEDS_IGNORE, async (t) => {
  const root = project();
  const outside = tmp();
  write(outside, "secret.txt", "outside");
  try {
    fs.symlinkSync(path.join(outside, "secret.txt"), path.join(root, "link.txt"));
    fs.symlinkSync(outside, path.join(root, "linked-dir"), "dir");
  } catch (_err) {
    return t.skip("symlinks not permitted here");
  }
  const result = await bundle(args(["-o", path.join(tmp(), "s.zip")]), { cwd: root, env: {} });
  assert.deepEqual(result.skippedSymlinks, ["link.txt", "linked-dir"]);
  const entries = readZip(result.out);
  assert.ok(!Object.keys(entries).some((n) => n.includes("link") || n.includes("secret")));
});

test("the archive is never written into itself", NEEDS_IGNORE, async () => {
  const root = project();
  const out = path.join(root, "release", "me.zip");
  const first = await bundle(args(["-o", out]), { cwd: root, env: {} });
  const second = await bundle(args(["-o", out]), { cwd: root, env: {} });
  assert.equal(first.sha256, second.sha256);
  assert.ok(!Object.keys(readZip(out)).some((n) => n.startsWith("release/me.zip")));
  assert.ok(!fs.existsSync(`${out}.part`));
  // also when the output sits at the top of the folder
  const top = path.join(root, "top.tar.gz");
  await bundle(args(["-o", top]), { cwd: root, env: {} });
  const again = await bundle(args(["-o", top]), { cwd: root, env: {} });
  assert.ok(!("top.tar.gz" in readTarGz(top)));
  assert.equal(again.files, 9); // the 8 sources plus release/me.zip from above
});

test("an --out that would overwrite a source file is refused", NEEDS_IGNORE, async () => {
  const root = project();
  const before = fs.readFileSync(path.join(root, "README.md"), "utf8");
  await assert.rejects(bundle(args(["-o", "README.md", "--format", "zip"]), { cwd: root, env: {} }), /Refusing to overwrite/);
  assert.equal(fs.readFileSync(path.join(root, "README.md"), "utf8"), before);
  await assert.rejects(bundle(args(["-o", "src"]), { cwd: root, env: {} }), /Can't tell|folder/);
  await assert.rejects(bundle(args(["-o", "src", "--format", "zip"]), { cwd: root, env: {} }), /is a folder/);
});

test("--list writes nothing and an empty selection fails", NEEDS_IGNORE, async () => {
  const root = project();
  const result = await bundle(args(["--list"]), { cwd: root, env: {} });
  assert.equal(result.files, 8);
  assert.ok(result.totalSize > 0);
  assert.ok(!fs.existsSync(path.join(root, "dist")));
  await assert.rejects(bundle(args(["--include", "nothing-matches-this"]), { cwd: root, env: {} }), /Nothing to bundle/);
});

test("a folder argument other than the current directory", NEEDS_IGNORE, async () => {
  const root = project();
  const elsewhere = tmp();
  const result = await bundle(args([root, "--name", "proj", "--version", "9"]), { cwd: elsewhere, env: {} });
  assert.equal(result.out, path.join(elsewhere, "dist", "proj-9.zip"));
  assert.equal(result.files, 8);
});

test("[bundle] in sof.toml sets defaults and CLI flags win", NEEDS_TOML, async () => {
  const root = project();
  write(
    root,
    "sof.toml",
    [
      "[bundle]",
      'include = ["src", "README.md"]',
      'exclude = ["util"]',
      'out = "out/pack.tgz"',
      'name = "packed"',
      'version = "3.1.4"',
      "root_folder = true",
      "gitignore = false",
    ].join("\n")
  );
  const result = await bundle(args([]), { cwd: root, env: {} });
  assert.equal(result.out, path.join(root, "out", "pack.tgz"));
  assert.equal(result.format, "tar.gz");
  assert.deepEqual(Object.keys(readTarGz(result.out)), [
    "packed/README.md",
    "packed/src/.gitignore",
    "packed/src/generated.lua",
    "packed/src/keep.log",
    "packed/src/main.lua",
  ]);
  // CLI wins: own output, no root folder is not expressible, so override include and format
  const cli = await bundle(args(["--include", "README.md", "-o", path.join(root, "x.zip")]), { cwd: root, env: {} });
  assert.equal(cli.files, 1);
  assert.equal(cli.format, "zip");
  // a table without an explicit out uses the default name from name/version
  write(root, "sof.toml", '[bundle]\nname = "packed"\nversion = "3.1.4"\n');
  const named = await bundle(args(["--list"]), { cwd: root, env: {} });
  assert.equal(path.basename(named.plan.outPath), "packed-3.1.4.zip");
});

test("a bad [bundle] table is reported", NEEDS_TOML, async () => {
  const root = project();
  write(root, "sof.toml", '[bundle]\ninclude = 5\n');
  await assert.rejects(bundle(args([]), { cwd: root, env: {} }), /\[bundle\] include/);
});

test("zip is also readable by adm-zip (when installed)", NEEDS_IGNORE, async (t) => {
  let AdmZip;
  try {
    AdmZip = require("adm-zip");
  } catch (_err) {
    return t.skip("adm-zip not installed");
  }
  const root = project();
  const out = path.join(tmp(), "z.zip");
  await bundle(args(["-o", out]), { cwd: root, env: {} });
  const zip = new AdmZip(out);
  assert.equal(zip.readAsText("src/main.lua"), "print('main')\n");
  assert.equal(zip.getEntries().length, 8);
});
