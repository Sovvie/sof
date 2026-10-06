"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const { findImportSource, readForeignTools } = require("../src/tools/import");

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "sof-import-test-"));
}

test("rokit.toml and aftman.toml tools are read as they are", () => {
  const dir = tempDir();
  const file = path.join(dir, "rokit.toml");
  fs.writeFileSync(
    file,
    '# managed by Rokit\n[tools]\nrojo = "rojo-rbx/rojo@7.6.1"\nstylua = "github:JohnnyMorganz/StyLua@v2.0.2"\n"wally" = "UpliftGames/wally@0.3.2"\n'
  );

  assert.deepEqual(readForeignTools(file), {
    tools: {
      rojo: "rojo-rbx/rojo@7.6.1",
      stylua: "JohnnyMorganz/StyLua@2.0.2",
      wally: "UpliftGames/wally@0.3.2",
    },
    skipped: [],
  });
});

test("foreman.toml tables become owner/repo@version; ranges and other hosts are skipped with a reason", () => {
  const dir = tempDir();
  const file = path.join(dir, "foreman.toml");
  fs.writeFileSync(
    file,
    [
      "[tools]",
      'rojo = { github = "rojo-rbx/rojo", version = "=7.4.1" }',
      'remodel = { source = "rojo-rbx/remodel", version = "0.11.0" }',
      'tarmac = { github = "rojo-rbx/tarmac", version = "^0.7" }',
      'darklua = { gitlab = "seaofvoices/darklua", version = "0.7.0" }',
      'noversion = { github = "a/b" }',
      'weird = 5',
      '"bad alias" = "a/b@1.0.0"',
      'selene = "Kampfkarren/selene@0.30.1"',
      "",
    ].join("\n")
  );

  const { tools, skipped } = readForeignTools(file);
  assert.deepEqual(tools, {
    rojo: "rojo-rbx/rojo@7.4.1",
    remodel: "rojo-rbx/remodel@0.11.0",
    selene: "Kampfkarren/selene@0.30.1",
  });

  const reasons = Object.fromEntries(skipped.map((entry) => [entry.alias, entry.reason]));
  assert.match(reasons.tarmac, /version range "\^0\.7"/);
  assert.match(reasons.darklua, /GitLab/);
  assert.match(reasons.noversion, /no version/);
  assert.match(reasons.weird, /string or a table/);
  assert.match(reasons["bad alias"], /may only contain letters, numbers/);
  assert.equal(Object.keys(reasons).length, 5, JSON.stringify(reasons));
});

test("a file with no [tools] has nothing to import, and a broken one is reported", () => {
  const dir = tempDir();
  const file = path.join(dir, "aftman.toml");
  fs.writeFileSync(file, "[other]\nx = 1\n");
  assert.deepEqual(readForeignTools(file), { tools: {}, skipped: [] });

  fs.writeFileSync(file, "tools = 3\n");
  assert.throws(() => readForeignTools(file), /must be a TOML table/);
  fs.writeFileSync(file, "not toml [");
  assert.throws(() => readForeignTools(file), /Failed to read/);
});

test("the source file is found in the folder: rokit first, then aftman, then foreman", () => {
  const dir = tempDir();
  assert.equal(findImportSource(dir), null);

  fs.writeFileSync(path.join(dir, "foreman.toml"), "");
  assert.equal(path.basename(findImportSource(dir)), "foreman.toml");
  fs.writeFileSync(path.join(dir, "aftman.toml"), "");
  assert.equal(path.basename(findImportSource(dir)), "aftman.toml");
  fs.writeFileSync(path.join(dir, "rokit.toml"), "");
  assert.equal(path.basename(findImportSource(dir)), "rokit.toml");
});
