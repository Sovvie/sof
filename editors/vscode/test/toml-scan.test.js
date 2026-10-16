"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { scan, lineIndex } = require("../src/toml-scan");
const { parseDependencies } = require("../src/model");

const README_EXAMPLE = `[[dependencies]]
path = "src/ReplicatedStorage/Packages"
Router = "sovvie/router@^2.0.0"
Stream = "sovvie/stream@^2.0.0"

[tools]
rojo = "rojo-rbx/rojo@7.6.1"
selene = "Kampfkarren/selene@0.30.1"
`;

function strings(text) {
  return scan(text).entries.filter((e) => e.value.kind === "string");
}

test("finds tables and string entries with exact offsets", () => {
  const result = scan(README_EXAMPLE);
  assert.deepEqual(
    result.tables.map((t) => [t.path.join("."), t.isArray]),
    [
      ["dependencies", true],
      ["tools", false],
    ]
  );

  const router = strings(README_EXAMPLE).find((e) => e.key === "Router");
  assert.ok(router);
  assert.deepEqual(router.path, ["dependencies", "Router"]);
  assert.equal(README_EXAMPLE.slice(router.value.innerSpan.start, router.value.innerSpan.end), "sovvie/router@^2.0.0");
  assert.equal(README_EXAMPLE.slice(router.value.span.start, router.value.span.end), '"sovvie/router@^2.0.0"');
  assert.equal(README_EXAMPLE.slice(router.keySpan.start, router.keySpan.end), "Router");
});

test("entries in one table share a container, a new table starts a new one", () => {
  const text = `[[dependencies]]
path = "a"
X = "s/x@1.0.0"

[[dependencies]]
path = "b"
Y = "s/y@1.0.0"
`;
  const all = strings(text);
  const [firstPath, secondPath] = all.filter((e) => e.key === "path");
  const x = all.find((e) => e.key === "X");
  const y = all.find((e) => e.key === "Y");
  assert.equal(firstPath.container, x.container);
  assert.equal(secondPath.container, y.container);
  assert.notEqual(x.container, y.container);
});

test("handles CRLF line endings", () => {
  const text = README_EXAMPLE.replace(/\n/g, "\r\n");
  const deps = parseDependencies(text);
  assert.deepEqual(
    deps.map((d) => d.raw),
    ["sovvie/router@^2.0.0", "sovvie/stream@^2.0.0"]
  );
  for (const dep of deps) {
    assert.equal(text.slice(dep.innerSpan.start, dep.innerSpan.end), dep.raw);
  }
});

test("ignores comments and strings inside them", () => {
  const text = `# Router = "sovvie/router@^1.0.0"
[[dependencies]]
path = "p" # trailing = "x"
Stream = "sovvie/stream@^2.0.0" # sovvie/router@^1.0.0
`;
  const deps = parseDependencies(text);
  assert.deepEqual(
    deps.map((d) => d.alias),
    ["Stream"]
  );
});

test("keep_unknown_instances arrays do not leak their strings as entries", () => {
  const text = `[[dependencies]]
path = "src/Packages"
keep_unknown_instances = [
  "Foo = bar",
  "baz",
]
Router = "sovvie/router@^2.0.0"
`;
  const deps = parseDependencies(text);
  assert.deepEqual(
    deps.map((d) => d.alias),
    ["Router"]
  );
  assert.equal(deps[0].groupPath, "src/Packages");
});

test("quoted and literal keys and values", () => {
  const text = `[[dependencies]]
path = 'src/Packages'
"My Router" = 'sovvie/router@^2.0.0'
`;
  const [dep] = parseDependencies(text);
  assert.equal(dep.alias, "My Router");
  assert.equal(dep.raw, "sovvie/router@^2.0.0");
  assert.equal(dep.groupPath, "src/Packages");
});

test("multi-line strings are skipped and do not hide what follows", () => {
  const text = `[[package]]
name = "sovvie/router"
description = """
Router = "not/a-dep@1.0.0"
a = b
"""
version = "1.0.0"

[package.dependencies]
Stream = "sovvie/stream@^2.0.0"
`;
  const deps = parseDependencies(text);
  assert.deepEqual(
    deps.map((d) => [d.kind, d.alias, d.raw]),
    [["publish", "Stream", "sovvie/stream@^2.0.0"]]
  );
});

