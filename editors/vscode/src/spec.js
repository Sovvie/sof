"use strict";

// "scope/name@range" dependency specifiers, parsed with the same rules as the sof CLI
// (src/packages/config.js parseDependencySpecifier), but reporting where each part is instead
// of throwing, so the editor can underline exactly the part that is wrong.

const semver = require("semver");

const PACKAGE_NAME_PATTERN = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

/**
 * @typedef {{ start: number, end: number }} Span   Offsets into the specifier text.
 *
 * @typedef {Object} SpecProblem
 * @property {"empty" | "missing-range" | "bad-name" | "bad-range"} code
 * @property {string} message
 * @property {Span} span
 *
 * @typedef {Object} ParsedSpec
 * @property {string | null} name        "scope/name" as written, when it is well formed.
 * @property {Span | null} nameSpan
 * @property {string | null} range       The part after "@", when it is a valid semver range.
 * @property {Span | null} rangeSpan
 * @property {SpecProblem[]} problems    Empty when the specifier is valid.
 */

/**
 * @param {string} raw  The text between the quotes.
 * @returns {ParsedSpec}
 */
function parseSpec(raw) {
  const lead = raw.length - raw.trimStart().length;
  const text = raw.trim();
  const whole = { start: lead, end: lead + text.length };
  /** @type {ParsedSpec} */
  const result = { name: null, nameSpan: null, range: null, rangeSpan: null, problems: [] };

  if (text === "") {
    result.problems.push({
      code: "empty",
      message: 'Expected "scope/name@range", for example "sovvie/router@^1.0.0".',
      span: { start: 0, end: raw.length },
    });
    return result;
  }

  const at = text.lastIndexOf("@");
  if (at <= 0 || at === text.length - 1) {
    // Still report the name when there is one, so hover/completion keep working mid-edit.
    const nameText = at > 0 ? text.slice(0, at).trimEnd() : at === -1 ? text : "";
    if (PACKAGE_NAME_PATTERN.test(nameText)) {
      result.name = nameText;
      result.nameSpan = { start: lead, end: lead + nameText.length };
    }
    result.problems.push({
      code: "missing-range",
      message: `Expected "scope/name@range", for example "${
        PACKAGE_NAME_PATTERN.test(nameText) ? nameText : "sovvie/router"
      }@^1.0.0".`,
      span: whole,
    });
    return result;
  }

  const nameText = text.slice(0, at).trimEnd();
  const rangeText = text.slice(at + 1).trim();
  const nameSpan = { start: lead, end: lead + nameText.length };
  const rangeStart = lead + at + 1 + (text.slice(at + 1).length - text.slice(at + 1).trimStart().length);
  const rangeSpan = { start: rangeStart, end: rangeStart + rangeText.length };

  if (PACKAGE_NAME_PATTERN.test(nameText)) {
    result.name = nameText;
    result.nameSpan = nameSpan;
  } else {
    result.problems.push({
      code: "bad-name",
      message: `Package name "${nameText}" must look like "scope/name" (letters, digits, "_", "." and "-").`,
      span: nameSpan,
    });
  }

  if (semver.validRange(rangeText, { includePrerelease: true })) {
    result.range = rangeText;
    result.rangeSpan = rangeSpan;
  } else {
    result.problems.push({
      code: "bad-range",
      message: `"${rangeText}" is not a valid semver range. Try "^1.0.0", "~1.2.0" or "1.2.3".`,
      span: rangeSpan,
    });
  }

  return result;
}

/**
 * The range text to write when moving a dependency to `version`, keeping the style the user
 * already chose: "^1.0.0" stays a caret, "~1.2.0" a tilde, "1.2.3" stays pinned. Anything more
 * elaborate (">=1 <3", "1.x") becomes a caret.
 *
 * @param {string} range
 * @param {string} version
 */
function bumpRange(range, version) {
  const trimmed = range.trim();
  if (semver.valid(trimmed)) {
    return version;
  }
  if (trimmed.startsWith("~") && !trimmed.includes(" ") && !trimmed.includes("|")) {
    return `~${version}`;
  }
  return `^${version}`;
}

/** "bufferfsm" -> "Bufferfsm", "mesh-builder" -> "MeshBuilder": a starting point for an alias. */
function suggestAlias(packageName) {
  const name = packageName.includes("/") ? packageName.split("/")[1] : packageName;
  const alias = name.replace(/(^|[-_.]+)([A-Za-z0-9])/g, (_match, _sep, char) => char.toUpperCase());
  return /^[A-Za-z]/.test(alias) ? alias : `P${alias}`;
}

module.exports = { parseSpec, bumpRange, suggestAlias, PACKAGE_NAME_PATTERN };
