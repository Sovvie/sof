"use strict";

// sof.lock lists what an install pinned: [[package]] tables with name, alias, version, path.
// Matching mirrors the CLI (src/commands/package.js findMatchingLockEntry).

const { scan } = require("./toml-scan");

/** @typedef {{ name: string, alias: string, version: string, path: string }} LockEntry */

function unescapeLockString(raw) {
  return raw.replace(/\\(["\\])/g, "$1");
}

/**
 * @param {string} text
 * @returns {LockEntry[]}
 */
function parseLockfile(text) {
  const { entries } = scan(text);
  /** @type {Map<number, Record<string, string>>} */
  const byContainer = new Map();

  for (const entry of entries) {
    if (entry.path.length !== 2 || entry.path[0] !== "package" || entry.value.kind !== "string") {
      continue;
    }
    let fields = byContainer.get(entry.container);
    if (!fields) {
      fields = {};
      byContainer.set(entry.container, fields);
    }
    fields[entry.key] = unescapeLockString(entry.value.raw);
  }

  const result = [];
  for (const fields of byContainer.values()) {
    if (fields.name && fields.version) {
      result.push({
        name: fields.name,
        alias: fields.alias || "",
        version: fields.version,
        path: fields.path || "",
      });
    }
  }
  return result;
}

const normalizePath = (value) => String(value).replace(/\\/g, "/");

/**
 * @param {LockEntry[]} entries
 * @param {{ name: string, alias: string, groupPath: string }} dependency
 * @returns {LockEntry | null}
 */
function findLockEntry(entries, dependency) {
  const wanted = normalizePath(dependency.groupPath);
  return (
    entries.find(
      (entry) =>
        normalizePath(entry.path) === wanted &&
        entry.alias === dependency.alias &&
        entry.name === dependency.name
    ) || null
  );
}

module.exports = { parseLockfile, findLockEntry };
