"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { evaluate } = require("../src/versions");
const { parseLockfile, findLockEntry } = require("../src/lockfile");
const { parseDependencies, analyze, tagFor, isSofFileName } = require("../src/model");

function pkg(versions) {
  return {
    source: "sof",
    name: "sovvie/router",
    versions: versions.map((v) =>
      typeof v === "string" ? { version: v, yanked: false, dependencies: {} } : { dependencies: {}, yanked: false, ...v }
    ),
  };
}

test("an exact pin below latest is outdated", () => {
  const result = evaluate({ range: "1.0.0", data: pkg(["1.0.0", "1.1.0", "2.0.0"]) });
  assert.equal(result.status, "outdated");
  assert.equal(result.baseline, "1.0.0");
  assert.deepEqual(result.update, { version: "2.0.0", diff: "major", inRange: false });
});

test("a caret range resolves to the highest match and is current when that is latest", () => {
  const result = evaluate({ range: "^1.0.0", data: pkg(["1.0.0", "1.4.0"]) });
  assert.equal(result.status, "current");
  assert.equal(result.resolved, "1.4.0");
  assert.equal(result.update, null);
});

test("a newer version outside the range is an update, with the diff kind", () => {
  const result = evaluate({ range: "^1.0.0", data: pkg(["1.0.0", "1.4.0", "1.5.0", "2.0.0"]) });
  assert.equal(result.status, "outdated");
  assert.equal(result.baseline, "1.5.0");
  assert.equal(result.update.version, "2.0.0");
  assert.equal(result.update.diff, "major");
  assert.equal(result.update.inRange, false);

  const minor = evaluate({ range: "1.0.0", data: pkg(["1.0.0", "1.1.0"]) });
  assert.equal(minor.update.diff, "minor");
  const patch = evaluate({ range: "1.0.0", data: pkg(["1.0.0", "1.0.3"]) });
  assert.equal(patch.update.diff, "patch");
});

test("the lock decides what the dependency is on when it still satisfies the range", () => {
  const result = evaluate({ range: "^1.0.0", installed: "1.0.0", data: pkg(["1.0.0", "1.4.0"]) });
  assert.equal(result.status, "outdated");
  assert.equal(result.installed, "1.0.0");
  assert.equal(result.resolved, "1.4.0");
  assert.deepEqual(result.update, { version: "1.4.0", diff: "minor", inRange: true });
});

test("a lock that no longer satisfies the range is ignored and reported", () => {
  const result = evaluate({ range: "^2.0.0", installed: "1.0.0", data: pkg(["1.0.0", "2.0.0"]) });
  assert.equal(result.installed, null);
  assert.equal(result.lockMismatch, "1.0.0");
  assert.equal(result.baseline, "2.0.0");
  assert.equal(result.status, "current");
});

test("yanked versions are never picked or offered", () => {
  const data = pkg(["1.0.0", { version: "1.1.0", yanked: true }, "1.0.5"]);
  const result = evaluate({ range: "^1.0.0", data });
  assert.equal(result.resolved, "1.0.5");
  assert.equal(result.latest, "1.0.5");
  assert.equal(result.status, "current");
});

test("only yanked versions match: install would fail", () => {
  const data = pkg([{ version: "1.0.0", yanked: true }, "2.0.0"]);
  const result = evaluate({ range: "1.0.0", data });
  assert.equal(result.status, "yanked-only");
  assert.deepEqual(result.yankedMatches, ["1.0.0"]);
});

test("a locked version that was yanked since is flagged, and still offers the update", () => {
  const data = pkg([{ version: "1.0.0", yanked: true }, "1.1.0"]);
  const result = evaluate({ range: "^1.0.0", installed: "1.0.0", data });
  assert.equal(result.status, "locked-yanked");
  assert.equal(result.update.version, "1.1.0");
});

test("no version satisfies the range", () => {
  const result = evaluate({ range: "^9.0.0", data: pkg(["1.0.0"]) });
  assert.equal(result.status, "no-match");
  assert.equal(result.baseline, null);
  assert.equal(result.latest, "1.0.0");
});

test("prereleases are not offered unless asked for", () => {
  const data = pkg(["1.0.0", "2.0.0-beta.1"]);
  assert.equal(evaluate({ range: "1.0.0", data }).status, "current");

  const withPre = evaluate({ range: "1.0.0", data, includePrereleases: true });
  assert.equal(withPre.status, "outdated");
  assert.equal(withPre.update.version, "2.0.0-beta.1");
  assert.equal(withPre.update.diff, "major");
});

test("someone already on a prerelease is offered newer prereleases", () => {
  const result = evaluate({ range: "2.0.0-beta.1", data: pkg(["1.0.0", "2.0.0-beta.1", "2.0.0-beta.2"]) });
  assert.equal(result.update.version, "2.0.0-beta.2");
  assert.equal(result.update.diff, "prerelease");
});

