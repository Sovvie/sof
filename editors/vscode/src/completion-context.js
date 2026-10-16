"use strict";

// Works out what the cursor is doing inside a sof.toml, so completion knows what to offer and
// exactly which characters a chosen item replaces. Pure (no `vscode`), driven by the scanner.

const { classifyPath } = require("./model");
const { parseSpec } = require("./spec");

/**
 * @typedef {import("./toml-scan").Span} Span
 * @typedef {import("./toml-scan").ScanResult} ScanResult
 *
 * @typedef {Object} NameContext          Typing the "scope/name" part of "scope/name@range".
 * @property {"name"} type
 * @property {string} prefix              Typed so far, from the start of the string.
 * @property {Span} replace               The part a chosen package name replaces.
 * @property {boolean} hasRange           An "@range" already follows, so only the name is written.
 * @property {boolean} needsClosingQuote
 *
 * @typedef {Object} VersionContext       Typing the range after "@".
 * @property {"version"} type
 * @property {string} name
 * @property {string} prefix              Typed after the "@".
 * @property {Span} replace
 * @property {boolean} needsClosingQuote
 *
 * @typedef {Object} KeyContext           At the start of a line in a dependency table.
 * @property {"key"} type
 * @property {"install" | "publish"} kind
 * @property {string} prefix
 * @property {Span} replace
 * @property {Set<string>} usedNames      Packages this table already depends on.
 *
 * @typedef {NameContext | VersionContext | KeyContext} CompletionContext
 */

// Keys a [[dependencies]] table has besides dependencies; typing their start must not be
// hijacked by package suggestions.
const RESERVED_KEYS = ["path", "keep_unknown_instances"];

/**
 * @param {string} text
 * @param {number} offset
 * @param {ScanResult} scanned
 * @returns {CompletionContext | null}
 */
function completionContext(text, offset, scanned) {
  const fromValue = contextInDependencyString(text, offset, scanned);
  if (fromValue) return fromValue;
  return contextAtKey(text, offset, scanned);
}

function contextInDependencyString(text, offset, scanned) {
  for (const entry of scanned.entries) {
    if (!classifyPath(entry.path) || entry.value.kind !== "string" || entry.value.multiline) {
      continue;
    }

    const { innerSpan } = entry.value;
    if (offset < innerSpan.start || offset > innerSpan.end) {
      continue;
    }

    const inner = entry.value.raw;
    const relative = offset - innerSpan.start;
    const before = inner.slice(0, relative);
    const needsClosingQuote = !entry.value.terminated;

    const atBefore = before.lastIndexOf("@");
    if (atBefore !== -1) {
      const name = inner.slice(0, atBefore).trim();
      if (!parseSpec(`${name}@1`).name) {
        return null;
      }
      /** @type {VersionContext} */
      const version = {
        type: "version",
        name,
        prefix: before.slice(atBefore + 1),
        replace: { start: innerSpan.start + atBefore + 1, end: innerSpan.end },
        needsClosingQuote,
      };
      return version;
    }

    const atAfter = inner.indexOf("@", relative);
    /** @type {NameContext} */
    const nameContext = {
      type: "name",
      prefix: before,
      replace: { start: innerSpan.start, end: atAfter === -1 ? innerSpan.end : innerSpan.start + atAfter },
      hasRange: atAfter !== -1,
      needsClosingQuote,
    };
    return nameContext;
  }

  return null;
}

function contextAtKey(text, offset, scanned) {
  // Inside an array or inline table we are not at the start of a dependency line.
  for (const entry of scanned.entries) {
    if (entry.value.kind === "other" && entry.value.span.start < offset && offset < entry.value.span.end) {
      return null;
    }
  }

  let lineStart = offset;
  while (lineStart > 0 && text[lineStart - 1] !== "\n" && text[lineStart - 1] !== "\r") lineStart--;
  let lineEnd = offset;
  while (lineEnd < text.length && text[lineEnd] !== "\n" && text[lineEnd] !== "\r") lineEnd++;

  const beforeCursor = text.slice(lineStart, offset);
  const afterCursor = text.slice(offset, lineEnd);
  const typed = /^([ \t]*)([A-Za-z0-9_.\-/]*)$/.exec(beforeCursor);
  const rest = /^([A-Za-z0-9_.\-/]*)[ \t]*(#.*)?$/.exec(afterCursor);
  if (!typed || !rest) {
    return null; // not typing a bare key (a "=" is already there, or something else)
  }

  const table = [...scanned.tables].reverse().find((candidate) => candidate.span.end <= lineStart);
  if (!table || !table.closed) {
    return null;
  }

  /** @type {"install" | "publish" | null} */
  let kind = null;
  if (table.path.length === 1 && table.path[0] === "dependencies") kind = "install";
  if (table.path.length === 2 && table.path[0] === "package" && table.path[1] === "dependencies") kind = "publish";
  if (!kind) {
    return null;
  }

  const prefix = typed[2];
  const keysHere = scanned.entries.filter((entry) => entry.container === table.container);
  if (kind === "install" && prefix !== "") {
    const hasKey = (key) => keysHere.some((entry) => entry.path.length === 2 && entry.path[1] === key);
    const lower = prefix.toLowerCase();
    if (RESERVED_KEYS.some((key) => key.startsWith(lower) && !hasKey(key))) {
      return null;
    }
  }

  const usedNames = new Set();
  for (const entry of keysHere) {
    if (classifyPath(entry.path) && entry.value.kind === "string") {
      const { name } = parseSpec(entry.value.raw);
      if (name) usedNames.add(name);
    }
  }

  /** @type {KeyContext} */
  const keyContext = {
    type: "key",
    kind,
    prefix,
    replace: { start: lineStart + typed[1].length, end: offset + rest[1].length },
    usedNames,
  };
  return keyContext;
}

module.exports = { completionContext };
