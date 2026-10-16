"use strict";

const fs = require("fs");
const path = require("path");
const { normalizeFormat, parseIntOption } = require("./args");

function findSofToml(startDir) {
  let dir = path.resolve(startDir);
  for (;;) {
    const candidate = path.join(dir, "sof.toml");
    if (fs.existsSync(candidate)) return candidate;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

/** Validate a parsed `[img]` table. Throws on bad values. `baseDir` resolves `out`. */
function normalizeImgTable(table, baseDir) {
  const config = {};
  if (!table || typeof table !== "object") return config;
  if (table.format !== undefined) config.format = normalizeFormat(table.format, "[img] format");
  if (table.quality !== undefined) config.quality = parseIntOption("[img] quality", table.quality, 1, 100);
  if (table.width !== undefined) config.width = parseIntOption("[img] width", table.width, 1);
  if (table.height !== undefined) config.height = parseIntOption("[img] height", table.height, 1);
  if (table.out !== undefined) {
    if (typeof table.out !== "string" || !table.out) throw new Error("[img] out must be a folder path.");
    config.out = path.resolve(baseDir, table.out);
  }
  return config;
}

function readImgConfig(startDir) {
  const file = findSofToml(startDir);
  if (!file) return {};
  const toml = require("smol-toml");
  let parsed;
  try {
    parsed = toml.parse(fs.readFileSync(file, "utf8"));
  } catch (_err) {
    return {};
  }
  return normalizeImgTable(parsed.img, path.dirname(file));
}

module.exports = { findSofToml, normalizeImgTable, readImgConfig };
