"use strict";

const fs = require("fs");
const path = require("path");

// Nearest sof.toml at or above the folder. Folders the sandbox cannot read simply count as "none".
function findSofToml(folder) {
  let dir = path.resolve(folder);
  for (;;) {
    const candidate = path.join(dir, "sof.toml");
    try {
      if (fs.statSync(candidate).isFile()) {
        return candidate;
      }
    } catch (_err) {
      // not here (or not readable): keep looking
    }
    const parent = path.dirname(dir);
    if (parent === dir) {
      return null;
    }
    dir = parent;
  }
}

function stringList(value, key) {
  if (typeof value === "string") {
    return [value];
  }
  if (Array.isArray(value) && value.every((v) => typeof v === "string")) {
    return value;
  }
  throw new Error(`[bundle] ${key} in sof.toml must be a string or a list of strings.`);
}

function expectType(value, type, key) {
  if (typeof value !== type) {
    throw new Error(`[bundle] ${key} in sof.toml must be a ${type}.`);
  }
  return value;
}

// Reads and checks the [bundle] table. Returns {} when there is none.
function loadBundleConfig(folder) {
  const file = findSofToml(folder);
  if (!file) {
    return { file: null, config: {} };
  }
  let parsed;
  try {
    parsed = require("smol-toml").parse(fs.readFileSync(file, "utf8"));
  } catch (err) {
    throw new Error(`Could not read ${file}: ${err.message}`);
  }
  const table = parsed.bundle;
  if (table === undefined) {
    return { file, config: {} };
  }
  if (typeof table !== "object" || table === null || Array.isArray(table)) {
    throw new Error("[bundle] in sof.toml must be a table.");
  }
  const config = {};
  if (table.include !== undefined) config.include = stringList(table.include, "include");
  if (table.exclude !== undefined) config.exclude = stringList(table.exclude, "exclude");
  if (table.out !== undefined) config.out = expectType(table.out, "string", "out");
  if (table.format !== undefined) {
    config.format = expectType(table.format, "string", "format");
    if (!["zip", "tar.gz", "tgz"].includes(config.format)) {
      throw new Error(`[bundle] format in sof.toml must be "zip" or "tar.gz".`);
    }
  }
  if (table.name !== undefined) config.name = expectType(table.name, "string", "name");
  if (table.version !== undefined) config.version = String(table.version);
  if (table.root_folder !== undefined) config.rootFolder = expectType(table.root_folder, "boolean", "root_folder");
  if (table.gitignore !== undefined) config.gitignore = expectType(table.gitignore, "boolean", "gitignore");
  return { file, config };
}

// CLI flags win over [bundle]; a list given on the command line replaces the table's list.
function mergeOptions(cli, config) {
  const pick = (key, fallback) => (cli[key] !== undefined ? cli[key] : config[key] !== undefined ? config[key] : fallback);
  return {
    out: pick("out"),
    format: pick("format"),
    name: pick("name"),
    version: pick("version"),
    rootFolder: pick("rootFolder", false),
    gitignore: pick("gitignore", true),
    include: cli.include.length ? cli.include : config.include || [],
    exclude: cli.exclude.length ? cli.exclude : config.exclude || [],
    list: Boolean(cli.list),
    json: Boolean(cli.json),
    reproducible: cli.reproducible !== false,
  };
}

module.exports = { findSofToml, loadBundleConfig, mergeOptions };