test("publish dependencies as an inline table and as dotted keys", () => {
  const text = `[[package]]
name = "a/b"
dependencies = { Stream = "sovvie/stream@^2.0.0", Butler = "sovvie/butler@^1.0.0" }

[[package]]
name = "a/c"
dependencies.Emit = "sovvie/emit@^1.0.0"
`;
  const deps = parseDependencies(text);
  assert.deepEqual(
    deps.map((d) => d.alias),
    ["Stream", "Butler", "Emit"]
  );
  assert.ok(deps.every((d) => d.kind === "publish"));
});

test("dependencies written as an array of inline tables", () => {
  const text = `dependencies = [
  { path = "src/A", Router = "sovvie/router@^1.0.0" },
  { path = "src/B", Stream = "sovvie/stream@^1.0.0" },
]
`;
  const deps = parseDependencies(text);
  assert.deepEqual(
    deps.map((d) => [d.alias, d.groupPath]),
    [
      ["Router", "src/A"],
      ["Stream", "src/B"],
    ]
  );
});

test("[tools] entries are not dependencies", () => {
  assert.deepEqual(parseDependencies(README_EXAMPLE).map((d) => d.alias), ["Router", "Stream"]);
});

test("path is not a dependency alias", () => {
  const text = `[[dependencies]]
path = "src/Packages"
`;
  assert.equal(parseDependencies(text).length, 0);
});

test("an unterminated string is still an entry and stops at the end of its line", () => {
  const text = `[[dependencies]]
path = "p"
Router = "sovvie/ro
Stream = "sovvie/stream@^2.0.0"
`;
  const entries = strings(text);
  const router = entries.find((e) => e.key === "Router");
  assert.ok(router);
  assert.equal(router.value.terminated, false);
  assert.equal(router.value.raw, "sovvie/ro");
  assert.ok(entries.find((e) => e.key === "Stream"));
});

test("an array that is never closed does not swallow the next table or entries", () => {
  const text = `[[dependencies]]
path = "p"
keep_unknown_instances = [
  "a",
Router = "sovvie/router@^2.0.0"

[[dependencies]]
path = "q"
Stream = "sovvie/stream@^2.0.0"
`;
  assert.deepEqual(
    parseDependencies(text).map((d) => d.alias),
    ["Router", "Stream"]
  );
});

test("an unclosed header does not attribute later lines to the previous table", () => {
  const text = `[[dependencies]]
path = "p"
Router = "sovvie/router@^2.0.0"

[[depend
Stream = "sovvie/stream@^2.0.0"
`;
  assert.deepEqual(
    parseDependencies(text).map((d) => d.alias),
    ["Router"]
  );
});

test("garbage lines are skipped without looping", () => {
  const text = `[[dependencies]]
path = "p"
== = ===
@@@
Router
= "x"
Stream = "sovvie/stream@^2.0.0"
`;
  assert.deepEqual(
    parseDependencies(text).map((d) => d.alias),
    ["Stream"]
  );
});

test("empty and whitespace-only input", () => {
  assert.deepEqual(scan(""), { entries: [], tables: [] });
  assert.deepEqual(scan("   \n\n  # hi\n").entries, []);
});

test("a value missing after = does not break the next line", () => {
  const text = `[[dependencies]]
path = "p"
Router =
Stream = "sovvie/stream@^2.0.0"
`;
  assert.deepEqual(
    parseDependencies(text).map((d) => d.alias),
    ["Stream"]
  );
});

test("lineIndex maps offsets for LF, CRLF and lone CR", () => {
  const lf = lineIndex("ab\ncd\nef");
  assert.deepEqual(lf.positionAt(0), { line: 0, character: 0 });
  assert.deepEqual(lf.positionAt(4), { line: 1, character: 1 });
  assert.deepEqual(lf.positionAt(7), { line: 2, character: 1 });

  const crlf = lineIndex("ab\r\ncd");
  assert.deepEqual(crlf.positionAt(4), { line: 1, character: 0 });
  assert.equal(crlf.lineCount, 2);
});

test("never throws and always terminates on arbitrary truncations of a real file", () => {
  const full = README_EXAMPLE + '[[package]]\nname = "a/b"\nversion = "1.0.0"\ninclude = ["x", "y"]\n[package.dependencies]\nA = "s/a@^1"\n';
  for (let cut = 0; cut <= full.length; cut++) {
    const result = scan(full.slice(0, cut));
    for (const entry of result.entries) {
      assert.ok(entry.keySpan.start <= entry.keySpan.end);
      if (entry.value.kind === "string") {
        assert.equal(
          full.slice(0, cut).slice(entry.value.innerSpan.start, entry.value.innerSpan.end),
          entry.value.raw
        );
      }
    }
  }
});