test("a package that only has prereleases still has a latest", () => {
  const result = evaluate({ range: "^1.0.0-0", data: pkg(["1.0.0-beta.1", "1.0.0-beta.2"]) });
  assert.equal(result.latest, "1.0.0-beta.2");
  assert.equal(result.status, "current");
});

test("ignores version keys that are not semver", () => {
  const result = evaluate({ range: "*", data: pkg(["1.0.0", "not-a-version"]) });
  assert.equal(result.resolved, "1.0.0");
});

test("sof.lock parsing and matching follow the CLI", () => {
  const lock = `# Auto-generated by sof install. Do not edit.

[[package]]
name = "sovvie/router"
alias = "Router"
version = "1.2.0"
source = "sof"
path = "src\\\\Packages"
checksum = "sha256:abc"

[[package]]
name = "sovvie/stream"
alias = "Stream"
version = "2.0.0"
source = "sof"
path = "src/Packages"
checksum = "sha256:def"
`;
  const entries = parseLockfile(lock);
  assert.equal(entries.length, 2);
  assert.equal(
    findLockEntry(entries, { name: "sovvie/router", alias: "Router", groupPath: "src/Packages" }).version,
    "1.2.0"
  );
  assert.equal(findLockEntry(entries, { name: "sovvie/router", alias: "Other", groupPath: "src/Packages" }), null);
  assert.equal(findLockEntry(entries, { name: "sovvie/router", alias: "Router", groupPath: "elsewhere" }), null);
});

test("analyze + tagFor: the states a dependency can be in", () => {
  const text = `[[dependencies]]
path = "src/Packages"
Current = "s/current@^1.0.0"
Major = "s/major@1.0.0"
Minor = "s/minor@1.0.0"
Missing = "s/missing@^1.0.0"
Nothing = "s/nothing@^9.0.0"
Yanked = "s/yanked@1.0.0"
Loading = "s/loading@^1.0.0"
Broken = "s/broken@^1.0.0"
BadSpec = "nope"
`;
  const states = {
    "s/current": { status: "ok", data: pkg(["1.0.0"]) },
    "s/major": { status: "ok", data: pkg(["1.0.0", "2.0.0"]) },
    "s/minor": { status: "ok", data: pkg(["1.0.0", "1.2.0"]) },
    "s/missing": { status: "notfound" },
    "s/nothing": { status: "ok", data: pkg(["1.0.0"]) },
    "s/yanked": { status: "ok", data: pkg([{ version: "1.0.0", yanked: true }]) },
    "s/loading": { status: "loading" },
    "s/broken": { status: "error", error: "boom" },
  };
  const analyzed = analyze(parseDependencies(text), { getState: (name) => states[name] || null });
  const tags = Object.fromEntries(analyzed.map((a) => [a.dep.alias, tagFor(a)]));

  assert.deepEqual(tags.Current, { kind: "current", text: "✓ latest" });
  assert.deepEqual(tags.Major, { kind: "major", text: "↑ 2.0.0" });
  assert.deepEqual(tags.Minor, { kind: "minor", text: "↑ 1.2.0" });
  assert.deepEqual(tags.Missing, { kind: "muted", text: "not in index" });
  assert.deepEqual(tags.Nothing, { kind: "problem", text: "✗ no match" });
  assert.deepEqual(tags.Yanked, { kind: "problem", text: "✗ yanked" });
  assert.deepEqual(tags.Loading, { kind: "muted", text: "checking…" });
  assert.deepEqual(tags.Broken, { kind: "muted", text: "⚠ unavailable" });
  assert.equal(tags.BadSpec, null);

  assert.equal(tagFor(analyzed[0], { showUpToDate: false }), null);
});

test("analyze applies sof.lock only to install dependencies with a matching path and alias", () => {
  const text = `[[dependencies]]
path = "src/Packages"
Router = "sovvie/router@^1.0.0"
`;
  const getState = () => ({ status: "ok", data: pkg(["1.0.0", "1.4.0"]) });
  const lockEntries = [{ name: "sovvie/router", alias: "Router", version: "1.0.0", path: "src/Packages" }];

  const [withLock] = analyze(parseDependencies(text), { getState, lockEntries });
  assert.equal(withLock.lock.version, "1.0.0");
  assert.equal(withLock.evaluation.status, "outdated");

  const [noLock] = analyze(parseDependencies(text), { getState, lockEntries: [] });
  assert.equal(noLock.lock, null);
  assert.equal(noLock.evaluation.status, "current");
});

test("which file names are sof files", () => {
  for (const name of ["sof.toml", ".sof.toml", "packages.sof.toml", "SOF.TOML", "my.sof.toml"]) {
    assert.ok(isSofFileName(name), name);
  }
  for (const name of ["rokit.toml", "sof.toml.bak", "sof.lock", "wally.toml", "xsof.toml", "Cargo.toml"]) {
    assert.ok(!isSofFileName(name), name);
  }
});
