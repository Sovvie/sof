"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");
const zlib = require("zlib");
const tar = require("tar");

const { validateArchive, validatePackageMetadata, failWithProblems } = require("../src/packages/validate");

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "sof-validate-test-"));

// Raw tar.gz writer, so tests can build archives the OS can't (symlinks, "A" next to "a", ...).
// entry: { path, type = "File", body = "", linkpath }
function makeArchive(entries) {
  const blocks = [];
  for (const entry of entries) {
    const type = entry.type || "File";
    const body = Buffer.from(entry.body || "");
    const header = new tar.Header({
      path: entry.path,
      type,
      mode: 0o644,
      size: type === "File" ? body.length : 0,
      linkpath: entry.linkpath,
    });
    header.encode();
    blocks.push(header.block);
    if (type === "File" && body.length > 0) {
      blocks.push(body, Buffer.alloc((512 - (body.length % 512)) % 512));
    }
  }
  blocks.push(Buffer.alloc(1024));

  const file = path.join(scratch, `${crypto.randomBytes(6).toString("hex")}.tar.gz`);
  fs.writeFileSync(file, zlib.gzipSync(Buffer.concat(blocks)));
  return file;
}

function entryFor(name = "sovvie/pkg") {
  return {
    name,
    version: "1.0.0",
    realm: "shared",
    description: "",
    license: "",
    authors: [],
    dependencies: [],
  };
}

async function problemsFor(entries, name) {
  return validateArchive(makeArchive(entries), entryFor(name));
}

function assertOneProblem(problems, pattern) {
  assert.equal(problems.length, 1, problems.join("\n"));
  assert.match(problems[0], pattern);
}

test("an ordinary package passes", async () => {
  const problems = await problemsFor([
    { path: "Router", type: "Directory" },
    { path: "Router/init.luau", body: "return 1" },
    { path: "Router/Util/Helpers.lua", body: "return 2" },
    { path: "Router/data.json", body: "{}" },
    { path: "Router/config.toml", body: "" },
    { path: "Router/NOTES.TXT", body: "x" },
    { path: "Router/ci.yml", body: "x" },
    { path: "Router/ci.yaml", body: "x" },
    { path: "README.md", body: "x" },
    { path: "LICENSE", body: "MIT" },
    { path: "LICENCE", body: "MIT" },
    { path: "NOTICE", body: "x" },
    { path: "README", body: "x" },
    { path: "CHANGELOG", body: "x" },
    { path: "COPYING", body: "x" },
  ]);
  assert.deepEqual(problems, []);
});

test("a package built by sof's own packer passes", async () => {
  const stage = fs.mkdtempSync(path.join(scratch, "stage-"));
  fs.mkdirSync(path.join(stage, "Router"));
  fs.writeFileSync(path.join(stage, "Router", "init.luau"), "return 1");
  const file = path.join(scratch, "packed.tar.gz");
  await tar.c({ file, gzip: true, cwd: stage, portable: true }, ["Router"]);

  assert.deepEqual(await validateArchive(file, entryFor()), []);
});

test("symlinks and hardlinks are rejected", async () => {
  assertOneProblem(
    await problemsFor([{ path: "link.luau", type: "SymbolicLink", linkpath: "/etc/passwd" }]),
    /SymbolicLink/
  );
  assertOneProblem(
    await problemsFor([
      { path: "a.luau", body: "x" },
      { path: "b.luau", type: "Link", linkpath: "a.luau" },
    ]),
    /Link/
  );
});

test("only the allowed file types get in", async () => {
  for (const bad of ["model.rbxm", "image.png", ".gitignore", "LICENSE.bak", "Makefile", "script.js", "a.luau.exe"]) {
    assertOneProblem(await problemsFor([{ path: bad, body: "x" }]), /not an allowed file type/);
  }
});

test("add-ons in the sofaddon scope may also ship .js, .mjs and .cjs", async () => {
  const files = ["index.js", "esm.mjs", "common.cjs"].map((name) => ({ path: name, body: "x" }));
  assert.deepEqual(await problemsFor(files, "sofaddon/docs"), []);
  assert.equal((await problemsFor(files, "sovvie/docs")).length, 3);
  assertOneProblem(await problemsFor([{ path: "m.rbxm", body: "x" }], "sofaddon/docs"), /not an allowed file type/);
});

test(".git and node_modules are rejected anywhere in a path", async () => {
  assertOneProblem(await problemsFor([{ path: ".git", type: "Directory" }]), /\.git or node_modules/);
  assertOneProblem(await problemsFor([{ path: "src/node_modules/x/index.luau", body: "x" }]), /\.git or node_modules/);
  assertOneProblem(await problemsFor([{ path: "src/.GIT/config.json", body: "x" }]), /\.git or node_modules/);
});

test("path rules: backslashes, traversal, length, depth, NFC", async () => {
  if (process.platform !== "win32") {
    // node-tar turns "\" into "/" when it reads on Windows (and a Windows packer can't make
    // such names), so this is only observable elsewhere.
    assert.match((await problemsFor([{ path: "src\\a.luau", body: "x" }])).join("\n"), /backslash/);
  }
  assertOneProblem(await problemsFor([{ path: "../a.luau", body: "x" }]), /plain relative path/);
  assertOneProblem(await problemsFor([{ path: "/abs/a.luau", body: "x" }]), /plain relative path/);

  const tooDeep = `${Array.from({ length: 13 }, () => "d").join("/")}/a.luau`;
  assertOneProblem(await problemsFor([{ path: tooDeep, body: "x" }]), /deeper than 12/);
  const exactlyDeep = `${Array.from({ length: 11 }, () => "d").join("/")}/a.luau`;
  assert.deepEqual(await problemsFor([{ path: exactlyDeep, body: "x" }]), []);

  const tooLong = `${Array.from({ length: 12 }, () => "x".repeat(20)).join("/")}`.slice(0, 241) + ".luau";
  assertOneProblem(await problemsFor([{ path: `${tooLong}`, body: "x" }]), /longer than 240/);

  assertOneProblem(
    await problemsFor([{ path: "café.luau", body: "x" }]), // "e" + combining acute: not NFC
    /NFC/
  );
  assert.deepEqual(await problemsFor([{ path: "café.luau", body: "x" }]), []);
});

