"use strict";

// Which version of a tool applies where you are: the nearest sof.toml (this folder, then each
// parent) that lists the alias in [tools], then the global ~/.sof/tools.toml. Like Rokit and
// Aftman, a nearer file only wins for the tools it lists.

const fs = require("fs");
const path = require("path");
const toml = require("smol-toml");

const { globalManifestPath } = require("./store");

// Just the one entry, not the whole file: a mistake in some other tool's line must not stop
// this tool from running.
function lookup(file, wanted) {
  if (!fs.existsSync(file)) {
    return null;
  }

  let table;
  try {
    table = toml.parse(fs.readFileSync(file, "utf8")).tools;
  } catch (err) {
    throw new Error(`Failed to parse ${file}: ${err.message}`);
  }

  if (!table || typeof table !== "object") {
    return null;
  }

  const alias = Object.keys(table).find((name) => name.toLowerCase() === wanted);
  return alias ? { alias, specifier: table[alias], file } : null;
}

function findToolEntry(alias, startDirectory = process.cwd()) {
  const wanted = String(alias).toLowerCase();

  let directory = path.resolve(startDirectory);
  for (;;) {
    const found = lookup(path.join(directory, "sof.toml"), wanted);
    if (found) {
      return { ...found, global: false };
    }

    const parent = path.dirname(directory);
    if (parent === directory) {
      break;
    }
    directory = parent;
  }

  const found = lookup(globalManifestPath(), wanted);
  return found ? { ...found, global: true } : null;
}

module.exports = {
  findToolEntry,
};
