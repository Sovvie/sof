"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { parseSpec, bumpRange, suggestAlias } = require("../src/spec");

test("a valid specifier reports name and range with offsets", () => {
  const spec = parseSpec("sovvie/router@^1.2.0");
  assert.equal(spec.name, "sovvie/router");
  assert.equal(spec.range, "^1.2.0");
  assert.deepEqual(spec.nameSpan, { start: 0, end: 13 });
  assert.deepEqual(spec.rangeSpan, { start: 14, end: 20 });
  assert.deepEqual(spec.problems, []);
});

test("accepts the same ranges the CLI accepts", () => {
  for (const range of ["1.0.0", "^1", "~1.2", ">=1.0.0 <2.0.0", "1.x", "*", "^1.0.0-beta.1", "1.0.0 || 2.0.0"]) {
    const spec = parseSpec(`a/b@${range}`);
    assert.deepEqual(spec.problems, [], range);
    assert.equal(spec.range, range);
  }
});

test("surrounding whitespace is tolerated and spans stay exact", () => {
  const raw = "  sovvie/router @ ^1.0.0 ";
  const spec = parseSpec(raw);
  assert.equal(spec.name, "sovvie/router");
  assert.equal(raw.slice(spec.nameSpan.start, spec.nameSpan.end), "sovvie/router");
  assert.equal(raw.slice(spec.rangeSpan.start, spec.rangeSpan.end), "^1.0.0");
});

test("a missing @range keeps the name for hover and completion", () => {
  for (const raw of ["sovvie/router", "sovvie/router@", "sovvie/router@  "]) {
    const spec = parseSpec(raw);
    assert.equal(spec.name, "sovvie/router", raw);
    assert.equal(spec.range, null);
    assert.equal(spec.problems[0].code, "missing-range");
  }
});

test("empty and malformed specifiers", () => {
  assert.equal(parseSpec("").problems[0].code, "empty");
  assert.equal(parseSpec("   ").problems[0].code, "empty");
  assert.equal(parseSpec("@^1.0.0").problems[0].code, "missing-range");

  const noScope = parseSpec("router@^1.0.0");
  assert.equal(noScope.name, null);
  assert.equal(noScope.problems[0].code, "bad-name");
  assert.deepEqual(noScope.problems[0].span, { start: 0, end: 6 });

  const badRange = parseSpec("sovvie/router@not-a-range");
  assert.equal(badRange.name, "sovvie/router");
  assert.equal(badRange.problems[0].code, "bad-range");
  assert.deepEqual(badRange.problems[0].span, { start: 14, end: 25 });
});

test("the last @ separates the range, so a scoped-looking name still fails on its own", () => {
  const spec = parseSpec("@scope/pkg@1.0.0");
  assert.equal(spec.problems[0].code, "bad-name");
});

test("bumpRange keeps the user's style", () => {
  assert.equal(bumpRange("^1.0.0", "2.1.0"), "^2.1.0");
  assert.equal(bumpRange("~1.2.0", "1.4.0"), "~1.4.0");
  assert.equal(bumpRange("1.0.0", "1.1.0"), "1.1.0");
  assert.equal(bumpRange("^1", "2.0.0"), "^2.0.0");
  assert.equal(bumpRange(">=1.0.0 <2.0.0", "2.0.0"), "^2.0.0");
  assert.equal(bumpRange("1.x", "2.0.0"), "^2.0.0");
  assert.equal(bumpRange("~1.0.0 || ~2.0.0", "3.0.0"), "^3.0.0");
});

test("suggestAlias makes a plausible Luau identifier", () => {
  assert.equal(suggestAlias("sovvie/router"), "Router");
  assert.equal(suggestAlias("sovvie/mesh-builder"), "MeshBuilder");
  assert.equal(suggestAlias("sovvie/b226"), "B226");
  assert.equal(suggestAlias("sovvie/9lives"), "P9lives");
  assert.equal(suggestAlias("sovvie/data_syncer"), "DataSyncer");
});
