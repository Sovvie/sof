"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { parseDependencies, analyze } = require("../src/model");
const { summarize } = require("../src/summary");

const data = (versions) => ({
  source: "sof",
  name: "x",
  versions: versions.map((version) => ({ version, yanked: false, dependencies: {} })),
});

function summaryOf(text, states) {
  return summarize(analyze(parseDependencies(text), { getState: (name) => states[name] || null }));
}

const HEAD = '[[dependencies]]\npath = "p"\n';

test("summary counts updates and lists every tag", () => {
  const { text, errors } = summaryOf(`${HEAD}A = "x/a@1.0.0"\nB = "x/b@^1.0.0"\nC = "nope"\n`, {
    "x/a": { status: "ok", data: data(["1.0.0", "2.0.0"]) },
    "x/b": { status: "ok", data: data(["1.0.0"]) },
  });
  assert.equal(text, "3 dependencies, 1 update: A ↑ 2.0.0, B ✓ latest, C (invalid)");
  assert.deepEqual(errors, []);
});

test("summary reports pending lookups and an unreachable registry once", () => {
  const { text, errors } = summaryOf(`${HEAD}A = "x/a@1.0.0"\nB = "x/b@1.0.0"\nC = "x/c@1.0.0"\n`, {
    "x/a": { status: "loading" },
    "x/b": { status: "error", error: "Could not reach https://r.test (down)." },
    "x/c": { status: "error", error: "Could not reach https://r.test (down)." },
  });
  assert.match(text, /^3 dependencies, 1 checking, registry unreachable:/);
  assert.deepEqual(errors, ["Could not reach https://r.test (down)."]);
});

test("summary of an empty file", () => {
  assert.equal(summaryOf("", {}).text, "no dependencies found");
  assert.equal(summaryOf(`${HEAD}A = "x/a@1.0.0"\n`, { "x/a": { status: "ok", data: data(["1.0.0", "1.1.0"]) } }).text, "1 dependency, 1 update: A ↑ 1.1.0");
});
