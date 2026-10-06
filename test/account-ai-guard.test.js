"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const home = fs.mkdtempSync(path.join(os.tmpdir(), "sofaihome-"));
process.env.SOF_AI_HOME = home;
process.env.SOF_HOME = path.join(home, ".sof");
delete process.env.SOF_AI_GUARD;

const guard = require("../src/account/ai-guard");

const claudeFile = path.join(home, ".claude", "settings.json");
const cursorFile = path.join(home, ".cursor", "cli-config.json");
const readJson = (file) => JSON.parse(fs.readFileSync(file, "utf8"));

test.beforeEach(() => {
  fs.rmSync(path.join(home, ".claude"), { recursive: true, force: true });
  fs.rmSync(path.join(home, ".cursor"), { recursive: true, force: true });
  fs.rmSync(path.join(home, ".sof"), { recursive: true, force: true });
  delete process.env.SOF_AI_GUARD;
});

const byTool = (results, name) => results.find((r) => r.tool === name);

test("Claude Code: adds Read and Edit deny rules for ~/.sof, keeps everything else", () => {
  fs.mkdirSync(path.dirname(claudeFile), { recursive: true });
  fs.writeFileSync(
    claudeFile,
    JSON.stringify({ env: { A: "1" }, permissions: { allow: ["Bash(ls)"], deny: ["Read(.env)"] }, theme: "dark" }, null, 4) + "\n"
  );
  const results = guard.applyGuard();
  assert.equal(byTool(results, "Claude Code").status, "added");
  const settings = readJson(claudeFile);
  assert.deepEqual(settings.permissions.deny, ["Read(.env)", "Read(~/.sof/**)", "Edit(~/.sof/**)"]);
  assert.deepEqual(settings.permissions.allow, ["Bash(ls)"]);
  assert.deepEqual(settings.env, { A: "1" });
  assert.equal(settings.theme, "dark");
  assert.match(fs.readFileSync(claudeFile, "utf8"), /^ {4}"env"/m, "the file's indentation is kept");
  assert.ok(fs.readFileSync(claudeFile, "utf8").endsWith("\n"));
});

test("running it again changes nothing", () => {
  fs.mkdirSync(path.dirname(claudeFile), { recursive: true });
  fs.writeFileSync(claudeFile, "{}\n");
  guard.applyGuard();
  const first = fs.readFileSync(claudeFile, "utf8");
  const again = guard.applyGuard();
  assert.equal(byTool(again, "Claude Code").status, "already");
  assert.equal(fs.readFileSync(claudeFile, "utf8"), first);
});

test("a tool that is not installed is left alone, and no folder is created", () => {
  const results = guard.applyGuard();
  assert.ok(results.every((r) => r.status === "absent"));
  assert.ok(!fs.existsSync(path.join(home, ".claude")));
  assert.ok(!fs.existsSync(path.join(home, ".cursor")));
});

test("Claude Code with a folder but no settings file gets one; Cursor's file is never invented", () => {
  fs.mkdirSync(path.join(home, ".claude"), { recursive: true });
  fs.mkdirSync(path.join(home, ".cursor"), { recursive: true });
  const results = guard.applyGuard();
  assert.equal(byTool(results, "Claude Code").status, "added");
  assert.deepEqual(readJson(claudeFile).permissions.deny, ["Read(~/.sof/**)", "Edit(~/.sof/**)"]);
  assert.equal(byTool(results, "Cursor CLI").status, "absent");
  assert.ok(!fs.existsSync(cursorFile));
});

test("Cursor CLI: an existing config gets Read and Write rules with an absolute path", () => {
  fs.mkdirSync(path.dirname(cursorFile), { recursive: true });
  fs.writeFileSync(cursorFile, JSON.stringify({ version: 1, permissions: { allow: ["Shell(ls)"], deny: [] } }, null, 2));
  const results = guard.applyGuard();
  assert.equal(byTool(results, "Cursor CLI").status, "added");
  const glob = `${path.join(home, ".sof").split(path.sep).join("/")}/**`;
  const config = readJson(cursorFile);
  assert.deepEqual(config.permissions.deny, [`Read(${glob})`, `Write(${glob})`]);
  assert.deepEqual(config.permissions.allow, ["Shell(ls)"]);
  assert.equal(config.version, 1);
});

test("a settings file that is not plain JSON, or has an odd shape, is never touched", () => {
  fs.mkdirSync(path.dirname(claudeFile), { recursive: true });
  for (const text of ["{ // comment\n}", "[1,2]", JSON.stringify({ permissions: "nope" }), JSON.stringify({ permissions: { deny: "x" } })]) {
    fs.writeFileSync(claudeFile, text);
    const result = byTool(guard.applyGuard(), "Claude Code");
    assert.equal(result.status, "skipped", text);
    assert.equal(fs.readFileSync(claudeFile, "utf8"), text, "untouched");
  }
});

test("SOF_AI_GUARD=off and the saved opt-out both stop it", () => {
  fs.mkdirSync(path.dirname(claudeFile), { recursive: true });
  fs.writeFileSync(claudeFile, "{}\n");
  process.env.SOF_AI_GUARD = "off";
  assert.equal(guard.applyGuard(), null);
  delete process.env.SOF_AI_GUARD;
  guard.setEnabled(false);
  assert.equal(guard.applyGuard(), null);
  assert.equal(fs.readFileSync(claudeFile, "utf8"), "{}\n");
  guard.setEnabled(true);
  assert.equal(byTool(guard.applyGuard(), "Claude Code").status, "added");
});

test("--off removes only sof's rules", () => {
  fs.mkdirSync(path.dirname(claudeFile), { recursive: true });
  fs.writeFileSync(claudeFile, JSON.stringify({ permissions: { deny: ["Read(.env)"] } }));
  guard.applyGuard();
  const removed = byTool(guard.removeGuard(), "Claude Code");
  assert.equal(removed.status, "removed");
  assert.deepEqual(readJson(claudeFile).permissions.deny, ["Read(.env)"]);
  assert.equal(byTool(guard.removeGuard(), "Claude Code").status, "absent");
});

test("status reports what is and is not protected", () => {
  fs.mkdirSync(path.dirname(claudeFile), { recursive: true });
  fs.writeFileSync(claudeFile, "{}\n");
  assert.equal(byTool(guard.statusGuard(), "Claude Code").status, "missing");
  guard.applyGuard();
  assert.equal(byTool(guard.statusGuard(), "Claude Code").status, "already");
});

test("a sof folder outside the home folder is reported, not guessed at", () => {
  const saved = process.env.SOF_HOME;
  process.env.SOF_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "elsewhere-"));
  try {
    fs.mkdirSync(path.dirname(claudeFile), { recursive: true });
    fs.writeFileSync(claudeFile, "{}\n");
    assert.equal(byTool(guard.applyGuard(), "Claude Code").status, "skipped");
    assert.equal(fs.readFileSync(claudeFile, "utf8"), "{}\n");
  } finally {
    fs.rmSync(process.env.SOF_HOME, { recursive: true, force: true });
    process.env.SOF_HOME = saved;
  }
});
