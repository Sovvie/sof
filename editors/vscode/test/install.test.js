"use strict";

// How sof.lock compares with sof.toml: has the last "sof run package install" caught up with
// what the file asks for now (a bumped range, a newly added dependency)?

const test = require("node:test");
const assert = require("node:assert/strict");
const { parseDependencies, analyze, installTagFor } = require("../src/model");
const { problemsFor } = require("../src/problems");
const { summarize } = require("../src/summary");

const HEAD = '[[dependencies]]\npath = "src/Packages"\n';

function data(versions) {
  return {
    source: "sof",
    name: "x/a",
    versions: versions.map((version) => ({ version, yanked: false, dependencies: {} })),
  };
}

const STATES = { "x/a": { status: "ok", data: data(["1.0.0", "2.0.0", "2.1.0"]) } };
const lock = (version) => [{ name: "x/a", alias: "A", version, path: "src/Packages" }];

function analyzeText(text, lockEntries, states = STATES) {
  return analyze(parseDependencies(text), { getState: (name) => states[name] || null, lockEntries });
}

const BUMPED = `${HEAD}A = "x/a@^2.1.0"\n`;

test("install state: ok, stale, missing, unknown and not applicable", () => {
  const stateOf = (lockEntries) => analyzeText(BUMPED, lockEntries)[0].install;

  assert.deepEqual(stateOf(lock("2.1.0")), { state: "ok", version: "2.1.0" });
  assert.deepEqual(stateOf(lock("2.0.0")), { state: "stale", version: "2.0.0" }, "the range was bumped, the lock was not");
  assert.deepEqual(stateOf([]), { state: "missing", version: null }, "a lockfile exists but does not list it");
  assert.deepEqual(stateOf(null), { state: "unknown", version: null }, "no sof.lock at all");

  const publish = analyze(parseDependencies('[[package]]\nname = "a/b"\n[package.dependencies]\nA = "x/a@^2.1.0"\n'), {
    getState: () => STATES["x/a"],
    lockEntries: [],
  });
  assert.equal(publish[0].install.state, "n/a", "[package.dependencies] entries are published, not installed");
});

test("install state is judged from the lock and the range alone, not from the registry", () => {
  const offline = { "x/a": { status: "error", error: "down" } };
  assert.equal(analyzeText(BUMPED, lock("2.0.0"), offline)[0].install.state, "stale");
});

test("install tag: next to a usable verdict, and only when the lock is behind", () => {
  const tag = (text, lockEntries, states) => installTagFor(analyzeText(text, lockEntries, states)[0]);

  assert.deepEqual(tag(BUMPED, lock("2.0.0")), { kind: "install", text: "⟳ installed 2.0.0" });
  assert.deepEqual(tag(BUMPED, []), { kind: "install", text: "⟳ not installed" });
  assert.equal(tag(BUMPED, lock("2.1.0")), null, "in sync");
  assert.equal(tag(BUMPED, null), null, "no lockfile: nothing to compare with");
  assert.equal(tag(`${HEAD}A = "x/a@^9.0.0"\n`, []), null, "a range nothing satisfies has bigger problems");
  assert.equal(tag(BUMPED, [], { "x/a": { status: "loading" } }), null, "nothing known yet");
});

test("problems: a lock that is behind is reported at the severity chosen for outdated", () => {
  const problems = problemsFor(analyzeText(BUMPED, lock("2.0.0")), { wallyEnabled: true });

  assert.deepEqual(
    problems.map((p) => [p.code, p.severity]),
    [["sof.not-installed", "outdated"]]
  );
  assert.match(problems[0].message, /sof\.lock still pins 2\.0\.0, but sof\.toml asks for "\^2\.1\.0"/);
  assert.match(problems[0].message, /sof run package install/);

  const missing = problemsFor(analyzeText(BUMPED, []), { wallyEnabled: true });
  assert.match(missing[0].message, /no entry in sof\.lock/);

  assert.deepEqual(problemsFor(analyzeText(BUMPED, lock("2.1.0")), { wallyEnabled: true }), []);
});

test("summary mentions dependencies that are not installed yet", () => {
  const { text } = summarize(analyzeText(BUMPED, lock("2.0.0")));
  assert.equal(text, "1 dependency, 1 not installed: A ✓ latest");
});

const { installCommandFor } = require("../src/install");

test("the install command names the file unless it is sof.toml, and refuses unsafe names", () => {
  assert.equal(installCommandFor("sof.toml"), "sof run package install");
  assert.equal(installCommandFor(".sof.toml"), "sof run package install .sof.toml");
  assert.equal(installCommandFor("packages.sof.toml"), "sof run package install packages.sof.toml");
  assert.equal(installCommandFor("my_game-2.sof.toml"), "sof run package install my_game-2.sof.toml");

  for (const name of ["my file.sof.toml", "a;rm -rf.sof.toml", "$(x).sof.toml", "a&b.sof.toml", 'q".sof.toml', "a`b.sof.toml", ""]) {
    assert.equal(installCommandFor(name), null, JSON.stringify(name));
  }
});