test("names that differ only by case, and Windows-reserved names, are rejected", async () => {
  assertOneProblem(
    await problemsFor([
      { path: "Util.luau", body: "x" },
      { path: "util.luau", body: "x" },
    ]),
    /differ only by case/
  );

  for (const reserved of ["CON.luau", "nul.txt", "src/COM1.md", "Lpt9", "aux/x.luau"]) {
    assert.match(
      (await problemsFor([{ path: reserved, body: "x" }])).join("\n"),
      /Windows-reserved/,
      reserved
    );
  }
  assert.deepEqual(await problemsFor([{ path: "console.luau", body: "x" }]), []);
});

test("size and count limits", async () => {
  const mb = 1024 * 1024;
  // Compressible, but not so much that tar's own decompression-bomb guard (1000:1) trips.
  const block = crypto.randomBytes(16 * 1024);
  const filler = (bytes) => Buffer.concat([...Array(Math.ceil(bytes / block.length))].map(() => block)).subarray(0, bytes);

  assertOneProblem(
    await problemsFor([{ path: "big.json", body: filler(4 * mb + 1) }]),
    /larger than 4 MB/
  );
  assert.deepEqual(await problemsFor([{ path: "ok.json", body: filler(4 * mb) }]), []);

  const expanded = Array.from({ length: 6 }, (_unused, index) => ({
    path: `f${index}.json`,
    body: filler(4 * mb),
  }));
  assertOneProblem(await problemsFor(expanded), /20 MB expanded/);

  const many = Array.from({ length: 1001 }, (_unused, index) => ({ path: `f${index}.txt`, body: "x" }));
  assertOneProblem(await problemsFor(many), /1001 entries/);
  assert.deepEqual(await problemsFor(many.slice(0, 1000)), []);

  const incompressible = [crypto.randomBytes(3.4 * mb), crypto.randomBytes(3.4 * mb)].map((body, index) => ({
    path: `r${index}.json`,
    body,
  }));
  assertOneProblem(await problemsFor(incompressible), /upload is larger than 6 MB/);
});

test("an unreadable archive is reported, not thrown", async () => {
  const file = path.join(scratch, "garbage.tar.gz");
  fs.writeFileSync(file, Buffer.from("this is not a tar.gz at all"));

  const problems = await validateArchive(file, entryFor());
  assert.equal(problems.length, 1);
  assert.match(problems[0], /could not be read/);
});

test("package metadata rules", () => {
  const good = {
    ...entryFor(),
    description: "d".repeat(1000),
    license: "l".repeat(100),
    authors: Array.from({ length: 20 }, () => "a".repeat(100)),
    dependencies: [{ alias: "_Butler9", name: "sovvie/butler", range: "^1.0.0", specifier: "sovvie/butler@^1.0.0" }],
  };
  assert.deepEqual(validatePackageMetadata(good), []);
  assert.deepEqual(validatePackageMetadata({ ...good, version: "1.0.0-rc.1" }), []);

  const cases = [
    [{ name: "Sovvie/pkg" }, /scope "Sovvie"/],
    [{ name: "-sovvie/pkg" }, /scope/],
    [{ name: `${"s".repeat(40)}/pkg` }, /scope/],
    [{ name: "sovvie/Pkg" }, /package name "Pkg"/],
    [{ name: "sovvie/_pkg" }, /package name/],
    [{ name: `sovvie/${"p".repeat(65)}` }, /package name/],
    [{ version: "1.0.0+build.5" }, /no \+build/],
    [{ version: "1.0" }, /version/],
    [{ version: "v1.0.0" }, /version/],
    [{ realm: "everywhere" }, /realm/],
    [{ realm: "addon" }, /only accepted in the "sofaddon" scope/],
    [{ description: "d".repeat(1001) }, /description/],
    [{ license: "l".repeat(101) }, /license/],
    [{ authors: Array.from({ length: 21 }, () => "a") }, /more than 20 authors/],
    [{ authors: ["a".repeat(101)] }, /author entry/],
    [{ dependencies: [{ alias: "1Bad", specifier: "x/y@1" }] }, /dependency alias "1Bad"/],
    [{ dependencies: [{ alias: "has-dash", specifier: "x/y@1" }] }, /dependency alias "has-dash"/],
    [{ dependencies: [{ alias: "a".repeat(65), specifier: "x/y@1" }] }, /dependency alias/],
  ];
  for (const [override, pattern] of cases) {
    assert.match(validatePackageMetadata({ ...good, ...override }).join("\n"), pattern, JSON.stringify(override).slice(0, 60));
  }

  assert.deepEqual(validatePackageMetadata({ ...entryFor("sofaddon/docs"), realm: "addon" }), []);
});

test("problems are listed under the package, capped at 20", () => {
  const problems = Array.from({ length: 25 }, (_unused, index) => `problem ${index}`);
  const error = failWithProblems("sovvie/pkg@1.0.0", problems);

  assert.match(error.message, /^sovvie\/pkg@1\.0\.0 would be rejected by the registry:/);
  assert.match(error.message, /- problem 19/);
  assert.doesNotMatch(error.message, /problem 20/);
  assert.match(error.message, /and 5 more/);
});
