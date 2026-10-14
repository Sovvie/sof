"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const childProcess = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

const { planCopy, runCopy } = require("../src/commands/copy");

function write(root, rel, text = "x") {
  const file = path.join(root, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
}

function makeProject() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "sof-copy-"));
  childProcess.execFileSync("git", ["init", "-q"], { cwd: root });
  write(root, ".gitignore", "secret.txt\nbuild/\n");
  write(
    root,
    "sof.toml",
    [
      "[[dependencies]]",
      'path = "Packages"',
      'Signal = "scope/signal@^1.0.0"',
      "",
      "[table-sync]",
      "[[table-sync.targets]]",
      'output = "src/Data/Weapons.luau"',
      "[[table-sync.targets]]",
      'output = "../outside.luau"',
    ].join("\n")
  );
  write(root, "src/Main.luau");
  write(root, "src/Data/Weapons.luau");
  write(root, "src/Data/Hand.luau");
  write(root, "Packages/Signal/init.luau");
  write(root, "Packages/Mine.luau");
  write(root, "secret.txt");
  write(root, "build/out.rbxl");
  return root;
}

const addons = [{ name: "table-sync", generated: ["table-sync.targets.output"], generatedPaths: ["gen/**"] }];

test("skips gitignored, installed packages and what add-ons declare generated", () => {
  const root = makeProject();
  write(root, "gen/a.txt");
  const plan = planCopy(root, { addons });
  assert.deepEqual(plan.files.filter((f) => f.startsWith("src/") || f.startsWith("Packages/")).sort(), [
    "Packages/Mine.luau",
    "src/Data/Hand.luau",
    "src/Main.luau",
  ]);
  assert.ok(plan.files.includes("sof.toml"));
  assert.ok(plan.skipped.git.includes("secret.txt"));
  assert.ok(plan.skipped.git.includes("build/out.rbxl"));
  const generated = plan.skipped.generated.map((entry) => entry.file);
  assert.ok(generated.includes("src/Data/Weapons.luau"));
  assert.ok(generated.includes("gen/a.txt"));
  assert.ok(generated.includes("Packages/Signal/init.luau"));
  assert.ok(!plan.files.some((f) => f.startsWith(".git/")));
});

test("copies the planned files and refuses a non-empty destination", async () => {
  const root = makeProject();
  const destination = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "sof-copy-dest-")), "out");
  const log = console.log;
  console.log = () => {};
  try {
    await runCopy([root, destination]);
  } finally {
    console.log = log;
  }
  assert.ok(fs.existsSync(path.join(destination, "src/Main.luau")));
  assert.ok(!fs.existsSync(path.join(destination, "secret.txt")));
  assert.ok(!fs.existsSync(path.join(destination, "Packages/Signal")));
  assert.ok(!fs.existsSync(path.join(destination, ".git")));
  await assert.rejects(runCopy([root, destination]), /not empty/);
  await assert.rejects(runCopy([root, path.join(root, "inner")]), /inside/);
});

test("works outside git: applies .gitignore files directly, copies single files, --all keeps everything", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "sof-copy-plain-"));
  write(root, ".gitignore", "*.log\n/dist/\n!keep.log\n");
  write(root, "a.txt");
  write(root, "debug.log");
  write(root, "keep.log");
  write(root, "dist/x.js");
  write(root, "sub/dist/y.js");
  write(root, "sub/.gitignore", "local.txt\n");
  write(root, "sub/local.txt");
  write(root, "sub/ok.txt");
  const plan = planCopy(root, { addons: [], useGit: false });
  assert.deepEqual(plan.files.filter((f) => f !== ".gitignore" && f !== "sub/.gitignore"), [
    "a.txt",
    "keep.log",
    "sub/dist/y.js",
    "sub/ok.txt",
  ]);
  assert.ok(planCopy(root, { addons: [], all: true }).files.includes("dist/x.js"));

  const out = fs.mkdtempSync(path.join(os.tmpdir(), "sof-copy-file-"));
  const log = console.log;
  console.log = () => {};
  try {
    await runCopy([path.join(root, "a.txt"), out]);
  } finally {
    console.log = log;
  }
  assert.ok(fs.existsSync(path.join(out, "a.txt")));
});
