"use strict";

const fs = require("fs");
const path = require("path");
const toml = require("smol-toml");

function asStringList(value, fieldName, indexLabel) {
  if (typeof value === "string") {
    return [value];
  }

  if (!Array.isArray(value) || value.length === 0) {
    throw new Error(`${indexLabel}: "${fieldName}" must be a string or a non-empty array of strings.`);
  }

  const output = [];
  for (const item of value) {
    if (typeof item !== "string" || item.trim() === "") {
      throw new Error(`${indexLabel}: "${fieldName}" entries must be non-empty strings.`);
    }
    output.push(item.trim());
  }

  return output;
}

function normalizeGroup(rawGroup, groupIndex) {
  const indexLabel = `[[auto-types]] entry #${groupIndex}`;

  if (!rawGroup || typeof rawGroup !== "object" || Array.isArray(rawGroup)) {
    throw new Error(`${indexLabel}: entry must be a TOML table.`);
  }

  if (typeof rawGroup.name !== "string" || rawGroup.name.trim() === "") {
    throw new Error(`${indexLabel}: "name" is required and must be a non-empty string.`);
  }

  if (typeof rawGroup.output !== "string" || rawGroup.output.trim() === "") {
    throw new Error(`${indexLabel}: "output" is required and must be a non-empty string.`);
  }

  const include = asStringList(rawGroup.include, "include", indexLabel);

  const recursive = rawGroup.recursive === undefined ? true : rawGroup.recursive;
  if (typeof recursive !== "boolean") {
    throw new Error(`${indexLabel}: "recursive" must be a boolean when provided.`);
  }

  const excludePrivateRaw = rawGroup.exclude_private === undefined
    ? rawGroup.excludePrivate
    : rawGroup.exclude_private;
  const excludePrivate = excludePrivateRaw === undefined ? true : excludePrivateRaw;
  if (typeof excludePrivate !== "boolean") {
    throw new Error(`${indexLabel}: "exclude_private" must be a boolean when provided.`);
  }

  return {
    name: rawGroup.name.trim(),
    include,
    output: rawGroup.output.trim(),
    recursive,
    excludePrivate,
  };
}

function readAutoTypesConfig(configPathArg) {
  const configPath = path.resolve(configPathArg || "sof.toml");

  if (!fs.existsSync(configPath)) {
    throw new Error(`Config file does not exist: ${configPath}`);
  }

  const configText = fs.readFileSync(configPath, "utf8");

  let parsed;
  try {
    parsed = toml.parse(configText);
  } catch (err) {
    throw new Error(`Failed to parse TOML config at ${configPath}: ${err.message}`);
  }

  const autoTypesGroups = parsed["auto-types"] ?? parsed.auto_types;
  if (!Array.isArray(autoTypesGroups) || autoTypesGroups.length === 0) {
    throw new Error(`Config must define at least one [[auto-types]] entry.`);
  }

  const groups = autoTypesGroups.map((group, index) => normalizeGroup(group, index + 1));

  return {
    configPath,
    configDirectory: path.dirname(configPath),
    groups,
  };
}

module.exports = {
  readAutoTypesConfig,
};
