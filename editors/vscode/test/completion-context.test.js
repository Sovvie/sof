"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { scan } = require("../src/toml-scan");
const { completionContext } = require("../src/completion-context");

// "|" marks the cursor.
function at(template) {
  const offset = template.indexOf("|");
  assert.notEqual(offset, -1, "template needs a | cursor");
  const text = template.slice(0, offset) + template.slice(offset + 1);
  const context = completionContext(text, offset, scan(text));
  return { text, offset, context };
}

function replaced({ text, context }) {
  return text.slice(context.replace.start, context.replace.end);
}

const HEAD = '[[dependencies]]\npath = "src/Packages"\n';

test("typing a package name inside the quotes", () => {
  const result = at(`${HEAD}Router = "sovvie/ro|"\n`);
  assert.equal(result.context.type, "name");
  assert.equal(result.context.prefix, "sovvie/ro");
  assert.equal(replaced(result), "sovvie/ro");
  assert.equal(result.context.hasRange, false);
  assert.equal(result.context.needsClosingQuote, false);
});

test("an empty string right after the opening quote", () => {
  const result = at(`${HEAD}Router = "|"\n`);
  assert.equal(result.context.type, "name");
  assert.equal(result.context.prefix, "");
});

test("an unterminated string still completes and asks for the closing quote", () => {
  const result = at(`${HEAD}Router = "sovvie/|\nStream = "sovvie/stream@^1.0.0"\n`);
  assert.equal(result.context.type, "name");
  assert.equal(result.context.needsClosingQuote, true);
  assert.equal(replaced(result), "sovvie/");
});

test("editing the name of an existing specifier replaces only the name", () => {
  const result = at(`${HEAD}Router = "sov|vie/router@^1.0.0"\n`);
  assert.equal(result.context.type, "name");
  assert.equal(result.context.hasRange, true);
  assert.equal(replaced(result), "sovvie/router");
});

test("typing the version after @", () => {
  const result = at(`${HEAD}Router = "sovvie/router@|"\n`);
  assert.equal(result.context.type, "version");
  assert.equal(result.context.name, "sovvie/router");
  assert.equal(result.context.prefix, "");
  assert.equal(replaced(result), "");
});

test("a partly typed range, with the operator in the prefix; the whole range is replaced", () => {
  const result = at(`${HEAD}Router = "sovvie/router@^1.|2.0"\n`);
  assert.equal(result.context.type, "version");
  assert.equal(result.context.prefix, "^1.");
  assert.equal(replaced(result), "^1.2.0");
});

test("a version after a malformed name offers nothing", () => {
  assert.equal(at(`${HEAD}Router = "router@|"\n`).context, null);
});

test("works in [package.dependencies] and in inline tables", () => {
  const publish = at('[[package]]\nname = "a/b"\n[package.dependencies]\nStream = "sovvie/str|"\n');
  assert.equal(publish.context.type, "name");

  const inline = at('[[package]]\nname = "a/b"\ndependencies = { Stream = "sovvie/stream@|" }\n');
  assert.equal(inline.context.type, "version");
});

test("other tables and keys never complete", () => {
  assert.equal(at('[tools]\nrojo = "rojo-rbx/ro|"\n').context, null);
  assert.equal(at(`[[dependencies]]\npath = "src/Pa|"\n`).context, null);
  assert.equal(at('[[package]]\nname = "sovvie/ro|"\n').context, null);
  assert.equal(at("# Router = \"sovvie/ro|\"\n").context, null);
});

test("at the start of a line in a dependency table: add a dependency", () => {
  const result = at(`${HEAD}Stream = "sovvie/stream@^1.0.0"\nrou|\n`);
  assert.equal(result.context.type, "key");
  assert.equal(result.context.kind, "install");
  assert.equal(result.context.prefix, "rou");
  assert.equal(replaced(result), "rou");
  assert.ok(result.context.usedNames.has("sovvie/stream"));
});

test("an indented key keeps its indentation out of the replaced range", () => {
  const result = at(`${HEAD}    sovvie/ro|\n`);
  assert.equal(result.context.type, "key");
  assert.equal(replaced(result), "sovvie/ro");
});

test("a key context also covers the rest of the word after the cursor", () => {
  const result = at(`${HEAD}ro|uter\n`);
  assert.equal(replaced(result), "router");
});

test("an empty line in a dependency table (Ctrl+Space) offers packages", () => {
  const result = at(`${HEAD}|\n`);
  assert.equal(result.context.type, "key");
  assert.equal(result.context.prefix, "");
});

test("typing the start of path or keep_unknown_instances is left alone until path exists", () => {
  assert.equal(at("[[dependencies]]\npa|\n").context, null);
  assert.equal(at("[[dependencies]]\nkeep_un|\n").context, null);
  // path is already there: "pa" can only be a package now.
  assert.equal(at(`${HEAD}pa|\n`).context.type, "key");
  // a different start is never reserved
  assert.equal(at("[[dependencies]]\nrou|\n").context.type, "key");
});

test("no key completion once the line has an =, outside dependency tables or in arrays", () => {
  assert.equal(at(`${HEAD}Router| = "sovvie/router@^1.0.0"\n`).context, null);
  assert.equal(at("[tools]\nro|\n").context, null);
  assert.equal(at("ro|\n").context, null);
  assert.equal(at(`${HEAD}keep_unknown_instances = [\n  Fo|\n]\n`).context, null);
});

test("not on or inside the header line, and not under an unclosed header", () => {
  assert.equal(at("[[dep|endencies]]\n").context, null);
  assert.equal(at("[[dependencies\nro|\n").context, null);
});

test("a table that follows a dependency table is not mistaken for it", () => {
  assert.equal(at(`${HEAD}Stream = "s/s@1.0.0"\n\n[tools]\nro|\n`).context, null);
});

test("CRLF documents", () => {
  const result = at(`[[dependencies]]\r\npath = "p"\r\nRouter = "sovvie/ro|"\r\n`);
  assert.equal(result.context.type, "name");
  assert.equal(replaced(result), "sovvie/ro");
});
